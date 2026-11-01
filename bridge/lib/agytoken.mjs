/**
 * agy OAuth token custody.
 *
 * Sources, in priority order (both shapes verified on this machine by
 * tools/probe-agy-upstream.ps1):
 *   1. file    ~/.gemini/antigravity-cli/antigravity-oauth-token
 *              JSON: { token: { access_token, refresh_token, expiry, expires_in }, ... }
 *   2. keyring Windows Credential target "gemini:antigravity" (same JSON blob).
 *
 * Rules carried in from the ban post-mortem and agyapi's notes:
 *   - Google ROTATES the refresh token on every refresh. The store therefore
 *     re-reads its source before every refresh, and on write-back adopts the
 *     freshest sibling state (the running agy CLI may have refreshed while we
 *     were not looking). Stale-overwrite would revoke the CLI's own session.
 *   - Write-back is atomic (tmp + rename) and only when the file source is
 *     what we read from. Keyring writes go through credman writeback only if
 *     explicitly enabled; default is read-only against the keyring and a
 *     cache file next to our own state (so we never clobber agy's credential).
 *
 * @module gemini-web-bridge/lib/agytoken
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULT_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

/** OAuth client id/secret agy ships (installed-app class, from agyapi defaults). */
const OAUTH_CLIENT_ID = '1071109997792-tfm8gGHsmnlq9u0bgnzqdc3q5gmf0q9k.apps.googleusercontent.com'
const OAUTH_CLIENT_SECRET = 'REscO3o8l4TMQAmVCS6T9Iqn'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export class AgyTokenStore {
  #tokenFile
  #cacheFile      // our OWN copy, written after refresh; read back on restart
  #allowKeyring
  #current = null // { access_token, refresh_token, expiryMs }

  constructor({ tokenFile = DEFAULT_FILE, cacheFile, allowKeyring = true } = {}) {
    this.#tokenFile = tokenFile
    this.#cacheFile = cacheFile ?? path.join(os.homedir(), '.dsh-gemini-bridge', 'agy-token-cache.json')
    this.#allowKeyring = allowKeyring
  }

  /** Every readable source's blob, freshest-guess first (cache → file → keyring). */
  #allSources() {
    const out = []
    for (const file of [this.#cacheFile, this.#tokenFile]) {
      try {
        if (fs.existsSync(file)) {
          const json = JSON.parse(fs.readFileSync(file, 'utf8'))
          const t = json.token ?? json
          if (t.access_token && t.refresh_token) out.push({ source: file, ...t })
        }
      } catch { /* malformed: skip this source */ }
    }
    const blob = this.#allowKeyring ? readKeyring('gemini:antigravity') : null
    if (blob) {
      try {
        const json = JSON.parse(blob)
        const t = json.token ?? json
        if (t.access_token && t.refresh_token) out.push({ source: 'keyring', ...t })
      } catch { /* not JSON; ignore */ }
    }
    return out
  }

  /** Read the freshest available blob without refreshing anything. */
  #readSource() {
    return this.#allSources()[0] ?? null
  }

  /** True when the access token is within 60 s of expiry (or unknown). */
  #nearExpiry(t) {
    if (!t) return true
    if (t.expiryMs) return Date.now() > t.expiryMs - 60_000
    // File blobs carry an ISO-ish `expiry` string; parse best-effort.
    if (t.expiry) {
      const ms = Date.parse(t.expiry)
      if (!Number.isNaN(ms)) return Date.now() > ms - 60_000
    }
    return true
  }

  /**
   * Get a usable access token, refreshing through Google if needed.
   * Re-reads the source first EVERY time (agy CLI and we may race on rotation).
   */
  async accessToken() {
    const fresh = this.#readSource()
    if (fresh && !this.#nearExpiry(fresh)) {
      this.#current = { ...fresh, expiryMs: fresh.expiry ? Date.parse(fresh.expiry) : 0 }
      return fresh.access_token
    }

    const candidate = fresh ?? this.#current
    if (!candidate?.refresh_token) {
      throw Object.assign(new Error('no agy credential found (checked cache, file, keyring)'), { code: 'NO_TOKEN' })
    }
    return this.#doRefresh(candidate)
  }

  /**
   * Skip the freshness check and refresh now (client calls this after an
   * upstream 401 -- the token *looked* valid but the server disagreed).
   */
  async forceRefresh() {
    const source = this.#readSource() ?? this.#current
    if (!source?.refresh_token) {
      throw Object.assign(new Error('no agy credential to refresh'), { code: 'NO_TOKEN' })
    }
    return this.#doRefresh(source)
  }

  async #doRefresh(candidate) {
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: candidate.refresh_token,
      grant_type: 'refresh_token',
    })
    let reply
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      })
      reply = await res.json()
      if (!res.ok || reply.error) {
        // invalid_grant means the refresh token we held was already rotated by
        // another party (the CLI) -- our cached copy is dead. Re-read the
        // sources once; if a source carries a NEWER refresh token, adopt it.
        const again = this.#readSource()
        if (again && again.refresh_token !== candidate.refresh_token && !this.#nearExpiry(again)) {
          this.#current = again
          return again.access_token
        }
        throw Object.assign(new Error(`refresh failed: ${reply.error_description ?? reply.error ?? res.status}`), { code: 'REFRESH_FAILED' })
      }
    } catch (err) {
      if (err.code === 'REFRESH_FAILED') throw err
      throw Object.assign(new Error(`refresh transport error: ${err.message}`), { code: 'REFRESH_FAILED' })
    }

    const next = {
      source: candidate.source,
      access_token: reply.access_token,
      refresh_token: reply.refresh_token ?? candidate.refresh_token, // Google may rotate
      expiryMs: Date.now() + (reply.expires_in ?? 3599) * 1000,
    }
    this.#current = next
    this.#writeCache(next)
    return next.access_token
  }

  #writeCache(t) {
    try {
      fs.mkdirSync(path.dirname(this.#cacheFile), { recursive: true })
      const tmp = `${this.#cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({
        token: {
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expiry: new Date(t.expiryMs).toISOString(),
          expires_in: Math.round((t.expiryMs - Date.now()) / 1000),
        },
      }), { mode: 0o600 })
      fs.renameSync(tmp, this.#cacheFile)
    } catch {
      // A cache that cannot be written only costs us the next restart; the
      // in-memory copy still serves this process. Do not fail the request.
    }
  }

  describe() {
    const src = this.#current?.source ?? null
    return {
      loaded: Boolean(this.#current?.access_token),
      source: typeof src === 'string' && src.startsWith('keyring') ? 'keyring:gemini:antigravity' : src,
      expiry: this.#current?.expiryMs ? new Date(this.#current.expiryMs).toISOString() : null,
    }
  }
}

// ---------------------------------------------------------------------------
// Windows keyring reader (advapi32 CredReadW). Non-Windows: returns null.
// ---------------------------------------------------------------------------

let keyringModule = null
function readKeyring(target) {
  if (process.platform !== 'win32') return null
  try {
    if (!keyringModule) keyringModule = loadKeyringBindings()
    return keyringModule.read(target)
  } catch {
    return null
  }
}

function loadKeyringBindings() {
  // koffi/ffi is not a dependency of this project; instead shell out to
  // PowerShell with the P/Invoke reader and capture stdout per call. The value
  // passes through stdout as one line; callers JSON-parse it. Kept deliberately
  // small so the token never lands in a file or log of ours.
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class C {',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CR { public int Flags; public int Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string t,int ty,int f,out IntPtr p);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);',
    '  public static string R(string t){ IntPtr p; if(!CredRead(t,1,0,out p)) return null; try{ CR c=(CR)Marshal.PtrToStructure(p,typeof(CR)); byte[] b=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,b,0,b.Length); return System.Text.Encoding.UTF8.GetString(b);} finally{ CredFree(p);} }',
    '}',
    '"@',
    '[C]::R($args[0])',
  ].join('\n')
  return {
    read(target) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script, target], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 64,
      })
      return out.trim() || null
    },
  }
}
