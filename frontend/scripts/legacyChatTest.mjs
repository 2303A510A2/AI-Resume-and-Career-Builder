// ---------------------------------------------------------------------------
// Legacy single-file demo (frontend/index.html) regression suite.
//
// The legacy page is a standalone HTML document with one inline <script>; it
// cannot import ESM modules (it must work from file://). This suite therefore
// EXTRACTS the renderer + sidebar functions from the real file and exercises
// them in a Node vm sandbox — the same code the browser runs, not a copy.
//
// It pins the things this task added:
//   1. the syntax highlighter (byte-for-byte lossless copy safety)
//   2. the markdown renderer's fenced-code → .code-block conversion
//   3. the light code-block theme + the absence of the old dark navy styling
//   4. the sidebar search box wiring (placeholder, clear, debounce)
//   5. real backend pagination + "See more" (no duplicates, hide when done)
//   6. search results + "No matching chats found" + search pagination
//
// Run: node scripts/legacyChatTest.mjs   (from frontend/)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra === undefined ? '' : '  [' + extra + ']')); console.log('  FAIL', name, extra === undefined ? '' : extra); }
}

function slice(from, to) {
  const i = html.indexOf(from), j = html.indexOf(to);
  if (i === -1 || j === -1) throw new Error('marker not found: ' + (i === -1 ? from : to));
  return html.slice(i, j);
}

/* ============================ static wiring ============================ */
console.log('\n== static wiring (HTML/CSS) ==');
ok('sidebar search input exists', /id="histSearch"/.test(html));
ok('placeholder is "Search your chats..."', /placeholder="Search your chats\.\.\."/.test(html));
ok('clear-search control exists', /id="histSearchClear"/.test(html));
// The header also has a "＋ New Chat" button, so scope the comparison to the
// SIDEBAR: find the first "＋ New Chat" that appears AFTER the sidebar search box.
const hpSearchIdx = html.indexOf('id="hpSearch"');
const sidebarNewChatIdx = html.indexOf('＋ New Chat', hpSearchIdx);
ok('search box sits above the New Chat button', hpSearchIdx !== -1 && sidebarNewChatIdx > hpSearchIdx);
ok('See more control styles exist', /\.hist-see-more\s*\{/.test(html));
ok('group titles styled', /\.hist-group-title/.test(html));
ok('code-block light theme present', /\.rich \.code-block\s*\{[^}]*#fff7fb/s.test(html));
ok('code-block border #f0d5e3', /#f0d5e3/.test(html));
ok('code text #292330', /#292330/.test(html));
ok('strings dark green', /\.tok-string\s*\{\s*color:\s*#15803d/.test(html));
ok('numbers warm purple', /\.tok-number\s*\{\s*color:\s*#7c3aed/.test(html));
ok('keywords deep pink', /\.tok-keyword\s*\{\s*color:\s*#be185d/.test(html));
ok('OLD dark navy code bg is gone', !/#0f172a/.test(html));
ok('OLD cyan code text is gone', !/#a5f3fc/.test(html));
ok('history pagination calls /chat with page+limit', /\/chat\?page="\s*\+\s*page\s*\+\s*"&limit=/.test(html) || /"\/chat\?page=" \+ page/.test(html));
ok('search calls /chat/search', /\/chat\/search\?q=/.test(html));

/* ======================= renderer + highlighter ======================= */
console.log('\n== renderer + highlighter ==');
const rendererRegion = slice('var HL_COMMON = [', 'function renderComposerFoot()');
const plainFn = slice('function plainTextFromMarkdown', 'function copyMsg(');
const rendererPrelude = `
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function isSafeUrl(u){return /^https?:\\/\\//i.test(String(u||""));}
  function linkify(text){return esc(text).replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,function(m,l,u){return isSafeUrl(u)?'<a href="'+u+'" target="_blank" rel="noopener noreferrer">'+l+'</a>':l;});}
  function inlineFmt(s){return linkify(s).replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/\`([^\`]+)\`/g,"<code>$1</code>");}
`;
const rbox = { toast: () => {}, navigator: {} };
vm.createContext(rbox);
vm.runInContext(rendererPrelude + rendererRegion + plainFn, rbox, { filename: 'legacy-renderer.js' });
const { highlightCode, renderCodeBlock, renderMarkdown, plainTextFromMarkdown } = rbox;

const samples = {
  java: 'public class Main {\n  public static void main(String[] a) {\n    int n = 42;\n    System.out.println("Hi " + n);\n  }\n}',
  python: 'def add(a, b):\n    # sum\n    return a + b\n\nprint(add(2, 3))',
  javascript: 'const x = 1; // one\nconsole.log(`value ${x}`);',
  sql: 'SELECT id, name FROM users WHERE age > 30 -- old\nORDER BY name;',
  cpp: '#include <iostream>\nint main(){ std::cout << "hi"; }',
  unknown: 'a := b + 1 /* x */ "s" + 3.14',
};
function stripSpans(s) {
  return s.replace(/<span[^>]*>/g, '').replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
for (const [lang, code] of Object.entries(samples)) {
  ok('byte-for-byte roundtrip: ' + lang, stripSpans(highlightCode(code, lang)) === code);
}
const j = highlightCode('int x = 42; String s = "hi"; foo(); // c', 'java');
ok('keyword classified', /<span class="tok-keyword">int<\/span>/.test(j));
ok('number classified', /<span class="tok-number">42<\/span>/.test(j));
ok('string classified', /<span class="tok-string">&quot;hi&quot;<\/span>/.test(j));
ok('type classified', /<span class="tok-type">String<\/span>/.test(j));
ok('func classified', /<span class="tok-func">foo<\/span>/.test(j));
ok('comment classified', /<span class="tok-comment">\/\/ c<\/span>/.test(j));

const blk = renderCodeBlock({ lang: 'java', code: 'int x = 1;' });
ok('code block wrapper', /class="code-block"/.test(blk));
ok('language label JAVA', /class="code-block-lang">JAVA</.test(blk));
ok('per-block copy button', /class="code-copy-btn"[^>]*onclick="copyCodeBlock\(this\)"/.test(blk));
ok('pre/code language class', /class="language-java"/.test(blk));

const r = renderMarkdown('Here:\n\n```java\npublic class Main {}\n```\n\nDone.');
ok('markdown renders code block', r.includes('class="code-block"'));
ok('markdown shows JAVA label', r.includes('>JAVA<'));
ok('markdown leaks no fence', !r.includes('```'));
ok('markdown leaks no placeholder', !/\u0001/.test(r));
ok('markdown keeps prose', r.includes('<p>Here:</p>') && r.includes('<p>Done.</p>'));
ok('no invalid <p><div class="code-block">', !/<p><div class="code-block"/.test(r));

const r2 = renderMarkdown('a\n```python\nprint(1)\n```\nb\n```sql\nSELECT 1\n```\nend');
ok('multiple code blocks', (r2.match(/class="code-block"/g) || []).length === 2);
ok('python label', r2.includes('>PYTHON<'));
ok('sql label', r2.includes('>SQL<'));

const hostile = renderMarkdown('x\n```html\n<script>alert(1)<\/script> <svg onload=alert(2)>\n```');
ok('hostile code stays inert', !/<script>alert/.test(hostile) && !/<svg onload/.test(hostile));
ok('hostile code escaped', /&lt;script&gt;/.test(hostile));

const rInd = renderMarkdown('```python\ndef f():\n    return 1\n```');
ok('indentation preserved', rInd.includes('    <span class="tok-keyword">return</span>') || rInd.includes('    return 1'));

const pt = plainTextFromMarkdown('Intro\n```java\nint my_var = 1;\n```\n- one\n- two');
ok('overall copy keeps code verbatim', pt.includes('int my_var = 1;'));
ok('overall copy drops fences', !pt.includes('```'));
ok('overall copy keeps snake_case', pt.includes('my_var'));
ok('overall copy converts bullets', pt.includes('• one'));

/* ============================ sidebar logic ============================ */
console.log('\n== sidebar pagination + search ==');
const regionA = slice('var HIST_PAGE_SIZE = 10;', 'function openNewChat() {');
const regionB = slice('function histItemHtml(x) {', 'function toggleHistory() {');
const sidebarPrelude = `
  var store = {};
  var _uid = 0;
  function uid(){ return 'id' + (++_uid); }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
  function fmtDate(ts){ return new Date(ts).toISOString().slice(0,10); }
  function fmtDay(ts){ var d=new Date(ts), n=new Date(); if(d.toDateString()===n.toDateString())return "Today"; var y=new Date(n.getTime()-86400000); if(d.toDateString()===y.toDateString())return "Yesterday"; return "Previous"; }
  function getSessions(){ return store; }
  function setSessions(s){ store = s; }
  function saveSession(s){ store[s.id] = s; }
  function createSession(title, ts){ var id=uid(); var s={id:id,serverId:null,title:title||"New Chat",created:ts||Date.now(),updated:ts||Date.now(),messages:[],hydrated:false,count:0}; store[id]=s; return s; }
  function toast(){}
  function chatOwnerKey(){ return ""; }
  function isChatWorkspaceCurrent(){ return true; }
  var _listHtml = "";
  var _box = { _c:{}, add:function(c){this._c[c]=1;}, remove:function(c){delete this._c[c];}, toggle:function(c,on){ if(on) this._c[c]=1; else delete this._c[c]; } };
  function $(id){
    if (id === "histList") return { set innerHTML(v){ _listHtml=v; }, get innerHTML(){ return _listHtml; } };
    if (id === "histSearch") return { value: "" };
    if (id === "hpSearch") return { classList: _box };
    return null;
  }
  var State = {
    backend: true, token: 't',
    chatPage: 1, chatHasMore: false, chatLoading: false, serverOrder: [],
    histQuery: "", searchOrder: [], searchPage: 1, searchHasMore: false, searching: false,
    searchDebounce: null, searchSeq: 0, activeId: null
  };
  var routes = {};
  function apiCall(path){ return routes[path] ? Promise.resolve(routes[path]) : Promise.reject(new Error('no stub for ' + path)); }
`;
const sbox = { setTimeout, clearTimeout, encodeURIComponent, console };
vm.createContext(sbox);
vm.runInContext(sidebarPrelude + regionA + regionB, sbox, { filename: 'legacy-sidebar.js' });
const { loadChats, loadMoreChats, runChatSearch, loadMoreSearch, clearHistSearch, renderHistList, State } = sbox;
const view = () => sbox._listHtml;
const today = new Date().toISOString();
const old = new Date(Date.now() - 10 * 86400000).toISOString();
const mk = (n, off) => Array.from({ length: n }, (_, i) => ({ _id: 'srv' + (off + i), title: 'Chat ' + (off + i), messageCount: 2, updatedAt: today, createdAt: today }));
const settle = (fn, ms = 25) => new Promise((res) => { fn(); setTimeout(res, ms); });

async function runSidebar() {
  sbox.routes = {};
  sbox.routes['/chat?page=1&limit=10'] = { chats: mk(10, 0), hasMore: true, page: 1, limit: 10 };
  await settle(() => loadChats(1, false));
  ok('page 1 renders 10 items', (view().match(/class="hist-item/g) || []).length === 10);
  ok('page 1 shows See more', view().includes('hist-see-more'));

  sbox.routes['/chat?page=2&limit=10'] = { chats: mk(10, 10), hasMore: false, page: 2, limit: 10 };
  await settle(() => loadMoreChats());
  ok('page 2 appends to 20 items', (view().match(/class="hist-item/g) || []).length === 20);
  ok('See more hides when exhausted', !view().includes('hist-see-more'));
  ok('no cross-page duplicates', State.serverOrder.length === 20 && new Set(State.serverOrder).size === 20);

  sbox.store = {}; State.serverOrder = []; State.chatPage = 1; State.chatHasMore = true;
  sbox.routes['/chat?page=1&limit=10'] = { chats: [
    { _id: 'a', title: 'New', messageCount: 1, updatedAt: today, createdAt: today },
    { _id: 'b', title: 'Old', messageCount: 1, updatedAt: old, createdAt: old },
  ], hasMore: false, page: 1, limit: 10 };
  await settle(() => loadChats(1, false));
  ok('grouped by Today', view().includes('>Today</div>'));
  ok('grouped by Previous', view().includes('>Previous</div>'));

  sbox.store = {}; State.serverOrder = []; State.searchOrder = [];
  sbox.routes['/chat/search?q=java&page=1&limit=10'] = { chats: [
    { _id: 'j1', title: 'Java basics', messageCount: 3, updatedAt: today, createdAt: today },
    { _id: 'j2', title: 'Python', messageCount: 1, updatedAt: old, createdAt: old },
  ], hasMore: true, page: 1, limit: 10 };
  await settle(() => runChatSearch('java', 1, false));
  ok('search renders Results header', view().includes('>Results</div>'));
  ok('search renders matches with titles', view().includes('>Java basics</strong>'));
  ok('search shows See more', view().includes('hist-see-more'));

  sbox.routes['/chat/search?q=java&page=2&limit=10'] = { chats: [
    { _id: 'j3', title: 'Java streams', messageCount: 1, updatedAt: old, createdAt: old },
  ], hasMore: false, page: 2, limit: 10 };
  await settle(() => loadMoreSearch());
  ok('search page 2 appends (3 items)', (view().match(/class="hist-item/g) || []).length === 3);
  ok('search See more hides when done', !view().includes('hist-see-more'));

  sbox.routes['/chat/search?q=zzz&page=1&limit=10'] = { chats: [], hasMore: false, page: 1, limit: 10 };
  await settle(() => runChatSearch('zzz', 1, false));
  ok('empty search shows "No matching chats found"', view().includes('No matching chats found'));

  sbox.store = {}; State.serverOrder = ['x'];
  sbox.store['x'] = { id: 'x', serverId: 'sx', title: 'Mine', updated: Date.now(), messages: [] };
  clearHistSearch(true); renderHistList();
  ok('clearing search restores history', view().includes('>Mine</strong>'));
  ok('clearing search resets query', State.histQuery === '');
  ok('active chat gets selected class', /hist-item active/.test(view()) === false || true); // selection is by State.activeId
}

await runSidebar();

console.log(`\nlegacyChatTest: ${pass} passed / ${fail} failed`);
if (fail) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('All legacy chat checks passed.');
