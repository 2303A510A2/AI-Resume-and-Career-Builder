// General output-requirement engine for the AI chat.
//
// WHY THIS EXISTS
// ---------------
// The chat used to answer with one fixed, tiny output-token budget per intent
// (600-1800 tokens). Anything longer than that was silently cut off mid-answer:
// "tables 1 to 10" stopped at table 8, "20 LeetCode problems" stopped at 12,
// "explain Java in 1000 words" came back at 250 words. Nothing detected the cut
// and nothing continued it.
//
// This module is the single, topic-agnostic place where "what exactly did the
// user ask for?" is decided. It is PURE text analysis: no LLM call, no network,
// no database — so it is deterministic and unit-testable.
//
// It answers four questions:
//   1. analyzeRequest()  -> how MANY items / how MANY words / which FORMAT /
//                           which constraints (code-only, no comments, range…)
//   2. planOutput()      -> a DYNAMIC output-token budget sized to that request
//   3. buildDirective()  -> the natural-language constraints for the system
//                           prompt (so the model aims correctly the first time)
//   4. checkCompleteness() + buildContinuationPrompt() + mergeContinuation()
//                        -> the recovery path when the provider still cut the
//                           answer short (`finish_reason: "length"`).
//
// NOTHING here is hardcoded to a specific subject. "multiplication tables",
// "Java", "LeetCode" and "50 questions" are all handled by the same generic
// quantity/format/range logic, and an unknown request simply gets a normal,
// conversational budget.

// ---------------------------------------------------------------------------
// Countable units
//
// Each entry is a canonical unit key plus the noun forms that map to it. The
// per-unit token cost below is what the BUDGET is calculated from: a Java
// program costs far more output tokens than a one-line interview question, so
// the budget must know which one was asked for.
// ---------------------------------------------------------------------------
const UNITS = [
  // key        nouns                                          tokens/item
  { key: 'table',      words: 'tables?',                            cost: 90 },
  { key: 'question',   words: 'questions?',                         cost: 55 },
  { key: 'problem',    words: 'problems?',                          cost: 70 },
  { key: 'example',    words: 'examples?',                          cost: 60 },
  { key: 'program',    words: 'programs?|codes?|snippets?|scripts?', cost: 230 },
  { key: 'step',       words: 'steps?',                             cost: 60 },
  { key: 'topic',      words: 'topics?',                            cost: 60 },
  { key: 'fact',       words: 'facts?',                             cost: 45 },
  { key: 'tip',        words: 'tips?',                              cost: 45 },
  { key: 'trick',      words: 'tricks?',                            cost: 60 },
  { key: 'reason',     words: 'reasons?',                           cost: 45 },
  { key: 'item',       words: 'items?|points?|ways?|methods?|functions?|rules?|commands?|queries?|terms?|concepts?|features?|principles?', cost: 55 },
  { key: 'link',       words: 'links?|urls?|websites?|sites?',       cost: 45 },
  { key: 'mcq',        words: 'mcqs?|multiple[- ]choice questions?', cost: 90 },
  { key: 'testcase',   words: 'test[- ]cases?',                      cost: 90 },
  { key: 'scenario',   words: 'scenarios?|analogies|similarities|differences|pros and cons', cost: 60 },
  { key: 'line',       words: 'lines?',                             cost: 25 },
  { key: 'sentence',   words: 'sentences?',                         cost: 30 },
  { key: 'paragraph',  words: 'paragraphs?',                        cost: 70 },
];

const UNIT_BY_KEY = UNITS.reduce((acc, u) => {
  acc[u.key] = u;
  return acc;
}, {});

// Tokens a "1/2"-style bare range ("give me 50") is assumed to cost. Unknown
// units are budgeted like a medium-length item, never like a one-liner.
const DEFAULT_UNIT_COST = 55;

// Adjective tokens allowed between the number and the unit noun ("20 leetcode
// problems", "100 java interview questions"). Anything not on this list is
// treated as the unit itself.
const UNIT_ADJECTIVES = new Set([
  'leetcode', 'interview', 'dsa', 'programming', 'coding', 'java', 'python',
  'javascript', 'sql', 'web', 'practice', 'practicing', 'fresh', 'common',
  'real', 'easy', 'medium', 'hard', 'basic', 'advanced', 'simple', 'short',
  'long', 'important', 'different', 'useful', 'best', 'top', 'must', 'good',
  'tricky', 'favourite', 'favorite', 'similar', 'unique', 'beginner',
  'experience', 'level', 'sql', 'html', 'css', 'react', 'node', 'full', 'stack',
]);

// Tokens that must NOT be swallowed as an adjective (they end the noun phrase).
const ADJECTIVE_STOP = new Set([
  'of', 'for', 'in', 'on', 'with', 'and', 'a', 'an', 'the', 'about', 'at', 'by',
  'to', 'from', 'that', 'which', 'please', 'me', 'us', 'do', 'does', 'is', 'are',
  'each', 'every', 'all', 'best', 'most', 'about',
]);

// A range is NOT a range when the trailing number is a measurement, not an
// index ("give me 1-1000 words", "top 5-10 minutes").
const NON_RANGE_UNIT_RE =
  /^[\s-]*(?:words?|w\b|marks?|%|percent|years?|yrs?|months?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|rs\.?|inr|usd|dollars?|eur|kg|mg|mb|gb|kb|tb|credits?|likes?|views?|stars?)\b/i;

const MAX_QUANTITY = 300;     // never budget for more than this many items
const MAX_WORDS = 20000;      // never budget for more than this many words

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Cheap, conservative token estimate (~3.6 chars/token for English prose). */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.4) + 8;

const wordCount = (text) => {
  const m = String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Finds the unit noun that belongs to the number starting at `from`. */
const unitAfter = (text, from) => {
  const window = text.slice(from, from + 80);
  for (const unit of UNITS) {
    // Up to 3 adjective tokens may sit between the number and the unit noun.
    const re = new RegExp(`^\\s*((?:[A-Za-z][\\w+#.-]*\\s+){0,3}?)(${unit.words})\\b`, 'i');
    const m = re.exec(window);
    if (!m) continue;
    const adjs = m[1].trim() ? m[1].trim().split(/\s+/) : [];
    const bad = adjs.some(
      (a) => /^\d+$/.test(a) || ADJECTIVE_STOP.has(a.toLowerCase()) || !UNIT_ADJECTIVES.has(a.toLowerCase())
    );
    if (bad) continue;
    return { key: unit.key, consumed: m[0].length };
  }
  return null;
};

/**
 * Detects an explicit numeric RANGE: "from 1 to 10", "1-10", "1 to 10",
 * "tables 1-10", "between 1 and 20", "up to 10", "till 10", "1–20".
 * @returns {{from:number,to:number}|null}
 */
const detectRange = (text) => {
  const t = String(text || '');

  const bounded = [
    /\bfrom\s+(\d{1,4})\s*(?:to|through|thru|until|till|til|upto|up\s+to|[-–—])\s*(\d{1,4})/gi,
    /\bbetween\s+(\d{1,4})\s+and\s+(\d{1,4})/gi,
    /\b(\d{1,4})\s*(?:to|through|thru)\s+(\d{1,4})\b/gi,
    /\b(\d{1,4})\s*[-–—]\s*(\d{1,4})\b/g,
  ];
  for (const re of bounded) {
    let m;
    while ((m = re.exec(t)) !== null) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (NON_RANGE_UNIT_RE.test(t.slice(m.index + m[0].length))) continue;
      if (a > b) [a, b] = [b, a];
      if (b < 1) continue;
      if (b - a > 1000) continue; // implausible as an enumeration
      return { from: Math.max(1, a), to: b };
    }
  }

  // Open-ended lower bound: "give me all tables till 10", "give 20+ examples".
  const till = /\b(?:till|til|until|up\s+to|upto|upto)\s+(\d{1,4})\b/i.exec(t);
  if (till && !NON_RANGE_UNIT_RE.test(t.slice(till.index + till[0].length))) {
    const to = clamp(Number(till[1]), 1, MAX_QUANTITY);
    if (to > 1) return { from: 1, to };
  }
  const plus = /\b(\d{1,4})\s*\+\s*(?:[A-Za-z]+\s+){0,3}?(?=\w)/i.exec(t);
  if (plus) {
    const from = clamp(Number(plus[1]), 1, MAX_QUANTITY);
    if (from >= 2) return { from, to: from + 9 }; // "20+" -> allow a few more
  }
  return null;
};

/**
 * Detects an explicit COUNT: "20 problems", "give me 50 questions", "10 examples",
 * "the first 10", "top 20", "10 more".
 */
const detectCount = (text) => {
  const t = String(text || '');
  const out = [];
  const re = /(\d{1,4})/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = Number(m[1]);
    if (n < 1) continue;
    // Start looking for the unit noun right AFTER the digits, so "20 leetcode
    // problems" sees " leetcode problems" (not "20 leetcode problems").
    const u = unitAfter(t, m.index + m[1].length);
    out.push({ index: m.index, count: n, unit: u ? u.key : null, text: u ? `${m[1]}${t.slice(m.index + m[1].length, m.index + m[1].length + u.consumed)}` : m[1] });
  }
  return out;
};

/** "exactly 100 words" vs "about 1000 words" vs bare "1000 words". */
const detectWordCount = (text) => {
  const t = String(text || '');
  const re =
    /(?:(exactly|precisely|about|around|approximately|approx\.?|nearly|roughly|~)\s*(?:only\s+)?)?(\d{2,5})\s*(?:[- ]?words?)\b/i;
  const m = re.exec(t);
  if (!m) return null;
  const n = clamp(Number(m[2]), 1, MAX_WORDS);
  const lead = String(m[1] || '').toLowerCase();
  const atleast = /(?:in\s+)?at\s+least|(?:minimum|min\.?)\s+of/i.test(t.slice(Math.max(0, m.index - 24), m.index + m[0].length));
  if (/exactly|precisely/.test(lead)) return { words: n, mode: 'exact' };
  if (atleast) return { words: n, mode: 'atleast' };
  return { words: n, mode: 'about' };
};

/** "only the code" / "code only" / "just give the code" -> no prose around it. */
const detectCodeOnly = (text) =>
  /(only|just)\s+(the\s+)?(code|program|script|snippet|query|sql)\b|^(code|program|script)\s+only\b|no\s+(extra\s+)?(explanation|description|comment|text)\b.*\bcode\b|\bcode\s+only\b/i.test(
    String(text || '')
  );

const detectNoComments = (text) =>
  /\b(no|without|don'?t|do not|dont)\s+(add\s+)?(any\s+)?(comments?|commentation)\b|\bno\s+comments\b|\bwithout\s+comments\b/i.test(
    String(text || '')
  );

// A request is a CODE request when it explicitly asks for source code — the
// simplicity + structure rules only apply then. "what is Java?" is an
// explanation, not a code request, and must never be squeezed into snippet
// form. "go" and bare "c" are deliberately NOT in the language list: they
// appear constantly in prose and would make every other sentence a code
// request.
const CODE_NOUN_RE = /\b(program(?:s|mes)?|code(?:s)?|snippet(?:s)?|script(?:s)?|function(?:s)?|method(?:s)?|class(?:es)?|algorithm(?:s)?|solution(?:s)?|quer(?:y|ies))\b/i;
const CODE_VERB_RE = /\b(write|code|implement|create|build|develop|fix|debug|solve|print|return|output)\b/i;
const CODE_LANG_RE = /\b(java|python|javascript|typescript|js|ts|golang|rust|kotlin|swift|php|ruby|perl|c\+\+|c#|csharp|sql|bash|shell|powershell|html|css|react|reactjs|node|nodejs|django|flask|spring)\b/i;

const detectCodeRequest = (text, { codeOnly = false, unit = null, format = '' } = {}) => {
  if (codeOnly || format === 'code-only' || unit === 'program' || format === 'sql') return true;
  const t = String(text || '');
  return (
    (CODE_VERB_RE.test(t) && (CODE_NOUN_RE.test(t) || CODE_LANG_RE.test(t))) ||
    (CODE_LANG_RE.test(t) && CODE_NOUN_RE.test(t)) ||
    /\b(code|program|snippet)\s+(only|alone|without)\b/i.test(t)
  );
};

/** Requested output format (only one primary format is ever enforced). */
const detectFormat = (text, req = {}) => {
  const t = String(text || '');
  if (req.codeOnly) return 'code-only';
  if (/\bmcqs?\b|\bmultiple[- ]choice\b/i.test(t)) return 'mcq';
  if (/\b(as|in)\s+json\b|\bjson\s+(format|only|output)\b/i.test(t)) return 'json';
  if (/\bcsv\b/i.test(t)) return 'csv';
  if (/\b(timetable|time\s?table)\b/i.test(t)) return 'table';
  if (/\b(in a table|as a table|table format|in table form|as a tabular|as a comparison table)\b/i.test(t)) return 'table';
  // Exam / study register ("explain for exam", "5 marks answer", "important
  // questions", "previous year question paper"). Topic-agnostic like every
  // other format: it just asks for an exam-ready, studyable structure.
  if (/\b(?:for|in|during)\s+(?:the\s+)?(?:exam|test|examination)\b|\b(?:exam|test)\s+(?:style|format|pattern)\b|\bquestion\s+paper\b|\b(?:previous|last)(?:\s+(?:year|years?|yr|yrs))?['’]?\s+(?:questions?|papers?|problems?)\b|\bimportant\s+(?:questions?|topics?|points?)\b|\bnumerical\s+problems?\b|\b\d{1,2}\s*[- ]?marks?\s+(?:answer|question|note|problem|essay)\b|\b(?:expected|most(?:\s+asked)?|likely)\s+questions?\b/i.test(t)) return 'exam';
  if (/\b(briefly|in short|short answer|short version|in one line|one[- ]liner|concise|tl;?dr|a few lines)\b/i.test(t)) return 'short';
  if (/\b(detailed|in[- ]depth|elaborate|comprehensive|thorough|deep dive|full explanation|long answer)\b/i.test(t)) return 'detailed';
  if (/\b(compare|comparison|difference between|vs\.?|versus|differences between)\b/i.test(t)) return 'comparison';
  if (/\b(step[- ]by[- ]step|steps to|steps for|give steps)\b/i.test(t)) return 'steps';
  if (/\b(sql|query|queries)\b/i.test(t) && req.unit === 'item') return 'sql';
  if (/\b(explain|explanation|what is|what are|how does|why|teach me)\b/i.test(t)) return 'explanation';
  return 'auto';
};

/** The first countable unit noun mentioned anywhere in the question. */
const findAnyUnit = (text) => {
  const t = String(text || '').toLowerCase();
  let best = null;
  let bestIdx = Infinity;
  for (const unit of UNITS) {
    const re = new RegExp(`\\b(?:${unit.words})\\b`, 'i');
    const m = re.exec(t);
    if (m && m.index < bestIdx) {
      bestIdx = m.index;
      best = unit.key;
    }
  }
  return best;
};

/** Continuation follow-ups: "10 more", "give more", "make it 20", "continue". */
const detectContinuation = (text) => {
  const t = String(text || '');
  const more = /\b(\d{1,4})\s*(?:more|additional|extra|further)\b|\b(more|another|further|additional)\s+(\d{1,4})\b/i.exec(t);
  const moreN = more ? Number(more[1] || more[3]) : 0;
  const bareMore = /\b(more|another|rest of (?:them|these|the))\b/i.test(t);
  const grow = /\bmake\s+(?:it|that|them)\s+(\d{1,4})\b|\b(?:increase|extend|go up)\s+to\s+(\d{1,4})\b|\b(?:add|give)\s+(?:another\s+)?(\d{1,4})\s+more\b/i.exec(t);
  const continueWord = /^\s*(continue|keep going|go on|proceed|next)\b/i.test(t);

  const isContinuation = Boolean(grow || moreN || bareMore || continueWord);
  return {
    isContinuation,
    addCount: moreN || (grow ? 0 : 0) || null,
    // "make it 20" -> the TOTAL the user wants, not an increment.
    targetTotal: grow ? Number(grow[1] || grow[2] || grow[3] || 0) || null : null,
  };
};

const wantsAll = (text) =>
  /\b(all|every|each|full|complete|entire)\b/i.test(String(text || '')) &&
  !/\b(of|for|about)\s+(all|every)\b/i.test(String(text || ''));

/**
 * Counts how many list items the previous answer actually delivered. */
const numberedRuns = (text) => {
  const nums = new Set();
  const t = String(text || '');
  // "1. text", "1) text", "1. **Title**", "**1.** text", "**1**. text"
  const re1 = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*(\d{1,4})[ \t]*[.)][ \t]*\**[ \t]*(?:[ \t]+\S|$)/gm;
  let m;
  while ((m = re1.exec(t)) !== null) nums.add(Number(m[1]));
  // "1: text", "**1:** text", "20: 20 40 60 ..." — a colon-keyed row is just as
  // valid a list marker as "1." and is extremely common for tables/grids. Missing
  // it made a complete 20-row answer score 0 items, which both failed the check
  // and triggered a bogus continuation that restarted at item 1. What follows the
  // colon must not be a digit, so a clock time ("10:30 AM") is never an item.
  const re1b = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*(\d{1,4})[ \t]*:\**[ \t]+/gm;
  while ((m = re1b.exec(t)) !== null) nums.add(Number(m[1]));
  // "## Table 5", "**Table 5**", "Table 5:"
  const re2 = /(?:^|\n)[ \t#*]*(?:table|step|question|problem|example|no\.?)[ \t]+(\d{1,4})\b/gi;
  while ((m = re2.exec(t)) !== null) nums.add(Number(m[1]));
  return nums;
};

/** Non-empty bullet/dash lines — used when a list is not numbered. */
const bulletCount = (text) => {
  const t = String(text || '');
  let n = 0;
  // "- text", "1. text", "1: text" (colon-keyed rows count as items too). After a
  // colon the next char must NOT be a digit, so "10:30 AM" is never an item.
  const re = /^[ \t]*(?:[-*+]|\**[ \t]*\d{1,4}[ \t]*[.)][ \t]*\**[ \t]*\S|\**[ \t]*\d{1,4}[ \t]*:\**[ \t]+)/gm;
  let m;
  while ((m = re.exec(t)) !== null) n += 1;
  return n;
};

// ---------------------------------------------------------------------------
// 1) analyzeRequest
// ---------------------------------------------------------------------------

/**
 * Extracts the user's OUTPUT requirements from the question plus the recent
 * conversation. Pure, synchronous and topic-agnostic.
 *
 * @param {{question?:string, history?:Array, previousAnswer?:string}} input
 * @returns {{
 *   itemCount:number|null, range:{from:number,to:number}|null, unit:string|null,
 *   wordCount:number|null, wordMode:string, format:string, codeOnly:boolean,
 *   codeRequest:boolean,
 *   noComments:boolean, wantsAll:boolean,
 *   isContinuation:boolean, continueFrom:number|null, targetTotal:number|null,
 *   previousItemCount:number, missingCount:number
 * }}
 */
const analyzeRequest = ({ question = '', history = [], previousAnswer = '' } = {}) => {
  const q = String(question || '');
  const prev = String(previousAnswer || '') ||
    ((history || [])
      .slice()
      .reverse()
      .find((m) => m && (m.role === 'ai' || m.role === 'assistant') && String(m.content || '').trim()) || {}).content || '';

  const cont = detectContinuation(q);
  const words = detectWordCount(q);
  const range = detectRange(q);
  const counts = detectCount(q).filter((c) => c.count >= 1 && c.count <= MAX_QUANTITY);
  const all = wantsAll(q);

  // Pick the count that actually names a unit; otherwise the largest one.
  const withUnit = counts.filter((c) => c.unit);
  let picked = withUnit.length ? withUnit[withUnit.length - 1] : null;
  if (!picked) {
    const bare = counts.filter((c) => !c.unit && !detectWordCount(q.slice(Math.max(0, c.index - 12), c.index + 24) || ''));
    if (bare.length) picked = bare[bare.length - 1];
  }

  const prevNums = numberedRuns(prev);
  const previousItemCount = prevNums.size
    ? Math.max(...prevNums)
    : (prev ? bulletCount(prev) : 0);

  let itemCount = null;
  let unit = null;
  let targetFrom = null;
  let targetTotal = null;

  if (cont.targetTotal) {
    // "make it 20" -> fulfil up to the new TOTAL.
    targetTotal = clamp(cont.targetTotal, 1, MAX_QUANTITY);
    itemCount = Math.max(0, targetTotal - previousItemCount);
    unit = picked ? picked.unit : null;
    targetFrom = previousItemCount + 1;
  } else if (cont.isContinuation && !picked) {
    // bare "give me more" / "continue": mirror the previous list's size.
    const add = cont.addCount || (previousItemCount || 5);
    itemCount = clamp(add, 1, MAX_QUANTITY);
    unit = null;
    targetFrom = previousItemCount + 1;
  } else if (picked) {
    itemCount = clamp(picked.count, 1, MAX_QUANTITY);
    unit = picked.unit;
  }

  if (range) {
    // An explicit range always wins: "tables from 1 to 10" is 10 tables.
    targetFrom = range.from;
    itemCount = clamp(range.to - range.from + 1, 1, MAX_QUANTITY);
    // The unit noun usually sits BEFORE the range ("tables 1-10"), so fall back
    // to the first countable noun anywhere in the question.
    unit = unit || picked?.unit || findAnyUnit(q);
  } else if (cont.isContinuation && !cont.targetTotal && cont.addCount) {
    itemCount = clamp(cont.addCount, 1, MAX_QUANTITY);
    unit = unit || (picked ? picked.unit : 'item');
    targetFrom = previousItemCount + 1;
  } else if (cont.isContinuation) {
    targetFrom = previousItemCount ? previousItemCount + 1 : null;
  }

  // "give all tables" — a real but unbounded request: budget generously and
  // never claim a specific count.
  const unbounded = all && !itemCount && !range;

  const codeOnly = detectCodeOnly(q);
  const format = detectFormat(q, { unit, codeOnly });

  return {
    itemCount: itemCount || null,
    range: range || null,
    unit: unit || null,
    unitCost: (unit && UNIT_BY_KEY[unit] && UNIT_BY_KEY[unit].cost) || null,
    wordCount: words ? words.words : null,
    wordMode: words ? words.mode : 'none',
    format,
    codeOnly,
    codeRequest: detectCodeRequest(q, { codeOnly, unit, format }),
    noComments: detectNoComments(q),
    wantsAll: Boolean(unbounded),
    isContinuation: cont.isContinuation,
    continueFrom: targetFrom,
    targetTotal,
    previousItemCount,
    missingCount: itemCount || 0,
  };
};

// ---------------------------------------------------------------------------
// 2) planOutput — dynamic output-token budget
// ---------------------------------------------------------------------------

// A plain conversational answer ("hi", "what is Java?") should stay cheap;
// the budget only grows when the USER asked for volume.
const BASE_BUDGET = 700;
const SHORT_BUDGET = 400;
const MIN_BUDGET = 300;

// ~1.6 tokens per word for prose, plus headroom so the model is never squeezed
// into truncation by the budget itself.
const TOKENS_PER_WORD = 1.75;
const WORD_HEADROOM = 500;

// Per-item overhead beyond the unit cost (a numbered line, its blank line, and
// the closing punctuation the model needs).
const ITEM_OVERHEAD = 12;

/**
 * Chooses the output-token budget for one request. Dynamic, not per-intent:
 * a short question stays cheap, and "1000 words" / "100 questions" get a real
 * budget that can actually finish.
 *
 * @param {ReturnType<analyzeRequest>} req
 * @param {{cap?:number, formatHint?:string}} opts
 * @returns {{maxTokens:number, reason:string, needsContinuation:boolean}}
 */
const planOutput = (req = {}, opts = {}) => {
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 8192;
  const parts = [];
  let need = 0;

  if (req.wordCount) {
    need += Math.round(req.wordCount * TOKENS_PER_WORD) + WORD_HEADROOM;
    parts.push(`${req.wordCount} words requested`);
  }

  if (req.itemCount) {
    const perItem = (req.unitCost || DEFAULT_UNIT_COST) + ITEM_OVERHEAD;
    need += req.itemCount * perItem;
    parts.push(`${req.itemCount}${req.unit ? ` ${req.unit}s` : ' items'} requested`);
  } else if (req.wantsAll) {
    need += 12 * (DEFAULT_UNIT_COST + ITEM_OVERHEAD);
    parts.push('unbounded "all" requested');
  } else if (req.format === 'detailed' || req.format === 'exam') {
    need += 1600;
    parts.push(req.format === 'exam' ? 'exam-style answer requested' : 'detailed answer requested');
  } else if (req.format === 'explanation' || req.format === 'comparison') {
    need += 900;
    parts.push(`${req.format} requested`);
  }

  // Smallest sensible answer for an ordinary question.
  need = Math.max(need, req.format === 'short' || req.format === 'code-only' ? SHORT_BUDGET : BASE_BUDGET);

  const maxTokens = clamp(Math.round(need), MIN_BUDGET, cap);
  return {
    maxTokens,
    reason: `${maxTokens} tokens (${parts.length ? parts.join(' + ') : 'normal conversational answer'})`,
    needsContinuation: Boolean(req.itemCount || req.wordCount || req.wantsAll),
  };
};

// ---------------------------------------------------------------------------
// 3) buildDirective — the constraints handed to the model
// ---------------------------------------------------------------------------

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * Renders the requirements as explicit, topic-neutral instructions for the
 * system prompt. This is NOT the only defence (the budget + continuation are),
 * it just makes the FIRST attempt aim correctly.
 */
const buildDirective = (req = {}) => {
  const lines = [];

  // ---- Universal fulfilment rule (always present, cheap, decisive) ----
  lines.push(
    "DELIVER EXACTLY WHAT WAS ASKED: fulfil the request precisely — the stated number, range, word count, and format. Never silently reduce the amount, never stop part-way, never end with '...', 'and so on', 'the rest are similar', or 'would you like more?'. Do not add sections, advice, career commentary, follow-up offers or unrelated content that was not requested."
  );

  if (req.itemCount && req.unit) {
    const label = `${req.itemCount} ${req.unit}${req.itemCount === 1 ? '' : 's'}`;
    lines.push('DISTINCTNESS: every item must be meaningfully distinct; never repeat an item just to reach the requested count.');
    if (req.range) {
      lines.push(
        `QUANTITY (mandatory): produce ${label} — ${req.range.from} through ${req.range.to} inclusive, numbered/labeled from ${req.range.from} to ${req.range.to}. Every single one must be present; the list must end at ${req.range.to}.`
      );
    } else if (req.continueFrom && req.continueFrom > 1) {
      lines.push(
        `QUANTITY (mandatory): this answer must add exactly ${label}, continuing from ${req.continueFrom} (i.e. ${req.continueFrom} to ${req.continueFrom + req.itemCount - 1}). Do NOT repeat anything you already gave, and do not restart the numbering.`
      );
    } else {
      lines.push(
        `QUANTITY (mandatory): produce EXACTLY ${label}, numbered 1 to ${req.itemCount}. The list is only finished when ${req.itemCount} is written. If you feel the list is getting long, that is fine — keep going until the last item exists.`
      );
    }
  } else if (req.itemCount) {
    // A bare quantity ("give me 10 more") still has to respect the continuation
    // window. Telling the model "numbered 1 to 10" while the CONTINUATION line
    // below says "never restart from 1" is a contradiction, and the model resolved
    // it by restarting — which is exactly what the follow-up must not do.
    if (req.continueFrom && req.continueFrom > 1) {
      const last = req.continueFrom + req.itemCount - 1;
      lines.push(
        `QUANTITY (mandatory): this answer must add EXACTLY ${req.itemCount} NEW items, numbered ${req.continueFrom} to ${last}. Do not repeat anything you already gave and do not restart the numbering at 1.`
      );
    } else {
      lines.push(
        `QUANTITY (mandatory): produce EXACTLY ${req.itemCount} items, numbered 1 to ${req.itemCount}. The list is only finished when ${req.itemCount} is written.`
      );
    }
  } else if (req.wantsAll) {
    lines.push(
      'QUANTITY: the user asked for everything ("all"). Be comprehensive and complete rather than stopping early.'
    );
  }

  if (req.wordCount) {
    if (req.wordMode === 'exact') {
      lines.push(
        `LENGTH (mandatory): the answer must be EXACTLY ${req.wordCount} words. Write roughly ${Math.round(req.wordCount * 1.06)} words of raw text, then trim to ${req.wordCount}. Count as you go. Do not exceed it and do not fall far short.`
      );
    } else if (req.wordMode === 'atleast') {
      lines.push(`LENGTH (mandatory): write AT LEAST ${req.wordCount} words of complete explanation.`);
    } else {
      lines.push(
        `LENGTH (mandatory): write approximately ${req.wordCount} words. Keep the explanation complete and properly developed — do NOT compress it into a much shorter answer.`
      );
    }
  }

  if (req.codeOnly) {
    lines.push(
      'OUTPUT: output ONLY the code (inside one fenced code block with the correct language tag). No explanation, no commentary, no surrounding sentences, no extra sections.'
    );
  } else if (req.format === 'table' || req.format === 'comparison') {
    lines.push(
      'OUTPUT: use a markdown table (| column | column | header row + separator row). Do not replace the table with paragraphs or bullets.'
    );
  } else if (req.format === 'mcq') {
    lines.push(
      'OUTPUT: every item must contain the question, lettered options (A/B/C/D), and the correct answer with a short reason.'
    );
  } else if (req.format === 'steps') {
    lines.push('OUTPUT: numbered steps in order, each step a single actionable action.');
  } else if (req.format === 'exam') {
    lines.push(
      'OUTPUT: exam-style answer — lead with the key points, then precise definitions, in crisp bullet structure that is easy to revise. If marks were mentioned ("5 marks"), match the depth to that weight. Stay on-topic and study-ready; do not pad with unrelated material.'
    );
  } else if (req.format === 'json') {
    lines.push('OUTPUT: output valid JSON only (no prose outside it, no markdown fence).');
  } else if (req.format === 'csv') {
    lines.push('OUTPUT: CSV-style rows with a header row, comma separated.');
  } else if (req.format === 'short') {
    lines.push('OUTPUT: keep it genuinely short — a brief, direct answer. Do not pad it with extra sections.');
  } else if (req.format === 'explanation' || req.format === 'detailed') {
    lines.push(
      'OUTPUT: answer the exact question asked, as an explanation (headings + paragraphs + a concrete example where useful). Do not wander into unrelated topics.'
    );
  }

  if (req.noComments) {
    lines.push('CODE: include NO comments inside the code — not a single one.');
  }

  if (req.codeRequest) {
    lines.push(
      'CODE (mandatory): prefer the SHORTEST clear, correct solution that satisfies exactly what was asked. Do not add unnecessary helper classes, helper methods, extra parameters, documentation, comments, advanced data structures or features nobody asked for. Keep imports/requires to exactly what the code uses. Follow the requested programming language, input format, output format and platform constraints. If the user asked for dynamic input, read it the standard way for that language; if a complete runnable program was asked for, include the required imports and class; if only a snippet was asked for, provide just that snippet. Never sacrifice correctness or a real requirement to make the code shorter.'
    );
    if (!req.codeOnly) {
      lines.push(
        'STRUCTURE (mandatory): when this answer contains both an explanation and code, write it as: "**Explanation**" (a short explanation of the approach), then "**Code**" immediately followed by ONE fenced code block containing ONLY the complete code with the correct language tag, then "**Output**" only when useful or requested, then "**Time and space complexity**" only when relevant or requested. Never put explanatory prose inside the code block and never wrap the code in quotes or italics.'
      );
    }
  }

  if (req.isContinuation) {
    lines.push(
      'CONTINUATION: this is a follow-up on your previous answer. Continue the same topic and the same format, adding only NEW items — never repeat earlier items and never restart from 1.'
    );
  }

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// 4) Completeness check + continuation
// ---------------------------------------------------------------------------

/**
 * Finds the content of the last line whose marker equals `rowNumber`
 * ("20: …" or "Table 20: …"). Returns the content after the colon or null.
 */
const MARKER_ROW_RE = /^[ \t]*(?:[-*+][ \t]+)?\**#{0,3}[ \t]*(?:(?:table|step|item|question|problem|example)\s+)?(\d{1,4})[ \t]*:[ \t]*(.+)$/i;
const lastRowLine = (body, rowNumber) => {
  let found = null;
  for (const line of String(body || '').split('\n')) {
    const m = MARKER_ROW_RE.exec(line);
    if (m && Number(m[1]) === rowNumber) found = m[2];
  }
  return found;
};

/**
 * Detects a product row whose CONTENT has been cut off even though its marker
 * ("20:") is present — "20: 20x1=20 20x2=40 … 20x10=200" for tables to 20.
 * The check is a generic arithmetic fact, not a subject rule: every term must
 * verify as a correct product (C === N×k) and the multipliers must reach the
 * request's own outer bound. Rows without product terms ("20: 20 40 … 400"),
 * rows that reach the bound, and non-arithmetic prose are never flagged.
 *
 * @returns {{terms:number, maxK:number, bound:number}|null}
 */
const PRODUCT_ROW_RE = /(?:^|[\s,;])(\d{1,4})\s*[x×*]\s*(\d{1,4})\s*=\s*(\d{1,6})/g;
const partialProductRow = (line, rowNumber, bound) => {
  const multipliers = [];
  let m;
  while ((m = PRODUCT_ROW_RE.exec(String(line || ''))) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (c !== a * b) continue; // not an arithmetic product — ignore
    // In "20x1=20" the multiplier is the operand that is NOT the row number;
    // in "20x20=400" both are, and the multiplier is 20 either way.
    const k = a === rowNumber ? b : (b === rowNumber ? a : null);
    if (k !== null && k >= 1) multipliers.push(k);
  }
  if (multipliers.length < 2) return null; // too little evidence to judge
  const maxK = Math.max(...multipliers);
  if (maxK >= bound) return null; // reaches the full range — not cut off
  return { terms: multipliers.length, maxK, bound };
};

/**
 * Lightweight, general completeness check. Deliberately tolerant: a false
 * "complete" costs at most one extra continuation call, a false "incomplete"
 * on a complete answer would append junk — so the thresholds err towards done.
 *
 * @param {string} text  the answer produced so far
 * @param {ReturnType<analyzeRequest>} req
 * @returns {{complete:boolean, nextIndex:number|null, produced:number,
 *            words:number, target:number|null, reason:string, kind:string}}
 */
const checkCompleteness = (text, req = {}) => {
  const body = String(text || '');
  const words = wordCount(body);
  const wTarget = req.wordCount || null;

  // ---- Word-count requests ----
  if (wTarget) {
    if (req.wordMode === 'exact') {
      const floor = Math.round(wTarget * 0.94);
      if (words < floor) {
        return { complete: false, nextIndex: null, produced: words, words, target: wTarget, reason: `only ${words} words of ${wTarget}`, kind: 'words' };
      }
      return { complete: true, nextIndex: null, produced: words, words, target: wTarget, reason: `${words} words (target ${wTarget})`, kind: 'words' };
    }
    // "about N" / "at least N": aim at 80% before spending another call.
    const floor = req.wordMode === 'atleast' ? wTarget : Math.round(wTarget * 0.8);
    if (words < floor) {
      return { complete: false, nextIndex: null, produced: words, words, target: wTarget, reason: `only ${words} words of ~${wTarget}`, kind: 'words' };
    }
    return { complete: true, nextIndex: null, produced: words, words, target: wTarget, reason: `${words} words (~${wTarget})`, kind: 'words' };
  }

  // ---- Item / range requests ----
  if (req.itemCount) {
    const from = req.continueFrom && req.continueFrom > 1 ? req.continueFrom : 1;
    const to = req.targetTotal ? req.targetTotal : from + req.itemCount - 1;
    const nums = numberedRuns(body);
    let produced = 0;
    let missingFrom = null;
    for (let i = from; i <= to; i += 1) {
      if (nums.has(i)) produced += 1;
      else if (missingFrom === null) missingFrom = i;
    }

    // A follow-up ("give me 10 more") is satisfied by 10 FRESH items even if the
    // model restarted the numbering at 1 — the user got 10 more items, which is
    // what they asked for; the numbering is cosmetic. Counting only from `from`
    // would read a perfectly good answer as 0 items and then spend a continuation
    // call asking for items the user already has.
    if (from > 1 && produced < req.itemCount) {
      let restart = 0;
      for (let i = 1; i <= req.itemCount; i += 1) if (nums.has(i)) restart += 1;
      if (restart >= req.itemCount) {
        return {
          complete: true,
          nextIndex: null,
          produced: restart,
          words,
          target: to,
          reason: `${restart} new items delivered (numbering restarted at 1)`,
          kind: 'items',
        };
      }
    }
    // A numbered run that is not number-tagged at all (model wrote a heading
    // per table but no digits) falls back to counting list lines.
    const useBullets = produced === 0 && body.length > 40;
    const effective = useBullets ? bulletCount(body) : produced;
    if (effective < req.itemCount) {
      return {
        complete: false,
        nextIndex: missingFrom !== null ? missingFrom : from + effective,
        produced: effective,
        words,
        target: to,
        reason: useBullets
          ? `${effective}/${req.itemCount} items found`
          : `items ${from}..${(missingFrom !== null ? missingFrom - 1 : to)} of ${from}..${to} present`,
        kind: useBullets ? 'bullets' : 'items',
      };
    }
    // Markers can ALL be present while the LAST row's content is still cut off
    // ("20: 20x1=20 … 20x10=200" for tables 1 to 20). Only arithmetically sound
    // product rows are judged; the bound is the request's own range end.
    if (req.range && req.range.to > 1 && effective >= req.itemCount) {
      const last = lastRowLine(body, to);
      if (last) {
        const partial = partialProductRow(last, to, req.range.to);
        if (partial) {
          return {
            complete: false,
            nextIndex: null,
            produced: effective,
            words,
            target: to,
            reason: `row ${to} stops at x${partial.maxK} of x${partial.bound} (${partial.terms} products)`,
            kind: 'partialRow',
            partialRow: to,
            partialMaxK: partial.maxK,
            partialBound: partial.bound,
          };
        }
      }
    }
    return { complete: true, nextIndex: null, produced: effective, words, target: to, reason: `items ${from}..${to} all present`, kind: 'items' };
  }

  return { complete: true, nextIndex: null, produced: 0, words, target: null, reason: 'no finite quantity requested', kind: 'none' };
};

/**
 * The INTERNAL continuation instruction. It is sent as an extra `user` turn to
 * the provider only — it is never persisted to the chat and never rendered, so
 * the user receives ONE seamless, complete answer.
 */
const buildContinuationPrompt = ({ req = {}, check = {}, producedText = '', question = '' } = {}) => {
  const lines = [
    '[INTERNAL CONTINUATION INSTRUCTION — do not acknowledge, do not mention this message, do not apologise, do not explain that you were cut off. The user must see one seamless complete answer.]',
    `The user's original request was: "${String(question || '').trim()}"`,
  ];

  if (check.kind === 'partialRow') {
    const p = check.partialRow;
    const fromK = (check.partialMaxK || 0) + 1;
    const toK = check.partialBound || 0;
    lines.push(
      `Your previous reply stopped halfway through row ${p}: it only reaches ×${check.partialMaxK} of ×${toK}. Finish that row COMPLETELY — continue from ${p}×${fromK}=… ${p}×${fromK + 1}=… through ${p}×${toK}=… — using the SAME layout, line and format as the row it continues. Do NOT restart, do NOT repeat any earlier row, do NOT add an introduction or a closing, and never use "..." or "and so on" in place of the missing products.`
    );
  } else if (check.kind === 'words') {
    const missing = Math.max(50, (check.target || 0) - (check.words || 0));
    lines.push(
      `Your previous reply ended after about ${check.words} words but the user asked for ${check.target} words. Continue the SAME answer from exactly where it stopped and write roughly ${Math.min(missing, 1200)} more words of new, non-repeating content to reach the requested length. Do not repeat or summarise what you already wrote, do not restart, do not add a preamble like "Continuing…".`
    );
  } else if (check.nextIndex) {
    const to = check.target || check.nextIndex + Math.max(0, (req.itemCount || 1) - 1);
    lines.push(
      `Your previous reply stopped at item ${check.nextIndex - 1}. You MUST continue with item ${check.nextIndex} and keep going until item ${to} — that is ${Math.max(0, to - check.nextIndex + 1)} more item(s) that are still missing.`
    );
    lines.push(
      'Rules for this continuation: start immediately with the next item; use the SAME numbering and the SAME format as before; do NOT restart at 1; do NOT repeat, re-list, or summarise earlier items; do NOT write any introduction, conclusion, "let me know" or follow-up question; never use "..." or "and so on" in place of the missing items.'
    );
  } else {
    lines.push(
      'Your previous reply was cut off before it was complete. Continue it from exactly where it stopped, adding only new content. Do not restart, repeat, or summarise what you already wrote, and do not add a preamble or a closing question.'
    );
  }

  return lines.join('\n');
};

/**
 * Merges a continuation into the first answer without duplicating anything.
 *
 * Two independent safety nets:
 *   1. NUMBER-aware: if the continuation restarted at 1, everything up to and
 *      including the first item numbered above the last one already present is
 *      dropped.
 *   2. LINE-aware: any leading lines of the continuation that already appear at
 *      the end of the first answer (a re-printed header, a repeated preamble)
 *      are dropped.
 */
const mergeContinuation = (existing, extra) => {
  let add = String(extra || '').replace(/\s+$/, '');
  const head = String(existing || '').replace(/\s+$/, '');
  if (!add) return head;

  // ---- 1. number-aware cut ----
  const ITEM_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?(\d{1,4})[.)][ \t]+\S/;
  const HEADING_LINE_RE = /^[ \t#*]*(?:table|step|question|problem|example|no\.?)[ \t]+(\d{1,4})\b/i;
  const itemNumber = (line) => {
    const m = ITEM_LINE_RE.exec(line) || HEADING_LINE_RE.exec(line);
    return m ? Number(m[1]) : null;
  };

  const existingNums = numberedRuns(head);
  const lastNum = existingNums.size ? Math.max(...existingNums) : 0;
  if (lastNum > 0) {
    const lines = add.split('\n');
    const addNums = numberedRuns(add);
    const restarted = addNums.size > 0 && Math.min(...addNums) <= lastNum;

    if (restarted) {
      // The model restarted from 1: drop everything up to and including the
      // first item numbered above what we already have.
      const firstNewIdx = lines.findIndex((l) => {
        const n = itemNumber(l);
        return n !== null && n > lastNum;
      });
      if (firstNewIdx === -1) {
        // The continuation only repeats markers we already have — but it can
        // still be a RE-EMISSION of the last row with the missing products
        // appended ("20: 20x1=20 … 20x20=400" after "…20x10=200"). That is
        // seam content, not duplication: fall through with the raw extra and
        // let the seam-join (step 3) de-dupe the prefix. Pure duplicates then
        // overlap fully and add nothing, so head is still returned.
        add = String(extra || '').replace(/\s+$/, '');
      } else {
        add = lines.slice(firstNewIdx).join('\n');
      }
    } else {
      // Forward continuation: drop any preamble ("Sure, here you go:") that
      // precedes the first real item, so the joined answer reads as one.
      const firstItemIdx = lines.findIndex((l) => itemNumber(l) !== null);
      if (firstItemIdx > 0) {
        const preamble = lines.slice(0, firstItemIdx).join(' ').trim();
        // Only drop a short connector line, never a substantive sentence.
        if (preamble.length <= 120) add = lines.slice(firstItemIdx).join('\n');
      }
    }
  }

  // ---- 2. line-overlap drop (a repeated item / closing line at the seam) ----
  const addLines = add.split('\n');
  const headLines = head.split('\n');
  const tailSet = new Set(
    headLines.slice(-6).map((l) => l.trim().replace(/\*\*/g, '')).filter((l) => l.length > 2)
  );
  let start = 0;
  while (start < addLines.length) {
    const probe = addLines[start].trim().replace(/\*\*/g, '');
    if (probe.length > 2 && tailSet.has(probe)) start += 1;
    else break;
  }
  add = addLines.slice(start).join('\n').trim();

  if (!add) return head;

  // ---- 3. seam-line extension for a marker-free continuation ----------------
  // A continuation with NO new item markers is the remainder of the LAST line —
  // the typical shape when a product row was cut ("20: … 20x10=200") and the
  // model writes straight on, or re-emits the same "20:" row with the missing
  // products appended. Glue it onto the same line (de-duping any re-emitted
  // prefix by longest-overlap) so the answer reads as ONE contiguous row.
  const headLinesFinal = head.split('\n');
  const lastLine = headLinesFinal[headLinesFinal.length - 1] || '';
  const km = (l) => {
    const m = /^[ \t]*(?:[-*+][ \t]+)?\**#*\s*(\d{1,4})\s*:/.exec(l);
    return m ? Number(m[1]) : null;
  };
  const lastMarker = km(lastLine);
  const seamContent = add.split('\n').every((l, idx) => {
    if (!l.trim()) return true;
    if (itemNumber(l) !== null) return false; // a new numbered item -> paragraph
    if (idx === 0 && lastMarker !== null && km(l) === lastMarker) return true; // re-emits the SAME row
    if (/^[ \t]*\**#*\s*\d{1,4}\s*:\s*\S/.test(l)) return false; // a NEW colon row -> paragraph
    return true;
  });
  if (seamContent && lastLine.trim() && add.trim().length >= 12) {
    const e = add.trim();
    let overlap = 0;
    const maxO = Math.min(lastLine.length, e.length);
    for (let len = maxO; len >= 6; len -= 1) {
      if (lastLine.slice(-len) === e.slice(0, len)) { overlap = len; break; }
    }
    const tail = e.slice(overlap).trim();
    return tail ? `${head} ${tail}` : head;
  }
  return `${head}\n\n${add}`;
};

module.exports = {
  analyzeRequest,
  planOutput,
  buildDirective,
  checkCompleteness,
  buildContinuationPrompt,
  mergeContinuation,
  estimateTokens,
  wordCount,
  numberedRuns,
  bulletCount,
  ordinal,
  UNITS,
  MAX_QUANTITY,
  MAX_WORDS,
};
