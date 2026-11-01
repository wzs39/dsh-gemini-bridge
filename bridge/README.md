# gemini-web-bridge

把网页版 Gemini（`gemini.google.com`）反代成本地 OpenAI 兼容端点，供 DSH /
任意 OpenAI 协议客户端使用。**支持多 Google 账号轮转与封号风险隔离。**

它不代理页面、不注入脚本、不需要 Google API Key。浏览器只负责登录一次并持有
凭据；之后所有 upstream 请求都从该浏览器内部发出（CDP `Runtime.evaluate` +
页内 `fetch`），TLS 指纹、HTTP/2 设置、Cookie、Client Hints 全部是真实浏览器
的形状。

**为什么必须从浏览器内发**：① Google 把会话绑到铸造它的 TLS 指纹上——浏览器
登录、Node 消费 = 一个账号两张脸；② 新版 Chromium 的 Device Bound Session
Credentials 把 cookie 绑到设备，拷出来给别的进程用几小时就失效。浏览器内发
请求这两个问题都不存在。详见 [docs/ban-risk.md](docs/ban-risk.md)。

---

## 快速开始

```bash
# 0. 编辑 config.json：browser.executable 填你的 Chrome 路径
# 1. 每个账号登录一次（各自独立 profile，绝不共享）
node bin/login.mjs --account pro-a
node bin/login.mjs --account pro-b

# 2. 启动（自动拉起各账号的浏览器）
node bin/serve.mjs

# 3. 验证
node bin/verify.mjs
curl http://127.0.0.1:18901/health

# 单账号也可以：accounts 留空即可，全程用 default
```

端点 `http://127.0.0.1:18901`，模型名 `gemini-web`，鉴权 `Bearer sk-local-gemini-web`。

---

## 双通道：Gemini 网页端 + agy 上游直连

按 `model` 名路由：

```
gemini-web / 缺省        → 网页通道（Edge 页内 fetch，双账号轮转 + 全套 guard）
claude-sonnet-4-6        → agy 通道（v1internal + OAuth，Node 直连 = CLI 同款 TLS）
claude-opus-4-6-thinking    · 真 contents[] 多轮 + function calling
gemini-3.8-flash-*           · thoughtSignature 走私在 tool_call_id
gpt-oss-120b-medium          · 真实 usage 回传
gemini-3-flash               · 401 自动 refresh（refresh 轮换竞争时采信源新票）
```

agy 通道的前提：**本机 agy CLI 已登录过**（token 从
`~/.gemini/antigravity-cli/antigravity-oauth-token` 或 keyring
`gemini:antigravity` 读，缺任何一边都能跑；两边都没有则该通道自动禁用，网页
通道不受影响）。地区锁已实测为纯客户端闸门
（`tools/probe-agy-upstream.ps1` → HTTP 200 逐字回显），所以这条路的 TLS/UA/
协议形状全部与官方 CLI 一致——**Node 直连在这里不是破绽而是同款**。

`config.json` 关闭 agy 通道：`"agy": { "enabled": false }`。

---

## 双账号轮转（pro-a / pro-b）

`config.json`：

```json
{
  "accounts": [
    { "name": "pro-a", "label": "Google Pro 账号 A" },
    { "name": "pro-b", "label": "Google Pro 账号 B" }
  ]
}
```

规则（`lib/manager.mjs`）：

- **每个账号一套隔离资源**：独立 CDP 端口（root+10i）、独立 Chrome
  `userDataDir`（`profiles/<name>`）、独立 guard 状态
  （`logs/accounts/<name>/`）。共享 profile 的多账号 = 账号农场信号，最伤。
- **请求轮转**：round-robin；某账号被 hard-stop 信号 park 后自动跳过，全部
  park 时返回 `429 + retry-after`（到最早解除时间）。
- **降级不致命**：一个账号 signed-out 不影响另一个继续服务；`/health` 逐账号
  上报 parked 状态与原因。
- **人工恢复通道**：重新 `bin/login.mjs --account <name>` 后自动 POST
  `/api/account/recovered` 解除 park；也可手动调该路由。

单账号模式（`accounts: []`）同样工作，行为等于只有一项的轮转表。

---

## 封禁风险防线（摘要）

完整推导、社区公开案例与残余风险表见 **[docs/ban-risk.md](docs/ban-risk.md)**。
这里只列实现与触发条件：

| 防线 | 位置 | 触发/动作 |
|---|---|---|
| 指纹一致 | `lib/session.mjs` | 所有上游调用页内发出，无 Node 直连路径 |
| 节奏 | `lib/guard.mjs` | 钟形 8–25 s 抖动 + 15 s 轮次周期下限 |
| 预算 | `lib/guard.mjs` | 20/天/账号 + 24 窗口均摊 + 4/小时 + burst 强制休息 |
| 熔断 | `lib/detect.mjs` + `manager` | `auth_expired` 停 12h、`captcha` 停 24h、`429/403` 停 1h；**hard-stop 一律不路径内重试** |
| 软封探测 | `guard.anomaly` | 200 但空回答计 2 分，≥4 进 1h 冷却；成功衰减 |
| 状态持久 | `guard.#save` | 落盘失败记录出声；重启不失忆（上次事故根因之一） |
| 并发 | `client` + `guard` | 全局串行队列 + maxConcurrentWaiters=1 |
| 拒绝语义 | `lib/server.mjs` | 所有拒绝发生在 writeHead 之前；429 带 retry-after；绝不伪装成"200 空流" |
| 诚实上报 | `/health` | 逐账号：会话年龄/冷却原因/窗口产能/异常分/park 状态 |
| DBSC/续期 | `lib/session.mjs` | 不拷 cookie、不外部刷新 PSIDTS，SNlM0e 页内重抓 |

**被上游拒绝之后继续敲门 = 事故本身。** 全部防线里这一条优先级最高。

---

## 三个关键实现点

### 1. 凭据与请求都在浏览器内
账号 profile 常驻 Chromium；`generateRaw()` / `scrapePageTokens()` 都是
`Runtime.evaluate` 里的 `fetch()`。Node 进程对 Google 几乎零直接流量。

### 2. 短效 CSRF token（SNlM0e）+ build label（bl）
每次生成前从页面 HTML 抓取，缓存 20 分钟，过期自动重抓——把"token 过期 403"
和"账号被拒 403"在 `detect.mjs` 里分开，前者不该计入封号信号。

### 3. 响应解析容错
`)]}'` 反 XSSI 前缀剥离 + `wrb.fr` 分块提取 + 已知索引优先、递归搜索回退。
Google 改布局时先降级告警（anomaly 分），而不是拿空答案冒充成功。

---

## DSH 挂载

参照 `deepseek-web-bridge/bin/mount-dsh.mjs` 的同款做法：provider baseUrl 指到
`http://127.0.0.1:18901/v1`，apiKey 填 `config.server.apiKey`，模型列表填
`gemini-web`。

---

## 验证

```bash
node --test test/
```

覆盖：响应解析（含前缀剥离/索引容错）、guard（节奏/预算/熔断/落盘/异常分）、
detect（六类信号 + park 时长排序）、manager（隔离/轮转/park/recover/无泄漏）、
server（流式/非流式/拒绝先于响应头/retry-after/鉴权）。

---

## 文件

```
lib/session.mjs    凭据托管：独立 profile、CDP 读 cookie、页内发请求
lib/detect.mjs     封号信号分类（auth/captcha/throttle/fault/degraded）
lib/manager.mjs    多账号隔离、轮转、park/recover
lib/parser.mjs     响应解析：)]}' 剥离 + wrb.fr 提取 + 递归回退
lib/client.mjs     串行队列、guard 集成、拒绝不重试
lib/guard.mjs      节奏 / 预算 / 熔断 / 异常分 / 持久化
lib/server.mjs     OpenAI 兼容 HTTP 层（拒绝先于响应头）
lib/config.mjs     配置加载（deep-merge defaults + accounts 列表）
lib/cdp.mjs        CDP：launch / attach / evaluate
bin/login.mjs      一次性人工登录（--account 选 profile）
bin/serve.mjs      主服务（逐账号拉起，降级不致命）
bin/verify.mjs     端到端冒烟 + 逐账号健康报告
docs/ban-risk.md   封禁风险手册（真实事故 + 社区公开经验）
tools/agy_unlock_addon.py  （另用）Antigravity CLI 地区资格本地改写
```

## 边界

- 自用。对外转售/共享 cookie 是 Google 执法优先级最高的一类，别做。
- 已封的号救不回来：标记跟账号不跟 IP，唯一路径是官方申诉。
- 这套防护降低概率，不免疫。上游风控是黑盒且在变。
