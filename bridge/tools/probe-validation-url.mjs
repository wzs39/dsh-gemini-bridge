// Extract the full VALIDATION_REQUIRED detail (esp. validation_url) for one
// account, so we can act on Google's actual remediation instead of guessing.
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const want = process.argv[2] ?? ''

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }
const acct = accounts.find(a => a.id.includes(want) || a.email?.includes(want))
if (!acct) { console.log('no match'); process.exit(1) }

const token = await acct.tokens.accessToken()
const res = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': UA,
    requesttype: 'agent',
  },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(30000),
})

console.log(`=== ${acct.id} (${acct.email}) status=${res.status} ===`)
const text = await res.text()
let data
try { data = JSON.parse(text) } catch { console.log(text.slice(0, 2000)); process.exit(0) }

const det = data?.error?.details?.find(d => d?.metadata)
if (det?.metadata) {
  for (const [k, v] of Object.entries(det.metadata)) {
    console.log(`\n[${k}]`)
    console.log(v)
  }
} else {
  console.log(JSON.stringify(data, null, 2).slice(0, 3000))
}
