/**
 * Dual-channel router: web Gemini page vs. agy v1internal upstream.
 *
 * Selection rule: an explicit `model` that matches the agy catalog goes to the
 * agy channel; everything else (including the default `gemini-web`) stays on
 * the web channel. One refusal shape for both: the router only returns after
 * the channel's first mapped event can be produced -- guard verdicts, parked
 * accounts and in-band upstream errors all surface as throws BEFORE the server
 * has written any response bytes (learned the expensive way).
 *
 * Event contract consumed by server.mjs:
 *   { delta: {...}, finishReason?: string, usage?: object, done: boolean }
 * `finishReason`/`usage` ride on the terminal event.
 *
 * @module gemini-web-bridge/lib/router
 */

import { AGY_MODELS, AgyUpstreamError } from './agyclient.mjs'
import { resolveWebMode, webModeIds, isWebMode } from './modes.mjs'

const AGY_SET = new Set(AGY_MODELS)

export class Router {
  #config
  #webClient   // existing GeminiWebClient (may be null if web channel disabled)
  #agyClient   // AgyClient (may be null when no agy credential)

  constructor({ config, webClient, agyClient }) {
    this.#config = config
    this.#webClient = webClient
    this.#agyClient = agyClient
  }

  /** Exposed for the manager-facing health route compatibility. */
  get manager() { return this.#webClient?.manager ?? null }

  /** Model list = web modes (only when the web channel exists) + agy catalog. */
  models() {
    const out = this.#webClient ? webModeIds() : []
    if (this.#agyClient) out.push(...AGY_MODELS)
    if (out.length === 0) out.push(this.#config.server?.model ?? 'gemini-web')
    return out
  }

  agyAvailable() {
    return Boolean(this.#agyClient)
  }

  channelFor(model) {
    if (this.#agyClient && AGY_SET.has(model)) return 'agy'
    // Web modes win over agy: their ids/aliases are namespaced (gemini-web*),
    // so an agy id can never collide, and an unknown id still falls through the
    // old "forward unchanged, let upstream 404 honestly" path.
    if (this.#webClient && isWebMode(model)) return 'web'
    if (this.#webClient && (!model || model === this.#config.server?.model)) return 'web'
    // Unknown model names: route to agy if it exists (upstream 404s honestly),
    // else web. Mirrors agyapi's "forward unknown names unchanged" behavior.
    if (this.#agyClient) return 'agy'
    if (this.#webClient) return 'web'
    throw new Error('no upstream channel configured')
  }

  /**
   * Open a completion on the right channel. Returns
   *   { channel, account?, iterator }
   * iterator yields the shared event contract.
   */
  async openCompletion(payload) {
    const model = payload.model
    const channel = this.channelFor(model)

    if (channel === 'agy') {
      const events = this.#agyClient.complete(payload)
      // Pre-fetch the first event so refusals throw before any bytes exist.
      const it = events[Symbol.asyncIterator]()
      const first = await it.next()
      return { channel, iterator: wrap(first, it) }
    }

    // Resolve the web mode here, where the requested id is still known: the
    // client only needs the mode spec, not the routing decision.
    const mode = resolveWebMode(model)
    const opened = await this.#webClient.openCompletion({
      messages: payload.messages ?? [],
      mode: mode?.hash ? mode : null,
    })
    // Web iterator is sync (events are already buffered); normalize shape.
    return {
      channel,
      account: opened.account,
      mode: opened.mode ?? null,
      iterator: normalizeWeb(opened.iterator),
    }
  }

  describeAll() {
    const accounts = this.#webClient?.manager?.describeAll?.() ?? []
    const agy = this.#agyClient?.describe?.() ?? null
    return { accounts, agy }
  }

  pickAccountByName(name) {
    return this.#webClient?.manager?.pickAccountByName?.(name) ?? null
  }

  recovered(name) {
    return this.#webClient?.manager?.recovered?.(name) ?? false
  }

  nextUnpauseInMs() {
    return this.#webClient?.manager?.nextUnpauseInMs?.() ?? 0
  }

  /** Resume one parked agy pool account (human re-login happened). */
  agyResume(id) {
    return this.#agyClient?.poolResume?.(id) ?? false
  }
}

/** async-generator tail: first (already-pulled) value, then the rest. */
async function* wrap(first, it) {
  if (!first.done) yield first.value
  for (;;) {
    const next = await it.next()
    if (next.done) return
    yield next.value
  }
}

/** Sync web iterator -> async, tagging the terminal event with finish/usage. */
async function* normalizeWeb(syncIterator) {
  let text = ''
  for (;;) {
    const { value, done } = syncIterator.next()
    if (done) break
    if (!value.done) text += value.delta
  }
  if (text) yield { delta: { content: text }, done: false }
  yield { delta: {}, finishReason: 'stop', usage: null, done: true }
}

export { AgyUpstreamError }
