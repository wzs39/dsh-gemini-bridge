// Probe loadCodeAssist + streamGenerateContent for ONE named pool account, so
// we can tell a client-side eligibility gate from a real server-side wall.
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const want = process.argv[2] ?? ''

const config = loadConfig()
const pool = new AgyPool({ config })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }
const acct = accounts.find(a => a.id.includes(want) || a.email?.includes(want))
if (!acct) {
  console.log('available:', accounts.map(a => `${a.id} / ${a.email}`).join('\n  '))
  process.exit(1)
}

console.log(`=== ${acct.id} (${acct.email}) ===`)
const token = await acct.tokens.accessToken()
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA }

// 1. loadCodeAssist — the endpoint whose refusal the CLI treats as "region lock"
const lca = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
  method: 'POST', headers: { ...auth, requesttype: 'agent' },
  body: JSON.stringify({ metadata: { pluginType: 'GEMINI', platform: 'WINDOWS_AMD64' } }),
  signal: AbortSignal.timeout(30000),
})
const lcaText = await lca.text()
console.log(`loadCodeAssist -> ${lca.status}`)
console.log(lcaText.slice(0, 1400))

// 2. retrieveUserQuotaSummary — the second gate the CLI checks at startup
const quota = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
  method: 'POST', headers: { ...auth, requesttype: 'agent' },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(30000),
})
const qText = await quota.text()
console.log(`\nretrieveUserQuotaSummary -> ${quota.status}`)
console.log(qText.slice(0, 900))

// 3. streamGenerateContent — does the actual generation path work?
const gen = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
  method: 'POST', headers: { ...auth, requesttype: 'agent' },
  body: JSON.stringify({
    project: 'aicode-consumers',
    requestId: `req-${Date.now()}`,
    requestType: 'agent',
    model: 'gemini-3.8-flash-medium',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
      generationConfig: { maxOutputTokens: 16 },
      sessionId: `-${Date.now()}`,
    },
  }),
  signal: AbortSignal.timeout(45000),
})
const gText = await gen.text()
console.log(`\nstreamGenerateContent -> ${gen.status}`)
console.log(gText.slice(0, 700))
