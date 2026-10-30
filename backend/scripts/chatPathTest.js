// In-process regression test for the chat code path.
//
// THE BUG IT GUARDS
//   backend\services\ragService.js called `pickMaxTokens(intent)` in two places
//   while the function itself did not exist anywhere in the repository (the file
//   was mid-refactor: the old fixed per-intent budget table had been deleted in
//   favour of outputRequirements.js, but the two call sites were left behind).
//   Every single POST /api/ai/career-assistant therefore threw
//       ReferenceError: pickMaxTokens is not defined
//   and the controller turned it into a generic 500. "hi", "What is Java?" and
//   every other message failed — for a plain "hi" the UI showed an error while
//   GET /api/health answered 200 the whole time.
//
// WHY A STATIC CHECK IS NOT ENOUGH
//   `node --check` only parses. An undefined identifier is perfectly valid
//   syntax, so it passes every syntax gate, every lint-less build, and the
//   production bundle. It can only be caught by EXECUTING the path.
//
// WHY THIS RUNS OFFLINE AND WITHOUT A DATABASE
//   llmService.chat is monkey-patched, so no provider is ever called. A plain
//   conversational question ("hi") is not a document intent, so the RAG gating
//   skips retrieval entirely and no MongoDB query is made. The whole suite is
//   therefore fast, free, and deterministic — unlike offlineBugE2E.js, which
//   needs the server running plus a real Groq key and a free-tier quota.
//
// Run: node scripts/chatPathTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.LLM_CONTINUATION_RATE_LIMIT_MAX_WAIT_MS = '1';

const llmService = require('../services/llmService');

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}${detail ? ' :: ' + detail : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
};

/**
 * Runs askCareerAssistant with a stubbed provider and returns
 * { answer, completion, error, calls } — the error is CAPTURED, never thrown, so a
 * ReferenceError inside the chat path shows up as a readable assertion failure
 * instead of an unhandled rejection.
 *
 * `replies` (optional) is a list of provider replies consumed IN ORDER, one per
 * call. That is how the continuation loop is exercised deterministically: the
 * first reply is a cut-off answer, the second is the remainder. A reply may be
 * a plain string (truncated=false) or `{ content, truncated:true }` so the
 * provider's own finish_reason=length signal can be simulated exactly like the
 * real llmService returns it. `failAfter` makes a call throw instead, to prove
 * a failed continuation never destroys an answer that already exists.
 */
const runChat = async ({ question, history = [], attachedImages = [], replies = [], failAfter = null, failSequence = [] }) => {
  const calls = [];
  const realChat = llmService.chat;
  const realChatWithBrowserSearch = llmService.chatWithBrowserSearch;
  const queue = [...replies];

  const nextReply = (opts, via) => {
    calls.push({ via, maxTokens: opts.maxTokens, messages: opts.messages, preferProvider: opts.preferProvider || '', preferModel: opts.preferModel || '' });
    const n = calls.length - 1;
    if (failSequence[n]) throw failSequence[n];
    if (failAfter !== null && n >= failAfter) {
      const err = new Error('stub provider failure');
      err.code = 'AI_UNREACHABLE';
      err.isOperational = true;
      throw err;
    }
    if (queue.length) {
      const item = queue.shift();
      if (item && typeof item === 'object' && 'content' in item) {
        const out = { content: String(item.content), truncated: Boolean(item.truncated) };
        // A reply may claim a provider/model (what the real llmService returns) —
        // ragService pins continuation turns to that provider.
        if (item.provider) out.provider = item.provider;
        if (item.model) out.model = item.model;
        return out;
      }
      return { content: String(item), truncated: false };
    }
    return { content: 'STUB ANSWER', truncated: false };
  };

  llmService.chat = async (opts) => {
    const r = nextReply(opts, 'chat');
    const out = { content: r.content, toolUsed: false, urls: [], truncated: r.truncated };
    if (r.provider) out.provider = r.provider;
    if (r.model) out.model = r.model;
    return out;
  };
  llmService.chatWithBrowserSearch = async (opts) => {
    const r = nextReply(opts, 'browserSearch');
    const out = { content: r.content, toolUsed: false, urls: [], truncated: r.truncated };
    if (r.provider) out.provider = r.provider;
    if (r.model) out.model = r.model;
    return out;
  };

  // Required lazily so the stub above is already installed.
  const ragService = require('../services/ragService');
  try {
    const r = await ragService.askCareerAssistant({
      userId: 'chat-path-test-user',
      question,
      history,
      attachedImages,
    });
    return { answer: r.answer, completion: r.completion, intent: r.intent, error: null, calls };
  } catch (err) {
    return { answer: '', error: err, calls };
  } finally {
    llmService.chat = realChat;
    llmService.chatWithBrowserSearch = realChatWithBrowserSearch;
  }
};

const main = async () => {
  console.log('\n1) The chat path runs without throwing a ReferenceError');
  {
    const r = await runChat({ question: 'hi' });
    ok(
      '"hi" does not throw',
      r.error === null,
      r.error ? `${r.error.name}: ${r.error.message}` : 'clean run'
    );
    ok('"hi" reaches the provider', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('"hi" returns the provider answer', r.answer === 'STUB ANSWER', r.answer || '(empty)');
    ok('"hi" is detected as GENERAL intent', r.intent === 'GENERAL', String(r.intent));
  }

  console.log('\n2) A question whose budget comes from outputRequirements');
  {
    const r = await runChat({ question: 'What is Java?' });
    ok('"What is Java?" does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('"What is Java?" reaches the provider', r.calls.length === 1, `${r.calls.length} call(s)`);
  }

  console.log('\n3) A high-volume request (this is what pickMaxTokens must size up)');
  {
    const r = await runChat({ question: 'give me 100 Java interview questions' });
    ok('a 100-item request does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    const mt = r.calls[0] ? r.calls[0].maxTokens : 0;
    ok('100 items gets a real budget (>4000 tokens)', mt > 4000, `maxTokens=${mt}`);
    ok('the budget is a finite positive number', Number.isFinite(mt) && mt > 0, `maxTokens=${mt}`);
  }

  console.log('\n4) maxTokens is always a usable integer, never undefined/NaN');
  {
    // These are exactly the shapes that used to produce a broken budget: a bare
    // greeting, a quantity with no unit noun, a bare word count, and a
    // continuation follow-up that must read the previous answer.
    const cases = [
      { question: 'hi' },
      { question: 'give me 50' },
      { question: 'explain Java in 1000 words' },
      { question: 'give me 20 Java programs' },
      { question: 'more', history: [{ role: 'user', content: 'give me 10 Java interview questions' }, { role: 'ai', content: '1. Q1\n2. Q2\n3. Q3' }] },
    ];
    let bad = null;
    for (const c of cases) {
      const r = await runChat(c);
      const mt = r.calls[0] ? r.calls[0].maxTokens : null;
      if (r.error) {
        bad = `"${c.question}" threw ${r.error.name}: ${r.error.message}`;
        break;
      }
      if (!Number.isInteger(mt) || mt < 64) {
        bad = `"${c.question}" produced maxTokens=${mt}`;
        break;
      }
    }
    ok('every request shape yields an integer budget >= 64', bad === null, bad || `${cases.length} shapes OK`);
  }

  console.log('\n5) An attached image with vision disabled still answers the text');
  {
    // Deliberately NOT a document question: a RESUME/JD intent turns on the RAG
    // gating, which would make a real MongoDB query and need a live database plus
    // a real ObjectId. This case is only about the image branch, so the question
    // stays conversational and the whole run remains server-free.
    const r = await runChat({
      question: 'hi',
      attachedImages: [{ fileName: 'diagram.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    ok('an image attachment does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('the image request still reaches the provider', r.calls.length === 1, `${r.calls.length} call(s)`);
  }

  console.log('\n6) The system prompt is never given to the user');
  {
    const r = await runChat({ question: 'hi' });
    ok('the internal intent marker is scrubbed from the answer', !/DETECTED INTENT|INTERNAL NOTE/i.test(r.answer), r.answer);
  }

  console.log('\n7) Conversational style is resolved from the user\'s own words');
  {
    // The style must be carried as PROMPT CONTEXT, never as a canned reply: these
    // assertions read the system message the model would receive, with the
    // provider stubbed, so they cost no quota and need no server.
    const styleOf = async (question, history = []) => {
      const r = await runChat({ question, history });
      if (r.error) return { error: r.error };
      const sys = (r.calls[0] || {}).messages;
      const systemMsg = (sys || []).find((m) => m.role === 'system');
      const line = ((systemMsg && systemMsg.content) || '').match(
        /CURRENT CONVERSATION STYLE[^\n]*/
      );
      return { line: line ? line[0] : '' };
    };

    const plain = await styleOf('hi');
    ok('a first message gets the default style', /:\s*normal\b/.test(plain.line), plain.line.slice(0, 60));

    const gf = await styleOf('Talk to me like my girlfriend.');
    ok('"talk to me like my girlfriend" sets partner style', /partner \(girlfriend-style\)/i.test(gf.line), gf.line.slice(0, 70));

    const kept = await styleOf('I had a bad day.', [
      { role: 'user', content: 'Talk to me like my girlfriend.' },
      { role: 'ai', content: 'Of course, love.' },
    ]);
    ok('the style survives into the next turn', /partner \(girlfriend-style\)/i.test(kept.line), kept.line.slice(0, 70));

    const reset = await styleOf('Stop girlfriend style. Talk normally.', [
      { role: 'user', content: 'Talk to me like my girlfriend.' },
      { role: 'ai', content: 'Of course, love.' },
    ]);
    ok('"stop girlfriend style, talk normally" resets to normal', /:\s*normal\b/.test(reset.line), reset.line.slice(0, 60));

    const friend = await styleOf('Talk like my friend.');
    ok('"talk like my friend" sets friend style', /\bfriend\b/.test(friend.line), friend.line.slice(0, 70));

    const pro = await styleOf('Be professional.', [{ role: 'user', content: 'Be my girlfriend.' }]);
    ok('"be professional" overrides the partner style', /:\s*normal\b/.test(pro.line), pro.line.slice(0, 60));

    // The assistant must not be able to re-program itself: only user turns count.
    const spoof = await styleOf('hi', [{ role: 'ai', content: 'talk to me like my girlfriend' }]);
    ok('an assistant message cannot switch the style', /:\s*normal\b/.test(spoof.line), spoof.line.slice(0, 60));

    // A style must not degrade the answer: the technical path still runs.
    const tech = await styleOf('What is polymorphism?', [{ role: 'user', content: 'Talk to me like my girlfriend.' }]);
    ok('a technical question still runs in the chosen style', /partner \(girlfriend-style\)/i.test(tech.line), tech.line.slice(0, 70));
  }

  console.log('\n8) Personal facts stated by the user are re-stated to the model');
  {
    const factsFor = async (question, history) => {
      const r = await runChat({ question, history });
      if (r.error) return { error: r.error };
      const messages = ((r.calls[0] || {}).messages) || [];
      const systemMsg = messages.find((m) => m.role === 'system');
      const content = (systemMsg && systemMsg.content) || '';
      const m = content.match(/KNOWN PERSONAL FACTS[^]*?directly\./);
      return { block: m ? m[0] : '', content };
    };

    const f = await factsFor("What's my friend's name?", [
      { role: 'user', content: 'My friend name is Karri and I love cricket.' },
    ]);
    ok(
      'a stated fact reaches the next turn',
      /\nKNOWN PERSONAL FACTS/.test(f.content) && /friend name = Karri/.test(f.content),
      (f.content.match(/friend name = \w+/) || ['(no fact)'])[0]
    );
    ok(
      'the fact is cut at the sentence, not swallowed whole',
      !/friend name = Karri and/i.test(f.content),
      (f.content.match(/friend name = .*/) || ['(none)'])[0].slice(0, 60)
    );

    // The static prompt mentions the block by name, so assert on the block being
    // INJECTED (it always starts its own line) rather than on the phrase.
    const none = await factsFor('hi', []);
    ok('no facts are invented for a fresh chat', !/\nKNOWN PERSONAL FACTS/.test(none.content), 'no block emitted');
  }

  console.log('\n9) A cut-off answer is CONTINUED, not shipped short');
  {
    // The provider hands back only items 1-5 of a requested 10 and admits
    // finish_reason=length via truncated:true. askCareerAssistant must issue an
    // internal continuation turn and merge the remainder — without the user ever
    // seeing an extra message.
    const first = Array.from({ length: 5 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const rest = Array.from({ length: 5 }, (_, i) => `${i + 6}. Item ${i + 6}`).join('\n');
    const r = await runChat({ question: 'give me 10 Java interview questions', replies: [first, rest] });
    ok('a truncated answer does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('a second provider call is made for the remainder', r.calls.length === 2, `${r.calls.length} call(s)`);
    ok('the merged answer contains all 10 items', /Item 10\b/.test(r.answer) && /Item 1\b/.test(r.answer), `${r.answer.replace(/\n/g, ' ').slice(0, 80)}`);
    ok('nothing is duplicated at the seam', (r.answer.match(/Item 6\b/g) || []).length === 1, `${(r.answer.match(/Item 6\b/g) || []).length} occurrence(s)`);
    ok('the continuation turn is not shown to the user as a message', !/INTERNAL CONTINUATION|Continuing…/.test(r.answer));
    ok('the continuation budget is sized to the MISSING items, not all 10', r.calls[1].maxTokens > 0 && r.calls[1].maxTokens <= 900, `continuation=${r.calls[1].maxTokens} tokens for 5 missing items`);
    const contSys = ((r.calls[1] || {}).messages || []).find((m) => m.role === 'system');
    ok('the continuation asks for plain markdown, not JSON', /CONTINUATION TURN/i.test((contSys && contSys.content) || ''), 'continuation system tail present');
  }

  console.log('\n10) The continuation loop is BOUNDED and never loops forever');
  {
    // Every continuation repeats what we already have, so nothing grows: the
    // loop must bail out on the no-growth check instead of spending MAX_CONTINUATIONS
    // calls forever.
    const same = '1. Item 1\n2. Item 2';
    const r = await runChat({ question: 'give me 10 Java interview questions', replies: [same, same, same, same, same, same, same] });
    ok('a non-growing continuation does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('the loop stops early when nothing grows', r.calls.length < 7, `${r.calls.length} call(s) total`);
    ok('the short answer is still returned to the user', r.answer.length > 0, `${r.answer.replace(/\n/g, ' ').slice(0, 40)}`);
    ok('a non-growing continuation is explicitly marked incomplete', r.completion && r.completion.complete === false, JSON.stringify(r.completion));
  }

  console.log('\n11) A failed continuation never destroys the answer we have');
  {
    const first = Array.from({ length: 5 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    // failAfter=1: the first call succeeds, every continuation throws.
    const r = await runChat({ question: 'give me 10 Java interview questions', replies: [first], failAfter: 1 });
    ok('a continuation error does not surface to the user', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('the original partial answer is still returned', /Item 5\b/.test(r.answer), `${r.answer.replace(/\n/g, ' ').slice(0, 60)}`);
    ok('a failed continuation is explicitly marked incomplete', r.completion && r.completion.complete === false, JSON.stringify(r.completion));
  }

  console.log('\n11b) A temporary continuation rate limit resumes automatically');
  {
    const first = Array.from({ length: 77 }, (_, i) => `${i + 1}. LeetCode problem ${i + 1}`).join('\n');
    const rest = Array.from({ length: 23 }, (_, i) => `${i + 78}. LeetCode problem ${i + 78}`).join('\n');
    const limited = new Error('temporary provider rate limit');
    limited.code = 'AI_RATE_LIMITED';
    limited.retryable = true;
    limited.rateLimitKind = 'tokens';
    const r = await runChat({ question: 'give me 100 LeetCode problems', replies: [first, rest], failSequence: [null, limited] });
    ok('a temporary continuation rate limit does not lose the partial answer', r.error === null && /problem 77\b/.test(r.answer));
    ok('automatic retry resumes at the next missing item', /problem 78\b/.test(r.answer) && /problem 100\b/.test(r.answer), `calls=${r.calls.length}`);
    const numbers = [...r.answer.matchAll(/^\s*(\d+)\./gm)].map((m) => Number(m[1]));
    ok('automatic retry preserves continuous numbering without duplicates',
      numbers.length === 100 && numbers.every((n, i) => n === i + 1) && new Set(numbers).size === 100,
      `${numbers.length} numbered items`);
    ok('automatic retry reports complete 100/100 progress', r.completion && r.completion.complete === true
      && r.completion.produced === 100 && r.completion.target === 100, JSON.stringify(r.completion));
  }

  console.log('\n12) A fully complete answer costs exactly ONE provider call');
  {
    const complete = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const r = await runChat({ question: 'give me 10 Java interview questions', replies: [complete] });
    ok('no wasted continuation call when the answer is already complete', r.calls.length === 1, `${r.calls.length} call(s)`);
    ok('the answer is passed through untouched', /Item 10\b/.test(r.answer));
    ok('a complete answer carries a complete status', r.completion && r.completion.complete === true, JSON.stringify(r.completion));
  }

  console.log('\n12b) On a LARGE request the continuation is cheaper than the first pass');
  {
    // The first turn pays for the whole hundred; a continuation that only needs
    // the last few must not pay for the whole hundred again.
    const Q = 'give me 100 Java interview questions';
    const partial = Array.from({ length: 95 }, (_, i) => `${i + 1}. Q${i + 1}`).join('\n');
    const rest = Array.from({ length: 5 }, (_, i) => `${i + 96}. Q${i + 96}`).join('\n');
    const r = await runChat({ question: Q, replies: [partial, rest] });
    ok('the large request is continued after 95 of 100', r.calls.length === 2, `${r.calls.length} call(s)`);
    ok('the first pass gets a large budget', r.calls[0].maxTokens > 4000, `first=${r.calls[0].maxTokens}`);
    ok('the continuation for 5 missing items is much cheaper', r.calls[1].maxTokens < r.calls[0].maxTokens / 2, `first=${r.calls[0].maxTokens} continuation=${r.calls[1].maxTokens}`);
    ok('the merged answer reaches item 100', /100\.\s|Q100/.test(r.answer) && /99\.\s|Q99/.test(r.answer), r.answer.replace(/\n/g, ' ').slice(-60));
  }

  console.log('\n13) A word-count request that comes up short is continued too');
  {
    const shortWords = 'Java virtual machines. '.repeat(60); // ~180 words of 500
    const moreWords = 'Extra explanation. '.repeat(200);
    const r = await runChat({ question: 'explain the JVM in 500 words', replies: [shortWords, moreWords] });
    ok('a short word-count answer is continued', r.calls.length === 2, `${r.calls.length} call(s)`);
    const contUser = ((r.calls[1] || {}).messages || []).slice(-1)[0];
    ok('the continuation is sent as an internal user turn', /INTERNAL CONTINUATION/.test(String((contUser && contUser.content) || '')), 'instruction present');
    ok('the internal instruction is never part of the returned answer', !/INTERNAL CONTINUATION/.test(r.answer));
  }

  console.log('\n14) A PARTIAL LAST ROW is detected from its CONTENT and continued (regression)');
  {
    // The live-run product bug: "give multiplication tables from 1 to 20" came
    // back with every marker 1..20 present, but row 20 stopped at "20x10=200".
    // The provider did not even report truncated — the content rule (products
    // must verify C=N×k and reach the request's own bound) is what fires here.
    // The continuation re-emits the same row complete; the seam-join must glue
    // the missing multipliers onto the SAME line, de-duped, reaching 20x20=400.
    const row = (n, maxK) =>
      `${n}: ${Array.from({ length: maxK }, (_, k) => `${n}x${k + 1}=${n * (k + 1)}`).join(' ')}`;
    const full19 = Array.from({ length: 19 }, (_, i) => row(i + 1, 20)).join('\n');
    const cut = `${full19}\n${row(20, 10)}`;
    const complete = `${full19}\n${row(20, 20)}`;
    const r = await runChat({
      question: 'give multiplication tables from 1 to 20',
      replies: [cut, row(20, 20)],
    });
    ok('a partial-row answer does not throw', r.error === null, r.error ? `${r.error.name}: ${r.error.message}` : 'clean run');
    ok('the partial row triggers exactly ONE continuation call', r.calls.length === 2, `${r.calls.length} call(s)`);
    ok('the merged answer reaches 20x20=400', /20x20=400/.test(r.answer), r.answer.replace(/\n/g, ' ').slice(-80));
    const rowLines = r.answer.split('\n').filter((l) => /^20:/.test(l));
    ok('the finished row reads as ONE line (seam-joined, not duplicated)', rowLines.length === 1, `${rowLines.length} "20:" line(s)`);
    ok('the seam de-duplicates the re-emitted prefix', (r.answer.match(/20x10=200/g) || []).length === 1, `${(r.answer.match(/20x10=200/g) || []).length} occurrence(s)`);
    ok('no multiplier is repeated', (r.answer.match(/20x11=220/g) || []).length === 1, `${(r.answer.match(/20x11=220/g) || []).length} occurrence(s)`);
    const contUser = ((r.calls[1] || {}).messages || []).slice(-1)[0];
    ok('the continuation names row 20 and the missing multipliers', /row 20/.test(String((contUser && contUser.content) || '')), 'prompt names the row');
    // The whole-row-complete answer must NOT trigger anything.
    const done = await runChat({ question: 'give multiplication tables from 1 to 20', replies: [complete] });
    ok('a fully complete rows answer costs exactly one call', done.calls.length === 1, `${done.calls.length} call(s)`);
  }

  console.log('\n15) A provider that ADMITS truncation gets a second chance even if markers look complete');
  {
    // All 10 markers are present, so the OLD trigger (`if (check.complete) break;`)
    // read "complete" and shipped a short answer in one call. A provider that
    // reports finish_reason=length is now decisive: the loop runs at least one
    // more time and keeps whatever new content arrives (bounded by the no-growth
    // guard), because a row can be present while its CONTENT is still cut off.
    const full = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const r = await runChat({
      question: 'give me 10 Java interview questions',
      replies: [{ content: full, truncated: true }, '11. Item 11\n12. Item 12'],
    });
    ok('a truncated-but-complete-marked answer still continues once', r.calls.length === 2, `${r.calls.length} call(s) (old trigger: 1)`);
    ok('the extra content is merged in', /Item 12/.test(r.answer), r.answer.replace(/\n/g, ' ').slice(-60));
    ok('previously delivered items are not duplicated', (r.answer.match(/Item 1\b/g) || []).length === 1, `${(r.answer.match(/Item 1\b/g) || []).length} occurrence(s)`);
    ok('the loop stops after the continuation when it is no longer truncated', r.calls.length === 2, `${r.calls.length} call(s)`);
  }

  console.log('\n16) A continuation is pinned to the provider that answered (same provider first)');
  {
    // The first pass was rescued by the FALLBACK provider (say, openai). The
    // continuation must carry preferProvider/preferModel = that SAME provider —
    // the dead primary is never re-probed mid-answer.
    const Q = 'give me 10 Java interview questions';
    const first = Array.from({ length: 5 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
    const rest = Array.from({ length: 5 }, (_, i) => `${i + 6}. Item ${i + 6}`).join('\n');
    const r = await runChat({
      question: Q,
      replies: [
        { content: first, truncated: true, provider: 'openai', model: 'gpt-test-mini' },
        { content: rest, truncated: false, provider: 'openai', model: 'gpt-test-mini' },
      ],
    });
    ok('the continuation runs (both passes merged)', r.error === null && /Item 10\b/.test(r.answer), r.error ? `${r.error.name}: ${r.error.message}` : 'merged');
    ok('the continuation carries the SAME provider as the first answer', r.calls[1] && r.calls[1].preferProvider === 'openai', r.calls[1] ? `preferProvider=${r.calls[1].preferProvider}` : '(no 2nd call)');
    ok('the continuation also pins the same model', r.calls[1] && r.calls[1].preferModel === 'gpt-test-mini', r.calls[1] ? `preferModel=${r.calls[1].preferModel}` : '');
    const noPin = await runChat({ question: 'hi', replies: [] });
    ok('a fresh turn with no provider info pins nothing', noPin.calls.length === 1 && noPin.calls[0].preferProvider === '', noPin.calls[0] ? `preferProvider=${noPin.calls[0].preferProvider}` : '(no call)');
  }

  console.log('\n17) General-assistant layering: emotional routing, language rule, no doc drag-in');
  {
    // The runChat harness stubs the provider, so these assertions verify what
    // the REAL pipeline would send to the model — no quota, no server needed.
    const sysOf = async (question, history = []) => {
      const r = await runChat({ question, history });
      if (r.error) return { error: r.error };
      const sys = ((r.calls[0] || {}).messages || []).find((m) => m.role === 'system');
      return { error: null, system: ((sys && sys.content) || ''), intent: r.intent, calls: r.calls.length };
    };

    const emo = await sysOf('I failed my interview today');
    ok('an emotional confession does not throw', emo.error === null, emo.error ? emo.error.message : 'clean run');
    ok('"I failed my interview today" routes to EMOTIONAL_SUPPORT, not INTERVIEW', emo.intent === 'EMOTIONAL_SUPPORT', String(emo.intent));
    ok('the empathetic per-intent tail is injected into the system prompt', /PERSONAL, EMOTIONAL MOMENT/i.test(emo.system), 'emotional tail present');
    ok('an emotional message costs exactly ONE provider call', emo.calls === 1, `${emo.calls} call(s)`);
    ok('an emotional message carries NO knowledge-base block', !/USER KNOWLEDGE BASE/.test(emo.system), 'no RAG block');
    ok('the system prompt carries the language-matching rule', /reply in the language the user writes in/i.test(emo.system), 'language line');

    const emoHistory = await sysOf('I am stressed', [{ role: 'user', content: 'I failed my interview today' }, { role: 'ai', content: 'That sounds rough, I am sorry. Tell me about it.' }]);
    ok('the emotional frame survives into the next turn', emoHistory.intent === 'EMOTIONAL_SUPPORT' && /PERSONAL, EMOTIONAL MOMENT/i.test(emoHistory.system), String(emoHistory.intent));

    const tech = await sysOf('give me 10 interview questions');
    ok('a plain quantity request stays INTERVIEW', tech.intent === 'INTERVIEW', String(tech.intent));
    ok('a plain quantity request gets NO emotional tail', !/PERSONAL, EMOTIONAL MOMENT/i.test(tech.system), 'no emotional tail');

    const gf = await sysOf('Talk to me like my girlfriend. I had a bad day.');
    ok('style + emotion in ONE message applies BOTH layers', /partner \(girlfriend-style\)/i.test(gf.system) && /PERSONAL, EMOTIONAL MOMENT/i.test(gf.system), 'style + emotional tail');

    const greet = await sysOf('hi');
    ok('a greeting stays GENERAL (assistant-first, not career-first)', greet.intent === 'GENERAL', String(greet.intent));
    ok('a greeting gets no emotional tail either', !/PERSONAL, EMOTIONAL MOMENT/i.test(greet.system), 'no emotional tail');
  }

  console.log('\n' + '='.repeat(56));
  if (failed) {
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`ALL ${passed} ASSERTIONS PASSED`);
  process.exit(0);
};

main().catch((err) => {
  console.error('\nchatPathTest.js itself crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});