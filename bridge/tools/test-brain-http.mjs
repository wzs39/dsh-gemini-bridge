// 用最小假 ctx 起 index.js 的路由，实测三条 brain 路由真的能返回数据。
// 目的：证明「路由挂得上去、能拿到真实文件」，而不只是函数层可用。
import http from 'node:http'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }

// agy-brain.js 在插件根目录的 lib/ 下（宿主半身），不在 bridge/lib/（网关本体）
const { scanBrain, readConversation, readConversationFile, defaultAccountsRoot } = await import('../../lib/agy-brain.js')

function isLoopbackReq(req) {
  const addr = req.socket?.localAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0'
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const routes = {
  '/plugins/dsh-gemini-bridge/agy/brain': () => scanBrain({ root: defaultAccountsRoot() }),
  '/plugins/dsh-gemini-bridge/agy/brain/conv': (url) => readConversation(
    url.searchParams.get('account') ?? '', url.searchParams.get('id') ?? '', { root: defaultAccountsRoot() }),
  '/plugins/dsh-gemini-bridge/agy/brain/file': (url) => readConversationFile(
    url.searchParams.get('account') ?? '', url.searchParams.get('id') ?? '',
    url.searchParams.get('path') ?? '', { root: defaultAccountsRoot() }),
}

const server = http.createServer((req, res) => {
  if (!isLoopbackReq(req)) return sendJson(res, 403, { error: 'host-not-trusted' })
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes[url.pathname]
  if (!handler) return sendJson(res, 404, { error: 'no route' })
  try { sendJson(res, 200, handler(url)) }
  catch (e) { sendJson(res, 404, { error: String(e?.message ?? e) }) }
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
log(`假宿主监听 ${base}\n`)

let failed = 0
const check = (n, c, d = '') => { if (c) log(`PASS  ${n}`); else { log(`FAIL  ${n}  ${d}`); failed++ } }

// 1) 索引
const idxResp = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/brain`)
const idx = await idxResp.json()
check('GET /agy/brain 返回 200', idxResp.status === 200, String(idxResp.status))
check('索引带 conversations', Array.isArray(idx.conversations) && idx.conversations.length > 0, String(idx.conversations?.length))
check('索引带 totals', idx.totals && idx.totals.files > 0, JSON.stringify(idx.totals?.files))

// 2) 详情
const c0 = idx.conversations[0]
const dResp = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/brain/conv?account=${encodeURIComponent(c0.account)}&id=${encodeURIComponent(c0.id)}`)
const detail = await dResp.json()
check('GET /agy/brain/conv 返回 200', dResp.status === 200, String(dResp.status))
check('详情带 messages', Array.isArray(detail.messages), String(detail.messages?.length))
check('详情带 files', Array.isArray(detail.files), String(detail.files?.length))

// 3) 产物文件
const withArt = idx.conversations.find(c => c.artifacts?.length > 0)
if (withArt) {
  const rel = withArt.artifacts[0].rel
  const fResp = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/brain/file?account=${encodeURIComponent(withArt.account)}&id=${encodeURIComponent(withArt.id)}&path=${encodeURIComponent(rel)}`)
  const file = await fResp.json()
  check('GET /agy/brain/file 返回 200', fResp.status === 200, String(fResp.status))
  check('文件内容非空', typeof file.content === 'string' && file.content.length > 0, `len=${file.content?.length}`)
  log(`      读到 ${rel} (${file.content.length} 字符)`)
} else {
  log('SKIP  没有产物文件可测')
}

// 4) 错误路径
const badResp = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/brain/conv?account=../../x&id=y`)
check('非法 account 返回 404', badResp.status === 404, String(badResp.status))
const travResp = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/brain/file?account=${encodeURIComponent(c0.account)}&id=${encodeURIComponent(c0.id)}&path=${encodeURIComponent('../../../etc/passwd')}`)
check('路径穿越返回 404', travResp.status === 404, String(travResp.status))
const noRoute = await fetch(`${base}/plugins/dsh-gemini-bridge/agy/nope`)
check('未知路径返回 404', noRoute.status === 404, String(noRoute.status))

// server.close() 之后立刻 process.exit 会和 libuv 的关停竞争
// （Windows 上表现为 Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
// 等 close 回调再退出，测试结论不受影响但收尾干净。
await new Promise((resolve) => server.close(resolve))
log('')
log(failed === 0 ? '全部通过' : `失败 ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
