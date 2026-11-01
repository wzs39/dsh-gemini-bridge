// 真实吞吐验证：连续快速打 N 次，确认新节奏真的能扛，而不是配置数字变大而已。
// 记录每次耗时、成功率、是否触发限速。
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const PORT = process.argv[2] ?? '18901'
const N = Number(process.argv[3] ?? '10')
const BASE = `http://127.0.0.1:${PORT}`
const KEY = 'sk-local-gemini-web'

async function chat(i) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gemini-web',
        messages: [{ role: 'user', content: `Reply with exactly: BURST-${i}` }],
        stream: false,
      }),
    })
    const j = await r.json().catch(() => ({}))
    const ms = Date.now() - t0
    if (!r.ok) return { i, ok: false, ms, status: r.status, err: j?.error?.message ?? '' }
    const c = j.choices?.[0]?.message?.content ?? ''
    return { i, ok: new RegExp(`BURST-${i}`).test(c), ms, status: r.status, content: c }
  } catch (e) {
    return { i, ok: false, ms: Date.now() - t0, status: 0, err: String(e.message ?? e) }
  }
}

const before = await (await fetch(`${BASE}/health`)).json()
const t0 = Date.now()
const results = []
for (let i = 1; i <= N; i++) {
  const r = await chat(i)
  results.push(r)
  const tag = r.ok ? '✓' : '✗'
  log(`  #${String(i).padStart(2)} ${tag} ${String(r.ms).padStart(5)}ms ${r.status}` +
      (r.ok ? ` "${(r.content ?? '').replace(/\n/g, ' ').slice(0, 30)}"` : ` ${r.err?.slice(0, 120) ?? ''}`))
}
const totalMs = Date.now() - t0
const pass = results.filter(r => r.ok).length
const limited = results.filter(r => r.status === 429).length

log(`\n合计: ${pass}/${N} 成功, 用时 ${(totalMs / 1000).toFixed(1)}s (平均 ${Math.round(totalMs / N)}ms/次)`)
log(`限速命中: ${limited} 次`)

const after = await (await fetch(`${BASE}/health`)).json()
log('\n各账号窗口消耗:')
for (const a of after.accounts) {
  const b = before.accounts.find(x => x.name === a.name)
  const d = a.guard.requestsToday - (b?.guard.requestsToday ?? 0)
  log(`  ${a.name}: window=${a.guard.windowSpent}/${a.guard.windowCap}  today +${d}  cd=${a.guard.cooldownSeconds}s`)
}
log(`\npacingPreset=${after.accounts[0].guard.pacingPreset} dailyCeiling=${after.accounts[0].guard.dailyCeiling}`)
process.exit(pass === N ? 0 : 1)
