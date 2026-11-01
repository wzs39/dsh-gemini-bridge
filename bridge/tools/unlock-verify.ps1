#requires -Version 5.1
<#
  unlock-verify.ps1 -- prove the unlock chain is intact, end to end.

  Checks the four links separately, because they fail independently and the
  symptom of any one being broken is identical: agy prints the region wall.

     1. mitmproxy CA trusted          (else TLS inside the proxy fails)
     2. listener actually up          (else agy egresses direct)
     3. pool accounts carry proxyUrl  (else DSH-spawned agy ignores the proxy)
     4. optional live generation      (the only check that proves the whole chain)

  Exit code 0 = all non-optional checks pass.
#>
[CmdletBinding()]
param(
    [int]$Port = 8899,
    [switch]$LiveTest,
    [string]$AgyBin = ''
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pass = 0
$fail = 0

function Report([string]$Label, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) {
        $script:pass++
        '  [PASS] {0,-40} {1}' -f $Label, $Detail
    } else {
        $script:fail++
        '  [FAIL] {0,-40} {1}' -f $Label, $Detail
    }
}

$pool = Join-Path $env:USERPROFILE '.dsh\agy-accounts\pool.json'
$expectedProxy = "http://127.0.0.1:$Port"

Write-Output '########## Antigravity unlock chain ##########'
Write-Output ''

Write-Output '-- 1. mitmproxy CA trusted --'
$ca = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match 'mitmproxy' }
if ($ca) {
    Report 'CA in CurrentUser\Root' $true ('expires ' + ($ca | Select-Object -First 1).NotAfter)
} else {
    Report 'CA in CurrentUser\Root' $false 'not found -- the addon cannot decrypt TLS'
}

Write-Output ''
Write-Output '-- 2. unlock listener --'
$up = $false
$client = New-Object Net.Sockets.TcpClient
try { $client.Connect('127.0.0.1', $Port); $up = [bool]$client.Connected } catch { } finally { $client.Close() }
if ($up) {
    Report "listener on 127.0.0.1:$Port" $true ''
} else {
    Report "listener on 127.0.0.1:$Port" $false 'dead -- run unlock-keepalive.ps1'
}

Write-Output ''
Write-Output '-- 3. pool proxyUrl (what DSH actually injects) --'
if (Test-Path $pool) {
    $data = Get-Content $pool -Raw | ConvertFrom-Json
    $accounts = @($data.accounts)
    $withProxy = @($accounts | Where-Object { $_.proxyUrl -eq $expectedProxy }).Count
    Report 'all accounts carry proxyUrl' ($withProxy -eq $accounts.Count) ("$withProxy/$($accounts.Count)")

    $missing = @($accounts | Where-Object { -not $_.proxyUrl })
    foreach ($m in $missing) {
        '         missing on: {0} ({1})' -f $m.id, $m.email
    }
    if ($missing) {
        Write-Output '         fix: python set-pool-proxy.py --apply'
    }
} else {
    Report 'pool.json present' $false $pool
}

Write-Output ''
Write-Output '-- 4. environment fallback --'
$envProxy = [Environment]::GetEnvironmentVariable('DSH_AGY_PROXY_URL', 'User')
if ($envProxy) {
    Report 'DSH_AGY_PROXY_URL (User)' ($envProxy -eq $expectedProxy) $envProxy
} else {
    '  [skip] DSH_AGY_PROXY_URL not set (optional fallback; pool proxyUrl is the primary lever)'
}

Write-Output ''
Write-Output '-- 5. supervisor task --'
$task = Get-ScheduledTask -TaskName 'AgyUnlockProxy' -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName 'AgyUnlockProxy'
    Report 'AgyUnlockProxy registered' $true ('last=' + $info.LastTaskResult + ' next=' + $info.NextRunTime)
} else {
    '  [skip] no AgyUnlockProxy task (run unlock-install.ps1 to survive reboots)'
}

if ($LiveTest) {
    Write-Output ''
    Write-Output '-- 6. live generation (proves the whole chain) --'
    if (-not $AgyBin) {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\agy\agy.exe')
        )
        foreach ($c in $candidates) { if (Test-Path $c) { $AgyBin = $c; break } }
    }
    if (-not $AgyBin -or -not (Test-Path $AgyBin)) {
        Report 'agy binary found' $false 'pass -AgyBin <path>'
    } else {
        $saved = @{}
        foreach ($k in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')) {
            $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        }
        try {
            $env:HTTPS_PROXY = $expectedProxy
            $env:HTTP_PROXY = $expectedProxy
            $env:ALL_PROXY = $expectedProxy
            $out = & $AgyBin --output-format json -p 'What is 17 times 23? Reply with just the number.' --dangerously-skip-permissions 2>&1
            $text = ($out | Out-String)
            $okGen = $text -match '391'
            Report 'live generation returns 391' $okGen ($text.Trim() -replace '\s+', ' ').Substring(0, [Math]::Min(110, ($text.Trim()).Length))
        } finally {
            foreach ($k in $saved.Keys) {
                [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process')
            }
        }
    }
}

Write-Output ''
Write-Output ('RESULT: {0} passed, {1} failed' -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
exit 0
