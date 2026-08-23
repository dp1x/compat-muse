$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
Set-Content probe\p5_xhigh_body.json -Value '{"model":"muse-spark-1.2-contributor-free","stream":false,"reasoning":{"effort":"xhigh"},"input":"Say OK"}' -NoNewline -Encoding UTF8
curl.exe -sS -m 90 -H $h -H "Content-Type: application/json" -o probe\p5_xhigh.json -w "xhigh_direct_http=%{http_code}`n" -d '@probe\p5_xhigh_body.json' 'https://opencode.ai/zen/v1/responses'
node -e "const j=require('./probe/p5_xhigh.json'); console.log('echoed effort:', j.reasoning && j.reasoning.effort, '| status:', j.status)"
