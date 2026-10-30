// Offline classification + retry/duplicate guard for provider errors.
//
// THE BUG THIS GUARDS
//   Every provider 429 used to be reported as "The AI's daily usage limit has
//   been reached / free-tier allowance used up", and a daily-quota 429 was
//   RETRIED (up to ~40s of backoff) before failing anyway. A 429 is not always
//   a daily limit: an RPM/TPM blip recovers in seconds and deserves a
//   retryable message, while a spent per-day allowance must fail fast with a
//   message that says so — and must never be retried, because it cannot come
//   back inside the request.
//
// WHAT IT PROVES (§4, §5, §12, §13, §14)
//   llmService.chat is driven against a STUBBED global.fetch, so every provider
//   answer is deterministic, free and offline:
//     - 429 TPD / RPD / insufficient_quota -> AI_DAILY_LIMIT, retryable:false,
//       EXACTLY ONE fetch (no retry, no sleep)
//     - 429 RPM / TPM / unknown           -> AI_RATE_LIMITED with the
//       "too many requests" wording, at most ONE bounded retry (<= 2 fetches)
//     - 500 / 502 / 503                   -> AI_PROVIDER_ERROR /
//       AI_PROVIDER_UNAVAILABLE, bounded retries only
//     - 401                               -> AI_AUTH_INVALID, exactly ONE fetch
//       (auth errors are never retried)
//     - network failure                   -> AI_UNREACHABLE, bounded retries
//     - 200                               -> one fetch, one answer
//   plus: the optional fallback runs EXACTLY once and only after the primary
//   failed (same provider/base/key, never an unconfigured one); one user
//   message costs ONE generation and a duplicate requestId costs ZERO extra
//   generations (controller level, with the DB save stubbed out); the
//   [AI REQUEST] / [AI RESPONSE] / [AI ERROR] dev logs carry only safe fields
//   (never a key, Bearer token or JWT); and both frontends map AI_DAILY_LIMIT
//   to the §11 wording with NO Retry button while a per-minute 429 stays
//   retryable — plus the UI half of §13: the synchronous in-flight flag, Enter
//   preventDefault, disabled controls and the absence of any auto-send effect
//   (source-pinned, because no browser tooling is available here).
//   The live end-to-end half of §13 is dedupLiveTest.js.
//
// NO network, NO MongoDB, NO real AI key, NO quota spend.
// Run: node scripts/providerErrorTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ---- Deterministic provider config. MUST run before llmService is loaded
// ---- (it reads DEV_LOG / retry caps / provider config at require time).
// The REAL key is remembered only so the log-scan below can prove it never
// appears anywhere; it is never printed by this file.
const REAL_KEY = String(process.env.LLM_API_KEY || '');
const FAKE_KEY = 'gsk_test_offline_suite_not_a_real_key';
delete process.env.AI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;
delete process.env.AI_BASE_URL;
delete process.env.AI_MODEL;
delete process.env.LLM_FALLBACK_API_KEY;
delete process.env.LLM_FALLBACK_BASE_URL;
delete process.env.LLM_FALLBACK_PROVIDER;
delete process.env.LLM_FALLBACK_MODEL; // enabled only inside the fallback section
// Slot 2 is ALSO fully controlled by this file (set at the chain section, removed
// at its cleanup). It must be cleared here too: a real LLM_FALLBACK2_* value in
// backend/.env would otherwise leak into the early chain-count assertions below
// ("1 primary + 1 fallback" would become 3 fetches) and make the suite's result
// depend on the developer's local config instead of the code under test.
delete process.env.LLM_FALLBACK2_API_KEY;
delete process.env.LLM_FALLBACK2_BASE_URL;
delete process.env.LLM_FALLBACK2_PROVIDER;
delete process.env.LLM_FALLBACK2_MODEL;
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
process.env.LLM_MODEL = 'openai/gpt-oss-20b';
process.env.LLM_API_KEY = FAKE_KEY;
process.env.LLM_MAX_RETRIES = '2';
process.env.NODE_ENV = 'test'; // dev logs ON (asserted below), never production
delete process.env.PROVIDER_LOG; // ...and not opted out

// ---- Capture every log line so their FORMAT (and their silence about keys)
// ---- can be asserted. Harness output goes through the saved originals.
const captured = [];
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
console.log = (...a) => { captured.push(a.join(' ')); };
console.error = (...a) => { captured.push(a.join(' ')); };
const say = (...a) => realLog(...a);

const fs = require('fs');
const path = require('path');
const llmService = require('../services/llmService');

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

// ---- Stubbed provider transport ------------------------------------------------
const http = (status, payload, headers = {}) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const h = {};
  Object.keys(headers).forEach((k) => { h[String(k).toLowerCase()] = String(headers[k]); });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h[String(name).toLowerCase()] !== undefined ? h[String(name).toLowerCase()] : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

const okReply = (content = 'STUB ANSWER', finishReason = 'stop') =>
  http(200, {
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

let responder = null;
let fetchCalls = [];
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const call = {
    url: String(url),
    model: String(body.model || ''),
    maxTokens: Number(body.max_tokens || 0),
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    messages: body.messages, // context preservation: what the provider actually received
    // Authorization is recorded for equality assertions ONLY — it is stored on
    // the call record, never printed, so the log key-scan stays meaningful.
    auth: String((init && init.headers && init.headers.Authorization) || ''),
  };
  fetchCalls.push(call);
  if (!responder) throw new Error('providerErrorTest: no responder configured');
  return responder(call, fetchCalls.length);
};

/** One llmService.chat run against `respond`. Returns the error, the answer,
 *  exactly how many provider fetches were made, and the log lines it produced. */
const runChat = async ({ respond, maxRetries = 2, maxTokens = 64, requestId = 'offline-test-rid' }) => {
  fetchCalls = [];
  responder = respond;
  const mark = captured.length;
  let error = null;
  let content = null;
  const t0 = Date.now();
  try {
    content = await llmService.chat({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens,
      maxRetries,
      requestId,
    });
  } catch (err) {
    error = err;
  }
  return { error, content, calls: fetchCalls.slice(), logs: captured.slice(mark), elapsedMs: Date.now() - t0 };
};

// Provider bodies copied from the real free-tier 429s this fix came from.
const BODY_TPD =
  'Rate limit reached for model "openai/gpt-oss-20b" on tokens per day (TPD): Limit 200000, Used 200000, Please try again in 35.424s.';
const BODY_RPD = 'Rate limit reached for requests per day (RPD): Limit 500, Used 500, Please try again in 35.424s.';
const BODY_RPM = 'Rate limit reached for requests per minute (RPM): Limit 100, Used 100, Request id: req_abc123';
const BODY_TPM = 'Rate limit reached for tokens per minute (TPM): Limit 50000, Used 50000, Request id: req_def456';
const BODY_INSUFFICIENT = JSON.stringify({
  error: { message: 'You exceeded your current quota. Please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
});

const main = async () => {
  say('\n1) A DAILY-quota 429 is classified as AI_DAILY_LIMIT and NEVER retried (§5, §14)');
  {
    const r = await runChat({ respond: () => http(429, BODY_TPD, { 'retry-after': '35' }) });
    ok('code is AI_DAILY_LIMIT (not a generic rate limit)', r.error && r.error.code === 'AI_DAILY_LIMIT', r.error ? r.error.code : '(no error)');
    ok('client status stays 502 with a clean message', r.error && r.error.statusCode === 502, r.error ? `status=${r.error.statusCode}` : '');
    ok('the message is the §11 wording', !!r.error && /Today's AI provider quota has been reached/.test(r.error.message), r.error ? r.error.message.slice(0, 70) : '');
    ok('marked retryable:false (no Retry button can work)', r.error && r.error.retryable === false, `retryable=${r.error && r.error.retryable}`);
    ok('rateLimitKind is daily', r.error && r.error.rateLimitKind === 'daily', r.error ? String(r.error.rateLimitKind) : '');
    ok('EXACTLY one provider call — a spent daily quota is never retried', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('[AI ERROR] logs http=429 + code + type for diagnostics (§12)', r.logs.some((l) => /^\[AI ERROR\]/.test(l) && /http=429/.test(l) && /code=AI_DAILY_LIMIT/.test(l) && /type=daily/.test(l)), (r.logs.find((l) => /^\[AI ERROR\]/.test(l)) || '(no [AI ERROR] line)').slice(0, 140));
    ok('[AI PROVIDER REQUEST] trace logs one request line with provider/model (§1)', r.logs.filter((l) => /^\[AI PROVIDER REQUEST\]/.test(l)).length === 1 && /^\[AI PROVIDER REQUEST\] requestId=offline-test-rid provider=groq model=openai\/gpt-oss-20b/.test(r.logs.find((l) => /^\[AI PROVIDER REQUEST\]/.test(l)) || ''), (r.logs.find((l) => /^\[AI PROVIDER REQUEST\]/.test(l)) || '(no request line)').slice(0, 120));
    ok('[AI PROVIDER ERROR] trace logs the REAL http=429 reason=AI_DAILY_LIMIT (§1)', r.logs.some((l) => /^\[AI PROVIDER ERROR\] requestId=offline-test-rid status=429 reason=AI_DAILY_LIMIT/.test(l)), (r.logs.find((l) => /^\[AI PROVIDER ERROR\]/.test(l)) || '(no error line)').slice(0, 120));
  }

  say('\n2) Account-allowance and per-day REQUESTS 429s are daily too (§3)');
  {
    const a = await runChat({ respond: () => http(429, BODY_INSUFFICIENT) });
    ok('insufficient_quota 429 -> AI_DAILY_LIMIT', a.error && a.error.code === 'AI_DAILY_LIMIT', a.error ? a.error.code : '');
    ok('insufficient_quota costs exactly one call', a.calls.length === 1, `${a.calls.length} call(s)`);
    const b = await runChat({ respond: () => http(429, BODY_RPD) });
    ok('"requests per day (RPD)" -> AI_DAILY_LIMIT', b.error && b.error.code === 'AI_DAILY_LIMIT', b.error ? b.error.code : '');
    ok('RPD costs exactly one call', b.calls.length === 1, `${b.calls.length} call(s)`);
  }

  say('\n3) A PER-MINUTE 429 is AI_RATE_LIMITED with at most ONE bounded retry (§3, §5)');
  {
    const rpm = await runChat({ respond: () => http(429, BODY_RPM) });
    ok('RPM 429 -> AI_RATE_LIMITED (never "daily limit")', rpm.error && rpm.error.code === 'AI_RATE_LIMITED', rpm.error ? rpm.error.code : '');
    ok('RPM wording is "receiving too many requests"', !!rpm.error && /too many requests/.test(rpm.error.message), rpm.error ? rpm.error.message.slice(0, 70) : '');
    ok('RPM kind is "requests"', rpm.error && rpm.error.rateLimitKind === 'requests', rpm.error ? String(rpm.error.rateLimitKind) : '');
    ok('RPM stays retryable (it recovers in seconds)', rpm.error && rpm.error.retryable === true, `retryable=${rpm.error && rpm.error.retryable}`);
    ok('RPM retries are bounded to ONE extra call (<= 2 total)', rpm.calls.length === 2 && rpm.calls.length <= 2, `${rpm.calls.length} call(s)`);

    const tpm = await runChat({ respond: () => http(429, BODY_TPM) });
    ok('TPM 429 -> AI_RATE_LIMITED', tpm.error && tpm.error.code === 'AI_RATE_LIMITED', tpm.error ? tpm.error.code : '');
    ok('TPM wording is "too many tokens"', !!tpm.error && /too many tokens/.test(tpm.error.message), tpm.error ? tpm.error.message.slice(0, 70) : '');
    ok('TPM kind is "tokens"', tpm.error && tpm.error.rateLimitKind === 'tokens', tpm.error ? String(tpm.error.rateLimitKind) : '');
    ok('TPM retries are bounded (<= 2 total)', tpm.calls.length <= 2, `${tpm.calls.length} call(s)`);

    const bare = await runChat({ respond: () => http(429, JSON.stringify({ error: { message: 'Rate limit reached' } })) });
    ok('an unclassifiable 429 is never called a daily limit', bare.error && bare.error.code === 'AI_RATE_LIMITED', bare.error ? bare.error.code : '');
    ok('an unclassifiable 429 still never exceeds 2 calls', bare.calls.length <= 2, `${bare.calls.length} call(s)`);
  }

  say('\n3b) A per-minute 429 honors the provider\'s OWN retry hint instead of re-hitting the same exhausted minute (§3, §5)');
  {
    // Groq often states the delay in the BODY, not a header. Ignoring it (the old
    // 3s cap) re-hit the same exhausted minute and surfaced a false outage. The
    // retry must actually WAIT for the stated delay, then succeed.
    let n = 0;
    const recover = await runChat({
      respond: () => {
        n += 1;
        return n === 1
          ? http(429, 'Rate limit reached for model "openai/gpt-oss-20b" on tokens per minute (TPM): Limit 8000, Used 7000, Requested 4000. Please try again in 150ms.')
          : okReply('RECOVERED AFTER RATE LIMIT');
      },
    });
    ok('a body retry hint RECOVERS on the retry (real answer, no false outage)', recover.error === null && recover.content === 'RECOVERED AFTER RATE LIMIT', recover.error ? `${recover.error.code}` : String(recover.content).slice(0, 40));
    ok('the recovery cost exactly ONE retry (2 calls total)', recover.calls.length === 2, `${recover.calls.length} call(s)`);
    ok('the retry WAITED for the stated delay (not an instant re-hit)', recover.elapsedMs >= 450, `${recover.elapsedMs}ms`);

    // A retry-after HEADER is honored too when the body carries no hint.
    let h = 0;
    const headerRecover = await runChat({
      respond: () => {
        h += 1;
        return h === 1 ? http(429, BODY_TPM, { 'retry-after': '0.15' }) : okReply('HEADER RECOVERED');
      },
    });
    ok('a retry-after HEADER is honored even without a body hint', headerRecover.error === null && headerRecover.content === 'HEADER RECOVERED', headerRecover.error ? `${headerRecover.error.code}` : String(headerRecover.content).slice(0, 40));

    // A delay beyond the honor cap fails FAST (one call) — never a pointless sleep.
    const tooLong = await runChat({
      respond: () => http(429, 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 8000, Requested 9000. Please try again in 300s.'),
    });
    ok('a per-minute 429 beyond the wait cap fails fast (exactly ONE call)', tooLong.calls.length === 1, `${tooLong.calls.length} call(s)`);
    ok('...and is still classified AI_RATE_LIMITED (never a daily limit)', tooLong.error && tooLong.error.code === 'AI_RATE_LIMITED', tooLong.error ? tooLong.error.code : '');
  }

  say('\n3c) A 413 "request too large" is a CAPACITY condition, not a dead 4xx (§5, §10)');
  {
    const BODY_413 =
      'Request too large for model `openai/gpt-oss-20b` in organization org_01m2yr184yezas8n3jxkek88gk on tokens per minute (TPM): Limit 8000, Requested 8487, please reduce your message size and try again.';

    // The provider rejects the whole request for exceeding its per-minute token
    // budget. The app must SHRINK the reserved output budget and retry — never
    // surface a generic "unexpected error (HTTP 413)".
    let n = 0;
    const rec = await runChat({
      respond: () => { n += 1; return n === 1 ? http(413, BODY_413) : okReply('SHRUNK AND ANSWERED'); },
      maxRetries: 2,
      maxTokens: 2000,
    });
    ok('413 request-too-large is recovered by shrinking the budget', rec.error === null && rec.content === 'SHRUNK AND ANSWERED', rec.error ? `${rec.error.code}` : String(rec.content).slice(0, 30));
    ok('413 recovery costs TWO calls (one shrink + one retry)', rec.calls.length === 2, `${rec.calls.length} call(s)`);
    ok('413 retry actually asks for a SMALLER max_tokens', rec.calls.length === 2 && rec.calls[1].maxTokens > 0 && rec.calls[1].maxTokens < rec.calls[0].maxTokens, `first=${rec.calls[0] && rec.calls[0].maxTokens} second=${rec.calls[1] && rec.calls[1].maxTokens}`);
    ok('413 is never surfaced as a generic HTTP-413 client error', !(rec.error && /unexpected error.*413/i.test(rec.error.message || '')));

    // If shrinking still cannot fit, a configured fallback IS tried: 413 is a
    // provider CAPACITY condition, not an ineligible request.
    process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b';
    const rescued = await runChat({
      respond: (call) => (call.model === 'openai/gpt-oss-20b' ? http(413, BODY_413) : okReply('FALLBACK RESCUED THE BIG REQUEST')),
      maxRetries: 0,
      maxTokens: 2000,
    });
    delete process.env.LLM_FALLBACK_MODEL;
    ok('a persistent 413 falls back instead of dying as a raw 4xx', rescued.error === null && rescued.content === 'FALLBACK RESCUED THE BIG REQUEST', rescued.error ? `${rescued.error.code}` : String(rescued.content).slice(0, 30));
    ok('the 413 fallback goes to the fallback MODEL', rescued.calls.length === 2 && rescued.calls[1].model === 'openai/gpt-oss-120b', `models=${rescued.calls.map((c) => c.model).join(',')}`);

    // With no fallback, it surfaces the honest retryable code (not AI_PROVIDER_ERROR).
    const stuck = await runChat({ respond: () => http(413, BODY_413), maxRetries: 0, maxTokens: 2000 });
    ok('a persistent 413 with no fallback is AI_RATE_LIMITED (retryable, honest)', stuck.error && stuck.error.code === 'AI_RATE_LIMITED', stuck.error ? stuck.error.code : '(none)');
    ok('...and is NOT misreported as a 400-style AI_PROVIDER_ERROR', !(stuck.error && stuck.error.code === 'AI_PROVIDER_ERROR'));

    // When the WHOLE chain rejects the size, the honest verdict is "request too
    // large" (retryable:false) — NOT the generic "temporarily unavailable", which
    // would invite a retry that can never succeed.
    process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b';
    process.env.LLM_FALLBACK2_PROVIDER = 'deepseek';
    process.env.LLM_FALLBACK2_BASE_URL = 'https://api.deepseek.com/v1';
    process.env.LLM_FALLBACK2_MODEL = 'deepseek-chat';
    process.env.LLM_FALLBACK2_API_KEY = 'sk-test-deepseek-key-not-real';
    const all143 = await runChat({ respond: () => http(413, BODY_413), maxRetries: 0, maxTokens: 2000 });
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK2_PROVIDER;
    delete process.env.LLM_FALLBACK2_BASE_URL;
    delete process.env.LLM_FALLBACK2_MODEL;
    delete process.env.LLM_FALLBACK2_API_KEY;
    ok('an ALL-413 chain surfaces AI_REQUEST_TOO_LARGE (not providers-unavailable)', all143.error && all143.error.code === 'AI_REQUEST_TOO_LARGE', all143.error ? all143.error.code : '(none)');
    ok('...and is retryable:false (retrying an oversized request cannot help)', all143.error && all143.error.retryable === false, `retryable=${all143.error && all143.error.retryable}`);
    ok('...and never says "temporarily unavailable"', !(all143.error && /temporarily unavailable/i.test(all143.error.message || '')));
  }

  say('\n4) 5xx / 401 / network / 200 classification and retry policy (§14, §5)');
  {
    const r500 = await runChat({ respond: () => http(500, JSON.stringify({ error: { message: 'Internal server error' } })), maxRetries: 1 });
    ok('500 -> AI_PROVIDER_ERROR', r500.error && r500.error.code === 'AI_PROVIDER_ERROR', r500.error ? r500.error.code : '');
    ok('500 retries are bounded (2 calls at maxRetries=1)', r500.calls.length === 2, `${r500.calls.length} call(s)`);

    const r502 = await runChat({ respond: () => http(502, 'bad gateway'), maxRetries: 1 });
    ok('502 -> AI_PROVIDER_ERROR', r502.error && r502.error.code === 'AI_PROVIDER_ERROR', r502.error ? r502.error.code : '');
    ok('502 retries are bounded (2 calls at maxRetries=1)', r502.calls.length === 2, `${r502.calls.length} call(s)`);

    const r503 = await runChat({ respond: () => http(503, 'service unavailable'), maxRetries: 1 });
    ok('503 -> AI_PROVIDER_UNAVAILABLE', r503.error && r503.error.code === 'AI_PROVIDER_UNAVAILABLE', r503.error ? r503.error.code : '');
    ok('503 retries are bounded (2 calls at maxRetries=1)', r503.calls.length === 2, `${r503.calls.length} call(s)`);

    const r401 = await runChat({ respond: () => http(401, JSON.stringify({ error: { message: 'Invalid API Key' } })), maxRetries: 2 });
    ok('401 -> AI_AUTH_INVALID', r401.error && r401.error.code === 'AI_AUTH_INVALID', r401.error ? r401.error.code : '');
    ok('401 is NEVER retried (exactly one call)', r401.calls.length === 1, `${r401.calls.length} call(s)`);
    ok('401 is not marked retryable', r401.error && r401.error.retryable !== true, `retryable=${r401.error && r401.error.retryable}`);

    const net = await runChat({ respond: () => { throw new TypeError('fetch failed'); }, maxRetries: 1 });
    ok('a network failure -> AI_UNREACHABLE', net.error && net.error.code === 'AI_UNREACHABLE', net.error ? net.error.code : '');
    ok('a transient network failure is retried, but bounded (2 calls)', net.calls.length === 2, `${net.calls.length} call(s)`);
    ok('AI_UNREACHABLE stays retryable', net.error && net.error.retryable === true, `retryable=${net.error && net.error.retryable}`);

    const good = await runChat({ respond: () => okReply('STUB ANSWER') });
    ok('a 200 succeeds on the first call', good.error === null && good.content === 'STUB ANSWER', good.error ? good.error.message : `${good.calls.length} call(s)`);
    ok('a 200 costs exactly one provider call', good.calls.length === 1, `${good.calls.length} call(s)`);
    ok('[AI RESPONSE] status=200 log carries provider + model only (§12)', good.logs.some((l) => /^\[AI RESPONSE\] status=200 provider=groq model=openai\/gpt-oss-20b/.test(l)), (good.logs.find((l) => /^\[AI RESPONSE\]/.test(l)) || '(no [AI RESPONSE] line)').slice(0, 140));
    ok('[AI PROVIDER RESPONSE] trace logs status=200 with the requestId (§1)', good.logs.some((l) => /^\[AI PROVIDER RESPONSE\] requestId=offline-test-rid status=200/.test(l)), (good.logs.find((l) => /^\[AI PROVIDER RESPONSE\]/.test(l)) || '(no response line)').slice(0, 120));
  }

  say('\n5) The optional fallback runs exactly ONCE, only after the primary failed (§8)');
  {
    process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b';
    const fb = llmService.getFallbackConfig();
    ok('a fallback is configured from LLM_FALLBACK_MODEL alone', !!fb, fb ? `${fb.provider} ${fb.model}` : 'none');
    ok('fallback keeps the SAME provider + base URL (never an unconfigured one)', !!fb && fb.provider === 'groq' && fb.baseUrl === 'https://api.groq.com/openai/v1', fb ? `${fb.provider} ${fb.baseUrl}` : '');
    ok('fallback reuses the configured key — no new/invented key', !!fb && fb.apiKey === FAKE_KEY, fb ? `same key: ${fb.apiKey === FAKE_KEY}` : '');
    ok('fallback targets the configured fallback model', !!fb && fb.model === 'openai/gpt-oss-120b', fb ? fb.model : '');

    const saved = await runChat({ respond: () => okReply('PRIMARY ANSWER') });
    ok('a healthy primary never calls the fallback (1 call)', saved.calls.length === 1, `${saved.calls.length} call(s)`);

    const rescued = await runChat({
      respond: (call) => (call.model === 'openai/gpt-oss-120b' ? okReply('FALLBACK ANSWER') : http(429, BODY_TPD)),
    });
    ok('primary daily 429 is NOT retried; only the ONE fallback runs', rescued.calls.length === 2, `${rescued.calls.length} call(s) (1 primary + 1 fallback)`);
    ok('the second call targets the fallback model', rescued.calls[1] && rescued.calls[1].model === 'openai/gpt-oss-120b', rescued.calls[1] ? rescued.calls[1].model : '');
    ok('a working fallback saves the message', rescued.error === null && rescued.content === 'FALLBACK ANSWER', rescued.error ? rescued.error.message : String(rescued.content));
    ok('fallback received the SAME messages as the primary (context preserved)', JSON.stringify(rescued.calls[0].messages) === JSON.stringify(rescued.calls[1].messages), 'messages differ');
    ok('[AI] logs name the primary provider first (§9)', rescued.logs.some((l) => /^\[AI\] Primary provider: groq/.test(l)), (rescued.logs.find((l) => /^\[AI\] Primary provider:/.test(l)) || '(no line)').slice(0, 90));
    ok('[AI] logs name the fallback when the primary is unavailable (§9)', rescued.logs.some((l) => /^\[AI\] Primary provider unavailable: groq \/ Fallback provider: groq/.test(l)), (rescued.logs.find((l) => /Primary provider unavailable/.test(l)) || '(no line)').slice(0, 110));

    const bothFail = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('when BOTH providers are daily-exhausted the surfaced code is AI_DAILY_LIMIT, never a generic outage (§10)', bothFail.error && bothFail.error.code === 'AI_DAILY_LIMIT', bothFail.error ? bothFail.error.code : '');
    ok('the daily-quota message names the quota (never "temporarily unavailable")', !!bothFail.error && /Today's AI provider quota has been reached/.test(bothFail.error.message), bothFail.error ? bothFail.error.message.slice(0, 80) : '');
    ok('a daily-involved both-fail stays retryable:false (no Retry is offered)', bothFail.error && bothFail.error.retryable === false, `retryable=${bothFail.error && bothFail.error.retryable}`);
    ok('the quota-surfaced both-failed error is tagged usedFallback', bothFail.error && bothFail.error.usedFallback === true, `usedFallback=${bothFail.error && bothFail.error.usedFallback}`);
    ok('total calls stay at 1 primary + 1 fallback (no retry storm)', bothFail.calls.length === 2, `${bothFail.calls.length} call(s)`);
    delete process.env.LLM_FALLBACK_MODEL;
  }

  say('\n5b) A FULLY SEPARATE fallback provider receives the same request (§1-§3)');
  {
    process.env.LLM_FALLBACK_PROVIDER = 'openai';
    process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1-test';
    process.env.LLM_FALLBACK_MODEL = 'gpt-test-mini';
    process.env.LLM_FALLBACK_API_KEY = 'sk-test-fallback-key-not-real';
    const fb = llmService.getFallbackConfig();
    ok(
      'a separate fallback resolves with its OWN provider/base/model/key',
      !!fb && fb.provider === 'openai' && fb.baseUrl === 'https://api.openai.com/v1-test' && fb.model === 'gpt-test-mini' && fb.apiKey === 'sk-test-fallback-key-not-real',
      fb ? `${fb.provider} ${fb.baseUrl} ${fb.model} key=${fb.apiKey === 'sk-test-fallback-key-not-real'}` : 'none'
    );

    const rescued = await runChat({
      respond: (call) => (call.url.includes('openai.com') ? okReply('OPENAI FALLBACK ANSWER') : http(429, BODY_TPD)),
    });
    ok('primary daily 429 -> the SEPARATE fallback provider answers', rescued.error === null && rescued.content === 'OPENAI FALLBACK ANSWER', rescued.error ? rescued.error.message : String(rescued.content));
    ok('exactly ONE primary + ONE fallback fetch', rescued.calls.length === 2, `${rescued.calls.length} call(s)`);
    ok('the fallback fetch hit the fallback base URL', String((rescued.calls[1] || {}).url).includes('/v1-test'), (rescued.calls[1] || {}).url);
    ok('the fallback used its OWN key, never the primary key', rescued.calls.length === 2 && rescued.calls[0].auth === `Bearer ${FAKE_KEY}` && rescued.calls[1].auth === 'Bearer sk-test-fallback-key-not-real', 'auth differs between primary and fallback');
    ok('the fallback received the SAME messages (conversation context intact)', JSON.stringify(rescued.calls[0].messages) === JSON.stringify(rescued.calls[1].messages), 'messages differ');
    ok('[AI] logs name primary + fallback providers (§9)', rescued.logs.some((l) => /^\[AI\] Primary provider unavailable: groq \/ Fallback provider: openai/.test(l)), (rescued.logs.find((l) => /Primary provider unavailable/.test(l)) || '(no line)').slice(0, 110));
    ok('[AI FALLBACK] dev log names the fallback provider + model (§9)', rescued.logs.some((l) => /^\[AI FALLBACK\] provider=openai model=gpt-test-mini/.test(l)), (rescued.logs.find((l) => /^\[AI FALLBACK\]/.test(l)) || '(no [AI FALLBACK] line)').slice(0, 110));

    const bothFail = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('separate-key fallback also daily-exhausted -> AI_DAILY_LIMIT surfaces (§10)', bothFail.error && bothFail.error.code === 'AI_DAILY_LIMIT', bothFail.error ? bothFail.error.code : '');
    ok('the daily-quota message names the quota (never "temporarily unavailable")', !!bothFail.error && /Today's AI provider quota has been reached/.test(bothFail.error.message), bothFail.error ? bothFail.error.message.slice(0, 80) : '');
    ok('a separate-key daily both-fail is NOT retryable', bothFail.error && bothFail.error.retryable === false, `retryable=${bothFail.error && bothFail.error.retryable}`);

    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK_API_KEY;
  }

  say('\n5b2) A declared fallback provider WITHOUT its own key is never used (§2)');
  {
    // LLM_FALLBACK_PROVIDER declared but LLM_FALLBACK_API_KEY empty = an
    // incomplete separate-provider config. The primary (Groq) key must NEVER be
    // sent to a foreign endpoint, so fallback() must resolve to null and the
    // request must stay at exactly one provider call.
    process.env.LLM_FALLBACK_PROVIDER = 'openai';
    process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1';
    process.env.LLM_FALLBACK_MODEL = 'gpt-4o-mini';
    delete process.env.LLM_FALLBACK_API_KEY;
    const fbIncomplete = llmService.getFallbackConfig();
    ok('a declared fallback provider without its own key resolves to NO fallback', fbIncomplete === null, fbIncomplete ? `${fbIncomplete.provider} ${fbIncomplete.baseUrl} key=${fbIncomplete.apiKey ? 'present' : 'EMPTY'}` : 'null');
    const r = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('primary daily 429 WITHOUT a usable fallback costs exactly ONE fetch', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('the honest AI_DAILY_LIMIT message surfaces (no cross-provider key leak)', r.error && r.error.code === 'AI_DAILY_LIMIT', r.error ? r.error.code : '');

    // Same-key fallback (ONLY LLM_FALLBACK_MODEL, no provider declaration) still works.
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_MODEL;
    process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b';
    const fbSameKey = llmService.getFallbackConfig();
    ok('same-key fallback (model only) still resolves when NO provider is declared', !!fbSameKey && fbSameKey.provider === 'groq' && fbSameKey.apiKey === FAKE_KEY, fbSameKey ? `${fbSameKey.provider} ${fbSameKey.model} same-key=${fbSameKey.apiKey === FAKE_KEY}` : 'null');
    delete process.env.LLM_FALLBACK_MODEL;
  }

  say('\n5b3) The fallback CHAIN: slot 1, then slot 2, then an honest error (§1, §20)');
  {
    // PRIMARY (groq) -> FALLBACK 1 (openai) -> FALLBACK 2 (deepseek). Every
    // slot is a REAL configured provider with its own key; the chain is tried
    // in order with exactly ONE attempt per slot, so one user message costs at
    // most 1 primary + 2 fallback fetches — and an error only when ALL fail.
    process.env.LLM_FALLBACK_PROVIDER = 'openai';
    process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1-test';
    process.env.LLM_FALLBACK_MODEL = 'gpt-test-mini';
    process.env.LLM_FALLBACK_API_KEY = 'sk-test-fallback-key-not-real';
    process.env.LLM_FALLBACK2_PROVIDER = 'deepseek';
    process.env.LLM_FALLBACK2_BASE_URL = 'https://api.deepseek.com/v1';
    process.env.LLM_FALLBACK2_MODEL = 'deepseek-chat';
    process.env.LLM_FALLBACK2_API_KEY = 'sk-test-deepseek-key-not-real';

    const chain = llmService.getFallbackChain();
    ok('the chain resolves BOTH configured fallbacks, in slot order', chain.length === 2 && chain[0].provider === 'openai' && chain[1].provider === 'deepseek', chain.map((c) => c.provider).join(', ') || '(empty)');
    ok('chain slot 1 carries its OWN key (never the primary key)', !!chain[0] && chain[0].apiKey === 'sk-test-fallback-key-not-real', chain[0] ? `key=${chain[0].apiKey === 'sk-test-fallback-key-not-real'}` : 'no config');
    ok('chain slot 2 carries its OWN key (never the primary key)', !!chain[1] && chain[1].apiKey === 'sk-test-deepseek-key-not-real', chain[1] ? `key=${chain[1].apiKey === 'sk-test-deepseek-key-not-real'}` : 'no config');

    const rescued = await runChat({
      respond: (call) => (call.url.includes('deepseek.com') ? okReply('CHAIN FALLBACK ANSWER') : http(429, BODY_TPD)),
    });
    ok('primary 429 daily -> slot 1 429 daily -> slot 2 ANSWER (§17 §18 §19)', rescued.error === null && rescued.content === 'CHAIN FALLBACK ANSWER', rescued.error ? rescued.error.message : String(rescued.content));
    ok('one message costs EXACTLY 1 primary + 1 slot1 + 1 slot2 fetch (3 total)', rescued.calls.length === 3, `${rescued.calls.length} call(s)`);
    ok('the slot-2 fetch used slot 2 OWN key, never the primary key', rescued.calls.length === 3 && rescued.calls[2].auth === 'Bearer sk-test-deepseek-key-not-real', 'auth mismatch on slot 2');
    ok('the slot-1 fetch used slot 1 OWN key, never the primary key', rescued.calls.length === 3 && rescued.calls[1].auth === 'Bearer sk-test-fallback-key-not-real', 'auth mismatch on slot 1');
    ok('every chain step received the SAME messages (personality/history/context intact)', JSON.stringify(rescued.calls[0].messages) === JSON.stringify(rescued.calls[1].messages) && JSON.stringify(rescued.calls[1].messages) === JSON.stringify(rescued.calls[2].messages), 'messages differ');
    ok('[AI] logs name primary -> first fallback (§9)', rescued.logs.some((l) => /^\[AI\] Primary provider unavailable: groq \/ Fallback provider: openai/.test(l)), (rescued.logs.find((l) => /Primary provider unavailable/.test(l)) || '(no line)').slice(0, 110));
    ok('[AI FALLBACK] logs BOTH chain slots with provider + model (§9)', rescued.logs.some((l) => /^\[AI FALLBACK\] provider=openai model=gpt-test-mini/.test(l)) && rescued.logs.some((l) => /^\[AI FALLBACK\] provider=deepseek model=deepseek-chat/.test(l)), (rescued.logs.find((l) => /^\[AI FALLBACK\]/.test(l)) || '(no [AI FALLBACK] line)').slice(0, 110));

    // ALL THREE providers daily-exhausted -> the ONE honest quota error.
    const allDaily = await runChat({ respond: () => http(429, BODY_TPD) });
    ok('all three daily-exhausted -> AI_DAILY_LIMIT surfaces (§20)', allDaily.error && allDaily.error.code === 'AI_DAILY_LIMIT', allDaily.error ? allDaily.error.code : '(no error)');
    ok('the quota message names the quota (never "temporarily unavailable")', !!allDaily.error && /Today's AI provider quota has been reached/.test(allDaily.error.message), allDaily.error ? allDaily.error.message.slice(0, 80) : '');
    ok('all-three daily is NOT retryable', allDaily.error && allDaily.error.retryable === false, `retryable=${allDaily.error && allDaily.error.retryable}`);
    ok('all-three daily is tagged as a fallback round (usedFallback)', allDaily.error && allDaily.error.usedFallback === true, `usedFallback=${allDaily.error && allDaily.error.usedFallback}`);

    // ALL THREE providers fail WITHOUT quota (503) -> outage wording, retryable.
    const allDown = await runChat({ respond: () => http(503, 'service unavailable') });
    ok('all three 503 -> AI_PROVIDERS_UNAVAILABLE (§20)', allDown.error && allDown.error.code === 'AI_PROVIDERS_UNAVAILABLE', allDown.error ? allDown.error.code : '(no error)');
    ok('all-503 stays retryable (every failure could recover)', allDown.error && allDown.error.retryable === true, `retryable=${allDown.error && allDown.error.retryable}`);
    ok('all-503 is tagged as a fallback round (usedFallback)', allDown.error && allDown.error.usedFallback === true, `usedFallback=${allDown.error && allDown.error.usedFallback}`);
    ok('every configured provider was tried at least once', allDown.calls.length >= 3, `${allDown.calls.length} call(s)`);

    const allNetworkDown = await runChat({
      respond: () => { throw new TypeError('fetch failed'); },
      maxRetries: 0,
    });
    ok('all providers failing before an HTTP response stays AI_UNREACHABLE', allNetworkDown.error && allNetworkDown.error.code === 'AI_UNREACHABLE', allNetworkDown.error ? allNetworkDown.error.code : '(no error)');
    ok('the network failure explains the outbound connection remedy', !!allNetworkDown.error && /could not connect to the configured AI provider/.test(allNetworkDown.error.message), allNetworkDown.error ? allNetworkDown.error.message : '');
    ok('an all-network failure remains retryable', allNetworkDown.error && allNetworkDown.error.retryable === true, `retryable=${allNetworkDown.error && allNetworkDown.error.retryable}`);

    // Incomplete slot 2 (provider declared, no own key) is EXCLUDED from the chain.
    delete process.env.LLM_FALLBACK2_API_KEY;
    const chainShrunk = llmService.getFallbackChain();
    ok('a slot-2 provider declared WITHOUT its own key is never called', chainShrunk.length === 1 && chainShrunk[0].provider === 'openai', chainShrunk.map((c) => c.provider).join(', ') || '(empty)');
    process.env.LLM_FALLBACK2_API_KEY = 'sk-test-deepseek-key-not-real';

    // A continuation pinned to chain slot 2 goes straight there — one fetch.
    fetchCalls = [];
    responder = () => okReply('PREFERRED ANSWER');
    const outSlot2 = await llmService.chat({
      messages: [{ role: 'user', content: 'continue the answer' }],
      maxTokens: 64,
      requestId: 'pref-test-slot2',
      preferProvider: 'deepseek',
      preferModel: 'deepseek-chat',
    });
    ok('continuation pinned to chain slot 2 answers directly', outSlot2 === 'PREFERRED ANSWER', String(outSlot2).slice(0, 30));
    ok('slot-2 pin costs EXACTLY one fetch (no chain, no primary re-probe)', fetchCalls.length === 1, `${fetchCalls.length} call(s)`);
    ok('that one fetch goes to slot 2 with its OWN key', String((fetchCalls[0] || {}).url).includes('deepseek.com') && fetchCalls[0].auth === 'Bearer sk-test-deepseek-key-not-real', (fetchCalls[0] || {}).url);

    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK_API_KEY;
    delete process.env.LLM_FALLBACK2_PROVIDER;
    delete process.env.LLM_FALLBACK2_BASE_URL;
    delete process.env.LLM_FALLBACK2_MODEL;
    delete process.env.LLM_FALLBACK2_API_KEY;
  }

  say('\n5c) User/auth/config errors NEVER switch providers (§4, §5)');
  {
    process.env.LLM_FALLBACK_MODEL = 'openai/gpt-oss-120b'; // a fallback IS configured
    const singles = [
      { name: '401 auth', respond: () => http(401, JSON.stringify({ error: { message: 'Invalid API Key' } })), code: 'AI_AUTH_INVALID' },
      { name: '403 forbidden', respond: () => http(403, 'forbidden'), code: 'AI_AUTH_FORBIDDEN' },
      { name: '404 bad model', respond: () => http(404, JSON.stringify({ error: { message: 'model not found' } })), code: 'AI_MODEL_UNAVAILABLE' },
      { name: '400 validation', respond: () => http(400, JSON.stringify({ error: { message: 'invalid request' } })), code: 'AI_PROVIDER_ERROR' },
    ];
    for (const c of singles) {
      const r = await runChat({ respond: c.respond, maxRetries: 2 });
      ok(`${c.name} does NOT fall back (exactly 1 call)`, r.calls.length === 1, `${r.calls.length} call(s)`);
      ok(`${c.name} surfaces its own code, untouched`, r.error && r.error.code === c.code, r.error ? r.error.code : '(no error)');
    }
    delete process.env.LLM_FALLBACK_MODEL;
  }

  say('\n5d) A continuation/pinned provider is reused, never re-probed (§8)');
  {
    // After the fallback rescued a truncated first pass, the next turn must go
    // STRAIGHT to that same provider — one fetch, no primary re-probe.
    process.env.LLM_FALLBACK_PROVIDER = 'openai';
    process.env.LLM_FALLBACK_BASE_URL = 'https://api.openai.com/v1-test';
    process.env.LLM_FALLBACK_MODEL = 'gpt-test-mini';
    process.env.LLM_FALLBACK_API_KEY = 'sk-test-fallback-key-not-real';

    fetchCalls = [];
    responder = () => okReply('PREFERRED ANSWER');
    const out = await llmService.chat({
      messages: [{ role: 'user', content: 'continue the answer' }],
      maxTokens: 64,
      requestId: 'pref-test',
      preferProvider: 'openai',
      preferModel: 'gpt-test-mini',
    });
    ok('preferProvider sends the continuation straight to the survivor', out === 'PREFERRED ANSWER', String(out).slice(0, 30));
    ok('a pinned provider costs EXACTLY one fetch (no re-probe, no fallback chain)', fetchCalls.length === 1, `${fetchCalls.length} call(s)`);
    ok('that one fetch goes to the pinned provider', String((fetchCalls[0] || {}).url).includes('/v1-test'), (fetchCalls[0] || {}).url);

    // A pinned provider that FAILS must fail cleanly — never chain back to the
    // damaged primary and never start another fallback round.
    const start = fetchCalls.length;
    responder = () => http(503, 'service unavailable');
    const pinnedErr = await llmService.chat({
      messages: [{ role: 'user', content: 'continue' }],
      maxTokens: 64,
      maxRetries: 1,
      requestId: 'pref-test-2',
      preferProvider: 'openai',
      preferModel: 'gpt-test-mini',
    }).catch((e) => e);
    const pinnedCalls = fetchCalls.slice(start);
    ok('a failing pinned provider surfaces ITS OWN clean error', pinnedErr && pinnedErr.code === 'AI_PROVIDER_UNAVAILABLE', pinnedErr ? pinnedErr.code : '(no error)');
    ok('every retry stayed on the pinned provider (never the dead primary)', pinnedCalls.length > 0 && pinnedCalls.every((c) => String(c.url).includes('/v1-test')), `${pinnedCalls.length} call(s), urls=${pinnedCalls.map((c) => c.url).join(',')}`);
    ok('it is never tagged as a fallback switch (no second chain)', !pinnedErr.usedFallback, `usedFallback=${pinnedErr && pinnedErr.usedFallback}`);

    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK_API_KEY;
  }

  say('\n6) One user message = ONE generation; a continuation only when truncated (§13)');
  {
    const ragService = require('../services/ragService');
    const realChat = llmService.chat;
    const realSearch = llmService.chatWithBrowserSearch;

    const runAsk = async ({ question, replies }) => {
      const queue = [...replies];
      let calls = 0;
      llmService.chat = async () => {
        calls += 1;
        const item = queue.shift();
        if (item && typeof item === 'object' && 'content' in item) return { content: String(item.content), truncated: Boolean(item.truncated) };
        return { content: item !== undefined ? String(item) : 'STUB ANSWER', truncated: false };
      };
      llmService.chatWithBrowserSearch = async (...args) => {
        const r = await llmService.chat(...args);
        return { ...r, toolUsed: false, urls: [] };
      };
      try {
        const r = await ragService.askCareerAssistant({ userId: 'offline-test-user', question, history: [] });
        return { answer: r.answer, error: null, calls };
      } catch (err) {
        return { answer: '', error: err, calls };
      } finally {
        llmService.chat = realChat;
        llmService.chatWithBrowserSearch = realSearch;
      }
    };

    const complete = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const a = await runAsk({ question: 'give me 10 Java interview questions', replies: [complete] });
    ok('a complete answer costs exactly ONE generation', a.error === null && a.calls === 1, `${a.calls} call(s)${a.error ? ` err=${a.error.message}` : ''}`);

    const b = await runAsk({ question: 'give me 10 Java interview questions', replies: [complete.slice(0, complete.length - 12), '10. Item 10'] });
    ok('a truncated answer gets ONE continuation (2 calls total)', b.error === null && b.calls === 2, `${b.calls} call(s)${b.error ? ` err=${b.error.message}` : ''}`);
  }

  say('\n7) Controller level: [AI REQUEST] log + duplicate requestId costs ZERO extra calls (§12, §13)');
  {
    const Chat = require('../models/Chat');
    Chat.prototype.save = async function save() { return this; }; // no MongoDB in this suite
    const aiController = require('../controllers/aiController');

    let generations = 0;
    const realChat = llmService.chat;
    const realSearch = llmService.chatWithBrowserSearch;
    llmService.chat = async () => { generations += 1; return 'STUB ANSWER'; };
    llmService.chatWithBrowserSearch = async () => { generations += 1; return { content: 'STUB ANSWER', toolUsed: false, urls: [], truncated: false }; };

    const makeRes = () => {
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (p) => { res.body = p; return res; };
      res.set = () => res;
      return res;
    };
    const send = async (requestId, message = 'hi') => {
      const res = makeRes();
      await aiController.careerAssistant({ body: { message, requestId }, user: { id: 'offline-test-user' } }, res);
      return res;
    };

    try {
      const mark = captured.length;
      const first = await send('rid-offline-1');
      ok('one user message -> ONE generation', generations === 1, `${generations} generation(s)`);
      ok('the request succeeds', !!(first.body && first.body.success), first.body ? JSON.stringify(first.body).slice(0, 80) : `status=${first.statusCode}`);
      ok('first send is not marked deduped', first.body && first.body.deduped === false, `deduped=${first.body && first.body.deduped}`);
      const reqLog = captured.slice(mark).find((l) => /^\[AI REQUEST\]/.test(l)) || '';
      ok('[AI REQUEST] logs provider/model/kind/user/requestId (§12)', /^\[AI REQUEST\] provider=groq model=\S+ kind=text user=offline-test-user requestId=rid-offline-1$/.test(reqLog), reqLog || '(no [AI REQUEST] line)');
      const chatLog = captured.slice(mark).find((l) => /^\[CHAT REQUEST\]/.test(l)) || '';
      ok('[CHAT REQUEST] trace logs requestId/provider and message length without chat content (§1)', /^\[CHAT REQUEST\] requestId=rid-offline-1 provider=groq messageChars=2$/.test(chatLog), chatLog || '(no [CHAT REQUEST] line)');

      const dup = await send('rid-offline-1');
      ok('a duplicate requestId replays the SAME response', !!(dup.body && dup.body.success) && dup.body.deduped === true, `deduped=${dup.body && dup.body.deduped}`);
      ok('the duplicate costs ZERO extra generations', generations === 1, `${generations} generation(s)`);

      const fresh = await send('rid-offline-2', 'what is Java?');
      ok('a NEW requestId runs a new generation', generations === 2 && fresh.body && fresh.body.deduped === false, `${generations} generation(s), deduped=${fresh.body && fresh.body.deduped}`);
      ok('exactly one [AI REQUEST] line per real message', captured.filter((l) => /^\[AI REQUEST\]/.test(l)).length === 2, `${captured.filter((l) => /^\[AI REQUEST\]/.test(l)).length} line(s)`);
      ok('exactly one [CHAT REQUEST] line per REAL message, NONE for the deduped replay (§5)', captured.filter((l) => /^\[CHAT REQUEST\]/.test(l)).length === 2, `${captured.filter((l) => /^\[CHAT REQUEST\]/.test(l)).length} line(s)`);
    } finally {
      llmService.chat = realChat;
      llmService.chatWithBrowserSearch = realSearch;
    }
  }

  say('\n8) No key, Bearer token or JWT ever reaches a log line (§2)');
  {
    const leaks = captured.filter(
      (l) =>
        /gsk_[A-Za-z0-9_-]{15,}/.test(l) ||
        /Bearer\s+[A-Za-z0-9._-]{15,}/i.test(l) ||
        (REAL_KEY && l.includes(REAL_KEY)) ||
        l.includes(FAKE_KEY)
    );
    ok('no key material in any captured log line', leaks.length === 0, leaks.length ? leaks[0].slice(0, 120) : `${captured.length} line(s) scanned`);
    ok('dev logs actually ran (they are not silently dead)', captured.some((l) => /^\[AI /.test(l)), `${captured.filter((l) => /^\[AI /.test(l)).length} [AI …] line(s)`);
  }

  say('\n9) Both frontends: daily -> §11 wording with NO Retry; per-minute 429 -> retryable (§3, §11)');
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
    const react = read(path.join('src', 'pages', 'CareerAssistant.jsx'));
    const legacy = read('index.html');

    ok('React: AI_DAILY_LIMIT uses the §10 quota wording', /Today's AI provider quota has been reached\./.test(react) && /Configure another AI provider or try again after the quota resets\./.test(react));
    ok('React: AI_DAILY_LIMIT is retryable:false', /AI_DAILY_LIMIT'\)[\s\S]{0,400}?retryable: false/.test(react));
    ok('React: both-failed uses the §10 "temporarily unavailable" wording', /AI_PROVIDERS_UNAVAILABLE'\)[\s\S]{0,250}?AI services are temporarily unavailable\. Please try again shortly\./.test(react));
    ok('React: both-failed respects the backend retryable flag', /AI_PROVIDERS_UNAVAILABLE'\)[\s\S]{0,400}?err\?\.response\?\.data\?\.retryable !== false/.test(react));
    ok('React: per-minute 429 stays retryable:true', /AI_RATE_LIMITED'\)[\s\S]{0,400}?retryable: true/.test(react));
    ok('React: the Retry button is gated on retryable !== false', /m\.retryable !== false/.test(react));
    ok('React: "unavailable" says the provider is temporarily unavailable', /The AI provider is temporarily unavailable\./.test(react));
    ok('React: AI_UNREACHABLE identifies backend-to-provider connectivity', /code === 'AI_UNREACHABLE'[\s\S]{0,300}?outbound HTTPS access/.test(react));
    ok('React: AI_REQUEST_TOO_LARGE tells the user to shorten and is retryable:false', /AI_REQUEST_TOO_LARGE'\)[\s\S]{0,400}?shorten your message[\s\S]{0,200}?retryable: false/.test(react));

    ok('Legacy: AI_DAILY_LIMIT uses the §10 quota wording', /Today's AI provider quota has been reached\./.test(legacy) && /Configure another AI provider or try again after the quota resets\./.test(legacy));
    ok('Legacy: AI_DAILY_LIMIT is checked BEFORE the generic 429 branch',
      legacy.indexOf('api === "AI_DAILY_LIMIT"') > -1 &&
      legacy.indexOf('api === "AI_DAILY_LIMIT"') < legacy.indexOf('api === "AI_RATE_LIMITED"'));
    ok('Legacy: AI_DAILY_LIMIT is retryable:false', /api === "AI_DAILY_LIMIT"[\s\S]{0,500}?retryable: false/.test(legacy));
    ok('Legacy: both-failed uses the §10 "temporarily unavailable" wording', /api === "AI_PROVIDERS_UNAVAILABLE"[\s\S]{0,250}?Please try again shortly\./.test(legacy));
    ok('Legacy: both-failed respects the backend retryable flag', /api === "AI_PROVIDERS_UNAVAILABLE"[\s\S]{0,400}?err\.retryable !== false/.test(legacy));
    ok('Legacy: per-minute 429 stays retryable:true', /status === 429 \|\| api === "AI_RATE_LIMITED"[\s\S]{0,500}?retryable: true/.test(legacy));
    ok('Legacy: the Retry button is gated on m.retryable', /retryBtn = \(m\.retryable\)/.test(legacy));
    ok('Legacy: "unavailable" says the provider is temporarily unavailable', /The AI provider is temporarily unavailable\./.test(legacy));
    ok('Legacy: AI_UNREACHABLE identifies backend-to-provider connectivity', /api === "AI_UNREACHABLE"[\s\S]{0,300}?outbound HTTPS access/.test(legacy));
    ok('Legacy: AI_REQUEST_TOO_LARGE tells the user to shorten (retryable:false)', /api === "AI_REQUEST_TOO_LARGE"[\s\S]{0,450}?shorten your message[\s\S]{0,250}?retryable: false/.test(legacy));
  }

  say('\n10) Both frontends: ONE user message = ONE backend request at the UI layer (§13)');
  // No browser tooling is available in CI, so the double-send guards are pinned
  // from source: a synchronous in-flight flag (never released until the response
  // settles), Enter preventDefault, disabled controls while sending, and NO
  // auto-send effect. The backend half of §13 is proven in section 7 (duplicate
  // requestId -> ZERO extra generations) and live by dedupLiveTest.js.
  {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
    const react = read(path.join('src', 'pages', 'CareerAssistant.jsx'));
    const legacy = read('index.html');
    const legacyRequestStart = legacy.indexOf('function runAssistantRequest(');
    const legacyTypingStart = legacy.indexOf('showTyping(', legacyRequestStart);
    const legacyTypingEnd = legacy.indexOf(';', legacyTypingStart) + 1;
    const legacyUploadStart = legacy.indexOf('ensureServerUploads(files)', legacyRequestStart);
    const legacyTypingCall = legacy.slice(legacyTypingStart, legacyTypingEnd);

    ok('React: the send path bails on the synchronous in-flight flag',
      /if \(!question \|\| sendingRef\.current\) return;/.test(react));
    ok('React: the flag is raised BEFORE any await (StrictMode/double-click safe)',
      /sendingRef\.current = true;\s*\n\s*setSending\(true\);/.test(react) &&
      react.indexOf('sendingRef.current = true;') < Math.min(
        ...['streamChatMessage(question', 'sendChatMessage(question']
          .map((needle) => {
            const index = react.indexOf(needle);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
          })
      ));
    ok('React: the flag is released when the response settles',
      /sendingRef\.current = false;\s*\n\s*setSending\(false\);/.test(react));
    ok('React: Enter preventDefaults instead of submitting twice',
      /e\.key === 'Enter' && !e\.shiftKey[\s\S]{0,60}e\.preventDefault\(\);[\s\S]{0,40}send\(\);/.test(react));
    ok('React: textarea is disabled while a send is in flight',
      /disabled=\{sending \|\| regenerating \|\| uploading\}/.test(react));
    ok('React: send button is disabled while a send is in flight',
      /disabled=\{sending \|\| regenerating \|\| uploading \|\| !input\.trim\(\)\}/.test(react));
    ok('React: form submit is preventDefault-ed', /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); send\(\); \}\}/.test(react));
    ok('React: no useEffect auto-sends a message', !/useEffect\([\s\S]{0,300}?\bsend\(\);/.test(react));

    ok('Legacy: Enter preventDefaults then sends exactly once',
      /if \(ev\.key === "Enter" && !ev\.shiftKey[\s\S]{0,60}\{ ev\.preventDefault\(\); sendMessage\(\); \}/.test(legacy));
    ok('Legacy: sendMessage returns early while a request is in flight',
      /function sendMessage\(\) \{[\s\S]{0,300}?if \(busy\(\)\) return;/.test(legacy));
    ok('Legacy: busy() is the in-flight typing row',
      /function busy\(\) \{ return !!document\.querySelector\("\.typing-row"\); \}/.test(legacy));
    ok('Legacy: the typing row is shown synchronously (busy() flips same tick)',
      legacyRequestStart >= 0 &&
      /Asking the AI assistant/.test(legacyTypingCall) &&
      /typingId/.test(legacyTypingCall) &&
      legacyUploadStart > legacyTypingEnd);
    ok('Legacy: ONE request core per message with a fresh requestId per attempt',
      /ONE user message = ONE AI call/.test(legacy) && /a fresh requestId per/.test(legacy));
  }

  say('\n' + '='.repeat(56));
  if (failed) {
    say(`RESULTS: ${passed} passed, ${failed} failed`);
    failures.forEach((f) => say(`  - ${f}`));
    process.exit(1);
  }
  say(`ALL ${passed} ASSERTIONS PASSED`);
  process.exit(0);
};

main().catch((err) => {
  realErr('\nproviderErrorTest.js itself crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
