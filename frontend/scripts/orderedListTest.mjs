// Pure renderer contract tests for list markers and blank-line continuity.
import { parseListMarker, shouldKeepListAcrossBlank } from '../src/services/markdownList.js';

let passed = 0;
let failed = 0;
const check = (name, value) => {
  if (value) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
};

check('dot marker', parseListMarker('1. first')?.number === 1);
check('bold marker', parseListMarker('**2.** second')?.number === 2);
check('colon marker', parseListMarker('3: third')?.number === 3);
check('table heading marker', parseListMarker('### Table 4')?.number === 4);
check('unordered marker', parseListMarker('- item')?.type === 'ul');

const lines = ['1. first', '', '2. second', '', '3. third'];
check('blank lines keep one ordered list together', shouldKeepListAcrossBlank(lines, 1, 'ol'));
check('last item does not create a following list', !shouldKeepListAcrossBlank(lines, 4, 'ol'));

console.log(`orderedListTest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
