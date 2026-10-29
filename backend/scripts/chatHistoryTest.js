// Offline unit suite for the chat-history layer added for the ChatGPT-style
// sidebar: pagination bounds, meaningful-title retitling, and the sidebar
// mapping shape. No MongoDB, no network, no AI key — it only exercises the pure
// helpers in chatController.js (requiring the module is safe; nothing connects).
const {
  isTrivialTitle,
  retitleIfTrivial,
  pageParams,
  mapChat,
  summarizeTitle,
} = require('../controllers/chatController');

let passed = 0;
let failed = 0;
const failures = [];

const ok = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const eq = (name, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (same) console.log(`  OK   ${name} -> ${JSON.stringify(actual)}`);
};

console.log('\n1) Trivial-title detection (greetings must not name conversations)');
ok('empty title is trivial', isTrivialTitle(''));
ok('"hi" is trivial', isTrivialTitle('hi'));
ok('"hello" is trivial', isTrivialTitle('hello'));
ok('"hey!" is trivial', isTrivialTitle('hey!'));
ok('"good morning" is trivial', isTrivialTitle('good morning'));
ok('"thanks" is trivial', isTrivialTitle('thanks'));
ok('"ok" is trivial (2 chars)', isTrivialTitle('ok'));
ok('"what is Java?" is NOT trivial', !isTrivialTitle('what is Java?'));
ok('"write a java program" is NOT trivial', !isTrivialTitle('write a java program'));
ok('"I failed my interview" is NOT trivial', !isTrivialTitle('I failed my interview'));

console.log('\n2) Retitling: a greeting-only conversation is named by the first real question');
{
  const chat = {
    title: 'hi',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ],
  };
  retitleIfTrivial(chat);
  eq('a single user turn keeps the greeting title', chat.title, 'hi');

  chat.messages.push({ role: 'user', content: 'write a java program to count letter case transitions' });
  retitleIfTrivial(chat);
  eq('the second user turn renames the chat to the 48-char summary', chat.title, summarizeTitle('write a java program to count letter case transitions'));
  ok('renamed title stays within 48 chars', chat.title.length === 48, chat.title);

  retitleIfTrivial(chat);
  eq('a meaningful title is never retitled again', chat.title, summarizeTitle('write a java program to count letter case transitions'));
}

{
  const chat = {
    title: summarizeTitle('what is Java?'),
    messages: [
      { role: 'user', content: 'what is Java?' },
      { role: 'assistant', content: 'Java is…' },
      { role: 'user', content: 'explain polymorphism too' },
    ],
  };
  retitleIfTrivial(chat);
  eq('a meaningful first question is never replaced', chat.title, 'what is Java?');
}

// Mirrors the real flow: retitle runs at EVERY send, so by the time a second
// substantive question arrives the chat already has a meaningful title.
{
  const chat = {
    title: 'hi',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }],
  };
  retitleIfTrivial(chat);
  chat.messages.push({ role: 'user', content: 'give me 10 interview questions'.repeat(10) });
  retitleIfTrivial(chat);
  ok('a long request becomes a truncated 48-char title', chat.title.length === 48, chat.title);
  ok('long title keeps the "…" ellipsis', chat.title.endsWith('…'), chat.title);
}

console.log('\n3) Pagination bounds (page/limit are read defensively)');
eq('defaults -> page 1 limit 10', pageParams({ query: {} }), { page: 1, limit: 10, skip: 0 });
eq('explicit values pass through', pageParams({ query: { page: '3', limit: '25' } }), { page: 3, limit: 25, skip: 50 });
eq('page 0 clamps to 1', pageParams({ query: { page: '0' } }), { page: 1, limit: 10, skip: 0 });
eq('negative page clamps to 1', pageParams({ query: { page: '-2' } }), { page: 1, limit: 10, skip: 0 });
eq('garbage page clamps to 1', pageParams({ query: { page: 'abc' } }), { page: 1, limit: 10, skip: 0 });
eq('limit above 50 clamps to 50', pageParams({ query: { limit: '999' } }), { page: 1, limit: 50, skip: 0 });
eq('limit 0 falls back to the default of 10', pageParams({ query: { limit: '0' } }), { page: 1, limit: 10, skip: 0 });

console.log('\n4) Sidebar mapping shape (metadata only, never message bodies)');
{
  const chat = {
    _id: 'abc123',
    title: 'what is Java?',
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    createdAt: new Date('2026-10-01T09:00:00Z'),
    messages: [{ role: 'user', content: 'secret content' }, { role: 'assistant', content: 'secret answer' }],
  };
  const mapped = mapChat(chat);
  const iso = (d) => d.toISOString();
  eq('mapped fields (metadata only)', {
    _id: 'abc123',
    title: 'what is Java?',
    messageCount: 2,
    updatedAt: iso(new Date('2026-10-01T10:00:00Z')),
    createdAt: iso(new Date('2026-10-01T09:00:00Z')),
  }, {
    _id: mapped._id,
    title: mapped.title,
    messageCount: mapped.messageCount,
    updatedAt: iso(mapped.updatedAt),
    createdAt: iso(mapped.createdAt),
  });
  ok('the sidebar payload never leaks message bodies', !JSON.stringify(mapped).includes('secret'));
}

console.log('\n5) summarizeTitle keeps 48-char cap');
eq('short title unchanged', summarizeTitle('what is Java?'), 'what is Java?');
ok('long title truncated', summarizeTitle('a'.repeat(100)).length === 48);

console.log(`\nchatHistoryTest: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}