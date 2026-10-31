// Offline multi-provider fallback contract: Groq -> OpenAI -> Gemini.
//
// THE BUG THIS GUARDS
//   On the deployed Render app a spent Groq free-tier allowance surfaced
//   "Today's AI provider quota has been reached…" even though OpenAI and Gemini
//   were configured. The chain must switch providers automatically on a quota /
//   rate-limit / outage / network failure, keep the EXACT same prompt/history/
//   system instructions, never leak one provider's key to another, and — only
//   when every configured provider really failed — show exactly:
//     "All configured AI providers are currently unavailable or have reached
//      their usage limits. Please try again later."
//
// WHAT IT PROVES
//   1. Groq healthy                      -> one call, no fallback.
//   2. Groq quota 429                    -> OpenAI answers (own URL/model/key).
//   3. Groq + OpenAI quota 429           -> Gemini answers (own URL/model/key).
//   4. All three fail                    -> the EXACT all-fail message, one
//                                           bounded call per provider, safe logs.
//   5. Groq 401 auth                     -> NEVER falls back (auth is not an
//                                           availability problem), one call.
//   6. Groq network/timeout              -> OpenAI answers.
//   7. Prompt/history/system/format      -> byte-identical on every provider.
//   Plus configuration resolution: Gemini OpenAI-compatible URL normalization,
//   provider-specific key aliases (OPENAI_API_KEY / GEMINI_API_KEY), a declared
//   provider WITHOUT a key is never called, and no log line ever contains a key.
//
// NO network, NO MongoDB, NO real AI key, NO quota spend.
// Run: node scripts/providerFallbackTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ---- Deterministic environment. MUST run before llmService is required.
const GROQ_KEY = 'gsk_test_fallback_suite_groq_not_real';
const OPENAI_KEY = 'sk-test-fallback-suite-openai-not-real';
const GEMINI_KEY = 'AIzaTestFallbackSuiteGeminiKeyNotReal123';
const REAL_KEYS = [
  process.env.LLM_API_KEY,
  process.env.AI_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.OPENAI_API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_API_KEY,
  process.env.LLM_FALLBACK_API_KEY,
  process.env.LLM_FALLBACK2_API_KEY,
].filter(Boolean).map(String);

const clearProviderEnv = () => {
  [
    'AI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL',
    'LLM_FALLBACK_API_KEY', 'LLM_FALLBACK_BASE_URL', 'LLM_FALLBACK_PROVIDER', 'LLM_FALLBACK_MODEL',
    'LLM_FALLBACK2_API_KEY', 'LLM_FALLBACK2_BASE_URL', 'LLM_FALLBACK2_PROVIDER', 'LLM_FALLBACK2_MODEL',
  ].forEach((name) => { delete process.env[name]; });
};

clearProviderEnv();
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.LLM_MODEL = 'openai/gpt-oss-20b';
process.env.LLM_API_KEY = GROQ_KEY;
process.env.LLM_MAX_RETRIES = '0'; // one attempt per provider — exact call counts
process.env.LLM_INPUT_TOKEN_LIMIT = '32000';
process.env.LLM_OUTPUT_TOKEN_LIMIT = '8000';
process.env.NODE_ENV = 'test'; // dev trace logs ON
delete process.env.PROVIDER_LOG;

// ---- Log capture (asserted for safety and for the fallback trace).
const captured = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
console.log = (...a) => { captured.push(a.join(' ')); };
console.error = (...a) => { captured.push(a.join(' ')); };
const say = (...a) => realLog(...a);

const llmService = require('../services/llmService');
const providers = require('../services/providers');

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    passed += 1;
    say(`  OK   ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    say(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
};

// ---- Stubbed provider transport.
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
const okReply = (content) => http(200, {
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const BODY_TPD =
  'Rate limit reached for model "openai/gpt-oss-20b" on tokens per day (TPD): Limit 200000, Used 200000, Please try again in 35.424s.';

let responder = null;
let fetchCalls = [];
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const call = {
    url: String(url),
    model: String(body.model || ''),
    temperature: body.temperature,
    maxTokens: Number(body.max_tokens || 0),
    messages: body.messages,
    tools: Array.isArray(body.tools) ? body.tools : [],
    auth: String((init && init.headers && init.headers.Authorization) || ''),
  };
  fetchCalls.push(call);
  if (!responder) throw new Error('providerFallbackTest: no responder configured');
  return responder(call, fetchCalls.length);
};

const runChat = async ({ respond, messages, maxTokens = 256, requestId = 'fallback-test-rid' }) => {
  fetchCalls = [];
  responder = respond;
  const mark = captured.length;
  let error = null;
  let content = null;
  try {
    content = await llmService.chat({
      messages: messages || [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxTokens,
      maxRetries: 0,
      requestId,
    });
  } catch (err) {
    error = err;
  }
  return { error, content, calls: fetchCalls.slice(), logs: captured.slice(mark) };
};

const configureThreeProviders = () => {
  clearProviderEnv();
  process.env.LLM_PROVIDER = 'groq';
  process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.LLM_MODEL = 'openai/gpt-oss-20b';
  process.env.LLM_API_KEY = GROQ_KEY;

  process.env.LLM_FALLBACK_PROVIDER = 'openai';
  process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1';
  process.env.LLM_FALLBACK_MODEL = 'gpt-4o-mini';
  process.env.LLM_FALLBACK_API_KEY = OPENAI_KEY;

  process.env.LLM_FALLBACK2_PROVIDER = 'gemini';
  process.env.LLM_FALLBACK2_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
  process.env.LLM_FALLBACK2_MODEL = 'gemini-2.5-flash';
  process.env.LLM_FALLBACK2_API_KEY = GEMINI_KEY;
};

const assertNoSecretsInLogs = (logs, label) => {
  const joined = logs.join('\n');
  const leaked = [GROQ_KEY, OPENAI_KEY, GEMINI_KEY, ...REAL_KEYS]
    .filter(Boolean)
    .some((secret) => joined.includes(String(secret)));
  ok(`${label}: logs never contain a provider key or Bearer token`, !leaked && !/Bearer\s+[A-Za-z0-9._-]{10,}/.test(joined), leaked ? 'a key leaked' : 'clean');
};

const main = async () => {
  say('\n0) Configuration: Groq primary + OpenAI fallback 1 + Gemini fallback 2');
  {
    configureThreeProviders();
    const d = llmService.describe();
    ok('primary resolves to Groq with the configured model', d.provider === 'groq' && d.model === 'openai/gpt-oss-20b', `${d.provider}/${d.model}`);
    ok('fallback chain resolves OpenAI then Gemini, in order', d.fallbackChain.length === 2 && d.fallbackChain[0].provider === 'openai' && d.fallbackChain[1].provider === 'gemini', JSON.stringify(d.fallbackChain));
    ok('fallback slot 1 targets the OpenAI model', d.fallbackChain[0].model === 'gpt-4o-mini', d.fallbackChain[0].model);
    ok('fallback slot 2 targets the Gemini model', d.fallbackChain[1].model === 'gemini-2.5-flash', d.fallbackChain[1].model);
    ok('both fallback slots report configured', d.fallback1Configured === true && d.fallback2Configured === true, `${d.fallback1Configured}/${d.fallback2Configured}`);
    ok('describe() exposes no key material', !JSON.stringify(d).includes(GROQ_KEY) && !JSON.stringify(d).includes(OPENAI_KEY) && !JSON.stringify(d).includes(GEMINI_KEY), 'clean');

    // Gemini accepts both documented roots; both must become the OpenAI-compatible root.
    process.env.LLM_FALLBACK2_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
    ok('Gemini /v1beta base URL is repaired to /v1beta/openai', llmService.getFallbackChain()[1].baseUrl === 'https://generativelanguage.googleapis.com/v1beta/openai', llmService.getFallbackChain()[1].baseUrl);
    process.env.LLM_FALLBACK2_BASE_URL = 'https://generativelanguage.googleapis.com';
    ok('Gemini bare host is repaired to /v1beta/openai', llmService.getFallbackChain()[1].baseUrl === 'https://generativelanguage.googleapis.com/v1beta/openai', llmService.getFallbackChain()[1].baseUrl);
    process.env.LLM_FALLBACK2_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

    // Provider-specific key aliases: a declared provider can use its own key.
    delete process.env.LLM_FALLBACK_API_KEY;
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    ok('a declared OpenAI fallback reuses OPENAI_API_KEY when LLM_FALLBACK_API_KEY is absent', (llmService.getFallbackConfig() || {}).apiKey === OPENAI_KEY, 'alias key used');
    delete process.env.OPENAI_API_KEY;

    delete process.env.LLM_FALLBACK2_API_KEY;
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    ok('a declared Gemini fallback reuses GEMINI_API_KEY when LLM_FALLBACK2_API_KEY is absent', (llmService.getFallbackChain()[0] || {}).apiKey === GEMINI_KEY, 'alias key used');
    delete process.env.GEMINI_API_KEY;

    // Declared provider with NO key at all is incomplete -> never called, and the
    // primary key is never sent to a foreign endpoint.
    ok('a declared fallback provider with no key resolves to no fallback', llmService.getFallbackConfig() === null, 'null');
    ok('with neither slot keyed the chain is empty', llmService.getFallbackChain().length === 0, llmService.getFallbackChain().map((c) => c.provider).join(',') || '(empty)');

    // One complete slot + one incomplete slot: only the complete one is called.
    process.env.LLM_FALLBACK_API_KEY = OPENAI_KEY;
    ok('an incomplete Gemini slot is excluded while OpenAI stays in the chain', llmService.getFallbackChain().length === 1 && llmService.getFallbackChain()[0].provider === 'openai', llmService.getFallbackChain().map((c) => c.provider).join(','));
    configureThreeProviders();
  }

  say('\n1) Groq healthy: exactly one call, no fallback');
  {
    const r = await runChat({ respond: () => okReply('GROQ ANSWER') });
    ok('the Groq answer is returned', r.error === null && r.content === 'GROQ ANSWER', r.error ? r.error.message : String(r.content));
    ok('exactly ONE provider call', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('the call goes to Groq with the Groq model', r.calls[0].url.startsWith('https://api.groq.com/openai/v1/chat/completions') && r.calls[0].model === 'openai/gpt-oss-20b', `${r.calls[0].url} ${r.calls[0].model}`);
    ok('the primary uses the Groq key', r.calls[0].auth === `Bearer ${GROQ_KEY}`, 'primary key');
    ok('logs name Groq and never switch', r.logs.some((l) => /^\[AI\] Primary provider: Groq$/.test(l)) && !r.logs.some((l) => /Switching to/.test(l)), (r.logs.find((l) => /Primary provider/.test(l)) || '(none)'));
    assertNoSecretsInLogs(r.logs, 'Groq healthy');
  }

  say('\n2) Groq quota exhausted -> OpenAI answers');
  {
    const r = await runChat({
      respond: (call) => (call.url.includes('openai.com') ? okReply('OPENAI ANSWER') : http(429, BODY_TPD)),
    });
    ok('the OpenAI fallback saves the message', r.error === null && r.content === 'OPENAI ANSWER', r.error ? r.error.message : String(r.content));
    ok('exactly 1 Groq + 1 OpenAI call', r.calls.length === 2 && r.calls[0].url.includes('groq.com') && r.calls[1].url.includes('openai.com'), r.calls.map((c) => c.url).join(' | '));
    ok('the fallback targets the OpenAI model', r.calls[1].model === 'gpt-4o-mini', r.calls[1].model);
    ok('the fallback uses its OWN OpenAI key (never the Groq key)', r.calls[1].auth === `Bearer ${OPENAI_KEY}` && r.calls[0].auth === `Bearer ${GROQ_KEY}`, 'separate keys');
    ok('Gemini is not called when OpenAI succeeds', r.calls.length === 2, `${r.calls.length} call(s)`);
    ok('logs trace Groq quota -> switching to OpenAI -> success', r.logs.some((l) => /^\[AI\] Groq quota exceeded\.$/.test(l)) && r.logs.some((l) => /^\[AI\] Switching to OpenAI\.$/.test(l)) && r.logs.some((l) => /^\[AI\] OpenAI response successful\.$/.test(l)), (r.logs.find((l) => /Switching to/.test(l)) || '(none)'));
    assertNoSecretsInLogs(r.logs, 'Groq -> OpenAI');
  }

  say('\n3) Groq + OpenAI exhausted -> Gemini answers');
  {
    const r = await runChat({
      respond: (call) => (call.url.includes('generativelanguage') ? okReply('GEMINI ANSWER') : http(429, BODY_TPD)),
    });
    ok('the Gemini fallback saves the message', r.error === null && r.content === 'GEMINI ANSWER', r.error ? r.error.message : String(r.content));
    ok('exactly 1 Groq + 1 OpenAI + 1 Gemini call', r.calls.length === 3, `${r.calls.length} call(s)`);
    ok('the third call hits the Gemini OpenAI-compatible endpoint', r.calls[2].url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', r.calls[2].url);
    ok('the third call uses the Gemini model', r.calls[2].model === 'gemini-2.5-flash', r.calls[2].model);
    ok('every provider uses its OWN key', r.calls[0].auth === `Bearer ${GROQ_KEY}` && r.calls[1].auth === `Bearer ${OPENAI_KEY}` && r.calls[2].auth === `Bearer ${GEMINI_KEY}`, 'separate keys');
    ok('logs trace both switches and the Gemini success', r.logs.some((l) => /^\[AI\] Switching to OpenAI\.$/.test(l)) && r.logs.some((l) => /^\[AI\] Switching to Gemini\.$/.test(l)) && r.logs.some((l) => /^\[AI\] Gemini response successful\.$/.test(l)), (r.logs.find((l) => /Switching to Gemini/.test(l)) || '(none)'));
    assertNoSecretsInLogs(r.logs, 'Groq -> OpenAI -> Gemini');
  }

  say('\n4) Every provider fails -> the EXACT all-fail message');
  {
    const expected = 'All configured AI providers are currently unavailable or have reached their usage limits. Please try again later.';
    ok('the exported message is exactly the required wording', llmService.ALL_PROVIDERS_FAILED_MESSAGE === expected, llmService.ALL_PROVIDERS_FAILED_MESSAGE);

    const daily = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('all-quota failure surfaces AI_PROVIDERS_UNAVAILABLE', daily.error && daily.error.code === 'AI_PROVIDERS_UNAVAILABLE', daily.error ? daily.error.code : '(no error)');
    ok('the message is the exact all-fail wording', daily.error && daily.error.message === expected, daily.error ? daily.error.message : '');
    ok('a quota-involved all-fail is NOT retryable', daily.error && daily.error.retryable === false, `retryable=${daily.error && daily.error.retryable}`);
    ok('the all-fail error is tagged usedFallback', daily.error && daily.error.usedFallback === true, `usedFallback=${daily.error && daily.error.usedFallback}`);
    ok('one bounded attempt per configured provider (3 calls)', daily.calls.length === 3, `${daily.calls.length} call(s)`);
    ok('logs end with the all-providers-failed line', daily.logs.some((l) => /^\[AI\] All configured AI providers failed\.$/.test(l)), (daily.logs.find((l) => /All configured AI providers failed/.test(l)) || '(none)'));
    assertNoSecretsInLogs(daily.logs, 'all quota fail');

    const outage = await runChat({ respond: () => http(503, 'service unavailable') });
    ok('all-outage failure also surfaces AI_PROVIDERS_UNAVAILABLE', outage.error && outage.error.code === 'AI_PROVIDERS_UNAVAILABLE', outage.error ? outage.error.code : '(no error)');
    ok('all-outage uses the same exact all-fail wording', outage.error && outage.error.message === expected, outage.error ? outage.error.message : '');
    ok('an outage-only all-fail stays retryable', outage.error && outage.error.retryable === true, `retryable=${outage.error && outage.error.retryable}`);
    ok('all-outage still costs exactly one call per provider', outage.calls.length === 3, `${outage.calls.length} call(s)`);
    assertNoSecretsInLogs(outage.logs, 'all outage fail');
  }

  say('\n5) Groq auth 401 is NEVER treated as a provider outage');
  {
    const r = await runChat({ respond: () => http(401, JSON.stringify({ error: { message: 'Invalid API Key' } })) });
    ok('a 401 surfaces AI_AUTH_INVALID', r.error && r.error.code === 'AI_AUTH_INVALID', r.error ? r.error.code : '(no error)');
    ok('a 401 does NOT switch providers (exactly 1 call)', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('no fallback switch is logged for a 401', !r.logs.some((l) => /Switching to/.test(l)), (r.logs.find((l) => /Switching to/.test(l)) || '(none)'));
    assertNoSecretsInLogs(r.logs, 'auth 401');
  }

  say('\n6) A network failure / timeout switches to the next provider');
  {
    const net = await runChat({
      respond: (call) => {
        if (call.url.includes('groq.com')) throw new TypeError('fetch failed');
        return okReply('OPENAI AFTER NETWORK');
      },
    });
    ok('a Groq network failure is rescued by OpenAI', net.error === null && net.content === 'OPENAI AFTER NETWORK', net.error ? net.error.message : String(net.content));
    ok('exactly 1 Groq + 1 OpenAI call', net.calls.length === 2, `${net.calls.length} call(s)`);
    ok('logs report Groq unavailable then the switch', net.logs.some((l) => /^\[AI\] Groq unavailable\.$/.test(l)) && net.logs.some((l) => /^\[AI\] Switching to OpenAI\.$/.test(l)), (net.logs.find((l) => /Groq unavailable/.test(l)) || '(none)'));

    const timeout = await runChat({
      respond: (call) => {
        if (call.url.includes('groq.com')) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return okReply('OPENAI AFTER TIMEOUT');
      },
    });
    ok('a Groq timeout is rescued by OpenAI', timeout.error === null && timeout.content === 'OPENAI AFTER TIMEOUT', timeout.error ? timeout.error.message : String(timeout.content));
    ok('a timeout also costs exactly 1 Groq + 1 OpenAI call', timeout.calls.length === 2, `${timeout.calls.length} call(s)`);
    assertNoSecretsInLogs(net.logs.concat(timeout.logs), 'network/timeout');
  }

  say('\n7) Prompt, history, system instructions and format survive every switch');
  {
    const messages = [
      { role: 'system', content: 'You are a warm AI career companion. Reply in the user language. STRICT RULES 1/2/3.' },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `history turn ${i + 1}: explain Java generics`,
      })),
      { role: 'user', content: 'Now give me 10 interview questions in a table.' },
    ];
    const r = await runChat({
      messages,
      maxTokens: 1200,
      respond: (call) => (call.url.includes('generativelanguage') ? okReply('GEMINI FINAL') : http(429, BODY_TPD)),
    });
    ok('the Gemini answer is returned', r.error === null && r.content === 'GEMINI FINAL', r.error ? r.error.message : String(r.content));
    const same = r.calls.length === 3 &&
      JSON.stringify(r.calls[0].messages) === JSON.stringify(r.calls[1].messages) &&
      JSON.stringify(r.calls[1].messages) === JSON.stringify(r.calls[2].messages);
    ok('every provider received the byte-identical messages (system + history + question)', same, 'messages differ');
    ok('the system instructions and final question are intact on the last provider', r.calls[2].messages[0].content.includes('warm AI career companion') && r.calls[2].messages[r.calls[2].messages.length - 1].content.includes('10 interview questions'), 'content intact');
    ok('temperature and max_tokens are preserved on every provider', r.calls.every((c) => c.temperature === 0.3) && r.calls.every((c) => c.maxTokens === 1200), r.calls.map((c) => `${c.temperature}/${c.maxTokens}`).join(', '));
    ok('no provider receives a tool it was not asked to use', r.calls.every((c) => c.tools.length === 0), 'no tools');

    // Same request with tools must keep them on every provider.
    fetchCalls = [];
    responder = (call) => (call.url.includes('openai.com') ? okReply('TOOL ANSWER') : http(429, BODY_TPD));
    const toolOut = await llmService.requestCompletion({
      messages,
      temperature: 0.1,
      maxTokens: 512,
      maxRetries: 0,
      requestId: 'fallback-tools-rid',
      tools: [{ type: 'function', function: { name: 'browser_search', parameters: { type: 'object', properties: {} } } }],
      toolChoice: 'auto',
    });
    ok('a tool-enabled request still succeeds on the fallback', toolOut && toolOut.content === 'TOOL ANSWER', toolOut ? String(toolOut.content) : '(none)');
    ok('the tools array is sent to the fallback unchanged', fetchCalls.length === 2 && fetchCalls[0].tools.length === 1 && fetchCalls[1].tools.length === 1, `${fetchCalls.map((c) => c.tools.length).join(',')}`);
  }

  say('\n8) Configuration edge cases never leak a key');
  {
    // No fallback configured at all -> a single-provider daily quota keeps the
    // honest quota message (no chain was attempted).
    clearProviderEnv();
    process.env.LLM_PROVIDER = 'groq';
    process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.LLM_MODEL = 'openai/gpt-oss-20b';
    process.env.LLM_API_KEY = GROQ_KEY;
    const single = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('with NO fallback a daily 429 keeps AI_DAILY_LIMIT', single.error && single.error.code === 'AI_DAILY_LIMIT', single.error ? single.error.code : '(no error)');
    ok('the single-provider quota wording is preserved', single.error && /Today's AI provider quota has been reached/.test(single.error.message), single.error ? single.error.message.slice(0, 70) : '');
    ok('a single-provider failure costs exactly one call', single.calls.length === 1, `${single.calls.length} call(s)`);

    configureThreeProviders();
    const chain = llmService.getFallbackChain();
    ok('the full chain still resolves after the edge cases', chain.length === 2 && chain[0].provider === 'openai' && chain[1].provider === 'gemini', chain.map((c) => c.provider).join(','));
    ok('no fallback config ever contains the primary Groq key', chain.every((c) => c.apiKey !== GROQ_KEY), 'no primary-key leak');
  }

  say(`\n${passed} passed / ${failed} failed`);
  if (failed) {
    say('\nFAILURES:');
    failures.forEach((f) => say(`  - ${f}`));
    process.exitCode = 1;
  }
};

main().catch((err) => {
  realErr('\nproviderFallbackTest crashed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
