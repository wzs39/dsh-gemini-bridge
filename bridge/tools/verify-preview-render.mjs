/**
 * 真机渲染验证：产物预览里的图片和 PDF 到底能不能画出来。
 *
 * 为什么需要这一步：接口返回 200 + 正确 MIME 只证明「字节到了浏览器」，
 * 不证明「用户看到了图」。图片可能因为 CSP、data URL 过长、iframe 被禁而
 * 白屏。所以这里用一个真实 Chromium 打开一个最小页面，把面板会用的两种
 * 元素（<img src=dataUrl> 与 <iframe src=rawUrl>）都放进去，然后量像素。
 *
 * 用法：node bridge/tools/verify-preview-render.mjs
 */

import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const {
  readConversation, readConversationFile, resolveConversationFile,
  defaultAccountsRoot,
} = await import('../../lib/agy-brain.js')

const ROOT = defaultAccountsRoot()
const log = (...a) => process.stdout.write(a.join(' ') + '\n')
let failed = 0
const check = (n, ok, d = '') => { if (ok) log(`PASS  ${n}`); else { log(`FAIL  ${n}  ${d}`); failed++ } }

// ── 找素材：一张图片 + 一个 PDF ──────────────────────────────────────────────
const { scanBrain } = await import('../../lib/agy-brain.js')
const idx = scanBrain({ root: ROOT })

let imgSource = null
let pdfSource = null
for (const c of idx.conversations) {
  const d = readConversation(c.account, c.id, { root: ROOT })
  for (const f of d.files ?? []) {
    if (!pdfSource && f.rel.endsWith('.pdf')) pdfSource = { acc: c.account, id: c.id, rel: f.rel }
    if (!imgSource && /\.(png|jpg|jpeg|webp|gif)$/i.test(f.rel)) imgSource = { acc: c.account, id: c.id, rel: f.rel }
  }
  if (pdfSource && imgSource) break
}

// 没有现成图片就在第一个会话目录里放一张 64x64 的红色 PNG（测完删）
let tempPng = null
if (!imgSource) {
  const c = idx.conversations[0]
  const dir = path.join(ROOT, c.account, '.gemini', 'antigravity-cli', 'brain', c.id)
  // 生成一个 64x64 纯红 PNG（用 zlib 手写，避免引入依赖）
  const zlib = await import('node:zlib')
  const W = 64, H = 64
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    const off = y * (W * 3 + 1)
    raw[off] = 0
    for (let x = 0; x < W; x++) {
      raw[off + 1 + x * 3] = 220
      raw[off + 2 + x * 3] = 40
      raw[off + 3 + x * 3] = 40
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crcTable = []
    for (let n = 0; n < 256; n++) { let c2 = n; for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xEDB88320 ^ (c2 >>> 1) : c2 >>> 1; crcTable[n] = c2 >>> 0 }
    let crc = 0xFFFFFFFF
    for (const b of td) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8)
    const cr = Buffer.alloc(4); cr.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0)
    return Buffer.concat([len, td, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const name = '__render_probe__.png'
  fs.writeFileSync(path.join(dir, name), png)
  tempPng = { acc: c.account, id: c.id, rel: name, abs: path.join(dir, name) }
  imgSource = { acc: c.account, id: c.id, rel: name }
}

// ── 起一个和插件同形的假宿主 ─────────────────────────────────────────────────
const RAW_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/page') {
    const imgJson = readConversationFile(imgSource.acc, imgSource.id, imgSource.rel, { root: ROOT })
    const pdfJson = pdfSource ? readConversationFile(pdfSource.acc, pdfSource.id, pdfSource.rel, { root: ROOT }) : null
    const html = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#111">
<img id="pic" src="${imgJson.dataUrl || imgJson.streamUrl}" style="max-width:200px">
${pdfJson ? `<iframe id="doc" src="${pdfJson.streamUrl}" style="width:400px;height:300px;border:0"></iframe>` : ''}
</body>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  if (url.pathname === '/plugins/dsh-gemini-bridge/agy/brain/raw') {
    try {
      const { real, st } = resolveConversationFile(
        url.searchParams.get('account') ?? '', url.searchParams.get('id') ?? '',
        url.searchParams.get('path') ?? '', { root: ROOT })
      res.writeHead(200, {
        'content-type': RAW_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(st.size),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      })
      fs.createReadStream(real).pipe(res)
    } catch (e) { res.writeHead(404); res.end(String(e?.message ?? e)) }
    return
  }
  res.writeHead(404); res.end('nope')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log(`假宿主 http://127.0.0.1:${port}/page\n`)

// ── 用真实 Chromium 量像素 ───────────────────────────────────────────────────
const { launchBrowser, waitForDevTools, attachFirstPage, evaluate } = await import('../lib/cdp.mjs')

const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // 本机实测 Edge 装在 x86 分支下，漏了这一条会让渲染验证静默 SKIP。
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'D:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'D:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p))
if (!exe) {
  log('SKIP  本机没有 Chrome/Edge，无法做渲染验证')
  await new Promise(r => server.close(r))
  process.exit(failed === 0 ? 0 : 1)
}

const cdpPort = 9411
const child = launchBrowser({ executable: exe, port: cdpPort, headless: true, userDataDir: path.join(os.tmpdir(), 'preview-render-probe') })
try {
  await waitForDevTools(cdpPort, 30000)
  const page = await attachFirstPage(cdpPort)
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/page` })
  await new Promise(r => setTimeout(r, 3500))

  const probe = await evaluate(page, `JSON.stringify((() => {
    const img = document.getElementById('pic');
    const doc = document.getElementById('doc');
    const out = {
      img: img ? { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete, cw: img.clientWidth } : null,
      doc: doc ? { w: doc.clientWidth, h: doc.clientHeight } : null,
    };
    // 真画出来了吗：把 img 画到 canvas 上取样一个像素
    if (img && img.naturalWidth > 0) {
      try {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        const px = cv.getContext('2d').getImageData(Math.floor(img.naturalWidth/2), Math.floor(img.naturalHeight/2), 1, 1).data;
        out.pixel = [px[0], px[1], px[2], px[3]];
      } catch (e) { out.pixelError = String(e && e.message || e); }
    }
    return out;
  })())`)

  const r = JSON.parse(probe)
  log(`图片解码结果: ${JSON.stringify(r.img)}`)
  if (r.pixel) log(`中心像素: rgba(${r.pixel.join(',')})`)

  check('图片被浏览器解码（naturalWidth > 0）', Boolean(r.img && r.img.w > 0),
    JSON.stringify(r.img))
  check('图片真的画出来了（canvas 取到非透明像素）',
    Boolean(r.pixel && r.pixel[3] > 0), JSON.stringify(r.pixel ?? r.pixelError))
  if (tempPng) {
    // 我们造的是纯红，画出来就该是红
    check('像素颜色与素材一致（红色）',
      Boolean(r.pixel && r.pixel[0] > 150 && r.pixel[1] < 120), JSON.stringify(r.pixel))
  }
  if (pdfSource) {
    check('PDF iframe 拿到了尺寸', Boolean(r.doc && r.doc.w > 0), JSON.stringify(r.doc))
  }

  page.close()
} finally {
  try { child.kill() } catch { /* 已退出 */ }
  if (tempPng) { try { fs.unlinkSync(tempPng.abs) } catch { /* 已删 */ } }
  await new Promise(r => server.close(r))
}

log('')
log(failed === 0 ? '渲染验证全部通过' : `渲染验证失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
