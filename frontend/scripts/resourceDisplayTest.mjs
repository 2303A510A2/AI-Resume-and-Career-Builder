import { visibleResources } from '../src/services/resourceDisplay.js';

let passed = 0;
let failed = 0;
const check = (name, value) => {
  if (value) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
};

const resources = [
  { type: 'leetcode', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/' },
  { type: 'leetcode', title: 'Majority Element', url: 'https://leetcode.com/problems/majority-element/' },
  { type: 'website', title: 'Java Documentation', url: 'https://docs.oracle.com/' },
];
const answer = '1. Two Sum - [Two Sum](https://leetcode.com/problems/two-sum/)\n2. Majority Element';
const visible = visibleResources(resources, answer);
check('problem cards already present in answer are hidden', visible.length === 1);
check('non-problem cards remain available', visible[0]?.title === 'Java Documentation');
check('a missing problem card remains available', visibleResources(resources, '1. Two Sum').length === 2);

console.log(`resourceDisplayTest: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
