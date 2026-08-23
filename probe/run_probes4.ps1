$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
$ct = "Content-Type: application/json"
$base = "https://opencode.ai/zen/v1"

# Direct upstream chat+tools probe, twice, spaced.
foreach ($i in 1..2) {
  $code = curl.exe -sS -m 120 -H $h -H $ct -o "probe\p4_chat_tools_$i.json" -w "%{http_code}" -d '@probe\p2_chat_tools_body.json' "$base/chat/completions"
  "attempt ${i}: http=$code"
  Start-Sleep -Seconds 12
}
