$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
foreach ($eff in @('high', 'xhigh')) {
  Set-Content probe\p5_effort_body.json -Value ('{"model":"muse-spark-1.2-contributor-free","stream":false,"reasoning":{"effort":"' + $eff + '"},"input":"Say OK"}') -NoNewline -Encoding UTF8
  $code = curl.exe -sS -m 90 -H $h -H "Content-Type: application/json" -o "probe\p5_eff_$eff.json" -w "%{http_code}" -d '@probe\p5_effort_body.json' 'https://opencode.ai/zen/v1/responses'
  $echo = ''
  try { $j = Get-Content "probe\p5_eff_$eff.json" -Raw | ConvertFrom-Json; $echo = " effort_echo=$($j.reasoning.effort) status=$($j.status)" } catch {}
  "effort=$eff http=$code$echo"
  Start-Sleep -Seconds 10
}
