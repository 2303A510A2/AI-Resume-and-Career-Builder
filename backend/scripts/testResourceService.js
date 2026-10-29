// Quick sanity check for resourceService (not part of the app).
const { parseStructuredResponse, sanitizeUrl } = require('../services/resourceService');

let ok = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
  if (!cond) process.exitCode = 1;
};

const plain = parseStructuredResponse('Just a normal answer.');
check('plain text -> null', plain === null);

const s = JSON.stringify({
  answer: 'Here are problems.\n\n1. Two Sum - Easy\nFind two numbers that add up to target.',
  resources: [
    { title: 'Two Sum', description: 'Find two numbers that add up to a target.', type: 'leetcode', difficulty: 'Easy', url: 'https://leetcode.com/problems/two-sum/' },
  ],
});
const structured = parseStructuredResponse(s);
check('structured parses', !!structured);
check('answer kept', !!structured && structured.answer.includes('Two Sum'));
check('resource kept', !!structured && structured.resources.length === 1);
check('resource url normalized', !!structured && structured.resources[0].url === 'https://leetcode.com/problems/two-sum/');

const bad = JSON.stringify({
  answer: 'x',
  resources: [
    { title: 'Fake', type: 'leetcode', difficulty: 'Medium', url: 'https://leetcode.com/problems/not-a-real-problem-slug/' },
  ],
});
const badR = parseStructuredResponse(bad);
check('fake leetcode slug dropped', !!badR && badR.resources.length === 0);
check('answer survives dropped resource', !!badR && badR.answer === 'x');

const evil = JSON.stringify({
  answer: 'x',
  resources: [
    { title: 'Evil', url: 'javascript:alert(1)' },
    { title: 'Ok GFG', url: 'https://www.geeksforgeeks.org/' },
    { title: 'Bad domain', url: 'https://phishing.example.com/' },
    { title: 'Bad scheme', url: 'ftp://leetcode.com/two-sum' },
  ],
});
const evilR = parseStructuredResponse(evil);
check('evil urls dropped, gfg kept', !!evilR && evilR.resources.length === 1 && evilR.resources[0].title === 'Ok GFG');
check('gfg normalized to https no www rules', evilR && evilR.resources[0].url.startsWith('https://www.geeksforgeeks.org/'));

const ps = JSON.stringify({
  answer: 'x',
  resources: [{ title: 'Problem Set', type: 'resource', url: 'https://leetcode.com/problemset/' }],
});
const psR = parseStructuredResponse(ps);
check('leetcode /problemset/ allowed', !!psR && psR.resources.length === 1);

const trailingJson = '{ "answer": "hi", "resources": [] } and some trailing words';
check('partial json tolerated', !!parseStructuredResponse(trailingJson));

const fenced = '```json\n{"answer":"fenced works","resources":[]}\n```';
check('fenced json parsed', !!parseStructuredResponse(fenced));

const java = sanitizeUrl('https://docs.oracle.com/en/java/');
check('oracle docs allowed', java === 'https://docs.oracle.com/en/java/');

// Place / travel URLs (safe, canonical shapes only)
const maps = sanitizeUrl('https://www.google.com/maps/search/?api=1&query=Charminar%2C%20Hyderabad');
check('google maps place link kept', maps === 'https://www.google.com/maps/search/?api=1&query=Charminar%2C%20Hyderabad');
check('google non-maps dropped', sanitizeUrl('https://www.google.com/search?q=java') === null);
check('wikipedia article kept', sanitizeUrl('https://en.wikipedia.org/wiki/Hyderabad') === 'https://en.wikipedia.org/wiki/Hyderabad');
check('wikipedia non-article dropped', sanitizeUrl('https://www.wikipedia.org/') === null);
check('unsafe schemes dropped', sanitizeUrl('javascript:alert(1)') === null && sanitizeUrl('data:text/html,x') === null);

const places = JSON.stringify({
  answer: 'x',
  resources: [
    { title: 'Charminar, Hyderabad', type: 'place', url: 'https://www.google.com/maps/search/?api=1&query=Charminar%2C%20Hyderabad' },
    { title: 'Invented hotel', type: 'place', url: 'https://myfakehotel.example.com/' },
  ],
});
const placesR = parseStructuredResponse(places);
check('place type preserved', !!placesR && placesR.resources.length === 1 && placesR.resources[0].type === 'place');

// ---- Sources (optional part of the structured response) ----
const src = JSON.stringify({
  answer: 'x',
  resources: [],
  sources: [
    { title: 'LeetCode Two Sum', url: 'https://leetcode.com/problems/two-sum/', snippet: 'Two Sum — LeetCode' },
    { title: 'GFG', url: 'https://www.geeksforgeeks.org/' },
    { title: 'Bad', url: 'https://bad.example.com/' },
    { title: 'Duplicate', url: 'https://leetcode.com/problems/two-sum/' },
  ],
});
const srcR = parseStructuredResponse(src);
check('sources parsed', !!srcR && Array.isArray(srcR.sources) && srcR.sources.length === 2);
check('source domain normalized', srcR && srcR.sources[0].domain === 'leetcode.com');
check('source url sanitized', srcR && srcR.sources[0].url === 'https://leetcode.com/problems/two-sum/');
check('source title fallback to domain', srcR && !srcR.sources.some((s) => !s.title));

const noSrc = parseStructuredResponse(JSON.stringify({ answer: 'plain', resources: [] }));
check('sources empty when absent', !!noSrc && Array.isArray(noSrc.sources) && noSrc.sources.length === 0);

console.log(ok || 'done');