// DIRECT PROVIDER TEST — backend only. ONE raw call to the configured
// OpenAI-compatible /chat/completions endpoint. No frontend, no RAG, no resume,
// no JD, no MongoDB chat history, no web search, no retries.
//
//   Run:  node scripts/directProviderTest.js   (from backend/)
//
// Prints the EXACT HTTP status and the EXACT (key-scrubbed) provider response
// body so a real provider error is never hidden behind a generic message.
// The API key is NEVER printed.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const providers = require('../services/providers');
const llmService = require('../services/llmService');

const scrub = (text) =>
  String(text || '')
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, '[key-redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, '[bearer-redacted]');

const main = async () => {
  const c = llmService.getConfig();

  console.log('── DIRECT PROVIDER TEST ──────────────────────────────');
  console.log(`LLM_PROVIDER configured: ${process.env.LLM_PROVIDER ? 'YES' : 'NO'}`);
  console.log(`LLM_BASE_URL configured: ${process.env.LLM_BASE_URL ? 'YES' : 'NO'}`);
  console.log(`LLM_MODEL configured:    ${process.env.LLM_MODEL ? 'YES' : 'NO'}`);
  console.log(`LLM_API_KEY configured:  ${process.env.LLM_API_KEY ? 'YES' : 'NO'}`);
  console.log('(The API key itself is never printed.)');
  console.log('');
  console.log(`Resolved provider: ${c.provider}`);
  console.log(`Resolved base URL: ${c.baseUrl}`);
  console.log(`Resolved model:    ${c.model}`);
  if (!c.apiKey) {
    console.log('\n❌ FAIL: no API key resolved. Nothing to test.');
    process.exit(2);
  }

  const endpoint = `${c.baseUrl}/chat/completions`;
  const body = {
    model: c.model,
    messages: [{ role: 'user', content: 'Reply with exactly: AI CONNECTED' }],
    temperature: 0,
    max_tokens: 50,
  };

  console.log('\nRequest being sent:');
  console.log(`  URL:          POST ${endpoint}`);
  console.log(`  Authorization: Bearer <configured key — not printed>`);
  console.log(`  Content-Type: application/json`);
  console.log(`  body.model:   ${body.model}`);
  console.log(`  body.messages: ${JSON.stringify(body.messages)}`);
  console.log(`  body.max_tokens: ${body.max_tokens}`);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    const latency = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error('\n❌ NETWORK FAILURE (could not reach the provider):');
    console.error(`   error:   ${err.name === 'AbortError' ? `request timed out after 25s` : err.message}`);
    console.error(`   latency: ${latency}s`);
    process.exit(2);
  }
  clearTimeout(timer);
  const latency = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nHTTP status: ${resp.status} ${resp.statusText || ''}`);
  console.log(`Latency:     ${latency}s`);
  const retryAfter = resp.headers ? resp.headers.get('retry-after') : null;
  const rlReset = resp.headers ? resp.headers.get('x-ratelimit-reset-tokens') : null;
  const rlRemainingTokens = resp.headers ? resp.headers.get('x-ratelimit-remaining-tokens') : null;
  const rlRemainingRequests = resp.headers ? resp.headers.get('x-ratelimit-remaining-requests') : null;
  console.log(`Rate-limit headers: retry-after=${retryAfter || '-'} x-ratelimit-reset-tokens=${rlReset || '-'} x-ratelimit-remaining-tokens=${rlRemainingTokens || '-'} x-ratelimit-remaining-requests=${rlRemainingRequests || '-'}`);
  console.log(`Response Content-Type: ${(resp.headers && resp.headers.get('content-type')) || '-'}`);

  const raw = await resp.text().catch(() => '');
  console.log(`\nRaw provider response body (key-scrubbed):`);
  console.log(scrub(raw).slice(0, 2000));
  console.log('');

  if (!resp.ok) {
    console.error(`❌ DIRECT AI TEST: FAIL (HTTP ${resp.status})`);
    if (resp.status === 429) {
      console.error('   → RATE LIMIT. Stopping provider testing as instructed — no retries attempted.');
    }
    process.exit(2);
  }

  // ---- Response parsing check (step 5) ----
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ DIRECT AI TEST: FAIL — response body was not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const msg = data?.choices?.[0]?.message || null;
  const content = msg?.content;
  console.log(`Parsed response.choices[0].message.content = ${JSON.stringify(content)}`);
  if (!content) {
    console.error('❌ DIRECT AI TEST: FAIL — choices[0].message.content is missing/empty.');
    process.exit(2);
  }
  if (!/AI CONNECTED/.test(content)) {
    console.log(`⚠️  Content did not literally contain "AI CONNECTED" (got: ${JSON.stringify(content).slice(0, 200)}) — still a real AI answer.`);
  } else {
    console.log('✅ Content contains "AI CONNECTED" literally.');
  }
  console.log('\n✅ DIRECT AI TEST: PASS ✅');
  process.exit(0);
};

main().catch((err) => {
  console.error('\n❌ DIRECT AI TEST: FAIL — unexpected error:');
  console.error('   ', err && err.stack ? err.stack : err);
  process.exit(1);
});