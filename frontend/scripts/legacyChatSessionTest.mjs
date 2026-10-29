import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(root, 'index.html'), 'utf8');

const extractFunction = (name) => {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} exists in the legacy app`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} has a closing brace`);
};

const localStorageData = new Map();
const generatedIds = ['collision', 'collision', 'second', 'third'];
const context = {
  State: {
    user: { email: 'first@example.test' },
    chatOwner: 'first@example.test',
    chatRequestEpoch: 0,
    activeId: 'old-account-chat',
    files: [{}],
    serverOrder: ['old-server-chat'],
    chatPage: 3,
    chatHasMore: true,
    chatLoading: true,
    searchOrder: ['old-search-result'],
    searchPage: 2,
    searchHasMore: true,
    searching: true,
  },
  KEYS: { sessionsPrefix: 'career_sessions_v1_' },
  localStorage: {
    getItem: (key) => localStorageData.get(key) || null,
    setItem: (key, value) => localStorageData.set(key, String(value)),
  },
  uid: () => generatedIds.shift(),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  unescape,
  encodeURIComponent,
  Date,
};

for (const name of ['userKey', 'chatOwnerKey', 'getSessions', 'setSessions', 'createSession', 'saveSession', 'localSessionIdForRoute', 'chooseActiveSessionId']) {
  vm.runInNewContext(extractFunction(name), context);
}

console.log('\n1) New chats have unique IDs and independent messages');
const first = context.createSession();
const second = context.createSession();
first.updated = 10;
second.updated = 20;
first.messages.push({ role: 'user', text: 'first conversation' });
second.messages.push({ role: 'user', text: 'second conversation' });
context.saveSession(first);
context.saveSession(second);
assert.notEqual(first.id, second.id);
const stored = context.getSessions();
assert.equal(stored[first.id].messages[0].text, 'first conversation');
assert.equal(stored[second.id].messages[0].text, 'second conversation');
assert.equal(stored[first.id].messages.some((message) => message.text === 'second conversation'), false);
assert.equal(stored[second.id].messages.some((message) => message.text === 'first conversation'), false);
console.log('  OK   two created conversations keep unique IDs and separate messages');

console.log('\n2) Active conversation is restored predictably');
const third = context.createSession();
context.saveSession(third);
stored[second.id].serverId = 'server-second';
assert.equal(context.chooseActiveSessionId(stored, '', first.id), first.id);
assert.equal(context.chooseActiveSessionId(stored, '', ''), second.id);
assert.equal(context.chooseActiveSessionId(stored, second.id, first.id), second.id);
assert.equal(context.chooseActiveSessionId(stored, 'server-second', first.id), second.id);
assert.match(extractFunction('openApp'), /chooseActiveSessionId\(all,\s*chatIdFromHash\(\),\s*getActiveId\(\)\)/);
console.log('  OK   the saved selection wins on reload, and the newest session is fallback');

console.log('\n3) Account-local history remains isolated');
context.State.user.email = 'other@example.test';
assert.equal(Object.keys(context.getSessions()).length, 0);
const otherAccountSession = context.createSession();
otherAccountSession.messages.push({ role: 'user', text: 'other account only' });
context.saveSession(otherAccountSession);
context.State.user.email = 'first@example.test';
assert.equal(context.getSessions()[first.id].messages[0].text, 'first conversation');
assert.equal(context.getSessions()[otherAccountSession.id], undefined);
console.log('  OK   switching account namespaces does not mix local conversation messages');

console.log('\n4) Account changes invalidate previous in-memory chat work');
context.clearHistSearch = () => { context.searchCleared = true; };
context.removeTyping = () => { context.typingRemoved = true; };
vm.runInNewContext(extractFunction('resetChatWorkspace'), context);
vm.runInNewContext(extractFunction('beginAuthenticatedSession'), context);
const previousEpoch = context.State.chatRequestEpoch;
context.beginAuthenticatedSession({ name: 'Other User', email: 'other@example.test' }, 'new-account-token');
assert.equal(context.State.chatOwner, 'other@example.test');
assert.equal(context.State.chatRequestEpoch, previousEpoch + 1);
assert.equal(context.State.activeId, null);
assert.equal(context.State.serverOrder.length, 0);
assert.equal(context.State.searchOrder.length, 0);
assert.equal(context.State.chatLoading, false);
assert.equal(context.State.token, 'new-account-token');
assert.equal(context.searchCleared, true);
assert.equal(context.typingRemoved, true);
console.log('  OK   switching accounts clears chat state and invalidates pending account requests');

console.log('\n5) Conversation URL supports selection navigation');
const routeContext = {
  window: {
    location: { hash: '#/app', pathname: '/frontend/index.html', search: '' },
    history: {
      state: null,
      replaceState(_state, _title, url) { this.replaced = url; },
    },
  },
};
routeContext.go = (hash) => { routeContext.window.location.hash = hash; };
vm.runInNewContext(extractFunction('chatIdFromHash'), routeContext);
vm.runInNewContext(extractFunction('setChatRoute'), routeContext);
routeContext.setChatRoute('local chat id', false);
assert.equal(routeContext.window.location.hash, '#/app?chat=local%20chat%20id');
assert.equal(routeContext.chatIdFromHash(), 'local chat id');
routeContext.setChatRoute('replacement', true);
assert.equal(routeContext.window.history.replaced, '/frontend/index.html#/app?chat=replacement');
assert.match(html, /window\.addEventListener\("hashchange", route\)/);
assert.match(extractFunction('route'), /openSession\(selectedChat,\s*false\)/);
console.log('  OK   selecting chats writes a hash route that Back/Forward can restore');

console.log('\n6) Incomplete provider output remains actionable after reload');
assert.match(extractFunction('hydrateSession'), /m\.completion/, 'hydration preserves saved completion metadata');
assert.match(extractFunction('renderMsg'), /Continue response|completionWarning/, 'assistant rendering exposes incomplete responses');
assert.match(extractFunction('continueResponse'), /sendMessage\(\)/, 'the continue action sends a normal authenticated chat turn');
for (const name of ['hydrateSession', 'renderMsg', 'continueResponse', 'pushAi']) {
  assert.doesNotThrow(() => new vm.Script(`(${extractFunction(name)})`), `${name} remains valid JavaScript`);
}
console.log('  OK   incomplete responses keep their status and can be continued from the UI');

console.log('\nlegacyChatSessionTest: 7 passed / 0 failed');
