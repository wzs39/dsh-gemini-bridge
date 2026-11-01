# Gemini 网页端反代封禁风险手册

本文 = 上一次真实封号的复盘教训（`deepseek-web-bridge/guard-policy.md`）
＋ 社区公开经验（Gemini-API 等项目与 issue 区）
＋ 本 bridge 里对应的实现点。每条规则后面都有代码或参数兜底，不是口号。

---

## 一、来自真实封号的两条铁律（DeepSeek 事故移植）

事故一句话：凭据已被上游明确拒绝（`INVALID_TOKEN`），bridge 仍以 5.5 秒间隔
继续发请求，当日请求量 105→118，随后账号被封。guard 当时 `level:0`、
`cooldownSeconds:0` —— **不是没写熔断，是熔断状态从来没落盘成功**（一个
`this.#logs` 误用抛异常被空 catch 吞掉）。

### 铁律 1：拒绝之后继续敲门 = 升级最快的做法

上游说不，全部流量立即停。体现在：

- `lib/detect.mjs`：auth/captcha/throttle 三类信号全部 `hardStop: true`。
- `lib/client.mjs`：hard-stop 后**不解析、不路径内重试**，直接抛错给调用方，
  附带 retry-after。
- `lib/manager.mjs`：hard-stop 把账号 park 住（auth 12h / captcha 24h /
  throttle 1h），轮转自动跳过。
- `lib/guard.mjs#authRecovered()`：只有**人工重新登录**才解除 auth 类暂停；
  429 类暂停不解除——换 token 不改变服务器对这个客户端行为的判断。

### 铁律 2：状态必须落盘，写失败必须出声

- `guard.#save()` 失败会记 `state-write-failed` 进 journal（不再静默吞）。
- `#dirty` 标记 + 每次 admit/succeed/fail 后即时写，重启不失忆。
- 每账号独立 `logs/accounts/<name>/guard-state.json`，
  冷却与异常分不跨身份泄漏。

附带教训（同样移植）：

| DeepSeek 事故点 | 本项目对应 |
|---|---|
| 日预算 400 拍脑袋 | 默认 20/天，双号合计 40；首周建议减半 |
| 2.5s 间隔比人读完回答还快 | 8–25s 钟形抖动 + 15s 轮次周期下限 |
| `floor` 摊预算把 30/天压成 1/小时 | `#perWindowCap` 用 `max(1, ceil(...))`（有测试钉住） |
| 熔断 reason 丢失 | cooldown 带 reason，`/health` 全量上报 |
| 「已加载」当「生效」 | verify.mjs 实测 health，配置以启动打印为准 |

---

## 二、Gemini / Google 侧的特有信号面（社区公开经验）

综合 [HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API)
（最主流的网页端逆向库）README、issue 区与同类项目的公开结论，Google 与
DeepSeek(AWS WAF) 风控的差异点：

### 2.1 会话 Cookie 是身份本身

Gemini 网页端凭据就是 `__Secure-1PSID` + `__Secure-1PSIDTS`（+ 页内短效
CSRF token `SNlM0e` 和 build label `bl`）。风险性质：

- **长寿命、可跨设备**：cookie 被 Google 判定"来自非浏览器环境"时，处罚跟
  账号走，不跟 IP 走 —— 与"标记跟着账号走"的 DeepSeek 教训一致。
- **Chromium 的 Device Bound Session Credentials（DBSC）**：新版 Chrome 的
  cookie 与设备密钥绑定，拷出去给别的进程用几小时就失效（Gemini-API 明确
  建议遇到频繁过期就改用 Firefox 提取）。
  → 本 bridge 的对策：**不拷 cookie**。所有请求都在那个真实登录的 Chromium
  页面内 `fetch()`（CDP `Runtime.evaluate`），DBSC 绑定的就是发请求的这台
  设备本身，天然满足。`state.json` 里只存 cookie 用于"浏览器挂了重启后校验
  会话还在不在"，不作为发请求通道。
- **自动续期会踢浏览器下线**：外部进程频繁刷新 `__Secure-1PSIDTS` 会让浏览
  器要求重新登录（Gemini-API issue #6）。
  → 对策：`SNlM0e` 刷新走页面内 fetch（同一浏览器行为），不单独 POST 刷新
  端点。

### 2.2 Google 的"软封"先于硬封，且是静默的

公开报告里最常见的顺序：**正常 → 回答变空/变短（200 但无内容）→ 弹
consent/captcha 页 → 限流 429/403 → 停号**。中间态不返回任何错误码。

→ 对策：`guard.anomaly('empty-answer', 2)` —— 空回答不是"没抽到好答案"，是
账号被降级的第一信号；两次空回答（分数≥4）自动进 1h 冷却。成功一次衰减 2，
避免误伤。

### 2.3 速率：网页端没有公开数字，但有三条社区共识

1. **Pro 账号的网页端节奏本来就慢**（长回答、深度思考），十几秒一条是常态。
   默认 minGap 8s 已经比多数重度用户快；首周请调到 15s 以上。
2. **批量/自动化调用是主要举报触发器**：同一 session 短时间高度相似的请求
   （程序化 prompt 前缀、固定长度、零思考间隔）被行为模型打分。
   → 对策：`requestsPerHour` + burst 窗 + 强制休息；串行队列（一次只有一条
   在途）；同一 thread 的 conversationId 延续让请求看起来是"一次对话"而不是
   "N 个孤立请求"。
3. **多账号 ≠ 更多额度**：同一浏览器 profile、同一 IP、同一设备指纹下的多个
   账号会被关联成一个"账号农场"。
   → 对策：`manager` 强制每账号独立 `userDataDir` + 独立 CDP 端口；你的两个
   Pro 号分别登录、永不共享 profile。IP 维度你在芬兰，出口固定且真实，
   这是少数天然安全的场景——**不要给 bridge 另配代理出口**。

### 2.4 ToS 立场（决定"封了能不能申诉回来"）

Gemini 服务条款禁止自动化访问与转售。自用低频在执法优先级底部（历史上几乎
没有单纯自用的网页端账号被永久封的公开案例；被封案例集中在转售 API、
高频脚本、共享 cookie 三类）。申诉成功案例的共性：**承认用途 + 展示频率限
制措施**，不写"我没做错"。（同 DeepSeek 复盘的申诉建议。）

---

## 三、按风险等级列的本项目残余风险

| 等级 | 风险 | 说明 | 缓解 |
|---|---|---|---|
| 中 | prompt 注入模型被 Google 侧内容审核拒绝 | 拒答也是请求，频繁触发拒答模式会被打分 | 内容决定，bridge 无法代防；被拒后**不要**换措辞重发（同铁律 1） |
| 中 | `SNlM0e` 抓取依赖页面结构 | Google 改版 → 抓不到 → 误判过期 | 正则多点回退；抓不到时抛"需要人工登录"而不是继续发 |
| 低 | 响应格式漂移 | 布局变更 → 解析空 → anomaly 分虚高 | parser 递归回退 + dump；两次空才触发冷却 |
| 低 | CDP 通道本身 | 页面内 fetch 的 JS 被 CSP 拦截理论可能 | Gemini 页面自身就同源 fetch，已实测路径 |
| 极低 | 芬兰 IP + Pro 付费 + 低频 | Google 对付费欧盟账号的执法优先级最低 | —— |

---

## 四、上线检查（每次改节奏参数后跑一遍）

```bash
node --test test/                        # 全绿才部署
node bin/serve.mjs                       # 启动
node bin/verify.mjs                      # 真实一问 + 健康报告
curl -s http://127.0.0.1:18901/health    # parked / anomaly / window 全看
```

首周建议用 `cautious` 档（新 profile / 新登录）：

```json
"protection": { "preset": "cautious" }
```

## 四甲、节奏档位（改这里，不要手调那 15 个数字）

`protection` 里的字段互相咬合，手调一个会悄悄弄坏另一个。最坑的一条：

```
windowCap = ceil(requestsPerDay / budgetWindowsPerDay)
```

旧默认 `20 / 24` → `ceil(0.83) = 1`，即**每账号每小时 1 次**。配置上写着"每天
20 次"，日额度根本摸不到；真人对话 20 秒一条，早就越界。实测：pro1 用掉那 1 次
之后，下一个请求直接 429，而 pro2/pro3 完全闲置——三账号池退化成单账号。

所以现在只用 preset，不再写散装数字：

| preset | windowCap | 日上限/账号 | 小时上限 | 间隔 | burst | 适用 |
|---|---|---|---|---|---|---|
| `cautious` | 2/h | 48 | 6 | 15–45s | 20min 活动 / 8min 休息 | 新 profile、新登录、首周 |
| `balanced` | 5/h | 120 | 12 | 6–18s | 30min / 5min | 默认，正常重度自用 |
| `brisk` | 17/h | 408 | 30 | 2–6s | 40min / 3min | 长 agent 跑批 |

显式写某个数字仍会覆盖同名字段（例如只把 `requestsPerHour` 调到 20）。
`/health` 的 `pacingPreset` / `windowCap` / `dailyCeiling` 报的是**实际生效值**，
不是配置文件里的字面值。

**真正在保护账号的是三道闸，不是日额度：**
① 请求间隔（`minGapMs`–`maxGapMs`，越像真人越好）
② 小时上限 + burst 强制休息（打断"连续机器节奏"）
③ 异常检测（空回答 = 降级第一信号）

调高 preset 只是放宽日/窗口额度，这三道闸一档都不会松。失败反应
（`failureBreakerAt`、`anomalyThreshold`）在所有档位完全一致——吞吐是调优选择，
"多久判定账号出事"不是。

### 空回答不要用单个请求判定

实测踩到的坑：一次爆发测试里 20 个请求 0 成功，三个账号同时被 park 65 分钟。
原因不是配额，是**同一个请求里既给首次空回答记 2 分、又给失败重试记 2 分**，
凑满阈值 4 就停号一小时。一个瞬时抖动不该有这个代价。

现在的规则：
- 首次空回答 → 刷新 token 重试一次，**不记分**
- 重试仍空 → 记 2 分（一次确认失败 = 两个信号中的一个）
- 第二次确认失败才触发 1h 冷却；触发后分数归零，避免一次失误反复续期

修复前后同一个 20 次爆发：**0/20 → 16/20**，剩下 4 次是 pro1 窗口真的满了
（`17/17`），报错如实写 `window budget spent` 和释放时间。

作息：白天用、夜里 0 流量是**正常人类形状**，不设夜间保活以外的请求。

---

## 五、参考来源

- 本仓库：`deepseek-web-bridge/guard-policy.md`（真实封号复盘，本文 §一）
- 本仓库：`deepseek-web-bridge/docs/reverse-proxy-playbook.md`（门禁阶梯/指纹一致性，§2.1 的 DBSC 对策即其"签发者=消费者"规则的 Gemini 特化）
- [HanaokaYuzu/Gemini-API](https://github.com/HanaokaYuzu/Gemini-API) README
  —— cookie 双件套、DBSC 过期问题、issue #6 自动续期踢线，§2.1
- Google 账号异常行为支持页：https://support.google.com/accounts?p=al_alert
  —— 403 VALIDATION_REQUIRED 的官方申诉通道
