// 关键问题：三个账号是各自独立的配额，还是共享同一个 cloudaicompanionProject？
//
// 如果三个号返回同一个 project id，那配额就是按 project 算的 —— 一个号用光，
// 三个号一起报 429，这正好解释「另外两个号我根本没用过却也耗尽」。
//
// 同时核对 ineligibleTiers / 地区字段，区分「地区限制」和「配额耗尽」。
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

for (const acct of accounts) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`账号: ${acct.email}`)
  console.log(`池 id: ${acct.id}`)
  let token
  try { token = await acct.tokens.accessToken() } catch (e) { console.log('  token FAIL', e.code); continue }

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': UA,
    requesttype: 'agent',
  }

  // ── loadCodeAssist：看 project、tier、地区字段 ──────────────────────────
  const lca = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
    method: 'POST', headers,
    body: JSON.stringify({ metadata: { pluginType: 'GEMINI', platform: 'WINDOWS_AMD64' } }),
    signal: AbortSignal.timeout(30000),
  })
  const lcaText = await lca.text()
  console.log(`\n  loadCodeAssist: HTTP ${lca.status}`)
  let lcaJson = null
  try { lcaJson = JSON.parse(lcaText) } catch { /* */ }
  if (lcaJson) {
    console.log(`  cloudaicompanionProject : ${lcaJson.cloudaicompanionProject ?? '(none)'}`)
    console.log(`  currentTier             : ${lcaJson.currentTier?.id ?? '(none)'}`)
    console.log(`  paidTier                : ${lcaJson.paidTier?.id ?? '(none)'}`)
    console.log(`  gcpManaged              : ${lcaJson.gcpManaged}`)
    const inel = lcaJson.ineligibleTiers ?? []
    if (inel.length) {
      console.log(`  ineligibleTiers         :`)
      for (const t of inel) {
        console.log(`      tierId=${t.tierId}  reasonCode=${t.reasonCode}`)
        console.log(`      ${(t.reasonMessage ?? '').slice(0, 110)}`)
      }
    } else {
      console.log(`  ineligibleTiers         : (空 —— 没有资格限制)`)
    }
    const allowed = (lcaJson.allowedTiers ?? []).map(t => t.id).join(', ')
    console.log(`  allowedTiers            : ${allowed || '(none)'}`)
  } else {
    console.log('  ' + lcaText.slice(0, 300))
  }

  // ── retrieveUserQuotaSummary：原始结构，看是否按 project 共享 ───────────
  const q = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(30000),
  })
  const qText = await q.text()
  console.log(`\n  retrieveUserQuotaSummary: HTTP ${q.status}`)
  if (q.status === 200) {
    try {
      const j = JSON.parse(qText)
      for (const g of j.groups ?? []) {
        console.log(`    组 ${g.displayName ?? '?'}`)
        for (const b of g.buckets ?? []) {
          const pct = typeof b.remainingFraction === 'number'
            ? (b.remainingFraction * 100).toFixed(1) + '%' : '?'
          const reset = b.resetTime ? new Date(b.resetTime).toISOString().slice(11, 19) : '?'
          console.log(`      ${String(b.bucketId).padEnd(14)} ${pct.padStart(7)}  reset ${reset}Z`)
        }
      }
    } catch { console.log('    ' + qText.slice(0, 300)) }
  } else {
    let msg = qText.slice(0, 200).replace(/\s+/g, ' ')
    try {
      const j = JSON.parse(qText)
      msg = `${j.error?.status}: ${j.error?.message}`
      const reason = j.error?.details?.[0]?.reason
      if (reason) msg += `  [reason=${reason}]`
    } catch { /* */ }
    console.log('    ' + msg)
  }

  // ── claude 实测时抓完整错误细节 ─────────────────────────────────────────
  const gen = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST', headers,
    body: JSON.stringify({
      project: 'aicode-consumers',
      requestId: `req-${Date.now()}`,
      requestType: 'agent',
      model: 'claude-sonnet-4-6',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
        generationConfig: { maxOutputTokens: 16 },
        sessionId: `-${Date.now()}`,
      },
    }),
    signal: AbortSignal.timeout(45000),
  })
  const genText = await gen.text()
  console.log(`\n  claude-sonnet-4-6: HTTP ${gen.status}`)
  if (gen.status !== 200) {
    try {
      const j = JSON.parse(genText)
      console.log(`    status : ${j.error?.status}`)
      console.log(`    message: ${j.error?.message}`)
      const det = j.error?.details ?? []
      for (const d of det) {
        console.log(`    detail : ${d['@type']?.split('/').pop()} reason=${d.reason ?? '-'} domain=${d.domain ?? '-'}`)
        if (d.metadata) {
          for (const [k, v] of Object.entries(d.metadata)) {
            console.log(`       ${k}: ${String(v).slice(0, 120)}`)
          }
        }
      }
    } catch { console.log('    ' + genText.slice(0, 400)) }
  } else {
    console.log('    OK 出字')
  }
}
