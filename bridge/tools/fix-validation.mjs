#!/usr/bin/env node
/**
 * tools/fix-validation.mjs — 处理 Antigravity 的 "Verify your account to continue"
 *
 * 背景（本机实测）：
 *   账号被 Google 标记为需要验证时，三个端点的表现是分层的：
 *     loadCodeAssist      -> 200，currentTier 已授予 standard-tier，
 *                            但带 ineligibleTiers: UNSUPPORTED_LOCATION
 *     retrieveUserQuotaSummary -> 403 PERMISSION_DENIED / VALIDATION_REQUIRED
 *     streamGenerateContent    -> 403 同上
 *
 *   CLI 读 loadCodeAssist 的 ineligibleTiers 就报「地区不可用」，所以用户看到的
 *   是「地区墙」，真正的锁是 VALIDATION_REQUIRED。把 ineligibleTiers 抹掉
 *   （agy_unlock_addon.py 做的事）能让 CLI 启动，但生成端点照样 403——
 *   这一步只能人来做：打开 Google 给的 validation_url 完成账号验证。
 *
 * 用法：
 *   node tools/fix-validation.mjs <账号 id 或邮箱片段> [--open] [--watch]
 *
 *   --open  取到 URL 后用 WMI 脱离当前进程启动一个可见浏览器直接打开
 *           （宿主的作业对象会杀掉普通子进程，所以必须 WMI Create）
 *           并用该账号自己的 profile 目录，避免和别的号混指纹。
 *   --watch 保持轮询生成端点，直到验证完成（默认每 15 秒一次，最多 30 分钟）。
 *           验证一过就打印 SERVING 并退出 0，不用人工回报。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgyPool } from '../lib/agytoken.mjs'
import { loadConfig } from '../lib/config.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

const argv = process.argv.slice(2)
const want = argv.find(a => !a.startsWith('--')) ?? ''
const doOpen = argv.includes('--open')
const doWatch = argv.includes('--watch')

if (!want) {
  console.error('usage: node tools/fix-validation.mjs <account-id-or-email-fragment> [--open]')
  process.exit(1)
}

const pool = new AgyPool({ config: loadConfig() })
const accounts = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !accounts.includes(a)) accounts.push(a) }
const acct = accounts.find(a => a.id.includes(want) || (a.email ?? '').includes(want))
if (!acct) {
  console.error(`no pool account matches "${want}". Available:`)
  for (const a of accounts) console.error(`  ${a.id}  ${a.email}`)
  process.exit(1)
}

/** Park state so a stuck account is visibly parked in the dashboard. */
function report(parked) {
  const state = parked ? 'PARKED (12h, auth window)' : 'rotating normally'
  console.log(`\n[fix-validation] ${acct.id} (${acct.email}) -> ${state}`)
}

console.log(`=== ${acct.id} (${acct.email}) ===`)

let token
try {
  token = await acct.tokens.accessToken()
} catch (e) {
  console.error(`token unavailable: ${e.code ?? e.message}`)
  report(true)
  process.exit(1)
}

async function probe(pathName, body) {
  const res = await fetch(`${BASE}${pathName}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': UA,
      requesttype: 'agent',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, text, data }
}

// ── 1. 资格检查：区分「地区不可用」和「需要验证」─────────────────────────
const lca = await probe('/v1internal:loadCodeAssist', {
  metadata: { pluginType: 'GEMINI', platform: 'WINDOWS_AMD64' },
})
const tier = lca.data?.currentTier?.id ?? '(none)'
const ineligible = (lca.data?.ineligibleTiers ?? [])
  .map(t => `${t.reasonCode ?? '?'}:${t.tierId ?? '?'}`)
  .join(', ')
console.log(`loadCodeAssist: ${lca.status}  currentTier=${tier}`)
console.log(`  ineligibleTiers: ${ineligible || '(none)'}`)

// ── 2. 生成端点：这才是真正的判决 ────────────────────────────────────────
const gen = await probe('/v1internal:streamGenerateContent?alt=sse', {
  project: 'aicode-consumers',
  requestId: `req-${Date.now()}`,
  requestType: 'agent',
  model: 'gemini-3.8-flash-medium',
  request: {
    contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
    generationConfig: { maxOutputTokens: 16 },
    sessionId: `-${Date.now()}`,
  },
})
const serving = gen.status === 200 && gen.text.includes('data:')
console.log(`streamGenerateContent: ${gen.status}  ${serving ? 'SERVING' : 'BLOCKED'}`)

if (serving) {
  console.log('\n这个账号其实能用（生成端点 200）。CLI 如果还报地区锁，')
  console.log('那是 loadCodeAssist 的 ineligibleTiers 在骗它——用 agy-unlock 抹掉即可。')
  report(false)
  process.exit(0)
}

// ── 3. 解析拒绝原因，取出 Google 给的自助修复链接 ────────────────────────
const detail = (gen.data ?? lca.data)?.error?.details?.find(d => d?.metadata)
const meta = detail?.metadata ?? {}
const reason = detail?.reason ?? gen.data?.error?.status ?? 'UNKNOWN'
const validationUrl = meta.validation_url ?? null

console.log(`\n拒绝原因: ${reason}`)
console.log(`提示文案: ${meta.validation_error_message ?? gen.data?.error?.message ?? '(none)'}`)

if (!validationUrl) {
  console.log('\n上游没给 validation_url。这类情况只能人工处理：')
  console.log('  1) 用该账号登录 https://one.google.com/settings 确认订阅与账号状态')
  console.log('  2) 或直接在该账号下打开 https://antigravity.google 走一遍授权')
  report(true)
  process.exit(2)
}

console.log('\n需要人工验证（这一步无法自动化，Google 要确认是账号本人在操作）：')
console.log(validationUrl)

// 存档，方便反复取用（URL 里的 plt 会过期，重跑本脚本可换新的）
const outDir = path.join(os.homedir(), '.dsh', 'agy-unlock', 'validation-links')
try {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${acct.id}-${Date.now()}.txt`)
  fs.writeFileSync(file, `${acct.email}\n${reason}\n${validationUrl}\n`, 'utf8')
  console.log(`\n已存档: ${file}`)
} catch { /* 存档失败不影响主流程 */ }

// ── 4. --open：用 WMI 脱离宿主作业对象，拿该账号自己的 profile 打开 ──────
if (doOpen) {
  const browser = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].map(p => p.replace(/\//g, path.sep)).find(p => fs.existsSync(p))

  if (!browser) {
    console.error('没找到 Edge/Chrome，请手动把上面的 URL 贴进浏览器。')
    report(true)
    process.exit(1)
  }

  // 每个账号一个独立 profile：验证过程和别的账号绝不能混指纹，
  // 否则 Google 会把两个号关联成同一个人反复触发验证。
  const profileDir = path.join(os.homedir(), '.dsh', 'agy-unlock', 'profiles', acct.id)
  fs.mkdirSync(profileDir, { recursive: true })

  const cmd = `"${browser}" --no-first-run --no-default-browser-check --user-data-dir="${profileDir}" "${validationUrl}"`
  try {
    const r = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    console.log(`\n已启动浏览器 (PID ${r.trim()})，profile: ${profileDir}`)
    console.log('在该窗口登录这个账号并完成验证。')
  } catch (e) {
    console.error(`启动浏览器失败: ${e.message}`)
    console.error(`手动打开: ${validationUrl}`)
  }
}

if (!doWatch) {
  console.log('\n完成验证后重跑本脚本确认；加 --watch 可以自动等结果。')
  report(true)
  process.exit(0)
}

// ── 5. --watch：轮询生成端点，验证一过就报 ──────────────────────────────
// 验证是 Google 侧异步生效的，通常几秒到几分钟。轮询发的是单 token 的最小
// 生成请求，间隔放到 15 秒，避免自己制造异常流量。
console.log('\n[watch] 等待验证生效（每 15 秒探测一次，最多 30 分钟）...')
const WATCH_INTERVAL = 15_000
const WATCH_DEADLINE = Date.now() + 30 * 60_000
let lastStatus = null
for (;;) {
  if (Date.now() > WATCH_DEADLINE) {
    console.log('[watch] 超时：验证仍未生效。可能验证没走完，或需要等 Google 侧同步。')
    report(true)
    process.exit(2)
  }
  await new Promise(r => setTimeout(r, WATCH_INTERVAL))
  let fresh
  try { fresh = await acct.tokens.accessToken() } catch { continue }
  const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fresh}`,
      'content-type': 'application/json',
      'user-agent': UA,
      requesttype: 'agent',
    },
    body: JSON.stringify({
      project: 'aicode-consumers',
      requestId: `req-${Date.now()}`,
      requestType: 'agent',
      model: 'gemini-3.8-flash-medium',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
        generationConfig: { maxOutputTokens: 16 },
        sessionId: `-${Date.now()}`,
      },
    }),
    signal: AbortSignal.timeout(45000),
  }).catch(() => null)

  if (!res) continue
  const text = await res.text().catch(() => '')
  if (res.status === 200 && text.includes('data:')) {
    console.log('\n[watch] ✓ 验证已生效，账号现在 SERVING（生成端点 200）。')
    console.log(`把它从 park 里放出来：POST /api/agy/resume?id=${acct.id}`)
    report(false)
    process.exit(0)
  }
  if (res.status !== lastStatus) {
    lastStatus = res.status
    console.log(`[watch] 仍是 ${res.status}，继续等...`)
  }
}
