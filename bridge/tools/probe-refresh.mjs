// 打印 refresh 失败的上游原文（invalid_grant / invalid_client / 其它），
// 区分「refresh_token 被轮换作废」和「网络/客户端配置问题」。
// 用模块自己解析出的 OAuth client（从本机 agy 二进制提取 + 探测），
// 仓库里不存任何 client 字面量。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveOAuthClient } from '../lib/agytoken.mjs'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

const poolFile = path.join(os.homedir(), '.dsh', 'agy-accounts', 'pool.json')
const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8'))

for (const acct of pool.accounts ?? []) {
  if (acct.enabled === false) continue
  const tokenFile = acct.systemHome
    ? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    : path.join(acct.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

  console.log(`\n=== ${acct.id} (${acct.email}) ===`)
  if (!fs.existsSync(tokenFile)) { console.log('  token file missing'); continue }

  let blob
  try { blob = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) } catch (e) { console.log('  unparsable:', e.message); continue }
  const t = blob.token ?? blob
  console.log(`  access_token: ${t.access_token ? t.access_token.slice(0, 12) + '...' : '(none)'}`)
  console.log(`  refresh_token: ${t.refresh_token ? t.refresh_token.slice(0, 12) + '...' : '(none)'}`)
  console.log(`  expiry: ${t.expiry ?? '(none)'}`)
  const expMs = t.expiry ? Date.parse(t.expiry) : NaN
  console.log(`  expiry in: ${Number.isNaN(expMs) ? '?' : Math.round((expMs - Date.now()) / 60000) + ' min'}`)

  if (!t.refresh_token) continue

  // 解析 client（首次会读二进制并探测匹配，之后进程内缓存）
  let client
  try {
    client = await resolveOAuthClient({
      probe: async ({ clientId, clientSecret }) => {
        const b = new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          refresh_token: t.refresh_token, grant_type: 'refresh_token',
        })
        const r = await fetch(TOKEN_ENDPOINT, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: b, signal: AbortSignal.timeout(15000),
        })
        const j = await r.json().catch(() => ({}))
        return r.ok || (j.error !== 'invalid_client' && j.error !== 'unauthorized_client')
      },
    })
  } catch (e) {
    console.log(`  client resolve FAIL: ${e.code ?? e.message}`)
    continue
  }

  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: t.refresh_token,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  console.log(`  refresh -> HTTP ${res.status}`)
  console.log(`  ${text.slice(0, 400)}`)
}
