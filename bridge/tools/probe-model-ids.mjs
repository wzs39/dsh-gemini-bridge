// Verify every candidate model id against a WORKING account, so the
// advertised /v1/models list contains no 404s.
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

// Authoritative ids from pool.json quotas (dsh-agy-link's own model table).
const CANDIDATES = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-tiered',
  'gemini-3-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]

const config = loadConfig()
const pool = new AgyPool({ config })

// Grab any account whose token works; we only need one for id validation.
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

function envelope(model) {
  return JSON.stringify({
    project: 'aicode-consumers',
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestType: 'agent',
    model,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
      generationConfig: { maxOutputTokens: 24 },
      sessionId: `-${Date.now()}`,
    },
  })
}

const ok = []
const denied = []
const missing = []

for (const model of CANDIDATES) {
  let outcome = null
  for (const acct of accounts) {
    let token
    try { token = await acct.tokens.accessToken() } catch { continue }
    try {
      const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', requesttype: 'agent', 'user-agent': UA },
        body: envelope(model),
        signal: AbortSignal.timeout(40000),
      })
      if (res.ok) {
        const text = await res.text()
        if (text.includes('data:')) { outcome = { kind: 'ok', acct: acct.id }; break }
        outcome = { kind: 'empty', acct: acct.id, note: text.slice(0, 60) }
        continue
      }
      const text = await res.text().catch(() => '')
      let status = '', message = text.slice(0, 80).replace(/\s+/g, ' ')
      try { const j = JSON.parse(text); status = j.error?.status ?? ''; message = j.error?.message ?? message } catch { /* raw */ }
      if (res.status === 404) { outcome = { kind: '404', message }; break }        // id-level, no point trying other accounts
      if (res.status === 403) { outcome = { kind: '403', message }; continue }     // account-level, try next account
      if (res.status === 429) { outcome = { kind: '429', message }; continue }     // quota-level, try next account
      outcome = { kind: String(res.status), message }
      continue
    } catch (e) {
      outcome = { kind: 'ERR', message: e.message.slice(0, 60) }
    }
  }

  if (!outcome) { console.log(`${model.padEnd(26)} NO-USABLE-ACCOUNT`); missing.push(model); continue }
  if (outcome.kind === 'ok') { console.log(`${model.padEnd(26)} OK        (${outcome.acct})`); ok.push(model); continue }
  if (outcome.kind === '404') { console.log(`${model.padEnd(26)} 404       ${outcome.message}`); missing.push(model); continue }
  if (outcome.kind === '403') { console.log(`${model.padEnd(26)} 403-gated ${outcome.message}`); denied.push(model); continue }
  if (outcome.kind === '429') { console.log(`${model.padEnd(26)} 429-quota ${outcome.message.slice(0, 60)}`); denied.push(model); continue }
  console.log(`${model.padEnd(26)} ${outcome.kind}       ${outcome.message}`)
  denied.push(model)
}

console.log(`\nSERVING=${JSON.stringify(ok)}`)
console.log(`QUOTA_OR_GATED=${JSON.stringify(denied)}`)
console.log(`INVALID_ID=${JSON.stringify(missing)}`)
