#!/usr/bin/env node
/**
 * bin/serve.mjs — Start the Gemini web bridge (multi-account aware).
 *
 * Lifecycle:
 *   1. For each configured account: start its browser (own CDP port, own
 *      profile dir), load persisted credentials or verify the browser session
 *      is signed in, scrape page tokens.
 *   2. Accounts that come up signed-out are REPORTED, not fatal -- a parked
 *      account plus one live account is a working bridge; killing startup over
 *      one dead cookie throws away capacity the other account still has.
 *   3. Serve OpenAI-compatible requests; the client rotates across live
 *      accounts and parks any account that trips a hard-stop signal.
 *
 * Usage:
 *   node bin/serve.mjs
 */

import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { GeminiWebClient } from '../lib/client.mjs'
import { AgyTokenStore } from '../lib/agytoken.mjs'
import { AgyClient } from '../lib/agyclient.mjs'
import { Router } from '../lib/router.mjs'
import { createServer } from '../lib/server.mjs'

const config = loadConfig()
const { host, port } = config.server

console.log('[serve] gemini-web-bridge starting ...')

// ── web channel (Gemini page via browser profiles) ─────────────────────────
const manager = new AccountManager(config)
const webClient = new GeminiWebClient({ config, manager })

// ── agy channel (v1internal upstream, OAuth from this machine's agy login) ─
let agyClient = null
if (config.agy?.enabled !== false) {
  const tokens = new AgyTokenStore({ tokenFile: config.agy?.tokenFile })
  agyClient = new AgyClient({ config, tokens })
  // Probe the credential once at boot so /health can report honestly; a
  // missing token does NOT kill the bridge, it just means no agy models.
  try {
    await tokens.accessToken()
    console.log('[serve] ✓ agy channel: credential live, refresh pipeline ready')
  } catch (e) {
    agyClient = null
    console.warn(`[serve] agy channel disabled: ${e.message} (run the agy CLI login once, or set agy.enabled=false)`)
  }
}

const client = new Router({ config, webClient, agyClient })

// ── 1. Bring every account up ────────────────────────────────────────────
let live = 0
for (const account of manager.describeAll().map(d => manager.pickAccountByName(d.name))) {
  const label = `[serve:${account.name}]`
  try {
    await account.session.ensureBrowser()
    if (!account.session.loadPersisted()) {
      await account.session.harvest({ force: true })
    }
    await account.session.scrapePageTokens()
    live++
    console.log(`${label} ✓ live`)
  } catch (e) {
    // Signed-out here is a parking decision, not a crash: someone runs
    // bin/login.mjs for this account later and POSTs /api/account/recovered.
    console.warn(`${label} ✗ parked: ${e.message}`)
  }
}

if (live === 0 && !agyClient) {
  console.error('[serve] ✗ no channel is live: no web accounts AND no agy credential.')
  console.error('[serve]   Run `node bin/login.mjs --account <name>` or log into the agy CLI.')
  manager.stopAll()
  process.exit(1)
}
if (live === 0 && agyClient) {
  console.warn('[serve] no web accounts live; running agy-only (the web-channel budget still applies per-account when they return)')
} else {
  console.log(`[serve] ${live}/${manager.count} web accounts live`)
}

// ── 2. HTTP surface ───────────────────────────────────────────────────────
const server = createServer(config, client)
server.listen(port, host, () => {
  const names = client.models()
  console.log(`\n[serve] ✓ http://${host}:${port}`)
  console.log(`[serve]   models: ${names.join(', ')}`)
  console.log(`[serve]   /health: http://${host}:${port}/health`)
})

// ── 3. Keep-alive: refresh tokens per live account before they go stale ───
const keepAliveMs = Math.min((config.behaviour.keepAliveSeconds ?? 900) * 1000, 15 * 60 * 1000)
setInterval(async () => {
  for (const name of manager.describeAll().map(d => d.name)) {
    const account = manager.pickAccountByName(name)
    if (!account || account.pausedUntil > Date.now()) continue
    if (account.session.tokensStale()) {
      try {
        await account.session.scrapePageTokens()
        console.log(`[serve:${name}] keep-alive: page tokens refreshed`)
      } catch (e) {
        console.warn(`[serve:${name}] keep-alive failed: ${e.message}`)
      }
    }
  }
}, keepAliveMs)

// ── 4. Unpark check: an auth-parked account becomes eligible for ONE probe ─
// request after its pause expires. pick() already skips paused accounts; this
// timer just logs the transition so operators know when to re-login if needed.
setInterval(() => {
  const now = Date.now()
  for (const d of manager.describeAll()) {
    if (d.pausedUntil && new Date(d.pausedUntil).getTime() <= now) {
      console.log(`[serve:${d.name}] park window elapsed; account will be retried on next request`)
    }
  }
}, 60000).unref?.()

const shutdown = () => {
  console.log('\n[serve] shutting down ...')
  manager.stopAll()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
