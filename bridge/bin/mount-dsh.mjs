/**
 * Mount the Gemini web bridge into DSH as an OpenAI-compatible provider.
 *
 * Same trick as deepseek-web-bridge/bin/mount-dsh.mjs: mint the harness's
 * signed browser-session cookie locally (HMAC with the secret already in
 * .credentials.yaml) and POST through the plugin's own /providers route, so
 * the durable settings file AND the live catalog both update without a restart.
 *
 * Pick a provider row whose baseUrl is overridable and whose auth kind carries
 * a Bearer key. Use --provider=<id> to choose; --show lists the current rows.
 * WARNING: saving a provider row overwrites that row -- do not point this at
 * the same row the deepseek bridge already owns.
 *
 * Usage:
 *   node bin/mount-dsh.mjs [--provider=<id>] [--model=gemini-web] [--show] [--remove]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const CREDENTIALS = path.join(DSH_HOME, '.credentials.yaml')
const AUTH_RECORD = 'client-connection/browser-session'
const COOKIE_PREFIX = 'dsh-auth-'

const REGISTRY = '/api/our-free-model/providers'

function flag(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function readSecret() {
  const yaml = fs.readFileSync(CREDENTIALS, 'utf8')
  const lines = yaml.split(/\r?\n/u)
  const at = lines.findIndex(line => line.trim() === `${AUTH_RECORD}:`)
  if (at === -1) throw new Error(`${AUTH_RECORD} is absent from ${CREDENTIALS}`)
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s{0,2}\S/u.test(line) && !line.startsWith(' ')) break
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(line)
    if (match === null) continue
    const bytes = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    if (bytes.byteLength !== 32) throw new Error(`browser-session secret is ${bytes.byteLength} bytes, expected 32`)
    return bytes
  }
  throw new Error(`${AUTH_RECORD} carries no secret field`)
}

function mintCookie({ secret, authority, maxAgeDays = 30 }) {
  const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  return { name, value: `v1.${body}.${signature}` }
}

function targetBase() {
  const fromFlag = process.argv.find(a => a.startsWith('--base='))
  if (fromFlag !== undefined) return new URL(fromFlag.slice('--base='.length))
  if (process.env.DSH_WEB_URL) return new URL(process.env.DSH_WEB_URL)
  // DSH's own web GUI default port.
  return new URL('http://127.0.0.1:6626')
}

async function api(base, cookie, method, routePath, body) {
  const headers = { cookie: `${cookie.name}=${cookie.value}`, accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(new URL(routePath, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = text }
  return { status: response.status, payload }
}

const base = targetBase()
const cookie = mintCookie({ secret: readSecret(), authority: base.host })

if (process.argv.includes('--show')) {
  console.log(JSON.stringify(await api(base, cookie, 'GET', REGISTRY), null, 2))
  process.exit(0)
}

const PROVIDER_ID = flag('provider', 'gemini')
const MODEL_ID = flag('model', 'gemini-web')

if (process.argv.includes('--remove')) {
  const result = await api(base, cookie, 'POST', `${REGISTRY}/remove`, { providerId: PROVIDER_ID })
  console.log(`remove ${PROVIDER_ID}: ${result.status}`)
  process.exit(result.status === 200 ? 0 : 1)
}

const bridge = process.env.BRIDGE_URL ?? 'http://127.0.0.1:18901/v1'
const saved = await api(base, cookie, 'POST', REGISTRY, {
  providerId: PROVIDER_ID,
  enabled: true,
  baseUrl: bridge,
  apiKey: process.env.BRIDGE_KEY ?? 'sk-local-gemini-web',
  models: [MODEL_ID],
})
console.log(`save ${PROVIDER_ID} -> ${bridge}: ${saved.status}`)
console.log(JSON.stringify(saved.payload, null, 2))
if (saved.status !== 200) process.exit(1)

// A saved row that never answers is worse than no row: prove the bridge is
// reachable through the route the harness will actually use.
const tested = await api(base, cookie, 'POST', `${REGISTRY}/test`, { providerId: PROVIDER_ID })
console.log(`test ${PROVIDER_ID}: ${tested.status}`)
console.log(JSON.stringify(tested.payload, null, 2))

console.log(`\nmodel id in the picker: ${PROVIDER_ID}/${MODEL_ID}`)
process.exit(0)
