// Full three-account rotation exercise: confirm traffic actually lands on all
// three identities, survives a park, and recovers — against real upstream.
import { AgyPool } from '../lib/agytoken.mjs'
import { AgyClient } from '../lib/agyclient.mjs'
import { loadConfig } from '../lib/config.mjs'

const config = loadConfig()
const pool = new AgyPool({ config })
const client = new AgyClient({ config, tokens: null, pool })

const all = []
for (let i = 0; i < pool.count; i++) { const a = pool.pick(); if (a && !all.includes(a)) all.push(a) }
console.log(`pool = ${pool.count} account(s)`)
for (const a of all) console.log(`  ${a.id}  ${a.email}`)

const hits = new Map()

async function turn(label) {
  const picked = pool.pick()
  const t0 = Date.now()
  let text = ''
  try {
    for await (const e of client.complete({
      model: 'gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      stream: false,
    })) text += e?.delta?.content ?? ''
    const ok = text.trim() === 'PONG'
    hits.set(picked.id, (hits.get(picked.id) ?? 0) + (ok ? 1 : 0))
    console.log(`${label.padEnd(22)} ${(picked.id).padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${ok ? 'PONG' : JSON.stringify(text.trim())}`)
  } catch (e) {
    console.log(`${label.padEnd(22)} ${String(picked?.id).padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ERROR ${e.message.slice(0, 80)}`)
  }
}

console.log('\n--- sticky behaviour (3 turns) ---')
for (let i = 1; i <= 3; i++) await turn(`sticky-${i}`)

console.log('\n--- force rotation through every account ---')
for (const acct of all) {
  for (const other of all) if (other !== acct) pool.pause(other, 120_000, 'rotation-drill')
  await turn(`only-${acct.id.slice(-8)}`)
  for (const other of all) if (other !== acct) pool.resume(other.id)
}

console.log('\n--- resume all, back to sticky ---')
for (const a of all) pool.resume(a.id)
await turn('after-resume')

console.log('\nper-account successful turns:')
for (const a of all) console.log(`  ${a.id.padEnd(32)} ${hits.get(a.id) ?? 0}`)
const served = [...hits.values()].filter(v => v > 0).length
console.log(`\naccounts that actually served: ${served}/${pool.count}`)
if (served < pool.count) {
  console.log('WARN: some accounts never served')
  process.exitCode = 1
}
