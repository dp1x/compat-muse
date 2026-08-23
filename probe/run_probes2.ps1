$ErrorActionPreference = 'Continue'
$k = [System.IO.File]::ReadAllText("$env:TEMP\oc_zen.key").Trim()
$h = "Authorization: Bearer $k"
$ct = "Content-Type: application/json"
$base = "https://opencode.ai/zen/v1"
$m = "muse-spark-1.2-contributor-free"

function Post($path, $bodyFile, $outFile) {
  curl.exe -sS -m 180 -H $h -H $ct -o $outFile -w "%{http_code}" -d "`@$bodyFile" "$base/$path"
}

# --- 1. Chat Completions with tools ---
$chatTools = @"
{"model":"$m","stream":false,"messages":[{"role":"user","content":"What is the weather in Paris right now? You MUST call the get_weather tool."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}
"@
Set-Content probe\p2_chat_tools_body.json -Value $chatTools -NoNewline -Encoding UTF8
"chat_tools_http=" + (Post "chat/completions" "probe\p2_chat_tools_body.json" "probe\p2_chat_tools.json")

# --- 2. Chat follow-up with tool result ---
try {
  $j = Get-Content probe\p2_chat_tools.json -Raw | ConvertFrom-Json
  $tc = $j.choices[0].message.tool_calls[0]
  $tid = $tc.id; $tname = $tc.function.name; $targs = $tc.function.arguments
  "chat_toolcall: id=$tid name=$tname args=$targs"
  $follow = '{"model":"' + $m + '","stream":false,"messages":[' +
    '{"role":"user","content":"What is the weather in Paris right now? You MUST call the get_weather tool."},' +
    '{"role":"assistant","content":"","tool_calls":[{"id":"' + $tid + '","type":"function","function":{"name":"' + $tname + '","arguments":' + $targs + '}}]},' +
    '{"role":"tool","tool_call_id":"' + $tid + '","content":"+18C, sunny"}],' +
    '"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}'
  Set-Content probe\p2_chat_followup_body.json -Value $follow -NoNewline -Encoding UTF8
  "chat_followup_http=" + (Post "chat/completions" "probe\p2_chat_followup_body.json" "probe\p2_chat_followup.json")
} catch { "chat follow-up failed: $_" }

# --- 3. Responses with tools ---
$respTools = @"
{"model":"$m","stream":false,"input":[{"role":"user","content":[{"type":"input_text","text":"What is the weather in Paris right now? You MUST call the get_weather tool."}]}],"tools":[{"type":"function","name":"get_weather","description":"Get current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}
"@
Set-Content probe\p2_resp_tools_body.json -Value $respTools -NoNewline -Encoding UTF8
"resp_tools_http=" + (Post "responses" "probe\p2_resp_tools_body.json" "probe\p2_resp_tools.json")

# --- 4. Responses follow-up with function_call_output ---
try {
  $j = Get-Content probe\p2_resp_tools.json -Raw | ConvertFrom-Json
  $fc = $j.output | Where-Object { $_.type -eq 'function_call' } | Select-Object -First 1
  if ($null -ne $fc) {
    "resp_function_call: id=$($fc.id) call_id=$($fc.call_id) name=$($fc.name) args=$($fc.arguments)"
    $inp = '[{"role":"user","content":[{"type":"input_text","text":"What is the weather in Paris right now? You MUST call the get_weather tool."}]},' +
      '{"type":"function_call","id":"' + $fc.id + '","call_id":"' + $fc.call_id + '","name":"' + $fc.name + '","arguments":' + $fc.arguments + '},' +
      '{"type":"function_call_output","call_id":"' + $fc.call_id + '","output":"+18C, sunny"}]'
    $follow = '{"model":"' + $m + '","stream":false,"input":' + $inp + '}'
    Set-Content probe\p2_resp_followup_body.json -Value $follow -NoNewline -Encoding UTF8
    "resp_followup_http=" + (Post "responses" "probe\p2_resp_followup_body.json" "probe\p2_resp_followup.json")
  } else { "no function_call in resp tools output" }
} catch { "resp follow-up failed: $_" }

# --- 5. Reasoning effort acceptance ---
$cx = '{"model":"' + $m + '","stream":false,"reasoning_effort":"xhigh","messages":[{"role":"user","content":"Say OK"}]}'
Set-Content probe\p2_chat_xhigh_body.json -Value $cx -NoNewline -Encoding UTF8
"chat_xhigh_http=" + (Post "chat/completions" "probe\p2_chat_xhigh_body.json" "probe\p2_chat_xhigh.json")
$rx = '{"model":"' + $m + '","stream":false,"reasoning":{"effort":"xhigh"},"input":"Say OK"}'
Set-Content probe\p2_resp_xhigh_body.json -Value $rx -NoNewline -Encoding UTF8
"resp_xhigh_http=" + (Post "responses" "probe\p2_resp_xhigh_body.json" "probe\p2_resp_xhigh.json")

# --- 6. Long output timing ---
$long = '{"model":"' + $m + '","stream":false,"messages":[{"role":"user","content":"Write a detailed technical explanation of roughly 1000 words about how server-sent events work."}]}'
Set-Content probe\p2_long_body.json -Value $long -NoNewline -Encoding UTF8
$sw = [System.Diagnostics.Stopwatch]::StartNew()
"long_http=" + (Post "chat/completions" "probe\p2_long_body.json" "probe\p2_long.json")
$sw.Stop()
"long_elapsed_secs=" + [math]::Round($sw.Elapsed.TotalSeconds, 1)
