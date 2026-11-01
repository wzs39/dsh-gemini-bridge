// Live agy round-trip smoke test: proves the pool actually serves traffic and
// rotates across accounts. Prints which account answered each turn.
import { AgyPool } from '../lib/agytoken.mjs'
import { AgyClient } from '../lib/agyclient.mjs'
import { loadConfig } from '../lib/config.mjs'

const config = loadConfig()
const pool = new AgyPool({ config })
console.log(`[smoke] pool accounts = ${pool.count}`)
for (const a of pool.describeAll()) console.log(`  - ${a.id} ${a.email} loaded=${a.token.loaded}`)

const client = new AgyClient({ config, tokens: null, pool })

const seen = []
const prompts = [
  'Reply with exactly: ALPHA',
  'Reply with exactly: BRAVO',
  'Reply with exactly: CHARLIE',
  'Reply with exactly: DELTA',
]

for (const [i, prompt] of prompts.entries()) {
  const picked = pool.pick()
  const t0 = Date.now()
  try {
    let text = ''
    for await (const evt of client.complete({
      model: 'gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    })) {
      // complete() yields raw { delta, finishReason?, usage?, done } — NOT an
      // OpenAI envelope (the server layer does that shaping downstream).
      text += evt?.delta?.content ?? ''
    }
    const ms = Date.now() - t0
    const reply = text.trim().slice(0, 60)
    seen.push(`${i + 1}. acct=${picked?.id ?? '?'} ${ms}ms reply=${JSON.stringify(reply)}`)
    console.log(seen.at(-1))
  } catch (e) {
    const ms = Date.now() - t0
    console.log(`${i + 1}. acct=${picked?.id ?? '?'} ${ms}ms ERROR ${e.name}: ${e.message.slice(0, 160)}`)
  }
}

console.log('\n[smoke] park/pause state after run:')
for (const a of pool.describeAll()) {
  console.log(`  ${a.id} parked=${a.pausedUntil ?? 'no'} ${a.pauseReason ?? ''}`)
}
