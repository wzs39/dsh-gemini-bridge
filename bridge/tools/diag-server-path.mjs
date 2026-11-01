// 复现服务端路径：manager 全量起来 -> GeminiWebClient.openCompletion
// 打印实际被选中的账号与原始响应前若干字符，用来定位“直连可用、走服务空”的差异。
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { GeminiWebClient } from '../lib/client.mjs'
import { parseGenerateResponse } from '../lib/parser.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const manager = new AccountManager(config)

// 完全照 serve.mjs 的启动顺序
for (const d of manager.describeAll()) {
  const account = manager.pickAccountByName(d.name)
  const label = `[${d.name}]`
  try {
    await account.session.ensureBrowser()
    if (!account.session.loadPersisted()) {
      await account.session.harvest({ force: true })
    }
    await account.session.scrapePageTokens()
    log(`${label} ✓ live  snlm0e=${account.session._pageTokens?.snlm0e?.length ?? '?'} bl=${account.session._pageTokens?.bl?.slice(0, 26) ?? '?'}`)
  } catch (e) {
    log(`${label} ✗ parked: ${e.message}`)
  }
}

const client = new GeminiWebClient({ config, manager })

// 直接调底层，绕开 client 的 guard/解析，先看原始字节
const acct = manager.pick()
log(`\n== pick() -> ${acct?.name} ==`)

const t0 = Date.now()
let raw
try {
  raw = await acct.session.generateRaw({ prompt: 'Reply with exactly: WEB-OK', timeoutMs: 180000 })
} catch (e) {
  log(`generateRaw 抛错: ${e.message} status=${e.status}`)
  manager.stopAll(); process.exit(1)
}
const ms = Date.now() - t0
const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
log(`generateRaw: ${ms}ms, ${text.length} 字节`)
log(`  头部: ${JSON.stringify(text.slice(0, 200))}`)
log(`  含 WEB-OK: ${/WEB-OK/.test(text) ? 'YES' : 'NO'}`)

const parsed = parseGenerateResponse(text)
log(`\nparseGenerateResponse -> ${parsed ? JSON.stringify({ len: parsed.text?.length, conv: parsed.conversationId, resp: parsed.responseId }) : 'null'}`)
if (parsed?.text) log(`  文本前 120: ${JSON.stringify(parsed.text.slice(0, 120))}`)

// 逐个 account 都试一遍，看是否某个账号空
log('\n== 逐账号 generateRaw ==')
for (const d of manager.describeAll()) {
  const a = manager.pickAccountByName(d.name)
  const st = Date.now()
  try {
    const r = await a.session.generateRaw({ prompt: 'Reply with exactly: WEB-OK', timeoutMs: 120000 })
    const s = typeof r === 'string' ? r : JSON.stringify(r)
    const p = parseGenerateResponse(s)
    log(`[${d.name}] ${Date.now() - st}ms ${s.length}B  parsed=${p?.text ? 'YES(' + p.text.length + ')' : 'null'}`)
    if (!p?.text) log(`   头部: ${JSON.stringify(s.slice(0, 300))}`)
  } catch (e) {
    log(`[${d.name}] 抛错 ${Date.now() - st}ms: ${e.message}`)
  }
}

manager.stopAll()
setTimeout(() => process.exit(0), 500)
