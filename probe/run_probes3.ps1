$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
$ct = "Content-Type: application/json"
$base = "https://opencode.ai/zen/v1"
$m = "muse-spark-1.2-contributor-free"

function Post($path, $bodyFile, $outFile) {
  $code = curl.exe -sS -m 180 -H $h -H $ct -o $outFile -w "%{http_code}" -d "`@$bodyFile" "$base/$path"
  return $code
}

# warm-up simple request
Start-Sleep -Seconds 10
$simple = '{"model":"' + $m + '","stream":false,"messages":[{"role":"user","content":"Say OK"}]}'
Set-Content probe\p3_simple_body.json -Value $simple -NoNewline -Encoding UTF8
"simple_http=" + (Post "chat/completions" "probe\p3_simple_body.json" "probe\p3_simple.json")

Start-Sleep -Seconds 15
"chat_tools_http=" + (Post "chat/completions" "probe\p2_chat_tools_body.json" "probe\p3_chat_tools.json")

Start-Sleep -Seconds 15
"resp_tools_http=" + (Post "responses" "probe\p2_resp_tools_body.json" "probe\p3_resp_tools.json")

Start-Sleep -Seconds 15
"chat_xhigh_http=" + (Post "chat/completions" "probe\p2_chat_xhigh_body.json" "probe\p3_chat_xhigh.json")

Start-Sleep -Seconds 15
$rx = '{"model":"' + $m + '","stream":false,"reasoning":{"effort":"xhigh"},"input":"Say OK"}'
Set-Content probe\p3_resp_xhigh_body.json -Value $rx -NoNewline -Encoding UTF8
"resp_xhigh_http=" + (Post "responses" "probe\p3_resp_xhigh_body.json" "probe\p3_resp_xhigh.json")
