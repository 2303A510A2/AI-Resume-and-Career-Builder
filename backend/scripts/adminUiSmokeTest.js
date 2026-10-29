// REAL-BROWSER smoke test of the admin portal over the Chrome DevTools
// Protocol. It drives an actual headless Chrome through the built SPA:
// admin sign-in -> forced initial-password change -> every section renders ->
// logout -> redirect. It CHANGES the main admin password and RESTORES the
// documented initial state in a finally block.
//
// Needs: the frontend dev server on :5173 and the backend on :5000.
// Run: node scripts/adminUiSmokeTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const Chat = require('../models/Chat');

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const APP = process.env.FRONTEND_URL || 'http://localhost:5173';
const PORT = Number(process.env.CDP_PORT || 9333);
const ADMIN_EMAIL = String(process.env.ADMIN_TEST_EMAIL || process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || '';
const TEMP_PASSWORD = `Ui#${Date.now()}`;

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

const pageText = () => evalJS('document.body ? document.body.innerText : ""');

const fetchJson = async (url, opts) => {
  const res = await fetch(url, opts);
  return res.json();
};

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('FAIL  INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD not set.');
    process.exit(1);
  }
  if (!fs.existsSync(CHROME)) {
    console.log(`FAIL  Chrome/Edge not found at ${CHROME}. Set CHROME_PATH.`);
    process.exit(1);
  }

  // backend + frontend reachability
  try {
    const h = await fetchJson('http://localhost:5000/api/health');
    if (h.status !== 'ok') throw new Error('health not ok');
    const f = await fetch(APP + '/admin/login');
    if (!f.ok) throw new Error('frontend status ' + f.status);
  } catch (err) {
    console.log(`FAIL  stack not reachable (${err.message}). Start backend :5000 and frontend :5173.`);
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const original = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
  if (!original) throw new Error('Main Admin Leader not found');
  const restore = { password: ADMIN_PASSWORD, mustChangePassword: original.mustChangePassword, adminTokenVersion: original.adminTokenVersion };

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ui-'));
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
  let throwaway = null; // dashboard search/delete fixture, removed in finally
  try {
    // wait for the CDP endpoint
    let version = null;
    for (let i = 0; i < 50 && !version; i += 1) {
      try { version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(200); }
    }
    if (!version) throw new Error('Chrome DevTools endpoint never came up');

    // open a fresh target (PUT is required on modern Chrome)
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
    console.log(`      app:     ${APP}`);

    // ===== 1. Login page =====
    await goto(APP + '/admin/login');
    check('admin login page renders', await waitFor("!!document.querySelector('#adminEmail') && document.body.innerText.includes('Admin Portal')"));

    // ===== 2. Sign in =====
    await setInput('#adminEmail', ADMIN_EMAIL);
    await setInput('#adminPassword', ADMIN_PASSWORD);
    await clickSel('form button[type="submit"]');
    const gateAppeared = await waitFor("document.body.innerText.includes('Set Your Own Password')", 10000);
    check('sign-in reaches the forced password-change gate', gateAppeared);

    // ===== 3. Forced password change =====
    if (gateAppeared) {
      await setInput('#curPass', ADMIN_PASSWORD);
      await setInput('#newPass', TEMP_PASSWORD);
      await setInput('#confPass', TEMP_PASSWORD);
      await clickSel('form button[type="submit"]');
      const overview = await waitFor("location.pathname === '/admin/overview' && !document.body.innerText.includes('Set Your Own Password')", 10000);
      check('password change unlocks the dashboard', overview);
    } else {
      check('password change unlocks the dashboard', false, 'gate never appeared (admin may already be onboarded)');
    }

    // ===== 4. Overview has exactly the TWO primary stat cards =====
    // The overview loads stats (and a users preview) asynchronously, so WAIT for
    // the grid instead of sampling the DOM immediately after navigation.
    await goto(APP + '/admin/overview');
    const cardsReady = await waitFor("document.querySelectorAll('.admin-stat-grid .stat-card').length === 2", 9000);
    const cardCount = await evalJS("document.querySelectorAll('.admin-stat-grid .stat-card').length");
    check('overview renders the two primary stat cards', cardsReady && cardCount === 2, `cards=${cardCount}`);
    const overviewText = await pageText();
    check('overview shows Total Users and Total Chats',
      overviewText.includes('Total Users') && overviewText.includes('Total Chats'));
    check('overview no longer shows Messages/Resumes/AI primary cards',
      !/AI Requests Today|Total Messages|Total Resumes/.test(overviewText));

    // ===== 4b. Top-right identity: real profile menu + notification bell =====
    check('topbar shows the signed-in administrator profile button',
      await waitFor("!!document.querySelector('.admin-profile-btn')", 9000));
    check('topbar shows a notification bell', await evalJS("!!document.querySelector('.admin-bell')"));
    await clickSel('.admin-profile-btn');
    check('profile menu opens with an email address',
      await waitFor("(() => { const p=document.querySelector('.admin-profile-pop'); return !!(p && /@/.test(p.innerText)); })()", 6000));
    const profTxt = await evalJS("document.querySelector('.admin-profile-pop') ? document.querySelector('.admin-profile-pop').innerText : ''");
    check('profile menu shows the signed-in administrator email (never hardcoded)',
      profTxt.toLowerCase().includes(ADMIN_EMAIL));
    check('profile menu offers My Profile, Settings, Admin Controls and Logout',
      /My Profile/.test(profTxt) && /Settings/.test(profTxt)
      && /Admin Controls/.test(profTxt) && /Logout/.test(profTxt));
    await clickSel('.admin-profile-btn');

    // ===== 4c. Dashboard shows the real user-management list =====
    await goto(APP + '/admin/overview');
    check('dashboard shows a real user-management list below the cards',
      await waitFor("document.querySelectorAll('.admin-table tbody tr').length > 0", 9000));

    // ===== 4d. The large left sidebar is gone; sections live in a top-right menu =====
    const sidebarCount = await evalJS("document.querySelectorAll('.admin-side').length");
    check('the large left-hand sidebar is removed from the DOM', sidebarCount === 0, `found=${sidebarCount}`);
    check('a compact section menu button exists in the top-right',
      await evalJS("!!document.querySelector('.admin-menu-wrap .admin-menu-btn')"));
    await clickSel('.admin-menu-wrap .admin-menu-btn');
    const menuOpen = await waitFor("!!document.querySelector('.admin-nav-pop')", 5000);
    const menuText = await evalJS("document.querySelector('.admin-nav-pop') ? document.querySelector('.admin-nav-pop').innerText : ''");
    check('section menu opens with every admin section',
      menuOpen && ['Dashboard', 'Users', 'Admin Controls', 'Audit Log', 'Profile & Settings']
        .every((l) => menuText.includes(l)),
      menuText.replace(/\n/g, ' | '));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.admin-nav-pop .admin-pop-item')).find(x=>/Audit Log/.test(x.textContent)); if(b) b.click(); return !!b; })()");
    check('selecting a section from the menu navigates to it',
      await waitFor("location.pathname === '/admin/audit'", 6000));

    // ===== 4e. The two stat cards show REAL counts that exclude admin accounts =====
    await goto(APP + '/admin/overview');
    await waitFor("document.querySelectorAll('.admin-stat-grid .stat-card').length === 2", 9000);
    const cardVals = await evalJS("Array.from(document.querySelectorAll('.admin-stat-grid .stat-value')).map(e=>e.innerText.trim())");
    const adminToken = await evalJS("localStorage.getItem('adminToken')");
    const statsJson = await fetchJson('http://localhost:5000/api/admin/stats', { headers: { Authorization: 'Bearer ' + adminToken } });
    const dbUserCount = await User.countDocuments({ role: { $nin: ['co_admin', 'main_admin'] } });
    const dbChatCount = await Chat.countDocuments();
    const apiChats = statsJson.stats.totalChats ?? statsJson.stats.totalConversations;
    check('Total Users card matches the API and excludes admin accounts',
      statsJson.stats.totalUsers === dbUserCount && cardVals[0] === Number(statsJson.stats.totalUsers).toLocaleString(),
      `card=${cardVals[0]} api=${statsJson.stats.totalUsers} db=${dbUserCount}`);
    check('Total Chats card matches the API (totalChats alias) and the database',
      statsJson.stats.totalChats === statsJson.stats.totalConversations
      && apiChats === dbChatCount && cardVals[1] === Number(apiChats).toLocaleString(),
      `card=${cardVals[1]} api=${apiChats} db=${dbChatCount}`);

    // ===== 4f. Search + permanent delete straight from the dashboard =====
    throwaway = await User.create({
      name: 'CDP Dashboard Throwaway',
      email: `cdp-dash-${Date.now()}@example.test`,
      password: 'Temp#12345',
    });
    await goto(APP + '/admin/overview');
    await setInput('.admin-section-head .search-box input', throwaway.email);
    // The newest account is already first in the UNFILTERED list, so wait for the
    // debounced search to actually isolate exactly one row — not merely for the
    // email to appear somewhere in the table.
    const filtered = await waitFor("document.querySelectorAll('.admin-table tbody tr').length === 1", 9000);
    const rowCount = await evalJS("document.querySelectorAll('.admin-table tbody tr').length");
    const rowFound = await evalJS(`document.body.innerText.includes(${JSON.stringify(throwaway.email)})`);
    check('dashboard search finds a user by email', filtered && rowFound);
    check('dashboard search filters out unrelated accounts', rowCount === 1, `rows=${rowCount}`);
    await waitFor("document.querySelectorAll('.admin-stat-grid .stat-card').length === 2", 9000);
    const beforeDeleteVals = await evalJS("Array.from(document.querySelectorAll('.admin-stat-grid .stat-value')).map(e=>e.innerText.trim())");
    await evalJS("(() => { const r=document.querySelector('.admin-table tbody tr'); const b=r && r.querySelector('.btn-danger'); if(b) b.click(); return !!b; })()");
    const modalOpen = await waitFor("!!document.querySelector('.modal-confirm')", 5000);
    const modalText = await evalJS("document.querySelector('.modal-confirm') ? document.querySelector('.modal-confirm').innerText : ''");
    check('delete shows a confirmation that explains the permanent cascading removal',
      modalOpen && /permanently delete/i.test(modalText) && /cannot be undone/i.test(modalText) && modalText.includes(throwaway.email),
      modalText.replace(/\n/g, ' | '));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.modal-confirm .modal-foot button')).find(x=>/delete everything/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    const removed = await waitFor(`!document.body.innerText.includes(${JSON.stringify(throwaway.email)})`, 9000);
    check('confirming delete removes the user from the list', removed);
    check('the deleted user is really gone from the database', !(await User.exists({ _id: throwaway._id })));
    await waitFor("document.querySelectorAll('.admin-stat-grid .stat-card').length === 2", 6000);
    const afterVals = await evalJS("Array.from(document.querySelectorAll('.admin-stat-grid .stat-value')).map(e=>e.innerText.trim())");
    check('the Total Users card refreshes after a delete',
      beforeDeleteVals[0] === (dbUserCount + 1).toLocaleString() && afterVals[0] === dbUserCount.toLocaleString(),
      `before=${beforeDeleteVals[0]} after=${afterVals[0]} baseline=${dbUserCount}`);
    throwaway = null; // deleted via the UI

    // ===== 4g. Block and unblock straight from the dashboard table =====
    throwaway = await User.create({
      name: 'CDP Block Throwaway',
      email: `cdp-block-${Date.now()}@example.test`,
      password: 'Temp#12345',
    });
    await goto(APP + '/admin/overview');
    await setInput('.admin-section-head .search-box input', throwaway.email);
    await waitFor("document.querySelectorAll('.admin-table tbody tr').length === 1", 9000);
    await evalJS("(() => { const r=document.querySelector('.admin-table tbody tr'); const b=r && Array.from(r.querySelectorAll('button')).find(x=>/^Block$/i.test(x.textContent.trim())); if(b) b.click(); return !!b; })()");
    const blockModal = await waitFor("!!document.querySelector('.modal-confirm')", 5000);
    const blockModalText = await evalJS("document.querySelector('.modal-confirm') ? document.querySelector('.modal-confirm').innerText : ''");
    check('Block asks for confirmation and explains the consequence',
      blockModal && /block/i.test(blockModalText) && /cannot sign in/i.test(blockModalText)
      && blockModalText.includes(throwaway.email),
      blockModalText.replace(/\n/g, ' | '));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.modal-confirm .modal-foot button')).find(x=>/^block account$/i.test(x.textContent.trim())); if(b) b.click(); return !!b; })()");
    const blockedRow = await waitFor("(() => { const r=document.querySelector('.admin-table tbody tr'); return !!(r && /Blocked/i.test(r.innerText)); })()", 9000);
    const blockedDoc = await User.findById(throwaway._id).select('isActive');
    check('confirming Block marks the account blocked in the UI and the database',
      blockedRow && blockedDoc && blockedDoc.isActive === false,
      `ui=${blockedRow} isActive=${blockedDoc && blockedDoc.isActive}`);
    await evalJS("(() => { const r=document.querySelector('.admin-table tbody tr'); const b=r && Array.from(r.querySelectorAll('button')).find(x=>/^Unblock$/i.test(x.textContent.trim())); if(b) b.click(); return !!b; })()");
    const unblockModal = await waitFor("!!document.querySelector('.modal-confirm')", 5000);
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.modal-confirm .modal-foot button')).find(x=>/^unblock account$/i.test(x.textContent.trim())); if(b) b.click(); return !!b; })()");
    const unblockedRow = await waitFor("(() => { const r=document.querySelector('.admin-table tbody tr'); return !!(r && /Active/i.test(r.innerText)); })()", 9000);
    const unblockedDoc = await User.findById(throwaway._id).select('isActive');
    check('confirming Unblock restores the account in the UI and the database',
      unblockModal && unblockedRow && unblockedDoc && unblockedDoc.isActive !== false,
      `ui=${unblockedRow} isActive=${unblockedDoc && unblockedDoc.isActive}`);

    // ===== 4h. Block by email from the Admin Controls page =====
    await goto(APP + '/admin/controls');
    await waitFor("document.body.innerText.includes('Admin Controls')", 9000);
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.admin-tab')).find(x=>/Regular Users/i.test(x.textContent)); if(b) b.click(); return !!b; })()");
    const emailFormReady = await waitFor("!!document.querySelector('.admin-email-block input[type=\"email\"]')", 9000);
    await setInput('.admin-email-block input[type="email"]', throwaway.email);
    await clickSel('.admin-email-block button[type="submit"]');
    const emailModal = await waitFor("!!document.querySelector('.modal-confirm')", 9000);
    const emailModalText = await evalJS("document.querySelector('.modal-confirm') ? document.querySelector('.modal-confirm').innerText : ''");
    check('Admin Controls can look up a user by email and offer to block them',
      emailFormReady && emailModal && emailModalText.includes(throwaway.email) && /block/i.test(emailModalText),
      emailModalText.replace(/\n/g, ' | '));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.modal-confirm .modal-foot button')).find(x=>/^block account$/i.test(x.textContent.trim())); if(b) b.click(); return !!b; })()");
    let emailBlockedDoc = null;
    for (let i = 0; i < 40; i += 1) {
      emailBlockedDoc = await User.findById(throwaway._id).select('isActive');
      if (emailBlockedDoc && emailBlockedDoc.isActive === false) break;
      await sleep(150);
    }
    check('blocking by email really blocks the account in the database',
      emailBlockedDoc && emailBlockedDoc.isActive === false,
      `isActive=${emailBlockedDoc && emailBlockedDoc.isActive}`);

    // ===== 5. Section routes =====
    const sections = [
      ['/admin/users', 'ACCOUNT STATUS'],
      ['/admin/controls', 'Admin Controls'],
      ['/admin/requests', 'APPLICANT'],
      ['/admin/co-admins', 'APPROVED BY'],
      ['/admin/audit', 'Audit Log'],
      ['/admin/settings', 'My Profile'],
    ];
    for (const [route, heading] of sections) {
      await goto(APP + route);
      const ok = await waitFor(`document.body.innerText.includes(${JSON.stringify(heading)})`, 9000);
      check(`section ${route} renders "${heading}"`, ok);
    }

    // ===== 5b. Profile editor + Contact pane =====
    await goto(APP + '/admin/settings');
    check('My Profile offers an Edit Profile action',
      await evalJS("/Edit Profile/i.test(document.body.innerText)"));
    await evalJS("(() => { const b=Array.from(document.querySelectorAll('.settings-tab')).find(x=>/Contact/i.test(x.textContent)); if (b) b.click(); return !!b; })()");
    check('Contact pane shows the Main Admin Leader contact email',
      await waitFor("document.body.innerText.includes('metebharath4@gmail.com')", 8000));

    // ===== 6. Users table actually lists accounts =====
    await goto(APP + '/admin/users');
    const rows = await waitFor("document.querySelectorAll('.admin-table tbody tr').length > 0", 9000);
    check('user management lists real accounts from the database', rows);

    // ===== 7. Audit log shows recorded admin actions =====
    await goto(APP + '/admin/audit');
    const auditRows = await evalJS("document.querySelectorAll('.admin-table tbody tr').length");
    check('audit log shows recorded admin actions', auditRows > 0, `rows=${auditRows}`);

    // ===== 8. Logout redirects to the login page =====
    await goto(APP + '/admin/account');
    await evalJS("localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); 'cleared'");
    await goto(APP + '/admin/overview');
    const loggedOut = await waitFor("location.pathname.startsWith('/admin/login')", 8000);
    check('cleared admin session redirects to the login page', loggedOut);

    // ===== 9. No uncaught runtime errors in the console =====
    check('no uncaught runtime errors during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    // Remove the dashboard search/delete fixture if it somehow survived.
    if (throwaway) {
      try { await User.deleteOne({ _id: throwaway._id }); } catch { /* ignore */ }
    }
    // RESTORE the documented main-admin state.
    try {
      const doc = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
      doc.password = restore.password;
      doc.mustChangePassword = restore.mustChangePassword;
      doc.adminTokenVersion = restore.adminTokenVersion;
      await doc.save();
      console.log('      (restored the Main Admin Leader to its initial credentials + forced change)');
    } catch (err) {
      console.log(`      (RESTORE WARNING: ${err.message})`);
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
  console.error('\nadminUiSmokeTest.js crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
