// 定位 fetch 卡在哪一层：同源 GET / 同源 POST / StreamGenerate 三步分开测。
import { attachFirstPage, evaluate } from '../lib/cdp.mjs'

const OUT = '../runs/fetch-probe.log'
const fs = await import('node:fs')
try { fs.writeFileSync(OUT, '') } catch { /* ignore */ }
const log = (...a) => {
  const line = a.join(' ') + '\n'
  process.stdout.write(line)
  try { fs.appendFileSync(OUT, line) } catch { /* ignore */ }
}
const race = (p, ms, label) => Promise.race([
  p, new Promise((_, r) => setTimeout(() => r(new Error(label + ' TIMEOUT')), ms)),
])

const page = await attachFirstPage(9334, { preferOrigin: 'https://gemini.google.com' })
log('attached')

// 1) 同源 GET：最小
try {
  const v = await race(evaluate(page,
    'fetch("/app", {credentials:"include"}).then(r=>r.status).catch(e=>"ERR:"+e.message)'
  ), 15000, 'GET')
  log('GET /app ->', JSON.stringify(v))
} catch (e) { log('GET /app ->', e.message) }

// 2) 同源 POST 到 StreamGenerate，用垃圾 body，只看能否拿到响应头
const probe = [
  '(async () => {',
  '  const t = Date.now();',
  '  try {',
  '    const r = await fetch("/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", {',
  '      method: "POST",',
  '      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },',
  '      body: "f.req=%5Bnull%2C%22x%22%5D",',
  '      credentials: "include",',
  '    });',
  '    return { status: r.status, ms: Date.now() - t };',
  '  } catch (e) { return { err: String(e), ms: Date.now() - t }; }',
  '})()',
].join('\n')
try {
  const v = await race(evaluate(page, probe), 30000, 'POST')
  log('POST StreamGenerate(garbage) ->', JSON.stringify(v))
} catch (e) { log('POST StreamGenerate(garbage) ->', e.message) }

page.close?.()
setTimeout(() => process.exit(0), 300)
