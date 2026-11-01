// 清空所有账号的 guard 冷却/异常计分（保留日预算与请求计数）。
// 用途：解析器修复后，旧代码写入的 "anomaly: empty-answer" 冷却会把账号
// 锁在 429 里最长 50 分钟——那是旧 bug 的产物，不是上游的态度。
// 必读：只清 cooldownUntil / level / reason / anomalyScore，
// 不动 requestsToday / hourStamps，避免绕过真实的配额保护。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const root = 'logs/accounts'

if (!existsSync(root)) { log('没有 logs/accounts，跳过'); process.exit(0) }

for (const name of readdirSync(root)) {
  const file = join(root, name, 'guard-state.json')
  if (!existsSync(file)) continue
  let state
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    log(`[${name}] 读取失败: ${e.message}`); continue
  }
  const before = {
    cooldown: state.cooldownUntil,
    level: state.level,
    reason: state.reason,
    anomaly: state.anomalyScore,
    requestsToday: state.requestsToday,
  }
  state.cooldownUntil = 0
  state.level = 0
  state.reason = null
  state.anomalyScore = 0
  state.burstStartedAt = 0
  writeFileSync(file, JSON.stringify(state, null, 2))
  log(`[${name}] cooldown ${before.cooldown} -> 0 | level ${before.level} -> 0 | reason ${JSON.stringify(before.reason)} -> null | anomaly ${before.anomaly} -> 0 | 保留 requestsToday=${before.requestsToday}`)
}
log('完成')
