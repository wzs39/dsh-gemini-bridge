// 空回答诊断：绕开服务端 guard，直接单账号 generateRaw，看是
// (a) 上游真返回空内容（限流/降级） 还是 (b) 解析器又对不上布局。
// 用不同 prompt 各打一次，打印原始字节特征。
import { writeFileSync } from 'node:fs'
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { parseGenerateResponse } from '../lib/parser.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const manager = new AccountManager(config)
const name = process.argv[2] ?? 'pro1'
const acct = manager.pickAccountByName(name)
if (!acct) { log(`无账号 ${name}`); process.exit(1) }

await acct.session.ensureBrowser()
if (!acct.session.loadPersisted()) await acct.session.harvest({ force: true })
await acct.session.scrapePageTokens()
log(`[${name}] 就绪`)

const prompts = [
  'Reply with exactly: DIAG-1',
  'BURST-1',
  'Reply with exactly: BURST-1',
]
for (const [i, prompt] of prompts.entries()) {
  const t0 = Date.now()
  let raw = null, err = null
  try {
    raw = await acct.session.generateRaw({ prompt, timeoutMs: 180000 })
  } catch (e) { err = e }
  const ms = Date.now() - t0
  if (err) { log(`#${i} 抛错 ${ms}ms: ${err.message} status=${err.status}`); continue }
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const parsed = parseGenerateResponse(s)
  log(`#${i} ${ms}ms ${s.length}B prompt=${JSON.stringify(prompt.slice(0, 40))}`)
  log(`    parsed=${parsed?.text ? JSON.stringify(parsed.text.slice(0, 60)) + ` (len ${parsed.text.length})` : 'NULL'}`)
  if (!parsed?.text) {
    writeFileSync(`../runs/empty-${name}-${i}.txt`, s, 'utf8')
    log(`    头部: ${JSON.stringify(s.slice(0, 260))}`)
    // 找 wrb.fr 条目看 inner 形状
    const stripped = s.replace(/^\)\]\}'[\s\S]*?\r?\n\r?\n/, '')
    const lines = stripped.split(/\r?\n/).filter(l => l.trim().startsWith('['))
    log(`    payload 行数=${lines.length}`)
    for (const [n, line] of lines.entries()) {
      try {
        const p = JSON.parse(line.trim())
        for (const e of p) {
          if (!Array.isArray(e) || e[0] !== 'wrb.fr') { log(`      chunk#${n} 非wrb: ${JSON.stringify(e).slice(0,60)}`); continue }
          if (typeof e[2] !== 'string') { log(`      chunk#${n} wrb inner=${JSON.stringify(e[2])}`); continue }
          const ip = JSON.parse(e[2])
          log(`      chunk#${n} inner shape: len=${ip.length} [4]=${Array.isArray(ip[4]) ? 'arr' + ip[4].length : typeof ip[4]}`)
          if (Array.isArray(ip[4])) log(`         ip[4][0]=${JSON.stringify(ip[4][0]).slice(0, 200)}`)
        }
      } catch (e) { log(`      chunk#${n} 解析失败 ${e.message}`) }
    }
  }
}

manager.stopAll()
setTimeout(() => process.exit(0), 500)
