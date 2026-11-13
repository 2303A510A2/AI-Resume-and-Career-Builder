// Offline regression tests for missing-key failover, provider circuits,
// inference diagnostics, and preservation of partial streaming output.
// No network, MongoDB, real provider key, or quota spend.
/* eslint-disable no-console */
const envNames = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY',
  'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY',
  'GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'LLM_FALLBACK_PROVIDER', 'LLM_FALLBACK_BASE_URL', 'LLM_FALLBACK_MODEL', 'LLM_FALLBACK_API_KEY',
  'LLM_FALLBACK2_PROVIDER', 'LLM_FALLBACK2_BASE_URL', 'LLM_FALLBACK2_MODEL', 'LLM_FALLBACK2_API_KEY',
  'LLM_MAX_RETRIES', 'LLM_PROVIDER_CIRCUIT_COOLDOWN_MS', 'LLM_PROVIDER_RATE_LIMIT_COOLDOWN_MS',
  'LLM_PROVIDER_DAILY_COOLDOWN_MS', 'LLM_PROVIDER_CONFIG_COOLDOWN_MS', 'LLM_PROVIDER_DIAGNOSTIC_COOLDOWN_MS',
  'LLM_INPUT_TOKEN_LIMIT', 'LLM_OUTPUT_TOKEN_LIMIT', 'NODE_ENV', 'PROVIDER_LOG',
];
for (const name of envNames) delete process.env[name];
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.LLM_MODEL = 'openai/gpt-oss-20b';
process.env.LLM_API_KEY = 'gsk_test_reliability_groq_not_real';
process.env.LLM_FALLBACK_PROVIDER = 'openai';
process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1';
process.env.LLM_FALLBACK_MODEL = 'gpt-4o-mini';
process.env.LLM_FALLBACK_API_KEY = 'sk-test-reliability-openai-not-real';
process.env.LLM_FALLBACK2_PROVIDER = 'gemini';
process.env.LLM_FALLBACK2_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
process.env.LLM_FALLBACK2_MODEL = 'gemini-2.5-flash';
process.env.LLM_FALLBACK2_API_KEY = 'AIzaTestReliabilityGeminiKeyNotReal123';
process.env.LLM_MAX_RETRIES = '0';
process.env.LLM_PROVIDER_CIRCUIT_COOLDOWN_MS = '30000';
process.env.LLM_PROVIDER_RATE_LIMIT_COOLDOWN_MS = '30000';
process.env.LLM_PROVIDER_DAILY_COOLDOWN_MS = '30000';
process.env.LLM_PROVIDER_CONFIG_COOLDOWN_MS = '30000';
process.env.LLM_PROVIDER_DIAGNOSTIC_COOLDOWN_MS = '30000';
process.env.LLM_INPUT_TOKEN_LIMIT = '32000';
process.env.LLM_OUTPUT_TOKEN_LIMIT = '8000';
process.env.NODE_ENV = 'test';
process.env.PROVIDER_LOG = '0';

const llmService = require('../services/llmService');
const providers = require('../services/providers');

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
  if (condition) passed += 1;
  else failed += 1;
};

const http = (status, payload) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const reply = (content) => http(200, {
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 4 },
});

let calls = [];
let responder = () => reply('OK');
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({
    url: String(url),
    model: body.model,
    auth: String(init.headers.Authorization || ''),
    body,
  });
  return responder(calls[calls.length - 1], calls.length);
};

const run = async () => {
  calls = [];
  try {
    const result = await llmService.chat({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
      maxRetries: 0,
      returnMeta: true,
    });
    return { result, error: null, calls: calls.slice() };
  } catch (error) {
    return { result: null, error, calls: calls.slice() };
  }
};

const main = async () => {
  console.log('\n1) Missing primary key uses a configured fallback');
  llmService.resetProviderCircuits();
  delete process.env.LLM_API_KEY;
  responder = (call) => call.url.includes('openai.com') ? reply('OpenAI fallback answer') : reply('Unexpected');
  const missingPrimary = await run();
  check('Groq is not called without its key', missingPrimary.calls.length === 1 && missingPrimary.calls[0].url.includes('openai.com'));
  check('OpenAI returns a real completion through the fallback path', missingPrimary.result?.content === 'OpenAI fallback answer');
  check('the OpenAI key is sent only to OpenAI', missingPrimary.calls[0]?.auth === `Bearer ${process.env.LLM_FALLBACK_API_KEY}`);

  const primaryTarget = providers.diagnosticTargets().find((target) => target.slot === 'primary');
  check('missing primary configuration lists the actual accepted key variables', /LLM_API_KEY/.test(primaryTarget?.missingKeyVariable || '') && /AI_API_KEY/.test(primaryTarget?.missingKeyVariable || ''));

  const savedFallback = {
    provider: process.env.LLM_FALLBACK_PROVIDER,
    baseUrl: process.env.LLM_FALLBACK_BASE_URL,
    model: process.env.LLM_FALLBACK_MODEL,
    apiKey: process.env.LLM_FALLBACK_API_KEY,
  };
  delete process.env.LLM_FALLBACK_PROVIDER;
  delete process.env.LLM_FALLBACK_BASE_URL;
  delete process.env.LLM_FALLBACK_API_KEY;
  process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b';
  const sameKeyTarget = providers.diagnosticTargets().find((target) => target.slot === 'fallback1');
  check('a missing same-key fallback is diagnosed as the primary provider and key source', sameKeyTarget?.provider === 'groq' && sameKeyTarget.missingKeyVariable === primaryTarget?.missingKeyVariable);
  if (savedFallback.provider === undefined) delete process.env.LLM_FALLBACK_PROVIDER;
  else process.env.LLM_FALLBACK_PROVIDER = savedFallback.provider;
  if (savedFallback.baseUrl === undefined) delete process.env.LLM_FALLBACK_BASE_URL;
  else process.env.LLM_FALLBACK_BASE_URL = savedFallback.baseUrl;
  if (savedFallback.model === undefined) delete process.env.LLM_FALLBACK_MODEL;
  else process.env.LLM_FALLBACK_MODEL = savedFallback.model;
  if (savedFallback.apiKey === undefined) delete process.env.LLM_FALLBACK_API_KEY;
  else process.env.LLM_FALLBACK_API_KEY = savedFallback.apiKey;

  console.log('\n2) All configured providers fail with differentiated safe reasons');
  llmService.resetProviderCircuits();
  process.env.LLM_API_KEY = 'gsk_test_reliability_groq_not_real';
  responder = (call) => {
    if (call.url.includes('groq.com')) return http(429, 'Rate limit reached for model on tokens per day (TPD): limit reached');
    if (call.url.includes('openai.com')) return http(401, { error: { message: 'invalid api key sk-test-provider-body-secret-not-for-logs' } });
    return http(404, { error: { message: 'model not found' } });
  };
  const providerErrorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => providerErrorLogs.push(args.join(' '));
  let allFailed;
  try {
    allFailed = await run();
  } finally {
    console.error = originalConsoleError;
  }
  check('the full order is Groq, OpenAI, then Gemini', allFailed.calls.length === 3 && allFailed.calls[0].url.includes('groq.com') && allFailed.calls[1].url.includes('openai.com') && allFailed.calls[2].url.includes('generativelanguage.googleapis.com'));
  check('the error names the actual quota, key, and model failures', /Groq: daily quota exhausted/.test(allFailed.error?.message || '') && /OpenAI: invalid API key/.test(allFailed.error?.message || '') && /Gemini: model unavailable/.test(allFailed.error?.message || ''), allFailed.error?.message);
  check('safe provider failure fields are attached', allFailed.error?.providerFailures?.length === 3 && allFailed.error.providerFailures.every((item) => item.provider && item.category));
  check('provider response bodies never appear in server error logs', !providerErrorLogs.some((line) => line.includes('sk-test-provider-body-secret-not-for-logs')), `${providerErrorLogs.length} error log(s) checked`);
  check('no fake completion is returned after all providers fail', !allFailed.result && allFailed.error?.code === 'AI_PROVIDERS_UNAVAILABLE');

  console.log('\n3) Open circuits suppress repeated provider calls');
  const circuitOpen = await run();
  check('a second request makes no calls while all circuits are open', circuitOpen.calls.length === 0);
  check('the circuit error still identifies quota exhaustion', /Groq: daily quota exhausted/.test(circuitOpen.error?.message || ''), circuitOpen.error?.code);

  console.log('\n4) Wrong provider base URLs never receive a provider key');
  llmService.resetProviderCircuits();
  process.env.LLM_BASE_URL = 'https://api.openai.com/v1';
  responder = (call) => call.url.includes('openai.com') ? reply('Correct fallback') : reply('wrong host');
  const mismatch = await run();
  check('the mismatched Groq endpoint is not called', mismatch.calls.every((call) => call.url.includes('openai.com')));
  check('the correctly configured fallback still answers', mismatch.result?.content === 'Correct fallback');
  check('no Groq key reaches the OpenAI URL', mismatch.calls.every((call) => call.auth !== `Bearer ${process.env.LLM_API_KEY}`));

  console.log('\n5) Admin diagnostic performs actual per-provider inference and returns safe metadata');
  llmService.resetProviderCircuits();
  process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
  calls = [];
  responder = () => reply('OK');
  const diagnostic = await llmService.runProviderDiagnostics();
  const diagnosticCalls = calls.slice();
  check('diagnostic inference succeeds for all configured providers', diagnostic.providers.length === 3 && diagnostic.providers.every((item) => item.lastInferenceStatus === 'success'));
  check('diagnostics report HTTP category, latency, model and provider', diagnostic.providers.every((item) => item.httpStatusCategory === 'success' && item.httpStatus === 200 && item.responseLatencyMs >= 0 && item.model && item.provider));
  check('diagnostic inference reserves enough output for reasoning models', diagnosticCalls.length === 3 && diagnosticCalls.every((call) => call.body.max_tokens === 128));
  check('diagnostics contain no API key values', !JSON.stringify(diagnostic).includes('gsk_test_reliability_groq_not_real') && !JSON.stringify(diagnostic).includes('sk-test-reliability-openai-not-real'));
  check('the provider diagnostic target source lists only environment variable names', providers.diagnosticTargets().every((item) => !JSON.stringify(item).includes('gsk_test_reliability_groq_not_real')));

  console.log('\n6) Streaming interruptions preserve content already emitted');
  llmService.resetProviderCircuits();
  let emitted = '';
  calls = [];
  const encoder = new TextEncoder();
  let readCount = 0;
  responder = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          readCount += 1;
          if (readCount === 1) {
            return {
              done: false,
              value: encoder.encode('data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n'),
            };
          }
          throw new Error('simulated stream interruption');
        },
      }),
    },
  });
  const streamResult = await llmService.chat({
    messages: [{ role: 'user', content: 'Explain Java.' }],
    maxTokens: 64,
    maxRetries: 0,
    onDelta: async (delta) => { emitted += delta; },
    returnMeta: true,
  });
  check('partial streamed content is preserved in the result', streamResult.content === 'partial answer' && emitted === 'partial answer');
  check('stream interruption is marked truncated instead of being replaced by an error', streamResult.truncated === true && calls.length === 1);

  console.log(`\nproviderReliabilityTest: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`providerReliabilityTest aborted: ${String(error && error.code || error && error.message || 'internal_error')}`);
  process.exitCode = 1;
});
