#!/usr/bin/env node
/**
 * bin/login.mjs — One-time Google sign-in helper (per account).
 *
 * Opens a visible Chromium on THAT ACCOUNT's profile and CDP port at
 * gemini.google.com. You sign in manually, then press Enter. The bridge reads
 * cookies via CDP into that account's state file.
 *
 * For multi-account setups, each --account uses a separate profile dir, which
 * is exactly what keeps two Google identities from merging into one browser
 * fingerprint (shared profile across accounts = account-farm signal).
 *
 * Usage:
 *   node bin/login.mjs [--account <name>]
 */

import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'

const argv = process.argv.slice(2)
const accountFlag = argv.find(a => a.startsWith('--account='))
  ?? (argv.includes('--account') ? `--account=${argv[argv.indexOf('--account') + 1]}` : undefined)

const config = loadConfig()
const manager = new AccountManager(config)

const wanted = accountFlag ? accountFlag.slice('--account='.length) : null
const account = wanted
  ? manager.pickAccountByName(wanted)
  : manager.pickAccountByName(manager.describeAll()[0]?.name)

if (!account) {
  console.error(`[login] unknown account "${wanted}". Names: ${manager.describeAll().map(a => a.name).join(', ')}`)
  console.error('[login] add it to config.json under "accounts": [...] and retry.')
  process.exit(1)
}

const { port, executable, headless, args, userDataDir } = account.config.browser
const origin = config.upstream.origin

console.log(`\n[login:${account.name}] profile=${userDataDir}`)
console.log(`[login:${account.name}] opening ${origin} on CDP port ${port} ...`)

let child
const live = await fetch(`http://127.0.0.1:${port}/json/version`, {
  signal: AbortSignal.timeout(1000),
}).then(r => r.ok).catch(() => false)

if (live) {
  console.log(`[login:${account.name}] reusing browser already on port ${port}`)
} else {
  if (!executable) {
    console.error('[login] ERROR: browser.executable is not set in config.json.')
    console.error('[login] e.g. "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"')
    process.exit(1)
  }
  // Force a VISIBLE window for this helper regardless of the headless default:
  // a human has to complete the Google login.
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    `--user-data-dir=${userDataDir}`,
  ]
  for (const a of (args ?? [])) launchArgs.push(a)
  child = spawn(executable, launchArgs, { detached: false, stdio: 'ignore' })
  await (await import('../lib/cdp.mjs')).waitForDevTools(port, 30000)
  console.log(`[login:${account.name}] browser started (visible).`)
}

console.log(`\n[login:${account.name}] Sign in as the ${account.label} account in the browser window.`)
console.log(`[login:${account.name}] When the Gemini chat interface is visible, press Enter here.`)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
await new Promise(resolve => rl.question('', resolve))
rl.close()

try {
  const creds = await account.session.harvest({ force: true })
  console.log(`[login:${account.name}] ✓ cookies harvested:`, creds.cookieNames.join(', '))
  await account.session.scrapePageTokens()
  console.log(`[login:${account.name}] ✓ SNlM0e scraped; state written.`)

  // If the bridge is already running, tell it this account is usable again.
  const bridge = `http://${config.server.host}:${config.server.port}`
  try {
    const r = await fetch(`${bridge}/api/account/recovered?account=${account.name}`, { method: 'POST' })
    if (r.ok) console.log(`[login:${account.name}] ✓ running bridge unparked this account`)
  } catch { /* bridge not up yet; fine. */ }

  console.log(`[login:${account.name}] Done. (serve: node bin/serve.mjs)`)
} catch (e) {
  console.error(`[login:${account.name}] ✗`, e.message)
  process.exit(1)
} finally {
  if (child) child.kill()
  manager.stopAll()
}
