# probe-agy-upstream.ps1 — 验证 agy 地区锁是否只是客户端闸门
#
# 已实测结论（2026-11-01，本账号）：HTTP 200 + 真实回显 REGION_GATE_IS_COSMETIC。
# 地区锁确认纯客户端；本脚本保留作为回归探针（agyapi 路线改协议后可再跑一次）。
#
# 步骤：
#   1) 取 agy OAuth token：文件优先（~\.gemini\antigravity-cli\antigravity-oauth-token，
#      形状 token.access_token / token.refresh_token / token.expiry 已实测匹配），
#      凭据管理器 'gemini:antigravity' 兜底。
#   2) 直接 POST /v1internal:streamGenerateContent，不经 CLI；access 过期先 refresh。
#   3) 200 + candidates → 地区锁纯客户端，agyapi 路线对该账号成立。
#      403 VALIDATION_REQUIRED → 先过 validation_url 验证再重测。
#
# 用法（必须 pwsh 7；Windows PowerShell 5.1 对本文件的 here-string 解析有 bug）：
#   pwsh -ExecutionPolicy Bypass -File probe-agy-upstream.ps1
# 注意：token 只在本机内存里用，脚本不打印、不落盘任何 token 值。

param(
  [string]$TokenFile = "$env:USERPROFILE\.gemini\antigravity-cli\antigravity-oauth-token"
)
$ErrorActionPreference = 'Stop'

# ── 1. 取 token ───────────────────────────────────────────────────────────
$tok = $null
if (Test-Path $TokenFile) {
  $tok = Get-Content $TokenFile -Raw | ConvertFrom-Json
  Write-Host '[ok] token source: file'
}
if (-not $tok) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return null; // ERROR_NOT_FOUND
      throw new Exception("CredRead failed: " + e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
      return System.Text.Encoding.UTF8.GetString(blob);
    } finally { CredFree(p); }
  }
}
'@
  foreach ($t in @('gemini:antigravity')) {
    $raw = [CredMan]::Read($t)
    if ($raw) { $tok = $raw | ConvertFrom-Json; Write-Host "[ok] token source: credential '$t'"; break }
  }
}
if (-not $tok) { Write-Host '[!] 未找到 agy token（文件和凭据都落空）'; exit 2 }

$access = $tok.token.access_token
if (-not $access) { Write-Host '[!] blob/文件里没有 token.access_token，形状变了'; exit 2 }

# ── 2. access 过期先 refresh（blob 自带 refresh_token + expires_in=3599）──
function Refresh-Access {
  param($tokObj)
  $body = @{
    client_id    = '1071109997792-tfm8gGHsmnlq9u0bgnzqdc3q5gmf0q9k.apps.googleusercontent.com'
    client_secret = 'REscO3o8l4TMQAmVCS6T9Iqn'
    refresh_token = $tokObj.token.refresh_token
    grant_type   = 'refresh_token'
  }
  $r = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' `
    -ContentType 'application/x-www-form-urlencoded' `
    -Body ($body | ConvertTo-Json -Compress)
  # 只更新内存，不写回任何文件——探针不留痕。
  return $r.access_token
}

# ── 3. 打一发 streamGenerateContent ───────────────────────────────────────
function Send-Probe {
  param([string]$Bearer)
  $body = @{
    project     = 'aicode-consumers'
    requestId   = "req-$(Get-Random)"
    requestType = 'agent'
    model       = 'gemini-3-flash'
    request     = @{
      contents  = @(@{ role = 'user'; parts = @(@{ text = 'Reply with exactly: REGION_GATE_IS_COSMETIC' }) })
      sessionId = '-probe-0002'
    }
  } | ConvertTo-Json -Depth 8
  return Invoke-WebRequest -Method Post `
    -Uri 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse' `
    -Headers @{ Authorization = "Bearer $Bearer"; requestType = 'agent' } `
    -UserAgent 'antigravity/4.3.0 windows/amd64' `
    -ContentType 'application/json' `
    -Body $body `
    -TimeoutSec 90
}

try {
  $resp = Send-Probe -Bearer $access
} catch {
  $r = $_.Exception.Response
  $code = if ($r) { [int]$r.StatusCode } else { 0 }
  if ($code -eq 401) {
    Write-Host '[..] 401 → 用 refresh_token 换一发新 access 重试'
    try {
      $access = Refresh-Access -tokObj $tok
      $resp = Send-Probe -Bearer $access
    } catch {
      Write-Host '[RESULT] refresh 后仍失败'
      $r2 = $_.Exception.Response
      if ($r2) {
        $sr = New-Object System.IO.StreamReader($r2.GetResponseStream())
        Write-Host "[RESULT] HTTP $([int]$r2.StatusCode)"
        Write-Host ($sr.ReadToEnd() | Select-Object -First 1200)
      } else { Write-Host $_.Exception.Message }
      exit 1
    }
  } else {
    if ($r) {
      $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
      $errBody = $sr.ReadToEnd()
      Write-Host "[RESULT] HTTP $code"
      Write-Host ($errBody.Substring(0, [Math]::Min(1200, $errBody.Length)))
      if ($errBody -match 'VALIDATION_REQUIRED') {
        Write-Host "`n[判定] 验证锁在服务端生效 → 先完成 validation_url 验证再重测。"
      } else {
        Write-Host "`n[判定] 异常 403 → 与 agyapi 作者环境不同，把上面响应体发回分析。"
      }
    } else { Write-Host "[RESULT] $($_.Exception.Message)" }
    exit 1
  }
}

Write-Host "[RESULT] HTTP $($resp.StatusCode)"
Write-Host ($resp.Content.Substring(0, [Math]::Min(2000, $resp.Content.Length)))
if ($resp.Content -match 'REGION_GATE_IS_COSMETIC') {
  Write-Host "`n[判定] 200 + 真实回显 → 地区锁纯客户端成立，agyapi 路线对该账号可用。"
} else {
  Write-Host "`n[判定] 200 但无回显关键词 → 把全文发回分析（可能被内容审核或格式漂移）。"
}
