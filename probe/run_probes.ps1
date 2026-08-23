$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
$ct = "Content-Type: application/json"
$base = "https://opencode.ai/zen/v1"

$chatNs = '{"model":"muse-spark-1.2-contributor-free","messages":[{"role":"user","content":"Reply with exactly: pong"}],"stream":false}'
$chatS  = '{"model":"muse-spark-1.2-contributor-free","messages":[{"role":"user","content":"Reply with exactly: pong"}],"stream":true}'
$respNs = '{"model":"muse-spark-1.2-contributor-free","input":"Reply with exactly: pong","stream":false}'
$respS  = '{"model":"muse-spark-1.2-contributor-free","input":"Reply with exactly: pong","stream":true}'

Set-Content -Path probe\chat_body.json  -Value $chatNs -NoNewline -Encoding ASCII
Set-Content -Path probe\chat_sbody.json -Value $chatS  -NoNewline -Encoding ASCII
Set-Content -Path probe\resp_body.json  -Value $respNs -NoNewline -Encoding ASCII
Set-Content -Path probe\resp_sbody.json -Value $respS  -NoNewline -Encoding ASCII

curl.exe -sS -m 90 -H $h -H $ct -o probe\chat_ns.json -w "chat_nonstream_http=%{http_code}`n"  -d '@probe\chat_body.json'  "$base/chat/completions"
curl.exe -sS -m 90 -H $h -H $ct -o probe\resp_ns.json -w "resp_nonstream_http=%{http_code}`n"  -d '@probe\resp_body.json'  "$base/responses"
curl.exe -sS -N -m 90 -H $h -H $ct -o probe\chat_sse.txt -D probe\chat_sse_hdr.txt -w "chat_stream_http=%{http_code}`n" -d '@probe\chat_sbody.json' "$base/chat/completions"
curl.exe -sS -N -m 90 -H $h -H $ct -o probe\resp_sse.txt -D probe\resp_sse_hdr.txt -w "resp_stream_http=%{http_code}`n" -d '@probe\resp_sbody.json' "$base/responses"
