// 打印配额端点的原始 JSON，看清结构（之前把数组当对象解析，全是 undefined）。
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const pool = new AgyPool({ config: loadConfig() })

const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

for (const acct of accounts) {
  console.log(`\n=== ${acct.email} ===`)
  let token
  try { token = await acct.tokens.accessToken() } catch (e) { console.log('  token FAIL', e.code); continue }
  const res = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA, requesttype: 'agent' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  console.log(`  status ${res.status}`)
  console.log(text.slice(0, 1500))
}
