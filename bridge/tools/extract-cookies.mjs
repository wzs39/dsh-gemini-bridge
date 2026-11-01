// 从 Edge/Chrome 的 Cookies SQLite 里读出 Gemini 会话 cookie。
//
// Windows 上 Chromium 用 DPAPI 加密 v10/v11 前缀的值，密钥在 Local State 的
// os_crypt.encrypted_key（同样是 DPAPI 保护的 base64）。直接读 SQLite 字节是
// 拿不到明文的，所以这里：
//   1. 用 node:sqlite 读 host_key/name/encrypted_value
//   2. 用 PowerShell 的 ProtectedData 解 os_crypt.encrypted_key 拿 AES 密钥
//   3. AES-256-GCM 解每个 cookie（v10/v11 格式：3 字节前缀 + 12 字节 nonce + 密文 + 16 字节 tag）
//
// 只输出 cookie 的名字和长度，不打印 Cookie 头本身 —— 这份输出会进终端日志。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'

const BROWSERS = [
  { name: 'Edge', ud: path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data') },
  { name: 'Chrome', ud: path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data') },
]

const target = BROWSERS.find(b => fs.existsSync(path.join(b.ud, 'Default', 'Network', 'Cookies')))
if (!target) {
  console.error('[cookies] 找不到 Edge/Chrome 的 Cookies 数据库')
  process.exit(1)
}
console.log(`[cookies] browser: ${target.name}`)
console.log(`[cookies] user data: ${target.ud}`)

// ── DPAPI 解出 AES 主密钥 ──────────────────────────────────────────────────
function dpapiUnprotect(base64Blob) {
  // -EncodedCommand 避免所有引号/转义问题
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$b = [Convert]::FromBase64String($env:DPAPI_BLOB)',
    '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, "CurrentUser")',
    '[Convert]::ToBase64String($p)',
  ].join('; ')
  const enc = Buffer.from(ps, 'utf16le').toString('base64')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DPAPI_BLOB: base64Blob },
    timeout: 20000,
  })
  return Buffer.from(out.trim(), 'base64')
}

function aesKey(userDataDir) {
  const lsFile = path.join(userDataDir, 'Local State')
  const ls = JSON.parse(fs.readFileSync(lsFile, 'utf8'))
  const encKeyB64 = ls?.os_crypt?.encrypted_key
  if (!encKeyB64) throw new Error('Local State 没有 os_crypt.encrypted_key')
  const raw = Buffer.from(encKeyB64, 'base64')
  // 前缀 "DPAPI" 占 5 字节
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('os_crypt 前缀不是 DPAPI')
  return dpapiUnprotect(raw.subarray(5).toString('base64'))
}

function decryptCookie(encValue, key) {
  if (!encValue || encValue.length === 0) return ''
  const prefix = encValue.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 未加密的旧格式
    return encValue.toString('utf8')
  }
  const nonce = encValue.subarray(3, 15)
  const payload = encValue.subarray(15)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(0, payload.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8')
}

// ── 读 SQLite ──────────────────────────────────────────────────────────────
let DatabaseSync
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch {
  console.error('[cookies] 当前 Node 没有 node:sqlite（需要 Node 22.5+）')
  process.exit(1)
}

const cookiesFile = path.join(target.ud, 'Default', 'Network', 'Cookies')
const tmp = path.join(os.tmpdir(), `cookies-snapshot-${Date.now()}.db`)
fs.copyFileSync(cookiesFile, tmp)

let key
try {
  key = aesKey(target.ud)
  console.log(`[cookies] AES key: ${key.length} bytes`)
} catch (e) {
  console.error('[cookies] 解密钥失败:', e.message)
  process.exit(1)
}

const db = new DatabaseSync(tmp, { readOnly: true })
// 注意：不要 SELECT expires_utc —— Chromium 的 1601 纪元微秒数超出 JS 安全
// 整数范围，node:sqlite 按 number 返回会抛
// RangeError: Value is too large to be represented as a JavaScript number。
const rows = db.prepare(`
  SELECT host_key, name, encrypted_value, is_secure, is_httponly
  FROM cookies
  WHERE host_key LIKE '%google.com%'
  ORDER BY host_key, name
`).all()
db.close()
fs.rmSync(tmp, { force: true })

console.log(`[cookies] google 域 cookie 行数: ${rows.length}`)
console.log('')

const IMPORTANT = new Set([
  '__Secure-1PSID', '__Secure-1PSIDTS', '__Secure-3PSID', '__Secure-3PSIDTS',
  'SID', 'HSID', 'SSID', 'SAPISID', 'APISID', 'NID',
])

const found = []
for (const r of rows) {
  let value = ''
  try { value = decryptCookie(r.encrypted_value, key) } catch { value = '<decrypt-failed>' }
  const mark = IMPORTANT.has(r.name) ? ' *' : ''
  const len = value && value !== '<decrypt-failed>' ? value.length : 0
  if (IMPORTANT.has(r.name)) {
    found.push({ host: r.host_key, name: r.name, len, ok: len > 0 })
  }
  console.log(`  ${r.host_key.padEnd(28)} ${r.name.padEnd(22)} len=${String(len).padStart(4)}${mark}`)
}

console.log('')
console.log('=== 关键会话 cookie 汇总 ===')
for (const f of found) {
  console.log(`  ${f.name.padEnd(22)} ${f.ok ? 'OK len=' + f.len : 'MISSING/FAILED'}`)
}
const hasPSID = found.some(f => f.name === '__Secure-1PSID' && f.ok)
console.log('')
console.log(hasPSID
  ? '[cookies] ✓ 有可用 Gemini 会话（__Secure-1PSID 明文可解）'
  : '[cookies] ✗ 没有 __Secure-1PSID，该 profile 未登录 Gemini 或 cookie 不可解')
