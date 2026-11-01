// 用刚从 Edge 取到的 cookie 现场调一次 Gemini，确认：(1) 会话真的有效 (2) 是哪个账号。
//
// 这一步很关键：cookie 存在 ≠ 能调通。只有拿到 SNlM0e 并成功跑一次
// batchexecute 才算真的可用。整个过程只在本地发一次请求，不走浏览器。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ORIGIN = 'https://gemini.google.com'
const APP_PATH = '/app'
const RPC_PATH = '/_/BardChatUi/data/batchexecute'
const RPCID = 'entertg'

const ud = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data')
const cookiesFile = path.join(ud, 'Default', 'Network', 'Cookies')
const tmp = path.join(os.tmpdir(), `ck-live-${Date.now()}.db`)
fs.copyFileSync(cookiesFile, tmp)

// ── 解 AES 主密钥 ──────────────────────────────────────────────────────────
function dpapiUnprotect(base64Blob) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$b = [Convert]::FromBase64String($env:DPAPI_BLOB)',
    '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, "CurrentUser")',
    '[Convert]::ToBase64String($p)',
  ].join('; ')
  const enc = Buffer.from(ps, 'utf16le').toString('base64')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DPAPI_BLOB: base64Blob }, timeout: 20000,
  })
  return Buffer.from(out.trim(), 'base64')
}
const ls = JSON.parse(fs.readFileSync(path.join(ud, 'Local State'), 'utf8'))
const rawKey = Buffer.from(ls.os_crypt.encrypted_key, 'base64').subarray(5)
const aesKey = dpapiUnprotect(rawKey.toString('base64'))

function decrypt(encValue) {
  if (!encValue?.length) return ''
  const prefix = encValue.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return encValue.toString('utf8')
  const nonce = encValue.subarray(3, 15)
  const payload = encValue.subarray(15)
  const d = createDecipheriv('aes-256-gcm', aesKey, nonce)
  d.setAuthTag(payload.subarray(payload.length - 16))
  return Buffer.concat([d.update(payload.subarray(0, payload.length - 16)), d.final()]).toString('utf8')
}

const db = new DatabaseSync(tmp, { readOnly: true })
const rows = db.prepare(`
  SELECT host_key, name, encrypted_value FROM cookies
  WHERE host_key LIKE '%google.com%'
`).all()
db.close()
fs.rmSync(tmp, { force: true })

// 只取发往 gemini.google.com 的 cookie（.google.com 泛域 + .gemini.google.com）
const jar = new Map()
for (const r of rows) {
  const host = r.host_key.replace(/^\./, '')
  if (!('gemini.google.com'.endsWith(host) || host === 'gemini.google.com')) continue
  let v
  try { v = decrypt(r.encrypted_value) } catch { continue }
  if (v) jar.set(r.name, v)
}
console.log(`[live] 可用 cookie（gemini 域）: ${jar.size} 个`)
if (!jar.has('__Secure-1PSID')) { console.error('[live] 缺 __Secure-1PSID'); process.exit(1) }

const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'

// ── 1. 取页面，抓 SNlM0e / bl / 以及当前账号邮箱 ─────────────────────────
console.log('[live] 拉取 Gemini 页面...')
const pageRes = await fetch(`${ORIGIN}${APP_PATH}`, {
  headers: { cookie: cookieHeader, 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
  signal: AbortSignal.timeout(30000),
})
console.log(`[live] 页面: HTTP ${pageRes.status}`)
const html = await pageRes.text()
console.log(`[live] HTML ${html.length} 字节`)

const snlm0e = /"SNlM0e":"([^"]+)"/.exec(html)?.[1] ?? null
const bl = /"cfb2h":"([^"]+)"/.exec(html)?.[1] ?? /"bl":"([^"]+)"/.exec(html)?.[1] ?? null
console.log(`[live] SNlM0e: ${snlm0e ? 'OK (' + snlm0e.length + ' chars)' : 'MISSING'}`)
console.log(`[live] bl    : ${bl ?? 'MISSING'}`)

// 页面里通常带账号邮箱（列表位或 AF_initDataCallback）
const emailMatches = [...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
  .map(m => m[0])
  .filter(e => !e.includes('example') && !e.endsWith('.png') && !e.endsWith('.jpg'))
const uniqEmails = [...new Set(emailMatches)].slice(0, 8)
console.log(`[live] 页面里的邮箱: ${uniqEmails.length ? uniqEmails.join(', ') : '(未找到)'}`)

if (!snlm0e) {
  console.log('')
  console.log('[live] ✗ 拿不到 SNlM0e —— 会话可能已失效，或页面结构变了')
  process.exit(1)
}

// ── 2. 真正发一次对话请求 ──────────────────────────────────────────────────
console.log('')
console.log('[live] 发一次最小对话请求...')
const prompt = 'Reply with exactly: PONG'
const inner = JSON.stringify([null, JSON.stringify([[prompt, 0, null, null, null, null, 0]]), null, bl ?? '', snlm0e, null, null, 0])
const body = new URLSearchParams({
  'f.req': JSON.stringify([[['entertg', inner, null, 'generic']]]),
  at: snlm0e,
})

const res = await fetch(`${ORIGIN}${RPC_PATH}?bl=${encodeURIComponent(bl ?? '')}&rt=c`, {
  method: 'POST',
  headers: {
    cookie: cookieHeader,
    'user-agent': UA,
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'x-same-domain': '1',
    origin: ORIGIN,
    referer: `${ORIGIN}${APP_PATH}`,
  },
  body,
  signal: AbortSignal.timeout(90000),
})
console.log(`[live] batchexecute: HTTP ${res.status}`)
const text = await res.text()
console.log(`[live] 响应 ${text.length} 字节`)

// 提取回答文本：wrb.fr 帧里的 JSON 数组
let answer = ''
for (const m of text.matchAll(/\["wrb\.fr","[^"]+","(.*?)",null,"generic"\]/gs)) {
  try {
    const arr = JSON.parse(JSON.parse(`"${m[1]}"`))
    const s = JSON.stringify(arr)
    const hit = /"([^"]{2,200})"/g
    let mm
    while ((mm = hit.exec(s))) {
      if (/^[A-Za-z0-9 ,.!?'\-]{2,200}$/.test(mm[1]) && !mm[1].includes('wrb')) {
        answer = mm[1]
        break
      }
    }
  } catch { /* 继续找 */ }
  if (answer) break
}

console.log(`[live] 回答: ${answer ? JSON.stringify(answer) : '(未能解析)'}`)
console.log('')
if (/PONG/i.test(text)) {
  console.log('[live] ✓ 会话可用，Gemini 真的出字了')
} else if (res.status === 200) {
  console.log('[live] HTTP 200，但没在响应里看到 PONG')
  console.log('[live] 响应前 600 字符:')
  console.log(text.slice(0, 600))
} else {
  console.log('[live] ✗ 请求被拒')
  console.log(text.slice(0, 400))
}
