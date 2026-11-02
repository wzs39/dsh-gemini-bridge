/**
 * 验证产物预览的三条路径：图片 / PDF / 文本，以及越权防护。
 *
 * 背景：「图片无法预览」的根因是 readConversationFile 把所有图片都判成
 * binary 且 content:''，前端只能显示「不在浏览器里渲染」。修完必须真的
 * 拿到能画的字节，而不是只返回 200。
 *
 * 用法：node bridge/tools/test-file-preview.mjs
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readConversationFile, scanBrain, defaultAccountsRoot } from '../../lib/agy-brain.js'

const root = defaultAccountsRoot()

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

// ── 找一个真的有附件的会话 ───────────────────────────────────────────────────
const index = scanBrain({ root })
console.log(`索引：${index.conversations.length} 会话 / ${index.totals.files} 文件\n`)

let target = null
for (const conv of index.conversations) {
  const detail = readConversationFile
  const files = conv.files ?? []
  const pdf = files.find((f) => f.rel.endsWith('.pdf') || f.path?.endsWith('.pdf'))
  if (pdf) { target = { conv, file: pdf }; break }
}

// scanBrain 的会话条目不带 files，回退到直接遍历
if (!target) {
  const { readConversation } = await import('../../lib/agy-brain.js')
  for (const conv of index.conversations) {
    const d = readConversation(conv.account, conv.id, { root })
    const pdf = (d.files ?? []).find((f) => f.rel.endsWith('.pdf'))
    if (pdf) { target = { conv, file: pdf, account: conv.account }; break }
  }
}

if (!target) {
  console.log('SKIP  没有找到带 PDF 的会话，跳过媒体用例')
} else {
  const account = target.account ?? target.conv.account
  const convId = target.conv.id
  const rel = target.file.rel

  console.log(`目标：${account} / ${convId} / ${rel}\n`)

  const pdf = readConversationFile(account, convId, rel, { root })
  check('PDF 被识别为 pdf', pdf.kind === 'pdf', `kind=${pdf.kind}`)
  check('PDF 带正确的 MIME', pdf.mime === 'application/pdf', `mime=${pdf.mime}`)
  check('PDF 给出 raw 路由', typeof pdf.streamUrl === 'string' && pdf.streamUrl.startsWith('/plugins/'),
    pdf.streamUrl ? pdf.streamUrl.slice(0, 60) + '…' : '(空)')
  check('PDF 不再把 base64 塞进 JSON', !pdf.dataUrl)
  check('PDF 的 note 说明用内置阅读器', /PDF/.test(pdf.note ?? ''), pdf.note)
}

// ── 图片：写一个临时 PNG 到某个会话目录里，验证真的回 base64 ──────────────────
if (index.conversations.length > 0) {
  const fs = await import('node:fs')
  const conv = index.conversations[0]
  const dir = path.join(root, conv.account, '.gemini', 'antigravity-cli', 'brain', conv.id)
  const relName = '__probe_preview__.png'
  const abs = path.join(dir, relName)
  // 1x1 透明 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  try {
    fs.writeFileSync(abs, png)
    const img = readConversationFile(conv.account, conv.id, relName, { root })
    check('PNG 被识别为 image', img.kind === 'image', `kind=${img.kind}`)
    check('PNG 带 image/png MIME', img.mime === 'image/png', `mime=${img.mime}`)
    check('PNG 回 base64 data URL', typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/png;base64,'),
      img.dataUrl ? `len=${img.dataUrl.length}` : '(空)')
    check('PNG 的 data URL 能还原成原始字节',
      Buffer.from((img.dataUrl.split(',')[1] ?? ''), 'base64').equals(png))
    check('PNG 也给 raw 路由（超大图回退用）', typeof img.streamUrl === 'string' && img.streamUrl.startsWith('/plugins/'))
  } finally {
    try { fs.unlinkSync(abs) } catch { /* 已删 */ }
  }
}

// ── 文本路径不能被破坏 ───────────────────────────────────────────────────────
if (index.conversations.length > 0) {
  const conv = index.conversations[0]
  const d = await (await import('../../lib/agy-brain.js')).readConversation(conv.account, conv.id, { root })
  const textFile = (d.files ?? []).find((f) => f.rel.endsWith('.jsonl'))
  if (textFile) {
    const t = readConversationFile(conv.account, conv.id, textFile.rel, { root })
    check('文本仍回 content', t.kind === 'text' && typeof t.content === 'string' && t.content.length > 0,
      `${t.content.length} 字符`)
    check('文本不塞 dataUrl', !t.dataUrl)
  }
}

// ── 越权防护：必须和 file 路由完全一致 ───────────────────────────────────────
const conv = index.conversations[0]
const escapes = [
  ['..\\..\\..\\etc\\passwd', 'unix 反斜杠逃逸'],
  ['../../../config.json', 'unix 斜杠逃逸'],
  ['/etc/passwd', '绝对路径'],
]
for (const [bad, why] of escapes) {
  let threw = false
  try { readConversationFile(conv.account, conv.id, bad, { root }) } catch { threw = true }
  check(`拒绝路径逃逸（${why}）`, threw)
}
for (const [acc, id, why] of [
  ['../evil', conv.id, 'account 含 ..'],
  [conv.account, '..', 'convId 含 ..'],
  [conv.account, 'a/b', 'convId 含斜杠'],
]) {
  let threw = false
  try { readConversationFile(acc, id, 'x', { root }) } catch { threw = true }
  check(`拒绝非法 id（${why}）`, threw)
}

// ── 真实 HTTP 路由（需要 DSH 在跑且已重启加载本版代码）──────────────────────
//
// 这一段验证的是「装上之后路由确实存在」，不是代码逻辑——逻辑已由
// test-brain-http.mjs 用假宿主完整覆盖（npm test 会跑它）。
// 所以这里的定位是**可选的真机确认**：DSH 没重启（新路由还没注册）时报 SKIP，
// 不报 FAIL——否则 CI 或本地跑测试会稳定得到 4 个假失败。
const port = process.env.DSH_WEB_PORT ?? '6366'
if (target) {
  const account = target.account ?? target.conv.account
  const qs = new URLSearchParams({ account, id: target.conv.id, path: target.file.rel })
  const url = `http://127.0.0.1:${port}/plugins/dsh-gemini-bridge/agy/brain/raw?${qs}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (r.status === 404) {
      console.log(`SKIP  raw 路由实测 —— DSH 在 ${port} 上跑的是旧代码（新路由要重启才注册）`)
      console.log('      逻辑覆盖见 bridge/tools/test-brain-http.mjs（npm test 会跑）')
    } else {
      const buf = Buffer.from(await r.arrayBuffer())
      check('raw 路由返回 200', r.status === 200, `status=${r.status}`)
      check('raw 路由 content-type 是 application/pdf',
        (r.headers.get('content-type') ?? '').includes('application/pdf'),
        r.headers.get('content-type') ?? '(空)')
      check('raw 路由回的是真字节（%PDF 头）', buf.subarray(0, 4).toString('latin1') === '%PDF',
        `${buf.length} 字节`)
      check('raw 路由禁止嗅探', r.headers.get('x-content-type-options') === 'nosniff')
    }
  } catch (error) {
    console.log(`SKIP  raw 路由实测（${error?.message ?? error}）—— DSH 未在 ${port} 上运行？`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
