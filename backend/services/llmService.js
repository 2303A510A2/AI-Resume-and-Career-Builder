// AI/LLM provider abstraction. Uses any OpenAI-compatible /chat/completions endpoint:
// OpenAI, Groq, DeepSeek, Together, OpenRouter, or a local Ollama server.
// No provider is ever called unless it is actually configured — the app reports a
// clear error state instead of pretending AI is working. There is NO local
// simulation/demo/template fallback anywhere in this module.
//
// Provider model (backend/services/providers.js):
//   PRIMARY provider   — LLM_API_KEY || AI_API_KEY || GROQ_API_KEY || OPENAI_API_KEY
//                        + LLM_BASE_URL || AI_BASE_URL + LLM_MODEL || AI_MODEL
//   FALLBACK provider  — LLM_FALLBACK_* (optional). Used as a LAST RESORT: when the
//                        primary's own retries are exhausted, one fallback attempt
//                        runs before the clean client-facing error is returned.
//   VISION             — LLM_VISION=1 enables image analysis on vision-capable models.
// The API key is NEVER logged and NEVER returned to any client.
//
// Reliability rules (addressed to Groq free-tier 429s):
//   - per-attempt timeout SCALES with the requested output budget
//     (see `perAttemptTimeoutMs`). A FIXED 20s abort is what used to cut long
//     answers off mid-sentence: "1000 words" or "100 questions" simply cannot be
//     produced inside 20 seconds, so the fetch was aborted and the user saw a
//     bare "AI unreachable" instead of an answer. CHAT_TIMEOUT_MS is only the
//     FLOOR now; LONG_TIMEOUT_MS is the ceiling.
//   - `finish_reason` is returned to callers so a `length` cut is detectable
//     (ragService uses it to continue the answer instead of silently shipping
//     a truncated one).
//   - `max_tokens` is clamped to MAX_OUTPUT_TOKENS, and a provider 400 that says
//     the budget is too large is retried with a halved budget instead of
//     failing the whole message.
//   - up to 2 automatic retries (LLM_MAX_RETRIES) for transient failures only:
//     network errors, fetch timeout, HTTP 408 / 429 / 500 / 502 / 503 / 504.
//   - HTTP 401 / 403 / 404 are NEVER retried (retrying auth/config errors only
//     hammers the provider).
//   - On 429 the `Retry-After` header and x-ratelimit-* headers are read and used
//     for the backoff delay + diagnostics. The client-facing message stays clean.
//   - No unbounded retry loops: hard cap = LLM_MAX_RETRIES retries per request.
//   - Safe diagnostics only: requestId, model, HTTP status, duration, attempts.
//     NEVER the API key, Authorization header, JWT, passwords, or Mongo creds.

const providers = require('./providers');
const tls = require('node:tls');

const configuredTlsMaxVersion = String(process.env.LLM_TLS_MAX_VERSION || '').trim();
if (configuredTlsMaxVersion) {
  if (!['TLSv1.2', 'TLSv1.3'].includes(configuredTlsMaxVersion)) {
    throw new Error('LLM_TLS_MAX_VERSION must be TLSv1.2 or TLSv1.3');
  }
  tls.DEFAULT_MAX_VERSION = configuredTlsMaxVersion;
}

const CHAT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20000); // floor for a SMALL request
// Long generations need proportionally more wall-clock. 45 output tokens/sec is a
// deliberately pessimistic free-tier generation rate, so this budget always has
// enough headroom for the tokens we asked for.
const LONG_TIMEOUT_MS = Number(process.env.LLM_LONG_TIMEOUT_MS || 180000);
const TOKENS_PER_SEC_BUDGET = Number(process.env.LLM_TOKENS_PER_SEC_BUDGET || 45);
const DEFAULT_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 2); // transient failures only
const RETRY_DELAYS_MS = [800, 1600, 2400]; // base backoff, one entry per retry
const MAX_BACKOFF_MS = 20000; // hard cap for retry-after honoring
// Floor for the total wall-clock budget of ONE provider request (all attempts
// combined). The REAL ceiling is derived from the per-attempt timeout so a long
// generation is never killed by a constant that was sized for a "hi".
const REQUEST_DEADLINE_MS = Number(process.env.LLM_REQUEST_DEADLINE_MS || 25000);
// Per-minute 429s recover in SECONDS and the provider states exactly how many
// ("Please try again in 18.33s"). Honor that delay (bounded) instead of the old
// 3s cap, which retried inside the same exhausted minute and surfaced a false
// "temporarily unavailable" while the provider was merely between windows.
const RATE_LIMIT_MAX_WAIT_MS = Number(process.env.LLM_RATE_LIMIT_MAX_WAIT_MS || 40000);
const EMPTY_RESPONSE_BUDGET_CAP = 32768; // max_tokens ceiling when retrying an empty 200
// Absolute ceiling for any single completion, whatever the request asked for.
// The configured model is usually allowed far more; this only guards against a
// provider 400 when we over-ask.
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 32768);
const MIN_OUTPUT_TOKENS = 64;
const DEFAULT_GROQ_INPUT_TOKEN_LIMIT = 8000;
const DEFAULT_GROQ_OUTPUT_TOKEN_LIMIT = 1000;
const DEFAULT_GENERIC_INPUT_TOKEN_LIMIT = 32768;

const estimateContentTokens = (content) => {
  if (Array.isArray(content)) {
    return Math.ceil(content.reduce((sum, part) => sum + estimateContentTokens(
      part && (part.text || part.image_url && part.image_url.url || '')
    ), 0));
  }
  return Math.ceil(String(content || '').length / 4);
};

const estimateMessageTokens = (message) =>
  4 + estimateContentTokens(message && message.content);

const providerTokenLimits = (cfg) => {
  const isGroq = String(cfg && cfg.provider || '').toLowerCase() === 'groq'
    || /api\.groq\.com/i.test(String(cfg && cfg.baseUrl || ''));
  const inputLimit = Number(
    process.env.LLM_INPUT_TOKEN_LIMIT
      || process.env.LLM_INPUT_TPM_LIMIT
      || (isGroq ? DEFAULT_GROQ_INPUT_TOKEN_LIMIT : DEFAULT_GENERIC_INPUT_TOKEN_LIMIT)
  );
  const outputLimit = Number(
    process.env.LLM_OUTPUT_TOKEN_LIMIT
      || process.env.LLM_OUTPUT_TPM_LIMIT
      || (isGroq ? DEFAULT_GROQ_OUTPUT_TOKEN_LIMIT : MAX_OUTPUT_TOKENS)
  );
  return {
    input: Math.max(256, Math.floor(inputLimit)),
    output: Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, Math.floor(outputLimit))),
  };
};

const truncateMessageContent = (content, maxChars, keepTail = false) => {
  if (Array.isArray(content)) return content;
  const text = String(content || '');
  if (text.length <= maxChars) return content;
  const marker = '\n[Earlier context trimmed to fit the provider input limit.]\n';
  const available = Math.max(0, maxChars - marker.length);
  return keepTail
    ? marker + text.slice(-available)
    : text.slice(0, available) + marker;
};

/**
 * Keeps the system prompt and current user request, then retains the newest
 * context that fits the provider's input-token limit. This is deliberately
 * performed immediately before every fetch so retries cannot resend an
 * oversized prompt.
 */
const fitMessagesToInputLimit = (messages, inputLimit) => {
  const source = Array.isArray(messages) ? messages : [];
  if (!source.length) return [];
  const system = source[0];
  const latest = source[source.length - 1];
  const middle = source.slice(1, -1);
  const result = [];
  const latestReserve = Math.min(
    estimateMessageTokens(latest),
    Math.max(32, Math.floor(inputLimit * 0.4))
  );
  let remaining = Math.max(1, inputLimit - latestReserve);

  const add = (message, keepTail = false) => {
    const cost = estimateMessageTokens(message);
    if (cost <= remaining) {
      result.push(message);
      remaining -= cost;
      return true;
    }
    if (typeof message.content !== 'string' || remaining <= 32) return false;
    const maxChars = Math.max(64, (remaining - 4) * 4);
    const trimmed = { ...message, content: truncateMessageContent(message.content, maxChars, keepTail) };
    if (estimateMessageTokens(trimmed) <= remaining) {
      result.push(trimmed);
      remaining -= estimateMessageTokens(trimmed);
      return true;
    }
    return false;
  };

  add(system);
  for (let i = middle.length - 1; i >= 0; i -= 1) {
    if (!add(middle[i], middle[i].role === 'assistant')) break;
  }
  remaining += latestReserve;
  add(latest, false);
  const first = result[0];
  const last = result[result.length - 1];
  const selectedMiddle = result.slice(1, -1).reverse();
  return first === last ? result : [first, ...selectedMiddle, last];
};

// Provider reachability probe (GET /models). Groq's /models list is routinely
// slower than 5s under Node/undici (observed ~9.5s) while chat completions stay
// fast — a 5s window made /api/health permanently misreport "unreachable".
const PROBE_TIMEOUT_MS = Number(process.env.LLM_PROBE_TIMEOUT_MS || 20000);
const PROBE_CACHE_MS = Number(process.env.LLM_PROBE_CACHE_MS || 60000);

const probeErrorCategory = (status) => {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'endpoint_or_model';
  if (status === 408 || status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_server_error';
  return 'provider_http_error';
};

// 429 bodies that mean the DAILY (per-day) quota is exhausted, e.g. Groq's
// "Rate limit reached for model ... on tokens per day (TPD): Limit 200000,
// Used 200000 ... Please try again in 35.424s." Retrying these with long
// backoff is what created the ~40s dead-ends — they fail fast instead.
//
// A 429 is NOT always a daily limit, and calling every 429 "daily" trains users
// to ignore a real (and quickly recoverable) rate limit. This matcher is
// deliberately DAY-only: per-minute bodies ("requests per minute (RPM)",
// "tokens per minute (TPM)") must NOT match, and account/billing allowance
// messages (OpenAI-style "insufficient_quota", "exceeded your current quota")
// DO count as a spent allowance rather than a per-minute blip.
const DAILY_QUOTA_RE =
  /tokens per day|tokens\/day|per day\b|daily (usage|limit|quota)|daily limit|\btpd\b|\brpd\b|per-day|requests per day|insufficient[_ ]quota|quota exceeded|exceeded your current quota|free[- ]tier (allowance|limit|quota)/i;

// Per-minute 429 bodies: these recover in SECONDS, so they get the short
// "too many requests" message and (at most) one bounded retry.
const RPM_QUOTA_RE = /requests per minute|\brpm\b/i;
const TPM_QUOTA_RE = /tokens per minute|\btpm\b/i;

// Scrubs anything that could look like a secret from a provider error body
// before it ever reaches logs/diagnostics (belt & braces — never log keys).
const scrubSecret = (text) =>
  String(text || '')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, '[bearer-redacted]');

// Provider's own error wording, trimmed + scrubbed, for server-side diagnostics.
const cleanProviderReason = (bodyText) => {
  const t = scrubSecret(bodyText).replace(/\s+/g, ' ').trim();
  return t ? `provider said: ${t.slice(0, 300)}` : '';
};

// Statuses that are transient provider/network failures and are safe to retry.
// Auth (401/403) and config (404) errors are NEVER retried — retrying them only
// hammers the provider without ever succeeding.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Provider failure codes after which a configured FALLBACK provider may be tried.
// This is the multi-provider switch contract: only availability / quota /
// rate-limit situations deserve the extra attempt. Client/user errors
// (400 validation, 401 auth, 403 authorization, 404 bad model/route) NEVER
// switch providers — the fallback would hit the same ineligible request.
const FALLBACKABLE_CODES = new Set([
  'AI_DAILY_LIMIT',          // daily allowance spent — the classic reason to switch
  'AI_RATE_LIMITED',         // per-minute pressure after the primary gave up
  'AI_PROVIDER_ERROR',       // provider 5xx
  'AI_PROVIDER_UNAVAILABLE', // provider 503
  'AI_UNREACHABLE',          // network / timeout
  'AI_EMPTY_RESPONSE',       // provider returned 200 with nothing usable
]);
const allowsFallback = (err) => {
  if (!err || !FALLBACKABLE_CODES.has(err.code)) return false;
  // A RAW 4xx from the provider (other than 429 rate limiting) is a user/auth/
  // config problem, NEVER a provider-availability situation — even if the mapped
  // code happens to be a fallbackable one. The fallback would hit the same
  // ineligible request. The ONE other exception is 413 "request too large": that
  // is a per-minute token CAPACITY condition (shrink and/or switch providers),
  // not a malformed request, so a different provider/key can rescue it.
  const http = Number(err.providerHttpStatus || 0);
  if (http >= 400 && http < 500 && http !== 429 && http !== 413) return false;
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Human-readable provider names for the safe fallback trace logs. NEVER a key,
// endpoint or model credential — just the product name of the provider.
const PROVIDER_LABELS = {
  groq: 'Groq',
  openai: 'OpenAI',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  together: 'Together',
  ollama: 'Ollama',
};
const providerLabel = (id) => {
  const key = String(id || '').trim().toLowerCase();
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  if (!key) return 'AI provider';
  return key.charAt(0).toUpperCase() + key.slice(1);
};

// The ONE message the user sees when every configured provider in the chain
// failed. Deliberately generic: it never leaks a provider name, URL, key or raw
// provider body, and it covers both an outage and a spent usage limit.
const ALL_PROVIDERS_FAILED_MESSAGE =
  'All configured AI providers are currently unavailable or have reached their usage limits. Please try again later.';

// Safe development diagnostics (§12): [AI REQUEST] / [AI RESPONSE] / [AI ERROR].
// OFF in production, and never prints the key, Authorization header, JWT,
// prompt/body or MongoDB credentials — only provider, model, requestId, status,
// attempts and latency. Set PROVIDER_LOG=0 to silence them in development.
const DEV_LOG =
  process.env.NODE_ENV !== 'production' &&
  !/^(0|false|no|off)$/i.test(String(process.env.PROVIDER_LOG || ''));

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

/**
 * Wall-clock allowance for ONE provider attempt, derived from the output budget
 * that was requested.
 *
 * This is the single most important reliability fix in the file. The old code
 * aborted every request after a fixed CHAT_TIMEOUT_MS (20s) regardless of how
 * much output was asked for, so any large request ("explain in 1000 words",
 * "give 100 interview questions", "multiplication tables 1..100") was killed
 * mid-generation and surfaced as a bare "AI unreachable" — the answer was lost,
 * not shortened. Now the timeout scales with the budget at a deliberately
 * pessimistic generation rate (TOKENS_PER_SEC_BUDGET), always between
 * CHAT_TIMEOUT_MS (floor, so a 4-token answer still gets 20s) and
 * LONG_TIMEOUT_MS (ceiling, so the request can never hang forever).
 */
const perAttemptTimeoutMs = (maxTokens) => {
  const tokens = clampInt(maxTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  return clampInt(
    CHAT_TIMEOUT_MS + Math.ceil(tokens / TOKENS_PER_SEC_BUDGET) * 1000,
    CHAT_TIMEOUT_MS,
    LONG_TIMEOUT_MS
  );
};

/**
 * True when the provider rejected the request as TOO LARGE — either max_tokens
 * above the model's own ceiling (400) or the whole request above the model's
 * per-minute token budget (Groq 413: "Request too large … tokens per minute
 * (TPM): Limit 8000, Requested 8487, please reduce your message size and try
 * again."). Both are recoverable by shrinking the reserved output budget; the
 * 413 variant is additionally a CAPACITY condition (see allowsFallback).
 */
const isTokenBudgetTooLarge = (status, bodyText) =>
  (status === 400 || status === 413) &&
  /max_tokens|max_completion_tokens|context length|maximum context|reduce the length|reduce your message size|request too large|too many tokens|token limit/i.test(
    String(bodyText || '')
  );

const GROQ_DEFAULT_MODEL = providers.defaults.GROQ_DEFAULT_MODEL;
const OPENAI_DEFAULT_MODEL = providers.defaults.OPENAI_DEFAULT_MODEL;
const GROQ_BASE_URL = providers.defaults.GROQ_BASE_URL;
const OPENAI_BASE_URL = providers.defaults.OPENAI_BASE_URL;

// Groq's built-in web search tool (server-side search; the model calls it only
// when it decides current/verifiable information is needed). The declared schema
// matches Groq's browser_search capability (query + optional topn/source).
const BROWSER_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'browser_search',
    description:
      'Search the web for current or verifiable information (latest news, places to visit, current versions, resources, websites) and return real source URLs. Use when the user asks for content you cannot verify from memory alone.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concise search query, e.g. "best DSA practice websites"' },
        topn: { type: 'integer', description: 'Number of results to return (1-8, default 5)' },
        source: { type: 'string', description: 'Optional source preference, e.g. news, docs, education, travel' },
      },
      required: ['query'],
    },
  },
};

/** Primary provider config (canonical shape from providers.js). */
const getConfig = () => providers.primary();

/** Optional fallback provider config, or null. Used after the primary exhausts its retries. */
const getFallbackConfig = () => providers.fallback();

/** Every configured, key-bearing fallback in slot order (max 2). */
const getFallbackChain = () => providers.allFallbacks();

const isConfigured = () => providers.isConfigured(providers.primary());

/** True when the configured LLM provider supports Groq's built-in browser search. */
const supportsBrowserSearch = () => {
  const c = getConfig();
  return c.provider === 'groq' || providers.looksLikeGroq(c.baseUrl);
};

/** True when image analysis is on for the primary provider (LLM_VISION=1 + vision model). */
const isVisionConfigured = () => providers.isVisionEnabled();

const notConfiguredError = (extra = '') => {
  const err = new Error(
    `AI provider is not configured. Set LLM_API_KEY (or AI_API_KEY / GROQ_API_KEY, and optionally LLM_BASE_URL / LLM_MODEL or AI_MODEL) in backend/.env, then restart the backend. See the LLM section in .env.example.${extra ? ` ${extra}` : ''}`
  );
  err.statusCode = 503;
  err.isOperational = true;
  err.code = 'AI_NOT_CONFIGURED';
  return err;
};

const apiError = (message, statusCode, code, detail = '') => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  err.code = code;
  if (detail) err.detail = detail; // server-side diagnostics; never contains the API key
  return err;
};

/**
 * Classifies an HTTP status into a user-safe error. The client-facing `message`
 * is calm and actionable; technical context goes into `detail` (server logs only)
 * and never includes the API key or the Authorization header.
 */
const classifyStatus = (status, bodyText, model, baseUrl, extraDetail = '') => {
  const bodyLower = String(bodyText || '').toLowerCase();
  const modelMentioned = /model/i.test(bodyLower);
  const tail = `provider=${getConfig().provider} status=${status}${extraDetail ? ` ${extraDetail}` : ''}`;
  // Every classified error remembers the RAW HTTP status the provider sent. The
  // fallback gate uses it: a raw 4xx (other than 429 rate limiting) is a user/
  // auth/config problem, never a provider-availability situation.
  const classifiedErr = (message, statusCode, code, detail) => {
    const e = apiError(message, statusCode, code, detail);
    e.providerHttpStatus = status;
    return e;
  };

  if (status === 401) {
    return classifiedErr(
      'The AI provider rejected the API key (HTTP 401). Check the LLM_API_KEY in backend/.env and restart the backend.',
      502,
      'AI_AUTH_INVALID',
      `${tail} 401 Unauthorized — invalid API key.`
    );
  }
  if (status === 403) {
    return classifiedErr(
      'The AI provider denied access to this model or key (HTTP 403). Check LLM_API_KEY and LLM_MODEL.',
      502,
      'AI_AUTH_FORBIDDEN',
      `${tail} 403 Forbidden.`
    );
  }
  if (status === 404) {
    if (modelMentioned) {
      return classifiedErr(
        `The configured AI model "${model}" is not available to this provider/key (HTTP 404). Check LLM_MODEL in backend/.env.`,
        502,
        'AI_MODEL_UNAVAILABLE',
        `${tail} 404 — model "${model}" not found.`
      );
    }
    return classifiedErr(
      'The AI provider endpoint was not found (HTTP 404). Check LLM_BASE_URL in backend/.env.',
      502,
      'AI_NOT_FOUND',
      `${tail} 404 — base URL ${baseUrl} returned not found.`
    );
  }
  if (status === 413) {
    // Groq sends 413 for "Request too large … tokens per minute (TPM): Limit
    // 8000, Requested 8487, please reduce your message size and try again." That
    // is a per-minute CAPACITY condition, not a malformed request: the caller
    // shrinks max_tokens and/or the fallback chain takes over. Classified like a
    // rate limit so it is retryable AND fallbackable (the old catch-all treated
    // it as a dead client error and gave up without even trying the fallback).
    const err413 = classifiedErr(
      'The AI provider could not fit this request in its per-minute token budget. Please try a shorter request or try again shortly.',
      502,
      'AI_RATE_LIMITED',
      `${tail} 413 request-too-large (per-minute token budget).`
    );
    err413.rateLimitKind = 'tokens';
    err413.retryable = true;
    // Marks the TRUE cause: the request itself cannot fit the provider's window.
    // The chain-failure path uses it to say "too large" instead of the misleading
    // "temporarily unavailable" (retrying an oversized request can never help).
    err413.requestTooLarge = true;
    return err413;
  }
  if (status === 429) {
    // NOT every 429 is a daily limit. Classify from the provider's own body:
    //   per-minute (RPM/TPM) -> recovers in seconds, one bounded retry is allowed
    //   daily allowance      -> overridden by dailyQuotaError() in the caller
    const kind = rateLimitKind(bodyText);
    let err429;
    if (kind === 'requests') {
      err429 = classifiedErr(
        'The AI provider is receiving too many requests. Please wait a moment and try again.',
        502,
        'AI_RATE_LIMITED',
        `${tail} 429 requests-per-minute (RPM) rate limit.`
      );
    } else if (kind === 'tokens') {
      err429 = classifiedErr(
        'The AI provider is receiving too many tokens right now. Please wait a moment and try again.',
        502,
        'AI_RATE_LIMITED',
        `${tail} 429 tokens-per-minute (TPM) rate limit.`
      );
    } else {
      err429 = classifiedErr(
        'The AI is temporarily busy. Please try again shortly.',
        502,
        'AI_RATE_LIMITED',
        `${tail} 429 rate limited (kind=${kind}).`
      );
    }
    err429.rateLimitKind = kind; // surfaced in [AI ERROR] logs only, never to the UI
    err429.retryable = true; // a per-minute limit is worth ONE bounded retry
    return err429;
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return classifiedErr(
      `The AI provider returned a temporary error (HTTP ${status}). Please try again.`,
      502,
      status === 503 ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_PROVIDER_ERROR',
      `${tail} HTTP ${status} provider error.`
    );
  }
  return classifiedErr(
    `The AI provider returned an unexpected error (HTTP ${status}). Please try again.`,
    502,
    'AI_PROVIDER_ERROR',
    `${tail} HTTP ${status} ${bodyText.slice(0, 200)}`
  );
};

/** Safe read of a response header (fetch Headers may be absent in tests). */
const readHeader = (resp, name) => {
  try {
    return resp.headers ? String(resp.headers.get(name) || '') : '';
  } catch {
    return '';
  }
};

/** Honest, rate-limit-aware backoff: honor Retry-After, never exceed MAX_BACKOFF_MS. */
const backoffDelay = (attempt, retryAfterMs = 0) => {
  const base = RETRY_DELAYS_MS[attempt] ?? 1600;
  const jitter = Math.round(Math.random() * 250);
  const fromHeader = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(Math.max(base, fromHeader) + jitter, MAX_BACKOFF_MS);
};

/** True when a 429 body says the DAILY quota is exhausted (fails fast — retrying only wastes 40s). */
const isDailyQuotaExhausted = (bodyText) => DAILY_QUOTA_RE.test(String(bodyText || ''));

/**
 * Which KIND of 429 the provider really sent. Every 429 must not be reported as
 * a "daily limit": a per-minute limit recovers in seconds and deserves a
 * different (and retryable) message than a spent daily allowance.
 * @returns {'daily'|'requests'|'tokens'|'unknown'}
 */
const rateLimitKind = (bodyText) => {
  const body = String(bodyText || '');
  if (isDailyQuotaExhausted(body)) return 'daily';
  if (RPM_QUOTA_RE.test(body)) return 'requests';
  if (TPM_QUOTA_RE.test(body)) return 'tokens';
  return 'unknown';
};

/**
 * The provider's own retry hint, parsed from the error BODY ("Please try again in
 * 18.33s" / "Please try again in 250ms"). Groq does not always send a
 * retry-after header, so relying on the header alone made the app retry inside
 * the same exhausted minute. Returns milliseconds, bounded to one minute, or 0.
 */
const parseRetryAfterFromBody = (bodyText) => {
  const m = String(bodyText || '').match(/try again in\s+([\d.]+)\s*(ms|s)?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = /ms/i.test(m[2] || '') ? n : n * 1000;
  return Math.min(Math.round(ms), 60000);
};

/**
 * Clean, honest error for an exhausted daily quota. The client-facing message
 * stays calm and tells the user the TWO real options (wait for the reset, or
 * configure another provider); the real provider reason goes into `detail`
 * (server logs only). Marked `retryable: false` so no UI offers a Retry button
 * that cannot work until the quota resets.
 */
const dailyQuotaError = ({ provider, bodyText, retryAfterMs, extraDetail, reqTag }) => {
  const reason = cleanProviderReason(bodyText) || 'daily token quota exhausted';
  const err = apiError(
    'Today\'s AI provider quota has been reached. Configure another AI provider or try again after the quota resets.',
    502,
    'AI_DAILY_LIMIT',
    `${extraDetail} ${provider} daily quota exhausted (retry-after ${retryAfterMs ? (retryAfterMs / 1000).toFixed(1) + 's' : '-'}). ${reason} ${reqTag}(stopped early — retrying a daily-limit 429 only burns time)`
  );
  err.isOperational = true;
  err.retryable = false; // a spent daily allowance never recovers inside this request
  err.rateLimitKind = 'daily';
  err.providerHttpStatus = 429; // raw provider status, for the fallback gate
  return err;
};

/**
 * Server-side failure diagnostics in the [AI ERROR] format: requestId, provider,
 * model, the RAW provider HTTP status + our client status, rate-limit kind, code
 * and the real provider reason. NEVER the API key or Authorization header
 * (scrubSecret guards the provider text).
 *
 * `http` is the status the PROVIDER sent (429/500/503…); `status` is the status
 * the client will receive. Both matter: a provider 429 answered to a client as
 * 502 is still a rate limit, and only `http` shows that.
 */
const aiErrorLog = ({ requestId = '', provider = '', model = '', status = '', http = '', kind = '', durationMs, attempts, code = '', detail = '', providerReason = '' }) => {
  const parts = [
    requestId ? `requestId=${requestId}` : '',
    provider ? `provider=${provider}` : '',
    model ? `model=${model}` : '',
    http ? `http=${http}` : '',
    status ? `status=${status}` : '',
    durationMs != null ? `latency=${(durationMs / 1000).toFixed(1)}s` : '',
    attempts != null ? `attempts=${attempts}` : '',
    code ? `code=${code}` : '',
    kind ? `type=${kind}` : '',
  ].filter(Boolean);
  console.error(`[AI ERROR] ${parts.join(' ')}`);
  const real = providerReason || detail || '';
  if (real) console.error(`[AI ERROR] ${scrubSecret(real).replace(/\s+/g, ' ').slice(0, 500)}`);
};

/**
 * Runs the retry/backoff policy against ONE provider config. Returns either a
 * success result or the final error plus rate-limit metadata for diagnostics.
 *
 * Reliability against provider wobble (esp. Groq free-tier 429s):
 * - transient statuses (408/429/5xx) and network/timeout failures are retried,
 *   never auth/config errors (401/403/404);
 * - a 200 with EMPTY content is retried with an increased token budget (some
 *   reasoning models exhaust a small max_tokens on thinking alone);
 * - a 429 that cannot possibly clear inside our backoff window (remaining
 *   tokens/requests = 0 and reset further away than MAX_BACKOFF_MS) fails FAST
 *   instead of burning ~40s of retries;
 * - backoff honors Retry-After / x-ratelimit-reset-tokens, capped at
 *   MAX_BACKOFF_MS; total retries are hard-capped (retries param).
 */
const consumeStreamingResponse = async (resp, { onDelta, abortSignal, cfg, attemptCount, startedAt, retryAfterMs, rateLimit }) => {
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) throw apiError('The AI provider returned an unreadable streaming response.', 502, 'AI_EMPTY_RESPONSE');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = '';
  const consume = async (line) => {
    const raw = line.trim();
    if (!raw || raw.startsWith(':') || raw === 'data: [DONE]' || !raw.startsWith('data:')) return;
    let event;
    try { event = JSON.parse(raw.slice(5).trim()); } catch { return; }
    const choice = event?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      content += delta;
      await onDelta(delta);
    }
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) await consume(line);
    }
    if (buffer.trim()) await consume(buffer);
    if (abortSignal?.aborted) finishReason = 'cancelled';
  } catch (err) {
    if (!content) throw err;
    finishReason = abortSignal?.aborted ? 'cancelled' : 'stream_error';
  }
  return {
    content: content ? content.trim() : null,
    toolCalls: [],
    provider: cfg.provider,
    model: cfg.model,
    attempts: attemptCount,
    durationMs: Date.now() - startedAt,
    retryAfterMs,
    rateLimit,
    finishReason,
    truncated: finishReason === 'length' || finishReason === 'stream_error',
    cancelled: finishReason === 'cancelled',
    usage: { promptTokens: null, completionTokens: null },
  };
};

const attemptWithProvider = async (cfg, {
  messages,
  temperature,
  maxTokens,
  retries,
  tools,
  toolChoice,
  requestId,
  onDelta,
  abortSignal,
}) => {
  const startedAt = Date.now();
  const reqTag = requestId ? `requestId=${requestId} ` : '';
  const total = retries + 1;
  const limits = providerTokenLimits(cfg);
  // Output budget actually requested by the caller (never above the absolute
  // ceiling) — this is what the per-attempt timeout is sized from.
  const requestedBudget = clampInt(maxTokens, MIN_OUTPUT_TOKENS, limits.output);
  // Per-attempt wall clock scales with that budget (see perAttemptTimeoutMs), and
  // the total request deadline is derived from it so the two can never disagree.
  const attemptTimeoutMs = perAttemptTimeoutMs(requestedBudget);
  const deadlineAt = startedAt + Math.max(REQUEST_DEADLINE_MS, attemptTimeoutMs * total + 2000);

  let lastErr = null;
  let retryAfterMs = 0;
  let rateLimit = {};
  let tokenBudget = requestedBudget;
  let attemptCount = 0;
  let rateLimitAttempts = 0; // 429s get AT MOST ONE retry (never a ~40s retry storm)
  let providerReason = '';
  let lastStatus = null; // HTTP status of the latest attempt (for backoff choice)
  let budgetDowngrades = 0; // how many times we halved max_tokens on a provider 400

  for (let attempt = 0; attempt < total; attempt += 1) {
    attemptCount += 1;
    // Hard total budget: a request can never hang longer than the derived deadline.
    if (Date.now() >= deadlineAt) break;

    const controller = new AbortController();
    const abortUpstream = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener('abort', abortUpstream, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    let retryable = false;

    const body = {
      model: cfg.model,
      messages: fitMessagesToInputLimit(messages, limits.input),
      temperature,
      max_tokens: Math.min(tokenBudget, limits.output),
      ...(typeof onDelta === 'function' ? { stream: true } : {}),
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      let resp = null;
      try {
        if (DEV_LOG) console.log(`[AI PROVIDER REQUEST]${requestId ? ` requestId=${requestId}` : ''} provider=${cfg.provider} model=${cfg.model} attempt=${attempt + 1}/${total}`);
        resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(body),
        });
      } catch (err) {
        const timedOut = err && err.name === 'AbortError';
        lastErr = apiError(
          'The AI provider is unreachable right now — the request timed out or the network failed. Please try again in a moment.',
          503,
          'AI_UNREACHABLE',
          `${reqTag}provider=${cfg.provider} ${timedOut
            ? `request timed out after ${Math.round(attemptTimeoutMs / 1000)}s (max_tokens=${tokenBudget})`
            : `network error: ${err.message}`}`
        );
        lastErr.retryable = true; // transient network/timeout failures are retried
        retryable = true;
      }

      if (resp) {
        lastStatus = resp.status;
        // Rate-limit headers (safe numbers only — never auth material).
        const ra = readHeader(resp, 'retry-after');
        const resetTokens = readHeader(resp, 'x-ratelimit-reset-tokens');
        const remainingTokens = readHeader(resp, 'x-ratelimit-remaining-tokens');
        const remainingRequests = readHeader(resp, 'x-ratelimit-remaining-requests');
        retryAfterMs = Number(ra) > 0 ? Number(ra) * 1000 : 0;
        if (!retryAfterMs && Number(resetTokens) > 0) retryAfterMs = Number(resetTokens) * 1000;
        rateLimit = {
          remainingRequests,
          remainingTokens,
          resetTokens,
          retryAfterSeconds: ra || String(retryAfterMs ? retryAfterMs / 1000 : ''),
        };

        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => '');
          const extra = `retryAfter=${retryAfterMs ? retryAfterMs / 1000 + 's' : '-'} remainingTokens=${remainingTokens || '-'} remainingRequests=${remainingRequests || '-'}`;
          lastErr = classifyStatus(resp.status, bodyText, cfg.model, cfg.baseUrl, extra);
          providerReason = cleanProviderReason(bodyText);
          retryable = RETRYABLE_STATUS.has(resp.status); // auth/config errors end immediately

          // The provider rejected the request as TOO LARGE — either max_tokens
          // above the model's ceiling (400) or the whole request above the
          // per-minute token budget (Groq 413 "Request too large … reduce your
          // message size"). That is recoverable: halve the reserved output budget
          // and ask again instead of failing the whole message (this protects
          // "give me 1000 words" in a long conversation on a small TPM budget).
          if (isTokenBudgetTooLarge(resp.status, bodyText) && tokenBudget > MIN_OUTPUT_TOKENS) {
            budgetDowngrades += 1;
            tokenBudget = Math.max(MIN_OUTPUT_TOKENS, Math.floor(tokenBudget / 2));
            const perMinute = resp.status === 413; // TPM capacity vs the model's max_tokens ceiling
            lastErr = apiError(
              perMinute
                ? 'The AI provider could not fit this request in its per-minute budget. Retrying with a smaller output budget.'
                : 'The configured AI model cannot produce an answer this long in one pass. Retrying with a smaller budget.',
              502,
              perMinute ? 'AI_RATE_LIMITED' : 'AI_BUDGET_TOO_LARGE',
              `${reqTag}provider=${cfg.provider} HTTP ${resp.status} request-too-large (downgrading max_tokens to ${tokenBudget}, attempt ${attempt + 1}) ${cleanProviderReason(bodyText)}`
            );
            lastErr.providerHttpStatus = resp.status; // 413 stays fallbackable; 400 does not
            lastErr.retryable = true;
            if (perMinute) lastErr.requestTooLarge = true; // honest all-413 verdict downstream
            // Shrinking the request IS the remedy — waiting out a rate window
            // cannot make an oversized request fit, so retry promptly.
            retryAfterMs = 0;
            retryable = true;
          }

          if (resp.status === 429 && retryable) {
            rateLimitAttempts += 1;
            const kind = rateLimitKind(bodyText);

            // Daily-quota (TPD/RPD/account allowance) 429s NEVER retry: the quota
            // does not come back inside this request, so retrying only burns time
            // and quota — the old code slept up to ~40s and still failed. A per-
            // minute limit is a different animal (it clears in seconds) and gets
            // ONE bounded retry below.
            if (kind === 'daily') {
              retryable = false;
              lastErr = dailyQuotaError({ provider: cfg.provider, bodyText, retryAfterMs, extraDetail: extra, reqTag });
            } else {
              // Per-minute / concurrency pressure: max ONE retry total.
              retryable = rateLimitAttempts < 2;
              // The provider often states the delay in the BODY ("Please try again
              // in 18.33s") even when no retry-after header is present. Honor it,
              // or the retry lands inside the same exhausted minute and fails.
              if (!retryAfterMs) retryAfterMs = parseRetryAfterFromBody(bodyText);
              if (retryAfterMs) rateLimit.retryAfterSeconds = String(retryAfterMs / 1000);
              // A reset farther out than we are willing to wait means the retry
              // would outlive the request — fail fast and let the fallback chain
              // (or the honest error) take over instead of sleeping pointlessly.
              if (retryable && retryAfterMs > RATE_LIMIT_MAX_WAIT_MS) retryable = false;
            }
          }
        } else {
          if (typeof onDelta === 'function') {
            const streamed = await consumeStreamingResponse(resp, {
              onDelta,
              abortSignal,
              cfg,
              attemptCount,
              startedAt,
              retryAfterMs,
              rateLimit,
            });
            return { ok: true, value: streamed };
          }
          const data = await resp.json().catch(() => null);
          const msg = data?.choices?.[0]?.message || null;
          const content = msg?.content;
          const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
          // `finish_reason: "length"` means the provider hit the output ceiling
          // and CUT the answer off. It is surfaced to the caller so a long
          // response can be continued instead of being silently shipped short.
          const finishReason = String(data?.choices?.[0]?.finish_reason || '') || '';

          if (!content && !toolCalls.length) {
            // Reasoning models can spend the max_tokens budget on "thinking" and
            // return 200 with empty content. Retry with a bigger budget instead
            // of failing the whole message.
            tokenBudget = Math.min(
              Math.max(tokenBudget * 2, Math.round(requestedBudget * 1.5)),
              Math.max(EMPTY_RESPONSE_BUDGET_CAP, requestedBudget)
            );
            lastErr = apiError(
              'The AI provider returned an empty response. Please try again.',
              502,
              'AI_EMPTY_RESPONSE',
              `${reqTag}provider=${cfg.provider} empty content + no tool calls on attempt ${attempt + 1} (retrying with max_tokens=${tokenBudget})`
            );
            retryable = attempt < total - 1; // retry only if a retry slot remains
          } else {
            const durationMs = Date.now() - startedAt;
            // Safe dev diagnostic (§12): never the key, Authorization header or
            // prompt/body — provider, model, requestId, attempts and latency only.
            if (DEV_LOG) {
              console.log(`[AI PROVIDER RESPONSE]${requestId ? ` requestId=${requestId}` : ''} status=200`);
              console.log(
                `[AI RESPONSE] status=200 provider=${cfg.provider} model=${cfg.model}` +
                  `${requestId ? ` requestId=${requestId}` : ''} attempts=${attemptCount} latency=${(durationMs / 1000).toFixed(1)}s` +
                  `${finishReason ? ` finish=${finishReason}` : ''}`
              );
            }
            return {
              ok: true,
              value: {
                content: content ? String(content).trim() : null,
                toolCalls,
                provider: cfg.provider,
                model: cfg.model,
                attempts: attemptCount,
                durationMs,
                retryAfterMs,
                rateLimit,
                finishReason,
                truncated: finishReason === 'length',
                usage: {
                  promptTokens: Number(data?.usage?.prompt_tokens) || null,
                  completionTokens: Number(data?.usage?.completion_tokens) || null,
                },
              },
            };
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', abortUpstream);
    }

    if (!retryable) break;

    // Controlled backoff before the next attempt, bounded by the total deadline.
    if (attempt < total - 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      let want = 0;
      if (lastStatus === 429) {
        // Honor the provider's OWN per-minute Retry-After (bounded by
        // RATE_LIMIT_MAX_WAIT_MS — the same cap that allowed this retry), so the
        // window has really cleared when we try again. With no stated delay keep
        // the short backoff the tests and the old path expect.
        want = retryAfterMs > 0
          ? Math.min(retryAfterMs + 400, RATE_LIMIT_MAX_WAIT_MS)
          : backoffDelay(attempt, 0);
      } else {
        want = retryAfterMs > 0 && retryAfterMs <= MAX_BACKOFF_MS ? retryAfterMs + 400 : 0;
        if (want <= 0) want = backoffDelay(attempt, retryAfterMs);
      }
      await sleep(Math.min(want, remaining));
    }
  }

  if (!lastErr) lastErr = apiError('The AI provider is unreachable right now — the request timed out or the network failed. Please try again in a moment.', 503, 'AI_UNREACHABLE');
  // End-to-end provider trace (safe: requestId, raw HTTP status, classified
  // reason — never the key, Authorization header, body or JWT).
  if (DEV_LOG) console.log(`[AI PROVIDER ERROR]${requestId ? ` requestId=${requestId}` : ''} status=${lastStatus || lastErr.statusCode || 502} reason=${lastErr.code || 'error'}`);
  // Server-side real-error diagnostics — logs the provider's own reason.
  aiErrorLog({
    requestId,
    provider: cfg.provider,
    model: cfg.model,
    status: lastErr.statusCode || 502,
    http: lastStatus || '',
    kind: lastErr.rateLimitKind || '',
    durationMs: Date.now() - startedAt,
    attempts: attemptCount,
    code: lastErr.code,
    detail: `${lastErr.detail || ''}${budgetDowngrades ? ` maxTokensBudgetDowngrades=${budgetDowngrades}` : ''}`,
    providerReason,
  });
  return { ok: false, error: lastErr, retryAfterMs, rateLimit, attempts: attemptCount, attemptUsable: true, lastAttemptDurationMs: Date.now() - startedAt };
};

/**
 * Safe per-request AI log (§37): requestId, provider, model, HTTP status,
 * duration, attempts, category. Never any key/auth material by construction.
 */
const aiLog = ({ requestId = '', provider = '', model = '', status = '', durationMs, attempts, category = '' }) => {
  const parts = [
    requestId ? `request=${requestId}` : '',
    provider ? `provider=${provider}` : '',
    model ? `model=${model}` : '',
    status ? `status=${status}` : '',
    durationMs != null ? `duration=${(durationMs / 1000).toFixed(1)}s` : '',
    attempts != null ? `attempts=${attempts}` : '',
    category ? `category=${category}` : '',
  ].filter(Boolean);
  console.log(`[AI] ${parts.join(' ')}`);
};

// Tag used when a provider failure is finally surfaced (from a clean error code).
const aiCategoryFromCode = (code) => String(code || 'AI_PROVIDER_ERROR').replace(/^AI_/, '');

/**
 * Resolves which provider config to use for a request that PINS a provider
 * (a continuation turn). Continuations stay on the SAME provider that produced
 * the answer — they never re-probe a primary that just failed mid-answer.
 * Returns null when the requested provider/model is not the primary or any
 * configured fallback in the chain (caller then falls back to normal resolution).
 */
const resolvePreferredCfg = ({ preferProvider, preferModel, primaryCfg, noFallback }) => {
  const wantProvider = String(preferProvider || '').trim();
  const wantModel = String(preferModel || '').trim();
  if (!wantProvider) return null;
  const matches = (p, m) => p === wantProvider && (!wantModel || m === wantModel);
  if (matches(primaryCfg.provider, primaryCfg.model)) return primaryCfg;
  if (!noFallback) {
    for (const fb of getFallbackChain()) {
      if (matches(fb.provider, fb.model)) return fb;
    }
  }
  // Provider-only match (the model may have been overridden per request).
  if (primaryCfg.provider === wantProvider) return primaryCfg;
  if (!noFallback) {
    for (const fb of getFallbackChain()) {
      if (fb.provider === wantProvider) return fb;
    }
  }
  return null;
};

/**
 * One complete chat request with the retry/backoff policy. When the primary
 * provider exhausts its retries AND the failure is a provider availability /
 * quota / rate-limit situation, a configured FALLBACK provider receives the
 * SAME request exactly once before the clean error is thrown. User/auth/config
 * errors (400/401/403/404) never switch providers.
 *
 * `maxTokens` is CLAMPED to MAX_OUTPUT_TOKENS: the caller may compute a large
 * budget from the user's request, but a model with a smaller ceiling must not
 * turn a normal request into a hard 400.
 *
 * @param {{messages:Array, temperature?:number, maxTokens?:number, maxRetries?:number,
 *          tools?:Array, toolChoice?:string, requestId?:string, model?:string,
 *          noFallback?:boolean, preferProvider?:string, preferModel?:string}} opts
 * @returns {Promise<{content:string|null, toolCalls:Array, provider:string, model:string,
 *                    attempts:number, durationMs:number, retryAfterMs:number,
 *                    rateLimit:Object, finishReason:string, truncated:boolean,
 *                    usage:Object}>}
 */
const requestCompletion = async ({
  messages,
  temperature = 0.5,
  maxTokens = 1200,
  maxRetries,
  tools,
  toolChoice,
  requestId = '',
  model = '',
  noFallback = false,
  preferProvider = '',
  preferModel = '',
  onDelta,
  abortSignal,
}) => {
  if (!isConfigured()) throw notConfiguredError();

  const primary = getConfig();
  // Optional per-request model override (used for image requests: the primary
  // text model may be text-only while LLM_VISION_MODEL handles the vision part).
  const primaryCfg = model ? { ...primary, model } : primary;
  const retries = Math.max(0, Math.min(3, Number(maxRetries ?? DEFAULT_MAX_RETRIES)));
  const reqTag = requestId ? `requestId=${requestId} ` : '';
  // Caller-computed budget, capped at the absolute ceiling.
  const budget = clampInt(maxTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

  // Continuation turns stay on the SAME provider that produced the answer:
  // ragService passes back the provider/model of the last successful call, so a
  // follow-up turn never re-hammers a primary that just went down. A preferred
  // provider is used directly (with its own retries) and no inline fallback is
  // tried — we are already on the survivor.
  let cfg = primaryCfg;
  if (preferProvider) {
    const preferred = resolvePreferredCfg({ preferProvider, preferModel, primaryCfg, noFallback });
    if (preferred) {
      cfg = preferred;
      noFallback = true;
    }
  }
  // Safe provider-status diagnostics (§9): names only, never keys/auth material.
  if (DEV_LOG) console.log(`[AI] Primary provider: ${providerLabel(cfg.provider)}`);

  const first = await attemptWithProvider(cfg, {
    messages,
    temperature,
    maxTokens: budget,
    retries,
    tools,
    toolChoice,
    requestId,
    onDelta,
    abortSignal,
  });
  if (first.ok) {
    aiLog({ requestId, provider: cfg.provider, model: cfg.model, status: 200, durationMs: first.value.durationMs, attempts: first.value.attempts, category: first.value.truncated ? 'OK(truncated)' : 'OK' });
    return first.value;
  }

  // Last resort: the configured FALLBACK CHAIN (slot 1, then slot 2) is tried
  // in order — EXACTLY ONE attempt per fallback — and only for provider
  // availability/quota/rate-limit failures. A daily-quota 429 is NEVER retried
  // on the primary — the chain is tried immediately. The user only sees an
  // error when EVERY configured provider failed. Vision requests skip the
  // fallback when it would be a text-only model (image content parts would 400
  // there) — a clean "AI temporarily busy" beats a confusing provider error.
  const fallbackChain = noFallback ? [] : getFallbackChain();
  if (fallbackChain.length && allowsFallback(first.error)) {
    const primaryLabel = providerLabel(cfg.provider);
    if (DEV_LOG) {
      const primaryKind = first.error && first.error.rateLimitKind === 'daily' ? 'quota exceeded' : 'unavailable';
      console.log(`[AI] ${primaryLabel} ${primaryKind}.`);
      console.log(`[AI] Primary provider unavailable: ${cfg.provider} / Fallback provider: ${fallbackChain[0].provider}`);
    }
    const chainAttempts = [];
    let chainErr = null;
    for (let i = 0; i < fallbackChain.length; i += 1) {
      const fb = fallbackChain[i];
      if (DEV_LOG) {
        console.log(`[AI] Switching to ${providerLabel(fb.provider)}.`);
        console.log(`[AI FALLBACK] provider=${fb.provider} model=${fb.model}`);
      }
      const attempt = await attemptWithProvider(fb, {
        messages,
        temperature,
        maxTokens: budget,
        retries: Math.min(1, retries),
        tools,
        toolChoice,
        requestId,
        onDelta,
        abortSignal,
      });
      if (attempt.ok) {
        if (DEV_LOG) console.log(`[AI] ${providerLabel(fb.provider)} response successful.`);
        aiLog({ requestId, provider: fb.provider, model: fb.model, status: 200, durationMs: attempt.value.durationMs, attempts: attempt.value.attempts, category: 'OK' });
        return attempt.value;
      }
      chainAttempts.push({ cfg: fb, attempt });
      chainErr = attempt.error || chainErr;
      if (DEV_LOG) {
        const kind = attempt.error && attempt.error.rateLimitKind === 'daily' ? 'quota exceeded' : 'unavailable';
        console.log(`[AI] ${providerLabel(fb.provider)} ${kind}.`);
      }
    }
    if (DEV_LOG) console.log('[AI] All configured AI providers failed.');
    const fallbackErr = chainErr || apiError('The AI fallback provider failed.', 502, 'AI_PROVIDER_ERROR');
    const triedNames = [cfg.provider, ...chainAttempts.map((x) => x.cfg.provider)];
    const triedCodes = [first.error && first.error.code || 'error', ...chainAttempts.map((x) => (x.attempt.error ? x.attempt.error.code || 'error' : 'error'))];
    // A spent DAILY quota on ANY tried provider means this request cannot recover
    // inside its own lifetime — it must never offer a Retry button that cannot
    // work until the provider's window resets.
    const dailyInvolved = triedCodes.includes('AI_DAILY_LIMIT');
    // EVERY provider rejected the request as TOO LARGE (Groq 413). That is the
    // true cause and the one case the generic "providers unavailable" wording
    // gets wrong: retrying an oversized request can never help.
    const allTooLarge =
      Boolean(first.error && first.error.requestTooLarge) &&
      chainAttempts.every((x) => x.attempt.error && x.attempt.error.requestTooLarge);
    const allRecoverable = [first.error, ...chainAttempts.map((x) => x.attempt.error)].every((e) => !e || e.retryable !== false);
    aiLog({ requestId, provider: cfg.provider, model: cfg.model, status: fallbackErr.statusCode || 502, attempts: chainAttempts.length ? chainAttempts[chainAttempts.length - 1].attempt.attempts : 1, category: aiCategoryFromCode(allTooLarge ? 'AI_REQUEST_TOO_LARGE' : 'AI_PROVIDERS_UNAVAILABLE') });
    if (allTooLarge) {
      // The request is bigger than the provider's whole per-minute window, so no
      // provider in the chain can fit it and no retry can. Say so plainly, with
      // retryable:false so no UI offers a Retry button that cannot work.
      const tooLarge = apiError(
        'This request is too large for the AI provider\'s per-minute token budget. Please shorten your message or start a new conversation and try again.',
        502,
        'AI_REQUEST_TOO_LARGE',
        `${reqTag}(${triedNames.map((n, i) => `provider "${n}" rejected as too large (${triedCodes[i]})`).join('; ')})`
      );
      tooLarge.retryable = false; // an oversized request never recovers by retrying
      tooLarge.usedFallback = true; // lets chatWithBrowserSearch degrade to a plain answer
      throw tooLarge;
    }
    // The whole configured chain (primary + every fallback) failed. Surface ONE
    // calm, exact message regardless of the individual causes — an outage, a
    // spent daily allowance and a per-minute limit are indistinguishable to the
    // user, and every raw provider body/name stays server-side. A quota failure
    // anywhere in the chain is never retryable (the allowance cannot come back
    // inside this request); otherwise retryable only if every failure could
    // recover.
    const allFailed = apiError(
      ALL_PROVIDERS_FAILED_MESSAGE,
      502,
      'AI_PROVIDERS_UNAVAILABLE',
      `${reqTag}(${triedNames.map((n, i) => `provider "${n}" failed with ${triedCodes[i]}`).join('; ')})`
    );
    allFailed.retryable = allRecoverable && !dailyInvolved;
    allFailed.usedFallback = true; // lets chatWithBrowserSearch degrade to plain chat
    throw allFailed;
  }

  const err = first.error;
  if (err && first.retryAfterMs) err.retryAfterMs = first.retryAfterMs;
  if (err && first.rateLimit) err.rateLimit = first.rateLimit;
  aiLog({ requestId, provider: cfg.provider, model: cfg.model, status: err.statusCode || 502, attempts: first.attempts, category: aiCategoryFromCode(err.code) });
  if (err && typeof err.detail === 'string' && !err.detail.includes('gave up after')) {
    err.detail = `${err.detail} ${reqTag}(gave up after ${retries + 1} attempt(s) on provider "${cfg.provider}")`;
  }
  throw err;
};

/**
 * Plain chat completion. Returns the assistant text (or throws a clean error).
 *
 * Pass `returnMeta: true` to get the full result object instead of a bare
 * string — ragService needs it to detect `finish_reason: "length"` (a cut-off
 * answer) and continue rather than shipping a truncated response.
 *
 * @param {{messages:Array<{role:string,content:string}>, temperature?:number, maxTokens?:number,
 *          maxRetries?:number, requestId?:string, returnMeta?:boolean}} opts
 * @returns {Promise<string|{content:string, finishReason:string, truncated:boolean, usage:Object}>}
 */
const chat = async ({
  messages,
  temperature = 0.5,
  maxTokens = 1200,
  maxRetries,
  requestId = '',
  model = '',
  noFallback = false,
  preferProvider = '',
  preferModel = '',
  returnMeta = false,
  onDelta,
  abortSignal,
}) => {
  const r = await requestCompletion({
    messages,
    temperature,
    maxTokens,
    maxRetries,
    requestId,
    model,
    noFallback,
    preferProvider,
    preferModel,
    onDelta,
    abortSignal,
  });
  if (!r.content) {
    throw apiError(
      'The AI model requested a search tool that is not enabled, and returned an empty response. Please try again in a moment.',
      502,
      'AI_TOOL_UNEXPECTED',
      `requestId=${requestId} provider=${getConfig().provider} model requested a tool call in a non-tool chat`
    );
  }
  if (returnMeta) {
    return {
      content: r.content,
      finishReason: r.finishReason || '',
      truncated: Boolean(r.truncated),
      cancelled: Boolean(r.cancelled),
      usage: r.usage || {},
      provider: r.provider || '',
      model: r.model || '',
    };
  }
  return r.content;
};

/**
 * Detects Groq's malformed-tool-call 400 (`tool_use_failed`). When the tools
 * array is present the model sometimes tries to emit its structured JSON answer
 * as a tool call, which the provider rejects. That is recoverable — re-ask with
 * no tools so the JSON arrives as ordinary content.
 */
const isToolCallFailure = (err) => {
  const d = String((err && (err.detail || err.message)) || '');
  return /tool_use_failed|tool call|tool_calls|failed to parse tool/i.test(d);
};

/**
 * Chat with Groq's built-in browser_search.
 *
 * Round 1: send the conversation with the browser_search tool available. If the
 * model decides web information is needed it returns a tool call.
 * Round 2: send back the assistant tool call plus a tool message so Groq executes
 * the search server-side (per Groq's browser_search contract) and produces a
 * grounded answer with real citations.
 *
 * When Groq's server-side fill is unavailable or fails, the call degrades HONESTLY:
 * the question is re-answered without any tool, so the assistant never pretends it
 * searched the web when it did not.
 *
 * @param {{messages:Array, temperature?:number, maxTokens?:number, maxRetries?:number, requestId?:string}} opts
 * @returns {Promise<{content:string, toolUsed:boolean, urls:string[],
 *                    rateLimit:Object, attempts:number, durationMs:number,
 *                    finishReason:string, truncated:boolean}>}
 */
const chatWithBrowserSearch = async ({
  messages,
  temperature = 0.4,
  maxTokens = 1600,
  maxRetries,
  requestId = '',
}) => {
  if (!isConfigured()) throw notConfiguredError();
  if (!supportsBrowserSearch()) {
    // Not a Groq endpoint: run the plain chat instead (still real, registry-grounded).
    const r = await chat({ messages, temperature, maxTokens, maxRetries, requestId, returnMeta: true });
    return { content: r.content, toolUsed: false, urls: [], attempts: 1, durationMs: 0, rateLimit: {}, finishReason: r.finishReason, truncated: r.truncated, provider: r.provider || '', model: r.model || '' };
  }

  let r1;
  try {
    r1 = await requestCompletion({
      messages,
      temperature,
      maxTokens,
      maxRetries,
      tools: [BROWSER_SEARCH_TOOL],
      toolChoice: 'auto',
      requestId,
    });
  } catch (err) {
    // The model tried to satisfy the "reply as JSON" instruction with a bogus
    // tool call instead of a browser_search call. A resource answer must not die
    // for that: re-ask without tools, where the JSON is produced as content.
    // A fallback provider that does not know the browser_search tool surfaces a
    // both-failed error tagged `usedFallback` — that degrades the SAME way
    // instead of failing a web question outright.
    if (!isToolCallFailure(err) && !err.usedFallback) throw err;
    const r = await chat({ messages, temperature, maxTokens, maxRetries, requestId, returnMeta: true });
    return { content: r.content, toolUsed: false, urls: [], attempts: 1, durationMs: 0, rateLimit: {}, finishReason: r.finishReason, truncated: r.truncated, provider: r.provider || '', model: r.model || '' };
  }

  // Model answered directly without needing web results.
  if (r1.content && !r1.toolCalls.length) {
    return { content: r1.content, toolUsed: false, urls: [], attempts: r1.attempts, durationMs: r1.durationMs, rateLimit: r1.rateLimit, finishReason: r1.finishReason, truncated: r1.truncated, provider: r1.provider || '', model: r1.model || '' };
  }

  // Model requested a search: run the Groq server-side round trip.
  const searchCall = (r1.toolCalls || []).find((tc) => tc && tc.function && tc.function.name === 'browser_search');
  if (!searchCall) {
    throw apiError(
      'The AI model requested an unexpected tool, and returned an empty response. Please try again in a moment.',
      502,
      'AI_TOOL_UNEXPECTED',
      `requestId=${requestId} tool=${((r1.toolCalls || [])[0] || {}).function?.name || 'unknown'}`
    );
  }

  let args = {};
  try {
    args = JSON.parse((searchCall.function && searchCall.function.arguments) || '{}') || {};
  } catch {
    args = {};
  }
  const toolCallId = searchCall.id || `call_${Date.now()}`;

  const assistantToolMsg = { role: 'assistant', tool_calls: r1.toolCalls };
  // Groq executes browser_search server-side when the tool message is sent back;
  // an empty content string means "let Groq fill in the real results".
  const toolMsg = { role: 'tool', tool_call_id: toolCallId, content: '' };

  let r2;
  try {
    r2 = await requestCompletion({
      messages: [...messages, assistantToolMsg, toolMsg],
      temperature,
      maxTokens,
      maxRetries,
      tools: [BROWSER_SEARCH_TOOL],
      toolChoice: 'auto',
      requestId,
    });
  } catch (err) {
    // Same recovery as round 1: a malformed tool call must degrade to a plain,
    // tool-free answer instead of a 502. A fallback provider that cannot replay
    // the primary's tool_call_id surfaces a both-failed error tagged
    // `usedFallback` — that degrades the same way.
    if (!isToolCallFailure(err) && !err.usedFallback) throw err;
    const r = await chat({ messages, temperature, maxTokens, maxRetries, requestId, returnMeta: true });
    return { content: r.content, toolUsed: false, urls: [], attempts: r1.attempts + 1, durationMs: r1.durationMs, rateLimit: r1.rateLimit, finishReason: r.finishReason, truncated: r.truncated, provider: r.provider || '', model: r.model || '' };
  }

  if (r2.content) {
    const urls = extractRealUrls(r2.content).slice(0, 6);
    return {
      content: r2.content,
      toolUsed: true,
      urls,
      attempts: r1.attempts + r2.attempts,
      durationMs: r1.durationMs + r2.durationMs,
      rateLimit: r2.rateLimit,
      finishReason: r2.finishReason,
      truncated: r2.truncated,
      provider: r2.provider || '',
      model: r2.model || '',
    };
  }

  // Honest degradation: no usable search result — answer without the tool.
  const degraded = await chat({ messages, temperature, maxTokens, maxRetries, requestId, returnMeta: true });
  return {
    content: degraded.content,
    toolUsed: false,
    urls: [],
    attempts: r1.attempts + r2.attempts + 1,
    durationMs: r1.durationMs + r2.durationMs,
    rateLimit: r2.rateLimit,
    finishReason: degraded.finishReason,
    truncated: degraded.truncated,
    provider: degraded.provider || '',
    model: degraded.model || '',
  };
};

/** Extracts http(s) URLs from free text, exactly as written (validated later by resourceService). */
const extractRealUrls = (text) => {
  const re = /https?:\/\/[^\s<>"'()]+/g;
  const out = [];
  const seen = new Set();
  const t = String(text || '');
  let m;
  while ((m = re.exec(t)) !== null) {
    const url = m[0].replace(/[),.;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
};

/**
 * Convenience: single system prompt + user prompt. Supports multi-part user
 * content for vision (images): pass parts as an array of OpenAI content parts.
 */
const complete = async ({ system, user, temperature = 0.5, maxTokens = 1200, requestId }) => {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  return chat({ messages, temperature, maxTokens, requestId });
};

// ---- Provider reachability probe (health "configured" vs "unreachable") ----
let probeState = {
  status: null, // null | 'not-configured' | 'checking' | 'configured' | 'unreachable'
  at: 0,
  detail: '',
  inFlight: false,
  modelAvailable: null, // null (unknown) | true | false
  availableModels: [],
};
let probePromise = null;

const freshProbe = (s) => Boolean(s.status) && Date.now() - s.at < PROBE_CACHE_MS;

async function doProbe() {
  const configIssue = providers.configurationIssue(getConfig());
  if (configIssue) {
    probeState = {
      status: 'misconfigured',
      at: Date.now(),
      detail: configIssue,
      inFlight: false,
      modelAvailable: null,
      availableModels: [],
    };
    return probeState;
  }
  if (!isConfigured()) {
    probeState = {
      status: 'not-configured',
      at: Date.now(),
      detail: 'no API key is configured (LLM_API_KEY / AI_API_KEY / GROQ_API_KEY)',
      inFlight: false,
      modelAvailable: null,
      availableModels: [],
    };
    return probeState;
  }
  if (probePromise) return probePromise;

  const c = getConfig();
  probeState = { ...probeState, status: 'checking', inFlight: true };
  probePromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;

    let next;
    try {
      const resp = await fetch(`${c.baseUrl}/models`, { method: 'GET', headers, signal: controller.signal });
      if (resp.ok) {
        let ids = [];
        let modelAvailable = null;
        try {
          const data = await resp.json();
          ids = (data.data || []).map((m) => m && m.id).filter(Boolean);
          modelAvailable = ids.includes(c.model);
        } catch { /* list body ignored */ }
        next = {
          status: 'configured',
          at: Date.now(),
          detail: `reachable (${ids.length || 0} models listed)`,
          httpStatus: resp.status,
          errorCategory: null,
          inFlight: false,
          modelAvailable,
          availableModels: ids,
        };
      } else {
        next = {
          status: 'unreachable',
          at: Date.now(),
          detail: `GET /models returned HTTP ${resp.status}`,
          httpStatus: resp.status,
          errorCategory: probeErrorCategory(resp.status),
          inFlight: false,
          modelAvailable: null,
          availableModels: [],
        };
      }
    } catch (err) {
      next = {
        status: 'unreachable',
        at: Date.now(),
        detail: err.name === 'AbortError' ? 'connection timed out' : 'provider probe failed',
        httpStatus: null,
        errorCategory: err.name === 'AbortError' ? 'timeout' : 'network',
        inFlight: false,
        modelAvailable: null,
        availableModels: [],
      };
    } finally {
      clearTimeout(timer);
    }
    probeState = next;
    console.info(
      `[AI HEALTH] provider=${c.provider} model=${c.model}` +
      ` status=${next.status} httpStatus=${next.httpStatus || '-'} category=${next.errorCategory || '-'}`
    );
    return next;
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

const probeStatus = async () => {
  const c = getConfig();
  const configIssue = providers.configurationIssue(c);
  if (configIssue || !isConfigured()) return providerStatus();
  if (freshProbe(probeState)) return providerStatus();
  await doProbe();
  return providerStatus();
};

/**
 * Current provider status for /api/health, never blocking on the network:
 * returns a cached value and refreshes in the background when stale.
 * @returns {{status:string, provider:string, model:string, baseUrl:string, detail:string, modelAvailable:boolean|null, availableModels:string[]}}
 */
const providerStatus = () => {
  const c = getConfig();
  const configIssue = providers.configurationIssue(c);
  if (configIssue) {
    return {
      status: 'misconfigured',
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      detail: configIssue,
      httpStatus: null,
      errorCategory: 'configuration',
      modelAvailable: null,
      availableModels: [],
    };
  }
  if (!isConfigured()) {
    return {
      status: 'not-configured',
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      detail: 'Set LLM_API_KEY, AI_API_KEY, or GROQ_API_KEY in backend/.env. No key is present, so AI chat returns an honest 503 — answers are never simulated.',
      httpStatus: null,
      errorCategory: 'not_configured',
      modelAvailable: null,
      availableModels: [],
    };
  }
  if (freshProbe(probeState)) {
    return {
      status: probeState.status,
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      detail: probeState.detail || '',
      httpStatus: probeState.httpStatus || null,
      errorCategory: probeState.errorCategory || null,
      modelAvailable: probeState.modelAvailable,
      availableModels: probeState.availableModels || [],
    };
  }
  // Stale/missing cache: refresh in the background, report "checking" meanwhile.
  doProbe().catch(() => {});
  const status = probeState.status === 'configured' || probeState.status === 'unreachable'
    ? (Date.now() - probeState.at < PROBE_CACHE_MS * 3 ? probeState.status : 'checking')
    : 'checking';
  return {
    status,
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    detail: probeState.detail || '',
    httpStatus: probeState.httpStatus || null,
    errorCategory: probeState.errorCategory || null,
    modelAvailable: probeState.modelAvailable,
    availableModels: probeState.availableModels || [],
  };
};

/** Safe startup diagnostics. NEVER includes the API key. */
const describe = () => {
  const p = providers.describe();
  return {
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeyConfigured: p.apiKeyConfigured,
    configured: p.configured,
    fallback: p.fallback ? { provider: p.fallback.provider, model: p.fallback.model } : null,
    fallback2: p.fallback2 ? { provider: p.fallback2.provider, model: p.fallback2.model } : null,
    fallbackChain: p.fallbackChain,
    fallback1Declared: p.fallback1Declared,
    fallback1Configured: p.fallback1Configured,
    fallback2Declared: p.fallback2Declared,
    fallback2Configured: p.fallback2Configured,
    vision: p.vision,
  };
};

module.exports = {
  chat,
  complete,
  chatWithBrowserSearch,
  requestCompletion,
  isToolCallFailure,
  isConfigured,
  supportsBrowserSearch,
  isVisionConfigured,
  supportsVisionModel: providers.supportsVisionModel,
  getConfig,
  getFallbackConfig,
  getFallbackChain,
  providerStatus,
  probeStatus,
  probeErrorCategory,
  doProbe,
  describe,
  // Budget/timeout introspection (used by the deterministic budget tests).
  perAttemptTimeoutMs,
  maxOutputTokensCeiling: () => MAX_OUTPUT_TOKENS,
  providerTokenLimits,
  estimateContentTokens,
  fitMessagesToInputLimit,
  // 429 classification introspection (used by providerErrorTest): which KIND of
  // rate limit a provider body really is, and how it maps to a client error.
  rateLimitKind,
  isDailyQuotaExhausted,
  classifyStatus,
  providerLabel,
  ALL_PROVIDERS_FAILED_MESSAGE,
};