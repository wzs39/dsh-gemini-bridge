#requires -Version 5.1
<#
  unlock-install.ps1 -- one-shot install of the unlock supervisor.

  Registers scheduled task "AgyUnlockProxy":
    - at logon (+1 min delay)
    - every N minutes thereafter (default 10)

  That cadence matters: the listener can die without anyone noticing (crash,
  taskkill, reboot race), and every second it is down agy egresses directly and
  the CLI reports the raw region wall again.

  No administrator required. This deliberately uses schtasks.exe rather than
  Register-ScheduledTask: the ScheduledTasks PowerShell module refuses
  non-elevated registration with "Access is denied", while schtasks creates a
  task owned by the current user just fine. Verified on this machine both ways.

  Re-running is safe: the task is overwritten.

  Undo with: .\unlock-install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [int]$Port = 8899,
    [int]$EveryMinutes = 10,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$taskName  = 'AgyUnlockProxy'
$keepalive = Join-Path $PSScriptRoot 'unlock-keepalive.ps1'

if ($Uninstall) {
    $out = schtasks.exe /Delete /TN $taskName /F 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Output ('removed scheduled task: ' + $taskName)
    } else {
        Write-Output ('task not removed (may not exist): ' + ($out -join ' '))
    }
    Write-Output ''
    Write-Output 'The listener itself was left running on purpose.'
    Write-Output 'Stop it with:  Get-Process mitmdump | Stop-Process -Force'
    exit 0
}

if (-not (Test-Path $keepalive)) { throw "missing: $keepalive" }

function Test-Port([int]$P) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $P); return [bool]$c.Connected }
    catch { return $false }
    finally { $c.Close() }
}

# Quote every path: the repo may live under a directory containing spaces.
$inner = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Port {1} -Quiet' -f $keepalive, $Port

# schtasks wants a single /TR payload; wrap the whole command in outer quotes.
$tr = '"{0}"' -f $inner

Write-Output '=== registering task ==='
Write-Output ('  command : ' + $inner)

$createArgs = @(
    '/Create',
    '/TN', $taskName,
    '/TR', $tr,
    '/SC', 'MINUTE',
    '/MO', "$EveryMinutes",
    '/RL', 'LIMITED',
    '/F'
)

$createOut = schtasks.exe @createArgs 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Output ('ERROR: schtasks /Create failed: ' + ($createOut -join ' '))
    exit 1
}
Write-Output ('  ' + ($createOut -join ' '))

# Start it once now rather than waiting for the first interval.
schtasks.exe /Run /TN $taskName 2>&1 | Out-Null
Start-Sleep -Seconds 8

$up = Test-Port $Port
$query = schtasks.exe /Query /TN $taskName /FO LIST 2>&1

Write-Output ''
Write-Output '=== status ==='
$query | Where-Object { $_ -match 'TaskName|Status|Next Run' } | ForEach-Object { '  ' + $_.Trim() }
'  listening on {0} : {1}' -f $Port, $up

if ($up) {
    Write-Output ''
    Write-Output 'Next: make DSH inject the proxy into the agy process it spawns.'
    Write-Output '  python set-pool-proxy.py --apply'
    Write-Output 'Then restart DSH so the plugin re-reads pool.json.'
    Write-Output ''
    Write-Output 'Verify:  powershell -ExecutionPolicy Bypass -File .\unlock-verify.ps1 -LiveTest'
    exit 0
}

Write-Output ''
Write-Output 'Proxy did not come up. Check unlock-proxy.stderr.log next to this script.'
exit 1
