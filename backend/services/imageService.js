// Secure, configurable IMAGE GENERATION provider layer.
//
// Images are NEVER generated in the frontend. The browser only ever sends a
// prompt to this backend service; the provider API key stays here, is never
// logged and never reaches a client.
//
// Configuration (backend/.env) — no key is hard-coded anywhere:
//   IMAGE_PROVIDER   pollinations | openai | gemini   (default: pollinations)
//   IMAGE_API_KEY    provider key (pollinations works key-less)
//   IMAGE_MODEL      provider model id (defaults per provider, overridable)
//   IMAGE_BASE_URL   optional base URL override
//   IMAGE_SIZE       square size in px for text-to-image (default 1024)
//   IMAGE_TIMEOUT_MS per-attempt timeout (default 90000 — images are slow)
//   IMAGE_MAX_RETRIES transient-failure retries (default 2)
//   IMAGE_MAX_BYTES  hard cap on the returned image bytes
//   IMAGE_PROMPT_SUFFIX quality suffix appended to the prompt ("" disables)
//
// Providers, all official image-generation APIs:
//   pollinations -> GET {base}/prompt/{prompt}?width&height&nologo&model
//                   (optionally authorised with IMAGE_API_KEY; supports image
//                   prompting, not image-to-image)
//   openai       -> POST {base}/images/generations  (gpt-image-1 / dall-e-3)
//                   and POST {base}/images/edits for image-to-image
//   gemini       -> POST {base}/models/{model}:generateContent with
//                   responseModalities ["TEXT","IMAGE"] (nano-banana style),
//                   accepts a reference image for image-to-image
//
// Safety: the provider's own safety filters are used and never bypassed. When a
// provider refuses a prompt we return a clean, specific error
// (IMAGE_SAFETY_BLOCKED) instead of pretending an image was produced.

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1200, 2500, 4000];
const MAX_BACKOFF_MS = 20000;
// Key-less providers (Pollinations) run on a shared anonymous pool that answers
// HTTP 402 "Insufficient balance" whenever that pool is momentarily busy. That is
// a throttle, not a broken configuration, so it is retried with a short backoff
// (~10s total) and then reported honestly. The chat error bubble offers Retry,
// which is a better experience than making the user stare at a spinner for a
// minute.
const THROTTLE_BACKOFF_MS = [3000, 7000];
const THROTTLE_STATUS = new Set([402, 429]);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_PROMPT_CHARS = 1500;

const PROVIDER_DEFAULTS = {
  pollinations: {
    baseUrl: 'https://image.pollinations.ai',
    model: 'flux',
    needsKey: false,
    supportsEdit: false,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    needsKey: true,
    supportsEdit: true,
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-image',
    needsKey: true,
    supportsEdit: true,
  },
  // TEST DOUBLE — never the default. Renders a real PNG in-process so the whole
  // pipeline (intent -> prompt -> generate -> store -> auth -> follow-up ->
  // regenerate) can be asserted deterministically offline / in CI. It is NOT an
  // AI image model and its output is tagged provider="selftest" so it can never
  // be mistaken for a real generation. Production keeps pollinations.
  selftest: {
    baseUrl: 'in-process',
    model: 'selftest-png',
    needsKey: false,
    supportsEdit: true,
  },
};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFAULTS);

const scrubSecret = (text) =>
  String(text || '')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, '[bearer-redacted]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key-redacted]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeBase = (url) => String(url || '').trim().replace(/\/+$/, '');

const resolveProviderId = () => {
  const explicit = String(process.env.IMAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit && PROVIDER_DEFAULTS[explicit]) return explicit;
  if (explicit) return explicit; // unknown -> reported honestly by getConfig()
  const base = normalizeBase(process.env.IMAGE_BASE_URL);
  if (/openai\.com/i.test(base)) return 'openai';
  if (/googleapis\.com/i.test(base)) return 'gemini';
  if (/pollinations/i.test(base)) return 'pollinations';
  return 'pollinations';
};

/** Canonical image-provider config (shape mirrors providers.js for the LLM). */
const getConfig = () => {
  const provider = resolveProviderId();
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.pollinations;
  const apiKey = String(process.env.IMAGE_API_KEY || '').trim();
  const baseUrl = normalizeBase(process.env.IMAGE_BASE_URL) || defaults.baseUrl;
  const model = String(process.env.IMAGE_MODEL || '').trim() || defaults.model;
  const size = Math.min(1536, Math.max(256, Number(process.env.IMAGE_SIZE) || 1024));
  const timeoutMs = Math.max(5000, Number(process.env.IMAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const maxRetries = Math.min(4, Math.max(0, Number(process.env.IMAGE_MAX_RETRIES ?? DEFAULT_MAX_RETRIES)));
  const maxBytes = Math.max(1024, Number(process.env.IMAGE_MAX_BYTES) || DEFAULT_MAX_BYTES);
  const promptSuffix = process.env.IMAGE_PROMPT_SUFFIX === undefined
    ? 'high quality, highly detailed'
    : String(process.env.IMAGE_PROMPT_SUFFIX).trim();
  return {
    provider,
    baseUrl,
    model,
    apiKey,
    size,
    timeoutMs,
    maxRetries,
    maxBytes,
    promptSuffix,
    needsKey: defaults.needsKey,
    supportsEdit: defaults.supportsEdit,
    known: Boolean(PROVIDER_DEFAULTS[provider]),
  };
};

/** True when image generation can actually run right now. */
const isConfigured = () => {
  const c = getConfig();
  if (!c.known) return false;
  if (!c.needsKey) return true; // pollinations needs no key
  return Boolean(c.apiKey);
};

/** 'configured' | 'not-configured' | 'misconfigured' — for /api/health. */
const status = () => {
  const c = getConfig();
  if (!c.known) return 'misconfigured';
  return isConfigured() ? 'configured' : 'not-configured';
};

/** Safe diagnostics (never includes the key). */
const describe = () => {
  const c = getConfig();
  return {
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    apiKeyConfigured: Boolean(c.apiKey),
    configured: isConfigured(),
    supportsEdit: c.supportsEdit,
    size: c.size,
  };
};

const imageError = (message, statusCode, code, detail) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  err.code = code;
  if (detail) err.detail = scrubSecret(detail).slice(0, 500);
  return err;
};

const isImageMime = (mime) => /^image\/(png|jpeg|jpg|webp|gif|bmp)/i.test(String(mime || ''));

/** Provider safety refusals -> one honest, safe user-facing message. */
const SAFETY_RE = /(safety|safe[_ ]?prompt|blocked|content[_ ]?policy|prohibited|nsfw|nsfw_filter|responsible ai|violat)/i;

const safetyError = (detail) =>
  imageError(
    "That image request was blocked by the image provider's safety policy. Please rephrase it (avoid real people, trademarks, gore or explicit content) and try again.",
    422,
    'IMAGE_SAFETY_BLOCKED',
    detail
  );

const notConfiguredError = () =>
  imageError(
    'Image generation is not configured on the server. Set IMAGE_PROVIDER and IMAGE_API_KEY in backend/.env, then restart the backend.',
    503,
    'IMAGE_NOT_CONFIGURED',
    `provider=${getConfig().provider}`
  );

/**
 * Builds the prompt actually sent to the image provider.
 * The user's own words are preserved; only the redundant generation wrapper
 * ("create an image of ...") is removed so the model gets a clean subject.
 * A conversational follow-up is merged onto the previous image's prompt
 * ("make it at night" -> "<previous prompt>, at night").
 */
const buildPrompt = ({ text, previousPrompt = '', isFollowUp = false, suffix } = {}) => {
  const { stripGenerationWrapper, buildFollowUpModification } = require('./imageIntent');
  const cfg = getConfig();
  const tail = suffix === undefined ? cfg.promptSuffix : String(suffix || '');
  let prompt;
  if (isFollowUp && previousPrompt) {
    const modification = buildFollowUpModification(text);
    prompt = modification
      ? `${String(previousPrompt).replace(/[.,;]+$/, '')}, ${modification}`
      : String(previousPrompt);
  } else {
    prompt = stripGenerationWrapper(text) || String(text || '').trim();
  }
  prompt = prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS);
  // Never append the quality suffix twice (a follow-up prompt already has it).
  if (tail && prompt && !prompt.toLowerCase().endsWith(tail.toLowerCase())) {
    prompt = `${prompt}, ${tail}`;
  }
  return prompt;
};

/**
 * Returns the user-facing subject prompt (no quality suffix). Stored alongside
 * the effective prompt so a follow-up ("make it at night") can be merged onto
 * the original request instead of onto the already-suffixed prompt.
 */
const basePromptFor = ({ text, previousPrompt = '', isFollowUp = false }) => {
  const { stripGenerationWrapper, buildFollowUpModification } = require('./imageIntent');
  if (isFollowUp && previousPrompt) {
    const modification = buildFollowUpModification(text);
    return modification
      ? `${String(previousPrompt).replace(/[.,;]+$/, '')}, ${modification}`
      : String(previousPrompt);
  }
  return (stripGenerationWrapper(text) || String(text || '').trim()).replace(/\s+/g, ' ').trim();
};

// ---------------------------------------------------------------------------
// Provider calls. Each returns { buffer, mimeType, revisedPrompt }
// ---------------------------------------------------------------------------

const callPollinations = async ({ cfg, prompt, size }) => {
  const url = new URL(`${cfg.baseUrl}/prompt/${encodeURIComponent(prompt)}`);
  url.searchParams.set('width', String(size));
  url.searchParams.set('height', String(size));
  url.searchParams.set('nologo', 'true');
  if (cfg.model) url.searchParams.set('model', cfg.model);
  if (cfg.apiKey) url.searchParams.set('key', cfg.apiKey);

  const headers = { Accept: 'image/*' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(url.toString(), { method: 'GET', headers });
  const mime = String(resp.headers?.get?.('content-type') || '').split(';')[0];
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (SAFETY_RE.test(body)) throw safetyError(`pollinations HTTP ${resp.status} ${body.slice(0, 300)}`);
    if (THROTTLE_STATUS.has(resp.status)) {
      throw imageError(
        'The image provider is busy right now. Please try again in a few seconds.',
        503,
        'IMAGE_RATE_LIMITED',
        `pollinations HTTP ${resp.status} ${body.slice(0, 200)}`
      );
    }
    throw imageError('Image generation is temporarily unavailable. Please try again.', 502, 'IMAGE_PROVIDER_ERROR', `pollinations HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
  if (!isImageMime(mime)) {
    const body = await resp.text().catch(() => '');
    throw imageError('The image provider returned an unexpected response. Please try again.', 502, 'IMAGE_BAD_RESPONSE', `pollinations content-type=${mime} ${body.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, mimeType: mime, revisedPrompt: '' };
};

const callOpenAI = async ({ cfg, prompt, size, referenceImage }) => {
  const openaiSize = ['256', '512', '1024', '1536'].includes(String(size)) ? String(size) : '1024';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
  let resp;

  if (referenceImage && cfg.supportsEdit) {
    // Image-to-image: /images/edits (multipart) keeps the real uploaded pixels.
    const form = new FormData();
    form.append('model', cfg.model);
    form.append('prompt', prompt);
    form.append('size', openaiSize);
    form.append('n', '1');
    const [meta, b64] = String(referenceImage.dataUrl).split(',');
    const mime = /^data:([^;]+);/.test(meta) ? meta.match(/^data:([^;]+);/)[1] : 'image/png';
    form.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime }), 'reference.png');
    resp = await fetch(`${cfg.baseUrl}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
  } else {
    resp = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, prompt, n: 1, size: openaiSize, response_format: 'b64_json' }),
    });
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 400 && SAFETY_RE.test(body)) throw safetyError(`openai HTTP 400 ${body.slice(0, 300)}`);
    if (resp.status === 401 || resp.status === 403) {
      throw imageError('The image provider rejected the API key. Check IMAGE_API_KEY in backend/.env.', 502, 'IMAGE_AUTH', `openai HTTP ${resp.status}`);
    }
    if (resp.status === 429) {
      throw imageError('Image generation is temporarily busy. Please try again shortly.', 502, 'IMAGE_RATE_LIMITED', 'openai HTTP 429');
    }
    throw imageError('Image generation failed. Please try again.', 502, 'IMAGE_PROVIDER_ERROR', `openai HTTP ${resp.status} ${body.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  const item = data?.data?.[0];
  if (item?.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png', revisedPrompt: item.revised_prompt || '' };
  }
  if (item?.url) {
    const imgResp = await fetch(item.url);
    if (!imgResp.ok) throw imageError('The generated image could not be downloaded. Please try again.', 502, 'IMAGE_BAD_RESPONSE', `openai image url HTTP ${imgResp.status}`);
    return {
      buffer: Buffer.from(await imgResp.arrayBuffer()),
      mimeType: String(imgResp.headers?.get?.('content-type') || 'image/png').split(';')[0],
      revisedPrompt: item.revised_prompt || '',
    };
  }
  throw imageError('The image provider returned no image. Please try again.', 502, 'IMAGE_BAD_RESPONSE', 'openai response had no data[0]');
};

const callGemini = async ({ cfg, prompt, referenceImage }) => {
  const parts = [];
  if (referenceImage && cfg.supportsEdit) {
    const [meta, b64] = String(referenceImage.dataUrl).split(',');
    const mime = /^data:([^;]+);/.test(meta) ? meta.match(/^data:([^;]+);/)[1] : 'image/png';
    parts.push({ inlineData: { mimeType: mime, data: b64 } });
  }
  parts.push({ text: prompt });

  const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (SAFETY_RE.test(body)) throw safetyError(`gemini HTTP ${resp.status} ${body.slice(0, 300)}`);
    if (resp.status === 401 || resp.status === 403) {
      throw imageError('The image provider rejected the API key. Check IMAGE_API_KEY in backend/.env.', 502, 'IMAGE_AUTH', `gemini HTTP ${resp.status}`);
    }
    if (resp.status === 429) {
      throw imageError('Image generation is temporarily busy. Please try again shortly.', 502, 'IMAGE_RATE_LIMITED', 'gemini HTTP 429');
    }
    throw imageError('Image generation failed. Please try again.', 502, 'IMAGE_PROVIDER_ERROR', `gemini HTTP ${resp.status} ${body.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    const contentParts = candidate?.content?.parts || [];
    for (const part of contentParts) {
      if (part?.inlineData?.data) {
        return {
          buffer: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
          revisedPrompt: '',
        };
      }
    }
  }
  const refusal = JSON.stringify(candidates).slice(0, 400);
  if (SAFETY_RE.test(refusal)) throw safetyError(`gemini refusal ${refusal}`);
  throw imageError('The image provider returned no image. Please try again.', 502, 'IMAGE_BAD_RESPONSE', 'gemini response had no inlineData image part');
};

/**
 * Reads the real pixel dimensions out of image bytes (PNG / JPEG / GIF / WebP).
 * Used so the UI can keep the image's proportions instead of squashing it.
 * Returns { width: 0, height: 0 } when the format is not recognised — the UI
 * then simply falls back to a neutral box, never to a wrong aspect ratio.
 */
const imageDimensions = (buffer) => {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length < 16) return { width: 0, height: 0 };

  // PNG: 8-byte signature then an IHDR chunk with width/height at 16/20.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }

  // GIF: logical screen descriptor.
  if (b.slice(0, 3).toString('ascii') === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }

  // WebP: VP8 / VP8L / VP8X chunk headers.
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    const fourcc = b.slice(12, 16).toString('ascii');
    if (fourcc === 'VP8 ' && b.length > 30) {
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L' && b.length > 25) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X' && b.length > 30) {
      return {
        width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
        height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
      };
    }
  }

  // JPEG: walk the marker segments until a start-of-frame carries the size.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      // SOF0..SOF15, skipping DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }

  return { width: 0, height: 0 };
};

/**
 * TEST DOUBLE provider. Encodes a real, valid PNG in-process (no network, no
 * AI) whose pixels are derived from the prompt, so the full pipeline can be
 * asserted end to end offline. It is never reachable unless IMAGE_PROVIDER is
 * explicitly set to "selftest".
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

/** Minimal, dependency-free RGB PNG encoder. */
const encodePng = (width, height, pixelAt) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0; // filter: none
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      raw[o] = r & 0xff;
      raw[o + 1] = g & 0xff;
      raw[o + 2] = b & 0xff;
      o += 3;
    }
  }
  const zlib = require('zlib');
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const promptHash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

const callSelfTest = async ({ cfg, prompt, size, referenceImage }) => {
  const dim = Math.min(512, Math.max(64, Number(size) || 256));
  const seed = promptHash(prompt);
  const baseR = seed % 200;
  const baseG = (seed >> 8) % 200;
  const baseB = (seed >> 16) % 200;
  const refSeed = referenceImage ? promptHash(String(referenceImage).slice(0, 64)) : 0;
  const buffer = encodePng(dim, dim, (x, y) => {
    const t = (x + y) / (dim * 2);
    return [
      (baseR + t * 40 + (refSeed % 20)) & 0xff,
      (baseG + (1 - t) * 40) & 0xff,
      (baseB + ((x ^ y) % 30)) & 0xff,
    ];
  });
  return { buffer, mimeType: 'image/png', revisedPrompt: '' };
};

const callProvider = async ({ cfg, prompt, size, referenceImage }) => {
  switch (cfg.provider) {
    case 'openai':
      return callOpenAI({ cfg, prompt, size, referenceImage });
    case 'gemini':
      return callGemini({ cfg, prompt, referenceImage });
    case 'selftest':
      return callSelfTest({ cfg, prompt, size, referenceImage });
    case 'pollinations':
    default:
      return callPollinations({ cfg, prompt, size });
  }
};

// Provider errors that are worth one more attempt (capacity spikes / rate
// limits / 5xx / network). Auth, config and safety errors are NEVER retried.
const TRANSIENT_CODES = new Set([
  'IMAGE_PROVIDER_ERROR',
  'IMAGE_RATE_LIMITED',
  'IMAGE_BAD_RESPONSE',
  'IMAGE_UNREACHABLE',
]);

/**
 * The subject of the request without the quality suffix. Used as the merge base
 * for a later follow-up, so it must never come back empty (an empty base would
 * make "make it at night" produce a prompt with no subject at all).
 */
const resolveBasePrompt = ({ text, previousPrompt = '', isFollowUp = false, finalPrompt = '' }) => {
  const derived = basePromptFor({ text, previousPrompt, isFollowUp });
  if (derived) return derived;
  if (isFollowUp && previousPrompt) return String(previousPrompt);
  const cfg = getConfig();
  const suffix = cfg.promptSuffix ? `, ${cfg.promptSuffix}` : '';
  const stripped = suffix && String(finalPrompt).endsWith(suffix)
    ? String(finalPrompt).slice(0, -suffix.length)
    : String(finalPrompt || '');
  return stripped.replace(/[.,;]+$/, '').trim();
};

/**
 * Generates one image.
 * @param {{ prompt:string, previousPrompt?:string, isFollowUp?:boolean,
 *           text?:string, size?:number, referenceImage?:{dataUrl:string}, requestId?:string }} input
 * @returns {Promise<{buffer:Buffer, mimeType:string, width:number, height:number,
 *                    provider:string, model:string, prompt:string, basePrompt:string,
 *                    revisedPrompt:string, attempts:number, durationMs:number}>}
 */
const generate = async ({ prompt, text, previousPrompt = '', isFollowUp = false, size, referenceImage = null, requestId = '' }) => {
  const cfg = getConfig();
  if (!cfg.known) {
    throw imageError(
      `Unknown IMAGE_PROVIDER "${cfg.provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      503,
      'IMAGE_PROVIDER_UNSUPPORTED',
      `provider=${cfg.provider}`
    );
  }
  if (!isConfigured()) throw notConfiguredError();

  const finalPrompt = String(prompt || '').trim() || buildPrompt({ text, previousPrompt, isFollowUp });
  if (!finalPrompt) throw imageError('Describe the image you want to create.', 400, 'IMAGE_EMPTY_PROMPT', 'empty image prompt');

  // Image-to-image is only attempted on providers that really accept a
  // reference image; otherwise the request is honestly refused instead of
  // silently generating an unrelated picture.
  let reference = referenceImage;
  if (reference && !cfg.supportsEdit) {
    reference = null;
    if (process.env.IMAGE_EDIT_FALLBACK_TEXT !== '1') {
      throw imageError(
        'The configured image provider cannot edit an uploaded image. Describe the change in words instead (for example "a picture of a futuristic city at night").',
        422,
        'IMAGE_EDIT_UNSUPPORTED',
        `provider=${cfg.provider} supportsEdit=false`
      );
    }
  }

  const startedAt = Date.now();
  const reqSize = Math.min(1536, Math.max(256, Number(size) || cfg.size));
  let lastErr = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const result = await callProvider({ cfg, prompt: finalPrompt, size: reqSize, referenceImage: reference });
      clearTimeout(timer);

      if (!result.buffer || !result.buffer.length) {
        throw imageError('The image provider returned an empty image. Please try again.', 502, 'IMAGE_BAD_RESPONSE', `${cfg.provider} returned 0 bytes`);
      }
      if (result.buffer.length > cfg.maxBytes) {
        throw imageError('The generated image was too large to store. Please try again with a smaller size.', 502, 'IMAGE_TOO_LARGE', `${cfg.provider} ${result.buffer.length} bytes > ${cfg.maxBytes}`);
      }

      console.log(
        `[IMAGE] request=${requestId || '-'} provider=${cfg.provider} model=${cfg.model} bytes=${result.buffer.length} attempts=${attempt + 1} duration=${((Date.now() - startedAt) / 1000).toFixed(1)}s`
      );

      return {
        buffer: result.buffer,
        mimeType: isImageMime(result.mimeType) ? result.mimeType : 'image/png',
        width: imageDimensions(result.buffer).width,
        height: imageDimensions(result.buffer).height,
        provider: cfg.provider,
        model: cfg.model,
        prompt: finalPrompt,
        basePrompt: resolveBasePrompt({ text, previousPrompt, isFollowUp, finalPrompt }),
        revisedPrompt: result.revisedPrompt || '',
        attempts: attempt + 1,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        lastErr = imageError(
          'Image generation timed out. Please try again.',
          504,
          'IMAGE_UNREACHABLE',
          `${cfg.provider} timed out after ${Math.round(cfg.timeoutMs / 1000)}s`
        );
      } else if (err instanceof TypeError || /fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(String(err?.message || ''))) {
        lastErr = imageError(
          'Image generation is temporarily unavailable. Please try again.',
          502,
          'IMAGE_UNREACHABLE',
          `${cfg.provider} network error: ${err.message}`
        );
      } else {
        lastErr = err;
      }

      const transient = lastErr && TRANSIENT_CODES.has(lastErr.code);
      if (!transient || attempt >= cfg.maxRetries) {
        console.error(`[IMAGE ERROR] request=${requestId || '-'} provider=${cfg.provider} model=${cfg.model} code=${lastErr?.code || 'UNKNOWN'} ${scrubSecret(lastErr?.detail || lastErr?.message || '')}`);
        throw lastErr;
      }
      const delay =
        lastErr.code === 'IMAGE_RATE_LIMITED'
          ? Math.min(THROTTLE_BACKOFF_MS[attempt] ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS)
          : Math.min(RETRY_DELAYS_MS[attempt] ?? 3000, MAX_BACKOFF_MS);
      await sleep(delay);
    }
  }

  throw lastErr || imageError('Image generation failed. Please try again.', 502, 'IMAGE_PROVIDER_ERROR', 'no attempt succeeded');
};

module.exports = {
  generate,
  buildPrompt,
  basePromptFor,
  imageDimensions,
  isConfigured,
  status,
  describe,
  getConfig,
  SUPPORTED_PROVIDERS,
  MAX_PROMPT_CHARS,
};