# compat-muse — OpenCode Zen → Grok Build bridge

> **Fixes `muse-spark-1.2-contributor-free` streaming inside Grok Build.** Runs as a tiny local proxy.

[![proxy: 127.0.0.1:8799](https://img.shields.io/badge/proxy-127.0.0.1%3A8799-14B8A6?style=flat-square)](#quick-start) [![verified: 2026-08-24](https://img.shields.io/badge/verified-2026--08--24-60A5FA?style=flat-square)](#verification) [![zero deps](https://img.shields.io/badge/zero--deps-stdlib-34D399?style=flat-square)](#quick-start)

![compat-muse architecture — Grok Build → localhost proxy → OpenCode Zen](./assets/architecture.svg)

## What is this?

**compat-muse** sits between Grok Build and OpenCode Zen (`https://opencode.ai/zen/v1`) and makes `muse-spark-1.2-contributor-free` work reliably. You point Grok at `http://127.0.0.1:8799` instead of OpenCode directly.

For the full technical investigation, protocol captures, root-cause analysis, and validation evidence, see **[TECHNICAL_REPORT.md](./TECHNICAL_REPORT.md)**.

## The problem

Grok Build expects strict OpenAI-compatible streaming. OpenCode Zen's streaming for this model breaks that contract on both endpoints (trailing ping events, missing IDs). The result is Grok errors instead of answers.

## The fix

The proxy always calls OpenCode **non-streaming** (`stream:false` — the lane that works), then **synthesizes a clean streaming response** locally for Grok. Successful proxied streams are synthesized into a strict client-compatible schema. See the technical report for details.

```
Grok Build → compat-muse :8799 → OpenCode Zen   (stream:false)
Grok Build ← clean SSE   ← compat-muse          (synthesized)
```

* Binds `127.0.0.1` only — never exposed to your network.
* No request bodies, prompts, or keys are ever logged.

## Quick start — just Python

**Prerequisites:** Python 3.10+ and an OpenCode Zen key.

**1. Set your key once (system-wide):**

```powershell
setx OPENCODE_API_KEY "sk-your-key-here"
# restart your terminal after setx
```

Or for one shell only:

```powershell
$env:OPENCODE_API_KEY = "sk-your-key-here"
```

**2. Run the proxy:**

```powershell
# from this directory
python muse.py
# → muse compat proxy  http://127.0.0.1:8799 -> https://opencode.ai/zen/v1
#   waiting for requests... press Ctrl+C to stop
```

That's it. Leave it running.

> Node alternative (`proxy.mjs`) exists with identical behavior if you prefer `node proxy.mjs` — Python is the daily driver.

## Grok Build config

Point the `muse` model at the proxy:

```toml
[model.muse]
name = "Muse Spark 1.2 Contributor Free (OpenCode Zen)"
model = "muse-spark-1.2-contributor-free"
base_url = "http://127.0.0.1:8799/v1"   # was https://opencode.ai/zen/v1
env_key = "OPENCODE_API_KEY"
api_backend = "responses"
context_window = 1048576
max_completion_tokens = 131072
reasoning_effort = "xhigh"
```

Rollback: set `base_url` back to `https://opencode.ai/zen/v1`. A sanitized example is in [`grok-config-backup.toml`](./grok-config-backup.toml).

Health check (no auth needed):

```powershell
Invoke-RestMethod http://127.0.0.1:8799/health
# {"ok":true,"upstream":"https://opencode.ai/zen/v1","pid":1234}
```

## What it costs

This is intentional. Responses are **buffered upstream**, so you wait for the full generation before output starts:

* **Time to first token = full generation** — *observed* typically 2–15 s in testing, longer for long outputs (estimated, not guaranteed). Then Grok renders instantly.
* **RAM:** *estimated* one buffered response (hundreds of KB) + ~30 MB process — observed, not guaranteed.

In exchange you get a reliable stream every time.

## Verification

Live tests against the real proxy + OpenCode — no mocks:

```powershell
$env:OPENCODE_API_KEY = "sk-your-key-here"
node test.mjs          # full suite: chat + responses + tools + long + reasoning
node test.mjs --quick  # fast subset

# Real Grok Build session through the proxy:
$env:OPENCODE_API_KEY = "sk-your-key-here"
powershell -ExecutionPolicy Bypass -File .\e2e_grok_test.ps1
```

Last run **2026-08-24**: `14/14` `test.mjs` + `4/4` Grok E2E (plain text, multi-turn, tool-call, stability) — all PASS. Details in the [technical report](./TECHNICAL_REPORT.md).

## Files

| Path | Purpose |
|---|---|
| `muse.py` | Python proxy — daily use (`python muse.py`, Ctrl+C to stop) |
| `proxy.mjs` | Node proxy — same logic, zero deps |
| `test.mjs` / `e2e_grok_test.ps1` | Validation suites |
| `probe/` | Raw protocol captures |
| `grok-config-backup.toml` | Sanitized config example |

## License

MIT — use and adapt freely.
