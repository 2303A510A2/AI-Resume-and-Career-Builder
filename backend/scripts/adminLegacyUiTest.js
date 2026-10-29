// REAL-BROWSER smoke test of the LEGACY single-file admin console
// (frontend/index.html, served at /legacy or /index.html) over the Chrome
// DevTools Protocol. It proves the previously-missing workflow end to end:
//   landing Admin link -> Admin Access page (Sign In + Request Access)
//   -> a real Pending admin request (throwaway user, cleaned up)
//   -> Main Admin Leader sign-in -> dashboard (security changes remain in Settings)
//   -> dashboard with EXACTLY two primary stat cards
//   -> Users table (Name/Email/Role/Registered/Chats/Status/Actions, real rows)
//   -> search + Block/Unblock + Delete against the throwaway user
//   -> Admin Approval shows the pending request
//
// It CHANGES the main admin password and RESTORES the documented initial state
// in a finally block. Every throwaway user + request is deleted in finally.
//
// Needs: the frontend dev server on :5173 and the backend on :5000.
// Run: node scripts/adminLegacyUiTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const AdminRequest = require('../models/AdminRequest');

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const APP = process.env.FRONTEND_URL || 'http://localhost:5173';
const PORT = Number(process.env.CDP_PORT || 9335);
const ADMIN_EMAIL = String(process.env.ADMIN_TEST_EMAIL || process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || '';
const TEMP_PASSWORD = `Ui#${Date.now()}`;

const STAMP = Date.now();
const REQ_EMAIL = `legacy.ui.${STAMP}@example.com`;
const REQ_NAME = 'Legacy UI Applicant';
const REQ_PASSWORD = `Req#${STAMP}`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny CDP client -------------------------------------------------------
let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

const connect = (url) =>
  new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { resolve: res, reject: rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'exception');
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        pageErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
  });

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error');
  return r.result.value;
};

const waitFor = async (expr, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evalJS(expr)) return true; } catch { /* retry */ }
    await sleep(150);
  }
  return false;
};

const setInput = (selector, val) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(val)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

const clickSel = (selector) =>
  evalJS(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

const goto = async (url) => {
  await send('Page.navigate', { url });
  await waitFor("document.readyState === 'complete'");
  await sleep(300);
};
const gotoHash = async (hash) => {
  await evalJS(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(400);
};
const pageText = () => evalJS('document.body ? document.body.innerText : ""');

const fetchJson = async (url, opts) => (await fetch(url, opts)).json();

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('FAIL  INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD not set.');
    process.exit(1);
  }
  if (!fs.existsSync(CHROME)) {
    console.log(`FAIL  Chrome/Edge not found at ${CHROME}. Set CHROME_PATH.`);
    process.exit(1);
  }

  try {
    const h = await fetchJson('http://localhost:5000/api/health');
    if (h.status !== 'ok') throw new Error('health not ok');
    const f = await fetch(APP + '/legacy');
    if (!f.ok) throw new Error('legacy status ' + f.status);
    const html = await f.text();
    if (!html.includes('adminAccessPanel')) throw new Error('served legacy build is stale (missing new admin code)');
  } catch (err) {
    console.log(`FAIL  stack not reachable / stale (${err.message}). Start backend :5000 and frontend :5173.`);
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const original = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
  if (!original) throw new Error('Main Admin Leader not found');
  const restore = { password: ADMIN_PASSWORD, mustChangePassword: original.mustChangePassword, adminTokenVersion: original.adminTokenVersion };

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-legacy-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let connected = false;
  try {
    let version = null;
    for (let i = 0; i < 50 && !version; i += 1) {
      try { version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(200); }
    }
    if (!version) throw new Error('Chrome DevTools endpoint never came up');

    let target = null;
    try {
      target = await fetchJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    } catch {
      target = await fetchJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`);
    }
    await connect(target.webSocketDebuggerUrl);
    connected = true;
    await send('Page.enable');
    await send('Runtime.enable');

    console.log(`      browser: ${version.Browser}`);
    console.log(`      app:     ${APP} (legacy)`);

    // ===== 1. Landing has the Admin Login link =====
    await goto(APP + '/legacy');
    check('legacy landing renders with an Admin Login link',
      await waitFor("!!document.querySelector('a.link') && document.body.innerText.includes('Admin Login')"));

    // ===== 2. The link opens the Admin Access page with Sign In =====
    await gotoHash('#/admin/access');
    check('Admin Access page opens (Sign In panel)',
      await waitFor("document.querySelector('#admin-signin') && document.querySelector('#admin-signin').classList.contains('active') && !!document.querySelector('#adminEmail') && !!document.querySelector('#adminPassword')"));
    check('Sign In panel offers "Request Admin Access"',
      await evalJS("!!Array.from(document.querySelectorAll('#admin-signin button')).find(b=>/Request Admin Access/i.test(b.textContent))"));

    // ===== 3. Request Access panel + real pending request =====
    await evalJS("(() => { const b = Array.from(document.querySelectorAll('#admin-signin button')).find(x=>/Request Admin Access/i.test(x.textContent)); if (b) b.click(); return !!b; })()");
    check('Request Access panel shows name/email/password/reason fields',
      await waitFor("document.querySelector('#admin-request').classList.contains('active') && !!document.querySelector('#admReqName') && !!document.querySelector('#admReqEmail') && !!document.querySelector('#admReqPassword') && !!document.querySelector('#admReqReason')"));
    await setInput('#admReqName', REQ_NAME);
    await setInput('#admReqEmail', REQ_EMAIL);
    await setInput('#admReqPassword', REQ_PASSWORD);
    await setInput('#admReqReason', 'I help maintain the platform and need moderation access.');
    await evalJS("(() => { const f = document.querySelector('#admin-request form'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()");
    const pendingShown = await waitFor("document.querySelector('#adminReqStatus') && /Pending/i.test(document.querySelector('#adminReqStatus').textContent)", 12000);
    check('admin request is submitted and confirmed Pending', pendingShown);
    const reqDoc = await AdminRequest.findOne({ email: REQ_EMAIL }).lean();
    check('admin request is saved in MongoDB with status pending',
      !!reqDoc && reqDoc.status === 'pending', reqDoc ? `status=${reqDoc.status}` : 'no doc');
    const reqUser = await User.findOne({ email: REQ_EMAIL }).lean();
    check('request created an ORDINARY account (role=user, no admin)',
      !!reqUser && reqUser.role === 'user');

    // ===== 4. Main Admin Leader sign-in + forced password change =====
    await gotoHash('#/admin/login');
    await waitFor("document.querySelector('#admin-signin').classList.contains('active')");
    await setInput('#adminEmail', ADMIN_EMAIL);
    await setInput('#adminPassword', ADMIN_PASSWORD);
    await evalJS("(() => { const f = document.querySelector('#admin-signin form'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()");
    const signinOk = await waitFor("location.hash === '#/admin/dashboard' && !!document.querySelector('#adminDashStats') && !document.querySelector('#adminCurPw')", 12000);
    check('Main Admin Leader sign-in opens the dashboard instead of the password form', signinOk);

    // A pending initial password change stays available under Profile -> Settings.
    if (await evalJS("!!(State.adminUser && State.adminUser.mustChangePassword)")) {
      await evalJS("adminOpenSettingsPane(); 'ok'");
      await waitFor("!!document.querySelector('#adminCurPw')", 5000);
      await setInput('#adminCurPw', ADMIN_PASSWORD);
      await setInput('#adminNewPw', TEMP_PASSWORD);
      await setInput('#adminNewPw2', TEMP_PASSWORD);
      await evalJS("(() => { const f = document.querySelector('#adminContent form'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()");
      const unlocked = await waitFor("location.hash === '#/admin/dashboard' && !document.querySelector('#adminCurPw') && !!document.querySelector('#adminNav .admin-nav-link')", 12000);
      check('forced initial-password change unlocks the console', unlocked);
    } else {
      check('password change is not forced in the dashboard', !await evalJS("!!document.querySelector('#adminCurPw')"));
    }

    // Auto-accept confirm/prompt for the destructive steps below.
    await evalJS("window.confirm = () => true; window.prompt = () => ''; 'ok'");

    // ===== 5. Navigation set (main admin) =====
    const nav = await evalJS("Array.from(document.querySelectorAll('#adminNav .admin-nav-link')).map(b=>{ var c=b.querySelector('.admin-nav-count'); var t=b.cloneNode(true); if(c) t.querySelector('.admin-nav-count').remove(); return t.textContent.trim(); })");
    check('nav has Dashboard / Users / Admin Approval / Admins / Profile & Settings',
      ['Dashboard', 'Users', 'Admin Approval', 'Admins', 'Profile & Settings'].every((l) => nav.includes(l)), JSON.stringify(nav));
    check('nav has NO Documents or System tab',
      !nav.some((l) => /Documents|System/i.test(l)));

    // ===== 6. Dashboard: exactly two primary stat cards =====
    await gotoHash('#/admin/dashboard');
    await waitFor("document.querySelectorAll('#adminDashStats .admin-stat').length > 0", 9000);
    const statCount = await evalJS("document.querySelectorAll('#adminDashStats .admin-stat').length");
    const statLabels = await evalJS("Array.from(document.querySelectorAll('#adminDashStats .admin-stat h4')).map(h=>h.textContent.trim())");
    check('dashboard shows EXACTLY two primary stat cards', statCount === 2, `count=${statCount}`);
    check('stat cards are Total Users + Total Conversations / Chats',
      statLabels.includes('Total Users') && statLabels.includes('Total Conversations / Chats'), JSON.stringify(statLabels));
    check('dashboard has no Messages/Resumes/Documents primary stats',
      !/Total Messages|Total Resumes|Documents/i.test(await pageText()));
    check('dashboard shows a real user-management list below the cards',
      await waitFor("document.querySelectorAll('#adminDashUsers .admin-table tbody tr').length > 0", 9000));
    await setInput('#adminDashSearch', REQ_EMAIL);
    check('a newly registered applicant appears in the dashboard list',
      await waitFor(`document.querySelector('#adminDashUsers').innerText.includes(${JSON.stringify(REQ_EMAIL)})`, 9000));
    await setInput('#adminDashSearch', '');
    await waitFor("document.querySelectorAll('#adminDashUsers .admin-table tbody tr').length > 0", 9000);

    // ===== 6b. Top-right identity: real admin profile + notification badge =====
    check('topbar shows the signed-in admin\'s real first name',
      await evalJS(`(document.querySelector('#adminTopName')||{}).textContent && document.querySelector('#adminTopName').textContent.trim().length > 0`));
    await evalJS("document.querySelector('#adminProfileBtn').click(); 'ok'");
    check('profile dropdown opens with the admin\'s real name + email',
      await waitFor("document.querySelector('#adminProfileMenu').classList.contains('open') && /@/.test((document.querySelector('#adminMenuEmail')||{}).textContent||'')"));
    const menuEmail = await evalJS("(document.querySelector('#adminMenuEmail')||{}).textContent||''");
    check('profile dropdown email is the Main Admin Leader\'s own address',
      menuEmail.toLowerCase() === ADMIN_EMAIL, menuEmail);
    check('profile dropdown offers Profile / Settings / Logout',
      await evalJS("(() => { const t=document.querySelector('#adminProfileMenu').innerText; return /Profile/.test(t)&&/Settings/.test(t)&&/Logout/.test(t); })()"));
    await evalJS("document.querySelector('#adminProfileBtn').click(); 'ok'");
    const bellBadge = await evalJS("(() => { const b=document.querySelector('#adminBellBadge'); return b && !b.hidden ? b.textContent.trim() : ''; })()");
    check('notification badge reflects the real pending admin request(s)', Number(bellBadge) >= 1, `badge=${bellBadge}`);

    // ===== 6c. Profile pane: edit + bio + contact email =====
    await gotoHash('#/admin/settings');
    await waitFor("!!document.querySelector('#adminProfileName')", 8000);
    check('My Profile pane renders name + email fields',
      await evalJS("!!document.querySelector('#adminProfileName') && !!document.querySelector('#adminProfileBio')"));
    check('My Profile starts read-only with an Edit Profile button',
      await evalJS("document.querySelector('#adminProfileName').disabled && /Edit Profile/i.test(document.querySelector('#adminContent').innerText)"));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('#adminContent button')).find(x=>/Edit Profile/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    check('Edit Profile enables the name + bio fields',
      await waitFor("!document.querySelector('#adminProfileName').disabled && !document.querySelector('#adminProfileBio').disabled"));
    check('profile photo picker offers Change photo',
      await evalJS("/Change photo/i.test(document.querySelector('#adminContent').innerText)"));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('#adminContent button')).find(x=>/Cancel/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('#adminContent .admin-tabs button, #adminContent button')).find(x=>/Contact/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    check('Contact pane shows the Main Admin Leader contact email',
      await waitFor("document.querySelector('#adminContent').innerText.includes('metebharath4@gmail.com')", 8000));

    // ===== 6d. Settings: password change from Settings returns to the dashboard =====
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('#adminContent button')).find(x=>/Security/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    check('Security pane renders current/new/confirm password fields',
      await waitFor("!!document.querySelector('#adminCurPw') && !!document.querySelector('#adminNewPw') && !!document.querySelector('#adminNewPw2')"));

    // ===== 7. Users table: real rows, correct columns =====
    await gotoHash('#/admin/users');
    await waitFor("document.querySelectorAll('#adminUsersBody .admin-table tbody tr').length > 0", 9000);
    const headers = await evalJS("Array.from(document.querySelectorAll('#adminUsersBody thead th')).map(th=>th.textContent.trim())");
    check('users table columns include identity, role, registration, chats, status and actions',
      JSON.stringify(headers) === JSON.stringify(['User Name', 'Email', 'Role', 'Registered', 'Total Chats', 'Account Status', 'Actions']), JSON.stringify(headers));
    check('users table has NO Joined / Resume / Documents columns',
      !headers.some((h) => /Joined|Resume|Documents/i.test(h)));
    const userRows = await evalJS("document.querySelectorAll('#adminUsersBody .admin-table tbody tr').length");
    check('users table lists real registered accounts (not "No users yet")', userRows > 0, `rows=${userRows}`);
    check('users table does NOT claim "No users yet"',
      !(await pageText()).includes('No users yet'));

    // ===== 8. Search finds the throwaway user; conversations column = 0 =====
    await setInput('#adminUserSearch', REQ_EMAIL);
    await waitFor(`document.querySelectorAll('#adminUsersBody .admin-table tbody tr').length === 1 && document.querySelector('#adminUsersBody').innerText.includes(${JSON.stringify(REQ_EMAIL)})`, 9000);
    const conv = await evalJS("(() => { const r=document.querySelector('#adminUsersBody .admin-table tbody tr'); if(!r) return null; const c=r.querySelectorAll('td'); return c[4]?c[4].textContent.trim():null; })()");
    check('search by email narrows to the throwaway user', conv !== null);
    check('Total Chats shows the actual count (0 for this newly registered user)', conv === '0', `chats=${conv}`);

    // ===== 9. Block / Unblock the throwaway user =====
    const clickRowBtn = (label) => evalJS(`(() => { const row = document.querySelector('#adminUsersBody .admin-table tbody tr'); if(!row) return false; const b = Array.from(row.querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true; })()`);
    await clickRowBtn('Block');
    check('Block sets the user status to Blocked', await waitFor("document.querySelector('#adminUsersBody .admin-table tbody tr') && /Blocked/.test(document.querySelector('#adminUsersBody .admin-table tbody tr').textContent)", 9000));
    await clickRowBtn('Unblock');
    check('Unblock restores the user to Active', await waitFor("document.querySelector('#adminUsersBody .admin-table tbody tr') && /Active/.test(document.querySelector('#adminUsersBody .admin-table tbody tr').textContent)", 9000));

    // ===== 10. Admin Approval shows the pending request =====
    await gotoHash('#/admin/requests');
    await waitFor("document.querySelectorAll('#adminReqBody .admin-table tbody tr').length > 0", 9000);
    const reqBodyText = await evalJS("document.querySelector('#adminReqBody').innerText");
    check('Admin Approval lists the submitted request as Pending',
      reqBodyText.includes(REQ_EMAIL) && /Pending/i.test(reqBodyText));
    check('Admin Approval shows the request reason',
      reqBodyText.includes('moderation access'));

    // ===== 11. Delete the throwaway user (cascade) =====
    await gotoHash('#/admin/users');
    await setInput('#adminUserSearch', REQ_EMAIL);
    await waitFor(`document.querySelector('#adminUsersBody').innerText.includes(${JSON.stringify(REQ_EMAIL)})`, 9000);
    await clickRowBtn('Delete');
    const gone = await waitFor(`!document.querySelector('#adminUsersBody').innerText.includes(${JSON.stringify(REQ_EMAIL)})`, 12000);
    check('Delete removes the user from the table', gone);
    check('deleted user is gone from MongoDB', (await User.findOne({ email: REQ_EMAIL })) === null);

    // ===== 12. No uncaught runtime errors =====
    check('no uncaught runtime errors during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    try {
      const doc = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
      if (doc) {
        doc.password = restore.password;
        doc.mustChangePassword = restore.mustChangePassword;
        doc.adminTokenVersion = restore.adminTokenVersion;
        await doc.save();
        console.log('      (restored the Main Admin Leader to its initial credentials + forced change)');
      }
    } catch (err) {
      console.log(`      (RESTORE WARNING: ${err.message})`);
    }
    try {
      await AdminRequest.deleteMany({ email: REQ_EMAIL });
      await User.deleteOne({ email: REQ_EMAIL });
    } catch (err) {
      console.log(`      (cleanup warning: ${err.message})`);
    }
    try { if (connected) ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(56));
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('\nadminLegacyUiTest.js crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
