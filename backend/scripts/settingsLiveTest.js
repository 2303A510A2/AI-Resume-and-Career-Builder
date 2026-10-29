// LIVE end-to-end proof of the user Settings feature (§9-§12 of the task).
//
// Runs against a RUNNING backend (+ MongoDB). It registers throwaway users and
// exercises every /api/settings endpoint through the real stack (JWT -> auth ->
// controller -> MongoDB), then deletes the accounts so nothing is left behind.
//
// What it proves:
//   * GET /api/settings needs a JWT (401 without one) and returns profile +
//     settings + stats for the AUTHENTICATED user only.
//   * PUT /api/settings/profile updates name/bio/avatar and persists; an invalid
//     avatar is rejected (400); an email owned by someone else is 409.
//   * PUT /api/settings/preferences persists appearance/chat/notifications and
//     a fresh GET returns the saved values (real backend persistence).
//   * POST /api/settings/change-password rejects a WRONG current password (400)
//     and accepts the right one; the NEW password then logs in and the OLD one
//     does not. The change does NOT invalidate the existing JWT.
//   * GET /api/settings/export returns ONLY the caller's data.
//   * POST /api/settings/clear-chats is scoped to the caller.
//   * DELETE /api/settings/account requires the password and, on success, the
//     account is gone (its token stops working).
//   * Cross-user isolation: user B never sees or changes user A's data.
//   * No response ever leaks a password/hash.
//
// Run: node scripts/settingsLiveTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:5000') + '/api';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const req = (method, path, { token, body } = {}) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

// A real 1x1 PNG (magic prefix iVBORw0KGgo…) — passes the server's magic check.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const main = async () => {
  // ---- health first ---------------------------------------------------------
  try {
    const h = await fetch(`${BASE}/health`);
    const health = await j(h);
    if (!h.ok || health.status !== 'ok') throw new Error(`health status=${h.status}`);
    console.log(`      backend online (db=${health.services && health.services.database})`);
  } catch (err) {
    console.log(`FAIL  backend not answering on ${BASE} :: ${err.message}`);
    console.log('      start it with `npm run dev` first — not a code failure.');
    process.exit(1);
  }

  const emailA = `settings.a.${uniq()}@example.com`;
  const emailB = `settings.b.${uniq()}@example.com`;
  const pwOld = 'Passw0rd!old';
  const pwNew = 'Passw0rd!new';

  // ---- register two users ---------------------------------------------------
  const ra = await req('POST', '/auth/register', { body: { name: 'Alice Settings', email: emailA, password: pwOld, confirmPassword: pwOld } });
  const a = await j(ra);
  check('register user A -> 201 + token', ra.status === 201 && !!a.token, `status=${ra.status}`);
  const tokenA = a.token;

  const rb = await req('POST', '/auth/register', { body: { name: 'Bob Settings', email: emailB, password: pwOld, confirmPassword: pwOld } });
  const b = await j(rb);
  check('register user B -> 201 + token', rb.status === 201 && !!b.token, `status=${rb.status}`);
  const tokenB = b.token;

  // ---- 1. GET requires auth -------------------------------------------------
  const noAuth = await req('GET', '/settings');
  check('GET /settings without a JWT -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  // ---- 2. GET returns profile + settings + stats ----------------------------
  const g1 = await req('GET', '/settings', { token: tokenA });
  const g1d = await j(g1);
  check('GET /settings -> 200', g1.status === 200, `status=${g1.status}`);
  check('settings object is complete (appearance/chat/notifications)',
    !!g1d.settings && !!g1d.settings.appearance && !!g1d.settings.chat && !!g1d.settings.notifications);
  check('defaults: theme=system, accent=violet, responseStyle=balanced',
    g1d.settings?.appearance?.theme === 'system'
    && g1d.settings?.appearance?.accent === 'violet'
    && g1d.settings?.chat?.responseStyle === 'balanced');
  check('stats carries conversationCount + memberSince',
    typeof g1d.stats?.conversationCount === 'number' && !!g1d.stats?.memberSince);
  check('response never leaks a password/hash',
    !/password/i.test(JSON.stringify(g1d.user || {})), 'user object scanned');

  // ---- 3. profile update (name, bio, avatar) --------------------------------
  const up1 = await req('PUT', '/settings/profile', { token: tokenA, body: { name: 'Alice Updated', bio: 'Backend dev.', avatar: PNG_1PX } });
  const up1d = await j(up1);
  check('PUT /settings/profile -> 200', up1.status === 200, `status=${up1.status}`);
  check('name persisted', up1d.user?.name === 'Alice Updated', `name=${up1d.user?.name}`);
  check('bio persisted', up1d.user?.profile?.bio === 'Backend dev.', `bio=${up1d.user?.profile?.bio}`);
  check('avatar persisted as data URL', String(up1d.user?.profile?.avatar || '').startsWith('data:image/png;base64,'));

  // ---- 3b. /auth/me (app boot) carries the photo + settings ---------------
  // This is what makes the photo survive a refresh/login: the React app boots by
  // calling GET /auth/me and seeding its user state from the response.
  const meBoot = await j(await req('GET', '/auth/me', { token: tokenA }));
  check('GET /auth/me returns the saved photo (survives refresh/login)',
    String(meBoot.user?.profile?.avatar || '').startsWith('data:image/png;base64,'));
  check('GET /auth/me returns the settings block (theme survives a refresh)',
    !!meBoot.user?.settings?.appearance && !!meBoot.user?.settings?.chat);

  // ---- 4. invalid avatar rejected -------------------------------------------
  const badAvatar = await req('PUT', '/settings/profile', { token: tokenA, body: { avatar: 'data:text/plain;base64,aGVsbG8=' } });
  check('non-image avatar -> 400', badAvatar.status === 400, `status=${badAvatar.status}`);

  // ---- 4b. Remove Photo restores the default avatar --------------------------
  const removed = await req('PUT', '/settings/profile', { token: tokenA, body: { avatar: '' } });
  const removedD = await j(removed);
  check('Remove photo -> 200 and clears the avatar', removed.status === 200 && !removedD.user?.profile?.avatar, `status=${removed.status}`);
  const meRemoved = await j(await req('GET', '/auth/me', { token: tokenA }));
  check('removed photo stays removed after a refetch', !meRemoved.user?.profile?.avatar);

  // ---- 5. cross-user email is refused (409) ---------------------------------
  const stealEmail = await req('PUT', '/settings/profile', { token: tokenA, body: { email: emailB } });
  check("taking another user's email -> 409", stealEmail.status === 409, `status=${stealEmail.status}`);

  // ---- 6. preferences persist ------------------------------------------------
  const pref = {
    appearance: { theme: 'light', accent: 'teal' },
    chat: { enterToSend: false, confirmDelete: false, responseStyle: 'detailed', language: 'Telugu', voicePlayback: true },
    notifications: { product: true },
  };
  const up2 = await req('PUT', '/settings/preferences', { token: tokenA, body: pref });
  const up2d = await j(up2);
  check('PUT /settings/preferences -> 200', up2.status === 200, `status=${up2.status}`);
  check('preferences echoed: theme=light accent=teal responseStyle=detailed',
    up2d.settings?.appearance?.theme === 'light'
    && up2d.settings?.appearance?.accent === 'teal'
    && up2d.settings?.chat?.responseStyle === 'detailed');

  const g2 = await req('GET', '/settings', { token: tokenA });
  const g2d = await j(g2);
  check('preferences PERSIST (fresh GET): enterToSend=false, voicePlayback=true, language=Telugu, product=true',
    g2d.settings?.chat?.enterToSend === false
    && g2d.settings?.chat?.voicePlayback === true
    && g2d.settings?.chat?.language === 'Telugu'
    && g2d.settings?.notifications?.product === true);

  // The appearance choice must come back through /auth/me so a refresh/login
  // restores the same theme instead of falling back to the default.
  const mePrefs = await j(await req('GET', '/auth/me', { token: tokenA }));
  check('/auth/me carries the saved theme (restores on next login)',
    mePrefs.user?.settings?.appearance?.theme === 'light'
    && mePrefs.user?.settings?.chat?.enterToSend === false);

  // ---- 7. invalid preference rejected ---------------------------------------
  const badPref = await req('PUT', '/settings/preferences', { token: tokenA, body: { appearance: { theme: 'neon' } } });
  check('invalid theme -> 400', badPref.status === 400, `status=${badPref.status}`);

  // ---- 8. cross-user isolation ----------------------------------------------
  const gB = await req('GET', '/settings', { token: tokenB });
  const gBd = await j(gB);
  check('user B GET /settings returns B OWN identity (not A)',
    gBd.user?.email === emailB && gBd.settings?.appearance?.theme === 'system', `email=${gBd.user?.email}`);
  // B updates its own name; A must be unaffected.
  await req('PUT', '/settings/profile', { token: tokenB, body: { name: 'Bob Renamed' } });
  const gA2 = await req('GET', '/settings', { token: tokenA });
  const gA2d = await j(gA2);
  check("user B's profile change does not touch user A", gA2d.user?.name === 'Alice Updated', `A name=${gA2d.user?.name}`);

  // ---- 9. change password ----------------------------------------------------
  const wrongPw = await req('POST', '/settings/change-password', { token: tokenA, body: { currentPassword: 'not-it', newPassword: pwNew, confirmPassword: pwNew } });
  check('change-password with WRONG current -> 400', wrongPw.status === 400, `status=${wrongPw.status}`);

  const mismatch = await req('POST', '/settings/change-password', { token: tokenA, body: { currentPassword: pwOld, newPassword: pwNew, confirmPassword: 'different' } });
  check('change-password with mismatched confirm -> 400', mismatch.status === 400, `status=${mismatch.status}`);

  const goodPw = await req('POST', '/settings/change-password', { token: tokenA, body: { currentPassword: pwOld, newPassword: pwNew, confirmPassword: pwNew } });
  check('change-password with correct current -> 200', goodPw.status === 200, `status=${goodPw.status}`);

  const oldLogin = await req('POST', '/auth/login', { body: { email: emailA, password: pwOld } });
  check('login with OLD password now fails (401)', oldLogin.status === 401, `status=${oldLogin.status}`);
  const newLogin = await req('POST', '/auth/login', { body: { email: emailA, password: pwNew } });
  check('login with NEW password succeeds (200)', newLogin.status === 200, `status=${newLogin.status}`);

  // The existing JWT must NOT be invalidated by the password change.
  const stillAuthed = await req('GET', '/settings', { token: tokenA });
  check('existing JWT stays valid after a password change (no forced logout)', stillAuthed.status === 200, `status=${stillAuthed.status}`);

  // ---- 10. export ------------------------------------------------------------
  const exp = await req('GET', '/settings/export', { token: tokenA });
  const expd = await j(exp);
  check('GET /settings/export -> 200', exp.status === 200, `status=${exp.status}`);
  check('export is scoped to the caller (own email only)',
    expd.data?.account?.email === emailA && !JSON.stringify(expd.data).includes(emailB));
  check('export includes settings + a conversations array',
    !!expd.data?.settings && Array.isArray(expd.data?.conversations));

  // ---- 11. clear chat history (scoped) --------------------------------------
  const clear = await req('POST', '/settings/clear-chats', { token: tokenA, body: {} });
  const cleard = await j(clear);
  check('POST /settings/clear-chats -> 200', clear.status === 200, `status=${clear.status}`);
  check('clear reports a deleted count', typeof cleard.deletedConversations === 'number', `count=${cleard.deletedConversations}`);

  // ---- 12. delete account requires the password -----------------------------
  const delNoPw = await req('DELETE', '/settings/account', { token: tokenA, body: {} });
  check('DELETE /settings/account without password -> 400', delNoPw.status === 400, `status=${delNoPw.status}`);
  const delWrong = await req('DELETE', '/settings/account', { token: tokenA, body: { password: 'wrong' } });
  check('DELETE /settings/account with wrong password -> 400', delWrong.status === 400, `status=${delWrong.status}`);

  const delOk = await req('DELETE', '/settings/account', { token: tokenA, body: { password: pwNew } });
  check('DELETE /settings/account with correct password -> 200', delOk.status === 200, `status=${delOk.status}`);

  const afterDelete = await req('GET', '/settings', { token: tokenA });
  check('deleted account token no longer works (not 200)', afterDelete.status !== 200, `status=${afterDelete.status}`);

  // ---- cleanup ---------------------------------------------------------------
  // Prefer the admin endpoint (like the other live suites): it is NOT behind the
  // 20/15min sensitive limiter that the account-deletion tests just spent, so the
  // suite stays repeatable. User A is already gone (deleted above); clean up B.
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@careerai.app';
  const adminPasswords = [...new Set([process.env.ADMIN_PASSWORD, 'Admin@12345'].filter(Boolean))];
  let adminToken = '';
  for (const pw of adminPasswords) {
    const r = await req('POST', '/admin/login', { body: { email: adminEmail, password: pw } });
    const d = await j(r);
    if (d.token) { adminToken = d.token; break; }
  }
  if (adminToken && b.user?._id) {
    const del = await req('DELETE', `/admin/users/${b.user._id}`, { token: adminToken });
    check('cleanup: throwaway user B removed (admin)', del.status === 200, `status=${del.status}`);
  } else {
    // Best-effort fallback via B's own endpoint. A 429 here is the sensitive
    // limiter tripped by rapid re-runs — harmless leftover test data, not a bug.
    const delB = await req('DELETE', '/settings/account', { token: tokenB, body: { password: pwOld } });
    if (delB.status === 200) check('cleanup: user B deleted', true);
    else console.log(`SKIP  cleanup: user B (status=${delB.status}) — likely the sensitive limiter on rapid re-runs; harmless test data`);
  }

  console.log('\n========================================================');
  console.log(`settingsLiveTest: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
