// 端到端验证 agy-brain 的三条路由逻辑（不依赖 DSH 宿主，直接调 handler 里的函数）。
// 目的：证明「面板能拿到真实数据」，而不是只证明「代码没语法错」。
// agy-brain.js 在插件根目录的 lib/ 下（宿主半身），不在 bridge/lib/（网关本体）
import { scanBrain, readConversation, readConversationFile, classifyFile, defaultAccountsRoot } from '../../lib/agy-brain.js'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { log(`PASS  ${name}`) }
  else { log(`FAIL  ${name}  ${detail}`); failed++ }
}

// ── 1. 索引 ──
const idx = scanBrain()
check('索引含 root', typeof idx.root === 'string' && idx.root.length > 0, idx.root)
check('索引有 scannedAt', typeof idx.scannedAt === 'string')
check('账号数 > 0', idx.totals.accounts > 0, String(idx.totals.accounts))
check('会话数 > 0', idx.totals.conversations > 0, String(idx.totals.conversations))
check('文件数 > 0', idx.totals.files > 0, String(idx.totals.files))
check('token 统计非零', idx.totals.tokens.output > 0, String(idx.totals.tokens.output))
check('每个会话都有 account/id', idx.conversations.every(c => c.account && c.id))
check('会话按时间倒序', (() => {
  for (let i = 1; i < idx.conversations.length; i++) {
    const a = idx.conversations[i - 1].lastAt || ''
    const b = idx.conversations[i].lastAt || ''
    if (a && b && a < b) return false
  }
  return true
})())

// ── 2. 详情 ──
const first = idx.conversations.find(c => c.messages === undefined && c.artifacts.length > 0) ?? idx.conversations[0]
const detail = readConversation(first.account, first.id)
check('详情有 messages 数组', Array.isArray(detail.messages))
check('详情有 files 数组', Array.isArray(detail.files))
check('详情有 summary', detail.summary && typeof detail.summary.tokens === 'object')
check('每条 message 有 type/tokens', detail.messages.every(m => typeof m.type === 'string' && m.tokens))

// ── 3. 产物文件内容可读 ──
const art = detail.files.find(f => f.kind === 'artifact' && /\.md$/.test(f.rel))
if (art) {
  const file = readConversationFile(first.account, first.id, art.rel)
  check('产物内容非空', typeof file.content === 'string' && file.content.length > 0, `len=${file.content?.length}`)
  check('产物不是二进制', file.binary === false)
} else {
  log('SKIP  该会话没有 md 产物')
}

// ── 4. 附件（media）必须被认出来 ──
//
// 回归：附件实际落在 `.system_generated/logs/media/…`，而 classifyFile 一进
// logs 就 return 'log'，于是 media 计数永远是 0、附件在列表里显示成「日志」，
// 用户看不出那是能预览的 PDF/图片。
const MEDIA_CASES = [
  ['.system_generated/logs/media/step_2_media_0.pdf', 'media'],
  ['.system_generated/logs/media/shot.png', 'media'],
  ['.system_generated/logs/transcript.jsonl', 'transcript'],
  ['.system_generated/logs/chunks/transcript/00000000.jsonl', 'transcript-shard'],
  ['.system_generated/steps/3/output.txt', 'tool-output'],
  ['.system_generated/messages/1.json', 'message'],
]
for (const [rel, want] of MEDIA_CASES) {
  const got = classifyFile(rel, 'conv-id')
  check(`分类 ${rel.split('/').slice(-1)[0]} → ${want}`, got === want, `got=${got}`)
}

const mediaConv = idx.conversations.find(c => (c.media ?? 0) > 0)
check('索引里有会话统计到 media', Boolean(mediaConv), '所有会话 media 都是 0')
if (mediaConv) {
  const md = readConversation(mediaConv.account, mediaConv.id)
  const mediaFiles = (md.files ?? []).filter(f => f.kind === 'media')
  check('附件文件被标成 media', mediaFiles.length > 0, `count=${mediaFiles.length}`)
}

// ── 5. 预览类型：图片给 dataUrl / PDF 给 raw URL / 文本给 content ──
const previewConv = mediaConv ?? idx.conversations[0]
const pv = readConversation(previewConv.account, previewConv.id)
const pdfFile = (pv.files ?? []).find(f => f.rel.endsWith('.pdf'))
if (pdfFile) {
  const f = readConversationFile(previewConv.account, previewConv.id, pdfFile.rel)
  check('PDF kind=pdf', f.kind === 'pdf', `kind=${f.kind}`)
  check('PDF mime=application/pdf', f.mime === 'application/pdf', `mime=${f.mime}`)
  check('PDF 给 streamUrl', typeof f.streamUrl === 'string' && f.streamUrl.includes('/brain/raw'))
  check('PDF 不把 base64 塞进 JSON', !f.dataUrl)
} else {
  log('SKIP  没有 PDF 附件可测预览')
}

// ── 6. 安全边界 ──
const bad = [
  ['路径穿越 ../', () => readConversationFile(first.account, first.id, '../../../etc/passwd')],
  ['绝对路径', () => readConversationFile(first.account, first.id, '/etc/passwd')],
  ['非法 account', () => readConversation('../../x', first.id)],
  ['非法 convId', () => readConversation(first.account, '../x')],
  ['不存在的会话', () => readConversation(first.account, 'no-such-conversation-id-xyz')],
]
for (const [name, fn] of bad) {
  let threw = false
  try { fn() } catch { threw = true }
  check(`安全拦截: ${name}`, threw)
}

log('')
log(failed === 0 ? `全部通过（${idx.totals.conversations} 会话 / ${idx.totals.files} 文件）` : `失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
