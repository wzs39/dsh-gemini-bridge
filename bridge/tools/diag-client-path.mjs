// 精确复现服务端路径：多账号 manager + GeminiWebClient.openCompletion，
// 用 8 个不同 prompt（不同 threadKey），逐次打印结果，找出空回答的触发条件。
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
    log(`[${d.name}] ✓`)
  } catch (e) { log(`[${d.name}] ✗ ${e.message}`) }
}

const client = new GeminiWebClient({ config, manager })
const N = Number(process.argv[2] ?? '8')

for (let i = 1; i <= N; i++) {
  const msg = `Reply with exactly: PROBE-${i}`
  const t0 = Date.now()
  try {
    const opened = await client.openCompletion([{ role: 'user', content: msg }])
    let text = ''
    for (const ev of opened.iterator) if (ev?.delta) text += ev.delta
    const ms = Date.now() - t0
    const ok = new RegExp(`PROBE-${i}`).test(text)
    log(`#${i} ${ok ? '✓' : '✗'} ${ms}ms acct=${opened.account?.name} len=${text.length} ${JSON.stringify(text.slice(0, 60))}`)
  } catch (e) {
    log(`#${i} ✗ ${Date.now() - t0}ms ${e.name}: ${e.message.slice(0, 140)}`)
  }
}

manager.stopAll()
setTimeout(() => process.exit(0), 500)
