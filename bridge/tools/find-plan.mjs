// DSH 会话是「多帧 zstd」：每帧一个独立 zstd 流，帧与帧首尾相接。
// zstdDecompressSync 只解第一帧（会话头），所以直接用它搜正文必然零命中。
// 这里按 zstd 帧格式自己走帧头，逐帧解压并拼接。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const root = join(process.env.USERPROFILE, '.dsh', 'sessions')
const ZSTD_MAGIC = 0xFD2FB528

/**
 * 计算一帧 zstd 的字节长度。
 * 帧结构：Magic(4) + FrameHeader(2..14) + BlockHeader(3*N) + [ContentChecksum(4)]
 * 逐块累加直到 last_block=1。
 */
function frameLength(buf, start) {
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) return -1
  let p = start + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksumFlag = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1                    // WindowDescriptor
  p += [0, 1, 2, 4][dictIdFlag]                 // DictionaryID
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag] // FrameContentSize

  // Block 循环
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const lastBlock = bh & 1
    const blockType = (bh >> 1) & 3
    const blockSize = bh >>> 3
    // type 1 = RLE（只占 1 字节），其它占 blockSize
    p += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
    if (p > buf.length) return -1
  }
  if (checksumFlag) p += 4
  return p - start
}

/** 逐帧解压整个多帧文件。 */
function decompressAll(file) {
  const buf = readFileSync(file)
  const parts = []
  let offset = 0
  let frames = 0
  while (offset < buf.length - 3) {
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const len = frameLength(buf, offset)
    if (len <= 0) break
    try {
      parts.push(zstdDecompressSync(buf.subarray(offset, offset + len)))
      frames++
    } catch { break }
    offset += len
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.zstd')) out.push({ path: p, mtime: st.mtimeMs, size: st.size })
  }
  return out
}

const files = walk(root).sort((a, b) => b.mtime - a.mtime)
log(`扫描 ${files.length} 个会话文件（多帧解码）...\n`)

const PATTERNS = [
  /10\s*[-–~]\s*13\s*(小时|h\b)/i,
  /总工时/,
  /(4|四)\s*个阶段/,
  /阶段[一二三四1-4][：:]/,
  /预计.{0,6}工时/,
]

const hits = []
for (const f of files) {
  let res
  try { res = decompressAll(f.path) } catch { continue }
  if (!res.text || res.text.length < 200) continue
  for (const re of PATTERNS) {
    if (re.test(res.text)) {
      hits.push({ ...f, text: res.text, frames: res.frames })
      break
    }
  }
}

log(`命中 ${hits.length} 个会话\n`)
for (const h of hits.slice(0, 3)) {
  log('='.repeat(72))
  log(`会话: ${basename(dirname(h.path))}`)
  log(`时间: ${new Date(h.mtime).toISOString()}  帧数: ${h.frames}  正文: ${h.text.length} 字符`)
  for (const re of PATTERNS) {
    const m = h.text.match(re)
    if (!m) continue
    const i = h.text.indexOf(m[0])
    log('--- 命中上下文 ---')
    log(h.text.slice(Math.max(0, i - 3000), Math.min(h.text.length, i + 5000)))
    break
  }
  log('')
}
