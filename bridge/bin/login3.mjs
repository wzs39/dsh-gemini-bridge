#!/usr/bin/env node
/**
 * bin/login3.mjs — sign in all configured web accounts without Enter-prompt
 * hand-holding: launch every account's visible browser, then poll each one's
 * cookie jar over CDP. As soon as an account carries a valid
 * __Secure-1PSID, harvest it + scrape page tokens, and close its window.
 *
 * Usage:  node bin/login3.mjs [--timeout=600]
 * Exits 0 when ALL accounts are harvested; exits 1 with a list otherwise.
 */

import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { launchBrowser, waitForDevTools, attachFirstPage, sleep } from '../lib/cdp.mjs'

const config = loadConfig()
const manager = new AccountManager(config)
const accounts = manager.describeAll().map(a => manager.pickAccountByName(a.name)).filter(Boolean)

if (accounts.length === 0) {
  console.error('[login3] no accounts in config.json')
  process.exit(1)
}

const timeoutMs = (() => {
  const f = process.argv.find(a => a.startsWith('--timeout='))
  return (f ? Number(f.slice(10)) : 600) * 1000
})()

console.log(`[login3] ${accounts.length} account(s): ${accounts.map(a => a.name).join(', ')}`)

// 1. Ensure one visible browser per account (own port + own profile dir).
const children = []
for (const account of accounts) {
  const { port, executable, userDataDir, args } = account.config.browser
  const live = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1000),
  }).then(r => r.ok).catch(() => false)
  if (live) {
    console.log(`[login3:${account.name}] reusing browser already on port ${port}`)
    continue
  }
  if (!executable) {
    console.error(`[login3:${account.name}] browser.executable not set in config.json — cannot launch`)
    process.exit(1)
  }
  const child = launchBrowser({ executable, userDataDir, port, headless: false, extraArgs: [...(args ?? []), '--new-window'] })
  children.push({ name: account.name, child })
  await waitForDevTools(port, 30000)
  const page = await attachFirstPage(port)
  try {
    await page.send('Page.navigate', { url: `${config.upstream.origin}${config.upstream.appPath}` })
  } finally {
    page.close()
  }
  console.log(`[login3:${account.name}] window opened (port ${port}, profile ${userDataDir.split(/[\\/]/).pop()}). Sign in there.`)
}

// 2. Poll each pending account until it has real Gemini session cookies.
const hostname = new URL(config.upstream.origin).hostname
const pending = new Map(accounts.map(a => [a.name, a]))
const done = new Map()
const deadline = Date.now() + timeoutMs

async function hasSession(port) {
  try {
    const page = await attachFirstPage(port)
    try {
      const { cookies } = await page.send('Network.getAllCookies')
      const rel = cookies.filter(c => {
        const h = c.domain.replace(/^\./, '')
        return hostname.endsWith(h) || h.endsWith(hostname)
      })
      return rel.some(c => c.name === '__Secure-1PSID')
    } finally {
      page.close()
    }
  } catch {
    return false
  }
}

console.log('[login3] waiting for sign-ins (a window closes automatically once its account is captured)...')
while (pending.size > 0 && Date.now() < deadline) {
  for (const [name, account] of [...pending]) {
    if (!(await hasSession(account.config.browser.port))) continue
    try {
      const creds = await account.session.harvest({ force: true })
      await account.session.scrapePageTokens()
      done.set(name, creds.cookieNames.length)
      console.log(`[login3:${name}] ✓ harvested (${creds.cookieNames.length} cookies) — window may now close`)
      // Close this account's window so the next sign-in gets full attention.
      try {
        const page = await attachFirstPage(account.config.browser.port)
        await page.send('Browser.close').catch(() => {})
        page.close()
      } catch { /* window already gone */ }
      const entry = children.find(c => c.name === name)
      if (entry) { try { entry.child.kill() } catch { /* dead */ } }
    } catch (e) {
      console.error(`[login3:${name}] harvest failed: ${e.message} — will retry`)
      await sleep(3000)
      continue
    }
    pending.delete(name)
  }
  if (pending.size > 0) await sleep(2500)
}

manager.stopAll()
for (const { child } of children) { try { child.kill() } catch { /* dead */ } }

if (pending.size > 0) {
  console.error(`[login3] INCOMPLETE — still unsigned: ${[...pending.keys()].join(', ')}`)
  console.error('[login3] rerun `node bin/login3.mjs` (signed ones are already captured and will be skipped)')
  process.exit(1)
}
console.log(`[login3] ALL ${done.size} account(s) captured. serve: node bin/serve.mjs`)
