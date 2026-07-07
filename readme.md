# koishi-plugin-check-sub2api-status

[![npm](https://img.shields.io/npm/v/koishi-plugin-check-sub2api-status?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-check-sub2api-status)

检查你的sub2api中转站的状态捏

## 思路

sub2api 前端登录态保存在 `localStorage`：

- `auth_token`
- `refresh_token`
- `auth_user`
- `token_expires_at`

插件截图前会把这些值注入到 `monitorUrl` 的页面环境里，再打开状态页。登录态只从 Koishi 配置项 `authStateJson` 读取，不再额外读取或写回文件。

## 导出登录态

推荐使用独立浏览器 profile，不直接读你日常浏览器的 profile。这样不会被 Chrome 文件锁卡住，也不会影响你自己的浏览器会话。

在 Koishi 根目录运行：

```powershell
node .\external\check-sub2api-status\tools\export-auth-state.mjs `
  --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --url "http://127.0.0.1:8080/monitor" `
  --profile ".\data\sub2api-auth-profile"
```

脚本会打开一个浏览器窗口。首次运行时在窗口里登录 sub2api，登录成功进入 `/monitor` 后，脚本会在控制台打印 JSON，同时写入 `external/check-sub2api-status/tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json`。

如果不想依赖 Node/Puppeteer，也可以使用纯 Python 标准库版本。它通过 Chrome DevTools Protocol 导出 localStorage，不需要安装第三方 Python 包：

```powershell
python .\external\check-sub2api-status\tools\export-auth-state.py `
  --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --url "http://127.0.0.1:8080/monitor" `
  --profile ".\data\sub2api-auth-profile-py"
```

## Koishi 配置

启用 `puppeteer` 服务后启用本插件，保留默认配置即可：

```yaml
check-sub2api-status:
  commandName: sub2api-status
  monitorUrl: http://127.0.0.1:8080/monitor
  authStateJson: |
    {
      "origin": "http://127.0.0.1:8080",
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
