// Prove the pool rotates onto the second working account when the first is
// parked, and that it comes back. Uses the real client against real upstream.
import { AgyPool } from '../lib/agytoken.mjs'
import { AgyClient } from '../lib/agyclient.mjs'
import { loadConfig } from '../lib/config.mjs'

const config = loadConfig()
const pool = new AgyPool({ config })
const client = new AgyClient({ config, tokens: null, pool })

// Pull out the two working accounts by identity so we can park one deliberately.
const all = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !all.includes(a)) all.push(a) }
const kalao = all.find(a => a.id.includes('kalao'))
const asabv = all.find(a => a.id.includes('asabv'))
console.log(`pool=${pool.count} kalao=${Boolean(kalao)} asabv=${Boolean(asabv)}\n`)

async function turn(label) {
  const picked = pool.pick()
  let text = ''
  const t0 = Date.now()
  try {
    for await (const e of client.complete({
      model: 'gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      stream: false,
    })) text += e?.delta?.content ?? ''
    console.log(`${label}  picked=${picked?.id ?? '?'}  ${Date.now() - t0}ms  reply=${JSON.stringify(text.trim())}`)
    return text.trim()
  } catch (e) {
    console.log(`${label}  picked=${picked?.id ?? '?'}  ${Date.now() - t0}ms  ERROR ${e.message.slice(0, 100)}`)
    return null
  }
}

console.log('--- 1. normal (sticky) ---')
await turn('turn-1')
await turn('turn-2')

if (kalao && asabv) {
  console.log('\n--- 2. park kalao, traffic must move to asabv ---')
  pool.pause(kalao, 60_000, 'rotation-test')
  await turn('turn-3')
  await turn('turn-4')

  console.log('\n--- 3. resume kalao ---')
  pool.resume(kalao.id)
  await turn('turn-5')
}

console.log('\nfinal park state:')
for (const a of pool.describeAll()) console.log(`  ${a.id} parked=${a.pausedUntil ?? 'no'}`)
