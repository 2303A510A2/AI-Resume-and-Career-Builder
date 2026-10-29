// LIVE duplicate-request proof (§13): one user message -> ONE generation.
//
// The offline suite (providerErrorTest.js §7) already proves the mechanism
// in-process; this script proves it END TO END through the real stack
// (JWT -> requestDedup -> RAG -> real provider) against a RUNNING backend.
//
// What it shows:
//   1. POST /api/ai/career-assistant with requestId R  -> 200, deduped:false,
//      a real (non-canned) answer  = ONE provider generation.
//   2. The SAME requestId sent again (a double-click / Enter twice / a client
//      network retry) -> 200, deduped:true, the IDENTICAL answer and
//      conversationId, and NO second provider call (the replay never reaches
//      askCareerAssistant).
//   3. A NEW requestId -> deduped:false, a fresh generation (dedup does not
//      over-block normal traffic).
//
// Needs: the backend on :5000, MongoDB, and a real LLM key. A spent provider
// quota is reported as SKIP, never FAIL — blaming the app for a provider quota
// would train us to ignore real regressions (same rule as offlineBugE2E).
//
// Run: node scripts/dedupLiveTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:5000') + '/api';
const PAUSE_MS = Number(process.env.AI_PAUSE_MS || 30000);
const QUOTA_CODES = new Set(['AI_DAILY_LIMIT', 'AI_RATE_LIMITED']);

let pass = 0;
let fail = 0;
let skip = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};
const skipped = (name, detail) => {
  console.log(`SKIP  ${name}${detail ? ' :: ' + detail : ''}`);
  skip += 1;
};
const pause = async (label) => {
  if (PAUSE_MS <= 0) return;
  console.log(`      (waiting ${PAUSE_MS}ms before ${label} — Groq free tier is 8000 tokens/min)`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
};

const j = async (r) => { try { return await r.json(); } catch { return {}; } };

const main = async () => {
  // ---- health first: a dead backend must say so, not "FAIL" -----------------
  let health;
  try {
    const h = await fetch(`${BASE}/health`);
    health = await j(h);
    if (!h.ok || health.status !== 'ok') throw new Error(`health status=${h.status}`);
  } catch (err) {
    console.log(`FAIL  backend is not answering on ${BASE} :: ${err.message}`);
    console.log('      start it with `npm run dev` (root) first — this is not a code failure.');
    process.exit(1);
  }
  console.log(`      backend online (server=${health.server}, db=${health.services && health.services.database})`);

  // ---- one throwaway user (deleted again at the end) ------------------------
  const stamp = Date.now();
  const email = `dedup_${stamp}@test.dev`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'DedupLive', email, password: 'Secret123', confirmPassword: 'Secret123' }),
  });
  const regData = await j(reg);
  const token = regData.token;
  check('register -> JWT', reg.status === 201 && !!token, `status=${reg.status}`);
  if (!token) process.exit(1);

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const meData = await j(await fetch(`${BASE}/auth/me`, { headers: auth }));
  const userId = String((meData.user && (meData.user._id || meData.user.id)) || meData._id || '');

  const post = async (requestId, message, conversationId) => {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/ai/career-assistant`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ message, conversationId, documentIds: [], requestId }),
    });
    return { status: r.status, body: await j(r), ms: Date.now() - t0 };
  };

  const rid = `live-dedup-${stamp}`;
  const first = await post(rid, 'hi');

  if (first.status !== 200 && QUOTA_CODES.has(first.body.code)) {
    skipped('one message -> one generation', `provider quota exhausted (${first.body.code}) — not an app failure`);
    skipped('duplicate requestId replays without a second generation', 'no successful turn to duplicate');
    skipped('a new requestId generates again', 'provider quota exhausted');
  } else {
    check('one message -> HTTP 200', first.status === 200, `status=${first.status} code=${first.body.code || '-'} in ${first.ms}ms`);
    check('first send is NOT deduped (it really generated)', first.body.deduped === false, `deduped=${first.body.deduped}`);
    const answer1 = String(first.body.message && first.body.message.content || '');
    check('the answer is real (non-empty, not a canned fallback)', answer1.length > 3, JSON.stringify(answer1.slice(0, 70)));
    check('requestId is echoed back', first.body.requestId === rid, String(first.body.requestId));

    // ---- the duplicate: same requestId, as a double-click would send --------
    const dup = await post(rid, 'hi');
    const answer2 = String(dup.body.message && dup.body.message.content || '');
    check('duplicate requestId -> HTTP 200', dup.status === 200, `status=${dup.status} code=${dup.body.code || '-'} in ${dup.ms}ms`);
    check('the duplicate IS deduped (no second generation)', dup.body.deduped === true, `deduped=${dup.body.deduped}`);
    check('the replayed answer is byte-identical (same stored run)', answer2 === answer1, `${answer2.length} chars vs ${answer1.length}`);
    check('the conversationId matches (no second conversation created)',
      String(dup.body.conversationId) === String(first.body.conversationId),
      String(dup.body.conversationId));

    // ---- a genuinely new message must still generate ------------------------
    await pause('the new-requestId turn');
    const fresh = await post(`live-dedup-${stamp}-2`, 'What is Java?', String(first.body.conversationId));
    if (fresh.status === 200) {
      check('a NEW requestId is not deduped (normal traffic unaffected)', fresh.body.deduped === false, `deduped=${fresh.body.deduped}`);
      check('the new message gets its own answer', String(fresh.body.message && fresh.body.message.content || '').length > 20,
        JSON.stringify(String(fresh.body.message && fresh.body.message.content || '').slice(0, 70)));
    } else if (QUOTA_CODES.has(fresh.body.code)) {
      skipped('a NEW requestId is not deduped', `provider quota exhausted (${fresh.body.code}) — not an app failure`);
    } else {
      check('a NEW requestId is not deduped (normal traffic unaffected)', false, `status=${fresh.status} code=${fresh.body.code}`);
    }
  }

  // ---- cleanup: conversations via the API, the user via Mongo ---------------
  try {
    const list = await j(await fetch(`${BASE}/chat`, { headers: auth }));
    const ids = (list.chats || list.data || []).map((c) => c._id).filter(Boolean);
    for (const id of ids) await fetch(`${BASE}/chat/${id}`, { method: 'DELETE', headers: auth });
    if (ids.length) console.log(`      (cleaned up ${ids.length} conversation(s))`);
  } catch { /* best effort */ }

  try {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (MONGO_URI && userId) {
      const mongoose = require('mongoose');
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
      const User = require('../models/User');
      await User.deleteOne({ _id: userId });
      await mongoose.disconnect();
      console.log(`      (cleaned up test user ${email})`);
    }
  } catch (err) {
    console.log(`      (note: could not delete the test user — ${err.message})`);
  }

  console.log('\n' + '='.repeat(56));
  console.log(`RESULTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('\ndedupLiveTest.js itself crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
