// 实测 agy 模型目录：逐个打，记录 404 / 429 / 可用。
// 404 = 这个模型 ID 上游根本没有（目录写错了）；429 = 有但配额耗尽。
// 两者性质完全不同：404 要从 AGY_MODELS 里删掉，否则用户点了必然报错。
import { loadConfig } from '../lib/config.mjs'
import { AgyPool, AgyTokenStore } from '../lib/agytoken.mjs'
import { AgyClient, AGY_MODELS } from '../lib/agyclient.mjs'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const config = loadConfig()
const pool = new AgyPool({ config })
let client
if (pool.count > 0) {
  client = new AgyClient({ config, pool })
  log(`pool: ${pool.count} 个账号`)
} else {
  const tokens = new AgyTokenStore({ tokenFile: config.agy?.tokenFile })
  client = new AgyClient({ config, tokens })
  log('single token store')
}

const ok = [], notfound = [], other = []
for (const model of AGY_MODELS) {
  const t0 = Date.now()
  let r = null, err = null
  try {
    const events = client.complete({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] })
    for await (const ev of events) {
      const d = ev?.delta?.content
      if (d) r = (r ?? '') + d
    }
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t0
  if (err) {
    const msg = String(err.message ?? err)
    if (/NOT_FOUND|404/.test(msg)) { notfound.push(model); log(`404 ${model} (${ms}ms)`) }
    else { other.push({ model, msg }); log(`ERR ${model} (${ms}ms): ${msg.slice(0, 110)}`) }
  } else {
    ok.push(model)
    log(`OK  ${model} (${ms}ms) ${JSON.stringify((r ?? '').slice(0, 30))}`)
  }
}

log(`\n=== 汇总 ===`)
log(`可用 ${ok.length}: ${ok.join(', ')}`)
log(`404（目录里不存在，需删除）${notfound.length}: ${notfound.join(', ')}`)
log(`其它错误 ${other.length}`)
for (const o of other) log(`  ${o.model}: ${o.msg.slice(0, 160)}`)
process.exit(0)
