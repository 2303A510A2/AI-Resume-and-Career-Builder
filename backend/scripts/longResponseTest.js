// Deterministic long-response regression suite.
// No MongoDB, network, or provider credentials are required.
/* eslint-disable no-console */
process.env.LLM_MAX_CONTINUATIONS = '12';
process.env.LLM_CONTINUATION_RATE_LIMIT_MAX_WAIT_MS = '1';

const assert = require('assert');
const llmService = require('../services/llmService');
const ragService = require('../services/ragService');

let passed = 0;
const ok = (name, condition, detail = '') => {
  assert(condition, `${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  OK   ${name}`);
};

const numbered = (from, to, label) => {
  const lines = [];
  for (let n = from; n <= to; n += 1) {
    lines.push(`${n}. ${label} ${n} — a distinct, useful entry.`);
  }
  return lines.join('\n');
};

const words = (count) => Array.from({ length: count }, (_, i) => `word${i + 1}`).join(' ');

const run = async ({ question, reply, failAfter = null }) => {
  const calls = [];
  const realChat = llmService.chat;
  llmService.chat = async (options) => {
    calls.push(options);
    if (failAfter !== null && calls.length > failAfter) {
      const error = new Error('mock provider unavailable');
      error.code = 'AI_PROVIDERS_UNAVAILABLE';
      error.retryable = false;
      error.isOperational = true;
      throw error;
    }
    return { content: reply(calls.length), truncated: false, provider: 'mock', model: 'mock' };
  };
  try {
    return await ragService.askCareerAssistant({
      userId: 'long-response-test',
      question,
      history: [],
    });
  } finally {
    llmService.chat = realChat;
  }
};

const chunked = (label, size, total) => (call) => {
  const from = (call - 1) * size + 1;
  return numbered(from, Math.min(total, from + size - 1), label);
};

const main = async () => {
  const tables = await run({
    question: 'Give me 20 multiplication tables.',
    reply: chunked('Multiplication table', 10, 20),
  });
  ok('20 multiplication tables are complete', tables.completion.complete === true);
  ok('20 multiplication tables contain all requested markers', tables.completion.produced === 20);
  ok('table items are distinct', new Set(tables.answer.match(/^\d+\./gm)).size === 20);

  const problems = await run({
    question: 'Give me 100 LeetCode problems to solve.',
    reply: chunked('LeetCode problem', 10, 100),
  });
  ok('100 LeetCode problems are complete', problems.completion.complete === true);
  ok('100 LeetCode problems contain all requested markers', problems.completion.produced === 100);
  ok('100 LeetCode problems do not duplicate markers', (problems.completion.duplicates || []).length === 0);

  const article = await run({
    question: 'Write an article of 1000 words about learning Java.',
    reply: () => words(1000),
  });
  ok('1000-word article meets the requested length', article.completion.complete === true);

  const partial = await run({
    question: 'Give me 20 interview questions.',
    reply: chunked('Interview question', 10, 20),
    failAfter: 1,
  });
  ok('partial output is preserved after a continuation failure', partial.answer.includes('10. Interview question 10'));
  ok('continuation failure is reported as incomplete', partial.completion.complete === false);

  const realChat = llmService.chat;
  const concurrent = [];
  llmService.chat = async ({ messages }) => {
    const question = String(messages[messages.length - 1].content);
    await new Promise((resolve) => setTimeout(resolve, question.includes('alpha') ? 4 : 1));
    return { content: question.includes('alpha') ? 'alpha-only-answer' : 'beta-only-answer', truncated: false };
  };
  try {
    concurrent.push(
      ragService.askCareerAssistant({ userId: 'concurrent-a', question: 'alpha request', history: [] }),
      ragService.askCareerAssistant({ userId: 'concurrent-b', question: 'beta request', history: [] })
    );
    const results = await Promise.all(concurrent);
    ok('concurrent requests remain isolated', results[0].answer === 'alpha-only-answer' && results[1].answer === 'beta-only-answer');
  } finally {
    llmService.chat = realChat;
  }

  console.log(`\nALL ${passed} LONG-RESPONSE ASSERTIONS PASSED`);
};

main().catch((error) => {
  console.error(`\nLONG-RESPONSE TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
