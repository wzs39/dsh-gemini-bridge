#requires -Version 5.1
<#
  unlock-keepalive.ps1 -- keep the Antigravity eligibility-unlock proxy alive.

  Why this exists
  ---------------
  agy_unlock_addon.py only works while its mitmproxy listener is actually up.
  The common failure is not a wrong addon: it is a dead listener. agy then falls
  back to direct egress and the CLI reports the raw region wall again, which
  looks identical to "the addon does not work".

  This script is the missing half: an idempotent supervisor you can run from a
  scheduled task so the listener is up before agy is ever spawned.

  Idempotent: if something already answers on the port, it does nothing.

  Exit codes: 0 = proxy is up, 1 = setup problem (missing addon / mitmdump).
#>
[CmdletBinding()]
param(
    [int]$Port = 8899,
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $Quiet) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }

# The addon ships next to this script (bridge/tools/).
$addon   = Join-Path $PSScriptRoot 'agy_unlock_addon.py'
$logFile = Join-Path $PSScriptRoot 'unlock-keepalive.log'

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if (-not $Quiet) { Write-Output $Message }
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

function Test-Port([int]$P) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $P)
        return [bool]$client.Connected
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (-not (Test-Path $addon)) {
    Write-Log ('FATAL addon missing next to script: ' + $addon)
    exit 1
}

if (Test-Port $Port) {
    Write-Log ('proxy already listening on ' + $Port + ' -- no action')
    exit 0
}

# Locate mitmdump: PATH first, then well-known per-user Python Scripts dirs.
# (A pip --user install often lands off PATH, which is exactly how the
#  listener silently never starts.)
$mitm = $null
$cmd = Get-Command mitmdump.exe -ErrorAction SilentlyContinue
if ($cmd) {
    $mitm = $cmd.Source
} else {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\mitmdump.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts\mitmdump.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\Scripts\mitmdump.exe'),
        (Join-Path $env:APPDATA 'Python\Python313\Scripts\mitmdump.exe'),
        (Join-Path $env:APPDATA 'Python\Python312\Scripts\mitmdump.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $mitm = $c; break }
    }
}

if (-not $mitm -or -not (Test-Path $mitm)) {
    Write-Log 'FATAL mitmdump.exe not found. Install it: pip install mitmproxy'
    exit 1
}

Write-Log ('starting unlock proxy: ' + $mitm + ' --listen-port ' + $Port)
Start-Process -FilePath $mitm `
    -ArgumentList @('-s', $addon, '--listen-port', "$Port", '--quiet') `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $PSScriptRoot 'unlock-proxy.stdout.log') `
    -RedirectStandardError  (Join-Path $PSScriptRoot 'unlock-proxy.stderr.log') | Out-Null

# Wait for the listener, up to 15s.
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port $Port) {
        Write-Log ('proxy UP on 127.0.0.1:' + $Port)
        exit 0
    }
}

Write-Log 'FAILED proxy did not start; see unlock-proxy.stderr.log'
exit 1
