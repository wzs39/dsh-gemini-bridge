@echo off
rem agy-unlock.cmd -- run the Antigravity CLI through the local eligibility
rem unlock proxy (agy_unlock_addon.py). Only THIS process's traffic goes
rem through mitmproxy; nothing else on the machine changes.
rem
rem One-time prerequisites (the script checks, installs the CA itself):
rem   pip install mitmproxy
rem
rem Usage:  agy-unlock.cmd [any agy args, e.g. -p "hello" --dangerously-skip-permissions]

setlocal
set PROXY_PORT=8899
set ADDON=%~dp0agy_unlock_addon.py
pushd "%~dp0"

where agy >nul 2>nul || (echo [agy-unlock] ERROR: agy not on PATH & exit /b 1)

rem Locate mitmdump: PATH first, then this python's Scripts dir.
set MITMDUMP=mitmdump.exe
where mitmdump.exe >nul 2>nul
if errorlevel 1 (
  for /f "delims=" %%P in ('python -c "import os,sys;print(os.path.join(os.path.dirname(sys.executable),'Scripts'))" 2^>nul') do set MITMDUMP=%%P\mitmdump.exe
)
if not exist "%MITMDUMP%" (
  "%MITMDUMP%" --version >nul 2>nul || (echo [agy-unlock] ERROR: mitmdump not found. Run: pip install mitmproxy & exit /b 1)
)

rem CA present? first mitm run generates it.
if not exist "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer" (
  echo [agy-unlock] first run: generating mitm CA via a 4-second boot...
  start "" /min "%MITMDUMP%" -s "%ADDON%" --listen-port %PROXY_PORT% --quiet
  ping -n 5 127.0.0.1 >nul
  taskkill /im mitmdump.exe /f >nul 2>nul
  ping -n 3 127.0.0.1 >nul
)

rem Trust the CA in CurrentUser\Root (pure API, no Cert: drive, no UI,
rem idempotent: skip when a mitmproxy cert is already in the store).
powershell -NoProfile -Command "$s=New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser'); $s.Open('ReadOnly'); $have=($s.Certificates | Where-Object { $_.Subject -match 'mitmproxy' }).Count; $s.Close(); if ($have -eq 0) { $c=New-Object Security.Cryptography.X509Certificates.X509Certificate2(\"$env:USERPROFILE\.mitmproxy\mitmproxy-ca-cert.cer\"); $s.Open('ReadWrite'); $s.Add($c); $s.Close(); Write-Host '[agy-unlock] mitm CA imported into CurrentUser\Root' }"

rem Is a proxy already answering on the port? reuse it, else spawn one.
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%PROXY_PORT%); exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  echo [agy-unlock] starting unlock proxy on 127.0.0.1:%PROXY_PORT% ...
  start "agy-unlock-proxy" /min "%MITMDUMP%" -s "%ADDON%" --listen-port %PROXY_PORT% --quiet
  ping -n 4 127.0.0.1 >nul
) else (
  echo [agy-unlock] reusing unlock proxy already on 127.0.0.1:%PROXY_PORT%
)

set HTTPS_PROXY=http://127.0.0.1:%PROXY_PORT%
set HTTP_PROXY=http://127.0.0.1:%PROXY_PORT%
set NO_PROXY=localhost,127.0.0.1
popd
agy %*
