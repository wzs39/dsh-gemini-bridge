// 从本机 agy 二进制提取 OAuth client 候选，逐个与真实 refresh_token 试配，
// 找出真正生效的组合。仓库里不存任何 client 字面量（GitHub 密钥扫描会拦，
// 而且硬编码的凭据在 Google 轮换后就静默失效）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveOAuthClient } from '../lib/agytoken.mjs'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const RE_ID = /([0-9]{6,})-[a-z0-9]{8,}\.apps\.googleusercontent\.com/g
const RE_SECRET = /GOCSPX-[A-Za-z0-9_-]{20,}/g

// 用池里任一账号的真实 refresh_token 做测试
const poolFile = path.join(os.homedir(), '.dsh', 'agy-accounts', 'pool.json')
const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'))
const acct = (pool.accounts ?? []).find(a => a.enabled !== false && a.dir)
if (!acct) { console.error('no usable pool account'); process.exit(1) }

const tokenFile = path.join(acct.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const blob = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
const refreshToken = (blob.token ?? blob).refresh_token
console.log(`[probe] test account : ${acct.email}`)
console.log(`[probe] refresh_token: ${refreshToken.slice(0, 16)}...`)
console.log('')

// 提取候选
const bin = path.join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')
if (!fs.existsSync(bin)) { console.error(`agy binary not found: ${bin}`); process.exit(1) }
const text = fs.readFileSync(bin).toString('latin1')
const ids = [...new Set([...text.matchAll(RE_ID)].map(m => m[0]))]
const secrets = [...new Set([...text.matchAll(RE_SECRET)].map(m => m[0]))]
console.log(`[probe] candidates: ${ids.length} client_id(s) x ${secrets.length} secret(s)`)
console.log('')

const accepted = []
for (const clientId of ids) {
  for (const clientSecret of secrets) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      })
      const j = await res.json().catch(() => ({}))
      const tag = `${clientId.split('-')[0]}/${clientSecret.slice(0, 12)}…`
      if (res.ok) {
        console.log(`OK      ${tag}  (access_token issued)`)
        accepted.push({ clientId, clientSecret, granted: true })
      } else if (j.error === 'invalid_grant') {
        // 客户端有效，只是这个 refresh_token 已失效——仍然是可用组合
        console.log(`VALID   ${tag}  (invalid_grant: client accepted, token dead)`)
        accepted.push({ clientId, clientSecret, granted: false })
      } else {
        console.log(`${res.status}   ${tag}  ${j.error ?? ''}`)
      }
    } catch (e) {
      console.log(`ERR     ${clientId.split('-')[0]}  ${e.message.slice(0, 40)}`)
    }
  }
}

console.log('')
if (accepted.length === 0) {
  console.log('[probe] ✗ 没有可用组合。agy CLI 可能更新了 client，需要重新提取。')
  process.exit(1)
}
const best = accepted.find(a => a.granted) ?? accepted[0]
console.log(`[probe] ✓ 可用组合（${accepted.length} 个候选通过）：`)
console.log(`  client_id     = ${best.clientId}`)
console.log(`  client_secret = ${best.clientSecret}`)
console.log('')
console.log('[probe] 模块会自己提取并探测，通常不需要手工设置。')
console.log('[probe] 如需显式覆盖：set AGY_OAUTH_CLIENT_ID=...  set AGY_OAUTH_CLIENT_SECRET=...')
