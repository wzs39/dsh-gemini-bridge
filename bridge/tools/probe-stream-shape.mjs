// 用长回答验证：每个 chunk 是「累积快照」还是「增量」。
// 打印每块 ip[4][0][1] 的原始数组与合并后长度，确认最终取哪一块。
import { writeFileSync } from 'node:fs'
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const manager = new AccountManager(config)
const acct = manager.pickAccountByName(process.argv[2] ?? 'pro1')

await acct.session.ensureBrowser()
if (!acct.session.loadPersisted()) await acct.session.harvest({ force: true })
await acct.session.scrapePageTokens()

const prompt = process.argv[3] ?? 'Count from 1 to 40, one number per line, then write a short sentence saying DONE.'
const raw = await acct.session.generateRaw({ prompt, timeoutMs: 300000 })
writeFileSync('../runs/raw-long.txt', raw, 'utf8')
log(`prompt = ${JSON.stringify(prompt)}`)
log(`raw ${raw.length} chars\n`)

const stripped = raw.replace(/^\)\]\}'[\s\S]*?\r?\n\r?\n/, '')
const lines = stripped.split(/\r?\n/).filter(l => l.trim().startsWith('['))

let n = 0
for (const line of lines) {
  let payload
  try { payload = JSON.parse(line.trim()) } catch { continue }
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue
    if (typeof entry[2] !== 'string') continue
    let ip
    try { ip = JSON.parse(entry[2]) } catch { continue }
    const blocks = ip?.[4]?.[0]?.[1]
    if (!Array.isArray(blocks)) { log(`#${n++} 无 candidates 文本（shape 顶层 ${ip.length} 项）`); continue }
    const joined = blocks.filter(x => typeof x === 'string').join('')
    log(`#${n++} blocks=${blocks.length} join=${joined.length} 尾部=${JSON.stringify(joined.slice(-40))}`)
  }
}

// 最后一块的 join 是不是完整全文？
const last = raw.trimEnd().split(/\r?\n/).reverse().find(l => l.trim().startsWith('['))
manager.stopAll()
setTimeout(() => process.exit(0), 500)
