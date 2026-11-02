/**
 * Gemini web modes: the account-level model selector behind the composer pill.
 *
 * WHAT THIS IS
 * ------------
 * gemini.google.com/app does not carry the model in the StreamGenerate payload.
 * The model is *account state*, read from the pill button in the composer
 * ("打开模式选择器，当前模式为"Pro"") and changed by a separate batchexecute RPC.
 * So a bridge that only POSTs StreamGenerate silently always uses whatever the
 * account was last set to — which is exactly why "网页端没办法切换模型" was true
 * even though the bridge looked fine.
 *
 * MEASURED WIRE FORMAT (pro2 / pro3, 2026-11)
 * ------------------------------------------
 *   POST /_/BardChatUi/data/batchexecute?rpcids=L5adhe&source-path=/app&bl=…&f.sid=…&hl=…&_reqid=…&rt=c
 *   body: f.req=[[["L5adhe","<inner-json>",null,"generic"]]]&at=<SNlM0e>
 *
 *   inner-json = JSON.stringify([arr0, null, [arr0.length]])
 *   arr0 is a sparse array; the ONLY meaningful index is 99:
 *       arr0 = new Array(100).fill(null); arr0[99] = "<16-hex model id>"
 *
 * The 16-hex ids are stable per model and were verified by setting each one and
 * reloading the app (the pill then reads Flash-Lite / Flash / Pro / Argon):
 *   8c46e95b1a07cecc  3.5 Flash-Lite
 *   56fdd199312815e2  3.8 Flash
 *   e6fa609c3fa255c0  3.1 Pro
 *   95a4c0abcba24364  4 Argon
 *
 * `f.sid` is `WIZ_global_data.FdrFJe` (a bare negative integer — NOT the build
 * label; `bl` is `WIZ_global_data.cfb2h`). Passing the build label as f.sid
 * still returns 200, so a wrong guess fails silently: verify by reading the
 * pill back, never by trusting the status code.
 *
 * THINKING LEVEL is a second axis: arr0 length 265 with index 264 set
 * (2 = high / 4 = medium, observed from the UI). It only exists on models that
 * publish it (Argon), so it is best-effort: we never fail a request over it.
 *
 * DOES THE SWITCH ACTUALLY REACH STREAMGENERATE? (measured, not assumed)
 * ---------------------------------------------------------------------
 * Yes — but the evidence is NOT the model name and NOT the answer length, and
 * both of those look like proof that it does nothing:
 *
 *   - The response occasionally echoes `"3.5 Flash-Lite"` in the action-hint
 *     block regardless of the account mode. It is a UI string, not a model id.
 *     Treating it as ground truth is the single most misleading signal here.
 *   - Answer length, latency and answer correctness across 4 AIME-style items
 *     were indistinguishable (both modes 4/4, both 2-char answers).
 *
 * What DOES separate the modes is the TOOLCHAIN in the response. Three neutral
 * prompts that need both computation and lookup, summed per mode:
 *
 *     mode         data_analysis_tool   python    google
 *     Flash-Lite            6             34       198
 *     Pro                   6             28       168
 *     Argon                12             74       204
 *
 * Argon makes ~2.2x the python calls and 2x the analysis-tool calls of
 * Flash-Lite on identical prompts. Tool availability is a tier attribute, so
 * that difference is the mode. Use this probe
 * (`bridge/tools/probe-toolchain.mjs`) to re-verify; do not use length.
 *
 * One caveat worth knowing: a pill switch takes effect for the NEXT request.
 * The composer button does not repaint on an out-of-band RPC, so the pill can
 * still read the old mode right after a successful switch — that is a display
 * lag, not a failed switch. `probe-ui-select.mjs` shows the UI path, where
 * clicking menu item N and reloading lands the pill on N every time.
 *
 * @module gemini-web-bridge/lib/modes
 */

/**
 * The four composer modes, keyed by the id we expose over OpenAI (`model`).
 *
 * `aliases` exist because the pill labels are localised and versioned; the
 * underlying 16-hex id is what the server actually honours, so the id is the
 * only thing that needs to be exact.
 */
export const WEB_MODES = [
  {
    id: 'gemini-web',
    hash: null,                     // null = "leave the account where it is"
    label: 'Flash-Lite',
    name: 'Gemini 网页端（跟随账号当前模式）',
    aliases: [],
  },
  {
    id: 'gemini-web-flash-lite',
    hash: '8c46e95b1a07cecc',
    label: 'Flash-Lite',
    name: 'Gemini 3.5 Flash-Lite（网页）',
    // No `gemini-3.5-flash-lite` alias: that is a REAL agy model id, and
    // claiming it here would silently route an agy request to the web channel.
    aliases: ['flash-lite', 'flashlite'],
  },
  {
    id: 'gemini-web-flash',
    hash: '56fdd199312815e2',
    label: 'Flash',
    name: 'Gemini 3.8 Flash（网页）',
    aliases: ['flash', 'gemini-3.8-flash', 'gemini-3.8-flash-web'],
  },
  {
    id: 'gemini-web-pro',
    hash: 'e6fa609c3fa255c0',
    label: 'Pro',
    name: 'Gemini 3.1 Pro（网页）',
    aliases: ['pro', 'gemini-3.1-pro'],
  },
  {
    id: 'gemini-web-argon',
    hash: '95a4c0abcba24364',
    label: 'Argon',
    name: 'Gemini 4 Argon（网页）',
    aliases: ['argon', 'gemini-4-argon'],
  },
]

/**
 * Model ids that belong to the web channel (both canonical and aliases).
 *
 * Anything unknown is NOT a web mode — returning true for unknown ids would
 * capture every agy model into the web branch. The router already treats the
 * default/empty id as web, so that case does not need to be handled here.
 */
export function isWebMode(model) {
  if (typeof model !== 'string' || model.trim() === '') return true  // '' = default
  const norm = model.trim().toLowerCase()
  return WEB_MODES.some((m) => m.id === norm || m.aliases.includes(norm))
}

/** Resolve any accepted spelling to a WEB_MODES entry (or null). */
export function resolveWebMode(model) {
  if (typeof model !== 'string' || model.trim() === '') return WEB_MODES[0]
  const norm = model.trim().toLowerCase()
  return WEB_MODES.find((m) => m.id === norm || m.aliases.includes(norm)) ?? null
}

/** Ids to advertise on /v1/models for the web channel. */
export function webModeIds() {
  return WEB_MODES.map((m) => m.id)
}

/** Map an applied 16-hex hash back to its human label (for /health). */
export function labelForHash(hash) {
  if (typeof hash !== 'string' || hash === '') return null
  return WEB_MODES.find((m) => m.hash === hash)?.label ?? null
}

/**
 * The pill's current mode, read from the composer button.
 *
 * Returns the mode word ("Pro", "Flash-Lite", …) or null.
 *
 * Two measured shapes have to be handled, and getting this wrong is silent:
 *   zh UI: 打开模式选择器，当前模式为“Pro”    (fullwidth quotes)
 *   en UI: Open mode picker, currently "Pro"  (ASCII quotes)
 * The first version only matched the fullwidth pair, so on an English UI the
 * parse returned the WHOLE aria-label, `labelMatches` then never matched, and
 * `applyMode` re-sent the switch on every single request. That looked like
 * "switching works" in the ACK while the account never actually moved.
 *
 * The button's own textContent is the bare mode word, so it is used as a
 * second opinion when no quote pair is found.
 */
export const READ_PILL_JS = `
  (() => {
    const b = document.querySelector('button.input-area-switch');
    if (!b) return null;
    const raw = b.getAttribute('aria-label') || '';
    // Any quote style, in one pass: fullwidth “”, curly “”, ASCII ".
    const quoted = raw.match(/[“"']([^”"']+)[”"']/);
    if (quoted && quoted[1].trim()) return quoted[1].trim();
    const text = (b.textContent || '').replace(/\\s+/g, ' ').trim();
    return text || (raw.trim() || null);
  })()
`

/**
 * Build the batchexecute call that sets a mode.
 *
 * Kept as a page-evaluated expression (not a Node fetch) for the same reason
 * every other upstream call is: the TLS/HTTP2 fingerprint and the cookies have
 * to come from Chromium, and `at` must be the live SNlM0e.
 *
 * `thinkingLevel` is optional; when given, the array is widened to 265 cells and
 * index 264 carries the value, which is how the UI encodes it.
 */
export function setModeExpression(hash, thinkingLevel = null) {
  const width = thinkingLevel === null ? 100 : 265
  const payload = {
    hash,
    width,
    level: thinkingLevel,
  }
  return `
  (async () => {
    const spec = ${JSON.stringify(payload)};
    const w = window.WIZ_global_data || {};
    const at = w.SNlM0e;
    const bl = w.cfb2h || '';
    const sid = w.FdrFJe || '';
    if (!at) return JSON.stringify({ error: 'no-snlm0e' });

    const arr = new Array(spec.width).fill(null);
    arr[99] = spec.hash;
    if (spec.level !== null) arr[264] = spec.level;

    const params = new URLSearchParams({
      rpcids: 'L5adhe',
      'source-path': '/app',
      bl,
      'f.sid': sid,
      hl: 'en',
      _reqid: String(Math.floor(Math.random() * 9000000) + 1000000),
      rt: 'c',
    });
    try {
      const r = await fetch('/_/BardChatUi/data/batchexecute?' + params, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({
          'f.req': JSON.stringify([[[ 'L5adhe', JSON.stringify([arr, null, [spec.width]]), null, 'generic' ]]]),
          at,
        }).toString(),
        credentials: 'include',
      });
      const text = await r.text();
      // The RPC answers "[1]" on success and "[[]]" for an unknown hash. A 200
      // proves nothing either way, so the caller re-reads the pill.
      const m = text.match(/"wrb\\.fr","L5adhe","([^"]*)"/);
      return JSON.stringify({ status: r.status, ack: m ? m[1] : null });
    } catch (e) {
      return JSON.stringify({ error: String(e && e.message || e) });
    }
  })()
  `
}

/**
 * Compare two pill labels loosely enough for localisation, tightly enough to
 * never confuse neighbouring tiers.
 *
 * The pill may read "3.1 Pro" where we asked for "Pro" (version prefix), or
 * "Flash-Lite" where the catalog says "flash lite" (case + separator). A plain
 * substring test looked sufficient and is not: "flash-lite" CONTAINS "flash",
 * so `labelMatches('Flash-Lite', 'Flash')` was true — meaning the bridge would
 * believe it had switched to Flash while the account sat on Flash-Lite, and
 * never correct it. That is a silent wrong-model bug, so the containment test
 * has to be boundary-aware: a label may only be treated as matching when the
 * remainder is a plain version/number prefix, not another tier word.
 */

/** Tier words that must never be treated as a benign prefix/suffix. */
const TIER_WORDS = ['flashlite', 'flash', 'pro', 'argon', 'thinking', 'lite']

export function labelMatches(pillLabel, modeLabel) {
  if (typeof pillLabel !== 'string' || typeof modeLabel !== 'string') return false
  const norm = (s) => s.toLowerCase().replace(/[\s\-_]+/g, '').trim()
  const pill = norm(pillLabel)
  const want = norm(modeLabel)
  if (pill === '' || want === '') return false
  if (pill === want) return true

  // One side is a version-prefixed form of the other ("3.1pro" vs "pro").
  // Strip a leading version/number run, then require exact equality.
  const stripVersion = (s) => s.replace(/^\d+(\.\d+)*/, '')
  if (stripVersion(pill) === stripVersion(want)) return true

  // Otherwise allow containment ONLY when the extra part is not another tier.
  const contains = (hay, needle) => {
    if (!hay.includes(needle)) return false
    // Any other tier word appearing inside the remainder means a different model.
    for (const t of TIER_WORDS) {
      if (t === needle) continue
      if (t.includes(needle)) continue          // "flash" is part of "flashlite"
      if (hay.includes(t)) return false         // e.g. hay=flashlite, needle=flash
    }
    return true
  }
  return contains(pill, want) || contains(want, pill)
}
