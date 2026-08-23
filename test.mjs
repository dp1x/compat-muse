#!/usr/bin/env node
// Protocol validation suite for the compat proxy against the live OpenCode Zen endpoint.
// Usage: OPENCODE_API_KEY=... node test.mjs [--quick]
// Prints PASS/FAIL per test; exits nonzero if any fail.

const BASE = process.env.PROXY_URL || 'http://127.0.0.1:8799';
const KEY = process.env.OPENCODE_API_KEY || '';
const MODEL = process.env.PROXY_TEST_MODEL || 'muse-spark-1.2-contributor-free';
const QUICK = process.argv.includes('--quick');

const AUTH = KEY ? { authorization: `Bearer ${KEY}` } : {};
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function postJson(path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text };
}

/** Parse an SSE payload into ordered frames {event, data}. Handles [DONE]. */
function parseSSE(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    let event = null;
    const datas = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) datas.push(line.slice(6));
      else if (line === 'data: [DONE]') datas.push('[DONE]');
    }
    if (event !== null || datas.length) frames.push({ event, datas });
  }
  return frames;
}

/** Retry wrapper: rerun fn while it reports {retryable:true}, up to attempts. */
async function withRetry(fn, attempts = 4, delayMs = 20000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (!last.retryable) return last;
    if (i < attempts - 1) {
      console.log(`  upstream ${last.status ?? 'error'}, retry ${i + 1}/${attempts - 1} in ${delayMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}

const is5xx = (s) => s >= 500;

// ---------------------------------------------------------------------------
// Chat Completions
// ---------------------------------------------------------------------------

async function testChatNonStream() {
  const r = await withRetry(async () => {
    const { status, text } = await postJson('/v1/chat/completions', {
      model: MODEL, stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    });
    if (is5xx(status)) return { retryable: true, status };
    let j = null; try { j = JSON.parse(text); } catch {}
    const ok = status === 200 && j?.object === 'chat.completion' && typeof j.choices?.[0]?.message?.content === 'string';
    return { ok, detail: `status=${status} object=${j?.object}` };
  });
  record('chat non-stream passthrough', r.ok, r.detail);
}

async function validateChatStream(label, messages, opts = {}) {
  const { minChars = 1, expectTools = null, tools = null, tool_choice = undefined } = opts;
  const r = await withRetry(async () => {
    const body = { model: MODEL, stream: true, messages };
    if (tools) body.tools = tools;
    if (tool_choice !== undefined) body.tool_choice = tool_choice;
    const { status, text } = await postJson('/v1/chat/completions', body);
    if (is5xx(status)) return { retryable: true, status };

    const problems = [];
    if (status !== 200) problems.push(`status=${status}`);
    const frames = parseSSE(text);
    if (!frames.length) problems.push('no frames');
    const doneIdx = frames.findIndex((f) => f.datas.includes('[DONE]'));
    if (doneIdx === -1) problems.push('missing [DONE]');
    if (doneIdx !== -1 && doneIdx !== frames.length - 1) problems.push('[DONE] not last');

    const jsonFrames = [];
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].datas.includes('[DONE]')) continue;
      for (const d of frames[i].datas) {
        let j; try { j = JSON.parse(d); } catch { problems.push(`frame ${i}: invalid JSON`); continue; }
        jsonFrames.push(j);
        if (typeof j.id !== 'string' || !j.id) problems.push(`frame ${i}: missing/empty id`);
        if (j.object !== 'chat.completion.chunk') problems.push(`frame ${i}: bad object=${j.object}`);
        if (!Array.isArray(j.choices)) problems.push(`frame ${i}: choices not array`);
      }
    }

    // role announcement first, terminal finish_reason last among choice-carrying chunks
    const choiceFrames = jsonFrames.filter((j) => Array.isArray(j.choices) && j.choices.length > 0);
    if (!choiceFrames.length) problems.push('no choice chunks');
    else {
      const first = choiceFrames[0]?.choices?.[0]?.delta;
      if (first?.role !== 'assistant') problems.push(`first delta role=${first?.role}`);
      const finishes = choiceFrames.filter((j) => j.choices[0].finish_reason);
      if (finishes.length !== 1) problems.push(`finish chunks=${finishes.length}`);
      else {
        const fin = finishes[0].choices[0].finish_reason;
        const wantFin = expectTools ? 'tool_calls' : 'stop';
        if (fin !== wantFin) problems.push(`finish_reason=${fin} want=${wantFin}`);
        if (finishes[0] !== choiceFrames[choiceFrames.length - 1]) problems.push('finish chunk not last');
      }
    }

    let content = '';
    let sawToolCall = null;
    for (const j of jsonFrames) {
      const d = j.choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string') content += d.content;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        const tc = d.tool_calls[0];
        sawToolCall = {
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments,
          hasIndex: Number.isInteger(tc.index),
        };
      }
    }

    if (expectTools) {
      if (!sawToolCall) problems.push('no tool_calls delta');
      else {
        if (!sawToolCall.id) problems.push('tool_call missing id');
        if (sawToolCall.name !== expectTools.name) problems.push(`tool name=${sawToolCall.name}`);
        try {
          const args = JSON.parse(sawToolCall.args || '');
          if (expectTools.argCheck && !expectTools.argCheck(args)) problems.push(`arg check failed: ${sawToolCall.args}`);
        } catch { problems.push(`arguments not valid JSON: ${sawToolCall.args}`); }
        if (!sawToolCall.hasIndex) problems.push('tool_call delta missing index');
      }
    } else if (content.length < minChars) {
      problems.push(`content too short (${content.length} < ${minChars})`);
    }

    return { ok: problems.length === 0, detail: problems.slice(0, 6).join('; ') || `contentLen=${content.length}`, toolCall: sawToolCall };
  });
  record(label, r.ok, r.detail);
  return r;
}

async function testChatMultiTurn() {
  await validateChatStream('chat turn 1 (seed fact)', [
    { role: 'user', content: 'My codename is ZEBRA-9. Just acknowledge with OK.' },
  ], { minChars: 1 });
  const r2 = await withRetry(async () => {
    const { status, text } = await postJson('/v1/chat/completions', {
      model: MODEL, stream: true,
      messages: [
        { role: 'user', content: 'My codename is ZEBRA-9. Just acknowledge with OK.' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: 'What is my codename? Reply with just the codename.' },
      ],
    });
    if (is5xx(status)) return { retryable: true, status };
    let content = ''; let ok = status === 200;
    const problems = [];
    for (const f of parseSSE(text)) {
      for (const d of f.datas) {
        if (d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          if (!j.id) problems.push('empty id');
          if (typeof j.choices?.[0]?.delta?.content === 'string') content += j.choices[0].delta.content;
        } catch { problems.push('bad json'); }
      }
    }
    ok = ok && content.includes('ZEBRA-9') && problems.length === 0;
    return { ok, detail: problems.join(';') || `reply=${JSON.stringify(content.slice(0, 40))}` };
  });
  record('chat turn 2 recalls fact (multi-turn)', r2.ok, r2.detail);
}

async function testChatTools() {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }];
  const q = 'What is the weather in Paris right now? You MUST call the get_weather tool.';
  const r1 = await validateChatStream('chat tool-call emitted correctly', [
    { role: 'user', content: q },
  ], { expectTools: { name: 'get_weather', argCheck: (a) => /paris/i.test(JSON.stringify(a)) }, tools });

  // Follow-up with tool result -> another model turn.
  const r2 = await withRetry(async () => {
    const callId = r1.toolCall?.id || 'call_test123';
    const rawArgs = r1.toolCall?.args || '{"city":"Paris"}';
    const { status, text } = await postJson('/v1/chat/completions', {
      model: MODEL, stream: true,
      messages: [
        { role: 'user', content: q },
        { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'get_weather', arguments: rawArgs } }] },
        { role: 'tool', tool_call_id: callId, content: '+18C, sunny' },
      ],
      tools,
    });
    if (is5xx(status)) return { retryable: true, status };
    let content = ''; const problems = [];
    if (status !== 200) problems.push(`status=${status}`);
    const frames = parseSSE(text);
    if (!frames.some((f) => f.datas.includes('[DONE]'))) problems.push('missing [DONE]');
    for (const f of frames) for (const d of f.datas) {
      if (d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { problems.push('bad json'); continue; }
      if (!j.id) problems.push('empty id');
      if (typeof j.choices?.[0]?.delta?.content === 'string') content += j.choices[0].delta.content;
    }
    const ok = problems.length === 0 && content.length > 0;
    return { ok, detail: problems.join(';') || `finalTurnChars=${content.length}` };
  });
  record('chat tool-result -> next model turn', r2.ok, r2.detail);
}

async function testChatLong() {
  await validateChatStream(
    'chat long output (~800 words)',
    [{ role: 'user', content: 'Write a technical explanation of roughly 800 words about database WAL checkpoints. Plain prose.' }],
    { minChars: 2500 },
  );
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function analyzeResponsesSSE(text) {
  const problems = [];
  const frames = parseSSE(text).filter((f) => f.event || f.datas.length);
  const events = frames.map((f) => f.event);
  if (events[0] !== 'response.created') problems.push(`first event=${events[0]}`);
  if (events[events.length - 1] !== 'response.completed') problems.push(`last event=${events[events.length - 1]}`);
  if (events.includes('ping')) problems.push('ping event present');
  let seqOk = true;
  let prev = 0;
  let textOut = '';
  let fnCall = null;
  let completedResponse = null;
  for (const f of frames) {
    for (const d of f.datas) {
      if (d === '[DONE]') { problems.push('[DONE] in responses stream'); continue; }
      let j; try { j = JSON.parse(d); } catch { problems.push('invalid json'); continue; }
      if (typeof j.sequence_number !== 'number' || j.sequence_number <= prev) seqOk = false;
      prev = j.sequence_number ?? prev;
      if (j.type === 'response.output_text.delta' && typeof j.delta === 'string') textOut += j.delta;
      if (j.type === 'response.output_item.done' && j.item?.type === 'function_call') {
        fnCall = { id: j.item.id, callId: j.item.call_id, name: j.item.name, args: j.item.arguments };
      }
      if (f.event === 'response.completed') completedResponse = j.response;
    }
  }
  if (!seqOk) problems.push('sequence_number not increasing');
  if (completedResponse?.status !== 'completed') problems.push(`completed status=${completedResponse?.status}`);
  if (!completedResponse?.id) problems.push('completed response missing id');
  return { problems, textOut, fnCall, events, completedResponse };
}

async function testResponsesText() {
  const r = await withRetry(async () => {
    const { status, text } = await postJson('/v1/responses', {
      model: MODEL, stream: true, input: 'Reply with exactly: pong',
    });
    if (is5xx(status)) return { retryable: true, status };
    const a = analyzeResponsesSSE(text);
    const ok = status === 200 && a.problems.length === 0 && a.textOut.length > 0;
    return { ok, detail: a.problems.join('; ') || `text=${JSON.stringify(a.textOut.slice(0, 20))}` };
  });
  record('responses stream: clean event sequence, no ping', r.ok, r.detail);
}

async function testResponsesMultiTurn() {
  const inp = [
    { role: 'user', content: [{ type: 'input_text', text: 'My codename is KILO-77. Just acknowledge with OK.' }] },
  ];
  await withRetry(async () => {
    const { status } = await postJson('/v1/responses', { model: MODEL, stream: true, input: structuredClone(inp) });
    return status >= 500 ? { retryable: true, status } : { ok: status === 200, detail: `t1=${status}` };
  }).then((r) => record('responses turn 1 (seed fact)', r.ok, r.detail));

  const r2 = await withRetry(async () => {
    const { status, text } = await postJson('/v1/responses', {
      model: MODEL, stream: true,
      input: [
        ...inp,
        { role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'What is my codename? Reply with just the codename.' }] },
      ],
    });
    if (is5xx(status)) return { retryable: true, status };
    const a = analyzeResponsesSSE(text);
    const ok = status === 200 && a.problems.length === 0 && a.textOut.includes('KILO-77');
    return { ok, detail: a.problems.join(';') || `reply=${JSON.stringify(a.textOut.slice(0, 30))}` };
  });
  record('responses turn 2 recalls fact (multi-turn)', r2.ok, r2.detail);
}

async function testResponsesTools() {
  const tools = [{
    type: 'function', name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }];
  const qTxt = 'What is the weather in Tokyo right now? You MUST call the get_weather tool.';
  const inp = [{ role: 'user', content: [{ type: 'input_text', text: qTxt }] }];

  const r1 = await withRetry(async () => {
    const { status, text } = await postJson('/v1/responses', { model: MODEL, stream: true, input: structuredClone(inp), tools });
    if (is5xx(status)) return { retryable: true, status };
    const a = analyzeResponsesSSE(text);
    const fc = a.fnCall;
    const probs = [...a.problems];
    if (!fc) probs.push('no function_call item');
    else {
      if (!fc.callId) probs.push('function_call missing call_id');
      if (fc.name !== 'get_weather') probs.push(`name=${fc.name}`);
      try {
        const args = JSON.parse(fc.args || '');
        if (!/tokyo/i.test(JSON.stringify(args))) probs.push(`args=${fc.args}`);
      } catch { probs.push(`args not json: ${fc.args}`); }
    }
    return { ok: probs.length === 0, detail: probs.join('; ') || 'function_call ok', fnCall: fc };
  });
  record('responses tool-call emitted correctly', r1.ok, r1.detail);

  const r2 = await withRetry(async () => {
    const callId = r1.fnCall?.callId || 'call_test';
    const itemId = r1.fnCall?.id || 'fc_1';
    const rawArgs = r1.fnCall?.args || '{"city":"Tokyo"}';
    const { status, text } = await postJson('/v1/responses', {
      model: MODEL, stream: true,
      input: [
        ...structuredClone(inp),
        { type: 'function_call', id: itemId, call_id: callId, name: 'get_weather', arguments: rawArgs },
        { type: 'function_call_output', call_id: callId, output: '+22C, clear' },
      ],
      tools,
    });
    if (is5xx(status)) return { retryable: true, status };
    const a = analyzeResponsesSSE(text);
    const ok = status === 200 && a.problems.length === 0 && a.textOut.length > 0;
    return { ok, detail: a.problems.join(';') || `finalTurnChars=${a.textOut.length}` };
  });
  record('responses function_output -> next model turn', r2.ok, r2.detail);
}

async function testResponsesReasoningPreserved() {
  const r = await withRetry(async () => {
    const { status, text } = await postJson('/v1/responses', {
      model: MODEL, stream: true,
      reasoning: { effort: 'low' },
      input: 'What is 17*24? Think briefly, then give the number.',
    });
    if (is5xx(status)) return { retryable: true, status };
    const a = analyzeResponsesSSE(text);
    const hasReasoningItem = a.events.some((e) => false); // events don't carry item types; check completed payload
    void hasReasoningItem;
    const outTypes = (a.completedResponse?.output ?? []).map((o) => o.type);
    const ok = status === 200 && a.problems.length === 0 && outTypes.includes('reasoning') && /\d{3}/.test(a.textOut.replace(/,/g, ''));
    return { ok, detail: a.problems.join(';') || `itemTypes=[${outTypes}] answerHasNumber=${/\d{3}/.test(a.textOut)}` };
  });
  record('responses reasoning item preserved + math answer', r.ok, r.detail);
}

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

async function testErrorPropagation() {
  const r = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-invalid-key-for-error-test' },
    body: JSON.stringify({ model: MODEL, stream: true, input: 'hi' }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const looksError = j?.error?.message || j?.type === 'error' || /error/i.test(text.slice(0, 200));
  const ok = r.status >= 400 && r.status < 500 && looksError;
  record('upstream auth error propagated (4xx + error envelope)', ok, `status=${r.status}`);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(`testing proxy at ${BASE} with model ${MODEL}\n`);
  await testChatNonStream();
  await validateChatStream('chat stream: strict schema + [DONE]', [{ role: 'user', content: 'Reply with exactly: pong' }]);
  await testChatMultiTurn();
  await testChatTools();
  if (!QUICK) await testChatLong();
  await testResponsesText();
  await testResponsesMultiTurn();
  await testResponsesTools();
  if (!QUICK) await testResponsesReasoningPreserved();
  await testErrorPropagation();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', e);
  process.exit(2);
});
