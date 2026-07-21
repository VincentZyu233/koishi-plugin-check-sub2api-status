#!/usr/bin/env python3
#
# 用法示例（只依赖 Python 标准库，不需要安装第三方包）:
#
#   python tools/export-auth-state.py --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
#
# 参数及默认值:
#   --browser  默认依次读取 CHROME_PATH、PUPPETEER_EXECUTABLE_PATH；均未设置时必须传入
#   --url      默认 "http://127.0.0.1:8080/monitor"
#   --profile  默认 "data/sub2api-auth-profile-py"（相对于当前工作目录）
#   --out      默认 "tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json"（相对于脚本目录）
#   --timeout  默认 600000 毫秒（10 分钟）
#   --port     默认 0（自动选择空闲端口）
#   --profile-mode 默认 "temporary"，可选 temporary/reuse/reset/open
#
# 脚本会打开一个独立浏览器窗口；如果没登录，就在窗口里登录 sub2api。
# 识别到 localStorage 里的 auth_token + auth_user 后，会连同 Origin 和 User-Agent
# 导出 Koishi 插件可直接读取的 JSON。

import argparse
import base64
import datetime as dt
import hashlib
import http.client
import json
import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
from typing import Optional


STORAGE_KEYS = [
    "auth_token",
    "refresh_token",
    "auth_user",
    "token_expires_at",
]


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
DEFAULT_PROFILE_DIR = os.path.abspath("data/sub2api-auth-profile-py")
PROFILE_MARKER_NAME = ".sub2api-auth-profile"
PROFILE_MODES = ("temporary", "reuse", "reset", "open")
PROFILE_CLEANUP_TIMEOUT_SECONDS = 5.0
PROFILE_CLEANUP_RETRY_SECONDS = 0.25
ANSI_ENABLED = not os.environ.get("NO_COLOR")


def style(text: object, *codes: str) -> str:
    if not ANSI_ENABLED or not codes:
        return str(text)
    return f"\033[{';'.join(codes)}m{text}\033[0m"


def format_local_time(date: dt.datetime) -> str:
    return f"{date.year}年{date.month}月{date.day}日{date.hour:02d}:{date.minute:02d}:{date.second:02d}"


def format_local_from_ms(value: object) -> str:
    try:
        timestamp_ms = int(float(str(value)))
    except (TypeError, ValueError):
        return "未知"
    return format_local_time(dt.datetime.fromtimestamp(timestamp_ms / 1000))


def format_local_from_iso(value: object) -> str:
    if not isinstance(value, str) or not value:
        return "未知"
    try:
        date = dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return "未知"
    return format_local_time(date)


def format_remaining(value: object) -> str:
    try:
        timestamp_ms = int(float(str(value)))
    except (TypeError, ValueError):
        return "未知"

    remaining_seconds = int((timestamp_ms - int(time.time() * 1000)) / 1000)
    if remaining_seconds <= 0:
        return "已过期"

    days, rem = divmod(remaining_seconds, 24 * 60 * 60)
    hours, rem = divmod(rem, 60 * 60)
    minutes, seconds = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}天")
    if hours or parts:
        parts.append(f"{hours}小时")
    if minutes or parts:
        parts.append(f"{minutes}分钟")
    parts.append(f"{seconds}秒")
    return "".join(parts)


class DevToolsError(RuntimeError):
    pass


class WebSocketClient:
    def __init__(self, ws_url: str):
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.scheme != "ws":
            raise DevToolsError(f"🌐 Only ws:// DevTools URLs are supported: {ws_url}")
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.path = parsed.path
        if parsed.query:
            self.path += "?" + parsed.query
        self.sock: Optional[socket.socket] = None
        self.next_id = 1

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))

        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise DevToolsError("🤝 DevTools WebSocket handshake failed")
            response += chunk

        header = response.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
        if " 101 " not in header.splitlines()[0]:
            raise DevToolsError(f"🤝 DevTools WebSocket handshake rejected: {header.splitlines()[0]}")

        accept_src = (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
        expected_accept = base64.b64encode(hashlib.sha1(accept_src).digest()).decode("ascii")
        headers = {}
        for line in header.splitlines()[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        if headers.get("sec-websocket-accept") != expected_accept:
            raise DevToolsError("🔑 DevTools WebSocket accept key mismatch")

        self.sock = sock

    def close(self) -> None:
        if self.sock:
            try:
                self._send_frame(b"", opcode=0x8)
            except OSError:
                pass
            try:
                self.sock.close()
            finally:
                self.sock = None

    def call(self, method: str, params: Optional[dict] = None, timeout: float = 30) -> dict:
        message_id = self.next_id
        self.next_id += 1
        payload = {"id": message_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._send_frame(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            raw = self._recv_text(remaining)
            if raw is None:
                continue
            data = json.loads(raw)
            if data.get("id") != message_id:
                continue
            if "error" in data:
                raise DevToolsError(f"⚠️ {method} failed: {data['error']}")
            return data.get("result", {})

        raise TimeoutError(f"⏱️ Timed out waiting for CDP response: {method}")

    def _send_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        if not self.sock:
            raise DevToolsError("🔌 WebSocket is not connected")

        first = 0x80 | opcode
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", first, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", first, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", first, 0x80 | 127, length)

        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _recv_text(self, timeout: float) -> Optional[str]:
        if not self.sock:
            raise DevToolsError("🔌 WebSocket is not connected")
        self.sock.settimeout(timeout)

        while True:
            first_two = self._recv_exact(2)
            first, second = first_two
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F

            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]

            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

            if opcode == 0x1:
                return payload.decode("utf-8")
            if opcode == 0x8:
                raise DevToolsError("🔌 DevTools WebSocket closed")
            if opcode == 0x9:
                self._send_frame(payload, opcode=0xA)
                continue
            if opcode in (0xA, 0x0):
                continue

    def _recv_exact(self, size: int) -> bytes:
        if not self.sock:
            raise DevToolsError("🔌 WebSocket is not connected")
        chunks = []
        remaining = size
        while remaining:
            chunk = self.sock.recv(remaining)
            if not chunk:
                raise DevToolsError("🔌 DevTools WebSocket closed unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export sub2api localStorage auth state using only Python standard library.",
    )
    parser.add_argument(
        "-b",
        "--browser",
        default=os.environ.get("CHROME_PATH") or os.environ.get("PUPPETEER_EXECUTABLE_PATH") or "",
        help="Chrome/Chromium executable path. Defaults to CHROME_PATH or PUPPETEER_EXECUTABLE_PATH.",
    )
    parser.add_argument(
        "-u",
        "--url",
        default="http://127.0.0.1:8080/monitor",
        help="sub2api monitor URL. Default: http://127.0.0.1:8080/monitor",
    )
    parser.add_argument(
        "-p",
        "--profile",
        default=DEFAULT_PROFILE_DIR,
        help="Dedicated browser profile dir. Default: ./data/sub2api-auth-profile-py",
    )
    parser.add_argument(
        "--profile-mode",
        choices=PROFILE_MODES,
        default="temporary",
        help="Profile lifecycle mode. Default: temporary.",
    )
    parser.add_argument(
        "-o",
        "--out",
        default=default_out_path(),
        help="Output auth JSON path. Default: tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=600_000,
        help="Wait timeout in milliseconds. Default: 600000.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Chrome remote debugging port. Default: auto.",
    )
    return parser.parse_args()


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(port: int, path: str, method: str = "GET") -> object:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status < 200 or resp.status >= 300:
            raise DevToolsError(f"🌐 HTTP {method} {path} failed: {resp.status} {body[:200]!r}")
        return json.loads(body.decode("utf-8"))
    finally:
        conn.close()


def wait_for_devtools(port: int, timeout_ms: int) -> None:
    deadline = time.monotonic() + timeout_ms / 1000
    last_error: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            http_json(port, "/json/version")
            return
        except Exception as exc:
            last_error = exc
            time.sleep(0.2)
    raise TimeoutError(f"⏱️ Chrome DevTools did not start on port {port}: {last_error}")


def find_page_ws(port: int, target_url: str) -> str:
    targets = http_json(port, "/json/list")
    if not isinstance(targets, list):
        raise DevToolsError("📄 /json/list did not return a list")

    origin = urllib.parse.urlparse(target_url).netloc
    pages = [item for item in targets if isinstance(item, dict) and item.get("type") == "page"]
    for item in pages:
        if origin and origin in str(item.get("url", "")) and item.get("webSocketDebuggerUrl"):
            return str(item["webSocketDebuggerUrl"])
    for item in pages:
        if item.get("webSocketDebuggerUrl"):
            return str(item["webSocketDebuggerUrl"])

    quoted = urllib.parse.quote(target_url, safe="")
    created = http_json(port, f"/json/new?{quoted}", method="PUT")
    if isinstance(created, dict) and created.get("webSocketDebuggerUrl"):
        return str(created["webSocketDebuggerUrl"])
    raise DevToolsError("🧭 Could not find or create a DevTools page target")


def normalize_auth_user(value: object) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return json.dumps(
        {
            "id": 0,
            "email": "bot@local",
            "username": "bot",
            "role": "user",
            "status": "active",
        },
        separators=(",", ":"),
    )


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def file_timestamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def default_out_path() -> str:
    return os.path.join(OUTPUT_DIR, f"sub2api-auth-state-{file_timestamp()}.json")


def normalize_compare_path(value: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(value)))


def is_same_or_parent_path(candidate: str, target: str) -> bool:
    try:
        return os.path.commonpath([candidate, target]) == candidate
    except ValueError:
        return False


def validate_profile_path(profile_path: str) -> None:
    normalized = normalize_compare_path(profile_path)
    drive, _ = os.path.splitdrive(normalized)
    root_path = normalize_compare_path(f"{drive}{os.sep}" if drive else os.path.abspath(os.sep))
    if normalized == root_path:
        raise RuntimeError(f"🛑 Refusing to manage filesystem root as profile path: {profile_path}")

    protected_paths = [
        normalize_compare_path(os.getcwd()),
        normalize_compare_path(os.path.expanduser("~")),
        normalize_compare_path(SCRIPT_DIR),
    ]
    if any(is_same_or_parent_path(normalized, protected) for protected in protected_paths):
        raise RuntimeError(f"🛑 Refusing to manage unsafe profile path: {profile_path}")

    if not os.path.lexists(profile_path):
        return
    is_junction = getattr(os.path, "isjunction", lambda _: False)
    if os.path.islink(profile_path) or is_junction(profile_path):
        raise RuntimeError(f"🛑 Refusing to manage linked profile path: {profile_path}")
    if not os.path.isdir(profile_path):
        raise RuntimeError(f"🛑 Profile path exists but is not a directory: {profile_path}")


def profile_is_script_owned(profile_path: str) -> bool:
    if normalize_compare_path(profile_path) == normalize_compare_path(DEFAULT_PROFILE_DIR):
        return True
    return os.path.isfile(os.path.join(profile_path, PROFILE_MARKER_NAME))


def clear_profile(profile_path: str) -> None:
    validate_profile_path(profile_path)
    if not os.path.exists(profile_path):
        return
    if not profile_is_script_owned(profile_path):
        raise RuntimeError(
            f"🛑 Refusing to delete unmarked profile directory: {profile_path}. "
            f"Missing {PROFILE_MARKER_NAME}.",
        )

    deadline = time.monotonic() + PROFILE_CLEANUP_TIMEOUT_SECONDS
    while True:
        try:
            shutil.rmtree(profile_path)
            break
        except FileNotFoundError:
            break
        except OSError as exc:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"🧹 Failed to delete profile directory {profile_path}: {exc}") from exc
            time.sleep(PROFILE_CLEANUP_RETRY_SECONDS)
    if os.path.exists(profile_path):
        raise RuntimeError(f"🧹 Profile directory still exists after cleanup: {profile_path}")


def prepare_profile(profile_path: str, profile_mode: str) -> None:
    validate_profile_path(profile_path)
    if profile_mode in ("temporary", "reset"):
        clear_profile(profile_path)

    existed = os.path.exists(profile_path)
    os.makedirs(profile_path, exist_ok=True)
    marker_path = os.path.join(profile_path, PROFILE_MARKER_NAME)
    if not existed or profile_is_script_owned(profile_path):
        with open(marker_path, "w", encoding="utf-8") as marker:
            marker.write("sub2api auth profile\n")
    else:
        print(
            style(
                f"⚠️ [sub2api-auth] Reusing unmarked custom profile; it will never be deleted automatically: {profile_path}",
                "33",
            ),
            file=sys.stderr,
        )


def runtime_evaluate(ws: WebSocketClient, expression: str, timeout: float = 30) -> object:
    result = ws.call(
        "Runtime.evaluate",
        {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        },
        timeout=timeout,
    )
    if "exceptionDetails" in result:
        raise DevToolsError(f"⚠️ Runtime.evaluate exception: {result['exceptionDetails']}")
    return result.get("result", {}).get("value")


def wait_for_auth(ws: WebSocketClient, timeout_ms: int) -> dict:
    keys_json = json.dumps(STORAGE_KEYS)
    expression = f"""
(() => {{
  const keys = {keys_json};
  const storage = {{}};
  for (const key of keys) {{
    const value = localStorage.getItem(key);
    if (value !== null) storage[key] = value;
  }}
  return {{
    href: location.href,
    pathname: location.pathname,
    userAgent: navigator.userAgent,
    ready: Boolean(storage.auth_token && storage.auth_user),
    storage,
  }};
}})()
"""
    deadline = time.monotonic() + timeout_ms / 1000
    last_value: object = None
    while time.monotonic() < deadline:
        try:
            value = runtime_evaluate(ws, expression, timeout=5)
            last_value = value
            if isinstance(value, dict) and value.get("ready"):
                return value
        except Exception as exc:
            last_value = str(exc)
        time.sleep(0.5)
    raise TimeoutError(f"⏱️ Timed out waiting for localStorage auth_token + auth_user. Last state: {last_value}")


def launch_chrome(args: argparse.Namespace, port: int) -> subprocess.Popen:
    cmd = [
        args.browser,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={os.path.abspath(args.profile)}",
        "--no-first-run",
        "--disable-features=Translate",
        "--new-window",
        args.url,
    ]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def build_auth_state(url: str, user_agent: str, storage: dict) -> dict:
    local_storage = {key: str(value) for key, value in storage.items() if value is not None}
    local_storage["auth_user"] = normalize_auth_user(local_storage.get("auth_user"))
    if not local_storage.get("token_expires_at"):
        local_storage["token_expires_at"] = str(int(time.time() * 1000) + 24 * 60 * 60 * 1000)

    return {
        "origin": f"{urllib.parse.urlparse(url).scheme}://{urllib.parse.urlparse(url).netloc}",
        "userAgent": user_agent,
        "exported_at": utc_now_iso(),
        "localStorage": local_storage,
    }


def write_auth_state(out_path: str, payload: dict) -> str:
    payload_json = json.dumps(payload, ensure_ascii=False, indent=2)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as file:
        file.write(payload_json + "\n")
    return payload_json


def print_summary(payload: dict, out_path: str) -> None:
    local_storage = payload.get("localStorage") if isinstance(payload, dict) else {}
    if not isinstance(local_storage, dict):
        local_storage = {}

    expires_at = local_storage.get("token_expires_at")
    print()
    print(style("════════════════════════════════════════", "36"))
    print(style("✅ 登录态导出成功", "1", "32"))
    print(style("════════════════════════════════════════", "36"))
    print(style("🧩 Koishi 配置填写提示", "1", "35"))
    print(style(f"   🔗 sub2apiBaseUrl: {payload.get('origin', '未知')}", "1", "36"))
    print(style("   🔐 authStateJson: 复制下方完整 JSON", "1", "36"))
    print()
    print(style("⏰ Token 过期信息", "1", "33"))
    print(style(f"   原始 token_expires_at: {expires_at or '未知'}", "33"))
    print(style(f"   人类可读过期时间: {format_local_from_ms(expires_at)}", "1", "33"))
    print(style(f"   当前剩余时间: {format_remaining(expires_at)}", "1", "33"))
    print()
    print(style("📦 导出信息", "1", "32"))
    print(style(f"   🌐 页面 Origin: {payload.get('origin', '未知')}", "32"))
    print(style(f"   🏷️ 浏览器 UA: {payload.get('userAgent', '未知')}", "32"))
    print(style(f"   🕒 导出时间: {format_local_from_iso(payload.get('exported_at'))}", "32"))
    print(style(f"   💾 文件位置: {out_path}", "32"))
    print(style("════════════════════════════════════════", "36"))
    print(style("📋 下方 JSON 可直接粘贴到 Koishi 的 authStateJson 配置项。", "1", "35"))
    print()


def main() -> int:
    args = parse_args()
    if not args.browser:
        print(
            '[sub2api-auth] Missing --browser. Example: --browser "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"',
            file=sys.stderr,
        )
        return 1

    args.profile = os.path.abspath(args.profile)
    args.out = os.path.abspath(args.out)
    port = args.port or pick_port()
    keep_open = args.profile_mode == "open"
    profile_prepared = False
    chrome: Optional[subprocess.Popen] = None
    ws: Optional[WebSocketClient] = None

    try:
        prepare_profile(args.profile, args.profile_mode)
        profile_prepared = True
        chrome = launch_chrome(args, port)
        wait_for_devtools(port, 30_000)
        ws_url = find_page_ws(port, args.url)
        ws = WebSocketClient(ws_url)
        ws.connect()
        ws.call("Runtime.enable")
        ws.call("Page.enable")
        ws.call("Page.navigate", {"url": args.url})

        print(style(f"🌐 [sub2api-auth] Opened {args.url}", "36"))
        print(style("🔐 [sub2api-auth] Log in in the opened browser window if needed.", "33"))
        print(style("⏳ [sub2api-auth] Waiting for localStorage auth_token + auth_user ...", "33"))

        state = wait_for_auth(ws, args.timeout)
        storage = state.get("storage") if isinstance(state, dict) else None
        if not isinstance(storage, dict):
            raise DevToolsError("🔐 Auth state payload did not contain localStorage")
        user_agent = state.get("userAgent") if isinstance(state, dict) else None
        if not isinstance(user_agent, str) or not user_agent.strip():
            raise DevToolsError("🏷️ Auth state payload did not contain navigator.userAgent")

        payload = build_auth_state(args.url, user_agent.strip(), storage)
        payload_json = write_auth_state(args.out, payload)
        print_summary(payload, args.out)
        print(style("📦 [sub2api-auth] JSON:", "1", "35"))
        print(payload_json)

        if keep_open:
            print(style("🪟 [sub2api-auth] profile mode is open; press Ctrl+C to exit when done.", "33"))
            while True:
                time.sleep(3600)
        return 0
    finally:
        if ws and not keep_open:
            try:
                ws.call("Browser.close", timeout=5)
            except Exception:
                pass
            ws.close()
        if not keep_open and chrome:
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.terminate()
                try:
                    chrome.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    chrome.kill()
                    chrome.wait(timeout=5)
        if args.profile_mode == "temporary" and profile_prepared:
            clear_profile(args.profile)
            print(style(f"🧹 [sub2api-auth] Removed temporary profile: {args.profile}", "36"))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(style("\n🛑 [sub2api-auth] Interrupted.", "31"), file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(style(f"❌ [sub2api-auth] {exc}", "31"), file=sys.stderr)
        raise SystemExit(1)
