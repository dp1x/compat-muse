# compat-muse — OpenCode Zen → Grok Build bridge

> **Fixes `muse-spark-1.2-contributor-free` streaming inside Grok Build.**  
> Verified against live endpoints on **2026-08-23** via raw protocol capture in [`probe/`](./probe/).

[![proxy: 127.0.0.1:8799](https://img.shields.io/badge/proxy-127.0.0.1%3A8799-14B8A6?style=flat-square)](#quick-start) [![verified: 2026-08-23](https://img.shields.io/badge/verified-2026--08--23-60A5FA?style=flat-square)](#root-cause-verified) [![zero deps](https://img.shields.io/badge/zero--deps-stdlib%20%7C%20node-34D399?style=flat-square)](#files) [![SSE: strict](https://img.shields.io/badge/SSE-strict%20compliant-F59E0B?style=flat-square)](#how-it-works)

![compat-muse architecture — Grok Build → localhost proxy → OpenCode Zen, showing the two streaming violations fixed and the non-streaming bridge strategy](./assets/architecture.svg)

### What this does

Grok Build expects strict OpenAI-compatible Server-Sent Events. OpenCode Zen's streaming for this model violates **both** wire protocols. This proxy sits on `http://127.0.0.1:8799`, accepts both `POST /v1/chat/completions` and `POST /v1/responses`, **forces upstream non-streaming** on the official `/responses` lane (which is valid), and **synthesizes a fully compliant SSE stream** downstream. Every chunk has a real `id`, a terminal `finish_reason`, a final `[DONE]` (chat) or `response.completed` (responses), and no stray `ping` events.

---

## Root cause (verified)

| Lane | Upstream violation | Grok symptom |
|---|---|---|
| `/v1/responses` stream | Appends `event: ping` / `{"type":"ping","cost":"0"}` after `response.completed` | `serialization error: unknown variant 'ping'` |
| `/v1/chat/completions` stream | Chunks carry `"id":""`, no `finish_reason`, no `[DONE]`, ends with `data: {"choices":[],"cost":"0"}` (no `id`) | `serialization error: missing field id` |

Non-streaming on either lane returns valid shapes (modulo `finish_reason: null` on chat), so the fix is deterministic.

**Additional finding:** `/chat/completions` is *unofficial* for this model (OpenCode docs list only `/responses`). It intermittently 500s and answered tool prompts with prose instead of `tool_calls`. The proxy therefore **bridges both downstream protocols → upstream `/responses`** for reliability.

Evidence: raw captures and repro scripts in [`probe/`](./probe/) — see `run_probes*.ps1` and `*.json`.

---

## How it works

```
Grok Build  ── compliant SSE ──►  compat-muse :8799  ── POST /v1/responses {stream:false} ──►  OpenCode Zen
     ◄── clean SSE (synthesized) ──┘                          ◄── buffered JSON 200 ──────────┘
```

1. **Ingest** — Parse `stream` flag. If `stream:false` and path is `/v1/responses`, pass through untouched. If `stream:false` and path is `/v1/chat/completions`, translate to Responses, call upstream, translate back to a `chat.completion` JSON.
2. **Streaming** — When `stream:true`, build a Responses request (`chatRequestToResponses` for chat lane), call upstream **once** with `stream:false`, buffer the single JSON response.
3. **Synthesize** — Emit a strict SSE sequence downstream:
   - **Chat:** `role` chunk → `reasoning_content` chunks → `content` chunks → `tool_calls` deltas (with guaranteed `id`/`index`) → `finish_reason` chunk → optional `usage` → `data: [DONE]`
   - **Responses:** `response.created` → `response.in_progress` → `output_item.added` / `content_part.added` / `output_text.delta` / `function_call_arguments.delta` / `...done` → `response.completed` (no `ping`, strictly increasing `sequence_number`)
4. **Flush** — Once upstream completes, frames are flushed immediately — Grok renders quickly.

### Tradeoff accepted by design

- **TTFB = full upstream generation** (measured 2–15 s typical, longer for long outputs). Downstream then flushes instantly.
- **RAM:** one buffered completion (hundreds of KB) + ~30–40 MB Node process (or Python stdlib).
- **In exchange:** every stream is guaranteed schema-valid regardless of upstream behavior.

Privacy: logs are **metadata-only** — `method / path / status / duration / byte-count`. Bodies, prompts, tool arguments, and keys are never logged.

---

## Quick start

### Prerequisites

- Python 3.10+ **or** Node 18+ (both work, identical behavior)
- An OpenCode Zen API key (`OPENCODE_API_KEY`) — set user-wide or per-shell

### Option A — Python (daily driver, stdlib only)

```powershell
# from this directory
$env:OPENCODE_API_KEY = '<your OpenCode Zen key>'
python muse.py
# → muse compat proxy  http://127.0.0.1:8799 -> https://opencode.ai/zen/v1
#   waiting for requests... press Ctrl+C to stop
```

### Option B — Node (zero dependencies, background)

```powershell
# from this directory
$env:OPENCODE_API_KEY = '<your OpenCode Zen key>'   # or set user-wide once
powershell -ExecutionPolicy Bypass -File .\start.ps1    # http://127.0.0.1:8799
Invoke-RestMethod http://127.0.0.1:8799/health          # {"ok":true,"upstream":"https://opencode.ai/zen/v1","pid":...}
powershell -ExecutionPolicy Bypass -File .\stop.ps1     # stop
# or directly: node proxy.mjs
```

> If you launch `node proxy.mjs` from a job-object wrapper (CI, agent shells), keep the parent alive. From a normal interactive PowerShell window, `start.ps1` detaches cleanly. The proxy binds `127.0.0.1` only.

### Grok config change (temporary experiment block)

Point the `muse` model at the proxy:

```toml
[model.muse]
name = "Muse Spark 1.2 Contributor Free (OpenCode Zen)"
model = "muse-spark-1.2-contributor-free"
base_url = "http://127.0.0.1:8799/v1"     # <-- was https://opencode.ai/zen/v1
env_key = "OPENCODE_API_KEY"
api_backend = "responses"
context_window = 1048576                  # verified via models.dev catalog
max_completion_tokens = 131072            # verified
reasoning_effort = "xhigh"                # verified: minimal|low|medium|high|xhigh
```

Rollback: restore `base_url = "https://opencode.ai/zen/v1"` (and optionally `context_window = 1000000`, drop `max_completion_tokens`). A pre-test copy of the whole config is in [`grok-config-backup.toml`](./grok-config-backup.toml).

---

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `PROXY_PORT` / `MUSE_PROXY_PORT` | `8799` | Listen port (8787 was occupied on this machine) |
| `PROXY_HOST` / `MUSE_PROXY_HOST` | `127.0.0.1` | Localhost-only bind |
| `PROXY_UPSTREAM` / `MUSE_UPSTREAM` | `https://opencode.ai/zen/v1` | Upstream base |
| `OPENCODE_API_KEY` | — | Fallback auth when client sends no `Authorization` header |
| `PROXY_DEBUG` | off | `1` = sanitized event-kind logging (never bodies) |
| `PROXY_UPSTREAM_TIMEOUT_MS` / `MUSE_UPSTREAM_TIMEOUT` | `600000` | Upstream call timeout (ms / s) |

Both `muse.py` and `proxy.mjs` read the same semantics (`MUSE_*` for Python, `PROXY_*` for Node).

Health check (no auth needed):

```powershell
Invoke-RestMethod http://127.0.0.1:8799/health
# {"ok":true,"upstream":"https://opencode.ai/zen/v1","pid":1234}
```

---

## Verification

No mocks — tests hit the live proxy (and through it, OpenCode Zen).

```powershell
# strict protocol validation (chat + responses, streaming + tools + long output)
$env:OPENCODE_API_KEY = '<key>'
node test.mjs            # full suite (~2-5 min, includes 800-word long test + reasoning)
node test.mjs --quick    # fast subset (skips long + reasoning)

# headless Grok Build e2e (plain text, multi-turn recall, tool-call round-trip, stability)
$env:OPENCODE_API_KEY = '<key>'
powershell -ExecutionPolicy Bypass -File .\e2e_grok_test.ps1
```

What `test.mjs` checks:

- `chat non-stream` passthrough shape
- `chat stream` strict schema + `[DONE]` last, single `finish_reason`, valid `id`
- Multi-turn memory (seed `ZEBRA-9`, recall)
- Tool-call emission (`get_weather` in `city:"Paris"`) and `tool_result → next turn`
- Long output (~800 words, `minChars 2500`)
- `responses stream` clean event sequence, no `ping`, increasing `sequence_number`, `response.completed`
- `responses` tool-call with `call_id` + JSON `arguments`
- Reasoning item preserved + math answer
- Upstream auth error propagated as `4xx` + error envelope

---

## Files

| Path | Purpose |
|---|---|
| `muse.py` | Python proxy — daily-use switch (`python muse.py`, Ctrl+C off, stdlib only) |
| `proxy.mjs` | Node proxy — same logic, zero dependencies |
| `start.ps1` / `stop.ps1` | Background helpers for Node (PID file + health wait + `Get-NetTCPConnection` fallback) |
| `test.mjs` | Strict validation suite (`node test.mjs [--quick]`) |
| `e2e_grok_test.ps1` | Grok Build headless e2e (`-m muse` via `grok --output-format json`) |
| `probe/` | Raw endpoint captures + repro scripts (evidence for the violations) |
| `assets/architecture.svg` | Architecture diagram (embedded above) |
| `grok-config-backup.toml` | Full Grok config backup from before the `base_url` experiment |
| `.gitignore` | Ignores `proxy.log`, `proxy.pid`, `__pycache__/`, `node_modules/`, `.env`, keys |

`muse.py` and `proxy.mjs` are intentionally duplicated (not shared code) — each is self-contained, zero-deps, and identical in behavior.

---

## Publishing & hygiene

This repo is git-clean:

- `__pycache__/`, `proxy.log`, `proxy.err.log`, `proxy.pid`, `.env`, `*.key`, `node_modules/` are ignored.
- No secrets are committed. `grok-config-backup.toml` contains no keys (only `env_key` names).
- To publish:

```powershell
git init
git add .
git commit -m "feat: compat-muse proxy with synthesized SSE + docs + architecture diagram"
# create an empty GitHub repo, then:
git remote add origin https://github.com/<you>/compat-muse.git
git branch -M main
git push -u origin main
```

To rotate a leaked key: revoke at OpenCode, set the new key in your user env (`setx OPENCODE_API_KEY "..."`), restart the proxy. The temporary test key used for verification on 2026-08-23 has been revoked.

---

## License

MIT — use, fork, and adapt freely. If you improve the synthesis, please keep the live-probe verification in `probe/`.
