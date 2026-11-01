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

      // 网关整体不可达（usage route 502 / 网络失败）
      if (!usage || typeof usage.status !== 'string') {
        return React.createElement('div', { style },
          React.createElement('div', { style: rowStyle },
            React.createElement('span', null, locale.title),
            React.createElement('span', { style: badgeStyle(GRAY) }, locale.offline)),
        )
      }

      const accounts = usage.accounts ?? []
      const agyReady = Boolean(usage.agy && usage.agy.token && usage.agy.token.loaded)

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
            agyReady
              ? React.createElement('span', { style: badgeStyle(BLUE) }, `${locale.agy} ${locale.agyOn}`)
              : React.createElement('span', { style: badgeStyle(GRAY) }, `${locale.agy} ${locale.agyOff}`)),
        ),
        // 账号行：live/parked + 今日预算 + 冷却
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
