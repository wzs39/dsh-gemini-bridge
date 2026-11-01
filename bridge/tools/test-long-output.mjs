// 请求一个长输出，测量真实产出的字符数与结束原因。
// 目的：区分「配额/上游中断」和「我们自己的流处理截断」。
import { AgyPool } from '../lib/agytoken.mjs'
import { AgyClient } from '../lib/agyclient.mjs'
import { loadConfig } from '../lib/config.mjs'

const config = loadConfig()
const pool = new AgyPool({ config })
const client = new AgyClient({ config, tokens: null, pool })

const prompt = process.argv[2] ??
  'Count from 1 to 200, one number per line, no other text.'

const t0 = Date.now()
let text = ''
let chunks = 0
let finishReason = null
let usage = null
const account = pool.pick()

try {
  for await (const e of client.complete({
    model: 'gemini-3.8-flash-medium',
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  })) {
    if (e.delta?.content) { text += e.delta.content; chunks++ }
    if (e.finishReason) finishReason = e.finishReason
    if (e.usage) usage = e.usage
  }
} catch (e) {
  console.log(`ERROR after ${Date.now() - t0}ms: ${e.name}: ${e.message.slice(0, 300)}`)
  console.log(`partial text len=${text.length}`)
  process.exit(1)
}

const ms = Date.now() - t0
const lines = text.trim().split('\n')
console.log(`account      : ${account?.id}`)
console.log(`elapsed      : ${ms}ms`)
console.log(`chunks       : ${chunks}`)
console.log(`text length  : ${text.length} chars`)
console.log(`lines        : ${lines.length}`)
console.log(`finishReason : ${finishReason}`)
console.log(`usage        : ${JSON.stringify(usage)}`)
console.log(`first line   : ${JSON.stringify(lines[0]?.slice(0, 60))}`)
console.log(`last line    : ${JSON.stringify(lines[lines.length - 1]?.slice(0, 60))}`)
console.log('')
console.log(text.length > 300 ? 'text head: ' + text.slice(0, 150).replace(/\n/g, ' | ') : text)
console.log('text tail: ' + text.slice(-150).replace(/\n/g, ' | '))
