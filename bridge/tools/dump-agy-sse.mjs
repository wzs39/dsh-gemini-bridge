// Dump raw upstream SSE for one call so we can see exactly what the 200
// stream contains when our consumer reports "produced no events".
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const config = loadConfig()
const pool = new AgyPool({ config })

const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }
const acct = accounts.find(a => a.id.includes('kalao')) ?? accounts[0]
const token = await acct.tokens.accessToken()
console.log(`[dump] account=${acct.id}`)

const envelope = JSON.stringify({
  project: 'aicode-consumers',
  requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  requestType: 'agent',
  model: 'gemini-3.8-flash-medium',
  request: {
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ALPHA' }] }],
    generationConfig: { maxOutputTokens: 64 },
    sessionId: `-${Date.now()}`,
  },
})

const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', requesttype: 'agent', 'user-agent': UA },
  body: envelope,
  signal: AbortSignal.timeout(60000),
})
console.log(`[dump] status=${res.status} type=${res.headers.get('content-type')}`)
const raw = await res.text()
console.log(`[dump] bytes=${raw.length}`)
console.log('[dump] ---- first 3000 chars ----')
console.log(raw.slice(0, 3000))
console.log('[dump] ---- frame boundaries ----')
console.log('has \\n\\n:', raw.includes('\n\n'), '| has \\r\\n\\r\\n:', raw.includes('\r\n\r\n'), '| data: count =', (raw.match(/data:/g) ?? []).length)
