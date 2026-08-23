# Start the compatibility proxy in the background.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $dir 'proxy.pid'
$logFile = Join-Path $dir 'proxy.log'
$errFile = Join-Path $dir 'proxy.err.log'

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Write-Output "proxy already running (pid $old)"
    exit 0
  }
}

$env:PROXY_PORT = '8799'
$p = Start-Process -FilePath node -ArgumentList "`"$dir\proxy.mjs`"" `
  -WorkingDirectory $dir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile -RedirectStandardError $errFile
Set-Content -Path $pidFile -Value $p.Id

# Wait briefly for the health endpoint.
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 2
    if ($h.ok) { $ok = $true; break }
  } catch {}
}
if ($ok) { Write-Output "proxy started (pid $($p.Id)) on http://127.0.0.1:8799" }
else { Write-Output "proxy process launched (pid $($p.Id)) but health check failed; see proxy.err.log"; exit 1 }
