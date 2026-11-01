// 宿主路由的契约测试：这类 bug 单测抓不住，必须在真进程里打。
//
// 实测踩到的：/plugins/dsh-gemini-bridge/usage 一直 502，body 是
// `usage fetch failed: options is not a function`。原因是 endpointOf 收的是
// options **函数**（它内部自己再调一次以支持热更新），而调用点传了 options()
// 的结果。客户端卡片因此永远显示「网关未运行」。
//
// 这里直接对运行中的 DSH 打三条路由，验证状态码与响应形状。
// 用法: node bridge/tools/test-host-routes.mjs [guiBase] [bridgeBase]
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const GUI = (process.argv[2] ?? 'http://127.0.0.1:4837').replace(/\/$/, '')
const BRIDGE = (process.argv[3] ?? 'http://127.0.0.1:18901').replace(/\/$/, '')

let failed = 0
const check = (n, c, d = '') => { if (c) log(`PASS  ${n}`); else { log(`FAIL  ${n}  ${d}`); failed++ } }

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, text, json }
}

// ── 1. bridge 自身活着 ──
let health
try { health = await get(`${BRIDGE}/health`) } catch (e) { health = { status: 0, text: String(e.message) } }
check('bridge /health 可达', health.status === 200, String(health.status))
check('bridge 报告 ready', health.json?.status === 'ready', JSON.stringify(health.json?.status))

// ── 2. /usage 不能再 502 ──
// 这是回归点：options 传错导致 TypeError 被吞成 502。
const usage = await get(`${GUI}/plugins/dsh-gemini-bridge/usage`)
check('/usage 不是 502', usage.status !== 502, `status=${usage.status} body=${usage.text.slice(0, 160)}`)
check('/usage 返回 200', usage.status === 200, String(usage.status))
check('/usage 有 channels 字段', typeof usage.json?.channels === 'object', JSON.stringify(Object.keys(usage.json ?? {})))
if (usage.json?.channels?.web) {
  log(`      web=${usage.json.channels.web.usable}/${usage.json.channels.web.total}`)
}
if (usage.json?.channels?.agy) {
  log(`      agy=${usage.json.channels.agy.usable}/${usage.json.channels.agy.total}`)
}
// 三个 Pro 账号必须都到位（配置指向 workspace 里已有的登录态）
if (usage.json?.channels?.web) {
  check('web 通道三账号全在线', usage.json.channels.web.usable === 3, `usable=${usage.json.channels.web.usable}`)
}

// ── 3. brain 索引 ──
const brain = await get(`${GUI}/plugins/dsh-gemini-bridge/agy/brain`)
check('/agy/brain 返回 200', brain.status === 200, String(brain.status))
check('/agy/brain 有 conversations', Array.isArray(brain.json?.conversations), typeof brain.json?.conversations)
check('/agy/brain 有 totals', typeof brain.json?.totals === 'object')
if (brain.json?.totals) {
  const t = brain.json.totals
  log(`      ${t.accounts} 账号 / ${t.conversations} 会话 / ${t.files} 文件 / ${t.artifacts} 产物`)
  check('扫描到会话', t.conversations > 0, String(t.conversations))
  check('扫描到产物', t.artifacts > 0, String(t.artifacts))
}

log('')
log(failed === 0 ? '全部通过' : `失败 ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
