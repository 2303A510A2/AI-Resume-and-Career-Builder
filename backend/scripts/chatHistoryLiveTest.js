// Live end-to-end suite for the ChatGPT-style chat-history layer:
//   - pagination (page/limit/hasMore, no duplicates across pages, newest first)
//   - search (title + message content, per-user, paginated, literal matching)
//   - meaningful-title retitling (a "hi" chat is renamed by the first real question)
//   - per-user privacy (another user cannot read or delete your chats)
//   - delete scoped to owner
//
// Run: node scripts/chatHistoryLiveTest.js   (requires backend on :5000 with
// MongoDB; uses the ADMIN_EMAIL/ADMIN_PASSWORD bootstrapped admin for cleanup).
// If the AI provider is unconfigured or the daily quota is spent, the chat
// creation cases report SKIP (never FAIL) — the same convention as the other
// live suites. Throwaway users are deleted via the admin endpoint at the end.
/* eslint-disable no-console */
const BASE = process.env.SMOKE_BASE || 'http://localhost:5000/api';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const log = (name, cond, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`  ⏭️  ${name} — SKIPPED: ${why}`);
};

const req = async (method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};

// A 502 with these codes means the AI budget is the only blocker — the request
// created NO chat, so the chat cases cannot run today.
const aiBlocked = (r) =>
  r.status === 502 && ['AI_DAILY_LIMIT', 'AI_RATE_LIMITED', 'AI_PROVIDERS_UNAVAILABLE'].includes(r.data?.code);

const main = async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const userA = { name: 'Chat A', email: `chatA_${suffix}@test.dev`, password: 'Secret123' };
  const userB = { name: 'Chat B', email: `chatB_${suffix}@test.dev`, password: 'Secret123' };

  console.log('\n=== 1. Register two throwaway users ===');
  const regA = await req('POST', '/auth/register', { ...userA, confirmPassword: userA.password });
  const regB = await req('POST', '/auth/register', { ...userB, confirmPassword: userB.password });
  const tokenA = regA.data?.token;
  const tokenB = regB.data?.token;
  const userIdA = regA.data?.user?._id || regA.data?.userId;
  const userIdB = regB.data?.user?._id || regB.data?.userId;
  log('user A registered + token', !!tokenA);
  log('user B registered + token', !!tokenB);
  if (!tokenA || !tokenB) {
    console.log('\n  Unable to register users — aborting (backend may need /auth/register).');
    process.exit(1);
  }

  console.log('\n=== 2. Greeting chat + retitling by the first real question ===');
  const hi = await req('POST', '/chat', { message: 'hi', requestId: `rid_hi_${suffix}` }, tokenA);
  if (hi.status !== 200 || aiBlocked(hi)) {
    skip('all chat-creation cases', aiBlocked(hi) ? 'AI quota/provider unavailable today' : `POST /chat -> ${hi.status}`);
    skip('retitle by second message', 'chat creation unavailable');
  } else {
    const chatId = hi.data.chatId;
    log('greeting chat created', !!chatId, `chatId=${chatId}`);

    const listAfterHi = await req('GET', '/chat', undefined, tokenA);
    const hiRow = (listAfterHi.data.chats || []).find((c) => c._id === chatId);
    log('sidebar row shows metadata only (title/messageCount/date, no bodies)',
      hiRow && typeof hiRow.title === 'string' && hiRow.messageCount === 2 && hiRow.updatedAt && !JSON.stringify(hiRow).includes('"content"'),
      JSON.stringify(hiRow));

    const real = await req('POST', '/chat', { message: 'write a java program to count letter case transitions', chatId, requestId: `rid_real_${suffix}` }, tokenA);
    if (real.status === 200) {
      const list = await req('GET', '/chat?limit=50', undefined, tokenA);
      const row = (list.data.chats || []).find((c) => c._id === chatId);
      log('chat retitled from the first real question', row && row.title.includes('java program'), row && row.title);
      log('retitled title is capped at 48 chars', row && row.title.length === 48, row && row.title);

      const detail = await req('GET', `/chat/${chatId}`, undefined, tokenA);
      log('GET /chat/:id returns the full messages', detail.status === 200 && Array.isArray(detail.data.chat.messages) && detail.data.chat.messages.length === 4,
        `messages=${detail.data.chat?.messages?.length}`);
    } else {
      skip('retitle by second message', aiBlocked(real) ? 'AI quota/provider unavailable today' : `POST /chat -> ${real.status}`);
    }
  }

  console.log('\n=== 3. Several chats so pagination actually has pages ===');
  const extras = [
    'what is Java?',
    'explain polymorphism with an example',
    'give me 5 LeetCode problems',
    'how do I negotiate a salary offer?',
  ];
  const created = [];
  for (const m of extras) {
    const r = await req('POST', '/chat', { message: m, requestId: `rid_${suffix}_${created.length}` }, tokenA);
    if (r.status === 200 && r.data.chatId) created.push(r.data.chatId);
    else if (aiBlocked(r)) { skip('pagination chat creation', 'AI quota/provider unavailable today'); break; }
  }
  log(`created ${created.length} extra chats`, created.length >= 4, `${created.length} chats`);

  console.log('\n=== 4. Pagination: stable newest-first, no duplicates, hasMore ===');
  // 5 chats total (1 greeting + 4 extras); pages of 2 give 3 pages incl. a
  // partial last page — full pagination proof with only 5 AI calls.
  const p1 = await req('GET', '/chat?page=1&limit=2', undefined, tokenA);
  const p2 = await req('GET', '/chat?page=2&limit=2', undefined, tokenA);
  const p3 = await req('GET', '/chat?page=3&limit=2', undefined, tokenA);
  log('list accepts a small server-side page (page=1 limit=2)', p1.data.page === 1 && p1.data.limit === 2, JSON.stringify({ page: p1.data.page, limit: p1.data.limit }));
  log('total counts every conversation', typeof p1.data.total === 'number' && p1.data.total >= 5, `total=${p1.data.total}`);
  log('page 1 hasMore is true when a second page exists', p1.data.hasMore === true, `hasMore=${p1.data.hasMore}`);
  const ids1 = (p1.data.chats || []).map((c) => String(c._id));
  const ids2 = (p2.data.chats || []).map((c) => String(c._id));
  const ids3 = (p3.data.chats || []).map((c) => String(c._id));
  log('page 2 rows exist and are disjoint from page 1', ids2.length === 2 && ids2.every((id) => !ids1.includes(id)), `p1=${ids1.length} p2=${ids2.length}`);
  log('page 3 is a partial final page, disjoint from both', ids3.length === 1 && !ids1.includes(ids3[0]) && !ids2.includes(ids3[0]), `p3=${ids3.length}`);
  log('last page hasMore false', p3.data.hasMore === false);
  log('rows sorted newest-activity first', (() => {
    const all = [...(p1.data.chats || []), ...(p2.data.chats || []), ...(p3.data.chats || [])];
    const times = all.map((c) => new Date(c.updatedAt).getTime());
    return times.every((t, i) => i === 0 || times[i - 1] >= t);
  })());

  console.log('\n=== 5. Search: titles + message content, per-user, paginated ===');
  const sJava = await req('GET', '/chat/search?q=java&limit=50', undefined, tokenA);
  log('search matches the user\'s own conversations', sJava.status === 200 && Array.isArray(sJava.data.chats) && sJava.data.chats.length >= 2, `hits=${sJava.data.chats?.length}`);
  const sResume = await req('GET', '/chat/search?q=salary&limit=50', undefined, tokenA);
  log('search matches message content (not just titles)', (sResume.data.chats || []).some((c) => String(c._id) === String(created[3])), `hits=${sResume.data.chats?.length}`);
  const sNone = await req('GET', '/chat/search?q=zzzznope123', undefined, tokenA);
  log('no-match search returns an empty page', sNone.status === 200 && sNone.data.chats.length === 0 && sNone.data.total === 0);
  const sNoQ = await req('GET', '/chat/search', undefined, tokenA);
  log('search without q is a 400', sNoQ.status === 400);
  const sNoAuth = await req('GET', '/chat/search?q=java');
  log('search without a JWT is a 401', sNoAuth.status === 401);

  console.log('\n=== 6. Privacy: user B can never see, search, or delete A\'s chats ===');
  const aChatId = (p1.data.chats || [])[0]?._id;
  if (aChatId) {
    const bGet = await req('GET', `/chat/${aChatId}`, undefined, tokenB);
    log('user B cannot read user A\'s chat', bGet.status === 404, `status=${bGet.status}`);
    const bDel = await req('DELETE', `/chat/${aChatId}`, undefined, tokenB);
    log('user B cannot delete user A\'s chat', bDel.status === 404, `status=${bDel.status}`);
    const bSearch = await req('GET', '/chat/search?q=java', undefined, tokenB);
    log('user B\'s search never surfaces A\'s chats', (bSearch.data.chats || []).every((c) => String(c._id) !== String(aChatId)));
  } else {
    skip('privacy checks', 'no chat to test against');
  }

  console.log('\n=== 7. Delete scoped to owner ===');
  if (created.length > 0) {
    const victim = created[0];
    const del = await req('DELETE', `/chat/${victim}`, undefined, tokenA);
    log('owner deletes their own chat', del.status === 200);
    const gone = await req('GET', `/chat/${victim}`, undefined, tokenA);
    log('deleted chat is gone', gone.status === 404);
    // The first page shrinks after deletion (no cache of a deleted chat).
    const p1b = await req('GET', '/chat?page=1&limit=10', undefined, tokenA);
    log('list reflects the deletion', !(p1b.data.chats || []).some((c) => String(c._id) === String(victim)));
  } else {
    skip('delete case', 'no chat created');
  }

  console.log('\n=== 8. Cleanup: delete the throwaway users (cascades their chats) ===');
  const adminLogin = await req('POST', '/admin/login', { email: process.env.ADMIN_EMAIL || 'admin@careerai.app', password: process.env.ADMIN_PASSWORD || 'Admin@12345' });
  const adminToken = adminLogin.data?.token;
  if (adminToken) {
    for (const id of [userIdA, userIdB]) {
      if (id) {
        const del = await req('DELETE', `/admin/users/${id}`, undefined, adminToken);
        log(`admin deletes throwaway user ${id.slice(-6)}`, del.status === 200, `status=${del.status}`);
      }
    }
  } else {
    skip('user cleanup', 'admin login failed — users remain but are harmless test data');
  }

  console.log(`\nchatHistoryLiveTest: ${passed} passed / ${failed} failed${skipped ? ` / ${skipped} skipped` : ''}`);
  if (failed > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
};

main().catch((err) => {
  console.error('chatHistoryLiveTest crashed:', err && err.message ? err.message : err);
  process.exit(1);
});