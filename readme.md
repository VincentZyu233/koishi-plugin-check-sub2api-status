# koishi-plugin-check-sub2api-status

[![npm](https://img.shields.io/npm/v/koishi-plugin-check-sub2api-status?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-check-sub2api-status)

检查你的sub2api中转站的状态捏

## 思路

sub2api 前端登录态保存在 `localStorage`：

- `auth_token`
- `refresh_token`
- `auth_user`
- `token_expires_at`

导出 JSON 还会记录登录页的 `origin` 和 `navigator.userAgent`。插件截图前会校验 Origin，设置相同的 User-Agent，再把登录态注入到 `sub2apiBaseUrl` 对应的页面环境里，按指令打开 `/monitor` 或 `/admin/dashboard`。

截图页会根据 `auth_user` 提前标记 sub2api 官方新手引导为已完成，并在截图前再检查 driver.js 引导层。如果新版 sub2api 仍显示引导，插件会通过官方关闭按钮或 `Escape` 销毁遮罩，避免灰色引导层进入截图。

Koishi 只从配置项 `authStateJson`、`enableCustomUserAgent` 和 `customUserAgent` 读取这些信息，不会读取或写回任何本地登录态文件。

## 导出登录态

推荐使用独立浏览器 profile，不直接读你日常浏览器的 profile。这样不会被 Chrome 文件锁卡住，也不会影响你自己的浏览器会话。

在 Koishi 根目录运行：

```powershell
node .\external\check-sub2api-status\tools\export-auth-state.mjs `
  --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --url "http://127.0.0.1:8080/monitor" `
  --profile ".\data\sub2api-auth-profile-js"
```

脚本会打开一个浏览器窗口。首次运行时在窗口里登录 sub2api，登录成功进入 `/monitor` 后，脚本会把 Origin、User-Agent 和 localStorage 合并成一份 JSON，在控制台打印，同时写入 `external/check-sub2api-status/tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json`。

如果不想依赖 Node/Puppeteer，也可以使用纯 Python 标准库版本。它通过 Chrome DevTools Protocol 导出 localStorage，不需要安装第三方 Python 包：

```powershell
python .\external\check-sub2api-status\tools\export-auth-state.py `
  --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --url "http://127.0.0.1:8080/monitor" `
  --profile ".\data\sub2api-auth-profile-py"
```

### 导出参数默认值

| 参数 | Node 版默认值 | Python 版默认值 | 说明 |
| --- | --- | --- | --- |
| `-b, --browser` | 依次读取 `CHROME_PATH`、`PUPPETEER_EXECUTABLE_PATH` | 依次读取 `CHROME_PATH`、`PUPPETEER_EXECUTABLE_PATH` | 两个环境变量均未设置时必须传入浏览器可执行文件路径 |
| `-u, --url` | `http://127.0.0.1:8080/monitor` | `http://127.0.0.1:8080/monitor` | sub2api 渠道状态页面地址，必须与需要导出登录态的 Origin 一致 |
| `-p, --profile` | `data/sub2api-auth-profile-js` | `data/sub2api-auth-profile-py` | 独立浏览器 Profile，默认路径相对于运行命令时的当前工作目录 |
| `--profile-mode` | `temporary` | `temporary` | Profile 生命周期，可选 `temporary`、`reuse`、`reset`、`open` |
| `-o, --out` | `tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json` | `tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json` | 默认文件实际保存在对应导出脚本所在目录的 `output` 子目录 |
| `--timeout` | `600000` 毫秒 | `600000` 毫秒 | 最多等待登录态出现 10 分钟 |
| `--port` | 不支持 | `0` | 仅 Python 版支持，`0` 表示自动选择空闲的 Chrome 调试端口 |

如果实际服务地址不是 `127.0.0.1`，请显式传入 `--url`。例如服务位于局域网 `192.168.31.25` 时，应使用 `--url "http://192.168.31.25:8080/monitor"`，否则导出的登录态会属于不同的浏览器 Origin。

### Profile 生命周期

`--profile-mode` 同时控制 Profile 启动前的处理方式、浏览器退出行为和运行后的清理方式：

| 模式 | 启动前 | 导出后 |
| --- | --- | --- |
| `temporary` | 删除脚本管理的旧 Profile，再创建全新 Profile | 关闭浏览器并删除整个 Profile |
| `reuse` | 复用现有 Profile，不存在则创建 | 关闭浏览器并保留 Profile |
| `reset` | 删除现有 Profile，再创建全新 Profile | 关闭浏览器并保留新的 Profile |
| `open` | 复用现有 Profile，不存在则创建 | 保持浏览器运行并保留 Profile |

默认模式是 `temporary`，因此正常导出不需要显式传入 `--profile-mode`，并且不会在磁盘上遗留浏览器 Profile。导出的登录态 JSON 位于 `tools/output`，不受 Profile 清理影响。

`tools/output` 中的 JSON 只是方便人工复制和备份的导出产物。Koishi 插件不会读取该目录，用户需要把控制台打印的完整 JSON 手动粘贴到 `authStateJson`。

需要复用登录状态时使用 `--profile-mode reuse`；需要丢弃旧登录状态并保留本次新 Profile 时使用 `--profile-mode reset`；需要导出后继续操作浏览器窗口时使用 `--profile-mode open`。

脚本创建的 Profile 会包含 `.sub2api-auth-profile` 标记文件。`temporary` 和 `reset` 只允许删除默认 Profile，或者包含该标记文件的自定义 Profile；磁盘根目录、用户主目录、当前工作目录、脚本目录、符号链接和 Windows Junction 均会被拒绝。任何清理失败都会立即报错并返回非零退出码。

## Koishi 配置

启用 `puppeteer` 服务后启用本插件，保留默认配置即可：

```yaml
check-sub2api-status:
  enableStatusCommand: true
  statusCommandName: sub2api-status
  enableTrendCommand: false
  trendCommandName: sub2api-trend
  sub2apiBaseUrl: http://127.0.0.1:8080
  enableCustomUserAgent: false
  customUserAgent: ''
  authStateJson: |
    {
      "origin": "http://127.0.0.1:8080",
      "userAgent": "Mozilla/5.0 ...",
      "exported_at": "2026-07-07T07:07:07Z",
      "localStorage": {
        "auth_token": "...",
        "refresh_token": "...",
        "auth_user": "...",
        "token_expires_at": "..."
      }
    }
```

把导出脚本控制台打印的完整 JSON 粘到 `authStateJson` 即可。导出的 token 属于敏感信息，`tools/output` 默认会忽略 JSON 文件，不建议提交到仓库。

### User-Agent 选择规则

- `enableCustomUserAgent: false`：使用 `authStateJson.userAgent`，即导出登录态时浏览器的真实 UA。
- `enableCustomUserAgent: true`：忽略导出的 UA，改用 `customUserAgent`。
- 启用自定义 UA 但 `customUserAgent` 为空，或者最终 UA 含有换行符时，插件会在访问 sub2api 前报错。
- 使用旧版脚本导出、不含 `userAgent` 的 JSON 时，需要重新导出，或显式启用自定义 UA。

### Origin 安全校验

`authStateJson.origin` 必须与 `sub2apiBaseUrl` 的 Origin 完全一致，包括协议、主机名和端口。如果不一致，插件会在发出任何 sub2api 请求前强制终止截图，避免会话 IP/UA 绑定因访问链路变化而撤销 refresh-token 家族。

例如，使用 `--url "http://192.168.31.25:8080/monitor"` 导出时，`sub2apiBaseUrl` 也必须填写 `http://192.168.31.25:8080`，不能改用公网域名。Origin 一致只能保证访问地址一致；如果 sub2api 开启会话 IP/UA 绑定，导出脚本与 Koishi 还应使用相同的网络出口。

## 指令

- `sub2api-status`：截图渠道状态页，默认启用。
- `sub2api-trend`：截图管理仪表盘中的“最近使用 (Top 12)”组件，默认关闭。启用后会固定使用暗色主题，并以约 1920px 宽度输出图表组件，不依赖整页裁剪参数。

两条指令均可分别通过 `enableStatusCommand`、`enableTrendCommand` 控制是否注册，也可以通过 `statusCommandName`、`trendCommandName` 修改指令名称。

`sub2apiBaseUrl` 只填写服务根地址，例如 `http://192.168.31.25:8080`。插件会为状态指令自动使用 `/monitor`，并为趋势指令自动使用 `/admin/dashboard`。

## 开发测试

`test/onboarding-tour.mjs` 保留了新手引导遮罩修复的回归测试。脚本会在内存中打包当前 `src/puppeteer.ts`，使用假 Puppeteer Page 验证引导完成键注入、官方关闭按钮以及失败兜底清理，不会启动浏览器、访问网络、读取真实登录态或生成临时构建文件。

```powershell
yarn test:onboarding
```
