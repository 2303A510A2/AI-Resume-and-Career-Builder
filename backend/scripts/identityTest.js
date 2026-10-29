// Offline regression suite for the ASSISTANT IDENTITY + FRIENDLY-CONVERSATION
// contract. Everything runs in-process with the provider STUBBED: no LLM call,
// no MongoDB, no network. It exercises the REAL layers the chat endpoint uses:
//
//   intentService.detectIntent   -> identity questions route GENERAL, never web,
//                                   never the user's documents
//   ragService.askCareerAssistant -> the shared system prompt that is actually
//                                   sent to the model (identity contract, varied
//                                   introduction, no model/provider disclosure)
//   ragService personal-fact layer -> nickname + friend memory reaches the model
//
// The point: the assistant must identify itself as this app's friendly AI
// companion for EVERY authenticated user, on EVERY path that shares
// askCareerAssistant (chat, /:id/messages, career-assistant, regenerate), and
// must never introduce itself as ChatGPT or reveal provider/model internals —
// while still answering normal questions at full quality.
//
// Run: node scripts/identityTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const llmService = require('../services/llmService');
const { detectIntent } = require('../services/intentService');
const ragService = require('../services/ragService');

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

// The RAG gate the real pipeline applies (documents only when they are the subject).
const wantsDocuments = (q) =>
  ragService.DOCUMENT_INTENTS.has(detectIntent(q).intent) ||
  ragService.DOCUMENT_HINT_RE.test(String(q || ''));

/**
 * Runs askCareerAssistant with the provider stubbed and returns the SYSTEM
 * message the real pipeline would send, plus routing metadata. Nothing is thrown
 * out of the harness — an error is returned so a bug reads as an assertion.
 */
const runChat = async ({ question, history = [] }) => {
  const realChat = llmService.chat;
  const realBrowser = llmService.chatWithBrowserSearch;
  let systemMessage = '';
  let calls = 0;
  const capture = (opts) => {
    calls += 1;
    const sys = ((opts && opts.messages) || []).find((m) => m.role === 'system');
    if (sys) systemMessage = String(sys.content || '');
    return { content: 'STUB ANSWER', truncated: false, provider: 'stub', model: 'stub', toolUsed: false, urls: [] };
  };
  llmService.chat = async (opts) => capture(opts);
  llmService.chatWithBrowserSearch = async (opts) => capture(opts);
  try {
    const r = await ragService.askCareerAssistant({ userId: 'identity-test-user', question, history });
    return { answer: r.answer, intent: r.intent, mode: r.mode, chunkCount: r.chunkCount, system: systemMessage, calls, error: null };
  } catch (err) {
    return { system: systemMessage, calls, error: err };
  } finally {
    llmService.chat = realChat;
    llmService.chatWithBrowserSearch = realBrowser;
  }
};

const main = async () => {
  console.log('\n1) Identity questions: GENERAL, no web search, no document drag-in (§1 §2 §4)');
  {
    const identities = [
      'Who are you?',
      'What is your name?',
      'Are you ChatGPT?',
      'Introduce yourself.',
      'Can you be my friend?',
      'Are you my friend?',
      'Tell me about yourself.',
      'Are you human?',
      'Are you a real person?',
      'Who made you?',
      'What are you?',
      'What should I call you?',
    ];
    for (const q of identities) {
      const r = detectIntent(q);
      ok(`"${q}" -> GENERAL`, r.intent === 'GENERAL', `${r.intent} (signals=${r.signals.join(',')})`);
      ok(`"${q}" never searches the web`, r.needsWeb === false, `needsWeb=${r.needsWeb}`);
      ok(`"${q}" never touches the user's documents`, wantsDocuments(q) === false, 'no RAG');
    }
    // The pronoun-entity regression: "who is this?" must not become a web search.
    ok('"Who is this?" never searches the web', detectIntent('Who is this?').needsWeb === false);
    // ...while a real named entity still does.
    ok('"who is Jonathan Gaming?" still uses the web', detectIntent('who is Jonathan Gaming?').needsWeb === true);
  }

  console.log('\n2) The shared system prompt carries the identity contract (§1 §4)');
  {
    const r = await runChat({ question: 'Who are you?' });
    ok('"Who are you?" does not throw', r.error === null, r.error ? r.error.message : 'clean run');
    ok('"Who are you?" triggers no retrieval (mode=none)', r.mode === 'none' && r.chunkCount === 0, `mode=${r.mode} chunks=${r.chunkCount}`);
    ok('it identifies as this app\'s AI companion', /AI companion|friendly, capable AI assistant/i.test(r.system), 'identity line');
    ok('it is explicitly told NEVER to introduce itself as ChatGPT', /NEVER introduce yourself as "ChatGPT"/i.test(r.system), 'no-ChatGPT rule');
    ok('it must never claim to be human', /NEVER claim to be a human/i.test(r.system), 'no-human rule');
    ok('model/provider names must never be revealed', /no model names, provider\/vendor names/i.test(r.system), 'secrecy rule');
    ok('it must VARY the introduction (never a fixed script)', /VARY the wording every time/i.test(r.system), 'variation rule');
    ok('nickname memory is instructed', /gives YOU a nickname/i.test(r.system), 'nickname rule');
    ok('the anti-ChatGPT rule is also in the strict rules', /never introduce yourself as ChatGPT or as any other AI product/i.test(r.system), 'strict rule 3');
    ok('friendliness never replaces the answer', /friendliness never replaces the answer/i.test(r.system), 'strict rule 6');
  }

  console.log('\n3) Nicknames and personal facts reach the model (§4 §5)');
  {
    const userNick = await runChat({ question: 'call me Bunty', history: [] });
    ok('a user nickname is remembered', /name the user asked you to call them = Bunty/.test(userNick.system), match(userNick.system, /name the user asked you to call them = \w+/));

    const aiNick = await runChat({ question: "I'll call you Max", history: [] });
    ok('a nickname for the assistant is remembered', /nickname the user gave the assistant = Max/.test(aiNick.system), match(aiNick.system, /nickname the user gave the assistant = \w+/));

    const friend = await runChat({
      question: 'Who is my friend?',
      history: [{ role: 'user', content: "My friend's name is Nithin." }],
    });
    ok('"who is my friend?" is a memory question, not a web search', friend.mode === 'none', `mode=${friend.mode}`);
    ok('the friend fact is re-stated to the model', /friend name = Nithin/.test(friend.system), match(friend.system, /friend name = \w+/));

    const namedMem = await runChat({
      question: 'Who is Nithin?',
      history: [{ role: 'user', content: "My friend's name is Nithin." }],
    });
    ok('"who is Nithin?" (already told) never searches the web', namedMem.mode === 'none', `mode=${namedMem.mode}`);
  }

  console.log('\n4) Capabilities are preserved — friendliness never shortens an answer (§3)');
  {
    const java = await runChat({ question: 'What is Java? Explain it simply.' });
    ok('"What is Java? Explain it simply." is a general answer (no docs)', java.mode === 'none' && wantsDocuments('What is Java? Explain it simply.') === false, `mode=${java.mode}`);

    const code = detectIntent('Give me a simple Java program.');
    ok('"Give me a simple Java program." routes to CODING', code.intent === 'CODING', code.intent);

    const emotion = detectIntent("I'm feeling sad today.");
    ok('"I\'m feeling sad today." routes to EMOTIONAL_SUPPORT (warmth first)', emotion.intent === 'EMOTIONAL_SUPPORT', emotion.intent);

    const { analyzeRequest } = require('../services/outputRequirements');
    const words = analyzeRequest({ question: 'Explain this topic in 1000 words.' });
    ok('"in 1000 words" is understood as a length target', words.wordCount === 1000, `wordCount=${words.wordCount}`);
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

const match = (text, re) => {
  const m = String(text || '').match(re);
  return m ? m[0] : '(none)';
};

main().catch((err) => {
  console.error('\nidentityTest.js itself crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
