#!/usr/bin/env node
/**
 * bin/verify.mjs — Quick end-to-end smoke test.
 *
 * Sends a short prompt to the local bridge, prints the answer, then dumps the
 * honest per-account health view (parked accounts, cooldowns, anomaly scores).
 *
 * Usage:
 *   node bin/verify.mjs ["your prompt here"]
 */

import { loadConfig } from '../lib/config.mjs'

const config = loadConfig()
const { host, port, apiKey, model } = config.server

const prompt = process.argv[2] ?? 'Reply with exactly: BRIDGE_OK'

const url = `http://${host}:${port}/v1/chat/completions`
console.log(`[verify] → ${url}`)
console.log(`[verify]   prompt: ${prompt.slice(0, 80)}`)

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  }),
})

const h = await fetch(`http://${host}:${port}/health`).then(r => r.json()).catch(() => null)
function printHealth() {
  if (!h) return
  console.log(`[verify]   health: ${h.status}  (${h.usableAccounts}/${h.totalAccounts} accounts usable)`)
  for (const a of h.accounts ?? []) {
    const lines = [
      `  - ${a.name}: session.ready=${a.session?.ready ?? false}`
        + (a.session?.ageSeconds != null ? ` age=${a.session.ageSeconds}s` : ''),
    ]
    if (a.pausedUntil) lines.push(`      PARKED until ${a.pausedUntil} (${a.pauseReason ?? ''})`)
    if (a.guard) {
      lines.push(`      budget ${a.guard.requestsToday}/${a.guard.budgetPerDay}`
        + ` · window ${a.guard.windowSpent}/${a.guard.windowCap}`
        + ` · cooldown ${a.guard.cooldownSeconds}s`
        + ` · anomaly ${a.guard.anomalyScore}`)
    }
    console.log(lines.join('\n'))
  }
}

if (!res.ok) {
  const text = await res.text()
  console.error(`[verify] ✗ HTTP ${res.status}: ${text.slice(0, 300)}`)
  printHealth()
  process.exit(1)
}

const data = await res.json()
const answer = data.choices?.[0]?.message?.content ?? '(no content)'
console.log(`[verify] ✓ answer: ${answer.slice(0, 200)}`)
printHealth()
