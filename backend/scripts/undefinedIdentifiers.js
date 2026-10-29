// Scans every backend JS file for identifiers that are USED but never defined.
//
// WHY THIS EXISTS
//   backend\services\ragService.js has been mid-refactor and shipped three
//   separate `ReferenceError: X is not defined` bugs in a row — `plan`,
//   `DOCUMENT_INTENT_FLOOR`, `STYLE_COMMAND_RE`, each of which broke EVERY
//   POST /api/ai/career-assistant call (500) while GET /api/health still
//   answered 200.
//
//   `node --check` cannot find these: an undefined identifier is perfectly valid
//   syntax, so it passes every parser, every build, and the production bundle. It
//   can only be found by actually executing the code — which is what
//   chatPathTest.js does for the chat path specifically. This script is the
//   cheap, whole-codebase sweep that covers everything else.
//
// HOW IT WORKS
//   Collects every name DECLARED in a file (const/let/var/function/class, imports,
//   destructured requires, catch bindings) plus the Node globals, then reports
//   every CALLED identifier (`name(`) that is in none of those sets. Method calls
//   on an object (`obj.method(`) are ignored because `obj.method` is not a bare
//   identifier. Template-literal and string contents are stripped first so
//   prose like "use http://x" cannot produce a phantom finding.
//
// This is a HEURISTIC linter, not a type checker: it can report a false positive
// for a name injected by eval or a global set elsewhere, and it can miss a name
// that is declared in a scope the regex cannot see. It is still far better than
// nothing, and every finding here must be confirmed by reading the file.
//
// Run: node scripts/undefinedIdentifiers.js   (no network, no database, no key)
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['.', 'controllers', 'services', 'routes', 'models', 'middleware', 'config', 'utils', 'scripts'];

/** Names Node/the runtime provide. Anything else must be declared in-file. */
const GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console',
  'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'structuredClone', 'crypto', 'performance', 'globalThis', 'global', 'JSON', 'Math', 'Date',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'RegExp', 'Function', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Intl', 'Proxy', 'Reflect', 'BigInt',
  'Int8Array', 'Uint8Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'assert', 'AsyncLocalStorage', 'ReadableStream', 'WritableStream', 'TransformStream',
  'MessageChannel', 'MessagePort', 'EventTarget', 'Event', 'CustomEvent', 'WeakRef', 'FinalizationRegistry',
  // Node 22+ ships a stable global WebSocket (used by the CDP-driven admin UI
  // smoke test). It is a real global, not an undefined identifier, so flagging it
  // made this linter fail on a healthy tree.
  'WebSocket',
  // Promise/callback plumbing that appears as a bare call in this codebase.
  'resolve', 'reject', 'next', 'cb', 'callback', 'done', 'nextTick', 'exec', 'spawn', 'execFile',
  'setTimeout', 'setInterval',
  // Typed arrays used by the inline PNG encoder in the test suites.
  'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
]);

/** Files where a reported name is expected and harmless. */
const ALLOW = {
  // Each suite defines and calls its own helpers; they are declared, so these
  // only appear if the regex misses an unusual declaration form.
};

/**
 * Placeholder tokens the stripper substitutes for removed literals. They must
 * never be reported as findings, so they are filtered out of the call scan.
 */
const PLACEHOLDERS = new Set(['STRIPPED', 'REGEXLIT']);

/** Reads a file, returning null when it does not exist. */
const readIfPresent = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
};

/**
 * Removes comments, string/template literals and REGEX literals so their
 * contents cannot be mistaken for code.
 *
 * The regex-literal case is the subtle one and it caused every false positive
 * in the first version of this script: prose inside `/you are (a )/` or
 * `/(?:failed|good)/` looks exactly like a function call to a naive scanner.
 * Distinguishing `/` as division vs. as a regex start needs the previous
 * significant token, so we track it while scanning rather than regexing blindly.
 *
 * Offsets shift as we replace, so only token CONTENT matters downstream — the
 * reported line numbers come from re-scanning the stripped text, which preserves
 * newlines exactly.
 */
const stripLiterals = (src) => {
  let out = '';
  let i = 0;
  const n = src.length;
  // The last significant char emitted, used to decide if `/` starts a regex.
  let prev = '';

  const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
  const canBeRegex = () => regexAllowedAfter.has(prev);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ---- line comment ----
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // ---- block comment ----
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // ---- template literal ----
    // A `${ ... }` hole contains REAL code and can itself nest another
    // template, so this branch is recursive: the literal text is dropped but the
    // interpolations are scanned normally. Without that, a line like
    // `... ${x ? ` [${y.join(', ')}]` : ''}` leaks its inner words and produces
    // phantom findings such as `file()` / `attached()`.
    if (c === '`') {
      i += 1;
      let depth = 0;
      while (i < n) {
        const t = src[i];
        if (t === '\\') { i += 2; continue; }
        if (t === '\n') { out += '\n'; i += 1; continue; }
        if (depth === 0 && t === '`') { i += 1; break; }
        if (depth === 0 && t === '$' && src[i + 1] === '{') {
          // Find the matching close brace, then re-scan the hole as code.
          let d = 1;
          let j = i + 2;
          while (j < n && d > 0) {
            const hc = src[j];
            if (hc === '\\') { j += 2; continue; }
            if (hc === '`') {
              // Nested template inside the hole: skip it wholesale.
              let nd = 0;
              j += 1;
              while (j < n) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '`' && nd === 0) { j += 1; break; }
                j += 1;
              }
              continue;
            }
            if (hc === '{') d += 1;
            else if (hc === '}') d -= 1;
            if (d === 0) break;
            j += 1;
          }
          const hole = src.slice(i + 2, j);
          out += ` ${stripLiterals(hole)} `;
          i = j + 1;
          continue;
        }
        i += 1;
      }
      out += ' STRIPPED ';
      prev = 'S';
      continue;
    }
    // ---- single/double quoted string ----
    if (c === "'" || c === '"') {
      const q = c;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1;
      out += ' STRIPPED ';
      prev = 'S';
      continue;
    }
    // ---- regex literal ----
    if (c === '/' && canBeRegex()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        const rc = src[j];
        if (rc === '\\') { j += 2; continue; }
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { closed = true; break; }
        else if (rc === '\n') break;
        j += 1;
      }
      if (closed) {
        j += 1;
        // flags
        while (j < n && /[a-z]/.test(src[j])) j += 1;
        i = j;
        out += ' RE ';
        prev = 'S';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
};

/** Every name DECLARED anywhere in the file (over-approximate on purpose). */
const declaredNames = (raw) => {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };

  // Keywords we must never treat as "used but undefined".
  'if else for while do switch case default return break continue function class const let var new delete typeof instanceof in of throw try catch finally import export from as async await yield static get set extends super this null undefined true false void NaN Infinity debugger with'.split(' ').forEach(add);

  // const/let/var NAME, including multiple declarators and destructuring.
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(raw))) add(m[1]);

  // function NAME / class NAME
  const fnRe = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(raw))) add(m[1]);
  const clsRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = clsRe.exec(raw))) add(m[1]);

  // Anything destructured: const { a, b: c } = ...  /  const [a, b] = ...
  // Also catches require('../x') destructuring and catch ({ message })
  const destructRe = /(?:const|let|var)\s*[{[]([^\]}]*)[}\]]/g;
  while ((m = destructRe.exec(raw))) {
    for (const part of m[1].split(',')) {
      const key = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key);
    }
  }

  // require('x') assigned to a name (already covered by declRe) and bare
  // require('x').something — the `something` is a property, not a bare name.
  const reqRe = /require\(\s*['"][^'"]+['"]\s*\)/g;
  while ((m = reqRe.exec(raw))) names.add('require');

  // Function PARAMETERS: any parenthesised list immediately followed by `=>` or
  // `{` is a parameter list, whatever precedes it. This resolves `next`/`cb`/`req`
  // in every callback shape: `function (req, res, next) {`,
  // `app.get('/', (req, res) => {`, `router.post('/x', protect, (req, res, next) => {`.
  const paramRe = /\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = paramRe.exec(raw))) {
    for (const part of m[1].split(',')) {
      const key = part.split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key);
    }
  }
  // Arrow params with a single bare name: `x => ...`
  const arrowRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowRe.exec(raw))) add(m[2]);

  // catch (NAME)
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catchRe.exec(raw))) add(m[1]);

  // Object shorthand / method shorthand definitions: { foo, bar() {} }
  const shorthandRe = /[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g;
  while ((m = shorthandRe.exec(raw))) add(m[1]);
  // Object/class METHOD definitions: `{ foo() {} }`, `{ async foo() {} }`,
  // `{ get foo() {} }`, `foo() {}` at the start of a line. Without the optional
  // `async`/`get`/`set`/`*` prefix this misses `async sendMail({...}) {}` and
  // reports the method as an undefined free function.
  const methodRe = /(?:^|[{;,\n])\s*(?:(?:async|get|set)\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm;
  while ((m = methodRe.exec(raw))) add(m[1]);

  return names;
};

/** Bare identifiers that are CALLED (`name(`), i.e. free function references. */
const calledNames = (stripped) => {
  const found = new Map();
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[2];
    // Skip our own replacement placeholders — they are not source identifiers.
    if (PLACEHOLDERS.has(name)) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    if (!found.has(name)) found.set(name, line);
  }
  return found;
};

const main = () => {
  const files = [];
  for (const d of DIRS) {
    const dir = path.join(ROOT, d);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      const rel = path.join(d, e.name);
      if (d === '.' && ['server.js', 'app.js'].includes(e.name)) files.push(path.join(ROOT, e.name));
      else files.push(path.join(dir, e.name));
      void rel;
    }
  }

  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const raw = readIfPresent(file);
    if (raw === null) continue;
    scanned += 1;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const declared = declaredNames(raw);
    const stripped = stripLiterals(raw);
    for (const [name, line] of calledNames(stripped)) {
      if (declared.has(name) || GLOBALS.has(name)) continue;
      if ((ALLOW[rel] || []).includes(name)) continue;
      findings.push({ rel, line, name });
    }
  }

  console.log(`\nScanned ${scanned} backend files for called-but-undefined identifiers.\n`);
  if (!findings.length) {
    console.log('CLEAN: no called identifier is missing a definition in its own file.');
    console.log('(This is a heuristic check; chatPathTest.js remains the executable guard.)\n');
    process.exit(0);
  }

  findings.sort((a, b) => (a.rel === b.rel ? a.line - b.line : a.rel.localeCompare(b.rel)));
  for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.name}()`);
  console.log(`\n${findings.length} potentially undefined identifier(s).`);
  console.log('Confirm each by reading the file before changing anything.\n');
  process.exit(findings.length ? 1 : 0);
};

main();