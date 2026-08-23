# Stop the compatibility proxy.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $dir 'proxy.pid'
$stopped = $false

if (Test-Path $pidFile) {
  $pidToStop = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($pidToStop) {
    $proc = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
    if ($proc) { Stop-Process -Id $pidToStop -Force; Write-Output "stopped pid $pidToStop"; $stopped = $true }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
}

# Fallback: anything still bound to the port.
$conns = Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Output "stopped listener pid $($c.OwningProcess)"
  $stopped = $true
}
if (-not $stopped) { Write-Output "proxy not running" }
