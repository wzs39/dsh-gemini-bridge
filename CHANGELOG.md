# Changelog

本项目的重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-11-02

网页端反代回复中的图片（如 Matplotlib 图表、Imagen 生成图）在客户端显示“图片不可见 / 无法预览”。

### 修复与新增

- **网页端模型生成图内联解析（彻底解决图片不可见）**：
  - **根因**：Gemini Web 在云端沙箱中执行 Python（如 Matplotlib 保存 `cycloid_arc.png`）或 Imagen 绘图时，返回的正文只包含 Google 内部占位符（如 `[http://googleusercontent.com/generated_image/...]`）和虚构的本地相对路径 `![...](cycloid_arc.png)`；真实的高清图片存储在 `https://lh3.googleusercontent.com/gg/...`，但带有会话级鉴权保护，普通客户端没有 Cookie 直接请求一律报 403 Forbidden。
  - **解法**：在 `parser.mjs` 中从响应元数据（`inner[4][0][12]`）完整解析出图片 URL、文件名、MIME 类型与占位符映射；利用既有 CDP 通道在浏览器会话内调用 `Network.loadNetworkResource`，在毫秒级内完成原图下载并转换为 Base64 `data:image/...;base64,...` URL。
  - **自动替换**：自动将文本中的所有 Google 内部占位符与虚构文件名 Markdown 图片标记替换为真实内联 Base64 Data URL，并在未显式引用时自动追加，使 DSH 的 Markdown 渲染器可以直接原生完整渲染图表，彻底解决“图片无法预览 / 403 / 找不到本地文件”的问题。
- `bridge/test/parser.test.mjs`：增加图片提取与 Markdown 内联替换测试，覆盖 Matplotlib 图表、Imagen 画图与自动追加 3 类场景。
- `bridge/tools/verify-web-image.mjs`：全链路端到端真机验证工具，测试流式与非流式下 Python 代码制图的下载与 Data URL 内联。

## [1.1.1] - 2026-11-02

产物面板里的图片和 PDF 无法预览。

### 修复

- **图片永远无法预览**。`readConversationFile` 把 png/jpg/gif/webp 和 zip/二进制
  放进同一张名单，一律返回 `binary: true, content: ''`，抽屉只能显示一句
  「二进制文件，不在浏览器里渲染」——字节从来没被送出去。现在图片回 base64
  data URL（上限 8 MB：base64 膨胀约 4/3，而整个响应是一次性 JSON），
  由前端 `<img>` 渲染；SVG 额外给出文本，但走 `<img>` 而不是 `innerHTML`。
- **附件被记成「日志」且计数恒为 0**。附件实际落在
  `.system_generated/logs/media/`，而 `classifyFile` 一进 `logs` 就
  `return 'log'`，于是 `media` 统计永远是 0，PDF 在列表里显示成日志行。
  现在 `media` 判定提前到 `logs` 的其它分支之前。
- **PDF 无法内嵌**。Chrome 禁止 `<iframe src="data:application/pdf">`
  （data URL 不能作为顶层导航），所以只有 JSON 路由时永远嵌不进去。新增
  `…/agy/brain/raw` 回原始字节（正确的 MIME + `nosniff` +
  `default-src 'none'` 的 CSP）。
- **越权检查只有一份**。`raw` 路由复用 `resolveConversationFile`；两份实现
  迟早会漂移，那时 raw 就成了绕过口。

### 新增

- 抽屉按类型渲染：图片 `<img>`、PDF `<iframe>`、文本 `<pre>`；抽屉头按类型给图标。
- `bridge/tools/test-file-preview.mjs`：图片/PDF/文本三类 + 6 项越权拦截。
- `bridge/tools/verify-preview-render.mjs`（`npm run test:render`）：用真实
  Chromium 把图片画到 canvas 上**取样像素**、并检查 PDF iframe 拿到尺寸——
  「返回 200」不算预览成功。
- `test-brain-http.mjs` / `test-brain-routes.mjs` 补 raw 路由与分类回归。

### 变更

- `npm test` 现在包含 `test-file-preview.mjs`。

## [1.1.0] - 2026-11-02

网页通道从「只有一个模型」变成真正可切换的四个模型。

### 新增

- **网页端模型切换**。新增 `gemini-web-flash-lite` / `gemini-web-flash` /
  `gemini-web-pro` / `gemini-web-argon` 四个模型；`gemini-web` 保留为
  「跟随账号当前模式」，且**故意不发切换 RPC**，避免每次请求白打一发。
- `bridge/lib/modes.mjs`：模式目录、16 位模型 id、pill 读取表达式、
  `L5adhe` 切换 RPC 的构造与比较逻辑。
- `bridge/test/modes.test.mjs`：17 个测试，覆盖目录/编码/pill 解析/命名冲突。
- `probe-toolchain.mjs`：用工具链调用次数判定「模式是否真的生效」的探针。
- `probe-ui-select.mjs`：走真实 UI 点选验证 pill 切换的探针。
- `/health` 每账号新增 `mode`（已推给账号的模式）与 `pillLabel`
  （按钮当前渲染值）两个字段——两者会短暂不一致，这是显示延迟而非切换失败。
- 模型切换失败时，`/v1/chat/completions` 会带 `x-gemini-mode-warning` 响应头。

### 修复

- **网页通道无法切换模型**（根因，不是实现问题）：`StreamGenerate` 接口
  **从不携带模型参数**，模型是账号状态、由 composer 模式按钮决定。只发
  StreamGenerate 的 bridge 永远用账号上次留下的模式。
- **pill 解析只认全角引号**：英文界面下会把整条 `aria-label` 当成模式名，
  于是每次请求都判定「没切成功」并重发 RPC，看起来一切正常。
- **`labelMatches` 的子串陷阱**：`flash-lite` 包含 `flash`，朴素的 `includes`
  会让「实际在 Flash-Lite、以为切到了 Flash」永远不被纠正——静默跑错模型。
  现在先剥离版本号前缀，再要求剩余部分不出现别的档位词。
- **会话 id 跨账号复用**：`conversationId` 属于创建它的那个 Google 账号。
  threadKey 原来只用 prompt 哈希，轮转后把 pro1 的 id 交给 pro2，上游返回
  **200 但正文为空**，和「账号被降级」无法区分。现在 key 是
  `account::modeHash::promptHash`，且空答案重试时会丢弃会话 id。
- **空答案重试**：以前复用同一个已失效的会话 id，只会重现已失效的结果；
  现在有会话 id 时改用新会话重试。
- **`gemini-3.5-flash-lite` 命名冲突**：它被列为网页别名，但它**是真实的
  agy 模型 id**，会让 agy 流量被错误路由到网页通道。
- **`isWebMode` 对未知 id 返回 true**：任何未知模型都会被网页分支截获，
  现在只认已声明的 id 与别名。

### 变更

- `bridge/lib/router.mjs`：`models()` 只在网页通道存在时才广播网页模型；
  `openCompletion()` 把解析后的模式 spec 传给 client。
- `bridge/lib/session.mjs`：新增 `readMode()` / `applyMode()`；`describe()`
  的 `mode` 现在报已推送的模式，新增 `pillLabel` 与 `appliedModeHash`。
- `bridge/lib/client.mjs`：`openCompletion()` 接受 `{messages, mode}`，
  返回值新增 `mode` 结果；thread 缓存上限从 50 提到 200（key 变长）。
- `lib/index.js`：静态模型目录补上四个网页模式。

### 关于「怎么验证切换生效」

响应里偶尔回显的 `"3.5 Flash-Lite"` 是 UI 字符串，与账号模式无关——拿它当
ground truth 会得出完全相反的结论。输出长度、耗时、简单题正确率在三个档位间
也几乎一致（实测同一道 AIME 级题目三者答案完全相同）。

真正的判据是**工具链**：同一批需要「计算 + 检索」的中性题，按模式累计响应里
的工具调用次数——

| 模式 | `data_analysis_tool` | `python` | `google` |
|---|---|---|---|
| Flash-Lite | 6 | 34 | 198 |
| Pro | 6 | 28 | 168 |
| Argon | 12 | 74 | 204 |

Argon 的 python 调用是 Flash-Lite 的 2.2 倍。复验：
`node bridge/tools/probe-toolchain.mjs <account>`。

## [1.0.0] - 2026-11-01

首个可用版本：双通道反代网关接入 DSH。

### 新增

- **网页通道**：所有上游请求从真实登录的 Chromium 页面内部发出（CDP
  `Runtime.evaluate`），TLS/HTTP2/Client-Hints 指纹天然一致；三账号轮转、
  每账号独立 profile 与端口。
- **agy 通道**：复用本机 agy CLI 的 OAuth 凭据直连 Antigravity 上游
  `v1internal`，解锁 `claude-sonnet-4-6`、`claude-opus-4-6-thinking` 等模型，
  含真实 function calling。
- **防封五层**：指纹一致、节奏抖动、预算摊窗、分级熔断、软封异常分。
- 插件侧进程托管、运行数据外置到 `~/.dsh/gemini-bridge`、浏览器路径自动发现。
- 侧边栏 agy 产物面板（会话/文件/对话浏览）。
- `docs/lessons-gemini-web-reverse-proxy.md`：六个「看起来像封号、实际都不是」
  的排查复盘。

### 修复

- CDP WebSocket 帧解析按大括号计数 → 上游 payload 内含大量括号导致深度失同步，
  生成请求永久挂起。改为完整 RFC 6455 实现。
- `SNlM0e` 正则不认冒号 → 所有健康会话被误判为「会话过期」。
- 构建标签 `bl` 取错字段 → 请求挂起且不报错。
- 上游响应解析多嵌一层数组 + 分块是累积快照 → 所有账号返回空答案。
- 一个账号耗尽额度就 429 整个池子。
- 一次空答案被计两次异常分 → 三账号各一次空回答就停摆 65 分钟。
- 页面被判定为遮挡 → Chromium 后台节流冻结网络栈，请求挂到超时。
- CDP 连到扩展页而非 gemini 页。
