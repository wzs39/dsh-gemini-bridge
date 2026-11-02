# dsh-gemini-bridge

把 **Gemini 双通道反代网关** 注册成 DeepSeek Harness 的模型提供方。一个插件，两条通道：

```
DSH 模型选择器
  ├─ gemini-web-flash-lite / -flash / -pro / -argon（网页通道，可实时切模式）
  ├─ gemini-web             （网页通道，跟随账号当前模式）
  └─ gemini/claude/gpt-oss 全家（agy 通道）→ Antigravity 上游 v1internal 直连
            两者都汇聚到本地 bridge（127.0.0.1:18901，OpenAI 兼容）
```

- **网页通道**：不拷 cookie 发请求——所有流量从真实登录的 Chromium（Chrome/Edge）
  页面内部发出，TLS/HTTP2/Client-Hints 指纹天然一致；Google 新版 DBSC 设备绑定
  在这个形状下不构成任何障碍。**模型可切换**：Flash-Lite / Flash / Pro / Argon
  四档，切换是账号状态（`L5adhe` RPC），详见
  [网页端切换模型](#网页端切换模型gemini-web-)。
- **agy 通道**：地区锁实测是**纯客户端闸门**（上游对 CN 归属账号的
  `streamGenerateContent` 正常返回 200）；插件直接复用本机 agy CLI 的 OAuth
  凭据走官方协议，解锁 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、
  `gemini-3.8-flash-tiered` 等模型，含真 function calling 与真实 usage。

**防封体系**（bridge 内置 + 插件互补，完整推导见
[bridge/docs/ban-risk.md](bridge/docs/ban-risk.md)，源自一次真实封号复盘）：

> 踩过的坑与排查方法已整理成第一手复盘：
> **[反代 Gemini 网页端：五个让「全部账号不可用」的坑](docs/lessons-gemini-web-reverse-proxy.md)**
> —— 六个「看起来像封号」的现象，没有一个真的和风控有关。

| 层 | 机制 |
|---|---|
| 指纹 | 网页通道页内 fetch；agy 通道 Node TLS = CLI 同款 |
| 节奏 | 档位化（cautious / balanced / brisk），间隔 + burst 强制休息 |
| 预算 | 日预算摊到 24 窗口 + 小时上限；拒绝伪装成空 200 |
| 熔断 | auth/captcha/throttle 分级 park（12h/24h/1h），hard-stop 零重试 |
| 软封 | 200 空回答计异常分，**确认两次**才冷却（重试失败不单独计分） |
| 并发 | bridge 串行队列 + 插件闸门（默认 ≤2 并发流）|
| 多账号 | 每账号独立浏览器 profile/端口/守卫状态；配额感知轮转 |

### agy 多账号池（复用 dsh-agy-link 的账号库）

agy 通道默认**只读消费** `~/.dsh/agy-accounts/pool.json`——那是 dsh-agy-link
维护的账号池（它管 Windows 凭据槽 `gemini:antigravity` 的租约、per-account
HOME 隔离、冷却与配额）。第二个写入者会和它的调度打架，所以这边只读：

- 账号来源 = `pool.json` 里 `enabled != false` 且带 `dir` 或 `systemHome` 的条目
- token 来源 = 各账号目录下的 `.gemini/antigravity-cli/antigravity-oauth-token`
  （`acc_primary` 走系统 HOME / keyring，和 CLI 一致）
- 我方写入 = **只有自己**的刷新缓存在 `os.tmpdir()/dsh-gemini-bridge/`
- 轮转策略 = 粘滞直到失败：命中硬信号才 park 并顺延到下一个，全 park 抛
  `AgyAllParkedError` 带 retry-after

**实测错误分类**（三条都来自真实流量，不是推断）：

| 上游返回 | 含义 | 处理 |
|---|---|---|
| 429 `RESOURCE_EXHAUSTED` | 该身份配额耗尽 | park 1h（throttled）后轮转 |
| 401 + 刷新失败 | refresh token 死了 | park 12h（auth）后轮转，需人工重登 |
| **403 `PERMISSION_DENIED`**<br>`Verify your account to continue` | **身份级验证门**：同一模型，一个号 403，另一个号正常 200 | park 12h（auth）后轮转 |
| **404 `NOT_FOUND`** | 模型 id 不存在 | **立即失败，不轮转**（不是账号问题，轮转会白烧整池） |

两个踩过的坑（都有回归测试 `test/agyclient.test.mjs`）：

1. **SSE 帧分隔符是 CRLF**——上游用 `\r\n\r\n`，只找 `\n\n` 会一帧都切不出来，
   把健康的 200 误报成 `stream produced no events`。
2. **模型 id 不能凭记忆写**——`gemini-3.8-flash` 上游 404，真实变体是
   `-high` / `-medium` / `-low` / `-tiered`（权威清单取自 `pool.json` 的
   `quotas.*.models[].modelId`）。`gemini-2.5-pro` 是账号门控项，默认不广播。

检查池状态：`node bridge/tools/pool-status.mjs`；
逐模型实测：`node bridge/tools/probe-model-ids.mjs`。

### 两种「地区墙」要分清（实测，别混为一件）

agy CLI 报「not currently available in your location」时，实际可能是两道**完全
不同**的锁。逐端点探测（`tools/fix-validation.mjs`）就能分辨：

| 症状 | `loadCodeAssist` | `streamGenerateContent` | 真正原因 | 解法 |
|---|---|---|---|---|
| CLI 拒绝启动，但生成端点通 | 200，带 `ineligibleTiers: UNSUPPORTED_LOCATION` | **200** | 纯客户端误判 | `agy-unlock` addon 抹掉拒绝字段即可 |
| CLI 拒绝启动，生成端点也 403 | 200，同样带 `UNSUPPORTED_LOCATION` | **403 `VALIDATION_REQUIRED`** | **Google 账号验证**，与地区无关 | 只能人工过验证 |

**关键判据**：`loadCodeAssist` 的 `ineligibleTiers` 只针对 `free-tier`，而
`currentTier` 往往已经授予 `standard-tier`——所以它不能作为「地区封禁」的证据。
真正的判决在生成端点：200 = 有资格（addon 能救）；403 `VALIDATION_REQUIRED` =
要账号验证（addon 救不了，抹字段只会让 CLI 启动后照样失败）。

#### 第一类：addon 救得了，但要「常驻 + 注入」两件事同时成立

`agy_unlock_addon.py` 本身是对的，它只在 mitmproxy 监听器**活着**且**真的被
agy 用上**时生效。这两条任一不成立，症状完全一样——CLI 照样吐原始地区墙，
看上去像「addon 无效」：

- **监听器没在跑**：重启、被杀、任务没注册，任何一次都会让它消失。
  `tools/unlock-keepalive.ps1` 负责自查自愈（幂等，端口没监听才拉起）。
- **代理没注入到 agy 进程**：手动用 `agy-unlock.cmd` 包一层是好的，但 DSH 经
  `dsh-agy-link` 拉起 agy 时不走那个 wrapper。插件实际这样拼环境：

  ```js
  const effectiveProxy = account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || void 0;
  const env = { ...process.env, ...proxyEnvFor(effectiveProxy) };
  ```

  所以持久杠杆是 `pool.json` 每个账号的 `proxyUrl`：只起代理不改它，DSH 拉起的
  agy 依然裸奔。

一条命令装齐（详见 [`bridge/tools/README-unlock.md`](bridge/tools/README-unlock.md)）：

```powershell
cd bridge/tools
powershell -ExecutionPolicy Bypass -File .\unlock-install.ps1   # 起代理 + 注册自愈
python set-pool-proxy.py --apply                                 # 写 pool.json
powershell -ExecutionPolicy Bypass -File .\unlock-verify.ps1 -LiveTest   # 真生成一次
```

`unlock-verify.ps1` 把 CA 信任、监听器、pool 注入、真实生成**分段**验证——
失败在哪一层一目了然，不用猜。改完需重启 DSH，插件才会重读 pool.json。

第二种情况的处理：

```bash
node bridge/tools/fix-validation.mjs <账号id或邮箱片段>          # 诊断 + 取验证链接
node bridge/tools/fix-validation.mjs <账号> --open               # 弹独立 profile 浏览器
node bridge/tools/fix-validation.mjs <账号> --watch              # 自动等验证生效
```

- 验证链接形如 `accounts.google.com/v3/signin/continue?...continue=developers.google.com/gemini-code-assist/...`，
  要**用该账号本人**登录完成（手机/设备确认），这一步无法自动化
- 浏览器用**该账号独立 profile**（`~/.dsh/agy-unlock/profiles/<id>`）：多个号混用
  同一个浏览器指纹会被 Google 关联成同一个人，反复触发验证
- `--watch` 每 15 秒探测一次生成端点，通了立刻退出 0，省掉人工回报

轮转自检：`node bridge/tools/test-rotation.mjs`（park 掉当前账号 → 看流量是否
切到另一个 → resume 后是否切回）。

### 网页端切换模型（`gemini-web-*`）

网页通道原来只有 `gemini-web` 一个模型，**因为模型不在请求体里**。
`StreamGenerate` 从来不携带模型参数——模型是**账号状态**，由 composer 里那颗
模式按钮（`button.input-area-switch`）决定。所以只发 StreamGenerate 的 bridge
永远用账号上次留下的模式，这就是「网页端没办法切换模型」。

现在提供四个真正可切的模型：

| 模型 id | 模式 | 内部 16 位 id |
|---|---|---|
| `gemini-web` | 跟随账号当前模式（**不发切换 RPC**） | — |
| `gemini-web-flash-lite` | Flash-Lite | `8c46e95b1a07cecc` |
| `gemini-web-flash` | Flash | `56fdd199312815e2` |
| `gemini-web-pro` | Pro | `e6fa609c3fa255c0` |
| `gemini-web-argon` | Argon | `95a4c0abcba24364` |

切换走 `batchexecute` 的 `L5adhe`：参数是一个稀疏数组，
**只有 index 99 有意义**，值就是上表的 16 位 id；数组长度写在第三个元素
（`[arr, null, [arr.length]]`）。`f.sid` 取 `WIZ_global_data.FdrFJe`，
`bl` 取 `WIZ_global_data.cfb2h`——反过来传照样返回 200，所以**状态码不能当判据**。

#### 三个会让这里出错、且都不会报错的点

1. **Pill 文案解析**：中文界面是 `当前模式为“Pro”`（全角引号），英文界面是
   `currently "Pro"`（ASCII 引号）。只匹配全角引号时，英文界面会把**整条
   aria-label** 当成模式名，于是每次请求都判定“没切成功”并重发 RPC。
   现在两种引号都认，并回退到按钮自身 `textContent`。
2. **`labelMatches` 的子串陷阱**：`flash-lite` 包含 `flash`，所以朴素的
   `includes` 会让「实际在 Flash-Lite、以为已切到 Flash」永远不被纠正——
   静默错模型。现在先剥离版本号前缀，再要求剩余部分不出现别的档位词。
3. **会话 id 跨账号/跨模式复用**：`conversationId` 属于创建它的那个 Google
   账号。用内容做 threadKey 时，轮转到另一个账号会把 A 的 `c_…` 交给 B，
   上游返回 **200 但正文为空**——和“账号被降级”长得一模一样。
   threadKey 现在是 `account::modeHash::promptHash`。

#### 怎么验证「切换真的生效」——不要用长度，不要用模型名

两个看似合理、实际都会骗人的判据：

- **响应里回显的模型名**：响应偶尔在动作建议区带一个 `"3.5 Flash-Lite"`，
  它与账号当前模式无关，是 UI 字符串。拿它当 ground truth 会得出“切换无效”的错结论。
- **输出长度 / 用时 / 简单题正确率**：实测三个模式在同一道 AIME 级题目上
  答案完全一致（都对），长度中位数也几乎相同。

真正能区分的判据是**工具链**：同一批需要“计算 + 检索”的中性题，按模式累计
响应里的工具调用次数：

| 模式 | `data_analysis_tool` | `python` | `google` |
|---|---|---|---|
| Flash-Lite | 6 | 34 | 198 |
| Pro | 6 | 28 | 168 |
| Argon | **12** | **74** | 204 |

Argon 的 python 调用是 Flash-Lite 的 2.2 倍、分析工具 2 倍。工具能力是档位属性，
这才是模式的指纹。复验：`node bridge/tools/probe-toolchain.mjs <account>`。

一个必须知道的时序：**切换对“下一次”请求生效**。RPC 成功后 composer 按钮不会
立即重绘，pill 可能还显示旧模式——那是显示延迟，不是切换失败。
`/health` 里 `mode` 报的是**已推给账号的模式**，`pillLabel` 才是按钮当前渲染值。

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

节奏只用档位选，不再手调那 15 个互相咬合的数字（推导见
[bridge/docs/ban-risk.md §四甲](bridge/docs/ban-risk.md)）：

```jsonc
"protection": {
  "preset": "balanced"      // cautious | balanced | brisk
                            //   cautious  2/h   48/day  gap 15-45s   新号首周
                            //   balanced  5/h  120/day  gap  6-18s   正常自用
                            //   brisk    17/h  408/day  gap  2-6s    长 agent
},
"agy": { "enabled": true },  // 关掉 agy 通道只留网页通道
"accounts": [ ... ]          // 多账号名册（各自独立 profile）
```

**手调单个数字仍会覆盖同名字段**，但要知道哪些不能松：

- 能调（只影响吞吐）：`requestsPerDay` / `budgetWindowsPerDay` / `requestsPerHour`
- **不要松**（这几道才在护号）：`minGapMs`–`maxGapMs` 请求间隔、
  `burstWindowMs`+`burstRestMs` 强制休息、`anomalyThreshold` 软封检测

⚠️ `windowCap = ceil(requestsPerDay / budgetWindowsPerDay)`。写 `20 / 24` 得到
`ceil(0.83) = 1`，即**每账号每小时 1 次**，日额度根本摸不到。`/health` 的
`pacingPreset` / `windowCap` / `dailyCeiling` 报的是**实际生效值**，以它为准。

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

## agy 产物面板（侧边栏 🗂）

把 agy 写在你机器上的东西摊开看，不用去翻 `~/.dsh/agy-accounts`：

| 入口 | 位置 |
|---|---|
| 侧边栏图标 | 左侧轨道 🗂，点开是整块面板 |
| composer 胶囊 | 输入框下方，随手开一个小窗 |

面板分「文件 / 对话」两个标签，支持搜索标题与文件名。文件抽屉按类型渲染：

| 类型 | 怎么预览 | 走什么 |
|---|---|---|
| 图片 png/jpg/gif/webp/avif/bmp/ico | `<img>` 直接画 | JSON 里带 base64 `dataUrl` |
| SVG | `<img>` 画（不塞 innerHTML） | 文本 + data URL 都给 |
| PDF | 浏览器内置阅读器，`<iframe>` 内嵌 | `…/agy/brain/raw` 原始字节 |
| 文本 md/json/jsonl/txt/log | 等宽字体原文 | JSON 里带 `content` |
| 其它二进制 | 只报大小与类型 | 不渲染 |

> **踩过的坑**：早先图片和 PDF 都落在一张 binary 名单里，一律返回
> `binary: true, content: ''`，抽屉只能显示一句「二进制文件，不在浏览器里渲染」
> ——这就是「图片无法预览」的全部原因。顺带还有两个连带缺陷：
> 附件实际在 `.system_generated/logs/media/`，而分类逻辑一进 `logs` 就
> `return 'log'`，于是 `media` 计数永远是 0，PDF 在列表里显示成「日志」；
> 以及 `<iframe src="data:application/pdf">` 被 Chrome 禁止，PDF 必须有真 URL
> 才能内嵌，所以单独开了 `…/agy/brain/raw` 原始字节路由（同一个越权检查，
> 不允许另写一份）。

预览正确性不靠"返回 200"判断，`npm run test:render` 会用真实 Chromium 打开
页面，把图片画到 canvas 上取样像素，并检查 PDF iframe 拿到了尺寸。

## 结构与已知边界

```
lib/index.js          Host 半身：进程托管、配置 seed、provider 注册、usage/brain 路由
lib/agy-brain.js      agy 产物索引与文件读取（含类型判定与 raw 字节路由的越权检查）
lib/openai-adapter.js DSH 词表 <-> OpenAI SSE（session-title 短路/闸门/透传拒绝）
lib/client.js         浏览器半身：usage 卡片 + 侧边栏产物面板（含图片/PDF 预览）
bridge/               网关本体（Node ≥22，零第三方依赖，可脱离插件独立运行）
  lib/cdp.mjs         RFC 6455 帧解析（不要用数括号切 JSON，见复盘 §1）
  lib/parser.mjs      StreamGenerate 解析（累积快照语义，见复盘 §4）
  lib/modes.mjs       网页端 composer 模式切换（L5adhe RPC 与 16 位模型 id）
  lib/guard.mjs       节奏/预算/熔断/异常分（档位化，availability() 供轮转查询）
  lib/manager.mjs     账号挑选（配额感知，不只看 park 状态）
bridge/test/fixtures/ 真实上游响应，解析器回归依据
bridge/tools/         探针与应急脚本
docs/                 第一手复盘
```

- 回环端点默认无鉴权之外不加暴露：bridge 只绑 `127.0.0.1`，apiKey 必填非空。
- 网页通道被 Google 降级时**先 park 账号再考虑申诉**；已永久封禁的账号无法靠
  本地改动恢复（标记跟账号走）。
- 本工具降低封号概率，不免疫。上游风控是黑盒；转售/共享凭属最高执法优先级，
  请勿外发端点。
- 改任何节奏参数后跑 `npm test`（158 个单元测试 + 4 组契约/预览测试）再部署；
  改了产物面板的渲染逻辑再跑 `npm run test:render`（真浏览器量像素）。

## License

MIT
