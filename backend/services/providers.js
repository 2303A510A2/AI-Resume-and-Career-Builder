// Clean AI provider model for the whole backend (chat + voice + vision).
//
// One canonical shape shared by every AI service:
//   { provider, baseUrl, model, apiKey }
//
// PRIMARY provider (what the app talks to first):
//   LLM_PROVIDER / AI_PROVIDER         provider id (groq | openai | openrouter | deepseek | together | ollama | ...)
//   LLM_API_KEY || AI_API_KEY || GROQ_API_KEY || OPENAI_API_KEY
//   LLM_BASE_URL || AI_BASE_URL        (defaults per provider, Groq/OpenAI)
//   LLM_MODEL    || AI_MODEL           (defaults per provider)
//
// FALLBACK provider (used automatically when the primary is temporarily
// unavailable after its own retries — one extra attempt, then a clean message):
//   LLM_FALLBACK_PROVIDER, LLM_FALLBACK_API_KEY,
//   LLM_FALLBACK_BASE_URL, LLM_FALLBACK_MODEL
//
// VISION (image analysis in chat):
//   LLM_VISION=1                       enables image input on vision-capable models
//   LLM_VISION_MODEL                   optional per-request vision model override
//                                      (e.g. qwen/qwen3.8-27b on Groq) used ONLY for
//                                      messages with attached images, leaving the
//                                      primary text model (e.g. gpt-oss-20b) for chat
//   LLM_VISION_MAX_IMAGE_BYTES         cap for stored base64 images (default 1.5 MB)
//
// Safety: keys are NEVER logged and NEVER returned to any client. Everything this
// module exports for diagnostics is key-free by construction.

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
// Gemini exposes an officially supported OpenAI-compatible API (same
// /chat/completions shape, Bearer auth). This is the canonical root; the
// provider layer appends `/chat/completions` exactly like OpenAI/Groq.
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const GROQ_DEFAULT_MODEL = 'qwen/qwen3.8-27b'; // fast, cheap AND vision-capable on Groq (verified live). Set LLM_MODEL=openai/gpt-oss-120b explicitly to opt back into the slower text-only reasoning flagship.
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Normalizes a provider base URL. A trailing slash is always removed (the
 * service appends `/chat/completions` itself). For Gemini it also repairs the
 * two easy-to-miss forms of the officially documented endpoint:
 *   https://generativelanguage.googleapis.com            -> .../v1beta/openai
 *   https://generativelanguage.googleapis.com/v1beta     -> .../v1beta/openai
 * so a valid Gemini key can never fail with a confusing 404 merely because the
 * admin pasted the native API root instead of the OpenAI-compatible root.
 */
const normalizeBase = (url, provider = '') => {
  let out = String(url || '').trim().replace(/\/+$/, '');
  if (!out) return out;
  const p = String(provider || '').trim().toLowerCase();
  const isGemini = p === 'gemini' || /generativelanguage\.googleapis\.com/i.test(out);
  if (isGemini && !/\/openai$/i.test(out)) {
    if (/\/v1beta$/i.test(out) || /\/v1$/i.test(out)) out = `${out}/openai`;
    else if (/googleapis\.com$/i.test(out)) out = `${out}/v1beta/openai`;
  }
  return out;
};

const isGroqApiKey = (key) => /^gsk_/i.test(String(key || '').trim());
const isGeminiApiKey = (key) => /^AIza[0-9A-Za-z_-]{10,}$/.test(String(key || '').trim());

/** Provider id inferred from env (explicit wins; then base URL; then key shape). */
const resolveProviderId = ({ configured, baseUrl, hasKey, apiKey }) => {
  const c = String(configured || '').trim().toLowerCase();
  if (c) return c;
  if (/(^|\.)groq\.com/i.test(baseUrl)) return 'groq';
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) return 'gemini';
  if (/openrouter\.ai/i.test(baseUrl)) return 'openrouter';
  if (/deepseek/i.test(baseUrl)) return 'deepseek';
  if (/together/i.test(baseUrl)) return 'together';
  if (/ollama/i.test(baseUrl)) return 'ollama';
  if (/openai\.com/i.test(baseUrl)) return 'openai';
  if (isGeminiApiKey(apiKey)) return 'gemini';
  if (isGroqApiKey(apiKey)) return 'groq';
  return hasKey ? 'openai' : 'openai';
};

const resolveApiKey = (...candidates) => {
  for (const key of candidates) {
    if (String(key || '').trim()) return String(key).trim();
  }
  return '';
};

const defaultModelFor = (provider) => {
  if (provider === 'groq') return GROQ_DEFAULT_MODEL;
  if (provider === 'gemini') return GEMINI_DEFAULT_MODEL;
  return OPENAI_DEFAULT_MODEL;
};

const defaultBaseFor = (provider) => {
  if (provider === 'groq') return GROQ_BASE_URL;
  if (provider === 'gemini') return GEMINI_BASE_URL;
  return OPENAI_BASE_URL;
};

/** Builds the PRIMARY provider config (backwards-compatible with llmService.getConfig). */
const primary = () => {
  const apiKey = resolveApiKey(
    process.env.LLM_API_KEY,
    process.env.AI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.OPENAI_API_KEY
  );
  let baseUrl = normalizeBase(process.env.LLM_BASE_URL || process.env.AI_BASE_URL);
  let configuredProvider = String(process.env.LLM_PROVIDER || process.env.AI_PROVIDER || '').trim().toLowerCase();
  // A Groq/Gemini key is unambiguous when no provider or endpoint was
  // configured. This prevents the historical failure mode where LLM_API_KEY
  // contained a Groq key but the absent provider settings silently selected
  // OpenAI.
  if (!configuredProvider && !baseUrl && isGroqApiKey(apiKey)) configuredProvider = 'groq';
  if (!configuredProvider && !baseUrl && isGeminiApiKey(apiKey)) configuredProvider = 'gemini';
  const provider = resolveProviderId({ configured: configuredProvider, baseUrl, hasKey: Boolean(apiKey), apiKey });
  if (!baseUrl) baseUrl = defaultBaseFor(provider);
  baseUrl = normalizeBase(baseUrl, provider);

  let model = String(process.env.LLM_MODEL || process.env.AI_MODEL || '').trim();
  if (!model) model = defaultModelFor(provider);

  return { provider, baseUrl, model, apiKey };
};

const configurationIssue = (cfg = primary()) => {
  const provider = String(cfg.provider || '').toLowerCase();
  const baseUrl = String(cfg.baseUrl || '').toLowerCase();
  if (provider === 'groq' && !/groq\.com/.test(baseUrl)) {
    return 'LLM_PROVIDER=groq requires LLM_BASE_URL=https://api.groq.com/openai/v1.';
  }
  if (isGroqApiKey(cfg.apiKey) && provider !== 'groq') {
    return 'A Groq API key requires LLM_PROVIDER=groq and the Groq OpenAI-compatible LLM_BASE_URL.';
  }
  return '';
};

// Provider-specific key names. A declared fallback provider can reuse the
// conventional key already present in the environment instead of requiring a
// duplicate `LLM_FALLBACK*_API_KEY`. These are the provider's OWN keys — never
// the primary's — so a fallback config can never send a Groq key to OpenAI (or
// vice versa), which would only produce a confusing 401.
const PROVIDER_KEY_ALIASES = {
  groq: ['GROQ_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  ollama: [],
};

const aliasKeyFor = (provider) => {
  for (const name of PROVIDER_KEY_ALIASES[provider] || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

// Known host per provider — used to prove that a base URL really belongs to the
// provider whose conventional key we are about to reuse. An unknown/custom host
// must never receive another provider's key.
const PROVIDER_HOST_RE = {
  groq: /(^|\.)groq\.com/i,
  openai: /(^|\.)openai\.com/i,
  gemini: /generativelanguage\.googleapis\.com/i,
  openrouter: /openrouter\.ai/i,
  deepseek: /deepseek/i,
  together: /together/i,
  ollama: /ollama/i,
};

const hostMatchesProvider = (provider, baseUrl) => {
  const re = PROVIDER_HOST_RE[provider];
  return Boolean(re && re.test(String(baseUrl || '')));
};

/**
 * Builds ONE optional fallback provider config from a variable prefix
 * (`LLM_FALLBACK` or `LLM_FALLBACK2`), or null when that slot is empty.
 *
 * Resolution order:
 *   1. An EXPLICIT provider declaration (`*_PROVIDER`) wins. Its key comes from
 *      `*_API_KEY` or that provider's conventional alias (OPENAI_API_KEY /
 *      GEMINI_API_KEY / GOOGLE_API_KEY / GROQ_API_KEY / …). With no such key the
 *      slot is INCOMPLETE and returns null — the primary key is never sent to a
 *      foreign endpoint.
 *   2. An explicit `*_API_KEY` without `*_PROVIDER`: the provider is inferred
 *      from the key shape or the base URL.
 *   3. Only `*_MODEL` (and/or `*_BASE_URL`) with no provider/key: same-key
 *      model reuse of the PRIMARY provider (e.g. a different Groq model after
 *      the primary model's per-day quota is spent). This is the historical,
 *      documented behaviour and is preserved exactly.
 *
 * Each slot is at most ONE extra attempt — the chain is bounded at 2 slots.
 */
const buildFallback = (prefix) => {
  const cfg = primary();
  const declaredProvider = String(process.env[`${prefix}_PROVIDER`] || '').trim().toLowerCase();
  const explicitKey = resolveApiKey(process.env[`${prefix}_API_KEY`]);
  const declaredBase = normalizeBase(process.env[`${prefix}_BASE_URL`]);
  const declaredModel = String(process.env[`${prefix}_MODEL`] || '').trim();

  // ---- 1. Explicit provider declaration (separate provider) ----
  if (declaredProvider) {
    const provider = resolveProviderId({
      configured: declaredProvider,
      baseUrl: declaredBase,
      hasKey: true,
      apiKey: explicitKey,
    });
    const apiKey = explicitKey || aliasKeyFor(provider);
    if (!apiKey) return null; // incomplete config: never reuse a foreign primary key
    const baseUrl = normalizeBase(declaredBase || defaultBaseFor(provider), provider);
    const model = declaredModel || defaultModelFor(provider);
    return { provider, baseUrl, model, apiKey };
  }

  // ---- 2. Explicit slot key, provider inferred from key/base URL ----
  if (explicitKey) {
    const provider = resolveProviderId({
      configured: '',
      baseUrl: declaredBase,
      hasKey: true,
      apiKey: explicitKey,
    });
    const baseUrl = normalizeBase(declaredBase || defaultBaseFor(provider), provider);
    const model = declaredModel || defaultModelFor(provider);
    return { provider, baseUrl, model, apiKey: explicitKey };
  }

  // ---- 3. Same-key model reuse (no provider, no explicit key) ----
  // A configured *_MODEL and/or *_BASE_URL reuses the PRIMARY key. Covers the
  // real-world case where the primary model's DAILY quota is exhausted but the
  // account key still serves other models (Groq per-model TPD limits). Still
  // exactly one last-resort attempt per slot — never an infinite fallback loop.
  const fallbackBase = normalizeBase(declaredBase, cfg.provider);
  if (!declaredModel && !fallbackBase) return null;
  const baseUrl = fallbackBase || cfg.baseUrl;
  // A *_BASE_URL pointing at a DIFFERENT provider cannot reuse the primary key
  // (that would leak it), but the provider's own conventional key may be used.
  const sameHost = String(baseUrl).toLowerCase() === String(cfg.baseUrl).toLowerCase();
  let apiKey = cfg.apiKey;
  if (!sameHost) {
    const provider = resolveProviderId({
      configured: '',
      baseUrl,
      hasKey: true,
      apiKey: cfg.apiKey,
    });
    // Only reuse that provider's conventional key when the endpoint is provably
    // that provider's own host — otherwise no fallback is configured.
    if (!hostMatchesProvider(provider, baseUrl)) return null;
    apiKey = aliasKeyFor(provider);
    if (!apiKey) return null;
    return {
      provider,
      baseUrl: normalizeBase(baseUrl, provider),
      model: declaredModel || defaultModelFor(provider),
      apiKey,
    };
  }
  return { provider: cfg.provider, baseUrl, model: declaredModel || cfg.model, apiKey };
};

/** Safe per-slot diagnostic: declared vs actually usable, without any secret. */
const fallbackSlotStatus = (prefix) => {
  const declared = Boolean(
    String(process.env[`${prefix}_PROVIDER`] || '').trim() ||
    String(process.env[`${prefix}_API_KEY`] || '').trim() ||
    String(process.env[`${prefix}_BASE_URL`] || '').trim() ||
    String(process.env[`${prefix}_MODEL`] || '').trim()
  );
  const cfg = buildFallback(prefix);
  return {
    declared,
    configured: Boolean(cfg && isConfigured(cfg)),
    provider: cfg ? cfg.provider : '',
    model: cfg ? cfg.model : '',
    baseUrl: cfg ? cfg.baseUrl : '',
    apiKeyConfigured: Boolean(cfg && cfg.apiKey),
  };
};

/** Fallback slot 1 (backwards-compatible with llmService.getFallbackConfig). */
const fallback = () => buildFallback('LLM_FALLBACK');

/** Fallback slot 2 — a second, fully independent configured provider. */
const fallback2 = () => buildFallback('LLM_FALLBACK2');

/**
 * The full fallback CHAIN: every configured, key-bearing fallback slot in
 * order (max 2). Each config is a real provider the app is allowed to call.
 */
const allFallbacks = () => [fallback(), fallback2()].filter((f) => f && isConfigured(f));

const isConfigured = (cfg) => Boolean(cfg && cfg.apiKey) || (cfg && cfg.provider === 'ollama');

const looksLikeGroq = (baseUrl) => /(^|\.)groq\.com/i.test(String(baseUrl || ''));

// Vision-capable model patterns (OpenAI-compatible content-parts image input).
// Conservative allowlist; add only models known to accept image_url parts.
const VISION_MODEL_RE =
  /(gpt-4o|gpt-4\.1|gpt-4-vision|vision|llama-3\.2-1[01]b-vision|llama-4\b|qwen.*-vl|pixtral|moondream|gemini|gpt-oss-20b|gpt-oss-120b)/i;

// Groq's hosted models that actually accept OpenAI-style image_url parts
// (verified live against the account's model list + real requests):
//   - qwen/qwen3.8-27b      ACCEPTS images (real 200 + grounded answer; rejected a
//                           1x1 PNG only because Groq requires >=32px per side)
//   - openai/gpt-oss-120b    TEXT-ONLY on Groq (live 400 "messages[0].content
//     / gpt-oss-20b          must be a string" when content parts are sent)
//   - llama-3.2-11b-vision-preview  DECOMMISSIONED on Groq (400 model_decommissioned)
// The generic visionary patterns below (llama-3.2-1[01]b-vision, llama-4, pixtral,
// moondream, gemini) stay valid for NON-Groq OpenAI-compatible providers.
const GROQ_VISION_MODEL_RE =
  /(qwen.*|llama-4\b|pixtral|moondream|gemini)/i;

/**
 * True when a SPECIFIC model accepts OpenAI-style image_url content parts on the
 * CURRENT provider (Groq's hosted list is verified live; other OpenAI-compatible
 * providers use the conservative generic allowlist).
 */
const supportsVisionModel = (model) => {
  const m = String(model || '').trim();
  if (!m) return false;
  const cfg = primary();
  if (cfg.provider === 'groq' || looksLikeGroq(cfg.baseUrl)) return GROQ_VISION_MODEL_RE.test(m);
  return VISION_MODEL_RE.test(m);
};

/**
 * Is vision enabled for the app? Requires LLM_VISION=1 AND at least one reachable
 * vision-capable model — either the PRIMARY model itself, or the dedicated
 * LLM_VISION_MODEL override used for image requests (e.g. gpt-oss-20b primary for
 * text + qwen/qwen3.8-27b vision override). Never true otherwise — a chat with an
 * attached image then honestly tells the user vision is off.
 */
const isVisionEnabled = () => {
  const flag = String(process.env.LLM_VISION || '').trim();
  if (flag !== '1' && flag.toLowerCase() !== 'true') return false;
  const cfg = primary();
  if (supportsVisionModel(cfg.model)) return true;
  return supportsVisionModel(process.env.LLM_VISION_MODEL || '');
};

/** Cap for stored base64 image data (bytes of the RAW image, before base64). */
const visionMaxImageBytes = () =>
  Number(process.env.LLM_VISION_MAX_IMAGE_BYTES || 1_500_000);

/** Safe diagnostics (keys stripped by construction). */
const describe = () => {
  const p = primary();
  const f = fallback();
  const f2 = fallback2();
  const slot1 = fallbackSlotStatus('LLM_FALLBACK');
  const slot2 = fallbackSlotStatus('LLM_FALLBACK2');
  return {
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeyConfigured: Boolean(p.apiKey),
    configured: isConfigured(p),
    fallback: f
      ? { provider: f.provider, baseUrl: f.baseUrl, model: f.model, apiKeyConfigured: Boolean(f.apiKey) }
      : null,
    fallback2: f2
      ? { provider: f2.provider, baseUrl: f2.baseUrl, model: f2.model, apiKeyConfigured: Boolean(f2.apiKey) }
      : null,
    fallback1Declared: slot1.declared,
    fallback1Configured: slot1.configured,
    fallback2Declared: slot2.declared,
    fallback2Configured: slot2.configured,
    fallbackChain: allFallbacks().map((x) => ({ provider: x.provider, model: x.model })),
    vision: isVisionEnabled(),
  };
};

module.exports = {
  primary,
  configurationIssue,
  fallback,
  fallback2,
  allFallbacks,
  isConfigured,
  looksLikeGroq,
  isVisionEnabled,
  supportsVisionModel,
  visionMaxImageBytes,
  describe,
  defaults: { GROQ_BASE_URL, OPENAI_BASE_URL, GEMINI_BASE_URL, GROQ_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL },
};