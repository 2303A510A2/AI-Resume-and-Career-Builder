// Offline streaming regression tests. No database, network, or real provider key.
/* eslint-disable no-console */
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.LLM_MODEL = 'stream-test-model';
process.env.LLM_API_KEY = 'stream-test-key';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const llmService = require('../services/llmService');

let passed = 0;
const ok = (name, condition, detail = '') => {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  OK   ${name}`);
};

const response = ({ status = 200, body = '', headers = {} } = {}) => {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
};

const sse = (content, finishReason = 'stop') =>
  content
    .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    .concat(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`)
    .join('');

const main = async () => {
  const originalFetch = global.fetch;
  try {
    let calls = 0;
    const deltas = [];
    global.fetch = async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      ok('stream request sets stream=true', body.stream === true);
      if (body.messages[0]?.content === 'cancel') {
        return response({ body: sse(['first ', 'second ']) });
      }
      return response({ body: sse(['Hello ', 'streaming ', 'world.']) });
    };
    const result = await llmService.chat({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 200,
      returnMeta: true,
      onDelta: (text) => deltas.push(text),
    });
    ok('successful stream makes one provider call', calls === 1);
    ok('successful stream emits progressive deltas', deltas.join('') === 'Hello streaming world.');
    ok('successful stream returns the assembled content', result.content === 'Hello streaming world.');

    calls = 0;
    const abort = new AbortController();
    const cancelled = await llmService.chat({
      messages: [{ role: 'user', content: 'cancel' }],
      maxTokens: 200,
      returnMeta: true,
      abortSignal: abort.signal,
      onDelta: (text) => {
        if (text === 'first ') abort.abort();
      },
    });
    ok('cancelled stream preserves partial content', cancelled.content.startsWith('first'), JSON.stringify(cancelled));
    ok('cancelled stream is marked cancelled', cancelled.cancelled === true, JSON.stringify(cancelled));

    global.fetch = async () => response({ body: sse(['partial'], 'length') });
    const incomplete = await llmService.chat({
      messages: [{ role: 'user', content: 'long answer' }],
      maxTokens: 200,
      returnMeta: true,
      onDelta: () => {},
    });
    ok('length finish reason marks stream incomplete', incomplete.truncated === true);
    ok('incomplete stream retains content', incomplete.content === 'partial');

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return response({
          status: 429,
          body: JSON.stringify({ error: { message: 'requests per minute (RPM)' } }),
          headers: { 'retry-after': '0' },
        });
      }
      return response({ body: sse(['retry succeeded']) });
    };
    const retried = await llmService.chat({
      messages: [{ role: 'user', content: 'retry' }],
      maxTokens: 200,
      maxRetries: 1,
      returnMeta: true,
      onDelta: () => {},
    });
    ok('per-minute 429 retries once and reconnects', calls === 2);
    ok('reconnected stream returns content', retried.content === 'retry succeeded');
  } finally {
    global.fetch = originalFetch;
  }
  console.log(`\nALL ${passed} STREAMING ASSERTIONS PASSED`);
};

main().catch((err) => {
  console.error(`\nSTREAMING TEST FAILED: ${err.message}`);
  process.exitCode = 1;
});
