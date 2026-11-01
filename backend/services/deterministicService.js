// Small, unambiguous computations that are faster and more accurate without an
// external provider. Anything requiring interpretation remains on the LLM path.

const TABLE_REQUEST_RE = /\b(?:multiplication|times)\s+tables?\b|\btable\s+of\s+\d+\b/i;
const RANGE_RE = /\b(?:from|between)\s+(\d{1,3})\s+(?:to|and)\s+(\d{1,3})\b|\b(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})\b/i;
const SINGLE_TABLE_RE = /\btable\s+of\s+(\d{1,3})\b/i;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const tableNumbers = (question) => {
  const text = String(question || '');
  const range = RANGE_RE.exec(text);
  if (range) {
    const from = Number(range[1] || range[3]);
    const to = Number(range[2] || range[4]);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      const start = clamp(Math.min(from, to), 0, 1000);
      const end = clamp(Math.max(from, to), start, 1000);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
  }
  const single = SINGLE_TABLE_RE.exec(text);
  if (single) return [clamp(Number(single[1]), 0, 1000)];
  const count = /\b(\d{1,3})\s+(?:multiplication|times)\s+tables?\b/i.exec(text);
  if (count) {
    const total = clamp(Number(count[1]), 1, 1000);
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  return null;
};

const generateMultiplicationTables = (numbers) =>
  numbers.map((n) => [
    `### Table ${n}`,
    Array.from({ length: 10 }, (_, i) => `${n} × ${i + 1} = ${n * (i + 1)}`).join('\n'),
  ].join('\n')).join('\n\n');

const tryDeterministic = (question) => {
  const text = String(question || '').trim();
  if (!TABLE_REQUEST_RE.test(text)) return null;
  const numbers = tableNumbers(text);
  if (!numbers || !numbers.length) return null;
  return {
    answer: generateMultiplicationTables(numbers),
    completion: {
      complete: true,
      kind: 'items',
      requested: numbers.length,
      produced: numbers.length,
      target: numbers[numbers.length - 1],
      nextIndex: null,
      reason: `tables ${numbers[0]}..${numbers[numbers.length - 1]} generated deterministically`,
    },
    intent: 'GENERAL',
    mode: 'deterministic',
    chunkCount: 0,
    sections: [],
    resources: [],
    sources: [],
  };
};

module.exports = { tryDeterministic, tableNumbers, generateMultiplicationTables };
