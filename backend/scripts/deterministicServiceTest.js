// Offline tests for the conservative deterministic computation path.
/* eslint-disable no-console */
const assert = require('assert');
const { tryDeterministic, tableNumbers } = require('../services/deterministicService');

let passed = 0;
const ok = (name, value) => {
  assert(value, name);
  passed += 1;
  console.log(`  OK   ${name}`);
};

const tables = tryDeterministic('Give me 20 multiplication tables');
ok('20 multiplication tables are detected', tables.completion.requested === 20);
ok('20 multiplication tables are complete', tables.completion.complete === true);
ok('table 20 contains 20 x 10 = 200', tables.answer.includes('20 × 10 = 200'));
ok('database tables are not misrouted', tryDeterministic('Design 20 database tables') === null);
ok('custom range is preserved', JSON.stringify(tableNumbers('multiplication tables 5 to 8')) === JSON.stringify([5, 6, 7, 8]));
ok('single table is supported', JSON.stringify(tableNumbers('show the table of 7')) === JSON.stringify([7]));

console.log(`\nALL ${passed} DETERMINISTIC ASSERTIONS PASSED`);
