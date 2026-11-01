// Small, unambiguous computations that are faster and more accurate without an
// external provider. Anything requiring interpretation remains on the LLM path.

const TABLE_REQUEST_RE = /\b(?:multiplication|times)\s+tables?\b|\btable\s+of\s+\d+\b/i;
const RANGE_RE = /\b(?:from|between)\s+(\d{1,3})\s+(?:to|and)\s+(\d{1,3})\b|\b(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})\b/i;
const SINGLE_TABLE_RE = /\btable\s+of\s+(\d{1,3})\b/i;
const PERCENT_OF_RE = /^\s*(?:what\s+is\s+)?(-?\d+(?:\.\d+)?)\s*%\s+of\s+(-?\d+(?:\.\d+)?)\s*\??\s*$/i;
const PERCENT_CHANGE_RE = /^\s*(?:increase|decrease|reduce|discount)\s+(-?\d+(?:\.\d+)?)\s+(?:by|of)\s+(-?\d+(?:\.\d+)?)\s*%\s*\??\s*$/i;
const LCM_HCF_RE = /^\s*(lcm|hcf|gcd|greatest\s+common\s+divisor|least\s+common\s+multiple)\s+(?:of|for)\s+(-?\d+(?:\.\d+)?)\s*(?:,|and)\s*(-?\d+(?:\.\d+)?)\s*\??\s*$/i;
const CONVERSION_RE = /^\s*(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*(km|kilometers?|m|meters?|cm|centimeters?|mm|millimeters?|kg|kilograms?|g|grams?|lb|pounds?|c|°c|celsius|f|°f|fahrenheit)\s+(?:to|into)\s*(km|kilometers?|m|meters?|cm|centimeters?|mm|millimeters?|kg|kilograms?|g|grams?|lb|pounds?|c|°c|celsius|f|°f|fahrenheit)\s*\??\s*$/i;
const ARITHMETIC_RE = /^\s*(?:calculate|compute|evaluate|what\s+is|solve)\s+([-+*/%().\d\s]+)\??\s*$/i;

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

const normalizeUnit = (unit) => {
  const value = String(unit || '').toLowerCase();
  if (/^km|kilometer/.test(value)) return 'km';
  if (/^m$|^meter/.test(value)) return 'm';
  if (/^cm|centimeter/.test(value)) return 'cm';
  if (/^mm|millimeter/.test(value)) return 'mm';
  if (/^kg|kilogram/.test(value)) return 'kg';
  if (/^g$|^gram/.test(value)) return 'g';
  if (/^lb|pound/.test(value)) return 'lb';
  if (/^(c|°c|celsius)$/.test(value)) return 'c';
  if (/^(f|°f|fahrenheit)$/.test(value)) return 'f';
  return '';
};

const formatNumber = (value) => {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round((value + Number.EPSILON) * 1e10) / 1e10;
  return String(rounded);
};

const gcd = (a, b) => {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) [x, y] = [y, x % y];
  return x;
};

const evaluateArithmetic = (expression) => {
  const tokens = String(expression).match(/-?\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join('') !== String(expression).replace(/\s+/g, '')) return null;
  const values = [];
  const operators = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  const apply = () => {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();
    if (left == null || right == null) return false;
    if (operator === '/' && right === 0) return false;
    if (operator === '%') values.push((left * right) / 100);
    else if (operator === '+') values.push(left + right);
    else if (operator === '-') values.push(left - right);
    else if (operator === '*') values.push(left * right);
    else values.push(left / right);
    return Number.isFinite(values[values.length - 1]);
  };
  for (const token of tokens) {
    if (/^-?\d/.test(token)) values.push(Number(token));
    else if (token === '(') operators.push(token);
    else if (token === ')') {
      while (operators.length && operators[operators.length - 1] !== '(' && apply()) {}
      if (operators.pop() !== '(') return null;
    } else {
      while (
        operators.length &&
        operators[operators.length - 1] !== '(' &&
        precedence[operators[operators.length - 1]] >= precedence[token]
      ) {
        if (!apply()) return null;
      }
      operators.push(token);
    }
  }
  while (operators.length) {
    if (operators[operators.length - 1] === '(' || !apply()) return null;
  }
  return values.length === 1 ? values[0] : null;
};

const deterministicResult = (answer, reason) => ({
  answer,
  completion: {
    complete: true,
    kind: 'none',
    requested: null,
    produced: 0,
    target: null,
    nextIndex: null,
    reason,
  },
  intent: 'GENERAL',
  mode: 'deterministic',
  chunkCount: 0,
  sections: [],
  resources: [],
  sources: [],
});

const tryDeterministic = (question) => {
  const text = String(question || '').trim();
  if (TABLE_REQUEST_RE.test(text)) {
    const numbers = tableNumbers(text);
    if (!numbers || !numbers.length) return null;
    const result = deterministicResult(
      generateMultiplicationTables(numbers),
      `tables ${numbers[0]}..${numbers[numbers.length - 1]} generated deterministically`
    );
    result.completion.kind = 'items';
    result.completion.requested = numbers.length;
    result.completion.produced = numbers.length;
    result.completion.target = numbers[numbers.length - 1];
    return result;
  }

  const percentOf = PERCENT_OF_RE.exec(text);
  if (percentOf) {
    const value = Number(percentOf[1]) * Number(percentOf[2]) / 100;
    return Number.isFinite(value) ? deterministicResult(formatNumber(value), 'percentage calculated deterministically') : null;
  }

  const percentChange = PERCENT_CHANGE_RE.exec(text);
  if (percentChange) {
    const original = Number(percentChange[1]);
    const percent = Number(percentChange[2]);
    const sign = /decrease|reduce|discount/i.test(text) ? -1 : 1;
    const value = original + (original * percent / 100) * sign;
    return Number.isFinite(value) ? deterministicResult(formatNumber(value), 'percentage change calculated deterministically') : null;
  }

  const lcmHcf = LCM_HCF_RE.exec(text);
  if (lcmHcf) {
    const a = Number(lcmHcf[2]);
    const b = Number(lcmHcf[3]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === 0 || b === 0) return null;
    const divisor = gcd(a, b);
    const isHcf = /hcf|gcd|greatest/i.test(lcmHcf[1]);
    const value = isHcf ? divisor : Math.abs(a * b) / divisor;
    return deterministicResult(String(value), `${isHcf ? 'HCF' : 'LCM'} calculated deterministically`);
  }

  const conversion = CONVERSION_RE.exec(text);
  if (conversion) {
    const value = Number(conversion[1]);
    const from = normalizeUnit(conversion[2]);
    const to = normalizeUnit(conversion[3]);
    const lengthInMeters = { km: 1000, m: 1, cm: 0.01, mm: 0.001 };
    const massInGrams = { kg: 1000, g: 1, lb: 453.59237 };
    let converted = null;
    if (lengthInMeters[from] && lengthInMeters[to]) converted = value * lengthInMeters[from] / lengthInMeters[to];
    else if (massInGrams[from] && massInGrams[to]) converted = value * massInGrams[from] / massInGrams[to];
    else if (from === 'c' && to === 'f') converted = (value * 9) / 5 + 32;
    else if (from === 'f' && to === 'c') converted = ((value - 32) * 5) / 9;
    return converted == null ? null : deterministicResult(`${formatNumber(converted)} ${to}`, 'unit conversion calculated deterministically');
  }

  const arithmetic = ARITHMETIC_RE.exec(text);
  if (arithmetic) {
    const value = evaluateArithmetic(arithmetic[1]);
    return value == null ? null : deterministicResult(formatNumber(value), 'arithmetic evaluated deterministically');
  }

  return null;
};

module.exports = {
  tryDeterministic,
  tableNumbers,
  generateMultiplicationTables,
  evaluateArithmetic,
};
