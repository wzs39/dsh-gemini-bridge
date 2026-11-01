// 复现 burst-test 的精确条件：同样的 prompt 文本形状（极短、高度相似），
// 连续打，看第几次开始空回答。这是要区分「配额」还是「重复请求被降级」。
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { GeminiWebClient } from '../lib/client.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const manager = new AccountManager(config)
for (const d of manager.describeAll()) {
  const a = manager.pickAccountByName(d.name)
  try {
    await a.session.ensureBrowser()
    if (!a.session.loadPersisted()) await a.session.harvest({ force: true })
    await a.session.scrapePageTokens()
  } catch (e) { log(`[${d.name}] ✗ ${e.message}`) }
}

const client = new GeminiWebClient({ config, manager })
const mode = process.argv[2] ?? 'short'
const N = Number(process.argv[3] ?? '12')

for (let i = 1; i <= N; i++) {
  // burst-test 用的正是这一句：prompt 极短且高度相似
  const msg = mode === 'short'
    ? `Reply with exactly: BURST-${i}`
    : `Reply with exactly: DIFFERENT-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const t0 = Date.now()
  try {
    const opened = await client.openCompletion([{ role: 'user', content: msg }])
    let text = ''
    for (const ev of opened.iterator) if (ev?.delta) text += ev.delta
    const ms = Date.now() - t0
    const expect = mode === 'short' ? `BURST-${i}` : `DIFFERENT-${i}`
    const ok = new RegExp(expect).test(text)
    log(`#${i} ${ok ? '✓' : '✗ 空/错'} ${ms}ms acct=${opened.account?.name} len=${text.length} ${JSON.stringify(text.slice(0, 50))}`)
  } catch (e) {
    log(`#${i} ✗ ${Date.now() - t0}ms ${e.name}: ${e.message.slice(0, 120)}`)
    break
  }
}
manager.stopAll()
setTimeout(() => process.exit(0), 500)
