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

const GROQ_DEFAULT_MODEL = 'qwen/qwen3.8-27b'; // fast, cheap AND vision-capable on Groq (verified live). Set LLM_MODEL=openai/gpt-oss-120b explicitly to opt back into the slower text-only reasoning flagship.
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

const normalizeBase = (url) => String(url || '').trim().replace(/\/+$/, '');

/** Provider id inferred from env (explicit wins; then base URL; then generic). */
const resolveProviderId = ({ configured, baseUrl, hasKey }) => {
  const c = String(configured || '').trim().toLowerCase();
  if (c) return c;
  if (/(^|\.)groq\.com/i.test(baseUrl)) return 'groq';
  if (/openrouter\.ai/i.test(baseUrl)) return 'openrouter';
  if (/deepseek/i.test(baseUrl)) return 'deepseek';
  if (/together/i.test(baseUrl)) return 'together';
  if (/ollama/i.test(baseUrl)) return 'ollama';
  if (/openai\.com/i.test(baseUrl)) return 'openai';
  return hasKey ? 'openai' : 'openai';
};

const resolveApiKey = (...candidates) => {
  for (const key of candidates) {
    if (String(key || '').trim()) return String(key).trim();
  }
  return '';
};

const defaultModelFor = (provider) =>
  provider === 'groq' ? GROQ_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;

const defaultBaseFor = (provider) =>
  provider === 'groq' ? GROQ_BASE_URL : OPENAI_BASE_URL;

/** Builds the PRIMARY provider config (backwards-compatible with llmService.getConfig). */
const primary = () => {
  const configuredProvider = String(process.env.LLM_PROVIDER || process.env.AI_PROVIDER || '').trim().toLowerCase();
  const apiKey = resolveApiKey(
    process.env.LLM_API_KEY,
    process.env.AI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.OPENAI_API_KEY
  );
  let baseUrl = normalizeBase(process.env.LLM_BASE_URL || process.env.AI_BASE_URL);
  const provider = resolveProviderId({ configured: configuredProvider, baseUrl, hasKey: Boolean(apiKey) });
  if (!baseUrl) baseUrl = defaultBaseFor(provider);

  let model = String(process.env.LLM_MODEL || process.env.AI_MODEL || '').trim();
  if (!model) model = defaultModelFor(provider);

  return { provider, baseUrl, model, apiKey };
};

/**
 * Builds ONE optional fallback provider config from a variable prefix
 * (`LLM_FALLBACK` or `LLM_FALLBACK2`), or null when that slot is empty.
 * A declared provider WITHOUT its own key is an incomplete config — null (the
 * primary key is never sent to a foreign endpoint). Same-key model reuse is
 * allowed only when NO provider is declared (LLM_FALLBACK[2]_MODEL alone).
 */
const buildFallback = (prefix) => {
  const cfg = primary();
  const apiKey = resolveApiKey(process.env[`${prefix}_API_KEY`]);

  if (apiKey) {
    // Explicit fallback with its own key (fully separate provider).
    const configuredProvider = String(process.env[`${prefix}_PROVIDER`] || '').trim().toLowerCase();
    let baseUrl = normalizeBase(process.env[`${prefix}_BASE_URL`]);
    const provider = resolveProviderId({ configured: configuredProvider, baseUrl, hasKey: true });
    if (!baseUrl) baseUrl = defaultBaseFor(provider);
    let model = String(process.env[`${prefix}_MODEL`] || '').trim();
    if (!model) model = defaultModelFor(provider);
    return { provider, baseUrl, model, apiKey };
  }

  // A declared fallback PROVIDER without its OWN key is an incomplete
  // separate-provider config. The primary key must NEVER be sent to a foreign
  // endpoint (that would leak the Groq key to another provider and fail with a
  // confusing 401), so an explicit provider declaration requires the explicit
  // key — without it, no fallback is configured at all (a clean message then
  // surfaces instead of a cross-provider credential leak).
  if (String(process.env[`${prefix}_PROVIDER`] || '').trim()) return null;

  // Same-key fallback: a configured *_MODEL (and optionally *_BASE_URL) reuses
  // the PRIMARY key. Covers the real-world case where the primary model's DAILY
  // quota is exhausted but the account key still serves other models (Groq
  // per-model TPD limits). Still exactly one last-resort attempt per slot,
  // logged and honest — never an infinite fallback loop.
  const model = String(process.env[`${prefix}_MODEL`] || '').trim();
  const fallbackBase = normalizeBase(process.env[`${prefix}_BASE_URL`]);
  const baseUrl = fallbackBase || cfg.baseUrl;
  if (!model && !fallbackBase) return null;
  return { provider: cfg.provider, baseUrl, model: model || cfg.model, apiKey: cfg.apiKey };
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
    fallbackChain: allFallbacks().map((x) => ({ provider: x.provider, model: x.model })),
    vision: isVisionEnabled(),
  };
};

module.exports = {
  primary,
  fallback,
  fallback2,
  allFallbacks,
  isConfigured,
  looksLikeGroq,
  isVisionEnabled,
  supportsVisionModel,
  visionMaxImageBytes,
  describe,
  defaults: { GROQ_BASE_URL, OPENAI_BASE_URL, GROQ_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL },
};