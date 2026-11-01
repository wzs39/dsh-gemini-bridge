// dump 原始 StreamGenerate 响应：按 length-prefixed chunk 正确切块，
// 打印每块的结构指纹，确认新布局里答案文本落在哪。
import { writeFileSync } from 'node:fs'
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const manager = new AccountManager(config)
const acct = manager.pickAccountByName('pro1')

await acct.session.ensureBrowser()
if (!acct.session.loadPersisted()) await acct.session.harvest({ force: true })
await acct.session.scrapePageTokens()

const raw = await acct.session.generateRaw({ prompt: 'Reply with exactly: WEB-OK', timeoutMs: 180000 })
writeFileSync('../runs/raw-stream.txt', raw, 'utf8')
log(`原始 ${raw.length} 字符 -> runs/raw-stream.txt`)

// ── 正确的 chunk 切分：<len>\n<json>，重复 ──
function splitChunks(s) {
  const out = []
  let i = s.indexOf("\n\n")
  if (i < 0) i = 0
  else i += 2
  while (i < s.length) {
    // 读数字
    let j = i
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
    if (j === i) break                     // 不是长度行，停
    const len = parseInt(s.slice(i, j), 10)
    if (s[j] === '\n') j++
    const body = s.slice(j, j + len)
    out.push({ len, body })
    i = j + len
    if (s[i] === '\n') i++
  }
  return out
}

const chunks = splitChunks(raw)
log(`切出 ${chunks.length} 块: ${chunks.map(c => c.len).join(', ')}`)

let acc = ''
for (const [n, c] of chunks.entries()) {
  let p
  try { p = JSON.parse(c.body) } catch (e) {
    log(`chunk#${n} JSON 失败: ${e.message}`)
    continue
  }
  // 找 wrb.fr 条目
  for (const outer of p) {
    if (!Array.isArray(outer)) continue
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue
      const inner = entry[2]
      if (typeof inner !== 'string') {
        log(`chunk#${n} wrb.fr 但 inner 不是字符串（null）= 中间块`)
        continue
      }
      let ip
      try { ip = JSON.parse(inner) } catch { log(`chunk#${n} inner 非法`); continue }
      const frag = ip?.[4]?.[0]?.[1]
      const txt = Array.isArray(frag) ? frag.join('') : (typeof frag === 'string' ? frag : '')
      acc += txt
      log(`chunk#${n} conv=${ip?.[1]?.[0]} resp=${ip?.[1]?.[1]} rc=${ip?.[4]?.[0]?.[0]} 片段=${JSON.stringify(txt)}`)
    }
  }
}

log(`\n累积文本 = ${JSON.stringify(acc)}`)
log(`含 WEB-OK: ${/WEB-OK/.test(acc) ? 'YES' : 'NO'}`)
manager.stopAll()
setTimeout(() => process.exit(0), 500)
