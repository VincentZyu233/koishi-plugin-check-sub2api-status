# 测试脚本说明

本目录分为离线回归测试与真实浏览器实拍测试。日常修改优先运行回归测试；涉及登录态、页面结构、Canvas 或截图参数时再运行实拍测试。

## 目录

| 路径 | 用途 | 联网 |
| --- | --- | --- |
| `regression/` | mock 或内存打包回归 | 否 |
| `live/` | 读取 Koishi 配置并启动 Chromium | 是 |
| `output/` | 默认图片输出，已被 Git 忽略 | - |

## 快速运行

```powershell
npm run test:onboarding
npm run test:auth
npm run test:trend-range
npm run test:trend-time
npm run test:live-status
npm run test:live-trend
```

实拍参数帮助：

```powershell
npm run test:live-status -- --help
npm run test:live-trend -- --help
```

脚本使用加粗 emoji 和 ANSI 颜色区分信息、路径、进度、成功与失败；设置 `NO_COLOR=1` 可以关闭颜色。每轮截图会输出纯文本绝对路径，便于在 VS Code 终端中点击图片。

## 回归脚本

| 脚本 | npm 命令 | 验证内容 |
| --- | --- | --- |
| `regression/onboarding-tour.mjs` | `test:onboarding` | 引导完成标记、官方关闭按钮、Escape 与遮罩清理 |
| `regression/auth-auto-relogin.mjs` | `test:auth` | token 轮换、密码回退、TOTP、互斥、冷却、Origin 校验 |
| `regression/trend-screenshot-range.mjs` | `test:trend-range` | A/B/C 范围、矩形合并、配置分组、emoji、Canvas 稳定等待 |
| `regression/trend-time-range.mjs` | `test:trend-time` | 默认范围、小时/天别名、自然日与范围限制 |

这些脚本不启动浏览器、不访问 sub2api，也不读取真实账号、密码或 token；TypeScript 源码通过 esbuild 在内存中打包，不留下 bundle。

## 实拍脚本

| 脚本 | 用途 |
| --- | --- |
| `live/run-live-screenshot.mjs` | 打包并启动 status/trend 测试入口 |
| `live/live-screenshot-harness.ts` | 只读加载配置、启动浏览器、调度批次与汇总结果 |
| `live/status-screenshot.test.ts` | 调用生产 `captureStatusScreenshot()` |
| `live/trend-screenshot.test.ts` | 调用生产 `captureTrendScreenshot()` |

实拍测试默认只读加载工作区根目录的 `koishi.yml`，应用 Schema 默认值，每批 5 次、间隔 2 秒并复用一个 Chromium。每轮使用新页面，默认输出到 `test/output/`，日志不会打印认证配置。

通用参数：

```text
--config <path>  --output <dir>  --count <int>  --interval-ms <ms>
--executable-path <path>  --headless / --no-headless
--wait-until <mode>  --wait-after-loaded-ms <ms>
--navigation-timeout-ms <ms>  --device-scale-factor <num>
--image-type <png|jpeg|webp>  --image-quality <1-100>
```

状态页参数：`--viewport-width`、`--viewport-height`、`--wait-for-selector`、`--[no-]full-page`、`--crop-rules-json`。

趋势页参数：`--num`、`--unit <h|hour|时|小时|d|day|天|日>`、`--trend-screenshot-range <all|charts-and-recent|recent-only>`。

## 示例

```powershell
# 1 倍缩放执行 10 次趋势截图
npm run test:live-trend -- --count 10 --device-scale-factor 1 --output test/output/trend-dpr-1

# 覆盖状态页视口，其余沿用 Koishi 配置
npm run test:live-status -- --viewport-width 1280 --viewport-height 900 --count 5

# 自定义 7 天、按天粒度的趋势范围
npm run test:live-trend -- --num 7 --unit day
```

## 安全说明

- Loader 会被设置为只读，不会重写 `koishi.yml`。
- 不要提交真实配置、登录态、账号密码或测试输出。
- 提交前检查 `git status`，确认 `output/` 仍被忽略。
- 实拍会访问真实管理接口，不要在生产高峰期使用过大的 `--count`。
- 认证错误会中止剩余批次，避免持续刷新或登录。
