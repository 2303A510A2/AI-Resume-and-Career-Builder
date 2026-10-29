// Safe provider diagnostic (development only). Makes ONE real request to the
// configured primary and (optionally) the fallback, printing the RAW provider
// status + sanitized body so the actual cause is visible in the terminal.
// NEVER prints the API key — every auth header/body is scrubbed.
// Run: node scripts/providerDiagnostic.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const providers = require('../services/providers');

const scrub = (text) =>
  String(text || '')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, '[bearer-redacted]');

const primary = providers.primary();
const fallback = providers.fallback();

console.log('== PROVIDER CONFIG (keys never printed) ==');
console.log(`primary  : provider=${primary.provider} baseUrl=${primary.baseUrl} model=${primary.model} key=${primary.apiKey ? `present(len=${primary.apiKey.length})` : 'MISSING'}`);
console.log(`fallback : ${fallback ? `provider=${fallback.provider} baseUrl=${fallback.baseUrl} model=${fallback.model} key=${fallback.apiKey ? `same-as-primary(${fallback.apiKey === primary.apiKey ? 'yes' : 'no'})` : 'MISSING'}` : 'NOT CONFIGURED'}`);
console.log('');

const call = async (cfg, label) => {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  // 1) GET /models — is the model even listed/available on this account?
  try {
    const m = await fetch(`${cfg.baseUrl}/models`, { method: 'GET', headers });
    const body = await m.text().catch(() => '');
    const ids = [];
    try { ids = (JSON.parse(body).data || []).map((x) => x && x.id).filter(Boolean); } catch { /* not json */ }
    console.log(`[${label}] GET /models -> HTTP ${m.status} (${ids.length} models listed)`);
    console.log(`[${label}]   contains primary model: ${ids.includes(primary.model) ? 'YES' : 'no'}`);
    if (fallback) console.log(`[${label}]   contains fallback model: ${ids.includes(fallback.model) ? 'YES' : 'no'}`);
    if (ids.length) console.log(`[${label}]   sample ids: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}`);
  } catch (e) {
    console.log(`[${label}] GET /models network error: ${e.message}`);
  }
  console.log('');

  // 2) ONE real chat completion, tiny budget — the exact request shape the app
  //    sends (model, messages, temperature, max_tokens).
  const bodies = [
    { label: 'tiny(64)', body: { model: cfg.model, messages: [{ role: 'user', content: 'Say hello.' }], temperature: 0.5, max_tokens: 64 } },
    // Realistic app-shaped request: same shape the chat pipeline sends for
    // "What is Java? Explain it simply" (system + user, ~700-1200 token budget).
    {
      label: 'app-like(1200)',
      body: {
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You are a helpful AI assistant. Answer clearly and naturally.' },
          { role: 'user', content: 'What is Java? Explain it simply' },
        ],
        temperature: 0.6,
        max_tokens: 1200,
      },
    },
  ];
  for (const { label, body } of bodies) {
    try {
      const t0 = Date.now();
      const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await r.text().catch(() => '');
      const ms = Date.now() - t0;
      console.log(`[${label}] POST /chat/completions -> HTTP ${r.status} in ${ms}ms`);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      if (parsed && parsed.error) {
        console.log(`[${label}]   REAL PROVIDER ERROR: ${scrub(JSON.stringify(parsed.error)).slice(0, 500)}`);
      } else if (parsed && parsed.choices) {
        const c = parsed.choices[0] || {};
        const content = (c.message && c.message.content) || '';
        console.log(`[${label}]   finish_reason=${c.finish_reason} usage=${JSON.stringify(parsed.usage || {})}`);
        console.log(`[${label}]   content=${scrub(content).replace(/\s+/g, ' ').slice(0, 220) || '(EMPTY)'}`);
      } else {
        console.log(`[${label}]   RAW: ${scrub(text).replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`[${label}] POST network error: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  }
  console.log('');
};

(async () => {
  await call(primary, 'PRIMARY');
  if (fallback && fallback.apiKey) await call(fallback, 'FALLBACK');
  console.log('done.');
})();