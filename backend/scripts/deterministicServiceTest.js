// Offline tests for the conservative deterministic computation path.
/* eslint-disable no-console */
const assert = require('assert');
const { tryDeterministic, tableNumbers, evaluateArithmetic } = require('../services/deterministicService');

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
ok('percentage is calculated exactly', tryDeterministic('What is 20% of 150?').answer === '30');
ok('percentage increase is calculated exactly', tryDeterministic('Increase 200 by 15%').answer === '230');
ok('HCF is calculated exactly', tryDeterministic('HCF of 12 and 18').answer === '6');
ok('LCM is calculated exactly', tryDeterministic('LCM of 12 and 18').answer === '36');
ok('safe arithmetic evaluates precedence', evaluateArithmetic('2 + 3 * 4') === 14);
ok('division by zero is rejected', evaluateArithmetic('4 / 0') === null);
ok('unit conversion is calculated exactly', tryDeterministic('Convert 2 km to m').answer === '2000 m');
ok('temperature conversion is calculated exactly', tryDeterministic('Convert 0 C to F').answer === '32 f');

console.log(`\nALL ${passed} DETERMINISTIC ASSERTIONS PASSED`);
