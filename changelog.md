# 📜✨ koishi-plugin-check-sub2api-status 变更日志 ✨📜

> 🐾 本文件依据仓库 `git log`、提交正文、文件统计与当前工作区差异整理。
>
> 🧭 版本记录采用倒序排列，优先展示最新功能、兼容性变化、安全策略与验证结果。
>
> 🔐 登录态 JSON、Token、Refresh Token、用户信息与真实服务地址均不会写入本日志。

## 🚧🖼️ 未发布

- 📈🎨 趋势截图不再仅凭 Canvas 宽高判断渲染完成。
- 🧪🖼️ 新增缩略像素采样，要求每个目标 Canvas 已存在真实绘制像素。
- ⏳📊 新增 750ms 连续像素签名稳定窗口，避开空白帧、动画中间帧与响应式 resize。
- 🔎🌐 `deviceScaleFactor` 移入通用截图设置，并同时作用于状态页与趋势页。
- 🧪🌐 实拍 CLI 的 `--device-scale-factor` 同步改为两类截图共用参数。
- 🗂️🧪 测试脚本整理为 `test/regression/` 与 `test/live/` 两类目录。
- 📚🧭 新增 `test/README.md`，逐项说明离线回归、真实实拍、CLI 覆盖与安全约束。
- 🎨🖥️ 测试输出统一增加加粗 emoji 与 ANSI 状态颜色，并支持 `NO_COLOR=1` 关闭颜色。
- 📂🔗 每轮实拍的开始与成功日志输出纯文本绝对图片路径，便于 VS Code 终端点击跳转。
- ✅📸 真实环境完成 DPR 3.3 与 DPR 1 各 5 轮趋势截图验证，两组均为 5/5 成功。

---

## 🔄🔐 0.1.6-alpha.8+20260723 - 2026-07-23

### 🧾🔖 版本信息

- ⬆️📦 版本：`0.1.5-alpha.7+20260722` → `0.1.6-alpha.8+20260723`。
- 🔄🔐 新增 sub2api token 进程内轮换与可选密码重新登录能力。
- 🛡️🔒 自动重新登录默认关闭，升级后不会主动使用账号密码。

### 🎛️🔑 新增配置

- 🔄🔐 新增 `enableAutoRelogin`，默认值为 `false`。
- 📧🔐 新增 `loginEmail`，用于配置 sub2api 本地管理员登录邮箱。
- 🔑🛡️ 新增 `loginPassword`，使用 Koishi `secret` 输入角色遮罩显示。
- ⚠️📄 README 明确说明 `secret` 只负责界面遮罩，不加密 `koishi.yml`。
- 😀📝 三个新增配置的 description 均包含 1–2 个 emoji。

### ♻️🧠 运行时登录态

- 🔁🔐 access token 距离过期不足两分钟时主动调用官方 refresh API。
- 🔄🗝️ refresh 成功后原子替换 access token、refresh token 与过期时间。
- 🧠🚫 轮换后的 token 只保存在插件进程内，不回写 Koishi 配置或本地文件。
- 📥🔄 页面自身发生 token 轮换时，在关闭 Puppeteer 页面前回收最新 localStorage。
- 🔒🧵 同一插件配置的并发截图共享认证互斥锁，只允许一次 token 轮换。
- 🔁🛡️ 页面意外返回认证错误时，单次截图最多恢复登录态并重试一次。

### 🔐🚪 密码回退

- 🚫🔑 refresh 成功时不会读取或发送配置的登录密码。
- 4️⃣0️⃣1️⃣ 仅在 refresh 确定返回认证失效后调用 `/api/v1/auth/login`。
- 🌐🏷️ 登录、刷新和截图均复用 Puppeteer 页面、Origin、User-Agent 与网络出口。
- 🧷🌍 保持与 sub2api Session Binding 的 IP/UA 指纹要求兼容。
- ⏳🛑 密码登录失败后固定冷却 60 秒，避免持续触发登录限流。
- 🔢⛔ 登录返回 TOTP 2FA 挑战时明确停止，不保存密钥或绕过二次验证。
- 🧩⛔ Cloudflare Turnstile 启用时不尝试生成或绕过人机验证 token。

### 📚🛡️ 使用文档

- 📋✅ README 新增 sub2api 自动登录必要配置检查表。
- 👤✅ 说明本地密码、管理员权限、账号状态与 TOTP 要求。
- ☁️✅ 说明 Turnstile 必须关闭。
- 🧷✅ 说明 Session Binding 可以开启，但代理、出口 IP 与 UA 必须稳定。
- 🌐✅ 继续要求 `authStateJson.origin` 与 `sub2apiBaseUrl` 完全一致。
- 🔐✅ 说明 `authStateJson` 仍是提供 Origin、UA 与初始 token 的必填种子配置。

### 📦🔒 发布安全

- 📋🔐 将 npm 发布白名单从整个 `tools` 目录收紧到两个导出脚本。
- 🚫🗃️ 阻止 `tools/output` 中的真实登录态 JSON 进入 npm tarball。
- 🚫🧪 阻止 `tools/tmp` 中的开发验证产物进入 npm tarball。
- 🛡️📦 弥补 `.gitignore` 不会自动影响 `npm pack` 的安全缺口。

### 🧪✅ 验证

- 🔄✅ 新增 `test/regression/auth-auto-relogin.mjs` 验证 refresh token 轮换。
- 🚫✅ 验证自动重新登录默认关闭。
- 🔑✅ 验证 refresh 401 后使用密码登录并更新用户状态。
- 🔢✅ 验证 TOTP 挑战会被明确拒绝。
- 🧵✅ 验证两个并发截图只执行一次 refresh。
- 📥✅ 验证页面轮换后的 token 会同步回运行时会话。
- 🛡️✅ 验证 Origin 不一致时在任何导航前终止。

---

## 🎛️📸 0.1.5-alpha.7+20260722 - 2026-07-22

### 🧾🔖 版本信息

- ⬆️📦 版本：`0.1.4-alpha.6+20260722` → `0.1.5-alpha.7+20260722`。
- 🧩✅ 配置键、默认值和截图运行逻辑保持兼容。
- 🎛️✨ 本版本主要改善 Koishi 控制台配置项的职责划分与可读性。

### 🎛️🧭 配置分组

- 🌐📸 将两条指令共用的配置移动到“通用截图设置”。
- 📡📸 将只影响 `sub2api-status` 的配置移动到“状态页截图设置”。
- 📈📸 将 `trendScreenshotRange` 移动到“趋势截图设置”。
- 🧹📋 从“指令设置”中移除不属于指令注册行为的截图范围配置。
- 🌐⏳ 通用分组包含 `waitUntil`、`waitAfterLoadedMs` 与 `navigationTimeoutMs`。
- 🌐🖼️ 通用分组包含 `imageType` 与 `imageQuality`。
- 📡↔️ 状态页分组包含 `viewportWidth` 与 `viewportHeight`。
- 📡🔎 状态页分组包含 `deviceScaleFactor`。
- 📡🎯 状态页分组包含 `waitForSelector`。
- 📡🧾 状态页分组包含 `fullPage` 与 `cropRules`。
- 📈📐 趋势分组包含 `trendScreenshotRange`。
- 📈🖥️ 趋势配置说明明确标注固定 `2240 × 1200 × 1` 视口策略。
- 😀📝 所有调整后的 Schema description 均保留 1–2 个 emoji。

### 📚🖼️ 文档与预览

- 🖼️📡 新增渠道状态效果预览图 `docs/images/preview/preview.status.png`。
- 🖼️📈 新增管理仪表盘趋势效果预览图 `docs/images/preview/preview.trend.png`。
- 📚👀 README 开头新增“效果预览”章节。
- 📡🧾 README 展示 `sub2api-status` 的真实渠道状态输出。
- 📈🧩 README 展示 `sub2api-trend` 默认 `A+B+C` 趋势输出。
- 🗂️📋 README 新增三个截图配置分组的适用范围表格。
- ⚠️🖼️ README 说明 `imageQuality` 仅影响 JPEG 与 WebP。
- 📐🛡️ README 说明趋势截图不会读取状态页视口、完整页面与裁剪规则。

### 🧪✅ 验证

- 🧩✅ 回归测试锁定通用、状态页、趋势三个分组名称。
- 🔢✅ 回归测试锁定三个截图分组的展示顺序。
- 😀✅ 回归测试继续检查全部 description 的 emoji。
- 🧰✅ 通过 TypeScript 类型检查。
- 📦✅ 通过 esbuild 入口打包检查。
- 🧹✅ 通过 `git diff --check` 检查。

### 📸✨ 本版本收录的预览资源

- 🖼️📡 新增渠道状态效果预览图 `docs/images/preview/preview.status.png`。
- 🖼️📈 新增管理仪表盘趋势效果预览图 `docs/images/preview/preview.trend.png`。
- 📚👀 在 README 开头加入“效果预览”章节，让读者先看到真实输出结果。
- 📡🧾 为 `sub2api-status` 预览图补充明确标题、指令说明与替代文本。
- 📈🧩 为 `sub2api-trend` 预览图注明默认采用 `A+B+C` 完整截图范围。

### 📝🎨 文档

- 🔗📁 README 使用仓库内相对路径引用预览图，便于 Git 仓库直接渲染。
- ♿🖼️ 两张预览图均设置了清晰的 Markdown alt 文本。
- ✅🔍 已验证两个文件均具有有效 PNG 文件签名。
- 📏💾 渠道状态预览图大小为 1,132,259 字节。
- 📏💾 管理趋势预览图大小为 321,764 字节。
- 🧹✅ 当前 README 差异已通过 `git diff --check` 检查。

---

## 🚀📈 0.1.4-alpha.6+20260722 - 2026-07-22

### 🧾🔖 提交信息

- 🆔✨ 提交：`28672d0 feat: 扩展管理仪表盘趋势截图范围与时间参数`。
- ⬆️📦 版本：`0.1.2-alpha.4+20260722` → `0.1.4-alpha.6+20260722`。
- 📊🧮 统计：9 个文件变更，新增 794 行，删除 64 行。
- 🤝💻 协作者：`Codex <codex@openai.com>`。

### ✨🧩 新增截图范围

- 🎛️📐 新增 `trendScreenshotRange` Koishi 单选配置。
- 🧩🅰️ `all` 模式截取 A、B、C 三个连续区域。
- 📊🅱️ `charts-and-recent` 模式截取 B、C 两个连续区域。
- 📉🅲️ `recent-only` 模式仅截取 C 区域。
- 🌟📸 默认值设为 `all`，首次启用即可获得完整仪表盘趋势截图。
- 🅰️📅 A 区域包含时间范围、刷新按钮与统计粒度。
- 🅱️📊 B 区域包含模型分布与 Token 使用趋势。
- 🅲️📈 C 区域包含最近使用 Top 12 趋势图。
- 🧭🔍 通过“最近使用”标题反向定位卡片及其相邻区域。
- 🏷️🧱 使用临时 `data-sub2api-trend-*` 属性标记目标 DOM。
- 📐🧮 根据实际 DOM 矩形计算联合截图边界。
- 🚫📏 不再依赖趋势区域的固定像素高度。
- 🔲✨ 对小数坐标向外取整，避免裁掉一像素边框。
- 🌐🖼️ 使用 `captureBeyondViewport` 捕获超出当前视口的完整区域。
- 🛡️🎯 页面结构变化时明确报错，不返回错位或残缺图片。

### ⏱️📅 新增时间范围参数

- ⌨️📈 趋势指令升级为 `sub2api-trend [num:number] [unit:string]`。
- 🔢✅ `num` 必须为正整数。
- 🕐✅ 小时范围限制为 `1–168`。
- 📆✅ 天数范围限制为 `1–365`。
- 🕐🔤 小时别名支持 `h`、`hr`、`hour`、`hours`、`时`、`小时`。
- 📅🔤 天数别名支持 `d`、`day`、`days`、`天`、`日`。
- 🔡🔄 英文单位忽略大小写。
- 🕛🌟 不传参数时默认使用 `24 hour`。
- 🔢🕐 只传 `num` 时默认使用 `hour`。
- 🚫🌐 参数错误时在创建浏览器页面前终止。
- 📏⚠️ 超过最大范围时返回明确的中文错误信息。
- 🧮🕰️ `N hour` 从当前时间减去 N 小时后转换为自然日边界。
- 📆➕ `N day` 按包含今天在内的 N 个自然日计算。
- 🗓️🔚 正确适配 sub2api 后端包含完整 `end_date` 的规则。
- ⚠️🕐 明确说明小时参数不是严格滚动小时窗口。
- 🧰🧩 时间类型、别名、默认值与解析逻辑统一收纳到 `src/utils.ts`。

### 🖱️🎛️ 页面交互

- 📅🖱️ 通过 sub2api 官方日期选择器写入开始日期与结束日期。
- 📨🔄 为两个日期输入框派发 `input` 与 `change` 事件。
- ✅📅 点击官方应用按钮触发 Vue 状态更新。
- 🕐🖱️ 通过官方 Select 组件切换 `hour` 或 `day` 粒度。
- 🌍🚫 粒度选项按源码顺序选择，不依赖中文或英文界面文本。
- 🔁📡 目标粒度已选中时再次点击触发按钮关闭浮层。
- 🧹🪟 防止 Select 传送到 `body` 的下拉层残留在最终截图中。
- 📡🎯 只接受日期与粒度完全匹配的接口响应。
- 📊🔄 包含 B 区域时等待 `/admin/dashboard/snapshot-v2`。
- 📈🔄 所有趋势截图均等待 `/admin/dashboard/users-trend`。
- 🔐🚨 同时监听 `/auth/refresh` 的 401 与 403 响应。
- 🛡️⛔ 登录态失效时立即停止后续截图流程。

### 🎨📊 渲染稳定性

- 🖥️🌙 趋势截图继续强制使用暗色主题。
- 📏🖥️ 趋势截图继续使用稳定的宽屏视口。
- ⏳🎨 接口完成后等待 Chart.js Canvas 真正具备尺寸。
- 📈✅ C 区域至少需要一个可渲染 Canvas。
- 📊✅ B 区域至少需要两个可渲染 Canvas。
- 🐢⏱️ 慢速环境最多额外等待 10 秒完成 Canvas 渲染。
- 📭⚠️ 数据为空时返回明确提示，不发送空白图片。
- 🧭🔍 截图边界随日期、图例与数据量自动变化。

### 🆘📖 指令帮助

- 📈📅 趋势指令描述增加多个 emoji，提升帮助页辨识度。
- 🔢📏 `--help` 明确展示 hour 与 day 的数量限制。
- 🔤🌍 `--help` 列出全部中英文单位别名。
- 🌟🕛 `--help` 说明默认值为 `24 hour`。
- 🕐📝 `--help` 说明省略 unit 时默认使用 hour。

### 🧪✅ 测试与验证

- 🧪🧩 新增 `test/regression/trend-screenshot-range.mjs`。
- 📐✅ 验证 A+B+C、B+C 与 C 三档范围映射。
- 🧮✅ 验证多个 DOM 矩形的联合边界计算。
- 🔲✅ 验证小数坐标向外取整行为。
- 🎛️✅ 验证 day 已选中时下拉框会被正确关闭。
- 🕐✅ 验证从 day 切换到 hour 时选择第二个官方选项。
- 😀✅ 验证 `src/config.ts` 中全部 description 都包含 emoji。
- 🧪⏱️ 新增 `test/regression/trend-time-range.mjs`。
- 🌟✅ 验证默认 `24 hour` 的日期计算。
- 🔤✅ 验证全部中英文单位别名。
- 🔡✅ 验证英文单位大小写兼容。
- 📆✅ 验证自然日包含规则。
- 🚫✅ 验证零、负数、小数与未知单位会被拒绝。
- 📏✅ 验证 168 小时与 365 天的范围上限。
- 🧪🧭 继续通过 onboarding-tour 回归测试。
- 🧰✅ 通过 TypeScript 类型检查。
- 📦✅ 通过 esbuild 入口打包检查。
- 🧹✅ 通过 `git diff --check` 检查。

### 📚📝 文档

- 📐🧩 README 新增趋势截图范围说明表格。
- 🅰️🅱️ README 解释 A、B、C 三个区域的具体含义。
- ⌨️📈 README 新增趋势指令参数示例。
- 🔤📖 README 列出 hour 与 day 全部别名。
- ⚠️🕐 README 解释自然日边界与非严格滚动小时语义。
- 🖱️📅 README 说明插件通过官方控件应用筛选条件。
- 🧪📚 README 新增三项开发测试命令。

### ⚠️🔄 升级提示

- 🌟📸 趋势截图默认范围由仅 C 扩大为 A+B+C。
- 🖼️📏 默认趋势图片会比旧版本更高。
- 🎛️🔙 需要旧行为时将 `trendScreenshotRange` 设置为 `recent-only`。
- 🕛📅 无参数趋势指令仍采用 sub2api 官方近 24 小时语义。
- 🧭🛡️ 若 sub2api 页面结构改变，插件会报错并提示重新适配。

---

## 🛡️🔐 0.1.2-alpha.4+20260722 - 2026-07-22

### 🧾🔖 提交信息

- 🆔✨ 提交：`9631f9f feat: 加固 sub2api 登录态导出与截图兼容性`。
- ⬆️📦 版本：`0.1.0-alpha.2+20260722` → `0.1.2-alpha.4+20260722`。
- 📊🧮 统计：9 个文件变更，新增 753 行，删除 101 行。
- 🤝💻 协作者：`Codex <codex@openai.com>`。

### 🔗🌐 配置迁移

- 🔄🧭 将 `monitorUrl` 不兼容地重命名为 `sub2apiBaseUrl`。
- 🏠🔗 `sub2apiBaseUrl` 只需要填写服务 Origin 根地址。
- 📡🛣️ 状态指令自动派生 `/monitor` 路径。
- 📈🛣️ 趋势指令自动派生 `/admin/dashboard` 路径。
- ⌨️📈 趋势指令默认名称调整为 `sub2api-trend`。
- ⚙️🧪 新增 `enableCustomUserAgent` 配置。
- 🏷️📝 新增 `customUserAgent` 配置。
- 😀✅ 所有新增 Koishi description 均包含 emoji。

### 🔐🧾 登录态结构

- 🌐📦 导出 JSON 新增 `origin` 字段。
- 🏷️📦 导出 JSON 新增 `userAgent` 字段。
- 🗃️📦 继续导出 `auth_token`、`refresh_token`、`auth_user` 与 `token_expires_at`。
- 🛡️🔗 截图前强制校验登录态 Origin 与配置地址 Origin。
- ⛔🌐 Origin 不一致时在发出请求前终止。
- 🔥🛡️ 避免错误访问链路撤销 refresh-token 家族。
- 🏷️🌐 首次导航前设置导出或自定义 User-Agent。
- 🚫📝 拒绝包含换行符的 User-Agent。
- ⚠️🏷️ 启用自定义 UA 但内容为空时明确报错。
- 📁🚫 Koishi 插件不读取本地登录态文件。
- 📝👤 用户需要手动把导出 JSON 粘贴到 `authStateJson`。

### 🌐🧰 登录态导出工具

- 🟩🧰 Node 导出工具新增 `--profile-mode` 参数。
- 🐍🧰 Python 导出工具新增 `--profile-mode` 参数。
- 🧼🕒 `temporary` 模式使用一次性 Profile 并在结束后删除。
- ♻️📁 `reuse` 模式复用并保留现有 Profile。
- 🆕📁 `reset` 模式清理旧 Profile 后保留新 Profile。
- 🪟📁 `open` 模式保留浏览器窗口与 Profile。
- 🏷️🛡️ Profile 使用 `.sub2api-auth-profile` 文件标记脚本所有权。
- ⛔💽 拒绝删除磁盘根目录。
- ⛔🏠 拒绝删除用户主目录。
- ⛔📂 拒绝删除当前工作目录与脚本目录。
- ⛔🔗 拒绝删除符号链接与 Windows Junction。
- 🔒🪟 增加浏览器关闭等待，降低 Windows 文件锁冲突概率。
- 🔁🧹 增加 Windows 文件锁删除重试。
- ❌🧹 Profile 清理失败时返回非零退出码。
- 💾📄 导出的 JSON 继续保存到 `tools/output` 供人工备份。

### 🚪🧭 新手引导处理

- 🗃️✅ 根据 `auth_user` 预先写入 sub2api 官方引导完成键。
- 🧭🔍 截图前检测 driver.js popover 与 overlay。
- ❎🖱️ 优先点击官方关闭按钮。
- ⌨️🚪 官方关闭失败时尝试按下 Escape。
- 🧹🛡️ 最后使用一次性 DOM 清理移除残留遮罩。
- 🌫️🚫 避免灰色遮罩与欢迎卡片进入最终截图。
- 🧪🧭 新增 `test/regression/onboarding-tour.mjs` 回归测试。
- 🧠📦 测试通过 esbuild 在内存中打包当前 TypeScript 源码。
- 🌐🚫 测试不访问网络、不读取真实 Token、不启动浏览器。

### 🧪✅ 验证

- 🧭✅ 通过 onboarding-tour 回归测试。
- 🟩✅ 通过 Node 脚本语法与导出结构检查。
- 🐍✅ 通过 Python 脚本语法与导出结构检查。
- 🧰✅ 通过 TypeScript 类型检查。
- 📦✅ 通过 esbuild 打包检查。
- 🧹✅ 通过 `git diff --check` 检查。

### ⚠️🔄 升级提示

- 🔄🧭 旧配置中的 `monitorUrl` 需要迁移为 `sub2apiBaseUrl`。
- 🌐🔐 旧导出 JSON 缺少 Origin 或 UA 时应重新导出。
- 🧪🏷️ 无法重新导出时可以显式启用自定义 User-Agent。
- 🛡️🌍 导出脚本与 Koishi 最好使用相同网络出口。

---

## 📈🌙 0.1.0-alpha.2+20260722 - 2026-07-22

### 🧾🔖 提交信息

- 🆔✨ 提交：`f3b916a feat: 新增最近使用趋势组件截图指令`。
- ⬆️📦 版本：`0.0.1` → `0.1.0-alpha.2+20260722`。
- 📊🧮 统计：6 个文件变更，新增 331 行，删除 134 行。
- 🤝💻 协作者：`Codex <codex@openai.com>`。

### ✨📈 新增

- 📈⌨️ 新增管理仪表盘最近使用趋势截图指令。
- 🎛️📡 新增 `enableStatusCommand` 状态指令开关。
- ⌨️📡 新增 `statusCommandName` 状态指令名称配置。
- 🎛️📈 新增 `enableTrendCommand` 趋势指令开关。
- ⌨️📈 新增 `trendCommandName` 趋势指令名称配置。
- 🌙🎨 趋势截图固定使用暗色主题。
- 🖥️📏 趋势截图固定使用宽屏视口。
- 📡⏳ 根据 `/users-trend` 接口响应判断加载状态。
- 🔐🚨 监听认证刷新失败响应。
- 🛡️⛔ 识别管理权限不足与登录态失效。
- 📭⚠️ 识别无趋势数据状态。
- ⏱️⚠️ 识别接口等待超时。
- 🎯🔍 通过 Top 12 或“最近使用”标题定位目标卡片。
- 🖼️🧩 使用元素级截图代替趋势页面固定裁剪。

### ♻️🧰 重构

- 🧰🖥️ 将 Puppeteer 页面与截图逻辑拆分到 `src/puppeteer.ts`。
- 🔐🗃️ 集中封装登录态注入流程。
- 🌐🧭 集中封装页面导航与接口等待流程。
- 🎯🧩 集中封装组件定位与截图流程。
- ✂️📐 集中封装状态页裁剪流程。
- 💬♻️ 统一复用等待提示、引用回复、日志与错误处理。
- 🧱🔄 统一处理 Buffer、Uint8Array 与 Base64 截图结果。
- 🎛️🧭 根据指令开关按需注册命令。

### 🧪✅ 验证

- 🧰✅ 通过 TypeScript 类型检查。
- 📦✅ 通过 esbuild 打包检查。
- 🧹✅ 通过 `git diff --check` 检查。

### ⚠️📝 当时状态

- 📈🔤 趋势指令最初默认名称为 `trend`。
- 🅲️📸 当时仅截取最近使用 Top 12 卡片。
- 📐🚫 当时尚未提供 A+B+C、B+C、C 三档范围配置。
- ⏱️🚫 当时尚未提供 num 与 unit 时间参数。

---

## 🌱📡 0.0.1 - 2026-07-07

### 🧾🔖 提交信息

- 🆔✨ 提交：`bb4d732 init: 实现 sub2api 状态页截图插件`。
- 📦🟰 版本：`0.0.1` → `0.0.1`，初始化功能提交保持版本号不变。
- 📊🧮 统计：11 个文件变更，新增 1,356 行，删除 8 行。
- 🤝💻 协作者：`Codex <codex@openai.com>`。

### ✨📡 初始功能

- 🤖🔌 接入 Koishi Puppeteer 服务。
- 💉🧩 声明插件依赖 Puppeteer 注入。
- 📡⌨️ 新增 `sub2api-status` 指令。
- 🌐🖼️ 支持截图 sub2api `/monitor` 渠道状态页面。
- 🔐🗃️ 支持通过 `authStateJson` 注入 localStorage 登录态。
- 🧩📦 兼容 `localStorage`、`items`、`storage` 等导出结构。
- 💬⏳ 支持截图等待提示消息。
- 💬↩️ 支持引用触发消息回复图片。
- ❌💬 支持截图失败错误提示。
- 🐛📋 支持详细日志开关。

### 📸⚙️ 截图配置

- ↔️🖥️ 新增浏览器视口宽度配置。
- ↕️🖥️ 新增浏览器视口高度配置。
- 🔎🖼️ 新增设备缩放倍率配置。
- 🌐⏳ 新增页面导航等待策略。
- 🎯⏳ 新增截图前等待选择器。
- ⏱️🎨 新增页面加载后额外等待时间。
- ⌛🌐 新增页面导航超时时间。
- 🧾🖼️ 新增完整页面截图开关。
- ✂️⬆️ 新增顶部裁剪规则。
- ✂️➡️ 新增右侧裁剪规则。
- ✂️⬇️ 新增底部裁剪规则。
- ✂️⬅️ 新增左侧裁剪规则。
- 🖼️📤 支持 PNG 输出。
- 🌄📤 支持 JPEG 输出。
- 🌐📤 支持 WebP 输出。
- 🎚️🖼️ 支持 JPEG 与 WebP 图片质量配置。

### 🧰🔐 导出工具

- 🟩🧰 新增 Node 版登录态导出工具 `tools/export-auth-state.mjs`。
- 🐍🧰 新增纯 Python 标准库导出工具 `tools/export-auth-state.py`。
- 🌐🔌 Python 版本通过 Chrome DevTools Protocol 读取 localStorage。
- 📦🚫 Python 版本无需安装第三方 Python 包。
- 💾📄 支持把导出登录态写入 JSON 文件。
- 🖨️📋 支持在控制台输出可直接粘贴的 JSON。
- ⏰🔐 支持显示 Token 过期信息。

### 🗂️📦 工程配置

- 📦🧰 将 `tools` 目录加入 npm 发布文件列表。
- 🧩📦 添加 Puppeteer 相关开发依赖。
- 🙈📁 `.gitignore` 忽略输出目录与临时目录。
- 🙈🔐 `.gitignore` 忽略本地浏览器 Profile 数据。
- 🧰😴 新增 MIME 类型转换工具。
- 🧰⏱️ 新增 `sleep` 异步等待工具。
- 📚📝 README 补充登录态导出与 Koishi 配置说明。
- 🛡️📖 README 补充敏感登录态安全提醒。

### 🏁✅ 初始结果

- 📡✅ 插件具备完整的渠道状态截图能力。
- 🔐✅ 插件能够注入导出的浏览器登录态。
- ✂️✅ 插件能够按配置裁剪状态页面。
- 🖼️✅ 插件能够输出多种图片格式。
- 🧰✅ Node 与 Python 两种导出路径均可使用。

---

## 🏗️🌱 仓库初始化 - 2026-07-07

### 🧾🔖 提交信息

- 🆔🌱 提交：`7cf15a4 initial commit`。
- 📊🧮 统计：7 个文件变更，新增 96 行。

### 🧱📁 初始化内容

- 📝🌱 创建基础 README。
- 📦🌱 创建 `package.json`。
- 🧰🌱 创建 `tsconfig.json`。
- 🧩🌱 创建最小 `src/index.ts` 插件入口。
- ✍️🌱 创建 `.editorconfig`。
- 🔤🌱 创建 `.gitattributes`。
- 🙈🌱 创建 `.gitignore`。
- 🤖🌱 确立 Koishi 插件基础工程结构。

---

## 🗺️📊 版本演进摘要

- 🌱📦 `0.0.1`：建立状态页截图、登录态注入、裁剪与导出工具基础能力。
- 📈🌙 `0.1.0-alpha.2+20260722`：新增管理仪表盘最近使用趋势截图。
- 🛡️🔐 `0.1.2-alpha.4+20260722`：加固 Origin、UA、Profile 生命周期与新手引导兼容性。
- 🧩⏱️ `0.1.4-alpha.6+20260722`：新增三档截图范围、时间参数与官方控件联动。
- 🎛️📸 `0.1.5-alpha.7+20260722`：重组截图配置分组并加入真实效果预览图。
- 🔄🔐 `0.1.6-alpha.8+20260723`：新增进程内 token 轮换与可选密码重新登录。

## 🧪🧭 当前测试矩阵

- 🧭✅ `yarn test:onboarding`：验证新手引导预处理、官方关闭与失败兜底清理。
- 🔄✅ `yarn test:auth`：验证 token 轮换、密码回退、并发互斥、TOTP 拒绝与 Origin 安全校验。
- 🧩✅ `yarn test:trend-range`：验证截图区域、边界计算、emoji 描述与官方控件交互。
- ⏱️✅ `yarn test:trend-time`：验证时间默认值、单位别名、日期计算与范围限制。
- 🧰✅ TypeScript：验证配置、指令、Puppeteer 与工具类型契约。
- 📦✅ esbuild：验证插件入口及运行时代码可以完整打包。
- 🧹✅ `git diff --check`：验证空白字符与补丁格式。

## 🔐⚠️ 安全提醒

- 🔑🚫 不要把 `auth_token` 提交到 Git 仓库。
- 🔄🚫 不要把 `refresh_token` 提交到 Git 仓库。
- 👤🚫 不要把真实 `auth_user` 信息写入 issue、日志或截图说明。
- 🔑🚫 不要把 `loginPassword`、真实邮箱或包含密码的 `koishi.yml` 提交到仓库。
- 📁🙈 `tools/output` 中的登录态 JSON 仅用于人工复制与本地备份。
- 🌐🛡️ `authStateJson.origin` 必须与 `sub2apiBaseUrl` 的 Origin 完全一致。
- 🏷️🛡️ 开启会话绑定时，导出 UA 与截图 UA 应保持一致。
- 🌍🛡️ 开启 IP 绑定时，导出脚本与 Koishi 应尽量使用相同网络出口。
- 🧹🛡️ Profile 清理仅允许默认目录或带有脚本所有权标记的目录。

## 📚🔗 维护说明

- 📝🧭 新功能应首先写入“未发布”章节。
- 🚀📦 发布新版本时应把未发布内容移动到对应版本标题下。
- 🔖📅 每个版本应记录版本号、日期与关键提交哈希。
- 🧪✅ 每个版本应记录实际执行的测试与残余风险。
- ⚠️🔄 不兼容配置变更必须提供迁移说明。
- 🔐🛡️ 登录态、安全策略与文件删除规则必须详细记录。
- 🖼️📸 UI 截图行为变化应同步更新预览图与 README。
- 🤝💻 使用 AI 协作完成提交时应保留规范的协作者尾注。
