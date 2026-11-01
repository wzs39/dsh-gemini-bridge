// Quick status print used interactively (avoids inline-quoting pain in pwsh).
import { AgyPool } from '../lib/agytoken.mjs'

const pool = new AgyPool({ config: {} })
console.log('agy pool count =', pool.count)
for (const a of pool.describeAll()) {
  console.log([
    a.id,
    a.email ?? '-',
    `loaded=${a.token.loaded}`,
    `source=${a.token.source}`,
    `expiry=${a.token.expiry ?? '-'}`,
    `parked=${a.pausedUntil ?? 'no'}`,
  ].join(' | '))
}
