/**
 * dsh-gemini-bridge — 浏览器半身（Client half）。
 *
 * 注册 usage 卡片到 conversation.composer.dock，每 60 秒轮询宿主侧
 * /plugins/dsh-gemini-bridge/usage 路由（由 index.js 注册的 webServer
 * 路由转发到 bridge 的 /health），显示通道状态：网页账号（live/parked/
 * signed-out + 今日预算）、agy 通道（凭据状态）、park 原因。
 *
 * 宿主以经典脚本加载 client.js（非 ESM），必须走
 * window.__ModuleLoader__.load({ id, factory }) 包装，React 用 require 取。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-gemini-bridge',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useEffect, useState } = React

    const name = 'dsh-gemini-bridge-client'

    /** 只声明宿主必定存在的服务。 */
    const inject = ['slots', 'locale']

    const USAGE_PATH = '/plugins/dsh-gemini-bridge/usage'
    const POLL_MS = 60_000

    // ── locale ──────────────────────────────────────────────────────────────
    const LOCALE = {
      zh: {
        title: 'Gemini 反代状态',
        ready: '就绪',
        parked: '冷却中',
        signedOut: '未登录',
        offline: '网关未运行',
        account: '账号',
        budget: '今日',
        cooldown: '冷却',
        agy: 'agy 通道',
        agyOn: '可用',
        agyOff: '无凭据',
        exhausted: '额度耗尽',
        partial: '部分可用',
        noCredential: '无凭据',
        disabled: '已关闭',
        web: '网页',
        models: '个模型',
        resets: '重置于',
        loginHint: '跑 node bridge/bin/login.mjs 登录',
        updated: '更新于',
      },
      en: {
        title: 'Gemini Bridge Status',
        ready: 'Ready',
        parked: 'Parked',
        signedOut: 'Signed out',
        offline: 'Bridge offline',
        account: 'Account',
        budget: 'Today',
        cooldown: 'Cooldown',
        agy: 'agy channel',
        agyOn: 'active',
        agyOff: 'no credential',
        exhausted: 'quota exhausted',
        partial: 'partial',
        noCredential: 'no credential',
        disabled: 'disabled',
        web: 'web',
        models: 'models',
        resets: 'resets',
        loginHint: 'Run node bridge/bin/login.mjs',
        updated: 'Updated',
      },
    }

    // ── usage 轮询 hook ─────────────────────────────────────────────────────
    async function fetchUsage() {
      try {
        const resp = await fetch(USAGE_PATH, { signal: AbortSignal.timeout(5000) })
        if (!resp.ok) return null
        return await resp.json()
      } catch {
        return null
      }
    }

    // ── UsageCard 组件 ──────────────────────────────────────────────────────
    function fmtTime(ts) {
      if (!ts) return '—'
      const d = new Date(ts)
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }

    function UsageCard({ locale }) {
      const [usage, setUsage] = useState(null)
      const [checkedAt, setCheckedAt] = useState(null)

      useEffect(() => {
        let timer
        let alive = true
        const load = async () => {
          const data = await fetchUsage()
          if (alive) {
            setUsage(data)
            setCheckedAt(Date.now())
          }
          timer = setTimeout(load, POLL_MS)
        }
        load()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      const style = {
        padding: '8px 12px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        fontSize: '12px',
        color: 'var(--text-secondary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }
      const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px' }
      const badgeStyle = (color) => ({
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 600,
        background: color.bg,
        color: color.fg,
      })
      const GREEN = { bg: 'rgba(100,255,100,0.15)', fg: '#6bff6b' }
      const RED = { bg: 'rgba(255,100,100,0.15)', fg: '#ff6b6b' }
      const BLUE = { bg: 'rgba(100,200,255,0.15)', fg: '#6bcfff' }
      const GRAY = { bg: 'rgba(150,150,150,0.15)', fg: '#999' }
      const ORANGE = { bg: 'rgba(255,180,80,0.18)', fg: '#ffb450' }

      /** 一条配额横条：按余量着色，0% 直接红，低于 20% 橙。 */
      function QuotaBar({ name, pct, usable, cooling, exhausted, reset, resetsLabel }) {
        const color = exhausted || cooling ? '#ff6b6b' : pct === null ? '#999' : pct < 0.2 ? '#ffb450' : '#6bff6b'
        const width = pct === null ? 0 : Math.max(0, Math.min(1, pct)) * 100
        const resetText = reset ? new Date(reset) : null
        const resetHuman = resetText && !Number.isNaN(resetText.getTime())
          ? `${resetsLabel} ${String(resetText.getMonth() + 1)}/${resetText.getDate()} ${String(resetText.getHours()).padStart(2, '0')}:${String(resetText.getMinutes()).padStart(2, '0')}`
          : ''
        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' } },
          React.createElement('span', { style: { width: '56px', opacity: 0.6 } }, name),
          React.createElement('div', { style: { flex: 1, height: '3px', background: 'rgba(150,150,150,0.2)', borderRadius: '2px', overflow: 'hidden' } },
            React.createElement('div', { style: { width: `${width}%`, height: '100%', background: color, borderRadius: '2px' } })),
          React.createElement('span', { style: { width: '32px', textAlign: 'right', color, fontWeight: 600 } }, pctText(pct)),
          resetHuman ? React.createElement('span', { style: { opacity: 0.4, fontSize: '9px' } }, resetHuman) : null,
        )
      }

      // 网关整体不可达（usage route 502 / 网络失败）
      if (!usage || typeof usage.status !== 'string') {
        return React.createElement('div', { style },
          React.createElement('div', { style: rowStyle },
            React.createElement('span', null, locale.title),
            React.createElement('span', { style: badgeStyle(GRAY) }, locale.offline)),
        )
      }

      const accounts = usage.accounts ?? []
      const agy = usage.agy ?? null
      const channels = usage.channels ?? null

      // ── agy 账号行：每号带配额条 + 真实可用结论 ──────────────────────────
      // 以前只显示 token 读没读到，那是「凭据没过期」，不是「上游愿意服务」。
      // 实测过三个号都因 VALIDATION_REQUIRED 被 403 时 token 依然全绿。
      function agyRows() {
        if (!agy) return []
        if (agy.pool) {
          return (agy.pool.accounts ?? []).map(a => {
            const parked = Boolean(a.pausedUntil && new Date(a.pausedUntil).getTime() > Date.now())
            const groups = (a.quota?.groups ?? []).map(g => ({
              name: g.group,
              pct: typeof g.remaining === 'number' ? g.remaining : null,
              usable: Boolean(g.usable),
              cooling: Boolean(g.cooling),
              exhausted: Boolean(g.exhausted),
              reset: g.resetTime,
            }))
            const liveGroups = groups.filter(g => g.usable).length
            // 三态：全可用 / 部分可用 / 全废。单布尔无法表达 kalao 那种
            // 「gemini 99% 但 anthropic 0%」的真实状态。
            const state = parked
              ? 'parked'
              : groups.length === 0
                ? (a.token?.loaded ? 'ready' : 'noCredential')
                : liveGroups === groups.length
                  ? 'ready'
                  : liveGroups > 0
                    ? 'partial'
                    : 'exhausted'
            return {
              key: a.id,
              label: a.email || a.alias || a.id,
              state,
              groups,
              parked,
              pauseReason: a.pauseReason,
            }
          })
        }
        const t = agy.token ?? {}
        return [{
          key: 'agy-single',
          label: t.source === 'keyring:gemini:antigravity' ? 'agy（系统凭据）' : 'agy',
          state: t.loaded ? 'ready' : 'noCredential',
          groups: [],
          parked: false,
          pauseReason: null,
        }]
      }
      const rows = agyRows()

      // 通道级徽标：直接把 /health 的 channels 结论搬上来，不再自己猜。
      const agyChannel = channels?.agy ?? null
      const agyBadge = (() => {
        if (!agyChannel) {
          return agy
            ? { text: `${locale.agy} ${locale.agyOn}`, color: BLUE }
            : { text: `${locale.agy} ${locale.agyOff}`, color: GRAY }
        }
        if (!agyChannel.enabled) return { text: `${locale.agy} ${locale.disabled}`, color: GRAY }
        if (agyChannel.state === 'ready') {
          return { text: `${locale.agy} ${agyChannel.usable}/${agyChannel.total} ${locale.agyOn}`, color: BLUE }
        }
        if (agyChannel.state === 'parked') return { text: `${locale.agy} ${locale.parked}`, color: RED }
        return { text: `${locale.agy} ${locale.agyOff}`, color: GRAY }
      })()

      const stateBadge = (state) => {
        switch (state) {
          case 'ready': return React.createElement('span', { style: badgeStyle(BLUE) }, locale.agyOn)
          case 'partial': return React.createElement('span', { style: badgeStyle(ORANGE) }, locale.partial)
          case 'parked': return React.createElement('span', { style: badgeStyle(RED) }, locale.parked)
          case 'exhausted': return React.createElement('span', { style: badgeStyle(RED) }, locale.exhausted)
          default: return React.createElement('span', { style: badgeStyle(GRAY) }, locale.agyOff)
        }
      }

      const pctText = (pct) => (pct === null ? '?' : `${Math.round(pct * 100)}%`)

      return React.createElement('div', { style },
        // 顶部：总状态 + agy 通道徽标
        React.createElement('div', { style: rowStyle },
          React.createElement('span', null, locale.title),
          usage.status === 'ready'
            ? React.createElement('span', { style: badgeStyle(GREEN) }, locale.ready)
            : usage.status === 'parked'
              ? React.createElement('span', { style: badgeStyle(RED) }, locale.parked)
              : React.createElement('span', { style: badgeStyle(GRAY) }, locale.signedOut),
          React.createElement('span', { style: { marginLeft: 'auto' } },
            React.createElement('span', { style: badgeStyle(agyBadge.color) }, agyBadge.text)),
        ),
        // agy 账号行：每个号一行状态 + 它自己的配额分组条
        rows.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
          rows.map((row) => React.createElement('div', { key: row.key, style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' } },
              React.createElement('span', { style: { fontWeight: 500, opacity: 0.85 } }, row.label),
              React.createElement('span', { style: { marginLeft: 'auto' } }, stateBadge(row.state)),
            ),
            // 配额明细：只看得到「有凭据」不够，要看得出哪一组还剩多少
            row.groups.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '2px' } },
              row.groups.map(g => React.createElement(QuotaBar, {
                key: g.name,
                name: g.name,
                pct: g.pct,
                usable: g.usable,
                cooling: g.cooling,
                exhausted: g.exhausted,
                reset: g.reset,
                resetsLabel: locale.resets,
              }))),
            // park 原因：告诉用户为什么这个号不干活，而不是只显示一个红点
            row.pauseReason && React.createElement('span', {
              style: { fontSize: '9px', opacity: 0.45, paddingLeft: '2px', wordBreak: 'break-word' },
            }, String(row.pauseReason).split('\n')[0].slice(0, 90)),
          ))),
        // 网页账号行
        accounts.length === 0
          ? React.createElement('span', { style: { fontSize: '11px', opacity: 0.5 } }, locale.loginHint)
          : accounts.map((acc) => {
              const parked = Boolean(acc.pausedUntil)
              const cool = acc.guard && acc.guard.cooldownSeconds > 0
              const budget = acc.guard ? `${acc.guard.requestsToday}/${acc.guard.budgetPerDay}` : ''
              return React.createElement('div', { key: acc.name, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' } },
                React.createElement('span', { style: { fontWeight: 500 } }, acc.name),
                React.createElement('span', { style: { marginLeft: 'auto' } },
                  parked
                    ? React.createElement('span', { style: badgeStyle(RED) }, locale.parked)
                    : acc.session && acc.session.ready
                      ? React.createElement('span', { style: badgeStyle(GREEN) }, locale.ready)
                      : React.createElement('span', { style: badgeStyle(GRAY) }, locale.signedOut),
                  cool
                    ? React.createElement('span', { style: { marginLeft: '6px', opacity: 0.7 } }, `${locale.cooldown} ${Math.ceil(acc.guard.cooldownSeconds / 60)}m`)
                    : null,
                  budget ? React.createElement('span', { style: { marginLeft: '6px', opacity: 0.6 } }, `${locale.budget} ${budget}`) : null),
              )
            }),
        // 更新时间
        React.createElement('span', { style: { fontSize: '10px', opacity: 0.4, textAlign: 'right' } },
          `${locale.updated} ${fmtTime(checkedAt)}`),
      )
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    async function apply(ctx) {
      const locale = ctx.locale
      locale.register?.('dsh-gemini-bridge', LOCALE)

      // 探测 slots 服务
      const slots = ctx.slots
      if (!slots?.inject) {
        console.warn('[dsh-gemini-bridge-client] slots service not available, skipping')
        return
      }

      const t = locale.bind?.('dsh-gemini-bridge') ?? ((key) => LOCALE.zh[key] ?? key)

      // 注册 usage 卡片到 conversation.composer.dock
      slots.inject('conversation.composer.dock', () => {
        const disposer = slots.register({
          name: 'dsh-gemini-bridge-usage',
          id: 'dsh-gemini-bridge-usage',
          order: 16,
          locale: 'dsh-gemini-bridge',
          inject: ['locale'],
        }, (props) => {
          return React.createElement(UsageCard, { locale: t })
        })
        return disposer
      })

      console.info('[dsh-gemini-bridge-client] usage card registered on conversation.composer.dock')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
