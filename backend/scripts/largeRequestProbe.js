// In-process probe: reproduces the LIVE inconsistency (small "hi" OK -> large
// request 502) through the REAL pipeline (ragService -> llmService.chat) and
// prints the true provider code/status/body plus the [AI ...] dev logs.
// Run: node scripts/largeRequestProbe.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const llmService = require('../services/llmService');
const ragService = require('../services/ragService');

const run = async (label, question) => {
  const t0 = Date.now();
  try {
    const r = await ragService.askCareerAssistant({ userId: 'probe-user', question, history: [], requestId: `probe-${Date.now()}` });
    console.log(`\n[${label}] OK in ${Date.now() - t0}ms provider=${r.provider || '?'} model=${r.model || '?'} len=${String(r.answer || '').length}`);
    console.log('        ', String(r.answer || '').replace(/\s+/g, ' ').slice(0, 180));
  } catch (err) {
    console.log(`\n[${label}] THROWN in ${Date.now() - t0}ms code=${err && err.code} status=${err && err.statusCode} retryable=${err && err.retryable} usedFallback=${err && err.usedFallback}`);
    console.log('        message:', err && err.message);
    console.log('        detail :', String((err && err.detail) || '').replace(/\s+/g, ' ').slice(0, 500));
  }
  console.log('');
};

(async () => {
  const d = llmService.describe();
  console.log('primary :', d.provider, d.model, '| fallback :', d.fallback ? `${d.fallback.provider} ${d.fallback.model}` : 'none', '\n');
  await run('A  hi (small)', 'hi');
  await run('B  tables 1 to 10 (large budget)', 'give me multiplication tables from 1 to 10');
  await run('C  20 LeetCode problems (large budget)', 'give me 20 LeetCode problems');
  await run('D  explain Java in 1000 words (large budget)', 'explain Java in 1000 words');
  console.log('done.');
})();
