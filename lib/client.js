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

    // ── agy brain 浏览器 ────────────────────────────────────────────────────
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

    /** 小胶囊按钮：面板收起时的入口。 */
    function BrainPill({ locale, totals, open, onToggle }) {
      const has = totals && totals.conversations > 0
      return React.createElement('div', {
        style: {
          position: 'fixed', right: '14px', bottom: '76px',
          pointerEvents: 'auto', zIndex: 1,
        },
      }, React.createElement('button', {
        onClick: onToggle,
        title: locale.brainTitle,
        style: {
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '6px 10px', borderRadius: '999px', cursor: 'pointer',
          border: '1px solid rgba(150,150,150,0.35)',
          background: open ? 'rgba(70,130,220,0.92)' : 'rgba(40,44,52,0.88)',
          color: '#fff', fontSize: '11px', lineHeight: '16px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
        },
      },
        React.createElement('span', null, '🗂'),
        React.createElement('span', null, locale.brainTitle),
        has ? React.createElement('span', { style: { opacity: 0.72 } }, String(totals.conversations)) : null,
      ))
    }

    /** 单个会话行。 */
    function ConvRow({ c, active, onOpen }) {
      const bits = []
      if (c.artifacts?.length) bits.push(`${c.artifacts.length} ${KIND_LABEL.artifact}`)
      if (c.toolOutputs) bits.push(`${c.toolOutputs} 输出`)
      if (c.subagents) bits.push(`${c.subagents} 子代理`)
      if (c.tokens?.output) bits.push(`${fmtNum(c.tokens.output)} tok`)
      return React.createElement('div', {
        onClick: () => onOpen(c),
        style: {
          padding: '7px 9px', borderRadius: '6px', cursor: 'pointer', marginBottom: '3px',
          background: active ? 'rgba(70,130,220,0.20)' : 'transparent',
          border: active ? '1px solid rgba(70,130,220,0.5)' : '1px solid transparent',
        },
      },
        React.createElement('div', {
          style: { fontSize: '11.5px', lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: c.title || c.id,
        }, c.title || `(无标题) ${c.id.slice(0, 8)}`),
        React.createElement('div', {
          style: { fontSize: '9.5px', opacity: 0.55, marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap' },
        },
          React.createElement('span', null, c.account.replace(/^acc_\d+_/, '').slice(0, 12)),
          React.createElement('span', null, fmtAgo(c.lastAt || (c.mtime ? new Date(c.mtime).toISOString() : ''))),
          React.createElement('span', null, `${c.fileCount} 文件`),
          bits.length ? React.createElement('span', { style: { color: '#7fb2ff' } }, bits.join(' · ')) : null,
        ),
      )
    }

    /** 对话时间线里的一条消息。 */
    function MsgBlock({ m }) {
      const [showThink, setShowThink] = useState(false)
      const isUser = m.type === 'USER_INPUT'
      const isPlanner = m.type === 'PLANNER_RESPONSE'
      const who = isUser ? '用户' : isPlanner ? '模型' : m.type
      const color = isUser ? '#7fb2ff' : isPlanner ? '#9ae6a0' : 'rgba(180,180,180,0.8)'

      // 用户输入里塞满元数据标签，显示时剥掉只留正文
      let body = m.content || ''
      const req = body.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
      if (req) body = req[1]
      const cur = body.match(/\[CURRENT REQUEST[^\]]*\]([\s\S]*)$/)
      if (cur) body = cur[1]

      return React.createElement('div', {
        style: { marginBottom: '8px', borderLeft: `2px solid ${color}`, paddingLeft: '8px' },
      },
        React.createElement('div', {
          style: { fontSize: '9.5px', opacity: 0.6, display: 'flex', gap: '8px', marginBottom: '2px' },
        },
          React.createElement('span', { style: { color, fontWeight: 600 } }, who),
          React.createElement('span', null, `#${m.step}`),
          m.at ? React.createElement('span', null, m.at.slice(11, 19)) : null,
          m.tokens?.output ? React.createElement('span', null, `${m.tokens.output} tok`) : null,
          m.toolCalls?.length
            ? React.createElement('span', { style: { color: '#e0b060' } }, `🔧 ${m.toolCalls.map(tc => tc.name).filter(Boolean).join(', ').slice(0, 60)}`)
            : null,
        ),
        body.trim()
          ? React.createElement('div', {
            style: { fontSize: '11px', lineHeight: '17px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflow: 'auto' },
          }, body.trim().slice(0, 4000))
          : null,
        m.thinking?.trim()
          ? React.createElement('div', { style: { marginTop: '3px' } },
            React.createElement('span', {
              onClick: () => setShowThink(v => !v),
              style: { fontSize: '9.5px', opacity: 0.55, cursor: 'pointer', userSelect: 'none' },
            }, showThink ? '▾ 思考过程' : '▸ 思考过程'),
            showThink
              ? React.createElement('div', {
                style: { fontSize: '10px', lineHeight: '15px', opacity: 0.65, whiteSpace: 'pre-wrap', marginTop: '3px', maxHeight: '200px', overflow: 'auto', fontStyle: 'italic' },
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

      if (err) return React.createElement('div', { style: { fontSize: '11px', color: '#ff8a8a', padding: '8px' } }, `读取失败：${err}`)
      if (!detail) return React.createElement('div', { style: { fontSize: '11px', opacity: 0.6, padding: '8px' } }, locale.loading)

      const artifactFiles = detail.files.filter(f => f.kind === 'artifact')
      const unknownFiles = detail.files.filter(f => f.kind === 'unknown')
      const otherFiles = detail.files.filter(f => f.kind !== 'artifact' && f.kind !== 'unknown')

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        // 头部：标题 + 统计
        React.createElement('div', { style: { padding: '6px 8px', borderBottom: '1px solid rgba(150,150,150,0.2)' } },
          React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, detail.title || '(无标题)'),
          React.createElement('div', { style: { fontSize: '9.5px', opacity: 0.55 } },
            `${detail.summary.steps} 步 · ${detail.files.length} 文件 · ${fmtNum(detail.summary.tokens.output)} output tok · ${fmtNum(detail.summary.tokens.cacheRead)} cache`),
        ),
        // Tab
        React.createElement('div', { style: { display: 'flex', gap: '4px', padding: '6px 8px' } },
          ...[['files', `文件 (${artifactFiles.length}/${detail.files.length})`], ['chat', `对话 (${detail.messages.length})`]].map(([k, label]) =>
            React.createElement('button', {
              key: k,
              onClick: () => setTab(k),
              style: {
                flex: 1, padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '10.5px',
                border: '1px solid rgba(150,150,150,0.3)',
                background: tab === k ? 'rgba(70,130,220,0.28)' : 'transparent',
                color: 'inherit',
              },
            }, label)),
        ),
        // 内容区
        React.createElement('div', { style: { flex: 1, overflow: 'auto', padding: '0 8px 8px', minHeight: 0 } },
          tab === 'files'
            ? React.createElement('div', null,
              artifactFiles.length
                ? React.createElement('div', { style: { marginBottom: '8px' } },
                  React.createElement('div', { style: { fontSize: '9.5px', opacity: 0.5, margin: '4px 0' } }, 'agy 写出的产物'),
                  ...artifactFiles.map(f => React.createElement('div', {
                    key: f.rel,
                    onClick: () => openFile(f),
                    style: {
                      padding: '5px 7px', borderRadius: '5px', cursor: 'pointer', marginBottom: '2px',
                      background: file?.path === f.rel ? 'rgba(70,130,220,0.2)' : 'rgba(150,150,150,0.08)',
                      display: 'flex', justifyContent: 'space-between', gap: '8px',
                    },
                  },
                    React.createElement('span', { style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `📄 ${f.rel}`),
                    React.createElement('span', { style: { fontSize: '9.5px', opacity: 0.5, flexShrink: 0 } }, fmtBytes(f.size)),
                  )))
                : React.createElement('div', { style: { fontSize: '10.5px', opacity: 0.5, padding: '6px 0' } }, '这个会话没有 agy 产物文件'),
              React.createElement('div', { style: { fontSize: '9.5px', opacity: 0.5, margin: '8px 0 4px' } }, '内部文件'),
              ...otherFiles.slice(0, 80).map(f => React.createElement('div', {
                key: f.rel,
                onClick: () => openFile(f),
                style: { padding: '3px 7px', fontSize: '10px', opacity: 0.72, cursor: 'pointer', borderRadius: '4px' },
              }, `${KIND_LABEL[f.kind] ?? f.kind} · ${f.rel}`)),
              otherFiles.length > 80
                ? React.createElement('div', { style: { fontSize: '9.5px', opacity: 0.45, padding: '4px 7px' } }, `…还有 ${otherFiles.length - 80} 个`)
                : null,
              // agy 以后可能加新目录/新格式。这里始终把它们列出来，
              // 而不是因为「不认识」就静默丢掉——看不见的类型才是真问题。
              unknownFiles.length
                ? React.createElement('div', { style: { marginTop: '10px', borderTop: '1px dashed rgba(224,176,96,0.4)', paddingTop: '6px' } },
                  React.createElement('div', { style: { fontSize: '9.5px', color: '#e0b060', marginBottom: '3px' } },
                    `未识别类型 (${unknownFiles.length}) — agy 新目录，点开即可看内容`),
                  ...unknownFiles.slice(0, 60).map(f => React.createElement('div', {
                    key: f.rel,
                    onClick: () => openFile(f),
                    style: { padding: '3px 7px', fontSize: '10px', opacity: 0.68, cursor: 'pointer', borderRadius: '4px' },
                  }, `? ${f.rel}  (${fmtBytes(f.size)})`)),
                )
                : null,
            )
            : React.createElement('div', null,
              ...detail.messages.map(m => React.createElement(MsgBlock, { key: m.step, m })),
            ),
        ),
        // 文件预览抽屉
        file
          ? React.createElement('div', {
            style: {
              borderTop: '1px solid rgba(150,150,150,0.25)', maxHeight: '42%',
              overflow: 'auto', padding: '6px 8px', background: 'rgba(0,0,0,0.18)',
            },
          },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } },
              React.createElement('span', { style: { fontSize: '10px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.path),
              React.createElement('span', {
                onClick: () => setFile(null),
                style: { fontSize: '10px', cursor: 'pointer', opacity: 0.6, flexShrink: 0, paddingLeft: '8px' },
              }, '✕'),
            ),
            file.loading
              ? React.createElement('div', { style: { fontSize: '10px', opacity: 0.6 } }, locale.loading)
              : file.error
                ? React.createElement('div', { style: { fontSize: '10px', color: '#ff8a8a' } }, file.error)
                : file.note && !file.content
                  ? React.createElement('div', { style: { fontSize: '10px', opacity: 0.6 } }, file.note)
                  : React.createElement('pre', {
                    style: { fontSize: '10px', lineHeight: '15px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 },
                  }, file.content))
          : null,
      )
    }

    /** 顶层：胶囊 + 展开面板。 */
    function BrainBrowser({ locale }) {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [sel, setSel] = useState(null)
      const [q, setQ] = useState('')
      const [loading, setLoading] = useState(false)

      const load = () => {
        setLoading(true)
        fetch(BRAIN_PATH, { signal: AbortSignal.timeout(20000) })
          .then(r => r.json())
          .then(d => { if (d.error) setErr(d.error); else { setData(d); setErr(null) } })
          .catch(e => setErr(String(e.message ?? e)))
          .finally(() => setLoading(false))
      }

      useEffect(() => { if (open && !data) load() }, [open])

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

      if (!open) return pill

      return React.createElement(React.Fragment, null,
        pill,
        React.createElement('div', {
          style: {
            position: 'fixed', right: '14px', bottom: '112px',
            width: 'min(760px, calc(100vw - 28px))',
            height: 'min(560px, calc(100vh - 140px))',
            display: 'flex', flexDirection: 'column',
            pointerEvents: 'auto', zIndex: 2,
            background: 'rgba(28,30,36,0.97)', color: 'rgba(235,235,240,0.95)',
            border: '1px solid rgba(150,150,150,0.3)', borderRadius: '10px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
          },
        },
          // 标题栏
          React.createElement('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 10px', borderBottom: '1px solid rgba(150,150,150,0.22)',
            },
          },
            React.createElement('span', { style: { fontSize: '12px', fontWeight: 600 } }, locale.brainTitle),
            data
              ? React.createElement('span', { style: { fontSize: '9.5px', opacity: 0.55 } },
                `${data.totals.accounts} 账号 · ${data.totals.conversations} 会话 · ${data.totals.artifacts} 产物 · ${fmtBytes(data.totals.bytes)}`)
              : null,
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', {
              onClick: load,
              title: '重新扫描',
              style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '12px', opacity: loading ? 0.4 : 0.75 },
            }, loading ? '⟳' : '🔄'),
            React.createElement('button', {
              onClick: () => setOpen(false),
              style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '13px', opacity: 0.7 },
            }, '✕'),
          ),
          // 主体：左列表右详情
          React.createElement('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
            React.createElement('div', {
              style: { width: '44%', minWidth: '210px', borderRight: '1px solid rgba(150,150,150,0.2)', display: 'flex', flexDirection: 'column', minHeight: 0 },
            },
              React.createElement('div', { style: { padding: '6px 8px' } },
                React.createElement('input', {
                  value: q,
                  onChange: e => setQ(e.target.value),
                  placeholder: locale.brainSearch,
                  style: {
                    width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: '11px',
                    borderRadius: '5px', border: '1px solid rgba(150,150,150,0.3)',
                    background: 'rgba(0,0,0,0.25)', color: 'inherit', outline: 'none',
                  },
                })),
              React.createElement('div', { style: { flex: 1, overflow: 'auto', padding: '0 6px 8px', minHeight: 0 } },
                err
                  ? React.createElement('div', { style: { fontSize: '10.5px', color: '#ff8a8a', padding: '6px' } }, `扫描失败：${err}`)
                  : !data
                    ? React.createElement('div', { style: { fontSize: '10.5px', opacity: 0.6, padding: '6px' } }, locale.loading)
                    : filtered.length === 0
                      ? React.createElement('div', { style: { fontSize: '10.5px', opacity: 0.5, padding: '6px' } }, locale.brainEmpty)
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
                : React.createElement('div', { style: { fontSize: '11px', opacity: 0.45, padding: '16px', textAlign: 'center' } }, locale.brainPick),
            ),
          ),
        ),
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

      console.info('[dsh-gemini-bridge-client] usage card + agy brain browser registered')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
