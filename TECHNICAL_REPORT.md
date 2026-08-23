# compat-muse — Technical Report

> **AI-generated technical investigation for `muse-spark-1.2-contributor-free` via OpenCode Zen (`https://opencode.ai/zen/v1`) into Grok Build.**  
> Verified against live endpoints **2026-08-23 → 2026-08-24** via raw captures in [`probe/`](./probe/). This is the companion to the concise [`README.md`](./README.md).

---

## 1. Executive Summary

Grok Build requires strict OpenAI-compatible Server-Sent Events. OpenCode Zen's streaming for `muse-spark-1.2-contributor-free` violates **both** wire protocols:

* `/v1/responses` stream: trailing `event: ping` after `response.completed` → `unknown variant 'ping'`
* `/v1/chat/completions` stream: empty `id`, no `finish_reason`, no `[DONE]` → `missing field id`

Non-streaming on either lane returns a valid JSON shape. `compat-muse` therefore **forces upstream `stream:false` on the official `/responses` lane and synthesizes a clean SSE stream downstream**. The result is a localhost-only proxy on `127.0.0.1:8799` that Grok can consume reliably, with successful proxied streams synthesized into a strict client-compatible schema.

Validated: **14/14** `test.mjs` (chat + responses, streaming + tools + long + reasoning) and **4/4** real Grok Build E2E (plain, multi-turn, tool-call round-trip, stability) on 2026-08-24.

---

## 2. Root Cause (Verified)

| Lane | Upstream violation | Grok symptom |
|---|---|---|
| `/v1/responses` stream | Appends `event: ping` / `{"type":"ping","cost":"0"}` after `response.completed` | `serialization error: unknown variant 'ping'` |
| `/v1/chat/completions` stream | Chunks carry `"id":""`, no `finish_reason`, no `[DONE]`, ends with `data: {"choices":[],"cost":"0"}` (no `id`) | `serialization error: missing field id` |

Non-streaming returns valid shapes (modulo `finish_reason: null` on chat), so the fix is deterministic.

**Additional finding:** `/chat/completions` is *unofficial* for this model (OpenCode docs list only `/responses`). It intermittently 500s and answered tool prompts with prose instead of `tool_calls`. The proxy **bridges both downstream protocols → upstream `/responses`** for reliability.

Evidence: `probe/chat_sse.txt`, `probe/resp_sse.txt`, `probe/chat_sse_hdr.txt`, `probe/resp_sse_hdr.txt` + `run_probes*.ps1`.

---

## 3. Raw Protocol Evidence

* **Chat SSE** (`probe/chat_sse.txt`): 10 frames, 6 with `id:""`, 2 with `id:"resp_…"` but `choices:[]`, final `data: {"choices":[],"cost":"0"}` — never a terminal `finish_reason` or `[DONE]`.
* **Responses SSE** (`probe/resp_sse.txt:33`): valid `response.created` → `response.completed` sequence then `event: ping` — strict clients reject.
* **Non-streaming** (`probe/chat_ns.json` 341 B, `probe/resp_ns.json` 3717 B): both `status:completed` with usable output (`content:"pong"` + reasoning `encrypted_content`).  
* Requests: `probe/chat_body.json`, `probe/resp_body.json` minimal samples (verified 2026-08-23).

Captures are live, not mocks; `models.json` / `modelsdev.json` catalog confirms model exists.

---

## 4. Architecture

```
Grok Build  ── compliant SSE ──►  compat-muse :8799  ── POST /v1/responses {stream:false} ──►  OpenCode Zen
     ◄── clean SSE (synthesized) ──┘                          ◄── buffered JSON 200 ──────────┘
```

* **Ingest** — Parse `stream` flag. If `stream:false` and `/v1/responses`, pass through untouched. If `stream:false` and `/v1/chat/completions`, translate to Responses, call upstream, translate back to `chat.completion` JSON.
* **Streaming** — When `stream:true`, build a Responses body (`chatRequestToResponses` for chat lane), call upstream **once** with `stream:false`, buffer the JSON.
* **Synthesize** — Emit strict SSE downstream (see §6–7).
* **Flush** — Once upstream completes, frames are flushed immediately — Grok renders quickly.

Diagram: [`assets/architecture.svg`](./assets/architecture.svg).

---

## 5. Chat Completions Translation

`muse.py:chat_request_to_responses` / `proxy.mjs:chatRequestToResponses`:

* `system`/`developer` → `{role:system, content:[{type:input_text}]}`
* `user` → `{role:user, content:[{type:input_text}]}`
* `assistant` text → `{role:assistant, content:[{type:output_text}]}`
* `assistant.tool_calls` → `{type:function_call, id/call_id, name, arguments}` (arguments kept as JSON string, default `'{}'`)
* `tool` → `{type:function_call_output, call_id, output}`
* `tools` flatten `type:function + function.name/description/parameters`
* `tool_choice`, `temperature`, `top_p`, `max_completion_tokens→max_output_tokens`, `reasoning_effort→reasoning.effort`, `parallel_tool_calls` mapped.

Reverse: `responses_to_chat_completion` walks `output[]` → concatenates `output_text` parts, collects `function_call` → `tool_calls` with `call_id||id`, maps `status=incomplete/reason=max_output_tokens` → `finish_reason=length`, else `tool_calls` vs `stop`.

---

## 6. SSE Synthesis

**Chat (`synthesizeChatSSE`):** `randId('chatcmpl-')` per request → `role:assistant` chunk → `reasoning_content` chunks (480-char split, surrogate-safe) → `content` chunks → `tool_calls` deltas with guaranteed `id`/`index`/`type:function` → terminal `finish_reason` (`tool_calls`/`length`/`stop`) → optional `usage` → `data: [DONE]`. Every chunk has non-empty `id`, `object=chat.completion.chunk`, `choices` array.

**Responses (`synthesizeResponsesSSE`):** `sequence_number` strictly increasing from 1 → `response.created`(`in_progress` copy) → `response.in_progress` → for each output item: `output_item.added(in_progress)` → `content_part.added`/`output_text.delta`/`function_call_arguments.delta` → `…done` → `output_item.done` → `response.completed(completed_at=now)`. Reasoning/other opaque items: `added(in_progress)` → `done(verbatim)`. No `ping`, no `[DONE]`.

Error paths: upstream `status:failed` → `response.failed` with upstream error or generic `upstream_error`; non-JSON success → `502`; mid-stream exception → chat `data: [DONE]`, responses `response.failed(proxy_error)`.

---

## 7. Tool-Call Handling

* Single tool call: verified via `test.mjs` `get_weather(city:Paris/Tokyo)` — downstream `tool_calls[0].id` stable, `function.arguments` valid JSON, `index:0`.
* Multiple tool calls in one response: code loops with incrementing `index` — not exercised in current suite (model-dependent, low priority).
* Tool-result continuation: `tool_call_id` / `call_id` round-trips (`chat` `tool` role, `responses` `function_call_output`) → next assistant turn streams correctly (e.g. `+18C, sunny` → follow-up `finalTurnChars>0`).
* Proxy never executes tools — only translates and preserves JSON exactly.

---

## 8. Reasoning Handling

Model emits `output[0].type=reasoning` with `encrypted_content` (opaque). Proxy preserves it verbatim through `output_item.added/done` with `status:in_progress→completed`. `xhigh` (and `high`/`medium`/`low`/`minimal`) mapped via `reasoning_effort→reasoning:{effort}`. Chat lane `reasoning_content` chunks are emitted before visible `content` if present.

Test: `reasoning:{effort:low}` on `17*24` → `output types=[reasoning,message]` and numeric answer — PASS in full suite.

---

## 9. Security / Credential Model

* **Reads only `OPENCODE_API_KEY`** as fallback when client omits `Authorization` (`muse.py:67-69` `proxy.mjs:86-87`). No `MUSE_*`/`PROXY_*` key aliases. Header passthrough preferred.
* **Binds `127.0.0.1` only** (`HOST` default, `server.listen(PORT,HOST)`), verified via `Get-NetTCPConnection`.
* **Health `GET /health`** — no auth, returns only `{"ok":true,"upstream":"…","pid":…}` (localhost-only).
* **Logs metadata-only:** `method / path / status / duration / byte-count` — never bodies, prompts, tool args, or keys (`proxy.mjs:22-23` `muse.py:23-24`). Error propagation forwards upstream JSON verbatim (no key echo; tested `Bearer invalid-key-12345` not leaked).
* **Disk:** no body writes; `.gitignore` blocks `proxy.log`, `proxy.pid`, `*.key`, `.env`, `__pycache__`, `node_modules`.

---

## 10. Performance / Buffering

Accepted tradeoff by design:

* **TTFB = full upstream generation** — measured 2–15 s typical for short, longer for long (800-word ~5 s in suite). Downstream flush is immediate once buffered.
* **RAM:** one buffered completion (hundreds of KB) + ~30–40 MB process (Node) or stdlib Python.
* **Payload limit:** Node `MAX_BODY_BYTES=64 MiB` (`proxy.mjs:33`); Python currently uncapped (hardening item F-07).
* **Cancellation:** Node propagates client disconnect via `AbortController` (`res.on('close')→controller.abort`); Python does not (continues upstream, quota spend — known limitation F-06, documented for daily-driver use).

---

## 11. Test Methodology & Results

**No mocks — live proxy + OpenCode.**

* `test.mjs --quick` (12 tests): `chat non-stream`, `chat stream` strict + `[DONE]`, multi-turn `ZEBRA-9`, **chat tool-call (now sends `tools`)**, `tool-result→next turn`, `responses stream` no ping + seq, `responses` multi-turn `KILO-77`, `responses` tool-call, `function_output→next turn`, `auth error 401`.
* `test.mjs` full (+2): `chat long output ~800 words` (`minChars 2500` → actual 5055), `responses reasoning item + math answer`.
* `e2e_grok_test.ps1`: real Grok Build sessions via `grok -m muse --output-format json` — `T1 PONG-FROM-MUSE`, `T2 multiturn recall`, `T3 tool shell echo MUSE-TOOL-OK-7391`, `T4 STILL-ALIVE`.
* **Last runs 2026-08-24:** `14/14 PASS` (01:01–01:02 UTC) + `12/12 ×5 PASS` + `4/4 Grok E2E PASS`. `5× concurrency` parallel `POST /v1/chat/completions stream:true` — all `200` with valid `id`/`[DONE]`, no cross-request leakage.
* Evidence in `probe/` + `test.mjs:45-57` retry on `5xx`.

**What is *not* proven:** multiple tool calls per turn, repeated tool rounds beyond one follow-up, Python cancellation under load, every reasoning effort level individually — intentionally out of scope for buffered correctness.

---

## 12. Known Limitations

* Buffered TTFB tradeoff (above).
* Python does not cancel upstream on client disconnect (use Node if cancellation matters).
* `/chat/completions` upstream is unofficial/500-prone — proxied via `/responses` for reliability; raw upstream streaming is not supported by design.
* Probe captures contain some placeholder `75 B` error JSONs from intermittent upstream 500s — not hidden, noted here.

---

## 13. Files & Publishing Hygiene

| Path | Purpose |
|---|---|
| `muse.py` | Python proxy — daily driver, stdlib only |
| `proxy.mjs` | Node proxy — identical logic, zero deps |
| `start.ps1` / `stop.ps1` | Node background helpers (PID + health + `Get-NetTCPConnection` fallback) |
| `test.mjs` / `e2e_grok_test.ps1` | Validation suites |
| `probe/` / `assets/architecture.svg` | Evidence + diagram |
| `grok-config-backup.toml` | Sanitized example (only `model.muse`) |
| `.gitignore` | `proxy.log`, `pid`, `__pycache__`, `node_modules`, `.env`, `*.key` |

Single verified signed commit `e465988` (`Dhanesh <dhaneshpanjnani@gmail.com>`), `HEAD == origin/main`, MIT. History scan: 43 blobs, no real `sk-` secrets (only `sk-invalid-key-for-error-test` placeholder).

---

## 14. References

* Previous audit (2026-08-23) + remediation report (F-01/F-02/F-03, GPG `no_user→valid`).
* GitHub verification docs: signing key must match verified email (`bad_email`/`unverified_email`/`no_user`/`unknown_key`).
* Model catalog: `probe/modelsdev.json` `context_window 1048576` etc.
