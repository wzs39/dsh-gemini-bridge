// 逐块解析 raw stream，打印 wrb.fr 条目内部结构，确认文本落点与累积方式。
import { readFileSync } from 'node:fs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const raw = readFileSync('../runs/raw-stream.txt', 'utf8')
log(`total ${raw.length} chars`)

const stripped = raw.replace(/^\)\]\}'[\s\S]*?\r?\n\r?\n/, '')
const lines = stripped.split(/\r?\n/).filter(l => l.trim().startsWith('['))
log(`payload 行数 = ${lines.length}\n`)

let acc = ''
for (const [n, line] of lines.entries()) {
  let payload
  try { payload = JSON.parse(line.trim()) } catch (e) { log(`#${n} 解析失败 ${e.message}`); continue }

  // payload = [ ["wrb.fr", null, inner, ...], ... ]  —— 注意：wrb 条目本身就是数组元素
  for (const entry of payload) {
    if (!Array.isArray(entry)) continue
    if (entry[0] !== 'wrb.fr') { log(`#${n} 非 wrb 条目: ${JSON.stringify(entry).slice(0, 80)}`); continue }
    const inner = entry[2]
    if (inner === null || inner === undefined) { log(`#${n} wrb 中间块 inner=null`); continue }
    if (typeof inner !== 'string') { log(`#${n} inner 非字符串: ${typeof inner}`); continue }
    let ip
    try { ip = JSON.parse(inner) } catch (e) { log(`#${n} inner 解析失败 ${e.message}`); continue }

    const shape = ip.map((v, i) => `${i}:${v === null ? 'null' : Array.isArray(v) ? 'arr' + v.length : typeof v}`).join(' ')
    const cand = ip?.[4]
    const frag = Array.isArray(cand) ? cand?.[0]?.[1] : undefined
    const txt = Array.isArray(frag) ? frag.filter(x => typeof x === 'string').join('') : (typeof frag === 'string' ? frag : '')
    acc += txt
    log(`#${n} shape{${shape}}`)
    log(`     conv=${JSON.stringify(ip?.[1]?.[0])} resp=${JSON.stringify(ip?.[1]?.[1])}`)
    log(`     rc=${JSON.stringify(cand?.[0]?.[0])} 片段=${JSON.stringify(txt)} (累积 ${acc.length})`)
  }
}

log(`\n累积全文 = ${JSON.stringify(acc)}`)
log(`含 WEB-OK: ${/WEB-OK/.test(acc) ? 'YES' : 'NO'}`)
