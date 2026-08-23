#!/usr/bin/env node
// Minimal localhost compatibility proxy: OpenCode Zen -> strict OpenAI-style streaming.
//
// Why it exists (verified 2026-08-23 against live endpoints):
// - /v1/responses streaming appends a nonstandard trailing `event: ping` frame
//   that strict Responses clients reject as an unknown event variant.
// - /v1/chat/completions streaming emits chunks with empty `id`, never sets a
//   final `finish_reason`, omits `[DONE]`, and ends with a frame lacking `id`.
//
// Fix strategy: force upstream inference to non-streaming (`stream:false`,
// which OpenCode serves correctly) and synthesize a fully compliant downstream
// SSE stream. Non-streaming requests pass through untouched.
//
// Config via env:
//   PROXY_PORT                default 8799
//   PROXY_HOST                default 127.0.0.1
//   PROXY_UPSTREAM            default https://opencode.ai/zen/v1
//   OPENCODE_API_KEY          fallback auth when client sends no Authorization
//   PROXY_DEBUG               "1" = log sanitized event counts (never bodies)
//   PROXY_UPSTREAM_TIMEOUT_MS default 600000
//
// Logging is metadata-only: method, path, status, duration, byte counts.
// Request bodies, prompts, tool arguments, and keys are never logged.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PROXY_PORT || 8799);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const UPSTREAM = (process.env.PROXY_UPSTREAM || 'https://opencode.ai/zen/v1').replace(/\/+$/, '');
const DEBUG = process.env.PROXY_DEBUG === '1';
const UPSTREAM_TIMEOUT_MS = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 600000);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const CHAT_PATH = '/v1/chat/completions';
const RESP_PATH = '/v1/responses';

const nowSecs = () => Math.floor(Date.now() / 1000);
const randId = (prefix, bytes = 12) => prefix + crypto.randomBytes(bytes).toString('hex');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Yield string pieces of at most n characters without splitting surrogate pairs. */
function* splitChunks(text, n = 480) {
  if (typeof text !== 'string' || text.length === 0) return;
  const pts = Array.from(text);
  for (let i = 0; i < pts.length; i += n) yield pts.slice(i, i + n).join('');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Build upstream request headers from the incoming request. */
function upstreamHeaders(req) {
  const h = { 'content-type': 'application/json' };
  const auth = req.headers['authorization'];
  if (auth && typeof auth === 'string') {
    h['authorization'] = auth;
  } else if (process.env.OPENCODE_API_KEY) {
    h['authorization'] = `Bearer ${process.env.OPENCODE_API_KEY}`;
  }
  return h;
}

/**
 * Forward a request to upstream and buffer the JSON response.
 * Returns { ok, status, body } where body is the parsed JSON (or null).
 */
async function callUpstream(pathname, bodyBuf, headers, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
  signal.addEventListener('abort', () => controller.abort(new Error('client disconnected')), { once: true });
  try {
    const r = await fetch(`${UPSTREAM}${pathname}`, {
      method: 'POST',
      headers,
      body: bodyBuf,
      signal: controller.signal,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, body: json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Chat Completions -> Responses bridging.
//
// OpenCode's /chat/completions lane is unofficial for this model and proved
// unreliable (intermittent 500s; tool requests answered with prose instead of
// tool calls). /responses is the documented endpoint and handles tools
// correctly, so chat requests are translated upstream and back.
// ---------------------------------------------------------------------------

/** Convert a Chat Completions request body to an equivalent Responses body. */
function chatRequestToResponses(chat) {
  const input = [];
  for (const m of Array.isArray(chat.messages) ? chat.messages : []) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system' || m.role === 'developer') {
      input.push({ role: 'system', content: [{ type: 'input_text', text: content }] });
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: content }] });
    } else if (m.role === 'assistant') {
      if (content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: content }] });
      }
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (tc?.type !== 'function') continue;
        input.push({
          type: 'function_call',
          id: tc.id || randId('fc_', 10),
          call_id: tc.id || randId('call_', 10),
          name: tc.function?.name ?? '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '{}',
        });
      }
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: content,
      });
    }
  }

  const out = { model: chat.model, input, stream: false };

  const tools = Array.isArray(chat.tools)
    ? chat.tools.map((t) =>
        t?.type === 'function' && t.function
          ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }
          : t,
      )
    : undefined;
  if (tools && tools.length) out.tools = tools;

  if (chat.tool_choice !== undefined) {
    out.tool_choice =
      typeof chat.tool_choice === 'object' && chat.tool_choice?.function?.name
        ? { type: 'function', name: chat.tool_choice.function.name }
        : chat.tool_choice;
  }
  if (chat.temperature !== undefined) out.temperature = chat.temperature;
  if (chat.top_p !== undefined) out.top_p = chat.top_p;
  if (chat.max_completion_tokens !== undefined || chat.max_tokens !== undefined) {
    out.max_output_tokens = chat.max_completion_tokens ?? chat.max_tokens;
  }
  if (chat.reasoning_effort !== undefined) out.reasoning = { effort: chat.reasoning_effort };
  if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;
  return out;
}

/** Convert a non-streaming Responses body into a Chat Completions completion. */
function responsesToChatCompletion(resp) {
  let content = '';
  const toolCalls = [];
  for (const item of Array.isArray(resp?.output) ? resp.output : []) {
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part.type === 'output_text' && typeof part.text === 'string') content += part.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || randId('call_', 10),
        type: 'function',
        function: { name: item.name ?? '', arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
      });
    }
  }

  let finish = 'stop';
  if (toolCalls.length) finish = 'tool_calls';
  else if (resp?.status === 'incomplete' && resp?.incomplete_details?.reason === 'max_output_tokens') finish = 'length';

  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = resp?.usage
    ? {
        prompt_tokens: resp.usage.input_tokens ?? 0,
        completion_tokens: resp.usage.output_tokens ?? 0,
        total_tokens: resp.usage.total_tokens ?? 0,
      }
    : undefined;

  const completion = {
    id: resp?.id || randId('chatcmpl-'),
    object: 'chat.completion',
    created: resp?.created_at ?? nowSecs(),
    model: resp?.model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (usage) completion.usage = usage;
  return completion;
}

// ---------------------------------------------------------------------------
// Chat Completions synthesis
// ---------------------------------------------------------------------------

function synthesizeChatSSE(res, completion, modelFallback) {
  const id = randId('chatcmpl-');
  const created = nowSecs();
  const model = typeof completion?.model === 'string' && completion.model ? completion.model : modelFallback;
  const base = { id, object: 'chat.completion.chunk', created, model };
  const writeFrame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta, finishReason = null, extra = {}) =>
    writeFrame({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });

  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined;
  const msg = choice?.message ?? {};

  // 1. role announcement chunk
  chunk({ role: 'assistant', content: '' });

  // 2. reasoning content first, preserving provider field when present
  const reason =
    typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content
      : typeof msg.reasoning === 'string'
        ? msg.reasoning
        : null;
  for (const piece of splitChunks(reason)) chunk({ reasoning_content: piece });

  // 3. visible content
  const content = typeof msg.content === 'string' ? msg.content : '';
  for (const piece of splitChunks(content)) chunk({ content: piece });

  // 4. tool calls with guaranteed ids and valid argument strings
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  let finish = choice?.finish_reason;
  toolCalls.forEach((tc, index) => {
    chunk({
      tool_calls: [
        {
          index,
          id: typeof tc?.id === 'string' && tc.id ? tc.id : randId('call_', 10),
          type: 'function',
          function: {
            name: typeof tc?.function?.name === 'string' ? tc.function.name : '',
            arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '{}',
          },
        },
      ],
    });
  });
  if (toolCalls.length > 0 && finish !== 'length') finish = 'tool_calls';
  else if (!finish) finish = 'stop';

  // 5. terminal chunk with valid finish_reason, then [DONE]
  chunk({}, finish);
  if (completion?.usage && typeof completion.usage === 'object') {
    writeFrame({ ...base, choices: [], usage: completion.usage });
  }
  res.write('data: [DONE]\n\n');
}

// ---------------------------------------------------------------------------
// Responses synthesis
// ---------------------------------------------------------------------------

function synthesizeResponsesSSE(res, body) {
  let seq = 0;
  const nextSeq = () => ++seq;
  const emit = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const ev = (type, extra) => ({ type, sequence_number: nextSeq(), ...extra });

  const failed = body?.status === 'failed' || (body?.error && body.error !== null);

  const createdResponse = { ...body, object: 'response', status: 'in_progress', output: [] };
  delete createdResponse.completed_at;
  emit('response.created', ev('response.created', { response: createdResponse }));
  emit('response.in_progress', ev('response.in_progress', { response: createdResponse }));

  if (failed) {
    const errObj =
      body?.error && typeof body.error === 'object'
        ? body.error
        : { code: 'upstream_error', message: 'Upstream returned a failed response.' };
    emit(
      'response.failed',
      ev('response.failed', {
        response: { ...body, object: 'response', status: 'failed', error: errObj },
      }),
    );
    return;
  }

  const outputs = Array.isArray(body?.output) ? body.output : [];
  outputs.forEach((item, outputIndex) => {
    if (item.type === 'message') {
      emit(
        'response.output_item.added',
        ev('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', content: [] },
        }),
      );
      const parts = Array.isArray(item.content) ? item.content : [];
      parts.forEach((part, contentIndex) => {
        if (part.type === 'output_text') {
          emit(
            'response.content_part.added',
            ev('response.content_part.added', {
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              part: { ...part, text: '', annotations: [], logprobs: [] },
            }),
          );
          for (const piece of splitChunks(part.text)) {
            emit(
              'response.output_text.delta',
              ev('response.output_text.delta', {
                output_index: outputIndex,
                content_index: contentIndex,
                item_id: item.id,
                delta: piece,
                logprobs: [],
              }),
            );
          }
          emit(
            'response.content_part.done',
            ev('response.content_part.done', {
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              part,
            }),
          );
        } else {
          // Unknown content part type: pass through added/done verbatim.
          emit(
            'response.content_part.added',
            ev('response.content_part.added', {
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              part,
            }),
          );
          emit(
            'response.content_part.done',
            ev('response.content_part.done', {
              output_index: outputIndex,
              content_index: contentIndex,
              item_id: item.id,
              part,
            }),
          );
        }
      });
      emit(
        'response.output_item.done',
        ev('response.output_item.done', { output_index: outputIndex, item }),
      );
    } else if (item.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : '{}';
      emit(
        'response.output_item.added',
        ev('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', arguments: '' },
        }),
      );
      for (const piece of splitChunks(args)) {
        emit(
          'response.function_call_arguments.delta',
          ev('response.function_call_arguments.delta', {
            output_index: outputIndex,
            item_id: item.id,
            delta: piece,
          }),
        );
      }
      emit(
        'response.function_call_arguments.done',
        ev('response.function_call_arguments.done', {
          output_index: outputIndex,
          item_id: item.id,
          arguments: args,
        }),
      );
      emit(
        'response.output_item.done',
        ev('response.output_item.done', { output_index: outputIndex, item }),
      );
    } else {
      // reasoning items and any other opaque types: announce then complete verbatim.
      emit(
        'response.output_item.added',
        ev('response.output_item.added', {
          output_index: outputIndex,
          item: item.status ? { ...item, status: 'in_progress' } : item,
        }),
      );
      emit(
        'response.output_item.done',
        ev('response.output_item.done', { output_index: outputIndex, item }),
      );
    }
  });

  const completedAt = body?.completed_at ?? nowSecs();
  emit(
    'response.completed',
    ev('response.completed', {
      response: { ...body, object: 'response', status: 'completed', completed_at: completedAt },
    }),
  );
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const reqId = randId('px', 5);
  const url = new URL(req.url, 'http://localhost');

  let outBytes = 0;
  const trackedWrite = (s) => {
    const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    outBytes += buf.length;
    return res.write(buf);
  };

  // Count pass-through bytes too.
  const origWrite = res.write.bind(res);
  res.write = (...a) => {
    const s = a[0];
    if (typeof s === 'string') outBytes += Buffer.byteLength(s);
    else if (Buffer.isBuffer(s)) outBytes += s.length;
    return origWrite(...a);
  };
  void trackedWrite;

  try {
    // Health endpoint (local only, no upstream call).
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, upstream: UPSTREAM, pid: process.pid });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: { message: 'method not allowed' } });
      return;
    }

    const raw = await readBody(req);

    // GET /v1/models and anything unrecognized: transparent pass-through.
    // Upstream base already ends in /v1, so strip a local /v1 prefix.
    const targetPath = url.pathname.replace(/^\/v1(?=\/|$)/, '');
    if (req.method === 'GET' || (url.pathname !== CHAT_PATH && url.pathname !== RESP_PATH)) {
      const headers = upstreamHeaders(req);
      delete headers['content-type'];
      const r = await fetch(`${UPSTREAM}${targetPath}`, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? raw : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const hdrs = { 'content-type': r.headers.get('content-type') || 'application/json' };
      res.writeHead(r.status, hdrs);
      res.end(buf);
      log(reqId, req.method, url.pathname, '->', r.status, `${Date.now() - t0}ms`, `${buf.length}B`);
      return;
    }

    // POST on one of the two inference routes.
    let body = null;
    let parseOk = true;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      parseOk = false;
    }

    if (!parseOk || body === null || typeof body !== 'object') {
      // Not our concern to fix: forward as-is non-streaming semantics cannot apply.
      const r = await fetch(`${UPSTREAM}${targetPath}`, {
        method: 'POST',
        headers: upstreamHeaders(req),
        body: raw,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(buf);
      log(reqId, req.method, url.pathname, '(opaque) ->', r.status, `${Date.now() - t0}ms`);
      return;
    }

    const wantsStream = body.stream === true;

    // Client-disconnect signal shared by all upstream calls below.
    const disconnect = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) disconnect.abort(new Error('client disconnected'));
    });
    const authHeaders = upstreamHeaders(req);

    /** Forward an already-built Responses body upstream (path is relative to the /v1 base). */
    const postResponses = async (rb) =>
      callUpstream('/responses', Buffer.from(JSON.stringify(rb)), authHeaders, disconnect.signal);

    /** Propagate an upstream failure verbatim (status + JSON error envelope). */
    const propagateError = (failure) => {
      const payload =
        failure.body !== null
          ? JSON.stringify(failure.body)
          : failure.text || '{"error":{"message":"upstream error"}}';
      res.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(payload);
      log(reqId, req.method, url.pathname, `upstream-error ${failure.status}`, `${Date.now() - t0}ms`);
    };

    // ---- Non-streaming ------------------------------------------------
    if (!wantsStream) {
      if (url.pathname === CHAT_PATH) {
        const r = await postResponses(chatRequestToResponses(body));
        if (!r.ok) return propagateError(r);
        if (r.body === null) return sendJson(res, 502, { error: { message: 'upstream returned non-JSON success response' } });
        sendJson(res, 200, responsesToChatCompletion(r.body));
        log(reqId, req.method, url.pathname, 'nonstream bridge ->', 200, `${Date.now() - t0}ms`);
        return;
      }
      // Responses route: pass through untouched.
      const r = await fetch(`${UPSTREAM}${targetPath}`, {
        method: 'POST',
        headers: authHeaders,
        body: raw,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      res.end(buf);
      log(reqId, req.method, url.pathname, 'nonstream ->', r.status, `${Date.now() - t0}ms`, `${buf.length}B`);
      return;
    }

    // ---- Streaming: force upstream non-streaming, synthesize SSE ------
    const isChat = url.pathname === CHAT_PATH;
    const upstreamReqBody = isChat ? chatRequestToResponses(body) : { ...body, stream: false };

    const upstreamRes = await postResponses(upstreamReqBody);

    if (!upstreamRes.ok) {
      propagateError(upstreamRes);
      return;
    }

    if (upstreamRes.body === null) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream returned non-JSON success response' } }));
      log(reqId, req.method, url.pathname, 'bad-upstream-json', `${Date.now() - t0}ms`);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    if (isChat) {
      synthesizeChatSSE(res, responsesToChatCompletion(upstreamRes.body), body.model);
    } else {
      synthesizeResponsesSSE(res, upstreamRes.body);
    }
    res.end();

    if (DEBUG) {
      const kinds = isChat
        ? upstreamRes.body?.choices?.[0]?.message?.tool_calls?.length
          ? 'tool_calls'
          : 'text'
        : Array.isArray(upstreamRes.body?.output)
          ? upstreamRes.body.output.map((o) => o.type).join('+')
          : '-';
      log(reqId, req.method, url.pathname, `stream synthesized [${kinds}]`, `${Date.now() - t0}ms`);
    } else {
      log(reqId, req.method, url.pathname, 'stream ->', 200, `${Date.now() - t0}ms`, `${outBytes}B`);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (res.headersSent) {
      // Mid-stream failure: terminate the stream the way clients expect.
      try {
        if (url.pathname === CHAT_PATH) {
          res.write('data: [DONE]\n\n');
        } else {
          res.write(
            `event: response.failed\ndata: ${JSON.stringify({
              type: 'response.failed',
              sequence_number: 1,
              response: { status: 'failed', error: { code: 'proxy_error', message: 'stream interrupted' } },
            })}\n\n`,
          );
        }
        res.end();
      } catch {
        /* socket already gone */
      }
      log(reqId, req.method, url.pathname, 'mid-stream-failure:', msg);
    } else {
      const status = /timeout/i.test(msg) ? 504 : 502;
      sendJson(res, status, { error: { message: `proxy: ${msg}` } });
      log(reqId, req.method, url.pathname, `failed ${status}:`, msg);
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`compat proxy listening on http://${HOST}:${PORT} -> ${UPSTREAM}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
