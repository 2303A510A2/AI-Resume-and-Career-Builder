// Deterministic unit tests for the general output-requirement engine.
//
// Run: node scripts/outputRequirementsTest.js
// (no network, no provider key, no database — pure text analysis)
//
// This is the regression suite for "the AI must deliver exactly what was asked":
// quantity detection (N items, ranges), word-count requests, format selection,
// the dynamic output-token budget, the completeness check, and the
// non-duplicating continuation merge. Nothing here is subject-specific, so a
// regression means the engine stopped understanding *quantities and formats*
// in general — not one particular question.
//
//   node scripts/outputRequirementsTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  analyzeRequest,
  planOutput,
  buildDirective,
  checkCompleteness,
  buildContinuationPrompt,
  mergeContinuation,
  wordCount,
  numberedRuns,
  numberedProgress,
  bulletCount,
} = require('../services/outputRequirements');

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

const req = (q, history = []) => analyzeRequest({ question: q, history });

console.log('\n1) Quantity requests — exact counts');
eq('20 leetcode problems', pick(req('give 20 LeetCode problems')), { count: 20, unit: 'problem' });
eq('50 interview questions', pick(req('give 50 interview questions')), { count: 50, unit: 'question' });
eq('100 java interview questions', pick(req('give me 100 Java interview questions')), { count: 100, unit: 'question' });
eq('10 examples', pick(req('give 10 examples')), { count: 10, unit: 'example' });
eq('30 programs', pick(req('give me 30 programs')), { count: 30, unit: 'program' });
eq('25 test cases', pick(req('write 25 test cases')), { count: 25, unit: 'testcase' });
eq('first 10 (no unit noun)', pick(req('give me the first 10')), { count: 10 });

console.log('\n2) Quantity requests — ranges (all natural phrasings)');
eq('tables from 1 to 10', pick(req('give multiplication tables from 1 to 10')), { count: 10, unit: 'table', from: 1, to: 10 });
eq('tables 1-10', pick(req('give tables 1-10')), { count: 10, unit: 'table', from: 1, to: 10 });
eq('tables 1 to 20', pick(req('multiplication tables 1 to 20')), { count: 20, unit: 'table', from: 1, to: 20 });
eq('between 1 and 20', pick(req('give me the numbers between 1 and 20')), { count: 20, from: 1, to: 20 });
eq('all tables till 10', pick(req('give all tables till 10')), { count: 10, unit: 'table', from: 1, to: 10 });
eq('en-dash 1-100 tables', pick(req('tables 1–100 please')), { count: 100, unit: 'table', from: 1, to: 100 });
ok('en-dash range is not mistaken for a word range', !req('write 1-100 words').range);

console.log('\n3) Word-count requests');
eq('1000 words', pick(req('explain Java in 1000 words')), { words: 1000, mode: 'about' });
eq('500 words', pick(req('write 500 words about AI')), { words: 500, mode: 'about' });
eq('200 word intro', pick(req('give a 200 word introduction')), { words: 200, mode: 'about' });
eq('exactly 100 words', pick(req('summarize in exactly 100 words')), { words: 100, mode: 'exact' });
eq('about 2000 words', pick(req('about 2000 words on system design')), { words: 2000, mode: 'about' });
eq('at least 300 words', pick(req('at least 300 words please')), { words: 300, mode: 'atleast' });

console.log('\n4) Format + constraint detection');
eq('table format', req('compare Java and Python in a table').format, 'table');
eq('comparison', req('compare Java and Python').format, 'comparison');
eq('code only', req('give only code for palindrome in Java').format, 'code-only');
eq('code only flag', req('give only the code').codeOnly, true);
eq('no comments', req('write java code, no comments').noComments, true);
eq('mcq', req('give me 10 mcqs on java').format, 'mcq');
eq('steps', req('give step by step steps to install java').format, 'steps');
eq('json', req('give me 5 examples in json').format, 'json');
eq('short answer', req('explain java briefly').format, 'short');
eq('detailed', req('explain java in depth').format, 'detailed');

console.log('\n5) Follow-ups / continuations');
{
  const r = req('give me 10 more', [{ role: 'ai', content: '1. a\n2. b\n3. c' }]);
  ok('10 more is a continuation', r.isContinuation);
  eq('10 more -> adds 10 items after item 3', pick(r), { count: 10, from: 4 });
  const g = req('make it 20', [{ role: 'ai', content: '1. a\n2. b\n3. c' }]);
  ok('make it 20 is a continuation', g.isContinuation);
  eq('make it 20 -> total 20', g.targetTotal, 20);
  eq('make it 20 -> adds the missing 17', g.itemCount, 17);
  eq('make it 20 -> continues from 4', g.continueFrom, 4);
  const m = req('give more', [{ role: 'ai', content: '1. a\n2. b\n3. c\n4. d' }]);
  eq('bare "more" mirrors the previous list size', pick(m), { count: 4, from: 5 });
}

console.log('\n6) Dynamic output-token budget');
{
  const short = planOutput(analyzeRequest({ question: 'hi' }));
  const codeOnly = planOutput(req('give only code for palindrome in Java'));
  const w100 = planOutput(req('explain Java in 1000 words'), { cap: 16384 });
  const w2000 = planOutput(req('explain java in 2000 words'), { cap: 16384 });
  const q100 = planOutput(req('give me 100 Java interview questions'), { cap: 16384 });
  const t100 = planOutput(req('multiplication tables from 1 to 100'), { cap: 16384 });
  const plain = planOutput(req('what is Java?'), { cap: 16384 });

  console.log(`  hi                              -> ${short.maxTokens}`);
  console.log(`  only code                      -> ${codeOnly.maxTokens}`);
  console.log(`  explain in 100 words           -> ${planOutput(req('explain in 100 words'), { cap: 16384 }).maxTokens}`);
  console.log(`  explain java in 1000 words     -> ${w100.maxTokens}`);
  console.log(`  explain java in 2000 words     -> ${w2000.maxTokens}`);
  console.log(`  100 java interview questions   -> ${q100.maxTokens}`);
  console.log(`  tables 1..100                  -> ${t100.maxTokens}`);
  console.log(`  what is java?                  -> ${plain.maxTokens}`);

  ok('short question stays cheap', short.maxTokens <= 800);
  ok('code-only stays cheap', codeOnly.maxTokens <= 800);
  ok('1000 words gets a real budget (>1400)', w100.maxTokens > 1400, `got ${w100.maxTokens}`);
  ok('2000 words gets more than 1000 words', w2000.maxTokens > w100.maxTokens);
  ok('100 questions gets a real budget (>4000)', q100.maxTokens > 4000, `got ${q100.maxTokens}`);
  ok('tables 1..100 gets a real budget (>7000)', t100.maxTokens > 7000, `got ${t100.maxTokens}`);
  ok('ordinary question is not inflated', plain.maxTokens <= 900, `got ${plain.maxTokens}`);
  ok('budget never exceeds the model cap', t100.maxTokens <= 16384);
  ok('budget never exceeds the cap even for 200 words x many', planOutput({ itemCount: 300, unit: 'program' }, { cap: 16384 }).maxTokens <= 16384);
}

console.log('\n7) Completeness check — detects the classic cut-short answers');
{
  // Tables 1..10 where the model stopped at table 8 (the reported bug).
  const partial = Array.from({ length: 8 }, (_, i) => `Table ${i + 1}\n${i + 1} x 1 = ${i + 1}`).join('\n\n');
  const c = checkCompleteness(partial, req('give multiplication tables from 1 to 10'));
  ok('stops at table 8 -> incomplete', !c.complete, JSON.stringify(c));
  eq('resume at table 9', c.nextIndex, 9);

  const full = Array.from({ length: 10 }, (_, i) => `Table ${i + 1}\n${i + 1} x 1 = ${i + 1}`).join('\n\n');
  ok('all 10 tables -> complete', checkCompleteness(full, req('give multiplication tables from 1 to 10')).complete);

  const progress = numberedProgress('**1.** first\n2: second\n2: repeated\n4. fourth');
  eq('progress preserves unique numbered markers', progress.numbers, [1, 2, 4]);
  eq('progress reports duplicate markers', progress.duplicates, [2]);
  eq('progress reports missing markers', progress.missing, [3]);
  const duplicate = checkCompleteness(
    '1. first\n2. second\n2. repeated\n3. third',
    req('give 3 interview questions')
  );
  ok('duplicate markers are not treated as complete progress', !duplicate.complete, JSON.stringify(duplicate));
  eq('duplicate progress is surfaced', duplicate.duplicates, [2]);

  // 20 problems where the model returned 12.
  const p12 = Array.from({ length: 12 }, (_, i) => `${i + 1}. Problem ${i + 1}`).join('\n');
  const pc = checkCompleteness(p12, req('give 20 LeetCode problems'));
  ok('12 of 20 problems -> incomplete', !pc.complete, JSON.stringify(pc));
  eq('resume at problem 13', pc.nextIndex, 13);

  const p20 = Array.from({ length: 20 }, (_, i) => `${i + 1}. Problem ${i + 1}`).join('\n');
  ok('20 of 20 problems -> complete', checkCompleteness(p20, req('give 20 LeetCode problems')).complete);

  // 50 questions where the model returned 50 but numbered 1..50 (no false positive).
  const q50 = Array.from({ length: 50 }, (_, i) => `${i + 1}. Question ${i + 1}`).join('\n');
  ok('50 of 50 questions -> complete', checkCompleteness(q50, req('give 50 interview questions')).complete);

  // 10 examples.
  const e10 = Array.from({ length: 10 }, (_, i) => `${i + 1}. Example ${i + 1}`).join('\n');
  ok('10 of 10 examples -> complete', checkCompleteness(e10, req('give 10 examples')).complete);

  // Word count: 250 words when 1000 were requested.
  const shortWords = 'word '.repeat(250);
  const wc = checkCompleteness(shortWords, req('explain Java in 1000 words'));
  ok('250 words of 1000 -> incomplete', !wc.complete);
  eq('word continuation kind', wc.kind, 'words');
  const fullWords = 'word '.repeat(1000);
  ok('1000 words of 1000 -> complete', checkCompleteness(fullWords, req('explain Java in 1000 words')).complete);
  ok('short answer of 60 words for "100 words" is fine', checkCompleteness('word '.repeat(96), req('explain in exactly 100 words')).complete);

  // No quantity requested -> always complete (never loop forever).
  ok('"what is java?" needs no continuation', checkCompleteness('Java is a language.', req('what is Java?')).complete);
  ok('"hi" needs no continuation', checkCompleteness('Hey!', req('hi')).complete);
}

console.log('\n7b) A row can be "present" while its content is cut off (regression)');
{
  // The exact live failure: "tables 1 to 20" where row 20 arrived as
  // "20: 20x1=20 20x2=40 … 20x10=200" — every marker 1..20 exists, so the pure
  // marker count read 20/20 and no continuation fired. The check must notice
  // that the LAST row only reaches multiplier 10 of 20.
  const row = (n, maxK) =>
    `${n}: ${Array.from({ length: maxK }, (_, k) => `${n}x${k + 1}=${n * (k + 1)}`).join(' ')}`;
  const full19 = Array.from({ length: 19 }, (_, i) => row(i + 1, 20)).join('\n');
  const cut = `${full19}\n${row(20, 10)}`;
  const r = req('give multiplication tables from 1 to 20');
  eq('range understood as 1..20', [r.range.from, r.range.to], [1, 20]);
  const c = checkCompleteness(cut, r);
  ok('row 20 present but cut at x10 -> incomplete', !c.complete, JSON.stringify(c));
  eq('partial-row kind', c.kind, 'partialRow');
  eq('partial row number', c.partialRow, 20);
  eq('cut at multiplier', c.partialMaxK, 10);

  // The same layout complete -> complete (no false positive).
  const done = `${full19}\n${row(20, 20)}`;
  ok('row 20 reaching x20 -> complete', checkCompleteness(done, r).complete, JSON.stringify(checkCompleteness(done, r)));

  // Plain numeric rows ("20: 20 40 … 400") carry no multipliers -> never flagged.
  const grid = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return `${n}: ${Array.from({ length: 20 }, (_, k) => n * (k + 1)).join(' ')}`;
  }).join('\n');
  ok('numeric grid rows are not flagged as partial', checkCompleteness(grid, r).complete);

  // A product row that REACHES the bound is not flagged even if sparse.
  const sparse = `${full19}\n20: 20x1=20 20x10=200 20x20=400`;
  ok('a sparse row that reaches x20 is complete', checkCompleteness(sparse, r).complete);

  // Non-arithmetic prose after a colon is never a product row.
  const prose = `${full19}\n20: 20 times 10 is 200, and 20 times 20 is 400`;
  ok('prose row is not a product row', checkCompleteness(prose, r).complete);

  // The thousands of checks must also accept the classic ONE-LINE-PER-TABLE
  // styles from earlier (Format A and the "Table N" heading style).
  const headings = Array.from({ length: 20 }, (_, i) => `Table ${i + 1}\n${i + 1} x 20 = ${(i + 1) * 20}`).join('\n\n');
  ok('heading-style tables stay complete', checkCompleteness(headings, r).complete);
}

console.log('\n8) Continuation instruction is specific and internal');
{
  const r = req('give multiplication tables from 1 to 10');
  const c = checkCompleteness(Array.from({ length: 8 }, (_, i) => `Table ${i + 1}`).join('\n\n'), r);
  const p = buildContinuationPrompt({ req: r, check: c, question: 'give multiplication tables from 1 to 10' });
  console.log(`  ${p.split('\n').slice(0, 2).join(' / ').slice(0, 150)}...`);
  ok('continuation names the next item', /item 9/.test(p), p.slice(0, 200));
  ok('continuation forbids restarting at 1', /do NOT restart at 1/i.test(p));
  ok('continuation is marked internal', /INTERNAL CONTINUATION/.test(p));
  ok('continuation forbids a preamble/closing', /do NOT write any introduction/i.test(p));

  const w = buildContinuationPrompt({
    req: req('explain Java in 1000 words'),
    check: checkCompleteness('word '.repeat(250), req('explain Java in 1000 words')),
    question: 'explain Java in 1000 words',
  });
  ok('word continuation asks for more words', /more words/i.test(w));
  ok('word continuation repeats no content', /not repeat|non-repeating/i.test(w));

  // Partial-row continuation: must name the row and the missing multipliers.
  const row = (n, maxK) =>
    `${n}: ${Array.from({ length: maxK }, (_, k) => `${n}x${k + 1}=${n * (k + 1)}`).join(' ')}`;
  const cut = `${Array.from({ length: 19 }, (_, i) => row(i + 1, 20)).join('\n')}\n${row(20, 10)}`;
  const pr = buildContinuationPrompt({
    req: req('give multiplication tables from 1 to 20'),
    check: checkCompleteness(cut, req('give multiplication tables from 1 to 20')),
    question: 'give multiplication tables from 1 to 20',
  });
  ok('partial-row continuation names the row', /row 20/.test(pr), pr.slice(0, 200));
  ok('partial-row continuation names the missing multipliers', /20×11/.test(pr), pr.slice(0, 200));
  ok('partial-row continuation forbids restarting', /do NOT restart/i.test(pr));
}

console.log('\n9) Merge: continuation never duplicates or restarts');
{
  const first = '1. alpha\n2. beta\n3. gamma';
  const dup = mergeContinuation(first, '1. alpha\n2. beta\n3. gamma\n4. delta\n5. epsilon');
  eq('restart is trimmed to the new items', dup, '1. alpha\n2. beta\n3. gamma\n\n4. delta\n5. epsilon');
  ok('no duplicate item 1', (dup.match(/1\. alpha/g) || []).length === 1);

  const straight = mergeContinuation(first, '4. delta\n5. epsilon');
  eq('already-correct continuation passes through', straight, '1. alpha\n2. beta\n3. gamma\n\n4. delta\n5. epsilon');

  const withHeader = mergeContinuation('4. delta\n5. epsilon', '4. delta\n5. epsilon\n6. zeta');
  eq('leading duplicated items are dropped at the seam', withHeader, '4. delta\n5. epsilon\n\n6. zeta');

  const preamble = mergeContinuation(first, 'Sure, here you go:\n4. delta\n5. epsilon');
  eq('a repeated preamble is dropped', preamble, '1. alpha\n2. beta\n3. gamma\n\n4. delta\n5. epsilon');

  const allDup = mergeContinuation('4. delta\n5. epsilon', '4. delta\n5. epsilon');
  eq('a fully duplicated continuation adds nothing', allDup, '4. delta\n5. epsilon');

  const tables = mergeContinuation('Table 1\nTable 2', 'Table 1\nTable 2\nTable 3\nTable 4');
  eq('table headings also de-duplicate', tables, 'Table 1\nTable 2\n\nTable 3\nTable 4');

  ok('merging nothing returns the original', mergeContinuation(first, '') === first);

  // ---- Seam-join: a continuation that only finishes the LAST line -----------
  // The live product bug: row "20: 20x1=20 … 20x10=200" was present but cut off.
  // The model's continuation either re-emits the whole row with the missing
  // products, or writes the bare remainder. Either shape must glue onto the SAME
  // line (de-duping the shared prefix) so the answer reads as ONE contiguous row.
  const cutRow = '20: 20x1=20 20x2=40 20x3=60 20x4=80 20x5=100 20x6=120 20x7=140 20x8=160 20x9=180 20x10=200';

  const bare = mergeContinuation(cutRow, '20x11=220 20x12=240 20x13=260 20x14=280 20x15=300 20x16=320 20x17=340 20x18=360 20x19=380 20x20=400');
  ok('a bare remainder extends the SAME line', bare.split('\n').length === 1, `${bare.split('\n').length} line(s)`);
  ok('a bare remainder reaches the full bound', /20x20=400/.test(bare), bare.slice(-60));
  ok('the bare remainder has no duplicated products', (bare.match(/20x10=200/g) || []).length === 1 && (bare.match(/20x11=220/g) || []).length === 1);

  const reEmit = mergeContinuation(cutRow, `${cutRow} 20x11=220 20x12=240 20x13=260 20x14=280 20x15=300 20x16=320 20x17=340 20x18=360 20x19=380 20x20=400`);
  ok('a re-emitted row de-dupes its prefix and extends the SAME line', reEmit.split('\n').length === 1, `${reEmit.split('\n').length} line(s)`);
  ok('a re-emitted row keeps every multiplier once', (reEmit.match(/20x10=200/g) || []).length === 1 && (reEmit.match(/20x20=400/g) || []).length === 1);
  ok('the re-emitted row ends at the bound', /20x20=400\s*$/.test(reEmit.trim()), reEmit.trim().slice(-40));

  const pureDup = mergeContinuation(cutRow, `${cutRow} 20x11=220`);
  ok('a re-emission that adds only one product still extends once', /20x11=220/.test(pureDup) && pureDup.split('\n').length === 1);

  // A continuation with a REAL new numbered item must NOT be glued mid-line.
  const nextItems = mergeContinuation(cutRow, '21: next row 21 products');
  ok('a new numbered colon row is NOT glued onto the previous line', nextItems.includes('200\n\n21: next row 21 products'), nextItems.slice(-60));

  const boldRestart = mergeContinuation('**1.** alpha\n**2.** beta', '**1.** alpha\n**2.** beta\n**3.** gamma');
  ok('bold numbered restart drops repeated items', (boldRestart.match(/\*\*1\.\*\*/g) || []).length === 1, boldRestart);

  const colonRestart = mergeContinuation('1: alpha\n2: beta', '1: alpha\n2: beta\n3: gamma');
  ok('colon numbered restart drops repeated rows', colonRestart === '1: alpha\n2: beta\n\n3: gamma', colonRestart);
}

console.log('\n10) The directive states the requirement to the model');
{
  const d = buildDirective(req('give multiplication tables from 1 to 10'));
  ok('range directive names the endpoints', /1 through 10/.test(d), d.slice(0, 200));
  const d2 = buildDirective(req('explain Java in 1000 words'));
  ok('word directive states the word count', /1000 words/.test(d2));
  const d3 = buildDirective(req('give only code for palindrome in Java'));
  ok('code-only directive forbids prose', /ONLY the code/.test(d3));
  const d4 = buildDirective(req('give 20 LeetCode problems'));
  ok('count directive says EXACTLY 20', /EXACTLY 20 problems/.test(d4));
  ok('count directive forbids duplicate filler items', /meaningfully distinct.*never repeat/i.test(d4));
  const d5 = buildDirective(req('give me 10 more', [{ role: 'ai', content: '1. a' }]));
  ok('continuation directive forbids repeats', /never repeat/i.test(d5));
  const d6 = buildDirective(req('compare Java and Python in a table'));
  ok('table directive demands a markdown table', /markdown table/i.test(d6));
  console.log(`  directive sample: ${d.split('\n')[1].slice(0, 130)}...`);
}

console.log('\n10b) Code answers: simplicity + structure directives (dynamic, never hardcoded)');
{
  const plain = req('what is Java?');
  ok('"what is Java?" is NOT a code request', !plain.codeRequest);
  const dPlain = buildDirective(plain);
  ok('no code simplicity directive for a plain explanation', !/SHORTEST clear/.test(dPlain));
  ok('no structure directive for a plain explanation', !/\*\*Explanation\*\*/.test(dPlain));

  const program = req('write a java program to count letter case transitions');
  ok('"write a java program…" is a code request', program.codeRequest, JSON.stringify(program));
  const dProgram = buildDirective(program);
  ok('code directive demands the shortest correct solution', /SHORTEST clear, correct/.test(dProgram));
  ok('code directive forbids unnecessary helpers', /unnecessary helper classes/.test(dProgram));
  ok('structure directive offers Explanation/Code/Output/Complexity', /\*\*Explanation\*\*/.test(dProgram) && /\*\*Code\*\*/.test(dProgram) && /\*\*Output\*\*/.test(dProgram));

  const pythonFn = req('write a function in python to reverse a string');
  ok('"write a function in python…" is a code request', pythonFn.codeRequest);

  const onlyCode = req('give only code for palindrome in Java');
  ok('code-only is a code request', onlyCode.codeRequest);
  const dOnly = buildDirective(onlyCode);
  ok('code-only directive forbids prose', /ONLY the code/.test(dOnly));
  ok('NO structure directive when code-only (no explanation allowed)', !/\*\*Explanation\*\*/.test(dOnly));

  const sqlQ = req('give sql queries to find employees by department');
  ok('"sql queries" is a code request', sqlQ.codeRequest);

  const interview = req('give me 10 java interview questions');
  ok('"java interview QUESTIONS" is NOT a code request', !interview.codeRequest);
}

console.log('\n11) Helpers');
eq('numberedRuns reads 1..10', [...numberedRuns('1. a\n2. b\n9. i\n10. j')].sort((a, b) => a - b), [1, 2, 9, 10]);
eq('wordCount is sane', wordCount('one two three four'), 4);
eq('wordCount ignores punctuation', wordCount('hello, world!'), 2);

console.log('\n11b) Every common list FORMAT is read back as items (regression)');
{
  // A model that fulfils the request perfectly but writes "20: ..." instead of
  // "20. ..." used to score 0/20 items, which failed the completeness check AND
  // triggered a bogus continuation that restarted at item 1. The counter must
  // accept every marker a model realistically uses — and must NOT read prose
  // ("10:30 AM", "Version 2: released") as an item.
  const items = [...numberedRuns('1. a\n2. b\n3. c')].sort((a, b) => a - b);
  eq('dot markers', items, [1, 2, 3]);
  eq('paren markers', [...numberedRuns('1) a\n2) b')].sort((a, b) => a - b), [1, 2]);
  eq('colon markers ("20: 20 40 60")', [...numberedRuns('1: 1 2\n2: 3 4\n3: 5 6')].sort((a, b) => a - b), [1, 2, 3]);
  eq('bold markers ("**1.** a")', [...numberedRuns('**1.** a\n**2.** b')].sort((a, b) => a - b), [1, 2]);
  eq('bold-colon markers ("**1:** a")', [...numberedRuns('**1:** a\n**2:** b')].sort((a, b) => a - b), [1, 2]);
  eq('headings ("### Table 4")', [...numberedRuns('### Table 1\nx\n### Table 2')].sort((a, b) => a - b), [1, 2]);
  eq('"Step 1:" prose markers', [...numberedRuns('Step 1: mix\nStep 2: bake')].sort((a, b) => a - b), [1, 2]);

  // Guard against false positives: these are NOT list items.
  eq('a clock time is not an item', [...numberedRuns('10:30 AM standup\n11:45 lunch')], []);
  eq('"Version 2: released" is not an item', [...numberedRuns('Version 2: released in 2024\nNote: it works')], []);
  eq('a mid-sentence "1." is not an item', [...numberedRuns('This sentence mentions 1. something and 2. other')], []);

  eq('bulletCount counts dashes', bulletCount('- a\n- b\n- c'), 3);
  eq('bulletCount counts colon rows', bulletCount('1: 1 2 3\n2: 4 5 6'), 2);
  eq('bulletCount ignores a clock time', bulletCount('10:30 AM standup\n11:45 lunch'), 0);

  // The behaviour that actually mattered: a complete answer in each format is
  // judged complete, and a genuinely short one still reports the next item.
  const rangeReq = req('give multiplication tables from 1 to 20');
  const grid = Array.from({ length: 20 }, (_, i) => `${i + 1}: ${Array.from({ length: 20 }, (_, j) => (i + 1) * (j + 1)).join(' ')}`).join('\n');
  ok('a complete 20-row colon grid passes the check', checkCompleteness(grid, rangeReq).complete);
  const bold = Array.from({ length: 20 }, (_, i) => `**${i + 1}.** Table of ${i + 1}`).join('\n');
  ok('a complete 20-item bold list passes the check', checkCompleteness(bold, rangeReq).complete);
  const short = Array.from({ length: 8 }, (_, i) => `${i + 1}: row ${i + 1}`).join('\n');
  const shortCheck = checkCompleteness(short, rangeReq);
  ok('a short colon grid still reports the next missing item', !shortCheck.complete && shortCheck.nextIndex === 9, `nextIndex=${shortCheck.nextIndex}`);
}

console.log('\n11c) Follow-ups ("10 more", "make it 20") (regression)');
{
  // The live suite caught the directive telling the model "numbered 1 to 10" for a
  // "give me 10 more" follow-up — a direct contradiction of the CONTINUATION line
  // right below it, which made the model restart at 1. A restart is cosmetic (the
  // user still got 10 NEW items) but the directive must not invite it, and the
  // check must not then read a perfectly good answer as 0 items.
  const tenItems = Array.from({ length: 10 }, (_, i) => `${i + 1}. Problem ${i + 1}`).join('\n');
  const hist = [{ role: 'ai', content: tenItems }];

  const more = req('Give me 10 more.', hist);
  ok('"give me 10 more" knows the previous count', more.previousItemCount === 10, `previousItemCount=${more.previousItemCount}`);
  ok('"give me 10 more" asks for 10 more, not 10 total', more.itemCount === 10 && more.continueFrom === 11, `itemCount=${more.itemCount} continueFrom=${more.continueFrom}`);
  const dMore = buildDirective(more);
  ok('the follow-up directive says do NOT restart at 1', /do not restart the numbering at 1/i.test(dMore), dMore.split('\n').find((l) => /QUANTITY/.test(l))?.slice(0, 120));
  ok('the follow-up directive names the NEW window 11..20', /11 to 20/.test(dMore), dMore.split('\n').find((l) => /QUANTITY/.test(l))?.slice(0, 120));
  ok('the follow-up directive never contradicts itself with "numbered 1 to 10"', !/numbered 1 to 10/.test(dMore));

  const five = req('give me 5 more', hist);
  ok('"give me 5 more" asks for items 11..15', five.itemCount === 5 && five.continueFrom === 11);

  const visibleContinue = req('Continue the previous list: include items 49 through 50. Fill only missing items.');
  ok('the UI Continue action is parsed as only the missing range', visibleContinue.itemCount === 2 && visibleContinue.range?.from === 49 && visibleContinue.range?.to === 50 && visibleContinue.continueFrom === 49, JSON.stringify({ itemCount: visibleContinue.itemCount, range: visibleContinue.range, continueFrom: visibleContinue.continueFrom }));

  const grow = req('make it 20', hist);
  ok('"make it 20" targets the new TOTAL of 20', grow.targetTotal === 20 && grow.itemCount === 10, `targetTotal=${grow.targetTotal} itemCount=${grow.itemCount}`);

  // Restart-at-1 is acceptable: the user got 10 new items either way.
  const restarted = Array.from({ length: 10 }, (_, i) => `${i + 1}. New problem ${i + 1}`).join('\n');
  const rCheck = checkCompleteness(restarted, more);
  ok('a follow-up that restarts numbering is still complete', rCheck.complete, rCheck.reason);

  // But a genuinely short follow-up must NOT be waved through.
  const thin = '1. A\n2. B\n3. C';
  ok('a follow-up with only 3 new items is incomplete', !checkCompleteness(thin, more).complete);
  ok('a follow-up that correctly continues 11..20 is complete', checkCompleteness(Array.from({ length: 10 }, (_, i) => `${i + 11}. P${i + 11}`).join('\n'), more).complete);

  // The restart tolerance is reachable ONLY when there is a continuation window.
  const firstTurn = req('give me 10 Java interview questions');
  ok('a first-turn request has no continuation window', !firstTurn.continueFrom || firstTurn.continueFrom <= 1, `continueFrom=${firstTurn.continueFrom}`);
  ok('a first-turn request that delivers all 10 items is complete', checkCompleteness(restarted, firstTurn).complete);
  ok('a first-turn request with only 3 items is still incomplete', !checkCompleteness(thin, firstTurn).complete);
}

console.log('\n12) The REAL service budget path (ragService.pickMaxTokens)');
{
  // planOutput in isolation is not the whole story: ragService floors the budget
  // per intent (structured JSON must round-trip) and clamps it to the configured
  // ceiling. This asserts the number the provider is actually sent.
  const rag = require('../services/ragService');
  const { detectIntent } = require('../services/intentService');
  const budget = (q) => {
    const r = analyzeRequest({ question: q, history: [] });
    return rag.pickMaxTokens(detectIntent(q, []).intent, r);
  };
  const CAP = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 32768);

  const hi = budget('hi');
  const java = budget('what is Java?');
  ok('a greeting stays cheap', hi < 1000, `hi=${hi}`);
  ok('a short general question stays cheap', java < 1000, `what is Java=${java}`);
  ok('a 1000-word request gets a much bigger budget', budget('explain Java in 1000 words') > java * 3);
  ok('a 100-item request gets a much bigger budget than "hi"', budget('give me 100 Java interview questions') > hi * 8);
  ok('a 1..100 range gets a bigger budget than a 1..10 range', budget('multiplication tables 1 to 100') > budget('multiplication tables 1 to 10'));
  ok('document analysis is floored above the conversational floor', budget('analyze my resume') >= 1200);
  ok('no budget ever exceeds the configured ceiling', [hi, java, budget('multiplication tables 1 to 100')].every((b) => b <= CAP));
  ok('every budget is a sane positive integer', [hi, java, budget('multiplication tables 1 to 100')].every((b) => Number.isInteger(b) && b >= 500));

  console.log(`  budgets: hi=${hi} "what is Java?"=${java} "1000 words"=${budget('explain Java in 1000 words')} "100 questions"=${budget('give me 100 Java interview questions')} "tables 1 to 100"=${budget('multiplication tables 1 to 100')} "analyze my resume"=${budget('analyze my resume')}`);

  // Continuation budgets are sized to what is MISSING, not to the whole request.
  const cReq = analyzeRequest({ question: 'multiplication tables 1 to 10', history: [] });
  const almost = checkCompleteness('1. 1 x 1 = 1\n2. 1 x 2 = 2\n3. 1 x 3 = 3\n4. 1 x 4 = 4', cReq);
  const almostAll = checkCompleteness(Array.from({ length: 9 }, (_, i) => `${i + 1}. 1 x ${i + 1} = ${i + 1}`).join('\n'), cReq);
  ok('a continuation is cheaper the less is missing', rag.continuationBudget(cReq, almostAll, CAP) < rag.continuationBudget(cReq, almost, CAP), `7 missing=${rag.continuationBudget(cReq, almost, CAP)} vs 2 missing=${rag.continuationBudget(cReq, almostAll, CAP)}`);
  ok('a continuation never exceeds the ceiling', rag.continuationBudget(cReq, almost, CAP) <= CAP);

  // A PARTIAL product row is a cheap continuation: only the missing multipliers.
  const makeReq20 = () => analyzeRequest({ question: 'give multiplication tables from 1 to 20', history: [] });
  const row = (n, maxK) =>
    `${n}: ${Array.from({ length: maxK }, (_, k) => `${n}x${k + 1}=${n * (k + 1)}`).join(' ')}`;
  const cut20 = `${Array.from({ length: 19 }, (_, i) => row(i + 1, 20)).join('\n')}\n${row(20, 10)}`;
  const partialCheck = checkCompleteness(cut20, makeReq20());
  const pb = rag.continuationBudget(makeReq20(), partialCheck, CAP);
  ok('partial-row continuation is sized to the missing multipliers', pb >= 300 && pb <= 600, `budget=${pb}`);
}

console.log('\n13) RAG is gated — general questions do not consult the knowledge base');
{
  const rag = require('../services/ragService');
  const { detectIntent } = require('../services/intentService');
  const wants = (q) => {
    const i = detectIntent(q, []).intent;
    return rag.DOCUMENT_INTENTS.has(i) || rag.DOCUMENT_HINT_RE.test(q);
  };
  ok('"hi" does not pull documents', wants('hi') === false);
  ok('"what is Java?" does not pull documents', wants('what is Java?') === false);
  ok('"explain polymorphism" does not pull documents', wants('explain polymorphism') === false);
  ok('"give me 20 java projects" does not pull documents', wants('give me 20 java projects') === false);
  ok('"analyze my resume" pulls documents', wants('analyze my resume') === true);
  ok('"review my resume" pulls documents', wants('review my resume') === true);
  ok('"what skills am i missing" pulls documents', wants('what skills am i missing') === true);
}

console.log(`\n${'='.repeat(58)}`);
console.log(failed === 0 ? `ALL ${passed} ASSERTIONS PASSED` : `${passed} passed / ${failed} FAILED`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(failed === 0 ? 0 : 1);

// helpers
function pick(r) {
  return {
    ...(r.itemCount ? { count: r.itemCount } : {}),
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.range ? { from: r.range.from, to: r.range.to } : {}),
    ...(r.continueFrom ? { from: r.continueFrom } : {}),
    ...(r.wordCount ? { words: r.wordCount, mode: r.wordMode } : {}),
  };
}
