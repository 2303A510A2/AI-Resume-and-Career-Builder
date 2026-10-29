// LIVE proof of the NEW admin-console contract added for the dashboard redesign:
//   * GET /admin/me exposes the Main Admin Leader contact email, the admin's own
//     profile (avatar+bio), unread notification count and pending-request count.
//   * PUT /admin/profile persists name + bio + a validated base64 photo, and the
//     change is visible on the next GET /admin/me (survives the request).
//   * Approving an admin request creates a REAL in-app notification for the
//     applicant, which they can read/mark-read from their own inbox.
//   * Rejecting a request records a REAL notification for the applicant.
//
// Needs: the backend on :5000 + MongoDB. It temporarily changes the Main Admin
// Leader's password/profile and RESTORES both in a finally block. Throwaway
// users, requests and notifications are deleted.
//
// Run: node scripts/adminProfileNotifTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const AdminRequest = require('../models/AdminRequest');
const Notification = require('../models/Notification');

const BASE = (process.env.API_BASE_URL || 'http://127.0.0.1:5000') + '/api';
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_EMAIL = String(process.env.ADMIN_TEST_EMAIL || process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || '';

const stamp = Date.now();
const TEMP_ADMIN_PASSWORD = `Adm1n#${stamp}`;
// 1x1 transparent PNG — small, valid, and accepted by the avatar sanitiser.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BAD_AVATAR = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
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
  return { status: r.status, body: await j(r) };
};

const registerUser = async (label) => {
  const email = `${label}_${stamp}@test.dev`;
  const r = await api('POST', '/auth/register', {
    body: { name: label, email, password: 'Secret123', confirmPassword: 'Secret123' },
  });
  return { email, password: 'Secret123', userId: r.body.user && r.body.user._id, token: r.body.token };
};

const loginAdmin = async (email, password) => {
  const r = await api('POST', '/admin/login', { body: { email, password } });
  return { status: r.status, body: r.body };
};

const makeAdminToken = async (email, password) => {
  // Sign in, then satisfy the forced first-login password change and return a
  // token that is allowed to reach normal admin endpoints.
  const first = await loginAdmin(email, password);
  if (first.status !== 200 || !first.body.token) return { token: '', status: first.status, body: first.body, mustChange: null };
  let token = first.body.token;
  const mustChange = !!(first.body.admin && first.body.admin.mustChangePassword);
  if (mustChange) {
    const cp = await api('POST', '/admin/change-password', {
      token,
      body: { currentPassword: password, newPassword: TEMP_ADMIN_PASSWORD, confirmPassword: TEMP_ADMIN_PASSWORD },
    });
    token = cp.body.token || token;
  }
  return { token, status: first.status, body: first.body, mustChange };
};

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('FAIL  INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD not set.');
    process.exit(1);
  }
  try {
    const h = await j(await fetch('http://127.0.0.1:5000/api/health'));
    if (h.status !== 'ok') throw new Error('health not ok');
  } catch (err) {
    console.log(`FAIL  backend not reachable (${err.message}).`);
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const mainDoc = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
  if (!mainDoc) throw new Error('Main Admin Leader not found');
  const restore = {
    password: ADMIN_PASSWORD,
    mustChangePassword: mainDoc.mustChangePassword,
    adminTokenVersion: mainDoc.adminTokenVersion,
    name: mainDoc.name,
    bio: (mainDoc.profile && mainDoc.profile.bio) || '',
    avatar: (mainDoc.profile && mainDoc.profile.avatar) || '',
  };

  const u1 = await registerUser('notifok');
  const u2 = await registerUser('notifno');
  const tracked = [u1, u2];

  try {
    // ===== 1. /admin/me new contract =====
    console.log('\n=== 1. GET /admin/me exposes contact + profile + badge counts ===');
    const admin = await makeAdminToken(ADMIN_EMAIL, ADMIN_PASSWORD);
    check('main admin can sign in', admin.status === 200 && !!admin.token, `status=${admin.status}`);
    const adminToken = admin.token;

    const me1 = await api('GET', '/admin/me', { token: adminToken });
    check('GET /admin/me is 200', me1.status === 200);
    check('the Main Admin Leader contact email is exposed', String(me1.body.mainAdminEmail || '').toLowerCase() === ADMIN_EMAIL, me1.body.mainAdminEmail);
    check('the admin profile object is exposed (avatar+bio)',
      !!me1.body.admin && !!me1.body.admin.profile && 'avatar' in me1.body.admin.profile && 'bio' in me1.body.admin.profile);
    check('unreadNotifications is a real number', typeof me1.body.unreadNotifications === 'number', String(me1.body.unreadNotifications));
    const realPending = await AdminRequest.countDocuments({ status: 'pending' });
    check('pendingAdminRequests matches the real pending count',
      me1.body.pendingAdminRequests === realPending, `api=${me1.body.pendingAdminRequests} db=${realPending}`);

    // ===== 2. Profile persistence (bio + avatar) =====
    console.log('\n=== 2. PUT /admin/profile persists bio + photo ===');
    const newBio = `Platform maintainer · updated ${stamp}`;
    const put = await api('PUT', '/admin/profile', {
      token: adminToken,
      body: { name: restore.name, bio: newBio, avatar: PNG },
    });
    check('profile update succeeds', put.status === 200, `status=${put.status}`);
    check('the response echoes the new bio', put.body.admin && put.body.admin.profile.bio === newBio);
    check('the response echoes the new avatar', put.body.admin && put.body.admin.profile.avatar === PNG);

    const me2 = await api('GET', '/admin/me', { token: adminToken });
    check('the new bio is persisted in MongoDB (reads back on /admin/me)',
      me2.body.admin && me2.body.admin.profile.bio === newBio, (me2.body.admin && me2.body.admin.profile.bio) || '');
    check('the new avatar is persisted (base64 data URL, not a file path)',
      me2.body.admin && me2.body.admin.profile.avatar === PNG);
    const dbDoc = await User.findById(mainDoc._id).select('profile');
    check('MongoDB doc holds the avatar + bio (not a temporary path)',
      dbDoc.profile && dbDoc.profile.avatar === PNG && dbDoc.profile.bio === newBio);

    const bad = await api('PUT', '/admin/profile', { token: adminToken, body: { avatar: BAD_AVATAR } });
    check('a non-image avatar is rejected with INVALID_IMAGE', bad.status === 400 && bad.body.code === 'INVALID_IMAGE', `status=${bad.status}`);

    // ===== 3. Approval creates a REAL notification for the applicant =====
    console.log('\n=== 3. Approval notifies the applicant (real in-app notification) ===');
    const req1 = await api('POST', '/admin/request', {
      body: { email: u1.email, password: u1.password, reason: 'I help onboard new users and need tools.' },
    });
    check('applicant submits a pending request', req1.status === 201 && req1.body.request && req1.body.request.status === 'pending', `status=${req1.status}`);

    const pending = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const reqDoc = (pending.body.requests || []).find((r) => r.email === u1.email);
    check('the request is listed for the Main Admin Leader', !!reqDoc);

    if (reqDoc) {
      const ap = await api('POST', `/admin/requests/${reqDoc._id}/approve`, { token: adminToken });
      check('approval succeeds', ap.status === 200, `status=${ap.status}`);
    }

    const notifDoc = await Notification.findOne({ userId: u1.userId, type: 'admin_approved' });
    check('an admin_approved notification row exists in MongoDB for the applicant', !!notifDoc);

    const u1Admin = await makeAdminToken(u1.email, u1.password);
    check('the approved applicant can now sign in to the admin portal', u1Admin.status === 200 && !!u1Admin.token);
    const inbox = await api('GET', '/admin/notifications', { token: u1Admin.token });
    check('the applicant\'s own inbox returns the approval notification',
      inbox.status === 200 && (inbox.body.notifications || []).some((n) => /approved/i.test(n.title)), `status=${inbox.status}`);
    check('the inbox reports an unread count >= 1', inbox.body.unread >= 1, String(inbox.body.unread));

    const firstNotif = (inbox.body.notifications || [])[0];
    if (firstNotif) {
      const rd = await api('POST', `/admin/notifications/${firstNotif._id}/read`, { token: u1Admin.token });
      check('marking one notification read decrements the unread count',
        rd.status === 200 && rd.body.unread === inbox.body.unread - 1, `before=${inbox.body.unread} after=${rd.body.unread}`);
    }
    const all = await api('POST', '/admin/notifications/read-all', { token: u1Admin.token });
    check('mark-all-read clears the unread count', all.status === 200 && all.body.unread === 0);

    // ===== 4. Rejection records a REAL notification for the applicant =====
    console.log('\n=== 4. Rejection notifies the applicant (real in-app notification) ===');
    await api('POST', '/admin/request', {
      body: { email: u2.email, password: u2.password, reason: 'I want to help but am not sure why.' },
    });
    const pending2 = await api('GET', '/admin/requests?status=pending', { token: adminToken });
    const reqDoc2 = (pending2.body.requests || []).find((r) => r.email === u2.email);
    if (reqDoc2) {
      const rj = await api('POST', `/admin/requests/${reqDoc2._id}/reject`, { token: adminToken, body: { note: 'not needed right now' } });
      check('rejection succeeds', rj.status === 200, `status=${rj.status}`);
    } else {
      check('rejection succeeds', false, 'request not found');
    }
    const rejDoc = await Notification.findOne({ userId: u2.userId, type: 'admin_rejected' });
    check('an admin_rejected notification row exists for the declined applicant', !!rejDoc);
    const u2Login = await loginAdmin(u2.email, u2.password);
    check('the declined applicant remains a non-admin', u2Login.status === 403 && u2Login.body.code === 'NOT_ADMIN', `status=${u2Login.status}`);
  } finally {
    // Restore the Main Admin Leader (profile + credentials + forced-change flag).
    try {
      const d = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
      if (d) {
        d.password = restore.password;
        d.mustChangePassword = restore.mustChangePassword;
        d.adminTokenVersion = restore.adminTokenVersion;
        d.name = restore.name;
        d.profile = d.profile || {};
        d.profile.bio = restore.bio;
        d.profile.avatar = restore.avatar;
        await d.save();
        console.log('      (restored the Main Admin Leader profile + credentials)');
      }
    } catch (err) {
      console.log(`      (RESTORE WARNING: ${err.message})`);
    }
    try {
      const ids = tracked.map((u) => u.userId).filter(Boolean);
      await Notification.deleteMany({ userId: { $in: ids } });
      await AdminRequest.deleteMany({ email: { $in: tracked.map((u) => u.email) } });
      await User.deleteMany({ email: { $in: tracked.map((u) => u.email) } });
      console.log('      (cleaned up throwaway users + requests + notifications)');
    } catch (err) {
      console.log(`      (cleanup warning: ${err.message})`);
    }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(56));
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('\nadminProfileNotifTest.js crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
