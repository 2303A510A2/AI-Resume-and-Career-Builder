// Offline unit suite for the chat code-block syntax highlighter
// (frontend/src/services/syntaxHighlight.js). Pure Node, no framework, no
// network — proves the tokenizer is safe (code can never become HTML) and
// lossless (rendered tokens always reassemble to the exact original code, so
// Copy Code can never copy altered text).
import { highlightTokens, normalizeLang } from '../src/services/syntaxHighlight.js';

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

// The decisive property: the token stream always reassembles byte-for-byte.
const roundtrip = (name, code, lang = '') => {
  const tokens = highlightTokens(code, lang);
  const joined = tokens.map((t) => t.text).join('');
  ok(`${name} round-trips exactly`, joined === String(code), `joined=${JSON.stringify(joined.slice(0, 100))}`);
  return tokens;
};

console.log('\n1) Language tag normalization');
eq('alias js -> javascript', normalizeLang('js'), 'javascript');
eq('alias c++ -> cpp', normalizeLang('c++'), 'cpp');
eq('alias c# -> csharp', normalizeLang('C#'), 'csharp');
eq('alias py -> python', normalizeLang('py'), 'python');
eq('alias ts -> typescript', normalizeLang('ts'), 'typescript');
eq('trim + case-insensitive', normalizeLang('  Java '), 'java');
eq('unknown fence stays empty', normalizeLang('pseudocode'), '');
eq('empty fence stays empty', normalizeLang(''), '');

console.log('\n2) Java — the exact style of the simple program the app is asked for');
{
  const java = `import java.util.*;

public class Main {
    public static void main(String[] args) {
        // count transitions
        Scanner sc = new Scanner(System.in);
        String s = sc.nextLine();
        int c = 0;
        for (int i = 1; i < s.length(); i++) {
            if (Character.isLowerCase(s.charAt(i)) != Character.isLowerCase(s.charAt(i - 1))) {
                c++;
            }
        }
        System.out.print(c);
    }
}`;
  const t = roundtrip('java sample', java, 'java');
  ok('java: import is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'import'));
  ok('java: public is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'public'));
  ok('java: String is a type', t.some((x) => x.type === 'type' && x.text === 'String'));
  ok('java: Scanner is a type', t.some((x) => x.type === 'type' && x.text === 'Scanner'));
  ok('java: comment is a comment', t.some((x) => x.type === 'comment' && x.text.includes('count transitions')));
  ok('java: main is a function call', t.some((x) => x.type === 'func' && x.text === 'main'));
  ok('java: line.nextInt-style call is detected', t.some((x) => x.type === 'func' && x.text === 'nextLine'));
  ok('java: number 0 is a number', t.some((x) => x.type === 'number' && x.text === '0'));
}

console.log('\n3) Python — indentation and #-comments survive');
{
  const py = `def count_transitions(s):
    c = 0
    for i in range(1, len(s)):
        if s[i].islower() != s[i - 1].islower():  # helper comment
            c += 1
    return c

print(count_transitions("HelloWorld"))`;
  const t = roundtrip('python sample', py, 'python');
  ok('python: def is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'def'));
  ok('python: for is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'for'));
  ok('python: return is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'return'));
  ok('python: indentation is preserved', t.some((x) => x.text.includes('    ')));
  ok('python: # comment is a comment', t.some((x) => x.type === 'comment' && x.text.includes('helper comment')));
  ok('python: string literal token', t.some((x) => x.type === 'string' && x.text.includes('HelloWorld')));
  ok('python: count_transitions is a function call', t.some((x) => x.type === 'func' && x.text === 'count_transitions'));
}

console.log('\n4) SQL — uppercase keywords matched case-insensitively');
{
  const sql = `SELECT name, age FROM users WHERE age > 18 ORDER BY name;`;
  const t = roundtrip('sql sample', sql, 'sql');
  ok('sql: SELECT is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'SELECT'));
  ok('sql: FROM is a keyword', t.some((x) => x.type === 'keyword' && x.text === 'FROM'));
  ok('sql: 18 is a number', t.some((x) => x.type === 'number' && x.text === '18'));
  ok('sql: users stays plain', t.some((x) => x.type === 'plain' && x.text === 'users'));
}

console.log('\n5) Safety — hostile code can never become HTML');
{
  const hostile = `alert("</script><script>alert('x');</script>");
const evil = '<svg onload=alert(1)>';`;
  const t = roundtrip('hostile code', hostile, 'javascript');
  ok('hostile: the whole <script> string is ONE string token', t.some((x) => x.type === 'string' && x.text.includes('<script>alert')));
  ok('hostile: <svg…> literal is a single string token', t.some((x) => x.type === 'string' && x.text.includes('<svg onload')));
  const joined = t.map((x) => x.text).join('');
  ok('hostile: reassembled text is identical', joined === hostile);
}

console.log('\n6) C-like preprocessor + annotation handling');
{
  const cpp = `#include <iostream>
// a comment
int main() {
    // TODO
    return 0;
}`;
  const t = roundtrip('cpp sample', cpp, 'cpp');
  ok('cpp: include is a preproc token', t.some((x) => x.type === 'preproc' && x.text === '#include'));
  ok('cpp: main is a function call', t.some((x) => x.type === 'func' && x.text === 'main'));

  const java2 = `@Override
public String toString() { return "x"; }`;
  const t2 = roundtrip('java annotation sample', java2, 'java');
  ok('java: @Override is an annotation', t2.some((x) => x.type === 'annotation' && x.text === '@Override'));
}

console.log('\n7) Unknown languages still tokenize generically (no crash, lossless)');
{
  const generic = `foo("bar")  // keep indentation and newlines
baz(1, 2)`;
  const t = roundtrip('generic code', generic, 'whatever');
  ok('generic: string still detected', t.some((x) => x.type === 'string'));
  ok('generic: number still detected', t.some((x) => x.type === 'number'));
}

console.log(`\ncodeHighlightTest: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}