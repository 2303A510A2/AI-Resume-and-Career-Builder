// ---------------------------------------------------------------------------
// Lightweight, dependency-free syntax highlighter for chat code blocks.
//
// This is deliberately NOT a full parser. It tokenizes the things that make
// real code readable — comments, strings, numbers, keywords, capitalized type
// names, function calls and annotations — for the common languages (Java,
// Python, JavaScript/TypeScript, C-like, Go, Rust, SQL, PHP, Ruby, Kotlin,
// Swift, Bash). Unknown languages still get the generic tokenization.
//
// It is PURE (no DOM, no React, no network) so it is unit-testable under Node,
// and it only ever returns { type, text } tokens. The caller renders those as
// React text nodes, so code can never inject HTML or execute anything.
// ---------------------------------------------------------------------------

const COMMON_KEYWORDS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'new', 'class', 'interface',
  'extends', 'implements', 'import', 'from', 'export', 'default', 'function',
  'const', 'let', 'var', 'this', 'super', 'async', 'await', 'typeof',
  'instanceof', 'in', 'of', 'yield', 'static', 'void', 'null', 'undefined',
  'true', 'false', 'NaN', 'public', 'private', 'protected', 'final', 'abstract',
]);

const LANGUAGE_KEYWORDS = {
  java: [
    'int', 'long', 'short', 'byte', 'char', 'boolean', 'double', 'float',
    'package', 'enum', 'synchronized', 'throws', 'throw', 'instanceof',
    'record', 'var',
    // Type names (String, List, Map…) are intentionally NOT keywords: the
    // capitalized-identifier rule below paints them as types instead.
  ],
  python: [
    'def', 'class', 'elif', 'import', 'as', 'except', 'with', 'lambda', 'pass',
    'not', 'and', 'or', 'in', 'is', 'None', 'True', 'False', 'global',
    'nonlocal', 'assert', 'raise', 'del', 'self', 'print', 'len', 'range',
  ],
  javascript: ['interface', 'type', 'enum', 'implements', 'readonly', 'keyof', 'as', 'satisfies', 'declare', 'namespace'],
  typescript: ['interface', 'type', 'enum', 'implements', 'readonly', 'keyof', 'as', 'satisfies', 'declare', 'namespace'],
  c: [
    'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma', 'using',
    'namespace', 'struct', 'union', 'typedef', 'enum', 'extern', 'inline',
    'register', 'volatile', 'const', 'template', 'typename', 'signed',
    'unsigned', 'char', 'int', 'long', 'short', 'float', 'double', 'bool',
    'nullptr', 'virtual', 'override', 'delete', 'sizeof', 'auto',
  ],
  cpp: [
    'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma', 'using',
    'namespace', 'struct', 'union', 'typedef', 'enum', 'extern', 'inline',
    'register', 'volatile', 'const', 'template', 'typename', 'signed',
    'unsigned', 'char', 'int', 'long', 'short', 'float', 'double', 'bool',
    'nullptr', 'virtual', 'override', 'delete', 'sizeof', 'auto',
  ],
  csharp: [
    'namespace', 'using', 'struct', 'enum', 'readonly', 'sealed', 'async',
    'await', 'string', 'int', 'long', 'short', 'byte', 'bool', 'double',
    'float', 'decimal', 'var', 'void', 'null', 'is', 'as', 'out', 'ref',
    'get', 'set', 'value',
  ],
  go: [
    'package', 'func', 'var', 'type', 'struct', 'interface', 'map', 'chan',
    'go', 'defer', 'range', 'fallthrough', 'default', 'select', 'rune',
    'byte', 'int', 'int32', 'int64', 'uint', 'string', 'bool', 'error',
    'nil', 'iota',
  ],
  rust: [
    'fn', 'let', 'mut', 'struct', 'enum', 'trait', 'impl', 'use', 'mod', 'pub',
    'crate', 'super', 'Self', 'match', 'loop', 'move', 'dyn', 'where', 'ref',
    'box', 'in', 'fn', 'None', 'Some',
  ],
  sql: [
    'select', 'insert', 'update', 'delete', 'from', 'where', 'group', 'by',
    'having', 'order', 'limit', 'join', 'inner', 'left', 'right', 'full',
    'outer', 'on', 'as', 'and', 'or', 'not', 'like', 'between', 'is',
    'union', 'distinct', 'count', 'sum', 'avg', 'min', 'max', 'create',
    'table', 'index', 'primary', 'key', 'foreign', 'references', 'values',
    'set', 'into', 'when', 'then', 'else', 'end', 'exists', 'offset', 'asc',
    'desc', 'null',
  ],
  kotlin: [
    'fun', 'val', 'object', 'data', 'sealed', 'companion', 'init',
    'constructor', 'override', 'open', 'internal', 'package', 'when',
    'by', 'get', 'set',
  ],
  swift: [
    'func', 'let', 'struct', 'enum', 'protocol', 'extension', 'guard',
    'repeat', 'init', 'deinit', 'throws', 'where', 'self',
  ],
  php: [
    'echo', 'elseif', 'foreach', 'trait', 'require', 'require_once',
    'include', 'include_once', 'namespace', 'use', 'public', 'static',
  ],
  ruby: [
    'def', 'class', 'module', 'require', 'include', 'attr_accessor',
    'attr_reader', 'attr_writer', 'elsif', 'unless', 'case', 'when', 'until',
    'do', 'end', 'begin', 'rescue', 'ensure', 'raise', 'yield', 'nil',
  ],
  bash: [
    'if', 'then', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
    'case', 'esac', 'function', 'export', 'local', 'source', 'set', 'unset',
  ],
};

// Languages whose keywords are matched case-insensitively (SQL, Bash).
const CASE_INSENSITIVE = new Set(['sql', 'bash']);

// Normalize a fence language tag to a canonical key.
export const normalizeLang = (lang) => {
  const aliases = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', py3: 'python',
    cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', cpp: 'cpp', cc: 'cpp',
    h: 'c', hpp: 'cpp', go: 'go', golang: 'go', rs: 'rust', kt: 'kotlin',
    kts: 'kotlin', sw: 'swift', sh: 'bash', shell: 'bash', zsh: 'bash',
    ps1: 'bash', yml: 'bash', yaml: 'bash', pl: 'perl', rb: 'ruby',
  };
  const key = String(lang || '').trim().toLowerCase();
  if (!key) return '';
  if (aliases[key]) return aliases[key];
  return Object.prototype.hasOwnProperty.call(LANGUAGE_KEYWORDS, key) ? key : '';
};

const keywordsFor = (lang) => {
  const canonical = normalizeLang(lang);
  const set = new Set(COMMON_KEYWORDS);
  if (canonical && LANGUAGE_KEYWORDS[canonical]) {
    for (const w of LANGUAGE_KEYWORDS[canonical]) set.add(w);
  }
  return { set, anyCase: CASE_INSENSITIVE.has(canonical) };
};

// A single master scanner: each alternative is tried at the current position,
// longest/most-specific first, so strings containing "//" or "/* */" are never
// split and comments containing quotes are never cut.
const buildScanner = (canonical) => {
  const parts = [];
  parts.push('/\\*[\\s\\S]*?\\*/'); // block comment
  if (canonical === 'c' || canonical === 'cpp' || canonical === 'csharp') {
    parts.push('^[ \\t]*#[ \\t]*[A-Za-z_][A-Za-z0-9_]*'); // preprocessor
    parts.push('//[^\\n]*'); // line comment (not the preprocessor)
  } else {
    parts.push('//[^\\n]*'); // line comment
  }
  // `#...` is a comment in python/ruby/bash/yaml, a preprocessor in c-like
  // languages (already consumed above).
  if (canonical !== 'c' && canonical !== 'cpp' && canonical !== 'csharp') {
    parts.push('#[^\\n]*');
  }
  // strings: backtick may span lines; quotes do not
  parts.push('`(?:\\\\.|[^`\\\\])*`');
  parts.push('"(?:\\\\.|[^"\\\\\\n])*"');
  parts.push("'(?:\\\\.|[^'\\\\\\n])*'");
  parts.push('\\b(?:0[xX][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b'); // numbers
  parts.push('@[A-Za-z_][A-Za-z0-9_.]*'); // annotations / decorators
  parts.push('[A-Za-z_$][A-Za-z0-9_$]*'); // identifiers
  parts.push('\\s+'); // whitespace runs stay ONE token (indentation preserved)
  parts.push('[\\s\\S]'); // anything else (punctuation), one char at a time
  // `m` lets the preprocessor's ^-anchored alternative match at line starts.
  // Each part must be wrapped in a CAPTURING group — classify() reads the groups
  // by index (1..N). Without the parens the pattern has no groups at all and
  // every match falls through to 'plain'.
  return new RegExp(parts.map((p) => `(${p})`).join('|'), 'gm');
};

/**
 * Tokenizes `code` into [{ type, text }] tuples. The token sequence always
 * reassembles to the ORIGINAL code byte-for-byte (whitespace preserved), so
 * copying a rendered block can never alter the code.
 *
 * @param {string} code
 * @param {string} lang  fence language tag (java, python, js…)
 * @returns {Array<{type:string, text:string}>}
 */
export function highlightTokens(code, lang = '') {
  const canonical = normalizeLang(lang);
  const { set: kws, anyCase } = keywordsFor(canonical);
  const scanner = buildScanner(canonical);
  const src = String(code || '');
  const out = [];
  scanner.lastIndex = 0;
  let m;
  while ((m = scanner.exec(src)) !== null) {
    const text = m[0];
    if (m.index > (out.length ? out[out.length - 1].end : 0)) {
      // A gap can only exist if the regex skipped nothing — this branch is a
      // safety net; scanner.exec always advances, so it should never trigger.
      out.push({ type: 'plain', text: src.slice(out.length ? out[out.length - 1].end : 0, m.index) });
    }
    const type = classify(src, m, text, { kws, anyCase, canonical });
    out.push({ type, text, end: m.index + text.length });
  }
  const consumed = out.length ? out[out.length - 1].end : 0;
  if (consumed < src.length) out.push({ type: 'plain', text: src.slice(consumed) });
  return out.map((t) => ({ type: t.type, text: t.text }));
}

function classify(src, m, text, { kws, anyCase, canonical }) {
  // The alternation order is fixed; group 1..N identify the alternative.
  let group = 1;
  if (m[group] !== undefined) return 'comment';
  group += 1;
  if (canonical === 'c' || canonical === 'cpp' || canonical === 'csharp') {
    if (m[group] !== undefined) return 'preproc';
    group += 1;
  }
  if (m[group] !== undefined) return 'comment';
  group += 1;
  if (canonical !== 'c' && canonical !== 'cpp' && canonical !== 'csharp') {
    if (m[group] !== undefined) return 'comment';
    group += 1;
  }
  for (const type of ['string', 'string', 'string', 'number', 'annotation', 'identifier']) {
    if (m[group] !== undefined) {
      if (type === 'identifier') {
        if (kws.has(anyCase ? text.toLowerCase() : text)) return 'keyword';
        if (/^[A-Z]/.test(text)) return 'type';
        // function call: identifier immediately followed by "(" (whitespace ok)
        let j = m.index + text.length;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j += 1;
        if (src[j] === '(') return 'func';
        return 'plain'; // ordinary identifier
      }
      return type;
    }
    group += 1;
  }
  return 'plain';
}