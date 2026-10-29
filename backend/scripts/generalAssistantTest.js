// Deterministic regression suite for the GENERAL-ASSISTANT behaviour of the
// chat pipeline (the "make it feel like a real AI assistant, not a career
// chatbot" contract). Everything here runs OFFLINE: no LLM call, no MongoDB,
// no network. It exercises the REAL layers that the chat endpoint uses:
//
//   intentService.detectIntent       -> routing (intents, needsWeb, signals)
//   ragService.DOCUMENT_INTENTS /
//   ragService.DOCUMENT_HINT_RE      -> RAG gating ("only relevant" rule)
//   ragService.pickMaxTokens         -> the REAL dynamic output budget
//   outputRequirements.analyzeRequest /
//   buildDirective / planOutput      -> quantity/length/format fulfilment
//
// The prompt-construction layers (style, personal facts, emotional tail,
// language rule) are asserted in chatPathTest.js section 17, which runs the
// actual askCareerAssistant with a stubbed provider. This file and that
// harness together are the deterministic half of §32's TEST 1-20 mapping.
//
// Run: node scripts/generalAssistantTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { detectIntent } = require('../services/intentService');
const ragService = require('../services/ragService');
const {
  analyzeRequest,
  planOutput,
  buildDirective,
} = require('../services/outputRequirements');

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

// The RAG gate the real pipeline applies: retrieval runs ONLY when documents
// are genuinely the subject (intent is document-scoped, a file is attached, or
// the question explicitly names "the document").
const wantsDocuments = (q) =>
  ragService.DOCUMENT_INTENTS.has(detectIntent(q).intent) ||
  ragService.DOCUMENT_HINT_RE.test(String(q || ''));

const reqOf = (question, history = []) => analyzeRequest({ question, history });

const main = () => {
  console.log('\n1) General assistant FIRST — greetings, general knowledge, casual chat (§1 §2 §5 §12 §29)');
  {
    const cases = [
      ['"hi"', 'hi', 'GENERAL', false],
      ['"how are you?"', 'how are you?', 'GENERAL', false],
      ['"talk to me"', 'talk to me', 'GENERAL', false],
      ['"what is Java?"', 'what is Java?', 'GENERAL', false],
      ['"what is blockchain?"', 'what is blockchain?', 'GENERAL', false],
      ['"explain polymorphism"', 'explain polymorphism', 'CODING', false],
      ['"give SQL queries"', 'give SQL queries', 'CODING', false],
      ['"write Python code to reverse a string"', 'write Python code to reverse a string', 'CODING', false],
      ['"tell me a joke"', 'tell me a joke', 'GENERAL', false],
      ['"I am confused"', 'I am confused', 'GENERAL', false],
      ['"help me study"', 'help me study', 'LEARNING', false],
      ['"solve this problem"', 'solve this problem', 'LEETCODE', false],
      ['"give me 20 Java programs"', 'give me 20 Java programs', 'CODING', false],
    ];
    for (const [label, q, want, wantWeb] of cases) {
      const r = detectIntent(q);
      ok(`${label} -> ${want}`, r.intent === want, `${r.intent} (needsWeb=${r.needsWeb})`);
      ok(`${label} is never a web-search trigger`, r.needsWeb === wantWeb, `needsWeb=${r.needsWeb}`);
      ok(`${label} never drags in the user's documents`, wantsDocuments(q) === false, 'no RAG');
    }
  }

  console.log('\n2) Emotional / personal moments are routed, never career-lectured (§3 §4 §32 TEST 3/4)');
  {
    const emotional = [
      'Today I had an incident.',
      'I failed my interview today.',
      "I'm so stressed about my exams.",
      'My dog died today.',
      "I'm feeling sad.",
      'I had a bad day.',
      'I failed my coding interview, how do I improve?',
      'I am feeling very anxious.',
      'My best friend betrayed me yesterday.',
    ];
    for (const q of emotional) {
      const r = detectIntent(q);
      ok(`"${q}" -> EMOTIONAL_SUPPORT`, r.intent === 'EMOTIONAL_SUPPORT', `${r.intent} (signals=${r.signals.join(',')})`);
      ok(`"${q}" must never inject documents`, wantsDocuments(q) === false, 'no RAG');
    }
    // Counter-examples that share words but are NOT emotional moments.
    const notEmotional = [
      ['"give me 10 interview questions"', 'INTERVIEW'],
      ['"I have an interview tomorrow"', 'INTERVIEW'],
      ['"write Java code for palindrome"', 'CODING'],
      ['"talk to me like my girlfriend"', 'GENERAL'],
      ['"explain Java inheritance"', 'CODING'],
      ['"give me 20 Java programs"', 'CODING'],
      ['"what is Java?"', 'GENERAL'],
      ['"explain to me how arrays work"', 'DSA'],
    ];
    for (const [label, want] of notEmotional) {
      const q = label.replace(/^"|"$/g, '');
      const r = detectIntent(q);
      ok(`${label} stays a technical/general intent`, r.intent === want, `${r.intent}`);
    }
  }

  console.log('\n3) RAG is gated — documents only when they are the subject (§12 §15 §32 TEST 15/16)');
  {
    const yes = [
      ['analyze my resume', 'RESUME'],
      ['what skills am I missing for this job?', 'CAREER + document hint'],
      ['compare my resume with this job description', 'DOCUMENT_ANALYSIS'],
      ['improve this resume', 'RESUME'],
      ['find errors in this document', 'resource wording + document hint'],
    ];
    for (const [q, detail] of yes) {
      ok(`"${q}" uses documents (${detail})`, wantsDocuments(q) === true, detectIntent(q).intent);
    }
    const no = [
      'hi',
      'what is Java?',
      'explain SQL',
      'give me 10 Python programs',
      'what is blockchain?',
      'tell me a joke',
      'who is Jonathan Gaming?',
      'I had a bad day',
      'give me multiplication tables from 1 to 10',
    ];
    for (const q of no) {
      ok(`"${q}" never touches documents`, wantsDocuments(q) === false, detectIntent(q).intent);
    }
  }

  console.log('\n4) Quantity and length are understood, not guessed (§7 §8 §9 §32 TEST 8/9/10)');
  {
    let r = reqOf('give me 20 Java programs');
    ok('"20 Java programs" -> 20 items', r.itemCount === 20, `itemCount=${r.itemCount}`);
    ok('... unit = program', r.unit === 'program', `unit=${r.unit}`);

    r = reqOf('give multiplication tables from 1 to 10');
    ok('"tables 1 to 10" -> range 1..10', r.range && r.range.from === 1 && r.range.to === 10, JSON.stringify(r.range));
    ok('... itemCount = 10', r.itemCount === 10, `itemCount=${r.itemCount}`);

    r = reqOf('give me 100 interview questions');
    ok('"100 interview questions" -> itemCount 100', r.itemCount === 100, `itemCount=${r.itemCount}`);

    r = reqOf('explain Java in 1000 words');
    ok('"in 1000 words" -> wordCount 1000', r.wordCount === 1000, `wordCount=${r.wordCount}`);

    r = reqOf('give me only code');
    ok('"give me only code" -> code-only', r.codeOnly === true && r.format === 'code-only', `format=${r.format}`);

    r = reqOf('answer in one line');
    ok('"answer in one line" -> short format', r.format === 'short', `format=${r.format}`);

    r = reqOf('compare Java and Python');
    ok('"compare Java and Python" -> comparison format', r.format === 'comparison', `format=${r.format}`);

    r = reqOf('give me a timetable');
    ok('"give me a timetable" -> table format', r.format === 'table', `format=${r.format}`);

    // The REAL dynamic budget (ragService.pickMaxTokens) must be huge for
    // volume requests and never silently cap them low.
    const cap = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 32768);
    const budget100 = ragService.pickMaxTokens('CODING', reqOf('give me 100 interview questions'));
    ok('100 questions gets a real budget (>6000)', budget100 > 6000, `maxTokens=${budget100}`);
    ok('the budget respects the absolute cap', budget100 <= cap, `${budget100} <= ${cap}`);
    const budgetWords = ragService.pickMaxTokens('GENERAL', reqOf('explain Java in 1000 words'));
    ok('1000 words gets a >2000-token budget', budgetWords > 2000, `maxTokens=${budgetWords}`);
    ok('the word budget stays under the cap', budgetWords <= cap, `${budgetWords} <= ${cap}`);
    const budget20 = ragService.pickMaxTokens('CODING', reqOf('give me 20 Java programs'));
    ok('20 programs gets a >4000-token budget (programs are heavy)', budget20 > 4000, `maxTokens=${budget20}`);
    const budgetHi = ragService.pickMaxTokens('GENERAL', reqOf('hi'));
    ok('a greeting stays a cheap, normal conversational budget', budgetHi >= 500 && budgetHi <= 1200, `maxTokens=${budgetHi}`);
    const budgetCode = ragService.pickMaxTokens('CODING', reqOf('give me only code'));
    ok('code-only stays a small, sharp budget', budgetCode <= 500, `maxTokens=${budgetCode}`);
  }

  console.log('\n5) The fulfilment directives say exactly what was asked (§8 §9)');
  {
    const d = buildDirective(reqOf('give me 20 Java programs'));
    ok('20 programs directive says EXACTLY 20', /EXACTLY 20 programs/.test(d), d.replace(/\n/g, ' ').slice(0, 90));
    const dw = buildDirective(reqOf('explain Java in 1000 words'));
    ok('1000 words directive says approximately 1000', /approximately 1000 words/.test(dw), dw.replace(/\n/g, ' ').slice(0, 90));
    const dc = buildDirective(reqOf('give me only code'));
    ok('code-only directive demands only code', /output ONLY the code/i.test(dc), dc.replace(/\n/g, ' ').slice(0, 90));
  }

  console.log('\n6) Follow-ups read the previous answer (§10 §32 TEST 11/12/13)');
  {
    const history = [
      { role: 'user', content: 'give me 10 Java interview questions' },
      { role: 'ai', content: '1. Q1\n2. Q2\n3. Q3\n4. Q4\n5. Q5\n6. Q6\n7. Q7\n8. Q8\n9. Q9\n10. Q10' },
    ];
    let r = reqOf('10 more', history);
    ok('"10 more" is a continuation', r.isContinuation === true, `isContinuation=${r.isContinuation}`);
    ok('"10 more" adds exactly 10', r.itemCount === 10, `itemCount=${r.itemCount}`);
    ok('"10 more" continues from 11', r.continueFrom === 11, `continueFrom=${r.continueFrom}`);

    r = reqOf('make it 20', history);
    ok('"make it 20" targets a total of 20', r.targetTotal === 20, `targetTotal=${r.targetTotal}`);
    ok('"make it 20" needs 10 more (11..20)', r.itemCount === 10 && r.continueFrom === 11, `itemCount=${r.itemCount} from=${r.continueFrom}`);
    ok('"make it 20" directive never restarts at 1', /numbered 11 to 20/.test(buildDirective(r)), buildDirective(r).replace(/\n/g, ' ').slice(0, 110));

    r = reqOf('explain number 5', history);
    ok('"explain number 5" is an explanation, not a fresh list', r.format === 'explanation', `format=${r.format}`);

    r = reqOf('continue', history);
    ok('bare "continue" is a continuation', r.isContinuation === true, `isContinuation=${r.isContinuation}`);
  }

  console.log('\n7) Entity lookups use the web; memory lookups never do (§11 §21 §32 TEST 14/21)');
  {
    let r = detectIntent('who is Jonathan Gaming?');
    ok('"who is Jonathan Gaming?" triggers live web', r.needsWeb === true, `needsWeb=${r.needsWeb}`);
    ok('... and stays a normal knowledge answer (no docs, no career)', r.intent === 'GENERAL' && wantsDocuments('who is Jonathan Gaming?') === false, r.intent);

    r = detectIntent('who is Elon Musk?');
    ok('"who is Elon Musk?" triggers live web', r.needsWeb === true, `needsWeb=${r.needsWeb}`);

    r = detectIntent('who is my friend?');
    ok('"who is my friend?" never searches the web', r.needsWeb === false, `needsWeb=${r.needsWeb}`);

    r = detectIntent('who is Karri?', [{ role: 'user', content: "My friend's name is Karri" }]);
    ok('"who is Karri?" (already told) stays MEMORY-first', r.needsWeb === false, `needsWeb=${r.needsWeb}`);

    r = detectIntent('who is Karri?', []);
    ok('an unknown capitalized name is honestly researched', r.needsWeb === true, `needsWeb=${r.needsWeb}`);

    r = detectIntent("Karri's friend is Nithin.");
    ok('a personal-second-hop statement is conversation, not a web search', r.needsWeb === false, `needsWeb=${r.needsWeb}`);

    r = detectIntent('what is the latest Java version?');
    ok('"latest Java version" -> CURRENT_INFORMATION + web', r.intent === 'CURRENT_INFORMATION' && r.needsWeb === true, `${r.intent} needsWeb=${r.needsWeb}`);

    r = detectIntent('give me Java YouTube links');
    ok('"give me Java YouTube links" -> web-backed resources', r.intent === 'RESOURCE_SEARCH' && r.needsWeb === true, `${r.intent} needsWeb=${r.needsWeb}`);
  }

  console.log('\n8) Exam / study register (§19)');
  {
    const study = [
      ['"explain for exam"', 'explain for exam'],
      ['"5 marks answer"', '5 marks answer'],
      ['"give important questions"', 'give important questions'],
      ['"give numerical problems on work energy"', 'give numerical problems on work energy'],
      ['"previous year question paper"', 'previous year question paper'],
    ];
    for (const [label, q] of study) {
      const r = detectIntent(q);
      ok(`${label} -> LEARNING`, r.intent === 'LEARNING', r.intent);
      ok(`${label} gets the exam FORMAT directive`, analyzeRequest({ question: q }).format === 'exam', analyzeRequest({ question: q }).format);
    }
    const r = detectIntent('explain in Telugu');
    ok('"explain in Telugu" is a plain request (language handled by the prompt layer)', r.intent === 'GENERAL' && r.needsWeb === false, `${r.intent} needsWeb=${r.needsWeb}`);
    ok('"explain in Telugu" stays out of the user documents', wantsDocuments('explain in Telugu') === false, 'no RAG');
  }

  console.log('\n9) Personality style commands are routing-neutral (§17 §34 — style never changes WHAT we know)');
  {
    for (const q of ['talk to me like my girlfriend', 'talk like my friend', 'talk normally', 'be professional', 'talk to me like my partner']) {
      const r = detectIntent(q);
      ok(`"${q}" -> GENERAL (style is a prompt layer, not an intent)`, r.intent === 'GENERAL', r.intent);
      ok(`"${q}" never touches documents`, wantsDocuments(q) === false, 'no RAG');
    }
    // A style command + a real technical ask in ONE message still routes technical.
    const r = detectIntent('Talk to me like my girlfriend, then explain Java inheritance.');
    ok('style + technical ask in one message stays technical', r.intent === 'CODING', r.intent);
  }

  console.log('\n10) Budget caps are never exceeded and never undersized (§9)');
  {
    const cap = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 32768);
    const big = ragService.pickMaxTokens('CODING', reqOf('give me 3000 questions'));
    ok('a 3000-item request is clamped to the cap', big <= cap, `${big} <= ${cap}`);
    const hugeWords = ragService.pickMaxTokens('GENERAL', reqOf('explain in 50000 words'));
    ok('a 50000-word request is clamped to the cap', hugeWords <= cap, `${hugeWords} <= ${cap}`);
    ok('the clamp still yields a large budget (>20000)', hugeWords > 20000, `maxTokens=${hugeWords}`);
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

main();