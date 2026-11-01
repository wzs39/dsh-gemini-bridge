// 验证网页通道真的在三个账号之间轮转，而不是逮着一个用。
// 每个账号的守卫/配额计数独立，打完一轮看 /health 里各账号的 requestsToday
// 是否均衡增长；同时读日志里的账号归属。
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const PORT = process.argv[2] ?? '18902'
const BASE = `http://127.0.0.1:${PORT}`
const KEY = 'sk-local-gemini-web'

async function health() {
  const r = await fetch(`${BASE}/health`)
  return r.json()
}

async function chat(prompt) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'gemini-web', messages: [{ role: 'user', content: prompt }], stream: false }),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, content: j.choices?.[0]?.message?.content ?? '', raw: j }
}

const before = await health()
log('轮转前 requestsToday:')
for (const a of before.accounts) log(`  ${a.name}: ${a.guard.requestsToday}  (paused=${a.pausedUntil || '-'})`)

log('\n连打 6 次（每账号 2 次才均衡）:')
for (let i = 1; i <= 6; i++) {
  const r = await chat(`Reply with exactly: ROT-${i}`)
  const hit = new RegExp(`ROT-${i}`).test(r.content)
  log(`  #${i} status=${r.status} ${hit ? '✓' : '✗'} "${r.content.replace(/\n/g, ' ').slice(0, 40)}"`)
}

const after = await health()
log('\n轮转后 requestsToday（增量应分散到三个账号）:')
let spread = 0
for (const a of after.accounts) {
  const b = before.accounts.find(x => x.name === a.name)
  const delta = a.guard.requestsToday - (b?.guard.requestsToday ?? 0)
  if (delta > 0) spread++
  log(`  ${a.name}: ${b?.guard.requestsToday} -> ${a.guard.requestsToday}  (+${delta})`)
}
log(`\n有增长的账号数 = ${spread} / ${after.accounts.length}`)
log(spread >= 2 ? '✓ 轮转生效' : '✗ 只用了同一个账号')
process.exit(spread >= 2 ? 0 : 1)
