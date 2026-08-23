# End-to-end test: real Grok Build sessions through the compat proxy using the muse model.
# Requires: proxy running on 127.0.0.1:8799, OPENCODE_API_KEY env set by caller,
# and [model.muse].base_url temporarily pointed at http://127.0.0.1:8799/v1.
$ErrorActionPreference = 'Continue'
if (-not $env:OPENCODE_API_KEY -or -not $env:OPENCODE_API_KEY.Trim()) {
  Write-Error "OPENCODE_API_KEY not set. Set `$env:OPENCODE_API_KEY to your OpenCode Zen key before running this test."
  exit 2
}
$env:OPENCODE_API_KEY = $env:OPENCODE_API_KEY.Trim()

$grok = 'grok'
$common = @('-m', 'muse', '--no-auto-update')

# --- T1: plain text turn ---
$t1 = & $grok -p 'Reply with exactly: PONG-FROM-MUSE' @common --output-format json --yolo 2>&1 | Out-String
try { $j1 = $t1 | ConvertFrom-Json } catch { $j1 = $null }
$sid = $j1.sessionId
"T1 text: stopReason=$($j1.stopReason) text=$($j1.text) sessionId=$sid"
if (-not $j1.text) { "T1 RAW OUTPUT:"; $t1 }

# --- T2: multi-turn recall via session resume ---
if ($sid) {
  $t2 = & $grok -p 'What exact token did I ask you to reply with one message ago? Reply with just the token.' -r $sid @common --output-format json --yolo 2>&1 | Out-String
  try { $j2 = $t2 | ConvertFrom-Json } catch { $j2 = $null }
  "T2 multiturn: stopReason=$($j2.stopReason) text=$($j2.text)"
  if (-not $j2.text) { "T2 RAW OUTPUT:"; $t2 }
} else { "T2 skipped (no sessionId)" }

# --- T3: tool-call round trip (shell tool through Muse -> proxy -> OpenCode) ---
$t3 = & $grok -p 'Use your terminal tool to run exactly this command: echo MUSE-TOOL-OK-7391 - then tell me the exact output it printed.' @common --output-format streaming-json --yolo 2>&1 | Out-String
$toolCalls = 0; $toolDone = 0; $sawOutput = $false
foreach ($line in ($t3 -split "`n")) {
  $line = $line.Trim()
  if (-not $line.StartsWith('{')) { continue }
  try { $e = $line | ConvertFrom-Json } catch { continue }
  if ($e.type -eq 'tool_call') { $toolCalls++ }
  if ($e.type -eq 'tool_call_update' -and $e.status -eq 'completed') { $toolDone++; if ("$($e.rawOutput)" -match 'MUSE-TOOL-OK-7391') { $sawOutput = $true } }
}
"T3 tools: tool_calls=$toolCalls completed=$toolDone sawExpectedOutput=$sawOutput"

# --- T4: another plain turn after all that (stability) ---
$t4 = & $grok -p 'Reply with exactly: STILL-ALIVE' @common --output-format json --yolo 2>&1 | Out-String
try { $j4 = $t4 | ConvertFrom-Json } catch { $j4 = $null }
"T4 stability: stopReason=$($j4.stopReason) text=$($j4.text)"
if (-not $j4.text) { "T4 RAW OUTPUT:"; $t4 }
