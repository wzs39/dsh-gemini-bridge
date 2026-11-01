# dsh-gemini-bridge

把 **Gemini 双通道反代网关** 注册成 DeepSeek Harness 的模型提供方。一个插件，两条通道：

```
DSH 模型选择器
  ├─ gemini/claude/gpt-oss 全家（agy 通道）→ Antigravity 上游 v1internal 直连
  └─ gemini-web（网页通道）               → gemini.google.com 网页端（多账号轮转）
            两者都汇聚到本地 bridge（127.0.0.1:18901，OpenAI 兼容）
```

- **网页通道**：不拷 cookie 发请求——所有流量从真实登录的 Chromium（Chrome/Edge）
  页面内部发出，TLS/HTTP2/Client-Hints 指纹天然一致；Google 新版 DBSC 设备绑定
  在这个形状下不构成任何障碍。
- **agy 通道**：地区锁实测是**纯客户端闸门**（上游对 CN 归属账号的
  `streamGenerateContent` 正常返回 200）；插件直接复用本机 agy CLI 的 OAuth
  凭据走官方协议，解锁 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、
  `gemini-3.8-flash-tiered` 等模型，含真 function calling 与真实 usage。

**防封体系**（bridge 内置 + 插件互补，完整推导见
[bridge/docs/ban-risk.md](bridge/docs/ban-risk.md)，源自一次真实封号复盘）：

| 层 | 机制 |
|---|---|
| 指纹 | 网页通道页内 fetch；agy 通道 Node TLS = CLI 同款 |
| 节奏 | 钟形抖动间隔 8–25 s、轮次周期下限、burst 强制休息 |
| 预算 | 日预算摊到 24 窗口 + 小时上限；拒绝伪装成空 200 |
| 熔断 | auth/captcha/throttle 分级 park（12h/24h/1h），hard-stop 零重试 |
| 软封 | 200 空回答计异常分，两次即冷却 |
| 并发 | bridge 串行队列 + 插件闸门（默认 ≤2 并发流）|
| 多账号 | 每账号独立浏览器 profile/端口/守卫状态；park 自动轮转 |

## 安装

```bash
# DSH 插件页安装，或手动：
npm i dsh-gemini-bridge
```

插件加载后自动：
1. 生成运行配置 `~/.dsh/gemini-bridge/config.json`（模板来自
   `bridge/config.example.json`；自动探测本机 Chrome/Edge 写入
   `browser.executable`；**插件更新不覆盖你的修改**）；
2. 拉起 bridge 进程（`node bridge/bin/serve.mjs`；已有健康实例则复用；
   崩溃自动重启 ≤5 次/小时；插件停用即杀）；
3. 注册 provider `gemini-bridge`，模型目录经 `/v1/models` 自动发现。

## 首次使用（人工步骤，共两步）

```bash
# ① 网页通道：Google 登录一次（会弹出可见浏览器窗口）
node <插件目录>/bridge/bin/login.mjs --account default
#    多账号：往 config.json 的 accounts 里加名字，逐个 login

# ② agy 通道：只要本机 agy CLI 登录过就自动可用（凭据从
#    ~/.gemini/antigravity-cli/ 或 Windows 凭据管理器读取）；
#    想单独验证：pwsh -File <插件目录>/bridge/tools/probe-agy-upstream.ps1
```

然后重启 DSH（或重载插件），模型选择器里出现 `gemini-bridge/*`。

## 状态查看

聊天输入坞的 usage 卡片实时显示：总状态（ready/parked/signed-out/网关未运行）、
每个账号的今日预算与冷却、agy 通道凭据状态。

## 防封配置速查（`~/.dsh/gemini-bridge/config.json`）

```jsonc
"protection": {
  "requestsPerDay": 20,      // 每账号每日预算；新号首周建议 10
  "minGapMs": 8000,          // 请求间隔下限（首周建议 15000）
  "maxGapMs": 25000,
  "anomalyThreshold": 4      // 软封异常分阈值
},
"agy": { "enabled": true },  // 关掉 agy 通道只留网页通道
"accounts": [ ... ]          // 多账号名册（各自独立 profile）
```

插件设置（DSH 设置页）：`noRetry`（默认开——冷却期绝不重试）、
`maxConcurrent`（默认 2）、`models` 静态清单、进程托管开关等。

## agy 多账号池（复用 dsh-agy-link）

本机装着 DSH 的 agy-link 插件并维护着 `~/.dsh/agy-accounts/pool.json` 账号池时，
bridge 的 agy 通道**自动切换为池模式**（无需配置）：

- 池内每个 enabled 账号一个凭据源（`acc_*` 目录各自的 token 文件；
  `acc_primary` 走系统 HOME/凭据管理器）
- **粘性轮转**：当前账号用到 429 配额（park 1h）或 refresh 死亡（park 12h）
  才切下一个；全部 park → 429 + 最早解除时间
- bridge 只读 pool.json、只写自己的 tmp 缓存——**绝不与 agy-link 抢写**凭据槽
  与 pool 状态；agy-link 里新增/删除账号，bridge 重启即跟随
- 状态查看：`GET /api/agy/pool`（逐账号 token/park 状态）、
  `POST /api/agy/resume?id=<accId>`（人工重登后恢复）、usage 卡片 agy 行

无 pool.json 时回落到单账号模式（系统默认 agy 凭据），行为与之前一致。

## 结构与已知边界

```
lib/index.js          Host 半身：进程托管、配置 seed、provider 注册、usage 路由
lib/openai-adapter.js DSH 词表 <-> OpenAI SSE（session-title 短路/闸门/透传拒绝）
lib/client.js         浏览器半身：usage 卡片（含 agy 池逐账号状态行）
bridge/               网关本体（Node ≥22，零第三方依赖，可脱离插件独立运行）
bridge/tools/         探针与应急脚本
```

- 回环端点默认无鉴权之外不加暴露：bridge 只绑 `127.0.0.1`，apiKey 必填非空。
- 网页通道被 Google 降级时**先 park 账号再考虑申诉**；已永久封禁的账号无法靠
  本地改动恢复（标记跟账号走）。
- 本工具降低封号概率，不免疫。上游风控是黑盒；转售/共享凭属最高执法优先级，
  请勿外发端点。

## License

MIT
