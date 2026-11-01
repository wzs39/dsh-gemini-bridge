// 逐账号 × 逐模型实测，用真实生成请求判定「这个号现在能不能用」。
// 不读 pool.json 缓存：实测过缓存与上游不一致（缓存显示 3p-5h 为 0%，
// 但 claude 照样出字），只有真发一次请求才算数。
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

const MODELS = [
  'gemini-3.8-flash-medium',
  'gemini-3-flash',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

function envelope(model) {
  return JSON.stringify({
    project: 'aicode-consumers',
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestType: 'agent',
    model,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
      generationConfig: { maxOutputTokens: 24 },
      sessionId: `-${Date.now()}`,
    },
  })
}

const table = []

for (const acct of accounts) {
  const label = acct.email ?? acct.id
  console.log(`\n=== ${label} ===`)
  let token
  try {
    token = await acct.tokens.accessToken()
  } catch (e) {
    console.log(`  token FAIL: ${e.code ?? e.message}`)
    continue
  }
  console.log(`  token ok`)

  const row = { account: label, results: {} }
  for (const model of MODELS) {
    const t0 = Date.now()
    let outcome
    try {
      const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': UA,
          requesttype: 'agent',
        },
        body: envelope(model),
        signal: AbortSignal.timeout(60000),
      })
      const text = await res.text()
      if (res.status === 200 && text.includes('data:')) {
        // 抽一小段回答文本，确认真的出字而不是空帧
        let got = ''
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const j = JSON.parse(line.slice(5).trim())
            const parts = j?.response?.candidates?.[0]?.content?.parts ?? []
            for (const p of parts) if (p.text) got += p.text
          } catch { /* skip */ }
        }
        outcome = { ok: true, ms: Date.now() - t0, text: got.trim().slice(0, 20) }
      } else {
        let msg = text.slice(0, 80).replace(/\s+/g, ' ')
        let status = ''
        let resetIn = ''
        try {
          const j = JSON.parse(text)
          status = j.error?.status ?? ''
          msg = (j.error?.message ?? msg).slice(0, 70)
          // 从 message 里抽 "Resets in ..."
          const m = /Resets in ([0-9hms]+)/i.exec(j.error?.message ?? '')
          if (m) resetIn = m[1]
        } catch { /* raw */ }
        outcome = { ok: false, ms: Date.now() - t0, status, msg, resetIn, http: res.status }
      }
    } catch (e) {
      outcome = { ok: false, ms: Date.now() - t0, status: 'ERR', msg: e.message.slice(0, 60) }
    }

    row.results[model] = outcome
    if (outcome.ok) {
      console.log(`  ${model.padEnd(28)} OK   ${String(outcome.ms).padStart(6)}ms  ${JSON.stringify(outcome.text)}`)
    } else if (outcome.status === 'RESOURCE_EXHAUSTED') {
      const reset = outcome.resetIn ? ` reset ${outcome.resetIn}` : ''
      console.log(`  ${model.padEnd(28)} 429  quota exhausted${reset}`)
    } else if (outcome.status === 'PERMISSION_DENIED') {
      console.log(`  ${model.padEnd(28)} 403  needs account verification`)
    } else {
      console.log(`  ${model.padEnd(28)} ${outcome.http ?? ''} ${outcome.status ?? ''}  ${outcome.msg}`)
    }
  }
  table.push(row)
}

// ── 汇总矩阵 ───────────────────────────────────────────────────────────────
console.log('\n\n=== 汇总 ===')
const modelNames = MODELS
const header = ['账号'.padEnd(26), ...modelNames.map(m => m.split('-')[0].slice(0, 6).padStart(7))]
console.log(header.join(' '))
for (const row of table) {
  const cells = modelNames.map(m => {
    const o = row.results[m]
    if (!o) return '      -'
    if (o.ok) return '     OK'
    if (o.status === 'RESOURCE_EXHAUSTED') return '    429'
    if (o.status === 'PERMISSION_DENIED') return '    403'
    return '    ERR'
  })
  console.log([row.account.padEnd(26), ...cells].join(' '))
}

console.log('')
console.log('=== 每个账号的结论 ===')
for (const row of table) {
  const ok = modelNames.filter(m => row.results[m]?.ok)
  const quota = modelNames.filter(m => row.results[m]?.status === 'RESOURCE_EXHAUSTED')
  const parts = []
  if (ok.length) parts.push(`可用: ${ok.join(', ')}`)
  if (quota.length) parts.push(`配额耗尽: ${quota.join(', ')}`)
  console.log(`  ${row.account.padEnd(26)} ${parts.join('  |  ') || '全部不可用'}`)
}
