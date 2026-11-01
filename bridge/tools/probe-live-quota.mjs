// 实测每个账号的实时配额与分组状态，不读 pool.json 缓存。
// 目的：区分「配额耗尽导致中断」和「输出被截断」这两件完全不同的事。
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

for (const acct of accounts) {
  console.log(`\n=== ${acct.id} (${acct.email}) ===`)
  let token
  try { token = await acct.tokens.accessToken() } catch (e) { console.log('  token FAIL', e.code ?? e.message); continue }

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': UA,
    requesttype: 'agent',
  }

  // 实时配额
  const q = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(30000),
  }).catch(() => null)

  if (!q) { console.log('  quota: request failed'); continue }
  const qt = await q.text()
  if (q.status !== 200) {
    let msg = qt.slice(0, 120).replace(/\s+/g, ' ')
    try { const j = JSON.parse(qt); msg = `${j.error?.status}: ${j.error?.message}` } catch { /* raw */ }
    console.log(`  quota: ${q.status} ${msg}`)
  } else {
    try {
      const j = JSON.parse(qt)
      // 结构可能是 {groups:{...}} 或 {models:[...]}，两种都打印
      const groups = j.groups ?? j.quotaGroups ?? null
      if (groups && typeof groups === 'object') {
        for (const [g, v] of Object.entries(groups)) {
          const rf = v?.remainingFraction
          const reset = v?.resetTime ?? '?'
          console.log(`  ${g.padEnd(10)} remaining=${rf === undefined ? '?' : (rf * 100).toFixed(1) + '%'}  reset=${reset}`)
        }
      } else if (Array.isArray(j.models)) {
        for (const m of j.models.slice(0, 8)) {
          const rf = m.remainingFraction ?? m.quota?.remainingFraction
          console.log(`  ${String(m.modelId ?? m.name).padEnd(28)} remaining=${rf === undefined ? '?' : (rf * 100).toFixed(1) + '%'}`)
        }
      } else {
        console.log('  quota raw keys:', Object.keys(j).join(', '))
        console.log('  ' + JSON.stringify(j).slice(0, 400))
      }
    } catch { console.log('  quota unparsable:', qt.slice(0, 200)) }
  }
}
