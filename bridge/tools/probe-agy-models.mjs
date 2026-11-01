// Per-account, per-model upstream probe. Tells us exactly which
// (account, model) pairs the region/verification gate allows, so we stop
// guessing why a turn failed.
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const MODELS = [
  'gemini-3.8-flash',
  'gemini-3.8-flash-high',
  'gemini-3-flash',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]

const config = loadConfig()
const pool = new AgyPool({ config })

function body(model) {
  return JSON.stringify({
    project: 'aicode-consumers',
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestType: 'agent',
    model,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
      generationConfig: { maxOutputTokens: 32 },
      sessionId: `-${Date.now()}`,
    },
  })
}

for (const account of pool.describeAll()) {
  const rec = pool.pick() // advances cursor; we re-resolve by id below
  const target = pool.describeAll().find(a => a.id === account.id)
  // reach the real account object through the public API
  const accounts = []
  for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a) accounts.push(a) }
  const acct = accounts.find(a => a.id === account.id) ?? accounts[0]

  console.log(`\n=== ${account.id} (${account.email}) ===`)
  let token
  try {
    token = await acct.tokens.accessToken()
  } catch (e) {
    console.log(`  token: FAIL ${e.code ?? e.message}`)
    continue
  }
  console.log(`  token: ok (${token.length} chars)`)

  for (const model of MODELS) {
    const t0 = Date.now()
    try {
      const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          requesttype: 'agent',
          'user-agent': UA,
        },
        body: body(model),
        signal: AbortSignal.timeout(45000),
      })
      const ms = Date.now() - t0
      if (res.ok) {
        const text = await res.text()
        const hasData = text.includes('data:')
        console.log(`  ${model.padEnd(26)} 200 ${ms}ms ${hasData ? 'sse-data' : 'EMPTY-STREAM'} ${text.slice(0, 80).replace(/\n/g, ' ')}`)
      } else {
        const text = await res.text().catch(() => '')
        let msg = text.slice(0, 120).replace(/\n\s*/g, ' ')
        try { const j = JSON.parse(text); msg = `${j.error?.status}: ${j.error?.message}` } catch { /* raw */ }
        console.log(`  ${model.padEnd(26)} ${res.status} ${ms}ms ${msg}`)
      }
    } catch (e) {
      console.log(`  ${model.padEnd(26)} ERR ${Date.now() - t0}ms ${e.name}: ${e.message.slice(0, 100)}`)
    }
  }
}
