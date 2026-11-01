// 单账号最小验证，每步都立刻打印（不缓冲），用来定位卡在哪一步。
// 上一个大脚本 CPU 0.2s / 墙钟 856s —— 明显卡在某个 await 上，不是慢而是死等。
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'

const name = process.argv[2] ?? 'pro1'
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }

log(`[${name}] 加载配置...`)
const config = loadConfig()
const manager = new AccountManager(config)

const acct = manager.pickAccountByName(name)
if (!acct) { log(`[${name}] 不存在`); process.exit(1) }

const port = acct.config.browser.port
log(`[${name}] CDP 端口 ${port}`)

// 每一步用 Promise.race 加硬超时，避免再次死等
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ])
}

try {
  log(`[${name}] 1/3 harvest（读 cookie）...`)
  const creds = await withTimeout(acct.session.harvest({ force: true }), 45000, 'harvest')
  log(`[${name}]   ✓ cookie ${creds.cookieNames.length} 个, 1PSID=${creds.cookieNames.includes('__Secure-1PSID')}`)

  log(`[${name}] 2/3 scrapePageTokens（抓 SNlM0e）...`)
  const tk = await withTimeout(acct.session.scrapePageTokens(), 45000, 'scrapePageTokens')
  log(`[${name}]   ✓ snlm0e=${tk.snlm0e?.length ?? 0} chars, bl=${tk.bl?.slice(0, 20)}`)

  log(`[${name}] 3/3 generateRaw（真实生成）...`)
  const t0 = Date.now()
  const raw = await withTimeout(
    acct.session.generateRaw({ prompt: 'Reply with exactly: PONG', timeoutMs: 90000 }),
    120000, 'generateRaw',
  )
  const ms = Date.now() - t0
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  log(`[${name}]   ✓ ${ms}ms, ${text.length} 字节`)
  log(`[${name}]   PONG: ${/PONG/i.test(text) ? 'YES' : 'NO'}`)
  if (!/PONG/i.test(text)) log(`[${name}]   前 150 字符: ${JSON.stringify(text.slice(0, 150))}`)
  log(`[${name}] === 结果: 可用 ===`)
} catch (e) {
  log(`[${name}] ✗ 失败: ${e.message}`)
} finally {
  manager.stopAll()
  // 某些句柄可能仍挂着，直接退出
  setTimeout(() => process.exit(0), 500)
}
