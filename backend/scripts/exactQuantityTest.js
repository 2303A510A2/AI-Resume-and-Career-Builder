// Deterministic exact-quantity and duplicate-content regression tests.
// Run: node scripts/exactQuantityTest.js
/* eslint-disable no-console */
const {
  analyzeRequest,
  checkCompleteness,
  mergeContinuation,
} = require('../services/outputRequirements');

let passed = 0;
let failed = 0;
const check = (name, value, detail = '') => {
  if (value) {
    passed += 1;
    console.log(`  OK   ${name}${detail ? ` :: ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const requests = [
  ['Give me 5 LeetCode problems', 5],
  ['Give me 10 LeetCode problems', 10],
  ['Give me 20 LeetCode problems', 20],
  ['Give me 50 LeetCode problems', 50],
  ['Give me 100 LeetCode problems', 100],
  ['Give me 50 aptitude questions', 50],
  ['Give me 100 Java examples', 100],
];

for (const [question, count] of requests) {
  const req = analyzeRequest({ question });
  const answer = Array.from({ length: count }, (_, i) => `${i + 1}. Unique item ${i + 1}`).join('\n\n');
  const result = checkCompleteness(answer, req);
  check(`${count} requested items are detected`, req.itemCount === count);
  check(`${count} unique numbered items are complete`, result.complete, result.reason);
  const duplicate = checkCompleteness(`${answer}\n\n${count + 1}. Unique item 1`, req);
  check(`${count} duplicate content is rejected`, !duplicate.complete && duplicate.duplicateItems?.length > 0);
}

{
  const req = analyzeRequest({ question: 'Give me 20 LeetCode problems' });
  const partial = Array.from({ length: 10 }, (_, i) => `${i + 1}. Problem ${i + 1}`).join('\n');
  const rest = Array.from({ length: 10 }, (_, i) => `${i + 1}. Problem ${i + 11}`).join('\n');
  const merged = mergeContinuation(partial, rest, { from: 11, to: 20 });
  const result = checkCompleteness(merged, req);
  check('a restarted continuation is renumbered and complete', result.complete, result.reason);
}

{
  const req = analyzeRequest({ question: 'Give me 10 LeetCode problems' });
  const partial = Array.from({ length: 5 }, (_, i) => `${i + 1}. Problem ${i + 1}`).join('\n');
  const mixed = '6. Majority Element\n1. Problem 7\n2. Problem 8\n3. Problem 9\n4. Problem 10';
  const merged = mergeContinuation(partial, mixed, { from: 6, to: 10 });
  const result = checkCompleteness(merged, req);
  check('a mixed global/local continuation stays continuous', result.complete, result.reason);
}

console.log(`\nexactQuantityTest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
