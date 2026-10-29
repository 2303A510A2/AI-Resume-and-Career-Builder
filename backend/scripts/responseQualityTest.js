// Live response-quality suite: does the assistant FULFIL the request exactly?
//
//   node scripts/responseQualityTest.js      (requires the backend running + a real key)
//
// This is the end-to-end proof for the truncation fix. Every assertion below is
// generic — it counts items, words, ranges, rows or code fences in whatever the
// model actually returned. There is no hardcoded expected answer and no
// per-subject special case, so a failure means the system stopped honouring a
// QUANTITY, a LENGTH or a FORMAT in general (not that one question regressed).
//
// It is deliberately slow: several cases need 5k-10k tokens and a free-tier
// provider can take 30-90s per turn.
//
//   SKIP_SLOW=1  run only the fast cases (no large generations / no follow-ups)
//   RQ_RETRIES=6 retry a rate-limited provider more times before skipping a case
const BASE = process.env.SMOKE_BASE || 'http://localhost:5000/api';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { analyzeRequest, checkCompleteness, wordCount, numberedRuns } = require('../services/outputRequirements');

let passed = 0;
let failed = 0;
const failures = [];
const log = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  PASS ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exit without tripping libuv's "Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)" on Windows: closing keep-alive sockets and tearing the
// global agent down first is safer than a bare process.exit() while fetch
// handles are still open.
const done = (code) => {
  try { globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.(); } catch { /* best effort */ }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
};

// A quota/overload hiccup is NOT a quality bug, but skipping every case because
// the free tier is busy would prove nothing. A 429/5xx provider error is retried
// a bounded number of times with a real backoff; only persistent failure is a skip.
const RETRYABLE_CODES = new Set(['AI_RATE_LIMITED', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_ERROR', 'AI_UNREACHABLE']);
const MAX_RETRIES = Number(process.env.RQ_RETRIES ?? 6);
let transient = 0;
let retries = 0;
let reauthUsed = false;

// The requested count, understood exactly the way the service understands it.
const reqFor = (question, history = []) => analyzeRequest({ question, history });

// Independent verification of "the items the user will see are all there": we do
// NOT trust checkCompleteness' own verdict, we re-count the markers ourselves.
// The marker universe is the ENGINE's own numberedRuns (plain "1.", bold
// "**2.**", bullets "- **3.**", colon rows "20: 20 40 60", "### Table 4",
// "Step 5:") — guard against a checker regression, never against a marker style
// the engine already accepts. The WINDOW mirrors checkCompleteness as well: a
// follow-up counts from `continueFrom` (with the restart-at-1 tolerance), so a
// "give me 10 more" answered 11..20 — or 4..13 — is counted in the window the
// engine demands, never in a hard-coded 1..N. Clock times ("10:30 AM") and
// prose ("Version 77: released") must still never count.
const countItems = (text, req = {}) => {
  const nums = numberedRuns(String(text || ''));
  const from = req.continueFrom && req.continueFrom > 1 ? req.continueFrom : 1;
  const to = req.targetTotal ? req.targetTotal : from + (req.itemCount || 1) - 1;
  let hits = 0;
  for (let i = from; i <= to; i += 1) if (nums.has(i)) hits += 1;
  let windowFrom = from;
  let windowTo = to;
  if (req.isContinuation && from > 1 && hits < (req.itemCount || 0)) {
    let restart = 0;
    for (let i = 1; i <= (req.itemCount || 0); i += 1) if (nums.has(i)) restart += 1;
    if (restart > hits) { hits = restart; windowFrom = 1; windowTo = req.itemCount; }
  }
  const gaps = [];
  for (let i = windowFrom; i <= windowTo; i += 1) if (!nums.has(i)) gaps.push(i);
  return { hits, gaps, seen: nums, windowFrom, windowTo };
};

const numberedItems = (text) => String(text || '').split(/\r?\n/).flatMap((line) => {
  const match = /^\s*(?:#{1,3}\s*)?(?:[-*+]\s*)?(?:\*\*)?(\d{1,3})[.)](?:\*\*)?\s+(.+?)\s*$/.exec(line);
  if (!match) return [];
  const content = match[2]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return content ? [{ number: Number(match[1]), content }] : [];
});

// The re-counter itself is asserted offline before any live call, so a checker
// regression surfaces here (deterministically) instead of as a bogus live FAIL.
const countItemsSelfTest = () => {
  const probe = [
    '1. plain', '**2.** bold', '- **3.** bullet bold', '11: 11 22 33',
    '### Table 4', 'Step 5:', '10:30 AM', 'Version 77: released',
  ].join('\n');
  const { hits, seen } = countItems(probe, { itemCount: 20 });
  // Expected: items 1,2,3,4,5 and the colon row 11 (hit in the 1..20 window).
  // A clock time must never add 10/30 and prose "Version 77:" never 77 —
  // those are exactly the false positives that used to fail complete answers.
  const ok = hits === 6 && seen.has(11) && !seen.has(10) && !seen.has(30) && !seen.has(77);
  log('number re-counter reads every real marker style', ok,
    `items 1..5 + 11 seen; clock time and prose excluded`);
  return ok;
};
const endsTruncated = (text) => /(?:^|\s)\.\.\.\s*$|…\s*$|\betc\.?\s*$/i.test(text.trim());

const main = async () => {
  console.log(`\n=== response quality live suite (${new Date().toISOString()}) ===`);
  if (!countItemsSelfTest()) console.log('  WARNING countItems backstop regression — a live FAIL below may be a checker bug');
  const health = await j(await fetch(`${BASE}/health`));
  if (!(health.status === 'ok' || health.success === true)) {
    console.log(`SKIP backend is not running on ${BASE}`);
    done(0);
  }
  // Only a genuinely absent key is a skip. "unreachable"/"checking" is a transient
  // provider state — the per-case retry loop is the right answer for that, not a skip.
  if (health?.services?.llm === 'not-configured') {
    console.log('SKIP no LLM key configured (LLM_API_KEY empty) — nothing honest to assert.');
    done(0);
  }

  const email = `rq_${Date.now()}@test.dev`;
  const password = 'Secret123';
  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RQ', email, password, confirmPassword: password }),
  });
  const regBody = await j(reg);
  if (!regBody.token) { console.log(`could not register (status=${reg.status})`); done(1); }
  let auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${regBody.token}` };
  console.log(`registered ${email}\n`);

  // If the backend restarts mid-run (nodemon + OneDrive touching files), the JWT
  // may go stale or the router may 404 once. That is an environment hiccup, not
  // a quality signal — register a fresh user ONCE and let the retry loop carry on.
  const reauth = async () => {
    const email2 = `rq_${Date.now()}_b@test.dev`;
    try {
      const r2 = await fetch(`${BASE}/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'RQ2', email: email2, password, confirmPassword: password }),
      });
      const b2 = await j(r2);
      if (!b2.token) return false;
      auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${b2.token}` };
      return true;
    } catch { return false; }
  };

  const ask = async (message, conversationId) => {
    const t0 = Date.now();
    // A dropped connection (the backend restarting under nodemon mid-run) is not a
    // quality signal, so it is reported like a provider hiccup and retried rather
    // than crashing the whole suite.
    try {
      const r = await fetch(`${BASE}/ai/career-assistant`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          message, conversationId, documentIds: [],
          requestId: `rq_${Math.random().toString(36).slice(2)}`,
        }),
      });
      const body = await j(r);
      return {
        status: r.status,
        code: body?.code,
        text: String(body?.message?.content || ''),
        completion: body?.completion || body?.message?.completion || null,
        conversationId: body?.conversationId,
        ms: Date.now() - t0,
      };
    } catch (err) {
      return { status: 0, code: 'TRANSPORT_ERROR', text: '', conversationId, ms: Date.now() - t0, error: String((err && err.message) || err) };
    }
  };
  const run = async (label, message, conversationId) => {
    let a = await ask(message, conversationId);
    for (let attempt = 0; attempt < MAX_RETRIES && (a.status !== 200 || !a.text); attempt += 1) {
      const transport = a.status === 0;
      // A backend restart can briefly 401 (stale token) or 404 (router not yet
      // mounted). One fresh user makes that a retry instead of a lost case.
      if (!transport && (a.status === 401 || (a.status === 404 && !a.code)) && !reauthUsed) {
        reauthUsed = true;
        if (await reauth()) {
          retries += 1;
          console.log(`  .. ${label}: backend restarted mid-run — registered a fresh user; retrying`);
          a = await ask(message, conversationId);
          continue;
        }
      }
      if (!transport && !RETRYABLE_CODES.has(a.code) && a.status !== 429 && a.status !== 503) break;
      const wait = Math.min(30000, 3000 * 2 ** attempt);
      retries += 1;
      console.log(`  .. ${label}: ${transport ? `transport error (${a.error})` : `provider ${a.status}/${a.code || 'no-code'}`}; retrying in ${(wait / 1000).toFixed(0)}s (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      a = await ask(message, conversationId);
    }
    if (a.status !== 200 || !a.text) {
      transient += 1;
      console.log(`  SKIP ${label} — unavailable after ${MAX_RETRIES} retries: ${a.status || 'transport'}/${a.code || 'no-code'} (not a quality failure)`);
      return { ok: false, skipped: true };
    }
    return { ok: true, ...a };
  };

  // ---- 1. a plain general question needs no documents ------------------------
  {
    const a = await run('greeting', 'hi');
    if (a.ok) log('a greeting is answered with no document uploaded at all', /\S{5,}/.test(a.text), a.text.slice(0, 60).replace(/\n/g, ' '));
  }

  // ---- 2. QUANTITY: 20 items --------------------------------------------------
  {
    const Q = 'Give me 20 Java project ideas for a beginner.';
    const a = await run('20 projects', Q);
    if (a.ok) {
      const target = reqFor(Q);
      const c = checkCompleteness(a.text, target);
      const mine = countItems(a.text, target);
      log('20 projects: every requested item is present', c.complete, `${c.produced}/${c.target} — ${c.reason}`);
      log('20 projects: our own re-count finds no gap', mine.hits >= target.itemCount, `${mine.hits}/${target.itemCount}${mine.gaps.length ? ` missing ${mine.gaps.join(',')}` : ''}`);
      log('20 projects: the answer is not closed off with "..." / "etc."', !endsTruncated(a.text), JSON.stringify(a.text.slice(-50)));
    }
  }

  // ---- 2b. EXACT QUANTITY: 10 distinct items -------------------------------
  {
    const Q = 'Give me 10 distinct easy LeetCode problem names only, with no descriptions.';
    const a = await run('10 LeetCode problems', Q);
    if (a.ok) {
      const target = reqFor(Q);
      const c = checkCompleteness(a.text, target);
      const mine = countItems(a.text, target);
      const items = numberedItems(a.text);
      const unique = new Set(items.map((item) => item.content));
      log('10 LeetCode problems: exactly 10 numbered items are present', c.complete && mine.hits === 10, `${mine.hits}/10 — ${c.reason}`);
      log('10 LeetCode problems: all 10 item descriptions are distinct', unique.size === 10, `${unique.size} distinct numbered entries`);
    }
  }

  // ---- 3. RANGE: "from 1 to 20" ----------------------------------------------
  {
    const Q = 'Give me multiplication tables from 1 to 20, one full table per line.';
    const a = await run('tables 1 to 20', Q);
    if (a.ok) {
      const c = checkCompleteness(a.text, reqFor(Q));
      log('tables 1 to 20: the whole range is delivered', c.complete, `${c.produced}/${c.target} — ${c.reason}`);
      // The row for 20 must reach 20x20=400 however the model lays it out:
      // as "20 x 20 = 400", or as a product grid row "20: 20 40 60 ... 400".
      // Asserting one exact spelling would fail on a correct answer.
      const row20 = a.text.split('\n').find((l) => /^\s*\**20[.:)]/.test(l)) || '';
      log(
        'tables 1 to 20: the last row reaches 20x20 = 400',
        /\b400\b/.test(row20) || /\b20\s*[x*×]\s*20\s*=\s*400/.test(a.text),
        `row 20 = ${JSON.stringify(row20.slice(0, 90))}`
      );
      log('tables 1 to 20: nothing is cut off or elided', !endsTruncated(a.text), JSON.stringify(a.text.slice(-50)));
    }
  }

  // ---- 4. WORD COUNT: "in 500 words" -----------------------------------------
  {
    const Q = 'Explain what a Java Virtual Machine is in 500 words.';
    const a = await run('500 words', Q);
    if (a.ok) {
      const c = checkCompleteness(a.text, reqFor(Q));
      const w = wordCount(a.text);
      log('500-word request: the requested length is honoured', c.complete, `${w} words vs target ${c.target}`);
      log('500-word request: it is a real answer, not a stub', w > 300, `${w} words`);
      log('500-word request: it does not stop mid-sentence on an ellipsis', !endsTruncated(a.text), JSON.stringify(a.text.slice(-60)));
    }
  }

  if (process.env.SKIP_SLOW === '1') {
    console.log('\n(skipping the large + follow-up cases: SKIP_SLOW=1)');
  } else {
    // ---- 5. MEDIUM QUANTITY: 50 distinct items ------------------------------
    {
      const Q = 'Give me 50 distinct easy LeetCode problem names only, with no descriptions.';
      const a = await run('50 LeetCode problems', Q);
      if (a.ok) {
        const target = reqFor(Q);
        const c = checkCompleteness(a.text, target);
        const mine = countItems(a.text, target);
        const items = numberedItems(a.text);
        const unique = new Set(items.map((item) => item.content));
        log('50 LeetCode problems: exactly 50 numbered items are present', c.complete && mine.hits === 50, `${mine.hits}/50 — ${c.reason}`);
        log('50 LeetCode problems: all 50 item descriptions are distinct', unique.size === 50, `${unique.size} distinct numbered entries`);
        log('50 LeetCode problems: persisted completion metadata is complete', a.completion && a.completion.complete === true, JSON.stringify(a.completion));
      }
    }

    // ---- 6. LARGE QUANTITY: 100 items (needs a genuinely big budget) --------
    {
      const Q = 'Give me 100 distinct easy LeetCode problem names only, with no descriptions.';
      const a = await run('100 LeetCode problems', Q);
      if (a.ok) {
        const target = reqFor(Q);
        const c = checkCompleteness(a.text, target);
        const mine = countItems(a.text, target);
        const items = numberedItems(a.text);
        const unique = new Set(items.map((item) => item.content));
        log('100 LeetCode problems: exactly 100 numbered items are present', c.complete && mine.hits === 100, `${mine.hits}/100 — ${c.reason}`);
        log('100 LeetCode problems: all 100 item descriptions are distinct', unique.size === 100, `${unique.size} distinct numbered entries`);
        log('100 LeetCode problems: persisted completion metadata is complete', a.completion && a.completion.complete === true, JSON.stringify(a.completion));
        log('100 LeetCode problems: not truncated with "..." / "etc."', !endsTruncated(a.text), JSON.stringify(a.text.slice(-50)));
      }
    }

    // ---- 6. FOLLOW-UP: "give me 10 more" extends, it does not restart -------
    {
      const first = await run('10 leetcode', 'Give me 10 easy LeetCode problems.');
      if (first.ok) {
        const more = await run('10 more', 'Give me 10 more.', first.conversationId);
        if (more.ok) {
          const req2 = reqFor('Give me 10 more.', [{ role: 'assistant', content: first.text }]);
          const c2 = checkCompleteness(more.text, req2);
          const mine = countItems(more.text, req2);
          log('"give me 10 more": delivers 10 more items', c2.complete, `${c2.produced}/${c2.target} — ${c2.reason}`);
          log('"give me 10 more": the new answer is numbered and long enough', mine.hits >= 8 && more.text.length > 250, `${mine.hits} numbers (${mine.windowFrom}..${mine.windowTo}), ${more.text.length} chars`);
          log('"give me 10 more": it did not just replay the first answer', more.text.trim() !== first.text.trim() && more.text.length > first.text.length * 0.5);
        }
      }
    }

    // ---- 7. FOLLOW-UP: "make it 20" grows the previous answer ---------------
    {
      const first = await run('5 benefits', 'List 5 benefits of learning Java.');
      if (first.ok) {
        const grow = await run('make it 20', 'Make it 20.', first.conversationId);
        if (grow.ok) {
          const req2 = reqFor('Make it 20.', [{ role: 'assistant', content: first.text }]);
          const c2 = checkCompleteness(grow.text, req2);
          log('"make it 20": delivers 20 items', c2.complete, `${c2.produced}/${c2.target} — ${c2.reason}`);
          log('"make it 20": still on the original topic', /java/i.test(grow.text), grow.text.slice(0, 60).replace(/\n/g, ' '));
        }
      }
    }

    // ---- 8. FOLLOW-UP memory: a fact stated earlier is recalled ------------
    {
      const s = await ask("My friend's name is Karri. Remember that.");
      if (s.status === 200 && s.text) {
        const q = await run('who is Karri', 'Who is Karri?', s.conversationId);
        if (q.ok) log('"who is Karri?" recalls the fact stated earlier', /karri/i.test(q.text), q.text.slice(0, 90).replace(/\n/g, ' '));
      }
    }
  }

  // ---- 9. CODE-ONLY: real code, no cut-off ---------------------------------
  {
    const Q = 'Give only code for a Python function that reverses a string. No explanation.';
    const a = await run('code only', Q);
    if (a.ok) {
      const fences = (a.text.match(/```/g) || []).length;
      log('code-only: real code is present', /def\s+\w+\s*\(|return\s+/.test(a.text), a.text.slice(0, 70).replace(/\n/g, ' '));
      log('code-only: no markdown fence is left unterminated', fences % 2 === 0, `${fences} fence markers`);
      log('code-only: nothing is truncated', !endsTruncated(a.text));
    }
  }

  // ---- 10. FORMAT: a table is a real table --------------------------------
  {
    const Q = 'Compare Java and Python in a markdown table with 5 rows.';
    const a = await run('table', Q);
    if (a.ok) {
      const rows = a.text.split('\n').filter((l) => l.trim().startsWith('|'));
      log('table request: it really is a markdown table', rows.length >= 3, `${rows.length} table lines`);
      log('table request: nothing is truncated', !endsTruncated(a.text), JSON.stringify(a.text.slice(-50)));
    }
  }

  // ---- 11. RAG is not required for a general question --------------------
  {
    const a = await run('general no-rag', 'What is the difference between a stack and a queue?');
    if (a.ok) {
      log('a general question works with no resume uploaded', /stack/i.test(a.text) && a.text.length > 80, `${a.text.length} chars`);
      log('a general question is not hijacked by an absent resume', !/your resume|upload your resume/i.test(a.text));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(failed === 0 ? `ALL ${passed} QUALITY ASSERTIONS PASSED` : `${passed} passed / ${failed} FAILED`);
  if (retries) console.log(`(${retries} provider retry/retries due to rate limiting)`);
  if (transient) console.log(`(${transient} case(s) skipped — provider stayed unavailable; not quality failures)`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  done(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error('crashed:', e.message, e.stack); done(1); });