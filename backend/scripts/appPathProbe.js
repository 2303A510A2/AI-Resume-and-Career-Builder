// In-process probe: exercises the EXACT provider path the chat pipeline uses
// (ragService -> llmService.chat), with the REAL system prompt, and prints the
// true error (code/status/detail) plus the [AI ...] dev logs to this terminal.
// Run: node scripts/appPathProbe.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const llmService = require('../services/llmService');
const { CAREER_ASSISTANT_SYSTEM, RESOURCE_GUIDE_SYSTEM } = require('../services/prompts');

const system = `${CAREER_ASSISTANT_SYSTEM}\n\n${RESOURCE_GUIDE_SYSTEM}`;
const run = async (label, messages, opts = {}) => {
  const t0 = Date.now();
  try {
    const r = await llmService.chat({
      messages,
      temperature: 0.6,
      maxTokens: 700,
      requestId: `probe-${Date.now()}`,
      returnMeta: true,
      ...opts,
    });
    console.log(`[${label}] OK in ${Date.now() - t0}ms provider=${r.provider} model=${r.model} finish=${r.finishReason} content=${String(r.content).replace(/\s+/g, ' ').slice(0, 160) || '(EMPTY)'}`);
  } catch (err) {
    console.log(`[${label}] THROWN in ${Date.now() - t0}ms code=${err && err.code} status=${err && err.statusCode} retryable=${err && err.retryable} usedFallback=${err && err.usedFallback}`);
    console.log(`        message: ${err && err.message}`);
    console.log(`        detail : ${String((err && err.detail) || '').replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  console.log('');
};

(async () => {
  await run('REAL-SYSTEM (What is Java?)', [
    { role: 'system', content: system },
    { role: 'user', content: 'What is Java? Explain it simply' },
  ]);
  await run('TINY-SYSTEM (What is Java?)', [
    { role: 'system', content: 'You are a helpful AI assistant.' },
    { role: 'user', content: 'What is Java? Explain it simply' },
  ]);
})();