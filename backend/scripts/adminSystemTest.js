// LIVE end-to-end proof of the admin system (§13): the Main Admin Leader
// bootstrap, forced initial-password change, admin access requests + approval,
// server-side RBAC, co-admin management/revocation, user suspension/deletion with
// cascade, real dashboard stats, settings + maintenance mode, audit logging, and
// that ordinary authentication still works.
//
// Needs: the backend on :5000 and MongoDB. Admin credentials come from
// INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (or ADMIN_TEST_EMAIL /
// ADMIN_TEST_PASSWORD). The test CHANGES the main admin password while running
// and RESTORES the initial credentials + mustChangePassword in a finally block,
// so the documented first-login flow is preserved. Throwaway users are deleted.
//
// Run: node scripts/adminSystemTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:5000') + '/api';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_EMAIL = String(process.env.ADMIN_TEST_EMAIL || process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || '';
const QUOTA_CODES = new Set(['AI_DAILY_LIMIT', 'AI_RATE_LIMITED', 'AI_PROVIDERS_UNAVAILABLE', 'AI_REQUEST_TOO_LARGE']);

const stamp = Date.now();
const TEMP_ADMIN_PASSWORD = `Adm1n#${stamp}`;

let pass = 0;
let fail = 0;
let skip = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};
const skipped = (name, detail = '') => {
  console.log(`SKIP  ${name}${detail ? ' :: ' + detail : ''}`);
  skip += 1;
};

const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const api = async (method, p, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = String(r.headers.get('content-type') || '').toLowerCase();
  const responseBody = await j(r);
  return { status: r.status, contentType, body: responseBody };
};

const registerUser = async (label) => {
  const email = `${label}_${stamp}@test.dev`;
  const r = await api('POST', '/auth/register', {
    body: { name: label, email, password: 'Secret123', confirmPassword: 'Secret123' },
  });
  return { email, token: r.body.token, userId: r.body.user && r.body.user._id, password: 'Secret123' };
};

const hasKey = (obj, key) => {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj).some((v) => hasKey(v, key));
};

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('FAIL  INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD are not set on the backend.');
    process.exit(1);
  }

  // ---- health --------------------------------------------------------------
  try {
    const h = await fetch(`${BASE}/health`);
    const hb = await j(h);
    if (!h.ok || hb.status !== 'ok') throw new Error(`status=${h.status}`);
    console.log(`      backend online (db=${hb.services && hb.services.database}, ai=${hb.services && hb.services.llm})`);
  } catch (err) {
    console.log(`FAIL  backend is not answering on ${BASE} :: ${err.message}`);
    console.log('      start it first (`node server.js` in backend/, or root `npm run dev`).');
    process.exit(1);
  }

  const missingCredentials = await api('POST', '/admin/login', { body: {} });
  check(
    'admin login missing credentials returns JSON 400',
    missingCredentials.status === 400 && missingCredentials.contentType.includes('application/json')
      && missingCredentials.body.code === undefined
      && typeof missingCredentials.body.message === 'string'
  );
  const incorrectCredentials = await api('POST', '/admin/login', {
    body: { email: ADMIN_EMAIL, password: `${ADMIN_PASSWORD}-wrong` },
  });
  check(
    'admin login incorrect password returns JSON 401',
    incorrectCredentials.status === 401
      && incorrectCredentials.contentType.includes('application/json')
      && incorrectCredentials.body.code === 'INVALID_CREDENTIALS'
  );

  if (!MONGO_URI) {
    console.log('FAIL  MONGO_URI is required for cleanup/restore.');
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const User = require('../models/User');
  const Chat = require('../models/Chat');
  const Resume = require('../models/Resume');
  const Document = require('../models/Document');
  const RAGDocument = require('../models/RAGDocument');
  const AdminRequest = require('../models/AdminRequest');
  const AuditLog = require('../models/AuditLog');

  const createdUserIds = [];
  let originalAdmin = null;

  try {
    originalAdmin = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
    if (!originalAdmin) {
      throw new Error(`Main Admin Leader ${ADMIN_EMAIL} does not exist — bootstrap failed.`);
    }
    const restore = {
      password: ADMIN_PASSWORD,
      mustChangePassword: originalAdmin.mustChangePassword,
      adminTokenVersion: originalAdmin.adminTokenVersion,
    };
    // Store immediately so the finally block can ALWAYS restore the main admin
    // even if a test assertion throws partway through.
    originalAdmin._testRestore = restore;

    // ======================================================================
    // 1. Main Admin Leader login + forced password change
    // ======================================================================
    console.log('\n=== 1. Main Admin Leader bootstrap + sign-in ===');
    let login = await api('POST', '/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (login.status !== 200 || !login.body.token) {
      // The operator may have already changed the password; surface that clearly.
      throw new Error(`Main Admin login failed (status=${login.status} code=${login.body.code}) — if you already changed the password, set ADMIN_TEST_PASSWORD.`);
    }
    let adminToken = login.body.token;
    const mainAdminId = String(login.body.admin._id);
    check('main admin login returns JSON', login.contentType.includes('application/json') && login.body && typeof login.body === 'object');
    check('main admin login works with the initial credentials', login.status === 200 && !!adminToken);
    check('login response contains NO password field', !hasKey(login.body, 'password'));
    const wasGated = login.body.admin.mustChangePassword === true;
    check('a freshly bootstrapped admin must change the initial password', wasGated,
      `mustChangePassword=${login.body.admin.mustChangePassword}`);

    const meRes = await api('GET', '/admin/me', { token: adminToken });
    check('GET /admin/me is allowed before the password change', meRes.status === 200 && meRes.body.admin.role === 'main_admin');

    if (wasGated) {
      const gated = await api('GET', '/admin/stats', { token: adminToken });
      check('normal admin operation is BLOCKED before the password change (403 PASSWORD_CHANGE_REQUIRED)',
        gated.status === 403 && gated.body.code === 'PASSWORD_CHANGE_REQUIRED', `status=${gated.status}`);

      const wrong = await api('POST', '/admin/change-password', {
        token: adminToken,
        body: { currentPassword: 'definitely-wrong', newPassword: TEMP_ADMIN_PASSWORD, confirmPassword: TEMP_ADMIN_PASSWORD },
      });
      check('changing password with a wrong current password is rejected', wrong.status === 401, `status=${wrong.status}`);

      const changed = await api('POST', '/admin/change-password', {
        token: adminToken,
        body: { currentPassword: ADMIN_PASSWORD, newPassword: TEMP_ADMIN_PASSWORD, confirmPassword: TEMP_ADMIN_PASSWORD },
      });
      check('initial password change succeeds', changed.status === 200 && !!changed.body.token, `status=${changed.status}`);
      if (changed.body.token) adminToken = changed.body.token;

      const statsNow = await api('GET', '/admin/stats', { token: adminToken });
      check('admin operations are ALLOWED after the password change', statsNow.status === 200, `status=${statsNow.status}`);
    } else {
      skipped('forced initial-password change', 'the admin already completed onboarding');
    }

    // The settings/profile endpoint accepts ONLY name/bio/avatar. A payload that
    // tries to change role, email, status or permissions must be ignored, both in
    // the response and in the database.
    const escalate = await api('PUT', '/admin/profile', {
      token: adminToken,
      body: {
        role: 'co_admin', email: 'attacker@example.test', isActive: false,
        adminPermissions: { deleteUsers: false, manageUsers: false }, mustChangePassword: false,
      },
    });
    const dbAdmin = await User.findOne({ email: ADMIN_EMAIL }).lean();
    check('admin profile settings cannot escalate role, email, status or permissions',
      escalate.status === 200 && escalate.body.admin.role === 'main_admin'
      && escalate.body.admin.email === ADMIN_EMAIL && escalate.body.admin.isActive !== false
      && escalate.body.admin.mustChangePassword === !!dbAdmin.mustChangePassword
      && escalate.body.admin.adminPermissions.deleteUsers === dbAdmin.adminPermissions.deleteUsers
      && escalate.body.admin.adminPermissions.manageUsers === dbAdmin.adminPermissions.manageUsers
      && dbAdmin.role === 'main_admin' && dbAdmin.isActive !== false,
      `status=${escalate.status} role=${escalate.body.admin && escalate.body.admin.role} dbRole=${dbAdmin.role}`);

    // ======================================================================
    // 2. Ordinary users cannot touch admin endpoints
    // ======================================================================
    console.log('\n=== 2. Ordinary-user isolation ===');
    const uNormal = await registerUser('normal');
    const uApplicant = await registerUser('applicant');
    const uReject = await registerUser('reject');
    const uDelete = await registerUser('deleteme');
    const uCo2 = await registerUser('co2');
    createdUserIds.push(uNormal.userId, uApplicant.userId, uReject.userId, uDelete.userId, uCo2.userId);
    check('existing user registration still works', !!uNormal.token);

    check('ordinary user GET /admin/stats -> 403',
      (await api('GET', '/admin/stats', { token: uNormal.token })).status === 403);
    check('ordinary user GET /admin/users -> 403',
      (await api('GET', '/admin/users', { token: uNormal.token })).status === 403);
    check('ordinary user GET /admin/requests -> 403',
      (await api('GET', '/admin/requests', { token: uNormal.token })).status === 403);
    check('ordinary user DELETE /admin/users/:id -> 403',
      (await api('DELETE', `/admin/users/${uDelete.userId}`, { token: uNormal.token, body: { confirm: true } })).status === 403);
    check('no token GET /admin/stats -> 401',
      (await api('GET', '/admin/stats')).status === 401);

    // ======================================================================
    // 3. Admin access requests: submit, no access, duplicate blocked
    // ======================================================================
    console.log('\n=== 3. Admin access requests ===');
    const req1 = await api('POST', '/admin/request', {
      body: { email: uApplicant.email, password: uApplicant.password, reason: 'I manage onboarding and need user tools.' },
    });
    check('eligible user can request admin access (pending)', req1.status === 201 && req1.body.request.status === 'pending', `status=${req1.status}`);

    const reqDup = await api('POST', '/admin/request', {
      body: { email: uApplicant.email, password: uApplicant.password, reason: 'duplicate attempt' },
    });
    check('duplicate pending request is prevented', reqDup.status === 200 && reqDup.body.code === 'ALREADY_PENDING', `status=${reqDup.status}`);

    const appLoginPre = await api('POST', '/admin/login', { body: { email: uApplicant.email, password: uApplicant.password } });
    check('a PENDING request grants NO admin session', appLoginPre.status === 403 && appLoginPre.body.code === 'NOT_ADMIN', `status=${appLoginPre.status}`);

    // ======================================================================
    // 4. Approve (with concurrency guard)
    // ======================================================================
    console.log('\n=== 4. Approval workflow ===');
    const pendingList = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const applicantReq = (pendingList.body.requests || []).find((r) => r.email === uApplicant.email);
    check('main admin can list pending requests', pendingList.status === 200 && !!applicantReq);

    if (applicantReq) {
      const [a1, a2] = await Promise.all([
        api('POST', `/admin/requests/${applicantReq._id}/approve`, { token: adminToken }),
        api('POST', `/admin/requests/${applicantReq._id}/approve`, { token: adminToken }),
      ]);
      const codes = [a1.status, a2.status].sort();
      check('concurrent double-approval grants exactly ONE approval', codes[0] === 200 && codes[1] === 409, `statuses=${codes.join(',')}`);
    }

    const appLoginPost = await api('POST', '/admin/login', { body: { email: uApplicant.email, password: uApplicant.password } });
    check('approved co-admin can sign in to the admin portal', appLoginPost.status === 200 && appLoginPost.body.admin.role === 'co_admin', `status=${appLoginPost.status}`);
    check('approved co-admin response has no password field', !hasKey(appLoginPost.body, 'password'));
    let coToken = appLoginPost.body.token;
    const coAdminId = String(appLoginPost.body.admin._id);

    // Co-admin is gated until they change their own (new) password.
    const coGated = await api('GET', '/admin/stats', { token: coToken });
    check('new co-admin must change password before normal ops (403)', coGated.status === 403 && coGated.body.code === 'PASSWORD_CHANGE_REQUIRED', `status=${coGated.status}`);
    const coChanged = await api('POST', '/admin/change-password', {
      token: coToken,
      body: { currentPassword: uApplicant.password, newPassword: 'CoAdmin#' + stamp, confirmPassword: 'CoAdmin#' + stamp },
    });
    check('co-admin can change their own password', coChanged.status === 200);
    if (coChanged.body.token) coToken = coChanged.body.token;

    // Permissions: manageUsers granted by default, everything else denied.
    check('co-admin CAN view users (manageUsers default)', (await api('GET', '/admin/users', { token: coToken })).status === 200);
    check('co-admin CANNOT view admin requests', (await api('GET', '/admin/requests', { token: coToken })).status === 403);
    check('co-admin CANNOT view audit logs', (await api('GET', '/admin/audit', { token: coToken })).status === 403);
    check('co-admin CANNOT change settings', (await api('PUT', '/admin/settings', { token: coToken, body: { aiLimits: { dailyRequestLimit: 1 } } })).status === 403);
    check('co-admin CANNOT delete users (no deleteUsers)', (await api('DELETE', `/admin/users/${uDelete.userId}`, { token: coToken, body: { confirm: true } })).status === 403);

    // ======================================================================
    // 5. Rejection leaves the user ordinary
    // ======================================================================
    console.log('\n=== 5. Rejection ===');
    await api('POST', '/admin/request', {
      body: { email: uReject.email, password: uReject.password, reason: 'please let me in' },
    });
    const rejectList = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const rejectReq = (rejectList.body.requests || []).find((r) => r.email === uReject.email);
    const rejected = rejectReq ? await api('POST', `/admin/requests/${rejectReq._id}/reject`, { token: adminToken, body: { note: 'not enough need' } }) : { status: 0, body: {} };
    check('main admin can reject a request', rejected.status === 200 && rejected.body.request.status === 'rejected', `status=${rejected.status}`);
    const rejectLogin = await api('POST', '/admin/login', { body: { email: uReject.email, password: uReject.password } });
    check('rejected user remains an ordinary user (no admin session)', rejectLogin.status === 403 && rejectLogin.body.code === 'NOT_ADMIN', `status=${rejectLogin.status}`);
    if (rejectReq) {
      const reApprove = await api('POST', `/admin/requests/${rejectReq._id}/approve`, { token: adminToken });
      check('an already-reviewed request cannot be approved', reApprove.status === 409, `status=${reApprove.status}`);
    }

    // ======================================================================
    // 6. Co-admins cannot approve / escalate / touch admins
    // ======================================================================
    console.log('\n=== 6. Co-admin escalation is impossible ===');
    await api('POST', '/admin/request', {
      body: { email: uNormal.email, password: uNormal.password, reason: 'normal wants admin' },
    });
    const normalReqList = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const normalReq = (normalReqList.body.requests || []).find((r) => r.email === uNormal.email);
    if (normalReq) {
      const coApprove = await api('POST', `/admin/requests/${normalReq._id}/approve`, { token: coToken });
      check('co-admin CANNOT approve any request (MAIN_ADMIN_REQUIRED)', coApprove.status === 403 && coApprove.body.code === 'MAIN_ADMIN_REQUIRED', `status=${coApprove.status}`);
    } else {
      check('co-admin CANNOT approve any request (MAIN_ADMIN_REQUIRED)', false, 'no pending request found');
    }
    check('co-admin CANNOT grant itself permissions',
      (await api('PATCH', `/admin/co-admins/${coAdminId}/permissions`, { token: coToken, body: { permissions: { deleteUsers: true, viewAudit: true } } })).status === 403);
    check('co-admin CANNOT revoke itself / others',
      (await api('POST', `/admin/co-admins/${coAdminId}/revoke`, { token: coToken })).status === 403);
    check('co-admin CANNOT delete the Main Admin Leader',
      (await api('DELETE', `/admin/co-admins/${mainAdminId}`, { token: coToken, body: { confirm: true } })).status === 403);
    check('co-admin CANNOT delete main admin via user delete',
      (await api('DELETE', `/admin/users/${mainAdminId}`, { token: coToken, body: { confirm: true } })).status === 403);

    // ======================================================================
    // 7. Main Admin Leader: manage-co-admin permissions and a 2nd co-admin
    // ======================================================================
    console.log('\n=== 7. Main Admin Leader co-admin management ===');
    const grant = await api('PATCH', `/admin/co-admins/${coAdminId}/permissions`, {
      token: adminToken,
      body: { permissions: { manageUsers: true, deleteUsers: true, manageRequests: true, viewAudit: true, manageSettings: true, manageResumes: true } },
    });
    check('main admin can update co-admin permissions', grant.status === 200 && grant.body.admin.adminPermissions.viewAudit === true, `status=${grant.status}`);
    check('main admin can list co-admins',
      (await api('GET', '/admin/co-admins', { token: adminToken })).status === 200);

    await api('POST', '/admin/request', { body: { email: uCo2.email, password: uCo2.password, reason: 'second co-admin' } });
    const co2List = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const co2Req = (co2List.body.requests || []).find((r) => r.email === uCo2.email);
    if (co2Req) {
      const ok = await api('POST', `/admin/requests/${co2Req._id}/approve`, { token: adminToken });
      check('main admin approves the second co-admin', ok.status === 200, `status=${ok.status}`);
    }
    // Reject the leftover normal-user request so cleanup is tidy.
    if (normalReq) await api('POST', `/admin/requests/${normalReq._id}/reject`, { token: adminToken, body: { note: 'cleanup' } });

    // ======================================================================
    // 8. User suspension / restoration (data preserved)
    // ======================================================================
    console.log('\n=== 8. Suspend / restore ===');
    const coAdminBlockUser = await api('POST', `/admin/users/${uNormal.userId}/suspend`, { token: coToken, body: {} });
    check('co-admin cannot block a regular user (MAIN_ADMIN_REQUIRED)',
      coAdminBlockUser.status === 403 && coAdminBlockUser.body.code === 'MAIN_ADMIN_REQUIRED', `status=${coAdminBlockUser.status}`);
    const coAdminBlockAdmin = await api('POST', `/admin/users/${uCo2.userId}/suspend`, { token: coToken, body: {} });
    check('co-admin cannot block another administrator (MAIN_ADMIN_REQUIRED)',
      coAdminBlockAdmin.status === 403 && coAdminBlockAdmin.body.code === 'MAIN_ADMIN_REQUIRED', `status=${coAdminBlockAdmin.status}`);
    const susp = await api('POST', `/admin/users/${uNormal.userId}/suspend`, { token: adminToken, body: { reason: 'abuse test' } });
    check('main admin can suspend a user', susp.status === 200, `status=${susp.status}`);
    check('a suspended user cannot use their existing token', (await api('GET', '/auth/me', { token: uNormal.token })).status === 403);
    const blockedLogin = await api('POST', '/auth/login', { body: { email: uNormal.email, password: uNormal.password } });
    check('a suspended user cannot log in (403 ACCOUNT_BLOCKED)',
      blockedLogin.status === 403 && blockedLogin.body.code === 'ACCOUNT_BLOCKED', `status=${blockedLogin.status}`);
    const rest = await api('POST', `/admin/users/${uNormal.userId}/restore`, { token: adminToken });
    check('main admin can restore a user', rest.status === 200);
    check('a restored user can use their token again', (await api('GET', '/auth/me', { token: uNormal.token })).status === 200);
    const restoredLogin = await api('POST', '/auth/login', { body: { email: uNormal.email, password: uNormal.password } });
    check('a restored user can log in again', restoredLogin.status === 200 && !!restoredLogin.body.token, `status=${restoredLogin.status}`);

    check('main admin CANNOT suspend themselves (protected account)',
      (await api('POST', `/admin/users/${mainAdminId}/suspend`, { token: adminToken, body: {} })).status === 403);
    const badGet = await api('GET', '/admin/users/not-an-object-id', { token: adminToken });
    check('malformed user id is rejected with 400 (never a CastError 500)',
      badGet.status === 400 && badGet.body.code === 'INVALID_ID', `status=${badGet.status} code=${badGet.body.code}`);
    const badSuspend = await api('POST', '/admin/users/not-an-object-id/suspend', { token: adminToken, body: {} });
    check('malformed id on a mutating admin route is rejected with 400',
      badSuspend.status === 400 && badSuspend.body.code === 'INVALID_ID', `status=${badSuspend.status}`);

    // ======================================================================
    // 9. Deletion: confirmation + safe cascade
    // ======================================================================
    console.log('\n=== 9. Deletion + cascade ===');
    // Seed real related records for the user we will delete.
    await Chat.create({ userId: uDelete.userId, title: 'cascade-chat', messages: [{ role: 'user', content: 'hi' }] });
    await Resume.create({ userId: uDelete.userId, fileName: 'resume.pdf', fileType: 'pdf', fileSize: 1000, originalText: 'secret resume text', parsed: {} });
    await Document.create({ userId: uDelete.userId, fileName: 'notes.txt', extension: 'txt', size: 10, category: 'document', text: 'private' });
    await RAGDocument.create({ userId: uDelete.userId, source: 'resume', section: 'skills', text: 'java' });

    const noConfirm = await api('DELETE', `/admin/users/${uDelete.userId}`, { token: adminToken });
    check('deletion without confirmation is refused', noConfirm.status === 400 && noConfirm.body.code === 'CONFIRMATION_REQUIRED', `status=${noConfirm.status}`);
    check('main admin CANNOT delete themselves (protected account)',
      (await api('DELETE', `/admin/users/${mainAdminId}`, { token: adminToken, body: { confirm: true } })).status === 403);
    check('the Main Admin Leader is protected from deletion', (await api('DELETE', `/admin/users/${mainAdminId}`, { token: coToken, body: { confirm: true } })).status === 403);

    const del = await api('DELETE', `/admin/users/${uDelete.userId}`, { token: adminToken, body: { confirm: true } });
    check('confirmed deletion succeeds', del.status === 200, `status=${del.status}`);
    const [cChat, cResume, cDoc, cRag, cUser] = await Promise.all([
      Chat.countDocuments({ userId: uDelete.userId }),
      Resume.countDocuments({ userId: uDelete.userId }),
      Document.countDocuments({ userId: uDelete.userId }),
      RAGDocument.countDocuments({ userId: uDelete.userId }),
      User.countDocuments({ _id: uDelete.userId }),
    ]);
    check('deletion cascades to chats, resume, documents, RAG chunks, and the account',
      cChat === 0 && cResume === 0 && cDoc === 0 && cRag === 0 && cUser === 0,
      `chat=${cChat} resume=${cResume} doc=${cDoc} rag=${cRag} user=${cUser}`);

    // ======================================================================
    // 10. Revoke + delete co-admin (sessions die immediately)
    // ======================================================================
    console.log('\n=== 10. Revoke / delete co-admin ===');
    const oldCoToken = coToken;
    const revoke = await api('POST', `/admin/co-admins/${coAdminId}/revoke`, { token: adminToken });
    check('main admin can revoke co-admin access', revoke.status === 200, `status=${revoke.status}`);
    check('a revoked co-admin token can no longer reach admin APIs', (await api('GET', '/admin/stats', { token: oldCoToken })).status === 403);
    check('a revoked co-admin is no longer an admin at sign-in',
      (await api('POST', '/admin/login', { body: { email: uApplicant.email, password: 'CoAdmin#' + stamp } })).status === 403);

    const co2U = await User.findOne({ email: uCo2.email });
    const delCo = await api('DELETE', `/admin/co-admins/${co2U._id}`, { token: adminToken, body: { confirm: true } });
    check('main admin can delete a co-admin account', delCo.status === 200, `status=${delCo.status}`);
    check('deleted co-admin account is gone', (await User.countDocuments({ _id: co2U._id })) === 0);

    // ======================================================================
    // 11. Dashboard stats + system health (real, redacted)
    // ======================================================================
    console.log('\n=== 11. Stats / monitoring ===');
    const statsRes = await api('GET', '/admin/stats', { token: adminToken });
    const s = statsRes.body.stats || {};
    const expectedUsers = await User.countDocuments({ role: { $nin: ['co_admin', 'main_admin'] } });
    const regularUserIds = await User.distinct('_id', { role: { $nin: ['co_admin', 'main_admin'] } });
    const expectedChats = await Chat.countDocuments({
      userId: { $in: regularUserIds },
      messages: { $exists: true, $ne: [] },
    });
    check('stats returns real numeric totals',
      statsRes.status === 200 && typeof s.totalUsers === 'number' && s.totalUsers >= 150 &&
      typeof s.pendingAdminRequests === 'number' && typeof s.totalConversations === 'number',
      `users=${s.totalUsers} convos=${s.totalConversations}`);
    check('dashboard totals count saved conversations owned by regular users only',
      s.totalUsers === expectedUsers && s.totalConversations === expectedChats,
      `users=${s.totalUsers}/${expectedUsers} chats=${s.totalConversations}/${expectedChats}`);
    const userRows = await api('GET', `/admin/users?role=user&limit=50&search=${encodeURIComponent(uNormal.email)}`, { token: adminToken });
    const normalRow = (userRows.body.users || []).find((u) => u._id === uNormal.userId);
    const expectedNormalChats = await Chat.countDocuments({ userId: uNormal.userId });
    check('user table chat count matches chats owned by that user',
      userRows.status === 200 && !!normalRow && normalRow.chatCount === expectedNormalChats,
      `chatCount=${normalRow && normalRow.chatCount}/${expectedNormalChats}`);
    check('stats includes tracked AI usage counters', s.ai && s.ai.today && typeof s.ai.today.aiTotal === 'number');
    check('stats exposes totalChats as a real alias of totalConversations',
      typeof s.totalChats === 'number' && s.totalChats === s.totalConversations,
      `totalChats=${s.totalChats} totalConversations=${s.totalConversations}`);
    check('stats reports recent registrations', Array.isArray(statsRes.body.recentUsers) && statsRes.body.recentUsers.length > 0);

    const sysRes = await api('GET', '/admin/system', { token: adminToken });
    check('system health separates backend vs AI provider',
      sysRes.status === 200 && sysRes.body.system.backend === 'online' && 'aiProvider' in sysRes.body.system && sysRes.body.system.mongodb === 'connected',
      `ai=${sysRes.body.system && sysRes.body.system.aiProvider}`);

    // ======================================================================
    // 12. Audit log (append-only, permissioned, no delete route)
    // ======================================================================
    console.log('\n=== 12. Audit log ===');
    const auditRes = await api('GET', '/admin/audit?limit=100', { token: adminToken });
    const actions = (auditRes.body.logs || []).map((l) => l.action);
    check('audit log records approvals', actions.includes('admin.request.approve'));
    check('audit log records rejections', actions.includes('admin.request.reject'));
    check('audit log records suspension/restoration', actions.includes('admin.user.suspend') && actions.includes('admin.user.restore'));
    check('audit log records deletions', actions.includes('admin.user.delete'));
    check('audit log records co-admin revocation', actions.includes('admin.coadmin.revoke'));
    check('audit log has NO delete endpoint', (await api('DELETE', '/admin/audit', { token: adminToken })).status === 404 || (await api('DELETE', '/admin/audit', { token: adminToken })).status === 405);

    // ======================================================================
    // 13. Settings + maintenance mode
    // ======================================================================
    console.log('\n=== 13. Settings / maintenance ===');
    const set0 = await api('GET', '/admin/settings', { token: adminToken });
    check('settings readable by main admin', set0.status === 200 && !!set0.body.providers);
    const setUpd = await api('PUT', '/admin/settings', {
      token: adminToken,
      body: { uploadLimits: { resumeMaxMB: 12 }, aiLimits: { dailyRequestLimit: 0, perMinuteUserLimit: 0 } },
    });
    check('main admin can update settings', setUpd.status === 200 && setUpd.body.settings.uploadLimits.resumeMaxMB === 12);

    const maintOn = await api('PUT', '/admin/settings', { token: adminToken, body: { maintenanceMode: { enabled: true, message: 'Scheduled maintenance (test).' } } });
    check('main admin can enable maintenance mode', maintOn.status === 200 && maintOn.body.settings.maintenanceMode.enabled === true);
    check('health stays reachable during maintenance', (await fetch(`${BASE}/health`)).status === 200);
    const blocked = await api('GET', '/chat', { token: uNormal.token });
    check('ordinary traffic is paused during maintenance (503)', blocked.status === 503 && blocked.body.code === 'MAINTENANCE_MODE', `status=${blocked.status}`);
    check('admin APIs stay reachable during maintenance', (await api('GET', '/admin/stats', { token: adminToken })).status === 200);
    const maintOff = await api('PUT', '/admin/settings', { token: adminToken, body: { maintenanceMode: { enabled: false } } });
    check('main admin can disable maintenance mode', maintOff.status === 200 && maintOff.body.settings.maintenanceMode.enabled === false);
    check('ordinary traffic resumes after maintenance', (await api('GET', '/chat', { token: uNormal.token })).status === 200);

    const restoreLimits = await api('PUT', '/admin/settings', { token: adminToken, body: { uploadLimits: { resumeMaxMB: 10 } } });
    check('settings restored to defaults', restoreLimits.status === 200 && restoreLimits.body.settings.uploadLimits.resumeMaxMB === 10);

    // ======================================================================
    // 14. Secret redaction across admin responses
    // ======================================================================
    console.log('\n=== 14. Secret redaction ===');
    const blobs = [login.body, meRes.body, statsRes.body, sysRes.body, set0.body, auditRes.body, revoke.body, del.body];
    const text = JSON.stringify(blobs);
    const forbidden = [process.env.JWT_SECRET, process.env.LLM_API_KEY, 'gsk_'].filter(Boolean);
    check('no JWT secret / provider key in any admin response', forbidden.every((f) => !text.includes(f)));
    check('no response carries a password hash/salt', !/passwordHash|bcrypt|\$2[aby]\$/.test(text));
    check('no admin response object exposes a password field', !blobs.some((b) => hasKey(b, 'password')));

    // ======================================================================
    // 15. Existing AI surface still honest (quota-aware)
    // ======================================================================
    console.log('\n=== 15. Existing chat still works ===');
    const ai = await api('POST', '/ai/career-assistant', {
      token: uNormal.token,
      body: { message: 'hi', requestId: `admin-e2e-${stamp}`, documentIds: [] },
    });
    if (ai.status === 200) {
      check('career-assistant still answers after the admin changes', String(ai.body.message && ai.body.message.content || '').length > 0);
    } else if (QUOTA_CODES.has(ai.body.code)) {
      skipped('career-assistant still answers', `provider quota (${ai.body.code}) — not an app failure`);
    } else {
      check('career-assistant still answers after the admin changes', false, `status=${ai.status} code=${ai.body.code}`);
    }
  } finally {
    // ----------------------------------------------------------------------
    // Cleanup: remove throwaway users + their requests; RESTORE the main admin
    // to its documented initial state (initial password + forced change).
    // ----------------------------------------------------------------------
    try {
      for (const id of createdUserIds.filter(Boolean)) {
        await Promise.all([
          Chat.deleteMany({ userId: id }),
          Resume.deleteMany({ userId: id }),
          Document.deleteMany({ userId: id }),
          RAGDocument.deleteMany({ userId: id }),
          AdminRequest.deleteMany({ userId: id }),
        ]);
        await User.deleteOne({ _id: id });
      }
      console.log(`\n      (cleaned up ${createdUserIds.filter(Boolean).length} test users + related records)`);
    } catch (err) {
      console.log(`      (cleanup warning: ${err.message})`);
    }

    try {
      if (originalAdmin && originalAdmin._testRestore) {
        const r = originalAdmin._testRestore;
        const doc = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
        doc.password = r.password;
        doc.mustChangePassword = r.mustChangePassword;
        doc.adminTokenVersion = r.adminTokenVersion;
        await doc.save();
        console.log('      (restored the Main Admin Leader to its initial credentials + forced change)');
      }
    } catch (err) {
      console.log(`      (RESTORE WARNING: could not reset the main admin password — ${err.message})`);
    }

    try { await mongoose.disconnect(); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(56));
  console.log(`RESULTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('\nadminSystemTest.js crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
