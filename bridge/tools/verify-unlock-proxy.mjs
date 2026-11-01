// 通过 HTTP CONNECT 隧道请求 loadCodeAssist，验证 addon 是否抹掉了
// ineligibleTiers。用 node:https 自己建隧道，不依赖 undici —— 项目零依赖，
// 也不想为一个验证脚本引入包。
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const HOST = 'daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'
const PROXY_HOST = '127.0.0.1'
const PROXY_PORT = 8899

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }

let target = null
for (const acct of accounts) {
  let token
  try { token = await acct.tokens.accessToken() } catch { continue }
  const res = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA, requesttype: 'agent' },
    body: JSON.stringify({ metadata: { pluginType: 'GEMINI', platform: 'WINDOWS_AMD64' } }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (text.includes('UNSUPPORTED_LOCATION')) { target = { acct, token }; break }
}
if (!target) { console.log('[check] 没有带 UNSUPPORTED_LOCATION 的账号'); process.exit(0) }
console.log(`[check] 受限账号: ${target.acct.email}`)

const body = JSON.stringify({ metadata: { pluginType: 'GEMINI', platform: 'WINDOWS_AMD64' } })

// ── 直连 ───────────────────────────────────────────────────────────────────
function direct() {
  return new Promise((resolve) => {
    const req = https.request({
      host: HOST, port: 443, path: '/v1internal:loadCodeAssist', method: 'POST',
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': UA,
        requesttype: 'agent',
      },
    }, (res) => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ status: res.statusCode, text: d }))
    })
    req.on('error', e => resolve({ status: 0, text: 'ERR ' + e.message }))
    req.setTimeout(40000, () => { req.destroy(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

// ── 经 CONNECT 隧道 ────────────────────────────────────────────────────────
function viaProxy() {
  return new Promise((resolve) => {
    const connectReq = require_http().request({
      host: PROXY_HOST, port: PROXY_PORT,
      method: 'CONNECT',
      path: `${HOST}:443`,
      headers: { host: `${HOST}:443` },
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve({ status: 0, text: `CONNECT failed ${res.statusCode}` })
      // mitmproxy 用自签 CA 重签目标证书，需要信任 ~/.mitmproxy 的 CA
      const caPath = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem')
      const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined
      const tlsSocket = tls.connect({ socket, servername: HOST, ca }, () => {
        // 用 tlsSocket.write 手写 HTTP 报文：node:https 的 createConnection
        // 会把 transfer-encoding 和 content-length 同时写出来，mitmproxy 直接
        // 拒（Parse Error: Content-Length can't be present with Transfer-Encoding）。
        const reqLines = [
          'POST /v1internal:loadCodeAssist HTTP/1.1',
          `Host: ${HOST}`,
          `authorization: Bearer ${target.token}`,
          'content-type: application/json',
          `content-length: ${Buffer.byteLength(body)}`,
          `user-agent: ${UA}`,
          'requesttype: agent',
          'connection: close',
          '',
          body,
        ].join('\r\n')
        tlsSocket.write(reqLines)

        let raw = ''
        tlsSocket.on('data', c => { raw += c.toString('utf8') })
        tlsSocket.on('end', () => {
          const idx = raw.indexOf('\r\n\r\n')
          if (idx < 0) return resolve({ status: 0, text: 'NO_HEADERS' })
          const head = raw.slice(0, idx)
          const status = Number(/HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0)
          const payload = raw.slice(idx + 4)
          resolve({ status, text: payload })
        })
        tlsSocket.on('close', () => {
          if (raw) {
            const idx = raw.indexOf('\r\n\r\n')
            if (idx >= 0) {
              const head = raw.slice(0, idx)
              const status = Number(/HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0)
              if (status) resolve({ status, text: raw.slice(idx + 4) })
            }
          }
        })
      })
      tlsSocket.on('error', e => resolve({ status: 0, text: 'TLS ' + e.message }))
    })
    connectReq.on('error', e => resolve({ status: 0, text: 'PROXY ' + e.message }))
    connectReq.end()
  })
}

// node:http 的 require 在 ESM 里不可用，用 import 提前拿
let _http = null
function require_http() { return _http }
const httpMod = await import('node:http')
_http = httpMod.default

function summarize(label, r) {
  let j = null
  try { j = JSON.parse(r.text) } catch { /* */ }
  const inel = j?.ineligibleTiers
  console.log(`\n${label}:`)
  console.log(`  HTTP ${r.status}`)
  if (r.status === 0) { console.log('  ' + r.text); return }
  console.log(`  ineligibleTiers: ${inel ? JSON.stringify(inel.map(t => t.reasonCode)) : '(无)'}`)
  console.log(`  currentTier    : ${j?.currentTier?.id ?? '(none)'}`)
  return inel?.length ?? 0
}

const d = await direct()
const nDirect = summarize('[check] 直连', d)

const p = await viaProxy()
const nProxied = summarize('[check] 经 8899 代理', p)

console.log('\n=== 结论 ===')
if (nDirect && nProxied === 0) console.log('✓ addon 生效：代理抹掉了 ineligibleTiers')
else if (!nDirect) console.log('- 直连本来就没有 ineligibleTiers')
else if (p.status === 0) console.log('✗ 代理链路不通（CA 或端口问题）')
else console.log('✗ addon 没生效')
