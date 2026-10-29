// Voice layer for the career assistant: speech-to-text (Groq Whisper) and
// optional text-to-speech (Groq TTS). Built on the SAME credentials as the LLM
// config (LLM_API_KEY chain + LLM_BASE_URL), so no extra secrets are needed.
//
// Speech-to-text:
//   model  = LLM_STT_MODEL  (default: whisper-large-v3-turbo, the currently
//            supported Groq transcription model)
//   POST {baseUrl}/audio/transcriptions  (multipart: file + model)
//   Returns the transcript only — never the raw audio, never the key.
//
// Text-to-speech:
//   model = LLM_TTS_MODEL (set one to enable, e.g. playai-tts on Groq)
//   voice = LLM_TTS_VOICE (optional)
//   POST {baseUrl}/audio/speech  -> mp3 bytes
// When no TTS model is configured this module reports { available: false } and
// the FRONTEND falls back to the browser speechSynthesis API — the user always
// gets audio, honestly, with zero fake audio ever produced.
//
// Security: the API key never leaves this module, is never logged, and never
// reaches the client. All failures surface as clean client-safe errors.

const llmService = require('./llmService');

const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 30000);

const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
const MAX_SPEECH_CHARS = 4000;

const getConfig = () => ({
  baseUrl: llmService.getConfig().baseUrl,
  apiKey: llmService.getConfig().apiKey,
  sttModel: String(process.env.LLM_STT_MODEL || '').trim() || DEFAULT_STT_MODEL,
  ttsModel: String(process.env.LLM_TTS_MODEL || '').trim(),
  ttsVoice: String(process.env.LLM_TTS_VOICE || '').trim() || 'Sonia',
});

const isSttConfigured = () => Boolean(getConfig().apiKey);
const isTtsConfigured = () => {
  const c = getConfig();
  return Boolean(c.apiKey && c.ttsModel);
};

const cleanError = (message, statusCode, code, detail) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  err.code = code;
  if (detail) err.detail = detail; // server logs only; never contains the key
  return err;
};

/**
 * Transcribes an audio buffer with the configured Groq model.
 * @param {{ buffer: Buffer, filename?: string, mimeType?: string, language?: string }} input
 * @returns {Promise<{ transcript: string, model: string }>}
 */
const transcribe = async ({ buffer, filename = 'voice.webm', mimeType = 'audio/webm', language = '' }) => {
  const c = getConfig();
  if (!isSttConfigured()) {
    throw cleanError(
      'Speech-to-text is not configured. Set LLM_API_KEY in backend/.env.',
      503,
      'AI_STT_NOT_CONFIGURED',
      'no LLM_API_KEY configured for transcription'
    );
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', c.sttModel);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(`${c.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}` }, // Content-Type set by FormData
      signal: controller.signal,
      body: form,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === 'AbortError';
    throw cleanError(
      'Speech-to-text is temporarily unavailable. Please try again.',
      502,
      'AI_STT_UNAVAILABLE',
      `STT ${timedOut ? `timed out after ${Math.round(STT_TIMEOUT_MS / 1000)}s` : `network error: ${err.message}`}`
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw cleanError('Speech-to-text rejected the API key. Check LLM_API_KEY.', 502, 'AI_STT_AUTH', `STT HTTP ${resp.status}`);
    }
    if (resp.status === 429) {
      throw cleanError('The AI is temporarily busy. Please try again shortly.', 502, 'AI_RATE_LIMITED', `STT HTTP 429 rate limited`);
    }
    if (resp.status === 404 && /model/i.test(bodyText)) {
      throw cleanError(`The transcription model "${c.sttModel}" is not available. Check LLM_STT_MODEL.`, 502, 'AI_STT_MODEL_UNAVAILABLE', `STT HTTP 404 model=${c.sttModel}`);
    }
    throw cleanError('Speech-to-text failed to transcribe the audio. Please try again.', 502, 'AI_STT_FAILED', `STT HTTP ${resp.status} ${bodyText.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  const transcript = String((data && data.text) || '').trim();
  if (!transcript) {
    throw cleanError("I couldn't understand the audio. Please try again.", 422, 'AI_STT_EMPTY', 'STT returned an empty transcript');
  }
  return { transcript, model: c.sttModel };
};

/**
 * Converts text to speech bytes via the configured provider.
 * @param {{ text: string }} input
 * @returns {Promise<{ audio: Buffer, contentType: string }>}
 */
const speak = async ({ text }) => {
  const c = getConfig();
  const clean = String(text || '').trim();
  if (!clean) throw cleanError('Text is required for speech.', 400, 'AI_TTS_EMPTY', 'empty TTS input');
  if (clean.length > MAX_SPEECH_CHARS) {
    throw cleanError('The answer is too long to speak. Try a shorter question.', 400, 'AI_TTS_TOO_LONG', `TTS input ${clean.length} chars > ${MAX_SPEECH_CHARS}`);
  }
  if (!isTtsConfigured()) {
    throw cleanError('Text-to-speech is not configured. Set LLM_TTS_MODEL in backend/.env.', 503, 'AI_TTS_NOT_CONFIGURED', 'no LLM_TTS_MODEL configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${c.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: c.ttsModel,
        input: clean,
        voice: c.ttsVoice,
        response_format: 'mp3',
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw cleanError('Text-to-speech is temporarily unavailable. Please try again.', 502, 'AI_TTS_UNAVAILABLE', `TTS ${err.name === 'AbortError' ? 'timed out' : `network error: ${err.message}`}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw cleanError('Text-to-speech rejected the API key. Check LLM_API_KEY.', 502, 'AI_TTS_AUTH', `TTS HTTP ${resp.status}`);
    }
    if (resp.status === 404) {
      throw cleanError(`The TTS model "${c.ttsModel}" is not available. Check LLM_TTS_MODEL.`, 502, 'AI_TTS_MODEL_UNAVAILABLE', `TTS HTTP 404 model=${c.ttsModel}`);
    }
    throw cleanError('Text-to-speech failed to generate audio. Please try again.', 502, 'AI_TTS_FAILED', `TTS HTTP ${resp.status} ${bodyText.slice(0, 200)}`);
  }

  const audio = Buffer.from(await resp.arrayBuffer());
  if (!audio.length) {
    throw cleanError('Text-to-speech returned empty audio. Please try again.', 502, 'AI_TTS_EMPTY', 'TTS returned 0 bytes');
  }
  return { audio, contentType: 'audio/mpeg' };
};

module.exports = { transcribe, speak, isSttConfigured, isTtsConfigured, getConfig };