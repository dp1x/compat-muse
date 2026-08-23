#!/usr/bin/env python3
"""
muse.py - localhost compatibility proxy: OpenCode Zen Muse -> strict OpenAI-style
streaming for Grok Build. Stdlib only. Run `python muse.py`, stop with Ctrl+C.

Why it exists (verified against live endpoints, 2026-08-23): OpenCode Zen's SSE
streams violate both wire protocols (trailing `ping` event on /responses; empty
ids / no finish_reason / no [DONE] on chat), and its /chat/completions lane is
unofficial and unreliable for this model. This proxy always calls upstream
NON-streaming on the official /responses lane and synthesizes fully compliant
streams locally. Non-stream requests pass through untouched on the responses
route; chat requests are bridged to /responses either way.

Config via env:
  OPENCODE_API_KEY        auth used when client sends no Authorization header
  MUSE_PROXY_HOST         default 127.0.0.1
  MUSE_PROXY_PORT         default 8799
  MUSE_UPSTREAM           default https://opencode.ai/zen/v1

Logs are metadata-only (method/path/status/duration/bytes) - never bodies,
prompts, tool arguments, or keys.
"""

import json
import os
import re
import time
import uuid
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOST = os.environ.get("MUSE_PROXY_HOST", "127.0.0.1")
PORT = int(os.environ.get("MUSE_PROXY_PORT", "8799"))
UPSTREAM = os.environ.get("MUSE_UPSTREAM", "https://opencode.ai/zen/v1").rstrip("/")
_u = urlsplit(UPSTREAM)
UP_HOST = _u.hostname
UP_PORT = _u.port or (443 if _u.scheme == "https" else 80)
UP_PREFIX = _u.path.rstrip("/")
UP_TLS = _u.scheme == "https"
UPSTREAM_TIMEOUT = int(os.environ.get("MUSE_UPSTREAM_TIMEOUT", "600"))

CHAT_PATH = "/v1/chat/completions"
RESP_PATH = "/v1/responses"


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *a, flush=True)


def rand_id(prefix):
    return prefix + uuid.uuid4().hex[:24]


def chunk_text(t, n=480):
    return [t[i:i + n] for i in range(0, len(t), n)] if t else []


def strip_v1(path):
    # Upstream base already ends in /v1; avoid /v1/v1/... when forwarding.
    return re.sub(r"^/v1(?=/|$)", "", path)


def upstream_post(path_rel, body_bytes, auth_header):
    headers = {"Content-Type": "application/json"}
    if auth_header:
        headers["Authorization"] = auth_header
    elif os.environ.get("OPENCODE_API_KEY"):
        headers["Authorization"] = "Bearer " + os.environ["OPENCODE_API_KEY"]
    conn = http.client.HTTPSConnection(UP_HOST, UP_PORT, timeout=UPSTREAM_TIMEOUT) if UP_TLS \
        else http.client.HTTPConnection(UP_HOST, UP_PORT, timeout=UPSTREAM_TIMEOUT)
    try:
        conn.request("POST", UP_PREFIX + path_rel, body=body_bytes, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        return r.status, raw
    finally:
        conn.close()


def send_json(handler, status, obj):
    body = json.dumps(obj, separators=(",", ":")).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def start_sse(handler):
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True


def sse_data(handler, payload):
    handler.wfile.write(b"data: " + json.dumps(payload, separators=(",", ":")).encode() + b"\n\n")


def sse_event(handler, event, payload):
    handler.wfile.write(b"event: " + event.encode() + b"\ndata: "
                        + json.dumps(payload, separators=(",", ":")).encode() + b"\n\n")


def chat_request_to_responses(chat):
    """Convert a Chat Completions request body to an equivalent Responses body."""
    inp = []
    for m in chat.get("messages") or []:
        role = m.get("role")
        content = m["content"] if isinstance(m.get("content"), str) else ""
        if role in ("system", "developer"):
            inp.append({"role": "system", "content": [{"type": "input_text", "text": content}]})
        elif role == "user":
            inp.append({"role": "user", "content": [{"type": "input_text", "text": content}]})
        elif role == "assistant":
            if content:
                inp.append({"role": "assistant", "content": [{"type": "output_text", "text": content}]})
            for tc in m.get("tool_calls") or []:
                if tc.get("type") != "function":
                    continue
                fn = tc.get("function") or {}
                cid = tc.get("id") or rand_id("call_")
                inp.append({
                    "type": "function_call",
                    "id": cid,
                    "call_id": cid,
                    "name": fn.get("name", ""),
                    "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str) else "{}",
                })
        elif role == "tool":
            inp.append({"type": "function_call_output", "call_id": m.get("tool_call_id", ""), "output": content})

    out = {"model": chat.get("model"), "input": inp, "stream": False}

    tools = chat.get("tools")
    if tools:
        flat = []
        for t in tools:
            if isinstance(t, dict) and t.get("type") == "function" and isinstance(t.get("function"), dict):
                fn = t["function"]
                flat.append({"type": "function", "name": fn.get("name"),
                             "description": fn.get("description"), "parameters": fn.get("parameters")})
            else:
                flat.append(t)
        if flat:
            out["tools"] = flat

    tc_choice = chat.get("tool_choice")
    if tc_choice is not None:
        if isinstance(tc_choice, dict) and isinstance(tc_choice.get("function"), dict):
            out["tool_choice"] = {"type": "function", "name": tc_choice["function"].get("name")}
        else:
            out["tool_choice"] = tc_choice
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p")):
        if chat.get(src) is not None:
            out[dst] = chat[src]
    max_tok = chat.get("max_completion_tokens", chat.get("max_tokens"))
    if max_tok is not None:
        out["max_output_tokens"] = max_tok
    if chat.get("reasoning_effort") is not None:
        out["reasoning"] = {"effort": chat["reasoning_effort"]}
    if chat.get("parallel_tool_calls") is not None:
        out["parallel_tool_calls"] = chat["parallel_tool_calls"]
    return out


def responses_to_chat_completion(resp):
    """Convert a non-streaming Responses body into a Chat Completions completion."""
    content_parts = []
    tool_calls = []
    for item in resp.get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    content_parts.append(part["text"])
        elif item.get("type") == "function_call":
            tool_calls.append({
                "id": item.get("call_id") or item.get("id") or rand_id("call_"),
                "type": "function",
                "function": {
                    "name": item.get("name", ""),
                    "arguments": item["arguments"] if isinstance(item.get("arguments"), str) else "{}",
                },
            })
    content = "".join(content_parts)

    if tool_calls:
        finish = "tool_calls"
    elif resp.get("status") == "incomplete" and (resp.get("incomplete_details") or {}).get("reason") == "max_output_tokens":
        finish = "length"
    else:
        finish = "stop"

    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls

    completion = {
        "id": resp.get("id") or rand_id("chatcmpl-"),
        "object": "chat.completion",
        "created": resp.get("created_at") or int(time.time()),
        "model": resp.get("model"),
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
    }
    u = resp.get("usage")
    if isinstance(u, dict):
        completion["usage"] = {
            "prompt_tokens": u.get("input_tokens", 0),
            "completion_tokens": u.get("output_tokens", 0),
            "total_tokens": u.get("total_tokens", 0),
        }
    return completion


def synthesize_chat_sse(handler, completion, model_fallback):
    cid = rand_id("chatcmpl-")
    created = int(time.time())
    model = completion.get("model") or model_fallback
    base = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model}

    def chunk(delta, finish=None):
        sse_data(handler, {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})

    choice = (completion.get("choices") or [{}])[0]
    msg = choice.get("message") or {}

    chunk({"role": "assistant", "content": ""})
    reason = msg.get("reasoning_content") or msg.get("reasoning")
    if isinstance(reason, str):
        for piece in chunk_text(reason):
            chunk({"reasoning_content": piece})
    text = msg.get("content") if isinstance(msg.get("content"), str) else ""
    for piece in chunk_text(text):
        chunk({"content": piece})

    tcs = msg.get("tool_calls") or []
    finish = choice.get("finish_reason")
    for i, tc in enumerate(tcs):
        fn = tc.get("function") or {}
        chunk({"tool_calls": [{
            "index": i,
            "id": tc.get("id") or rand_id("call_"),
            "type": "function",
            "function": {"name": fn.get("name", ""),
                         "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str) else "{}"},
        }]})
    if tcs and finish != "length":
        finish = "tool_calls"
    elif not finish:
        finish = "stop"

    chunk({}, finish)
    if isinstance(completion.get("usage"), dict):
        sse_data(handler, {**base, "choices": [], "usage": completion["usage"]})
    handler.wfile.write(b"data: [DONE]\n\n")


def synthesize_responses_sse(handler, body):
    seq = [0]

    def nxt():
        seq[0] += 1
        return seq[0]

    def emit(event, payload):
        sse_event(handler, event, payload)

    failed = body.get("status") == "failed" or (body.get("error") is not None)

    created_resp = {**body, "object": "response", "status": "in_progress", "output": []}
    created_resp.pop("completed_at", None)
    emit("response.created", {"type": "response.created", "sequence_number": nxt(), "response": created_resp})
    emit("response.in_progress", {"type": "response.in_progress", "sequence_number": nxt(), "response": created_resp})

    if failed:
        err = body.get("error") if isinstance(body.get("error"), dict) else \
            {"code": "upstream_error", "message": "Upstream returned a failed response."}
        emit("response.failed", {
            "type": "response.failed",
            "sequence_number": nxt(),
            "response": {**body, "object": "response", "status": "failed", "error": err},
        })
        return

    for oi, item in enumerate(body.get("output") or []):
        itype = item.get("type")
        if itype == "message":
            emit("response.output_item.added", {
                "type": "response.output_item.added", "sequence_number": nxt(),
                "output_index": oi, "item": {**item, "status": "in_progress", "content": []},
            })
            parts = item.get("content") or []
            for ci, part in enumerate(parts):
                base = {"output_index": oi, "content_index": ci, "item_id": item.get("id")}
                if part.get("type") == "output_text":
                    emit("response.content_part.added", {
                        "type": "response.content_part.added", "sequence_number": nxt(),
                        **base, "part": {**part, "text": "", "annotations": [], "logprobs": []},
                    })
                    for piece in chunk_text(part.get("text", "")):
                        emit("response.output_text.delta", {
                            "type": "response.output_text.delta", "sequence_number": nxt(),
                            **base, "delta": piece, "logprobs": [],
                        })
                    emit("response.content_part.done", {
                        "type": "response.content_part.done", "sequence_number": nxt(), **base, "part": part,
                    })
                else:
                    emit("response.content_part.added", {
                        "type": "response.content_part.added", "sequence_number": nxt(), **base, "part": part,
                    })
                    emit("response.content_part.done", {
                        "type": "response.content_part.done", "sequence_number": nxt(), **base, "part": part,
                    })
            emit("response.output_item.done", {
                "type": "response.output_item.done", "sequence_number": nxt(), "output_index": oi, "item": item,
            })
        elif itype == "function_call":
            args = item["arguments"] if isinstance(item.get("arguments"), str) else "{}"
            emit("response.output_item.added", {
                "type": "response.output_item.added", "sequence_number": nxt(),
                "output_index": oi, "item": {**item, "status": "in_progress", "arguments": ""},
            })
            fb = {"output_index": oi, "item_id": item.get("id")}
            for piece in chunk_text(args):
                emit("response.function_call_arguments.delta", {
                    "type": "response.function_call_arguments.delta",
                    "sequence_number": nxt(), **fb, "delta": piece,
                })
            emit("response.function_call_arguments.done", {
                "type": "response.function_call_arguments.done", "sequence_number": nxt(), **fb, "arguments": args,
            })
            emit("response.output_item.done", {
                "type": "response.output_item.done", "sequence_number": nxt(), "output_index": oi, "item": item,
            })
        else:
            # reasoning items and other opaque types: announce then complete verbatim.
            added = {k: v for k, v in item.items()}
            if "status" in added:
                added["status"] = "in_progress"
            emit("response.output_item.added", {
                "type": "response.output_item.added", "sequence_number": nxt(),
                "output_index": oi, "item": added,
            })
            emit("response.output_item.done", {
                "type": "response.output_item.done", "sequence_number": nxt(), "output_index": oi, "item": item,
            })

    done_at = body.get("completed_at") or int(time.time())
    emit("response.completed", {
        "type": "response.completed", "sequence_number": nxt(),
        "response": {**body, "object": "response", "status": "completed", "completed_at": done_at},
    })


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "muse-compat/1.0"

    def log_message(self, fmt, *args):  # silence default per-line access log
        pass

    # ---- helpers -------------------------------------------------------

    def auth_header(self):
        a = self.headers.get("Authorization")
        if a:
            return a
        key = os.environ.get("OPENCODE_API_KEY")
        return ("Bearer " + key) if key else None

    def read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        remaining = n
        parts = []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            parts.append(chunk)
            remaining -= len(chunk)
        return b"".join(parts)

    def passthrough_raw(self, path_rel, body_bytes):
        status, raw = upstream_post(path_rel, body_bytes, self.auth_header())
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)
        return status, len(raw)

    def propagate_error(self, status, raw):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    # ---- GET -----------------------------------------------------------

    def do_GET(self):
        t0 = time.time()
        self.close_connection = True  # one request per connection; avoids reset noise
        path = urlsplit(self.path).path
        try:
            if path == "/health":
                send_json(self, 200, {"ok": True, "upstream": UPSTREAM, "pid": os.getpid()})
                return
            # /v1/models and anything else: transparent pass-through.
            conn = http.client.HTTPSConnection(UP_HOST, UP_PORT, timeout=UPSTREAM_TIMEOUT) if UP_TLS \
                else http.client.HTTPConnection(UP_HOST, UP_PORT, timeout=UPSTREAM_TIMEOUT)
            headers = {}
            a = self.auth_header()
            if a:
                headers["Authorization"] = a
            try:
                conn.request("GET", UP_PREFIX + strip_v1(path), headers=headers)
                r = conn.getresponse()
                raw = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.getheader("Content-Type") or "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                out = len(raw)
                code = r.status
            finally:
                conn.close()
            log(f"{self.command} {path} -> {code} {int((time.time()-t0)*1000)}ms {out}B")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            log(f"{self.command} {path} failed: {e}")
            try:
                send_json(self, 502, {"error": {"message": f"proxy: {e}"}})
            except Exception:
                pass

    # ---- POST ----------------------------------------------------------

    def do_POST(self):
        t0 = time.time()
        self.close_connection = True
        path = urlsplit(self.path).path
        raw = self.read_body()
        try:
            if path not in (CHAT_PATH, RESP_PATH):
                code, out = self.passthrough_raw(strip_v1(path), raw)
                log(f"POST {path} -> {code} {int((time.time()-t0)*1000)}ms {out}B")
                return

            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
                if not isinstance(body, dict):
                    raise ValueError("body is not an object")
            except Exception:
                # Not JSON we understand: forward verbatim, mirror response.
                code, out = self.passthrough_raw(strip_v1(path), raw)
                log(f"POST {path} (opaque) -> {code} {int((time.time()-t0)*1000)}ms")
                return

            want_stream = body.get("stream") is True
            status, resp_raw = upstream_post("/responses", json.dumps(
                chat_request_to_responses(body) if path == CHAT_PATH else {**body, "stream": False},
                separators=(",", ":")).encode(), self.auth_header())

            if status >= 400 or status < 200:
                self.propagate_error(status, resp_raw)
                log(f"{self.command} {path} upstream-error {status} {int((time.time()-t0)*1000)}ms")
                return
            try:
                resp = json.loads(resp_raw.decode("utf-8"))
            except Exception:
                send_json(self, 502, {"error": {"message": "upstream returned non-JSON success response"}})
                return

            if path == CHAT_PATH:
                completion = responses_to_chat_completion(resp)
                if want_stream:
                    start_sse(self)
                    synthesize_chat_sse(self, completion, body.get("model"))
                else:
                    send_json(self, 200, completion)
            elif want_stream:
                start_sse(self)
                synthesize_responses_sse(self, resp)
            else:
                # Ordinary non-streaming responses request: return JSON untouched.
                send_json(self, 200, resp)
            self.wfile.flush()
            log(f"{self.command} {path} {'stream' if want_stream else 'nonstream'} -> 200 {int((time.time()-t0)*1000)}ms")
        except (BrokenPipeError, ConnectionResetError):
            log(f"POST {path} client disconnected")
        except Exception as e:  # noqa: BLE001
            log(f"POST {path} failed: {e}")
            try:
                send_json(self, 502, {"error": {"message": f"proxy: {e}"}})
            except Exception:
                pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"muse compat proxy  http://{HOST}:{PORT} -> {UPSTREAM}", flush=True)
    print("waiting for requests... press Ctrl+C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nCtrl+C received, shutting down...", flush=True)
    finally:
        try:
            server.server_close()
        except Exception:
            pass
        print("proxy stopped.", flush=True)


if __name__ == "__main__":
    main()
