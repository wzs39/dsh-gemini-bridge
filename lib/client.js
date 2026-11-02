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
        brainTitle: 'agy 产物',
        brainSearch: '搜索标题 / id / 文件名…',
        brainEmpty: '没有匹配的会话',
        brainPick: '← 选一个会话，看 agy 在里面写了什么',
        loading: '读取中…',
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
        brainTitle: 'agy artifacts',
        brainSearch: 'Search title / id / filename…',
        brainEmpty: 'No matching conversation',
        brainPick: '← Pick a conversation to see what agy wrote',
        loading: 'Loading…',
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
      function QuotaBar({ name, pct, usable, cooling, exhausted, reset, resetsLabel, indent }) {
        const color = exhausted || cooling ? '#ff6b6b' : pct === null ? '#999' : pct < 0.2 ? '#ffb450' : '#6bff6b'
        const width = pct === null ? 0 : Math.max(0, Math.min(1, pct)) * 100
        const resetText = reset ? new Date(reset) : null
        const resetHuman = resetText && !Number.isNaN(resetText.getTime())
          ? `${resetsLabel} ${String(resetText.getMonth() + 1)}/${resetText.getDate()} ${String(resetText.getHours()).padStart(2, '0')}:${String(resetText.getMinutes()).padStart(2, '0')}`
          : ''
        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', opacity: indent ? 0.72 : 1 } },
          React.createElement('span', { style: { width: '56px', opacity: 0.6, paddingLeft: indent ? '8px' : 0 } }, name),
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
              // 上游真正限流的是桶：5h 先耗尽，weekly 后耗尽。组汇总会掩盖
              // 「weekly 100% 但 5h 为 0」，那正是 claude 报 Resets in 1h 的
              // 真实状态，所以桶必须单独显示。
              buckets: (g.buckets ?? []).map(b => ({
                id: b.id,
                window: b.window,
                pct: typeof b.remaining === 'number' ? b.remaining : null,
                reset: b.resetTime,
              })),
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
            // 配额明细：组级 + 桶级。组汇总会掩盖「weekly 满、5h 空」的真实
            // 状态，而那正是上游真正限流的地方，所以桶必须单独列出来。
            row.groups.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '2px' } },
              row.groups.flatMap(g => {
                const items = [React.createElement(QuotaBar, {
                  key: g.name,
                  name: g.name,
                  pct: g.pct,
                  usable: g.usable,
                  cooling: g.cooling,
                  exhausted: g.exhausted,
                  reset: g.reset,
                  resetsLabel: locale.resets,
                })]
                // 只有在桶信息存在且与组汇总不同时才展开，避免重复占屏。
                for (const b of g.buckets ?? []) {
                  const differs = g.pct === null || b.pct === null || Math.abs(b.pct - g.pct) > 0.005
                  if (!differs) continue
                  items.push(React.createElement(QuotaBar, {
                    key: `${g.name}:${b.id ?? b.window}`,
                    name: `${b.window ?? b.id}`,
                    pct: b.pct,
                    usable: b.pct === null ? true : b.pct > 0,
                    cooling: false,
                    exhausted: b.pct !== null && b.pct <= 0,
                    reset: b.reset,
                    resetsLabel: locale.resets,
                    indent: true,
                  }))
                }
                return items
              })),
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

    // ── 样式基元 ────────────────────────────────────────────────────────────
    // 全部走 DSH 自己的主题别名（--dsw-alias-*），不写死颜色。
    // 写死 rgba(28,30,36,.97) 这种值在浅色主题下会变成一块突兀的深色板，
    // 和宿主其余界面完全脱节——之前那版就是这样，浅色模式下几乎不可用。
    const T = {
      bgPanel: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, rgba(127,127,127,0.06)))',
      bgRow: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.07))',
      bgRowHover: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.13))',
      bgActive: 'var(--dsw-alias-button-ghost-active-fill, rgba(70,130,220,0.16))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.16))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      textDim: 'var(--dsw-alias-label-caption, rgba(127,127,127,0.9))',
      textMuted: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.72))',
      accent: 'var(--dsw-alias-brand-primary, rgb(88,140,240))',
      ok: 'var(--dsw-alias-state-success-primary, rgb(70,170,110))',
      warn: 'var(--dsw-alias-state-warn-primary, rgb(210,160,60))',
      err: 'var(--dsw-alias-label-error, rgb(220,100,100))',
      radius: '8px',
      radiusSm: '6px',
    }

    /** 悬停反馈：只用一个 state，避免为每行都建组件。 */
    function useHover() {
      const [hover, setHover] = useState(false)
      return [hover, {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }]
    }

    /** 可点击的行：统一悬停、选中、键盘可达。 */
    function HoverRow({ onClick, active = false, style, children, title }) {
      const [hover, hoverProps] = useHover()
      return React.createElement('div', {
        onClick,
        title,
        role: onClick ? 'button' : undefined,
        tabIndex: onClick ? 0 : undefined,
        onKeyDown: onClick
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } }
          : undefined,
        ...hoverProps,
        style: {
          cursor: onClick ? 'pointer' : 'default',
          borderRadius: T.radiusSm,
          background: active ? T.bgActive : (hover ? T.bgRowHover : 'transparent'),
          outline: 'none',
          transition: 'background 120ms ease',
          ...style,
        },
      }, children)
    }

    /** 分区标题：小号、淡色、全大写间距，替代原来散落的 opacity 0.5。 */
    function SectionLabel({ children, tone = 'dim', right = null }) {
      return React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '8px', margin: '10px 0 4px',
        },
      },
        React.createElement('span', {
          style: {
            fontSize: '10px', letterSpacing: '0.03em', fontWeight: 600,
            color: tone === 'warn' ? T.warn : T.textDim,
          },
        }, children),
        right,
      )
    }

    /** 空状态：一句话 + 可选提示，居中但不啰嗦。 */
    function EmptyState({ title, hint }) {
      return React.createElement('div', {
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: '6px', padding: '28px 16px',
          textAlign: 'center', color: T.textMuted,
        },
      },
        React.createElement('div', { style: { fontSize: '22px', opacity: 0.5 } }, '🗂'),
        React.createElement('div', { style: { fontSize: '12px', color: T.textDim } }, title),
        hint ? React.createElement('div', { style: { fontSize: '10.5px', maxWidth: '280px', lineHeight: '16px' } }, hint) : null,
      )
    }

    // agy CLI 把会话痕迹写在 ~/.dsh/agy-accounts/*/…/brain/ 下，DSH 会话里
    // 完全看不到（实测 2 账号 / 13 会话 / 211 文件 / 7.1 MB）。这里把它们
    // 以只读方式搬进界面：会话列表 → 对话时间线 → 产物文件内容。
    //
    // 挂在 shell.overlay：一个可展开的悬浮面板。收起时只剩一个小胶囊，
    // 因为 overlay 层本身 click-through，不会挡住下面的界面。

    const BRAIN_PATH = '/plugins/dsh-gemini-bridge/agy/brain'
    const CONV_PATH = '/plugins/dsh-gemini-bridge/agy/brain/conv'
    const FILE_PATH = '/plugins/dsh-gemini-bridge/agy/brain/file'

    const fmtBytes = (n) => {
      if (!n) return '0'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }
    const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))
    const fmtAgo = (iso) => {
      if (!iso) return ''
      const ms = Date.now() - new Date(iso).getTime()
      if (!Number.isFinite(ms) || ms < 0) return ''
      const m = Math.floor(ms / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return `${m} 分钟前`
      const h = Math.floor(m / 60)
      if (h < 24) return `${h} 小时前`
      return `${Math.floor(h / 24)} 天前`
    }

    const KIND_LABEL = {
      artifact: '产物',
      transcript: '对话',
      'transcript-shard': '分片',
      'tool-output': '工具输出',
      message: '消息',
      subagent: '子代理',
      task: '任务日志',
      media: '附件',
      log: '日志',
      'step-file': '步骤文件',
      unknown: '未识别',
    }

    /**
     * 预览抽屉的图标。按文件后缀判，而不是按 brain 的 kind 字段：
     * kind 说的是「这个文件在 agy 里扮演什么角色」（附件/产物/日志），
     * 和「能不能画出来」是两件事——media 里放的是 PDF，产物里可以是 PNG。
     */
    function fileIcon(file) {
      if (file?.kind === 'image') return '🖼'
      if (file?.kind === 'pdf') return '📕'
      if (file?.binary) return '📦'
      return '📄'
    }

    /** 小胶囊按钮：面板收起时的入口。 */
    function BrainPill({ locale, totals, open, onToggle }) {
      const has = totals && totals.conversations > 0
      const [hover, hoverProps] = useHover()
      return React.createElement('div', {
        style: {
          position: 'fixed', right: '14px', bottom: '76px',
          pointerEvents: 'auto', zIndex: 1,
        },
      }, React.createElement('button', {
        onClick: onToggle,
        title: locale.brainTitle,
        'aria-expanded': open,
        ...hoverProps,
        style: {
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 11px', borderRadius: '999px', cursor: 'pointer',
          border: `1px solid ${open ? T.accent : T.border}`,
          background: open ? T.accent : T.bgPanel,
          color: open ? '#fff' : T.text,
          fontSize: '11px', lineHeight: '16px', fontWeight: 500,
          boxShadow: hover || open ? '0 3px 12px rgba(0,0,0,0.22)' : '0 1px 4px rgba(0,0,0,0.14)',
          transition: 'background 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
        },
      },
        React.createElement('span', { 'aria-hidden': 'true' }, '🗂'),
        React.createElement('span', null, locale.brainTitle),
        has
          ? React.createElement('span', {
            style: {
              minWidth: '18px', padding: '0 5px', borderRadius: '999px',
              background: open ? 'rgba(255,255,255,0.24)' : T.bgRow,
              color: open ? '#fff' : T.textDim,
              fontSize: '10px', fontWeight: 600, textAlign: 'center',
            },
          }, String(totals.conversations))
          : null,
      ))
    }

    /** 单个会话行。 */
    function ConvRow({ c, active, onOpen }) {
      const bits = []
      if (c.artifacts?.length) bits.push(`${c.artifacts.length} 产物`)
      if (c.toolOutputs) bits.push(`${c.toolOutputs} 输出`)
      if (c.subagents) bits.push(`${c.subagents} 子代理`)
      const title = c.title || `(无标题) ${c.id.slice(0, 8)}`
      return React.createElement(HoverRow, {
        onClick: () => onOpen(c),
        active,
        title,
        style: { padding: '7px 9px', marginBottom: '2px' },
      },
        React.createElement('div', {
          style: {
            fontSize: '11.5px', lineHeight: '16px', fontWeight: active ? 600 : 400,
            color: active ? T.accent : T.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, title),
        React.createElement('div', {
          style: {
            fontSize: '10px', marginTop: '3px', display: 'flex',
            gap: '8px', flexWrap: 'wrap', color: T.textMuted, alignItems: 'center',
          },
        },
          React.createElement('span', null, c.account.replace(/^acc_\d+_/, '').slice(0, 12)),
          React.createElement('span', null, fmtAgo(c.lastAt || (c.mtime ? new Date(c.mtime).toISOString() : ''))),
          React.createElement('span', null, `${c.fileCount} 文件`),
          c.tokens?.output
            ? React.createElement('span', { style: { color: T.textDim } }, `${fmtNum(c.tokens.output)} tok`)
            : null,
          bits.length
            ? React.createElement('span', { style: { color: T.accent } }, bits.join(' · '))
            : null,
        ),
      )
    }

    /** 对话时间线里的一条消息。 */
    function MsgBlock({ m }) {
      const [showThink, setShowThink] = useState(false)
      const isUser = m.type === 'USER_INPUT'
      const isPlanner = m.type === 'PLANNER_RESPONSE'
      const who = isUser ? '用户' : isPlanner ? '模型' : m.type
      // 用主题语义色：用户=品牌色，模型=成功色，系统类=淡色。
      const color = isUser ? T.accent : isPlanner ? T.ok : T.textMuted
      const [hover, hoverProps] = useHover()

      // 用户输入里塞满元数据标签，显示时剥掉只留正文
      let body = m.content || ''
      const req = body.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
      if (req) body = req[1]
      const cur = body.match(/\[CURRENT REQUEST[^\]]*\]([\s\S]*)$/)
      if (cur) body = cur[1]
      const trimmed = body.trim()
      const toolNames = (m.toolCalls ?? []).map(tc => tc.name).filter(Boolean)

      return React.createElement('div', {
        ...hoverProps,
        style: {
          marginBottom: '6px', padding: '6px 8px',
          borderLeft: `2px solid ${color}`,
          background: hover ? T.bgRow : 'transparent',
          borderRadius: `0 ${T.radiusSm} ${T.radiusSm} 0`,
          transition: 'background 120ms ease',
        },
      },
        React.createElement('div', {
          style: {
            fontSize: '10px', display: 'flex', gap: '8px', alignItems: 'center',
            marginBottom: trimmed ? '4px' : 0, flexWrap: 'wrap', color: T.textMuted,
          },
        },
          React.createElement('span', { style: { color, fontWeight: 600 } }, who),
          React.createElement('span', null, `#${m.step}`),
          m.at ? React.createElement('span', null, m.at.slice(11, 19)) : null,
          m.tokens?.output
            ? React.createElement('span', null, `${fmtNum(m.tokens.output)} tok`)
            : null,
          toolNames.length
            ? React.createElement('span', {
              style: {
                color: T.warn, maxWidth: '260px', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
              title: toolNames.join(', '),
            }, `🔧 ${toolNames.join(', ')}`)
            : null,
        ),
        trimmed
          ? React.createElement('div', {
            style: {
              fontSize: '11.5px', lineHeight: '18px', whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', maxHeight: '260px', overflow: 'auto',
              color: T.text,
            },
          }, trimmed.slice(0, 4000))
          : null,
        m.thinking?.trim()
          ? React.createElement('div', { style: { marginTop: '4px' } },
            React.createElement('span', {
              onClick: () => setShowThink(v => !v),
              role: 'button',
              tabIndex: 0,
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowThink(v => !v) } },
              style: {
                fontSize: '10px', color: T.textDim, cursor: 'pointer',
                userSelect: 'none', display: 'inline-block',
              },
            }, showThink ? '▾ 思考过程' : '▸ 思考过程'),
            showThink
              ? React.createElement('div', {
                style: {
                  fontSize: '10.5px', lineHeight: '16px', color: T.textDim,
                  whiteSpace: 'pre-wrap', marginTop: '4px', maxHeight: '200px',
                  overflow: 'auto', fontStyle: 'italic',
                  paddingLeft: '8px', borderLeft: `1px dashed ${T.borderSoft}`,
                },
              }, m.thinking.slice(0, 3000))
              : null)
          : null,
      )
    }

    /** 会话详情：文件清单 + 对话时间线 + 文件内容预览。 */
    function ConvDetail({ locale, account, id }) {
      const [detail, setDetail] = useState(null)
      const [err, setErr] = useState(null)
      const [tab, setTab] = useState('files')
      const [file, setFile] = useState(null)

      useEffect(() => {
        let alive = true
        setDetail(null); setErr(null); setFile(null)
        fetch(`${CONV_PATH}?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) })
          .then(r => r.json())
          .then(d => { if (alive) { if (d.error) setErr(d.error); else setDetail(d) } })
          .catch(e => { if (alive) setErr(String(e.message ?? e)) })
        return () => { alive = false }
      }, [account, id])

      const openFile = (f) => {
        setFile({ loading: true, path: f.rel })
        fetch(`${FILE_PATH}?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}&path=${encodeURIComponent(f.rel)}`, { signal: AbortSignal.timeout(20000) })
          .then(r => r.json())
          .then(d => setFile(d.error ? { error: d.error, path: f.rel } : d))
          .catch(e => setFile({ error: String(e.message ?? e), path: f.rel }))
      }

      if (err) {
        return React.createElement('div', {
          style: { padding: '20px 16px', textAlign: 'center' },
        },
          React.createElement('div', { style: { fontSize: '12px', color: T.err, marginBottom: '6px' } }, '读取失败'),
          React.createElement('div', { style: { fontSize: '10.5px', color: T.textMuted, lineHeight: '16px' } }, err),
        )
      }
      if (!detail) {
        return React.createElement('div', {
          style: { padding: '24px 16px', textAlign: 'center', fontSize: '11px', color: T.textMuted },
        }, locale.loading)
      }

      const artifactFiles = detail.files.filter(f => f.kind === 'artifact')
      const unknownFiles = detail.files.filter(f => f.kind === 'unknown')
      const otherFiles = detail.files.filter(f => f.kind !== 'artifact' && f.kind !== 'unknown')
      const totalBytes = detail.files.reduce((n, f) => n + (f.size ?? 0), 0)

      /** 统计小徽标：替代原来挤在一行里的 · 分隔。 */
      const stat = (text, tone) => React.createElement('span', {
        style: {
          fontSize: '10px', padding: '1px 6px', borderRadius: '999px',
          background: T.bgRow, color: tone ?? T.textDim, whiteSpace: 'nowrap',
        },
      }, text)

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        // 头部：标题 + 统计徽标
        React.createElement('div', {
          style: { padding: '8px 10px', borderBottom: `1px solid ${T.borderSoft}`, flexShrink: 0 },
        },
          React.createElement('div', {
            title: detail.title || '',
            style: {
              fontSize: '12.5px', fontWeight: 600, color: T.text,
              marginBottom: '5px', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, detail.title || '(无标题)'),
          React.createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            stat(`${detail.summary.steps} 步`),
            stat(`${detail.files.length} 文件`),
            stat(fmtBytes(totalBytes)),
            detail.summary.tokens.output ? stat(`${fmtNum(detail.summary.tokens.output)} out`, T.accent) : null,
            detail.summary.tokens.cacheRead ? stat(`${fmtNum(detail.summary.tokens.cacheRead)} cache`) : null,
          ),
        ),
        // Tab 切换
        React.createElement('div', {
          style: {
            display: 'flex', gap: '2px', padding: '6px 8px 0',
            borderBottom: `1px solid ${T.borderSoft}`, flexShrink: 0,
          },
        },
          ...[
            ['files', '文件', artifactFiles.length],
            ['chat', '对话', detail.messages.length],
          ].map(([k, label, count]) => {
            const on = tab === k
            return React.createElement('button', {
              key: k,
              onClick: () => setTab(k),
              'aria-selected': on,
              role: 'tab',
              style: {
                padding: '4px 10px', cursor: 'pointer', fontSize: '11px',
                background: 'transparent', color: on ? T.accent : T.textDim,
                border: 'none', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
                marginBottom: '-1px', fontWeight: on ? 600 : 400,
                transition: 'color 120ms ease, border-color 120ms ease',
              },
            }, `${label} ${count}`)
          }),
        ),
        // 内容区
        React.createElement('div', { style: { flex: 1, overflow: 'auto', padding: '6px 8px 10px', minHeight: 0 } },
          tab === 'files'
            ? React.createElement('div', null,
              artifactFiles.length
                ? React.createElement('div', { style: { marginBottom: '4px' } },
                  React.createElement(SectionLabel, {
                    right: React.createElement('span', { style: { fontSize: '10px', color: T.textMuted } }, fmtBytes(artifactFiles.reduce((n, f) => n + (f.size ?? 0), 0))),
                  }, `agy 写出的产物 · ${artifactFiles.length}`),
                  ...artifactFiles.map(f => React.createElement(HoverRow, {
                    key: f.rel,
                    onClick: () => openFile(f),
                    active: file?.path === f.rel,
                    title: f.rel,
                    style: {
                      padding: '6px 8px', marginBottom: '2px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                      border: `1px solid ${file?.path === f.rel ? T.accent : T.borderSoft}`,
                      background: file?.path === f.rel ? T.bgActive : T.bgRow,
                    },
                  },
                    React.createElement('span', {
                      style: {
                        fontSize: '11.5px', color: T.text, display: 'flex',
                        alignItems: 'center', gap: '5px', minWidth: 0,
                      },
                    },
                      React.createElement('span', { 'aria-hidden': 'true' }, '📄'),
                      React.createElement('span', {
                        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      }, f.name || f.rel),
                    ),
                    React.createElement('span', {
                      style: { fontSize: '10px', color: T.textMuted, flexShrink: 0 },
                    }, fmtBytes(f.size)),
                  )))
                : React.createElement(EmptyState, {
                  title: '这个会话没有 agy 产物文件',
                  hint: 'agy 只在模型主动写文件时才产生产物；对话记录仍然可以在「对话」标签里看。',
                }),
              otherFiles.length
                ? React.createElement(SectionLabel, { right: React.createElement('span', { style: { fontSize: '10px', color: T.textMuted } }, String(otherFiles.length)) }, '内部文件')
                : null,
              ...otherFiles.slice(0, 80).map(f => React.createElement(HoverRow, {
                key: f.rel,
                onClick: () => openFile(f),
                active: file?.path === f.rel,
                title: f.rel,
                style: { padding: '4px 8px', display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 },
              },
                React.createElement('span', {
                  style: {
                    fontSize: '9.5px', color: T.textMuted, flexShrink: 0,
                    padding: '0 5px', borderRadius: '3px', background: T.bgRow,
                  },
                }, KIND_LABEL[f.kind] ?? f.kind),
                React.createElement('span', {
                  style: {
                    fontSize: '10.5px', color: T.textDim, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                }, f.rel),
              )),
              otherFiles.length > 80
                ? React.createElement('div', { style: { fontSize: '10px', color: T.textMuted, padding: '6px 8px' } }, `…还有 ${otherFiles.length - 80} 个未列出`)
                : null,
              // agy 以后可能加新目录/新格式。这里始终把它们列出来，
              // 而不是因为「不认识」就静默丢掉——看不见的类型才是真问题。
              unknownFiles.length
                ? React.createElement('div', {
                  style: { marginTop: '12px', borderTop: `1px dashed ${T.warn}`, paddingTop: '8px' },
                },
                  React.createElement(SectionLabel, {
                    tone: 'warn',
                    right: React.createElement('span', { style: { fontSize: '10px', color: T.textMuted } }, String(unknownFiles.length)),
                  }, '未识别类型 · agy 新目录，点开即可看内容'),
                  ...unknownFiles.slice(0, 60).map(f => React.createElement(HoverRow, {
                    key: f.rel,
                    onClick: () => openFile(f),
                    active: file?.path === f.rel,
                    title: f.rel,
                    style: { padding: '4px 8px', display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 },
                  },
                    React.createElement('span', { style: { fontSize: '10px', color: T.warn, flexShrink: 0 } }, '?'),
                    React.createElement('span', {
                      style: {
                        fontSize: '10.5px', color: T.textDim, minWidth: 0, flex: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                    }, f.rel),
                    React.createElement('span', { style: { fontSize: '10px', color: T.textMuted, flexShrink: 0 } }, fmtBytes(f.size)),
                  )),
                )
                : null,
            )
            : React.createElement('div', null,
              detail.messages.length
                ? React.createElement(React.Fragment, null,
                  ...detail.messages.map(m => React.createElement(MsgBlock, { key: m.step, m })),
                )
                : React.createElement(EmptyState, {
                  title: '没有可解析的对话记录',
                  hint: '这个会话的 transcript 可能是空的，或 agy 换了新的记录格式。',
                }),
            ),
        ),
        // 文件预览抽屉
        file
          ? React.createElement('div', {
            style: {
              borderTop: `1px solid ${T.border}`, maxHeight: '45%',
              display: 'flex', flexDirection: 'column', flexShrink: 0,
              background: T.bgRow,
            },
          },
            // 抽屉头：文件名 + 大小 + 关闭
            React.createElement('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 10px', borderBottom: `1px solid ${T.borderSoft}`,
                flexShrink: 0,
              },
            },
              React.createElement('span', { style: { fontSize: '11px', flexShrink: 0 } }, fileIcon(file)),
              React.createElement('span', {
                title: file.path,
                style: {
                  fontSize: '11px', color: T.text, flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: 500,
                },
              }, String(file.path ?? '').split('/').pop()),
              file.size
                ? React.createElement('span', {
                  style: { fontSize: '10px', color: T.textMuted, flexShrink: 0 },
                }, fmtBytes(file.size))
                : null,
              React.createElement('button', {
                onClick: () => setFile(null),
                title: '关闭预览',
                style: {
                  flexShrink: 0, cursor: 'pointer', border: 'none', borderRadius: '4px',
                  background: 'transparent', color: T.textDim, fontSize: '12px',
                  padding: '2px 6px', lineHeight: 1,
                },
              }, '✕'),
            ),
            React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
              file.loading
                ? React.createElement('div', {
                  style: { padding: '12px', fontSize: '11px', color: T.textMuted },
                }, locale.loading)
                : file.error
                  ? React.createElement('div', {
                    style: { padding: '12px', fontSize: '11px', color: T.err, lineHeight: '17px' },
                  }, file.error)
                  // 图片：dataUrl 优先（一次请求就够），过大时退到 raw 路由。
                  : file.kind === 'image' && (file.dataUrl || file.streamUrl)
                    ? React.createElement('div', {
                      style: { padding: '10px 12px', display: 'flex', justifyContent: 'center' },
                    },
                      React.createElement('img', {
                        src: file.dataUrl || file.streamUrl,
                        alt: String(file.path ?? '').split('/').pop(),
                        style: {
                          maxWidth: '100%', maxHeight: '340px', objectFit: 'contain',
                          borderRadius: T.radiusSm, border: `1px solid ${T.borderSoft}`,
                          // 棋盘底：透明 PNG 在深色主题下才看得出边界
                          background: 'repeating-conic-gradient(' +
                            'var(--dsw-alias-bg-l3, rgba(128,128,128,.12)) 0% 25%, transparent 0% 50%) 50% / 12px 12px',
                        },
                      }),
                    )
                    // PDF：必须走真 URL——Chrome 不允许 <iframe src="data:application/pdf">。
                    : file.kind === 'pdf' && file.streamUrl
                      ? React.createElement('iframe', {
                        src: file.streamUrl,
                        title: String(file.path ?? '').split('/').pop(),
                        style: {
                          width: '100%', height: '360px', border: 'none',
                          background: 'var(--dsw-alias-bg-layer-1, #fff)',
                        },
                      })
                      : (file.note && !file.content)
                        ? React.createElement('div', {
                          style: { padding: '12px', fontSize: '11px', color: T.textMuted, lineHeight: '17px' },
                        }, file.note)
                        : React.createElement('pre', {
                          style: {
                            fontSize: '11px', lineHeight: '17px', whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word', margin: 0, padding: '10px 12px',
                            color: T.text,
                            fontFamily: 'var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
                          },
                        }, file.content),
            ),
          )
          : null,
      )
    }

    /** 顶层：胶囊 + 展开面板。 */
    function BrainBrowser({ locale, forceOpen = false, onClose = null, embedded = false }) {
      const [open, setOpen] = useState(forceOpen)
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [sel, setSel] = useState(null)
      const [q, setQ] = useState('')
      const [loading, setLoading] = useState(false)

      // forceOpen 模式下由外部控制显隐，胶囊与自带的收起按钮都不渲染。
      const shown = forceOpen || open
      const close = () => { if (onClose) onClose(); else setOpen(false) }

      const load = () => {
        setLoading(true)
        fetch(BRAIN_PATH, { signal: AbortSignal.timeout(20000) })
          .then(r => r.json())
          .then(d => { if (d.error) setErr(d.error); else { setData(d); setErr(null) } })
          .catch(e => setErr(String(e.message ?? e)))
          .finally(() => setLoading(false))
      }

      useEffect(() => { if (shown && !data) load() }, [shown])

      const filtered = (data?.conversations ?? []).filter(c => {
        if (!q.trim()) return true
        const needle = q.trim().toLowerCase()
        return (c.title ?? '').toLowerCase().includes(needle)
          || c.id.toLowerCase().includes(needle)
          || c.account.toLowerCase().includes(needle)
          || c.artifacts.some(a => a.name.toLowerCase().includes(needle))
      })

      const pill = React.createElement(BrainPill, {
        locale, totals: data?.totals, open, onToggle: () => setOpen(v => !v),
      })

      if (!shown) return forceOpen ? null : pill

      // embedded：主列里占满容器，不做浮动卡片、不带圆角阴影。
      // 浮动：shell.overlay / composer 下的卡片形态。
      const shellStyle = embedded
        ? {
            position: 'relative', flex: 1, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            width: '100%', height: '100%',
            background: 'transparent', color: 'inherit',
            overflow: 'hidden',
          }
        : {
            position: 'fixed', right: '14px', bottom: '112px',
            width: 'min(760px, calc(100vw - 28px))',
            height: 'min(560px, calc(100vh - 140px))',
            display: 'flex', flexDirection: 'column',
            pointerEvents: 'auto', zIndex: 2,
            background: T.bgPanel, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: '10px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)', overflow: 'hidden',
          }

      const body = React.createElement('div', { style: shellStyle },
          // 标题栏
          React.createElement('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '9px 12px', borderBottom: `1px solid ${T.borderSoft}`, flexShrink: 0,
            },
          },
            React.createElement('span', { style: { fontSize: '12.5px', fontWeight: 600, color: T.text } }, locale.brainTitle),
            data
              ? React.createElement('span', {
                style: {
                  fontSize: '10px', color: T.textMuted, display: 'flex',
                  gap: '6px', flexWrap: 'wrap', alignItems: 'center',
                },
              },
                React.createElement('span', null, `${data.totals.accounts} 账号`),
                React.createElement('span', null, `${data.totals.conversations} 会话`),
                data.totals.artifacts
                  ? React.createElement('span', { style: { color: T.accent } }, `${data.totals.artifacts} 产物`)
                  : null,
                React.createElement('span', null, fmtBytes(data.totals.bytes)),
              )
              : null,
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', {
              onClick: load,
              title: '重新扫描',
              disabled: loading,
              style: {
                background: 'transparent', border: 'none', color: T.textDim,
                cursor: loading ? 'default' : 'pointer', fontSize: '13px',
                padding: '2px 6px', borderRadius: '4px', lineHeight: 1,
                opacity: loading ? 0.4 : 0.9,
              },
            }, loading ? '⟳' : '🔄'),
            embedded ? null : React.createElement('button', {
              onClick: close,
              title: '关闭',
              style: {
                background: 'transparent', border: 'none', color: T.textDim,
                cursor: 'pointer', fontSize: '13px', padding: '2px 6px',
                borderRadius: '4px', lineHeight: 1,
              },
            }, '✕'),
          ),
          // 主体：左列表右详情
          React.createElement('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
            React.createElement('div', {
              style: {
                width: '42%', minWidth: '200px', maxWidth: '340px',
                borderRight: `1px solid ${T.borderSoft}`,
                display: 'flex', flexDirection: 'column', minHeight: 0,
              },
            },
              React.createElement('div', { style: { padding: '8px 8px 4px', flexShrink: 0 } },
                React.createElement('input', {
                  value: q,
                  onChange: e => setQ(e.target.value),
                  placeholder: locale.brainSearch,
                  style: {
                    width: '100%', boxSizing: 'border-box', padding: '5px 9px',
                    fontSize: '11px', borderRadius: T.radiusSm,
                    border: `1px solid ${T.border}`,
                    background: T.bgRow, color: T.text, outline: 'none',
                  },
                })),
              React.createElement('div', { style: { flex: 1, overflow: 'auto', padding: '0 6px 8px', minHeight: 0 } },
                err
                  ? React.createElement('div', {
                    style: { fontSize: '10.5px', color: T.err, padding: '8px', lineHeight: '16px' },
                  }, `扫描失败：${err}`)
                  : !data
                    ? React.createElement('div', { style: { fontSize: '10.5px', color: T.textMuted, padding: '10px 8px' } }, locale.loading)
                    : filtered.length === 0
                      ? React.createElement(EmptyState, {
                        title: locale.brainEmpty,
                        hint: q.trim() ? '换个关键词，或清空搜索看全部会话。' : null,
                      })
                      : filtered.map(c => React.createElement(ConvRow, {
                        key: `${c.account}/${c.id}`, c,
                        active: sel?.account === c.account && sel?.id === c.id,
                        onOpen: (conv) => setSel({ account: conv.account, id: conv.id }),
                      })),
              ),
            ),
            React.createElement('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              sel
                ? React.createElement(ConvDetail, { key: `${sel.account}/${sel.id}`, locale, account: sel.account, id: sel.id })
                : React.createElement(EmptyState, {
                  title: locale.brainPick,
                  hint: '左边会列出 agy 的全部会话——包括它写出来但你没见过的方案和报告。',
                }),
            ),
          ),
        )

      // embedded 模式下不要胶囊：主列里已经有侧边栏图标在指路，
      // 再飘一个圆按钮只会挡住内容。
      return embedded ? body : React.createElement(React.Fragment, null, pill, body)
    }

    /**
     * composer.dock 里的入口按钮。
     *
     * 与 shell.overlay 的胶囊功能相同，但走另一条 slot 通道：
     * composer.dock 由 chat 包提供，一定存在；shell.overlay 只在 layout 包
     * 加载后才有。两条都挂，任何一条被宿主忽略都还有另一个入口。
     *
     * 刻意不用 react-dom 的 createPortal：那是额外 external，宿主模块表里
     * 未必有它，缺了就整个 bundle 挂掉。面板本身用 position:fixed 就足以
     * 脱离父级 overflow 裁剪，代价只是它在该 slot 的 React 树内。
     */
    function BrainEntryButton({ locale }) {
      const [open, setOpen] = useState(false)
      const [hover, hoverProps] = useHover()
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          onClick: () => setOpen(v => !v),
          title: locale.brainTitle,
          'aria-expanded': open,
          ...hoverProps,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '3px 9px', cursor: 'pointer',
            borderRadius: T.radiusSm, fontSize: '10.5px', lineHeight: '16px',
            border: `1px solid ${open ? T.accent : T.border}`,
            background: open ? T.bgActive : (hover ? T.bgRowHover : 'transparent'),
            color: open ? T.accent : T.textDim,
            transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
          },
        },
          React.createElement('span', { 'aria-hidden': 'true' }, '🗂'),
          React.createElement('span', null, locale.brainTitle),
        ),
        open
          ? React.createElement(BrainBrowser, {
            locale,
            forceOpen: true,
            onClose: () => setOpen(false),
          })
          : null,
      )
    }

    /**
     * 侧边栏图标。
     *
     * sidebar.panellist 只负责「图标 + 标签」，点它主列会切到同名 id 的 main
     * 面板（官方 plugin-manager / schedule 都是 id === key 配对）。所以这里
     * 只需要画一个图标，注意 ownerProps 只给 { size, active }。
     */
    function BrainPanelIcon({ size = 18, active = false }) {
      return React.createElement('span', {
        style: {
          width: size, height: size, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(size * 0.82), lineHeight: 1,
          opacity: active ? 1 : 0.72,
        },
        'aria-hidden': 'true',
      }, '🗂')
    }

    /**
     * 主列里的完整面板。
     *
     * 与悬浮版共用 BrainBrowser，只是去掉胶囊、撑满容器：
     * main 面板拿到的是整块中央区域，胶囊在那里既多余又难看。
     */
    function BrainMainPanel({ locale }) {
      return React.createElement('div', {
        style: {
          width: '100%', height: '100%', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-base, transparent)',
        },
      },
        React.createElement(BrainBrowser, { locale, forceOpen: true, embedded: true }),
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

      // ── 侧边栏面板（主入口）─────────────────────────────────────────────
      // 官方 plugin-manager / schedule 都是这个配对：sidebar.panellist 放图标
      // （id = PANEL_ID），main 放整块面板（key = PANEL_ID）。id 与 key 必须
      // 逐字相同，否则点图标切不到面板。三者共享同一个常量，避免手抖写岔。
      const PANEL_ID = 'dsh-gemini-bridge-brain'

      slots.inject('main', () => {
        const disposer = slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: 'dsh-gemini-bridge',
        }, () => React.createElement(BrainMainPanel, { locale: t }))
        return disposer
      })

      slots.inject('sidebar.panellist', () => {
        const disposer = slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: 'dsh-gemini-bridge',
          label: () => t('brainTitle'),
        }, BrainPanelIcon)
        return disposer
      })

      // agy brain 浏览面板：挂到 frame 级浮动层。
      // shell.overlay 是「additive seat」——新 id 与内置条目并存，层本身
      // click-through，所以面板收起来时完全不挡下面的界面。
      slots.inject('shell.overlay', () => {
        const disposer = slots.register({
          name: 'dsh-gemini-bridge-brain',
          id: 'dsh-gemini-bridge-brain',
          order: 120,
          locale: 'dsh-gemini-bridge',
          inject: ['locale'],
        }, () => React.createElement(BrainBrowser, { locale: t }))
        return disposer
      })

      // 同时在 composer.dock 放一个入口。shell.overlay 只在 layout 包加载后
      // 才存在；composer.dock 由 chat 包提供、必定可用。三条路都挂，
      // 任何一条被宿主吞掉，另一个还在。
      slots.inject('conversation.composer.dock', () => {
        const disposer = slots.register({
          name: 'dsh-gemini-bridge-brain-entry',
          id: 'dsh-gemini-bridge-brain-entry',
          order: 17,
          locale: 'dsh-gemini-bridge',
          inject: ['locale'],
        }, () => React.createElement(BrainEntryButton, { locale: t }))
        return disposer
      })

      console.info('[dsh-gemini-bridge-client] sidebar panel + overlay + composer entry registered')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
