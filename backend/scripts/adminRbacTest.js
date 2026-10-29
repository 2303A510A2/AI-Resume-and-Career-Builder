// OFFLINE unit suite for server-side admin authorization (no MongoDB, no AI key,
// no network). It proves the rule that matters most: authorization reads the
// EFFECTIVE database role, never a role forged into the JWT or the request body.
//
// Run: node scripts/adminRbacTest.js
/* eslint-disable no-console */

const {
  requireAdmin,
  requireMainAdmin,
  requirePermission,
  requirePasswordChanged,
} = require('../middleware/adminMiddleware');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};

// Minimal Express req/res doubles. `admin` is pre-populated from the record to
// emulate the real chain `protect -> requireAdmin -> requireMainAdmin/...`.
const makeReq = (userRecord, opts = {}) => ({
  userRecord,
  admin: userRecord,
  auth: opts.auth,
  body: opts.body || {},
  headers: {},
  ip: '127.0.0.1',
});
const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
};
const run = (mw, req) => {
  const res = makeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { nexted, res, req };
};

const user = (role, extra = {}) => ({
  _id: 'u1',
  email: `${role}@test.dev`,
  role,
  isActive: true,
  adminPermissions: {},
  adminTokenVersion: 0,
  ...extra,
});
const FULL = {
  manageUsers: true, deleteUsers: true, manageResumes: true,
  manageRequests: true, viewAudit: true, manageSettings: true,
};

console.log('\n=== requireAdmin ===');
{
  let r = run(requireAdmin, makeReq(null));
  check('no authenticated record -> 403 ADMIN_REQUIRED', r.res.statusCode === 403 && r.res.body.code === 'ADMIN_REQUIRED');

  r = run(requireAdmin, makeReq(user('user')));
  check("role 'user' -> 403 ADMIN_REQUIRED", r.res.statusCode === 403 && !r.nexted);

  r = run(requireAdmin, makeReq(user('co_admin')));
  check("role 'co_admin' active -> next()", r.nexted && r.req.admin.role === 'co_admin');

  r = run(requireAdmin, makeReq(user('main_admin')));
  check("role 'main_admin' active -> next()", r.nexted);

  r = run(requireAdmin, makeReq(user('co_admin', { isActive: false })));
  check('suspended admin -> 403 ACCOUNT_DISABLED', r.res.statusCode === 403 && r.res.body.code === 'ACCOUNT_DISABLED');

  r = run(requireAdmin, makeReq(user('co_admin', { adminTokenVersion: 3 }), { auth: { role: 'co_admin', av: 2 } }));
  check('revoked session (stale av) -> 401 SESSION_REVOKED', r.res.statusCode === 401 && r.res.body.code === 'SESSION_REVOKED');

  r = run(requireAdmin, makeReq(user('co_admin', { adminTokenVersion: 3 }), { auth: { role: 'co_admin', av: 3 } }));
  check('matching av -> next()', r.nexted);

  // The decisive anti-forgery test: token claims main_admin, DB says user.
  r = run(requireAdmin, makeReq(user('user'), { auth: { role: 'main_admin', av: 0 } }));
  check('forged JWT role cannot elevate a DB user', r.res.statusCode === 403 && !r.nexted);

  // A request body claiming a role must be ignored entirely.
  r = run(requireAdmin, makeReq(user('user'), { body: { role: 'main_admin', admin: true } }));
  check('role in request body never grants admin', r.res.statusCode === 403 && !r.nexted);
}

console.log('\n=== requireMainAdmin ===');
{
  let r = run(requireMainAdmin, makeReq(user('co_admin', { adminPermissions: FULL })));
  check('co_admin (even with all permissions) -> 403 MAIN_ADMIN_REQUIRED', r.res.statusCode === 403 && r.res.body.code === 'MAIN_ADMIN_REQUIRED');

  r = run(requireMainAdmin, makeReq(user('main_admin')));
  check('main_admin -> next()', r.nexted);
}

console.log('\n=== requirePermission ===');
{
  const perms = ['manageUsers', 'deleteUsers', 'manageResumes', 'manageRequests', 'viewAudit', 'manageSettings'];
  let ok = true;
  for (const p of perms) {
    const r = run(requirePermission(p), makeReq(user('main_admin')));
    if (!r.nexted) ok = false;
  }
  check('main_admin passes EVERY permission', ok);

  let r = run(requirePermission('manageUsers'), makeReq(user('co_admin', { adminPermissions: { manageUsers: true } })));
  check('co_admin with the flag -> next()', r.nexted);

  r = run(requirePermission('deleteUsers'), makeReq(user('co_admin', { adminPermissions: { manageUsers: true } })));
  check('co_admin WITHOUT the flag -> 403 PERMISSION_DENIED', r.res.statusCode === 403 && r.res.body.code === 'PERMISSION_DENIED');

  r = run(requirePermission('viewAudit'), makeReq(user('co_admin', { adminPermissions: {} })));
  check('empty permission set denies', r.res.statusCode === 403);

  // Non-boolean truthy values must not pass.
  r = run(requirePermission('deleteUsers'), makeReq(user('co_admin', { adminPermissions: { deleteUsers: 'yes' } })));
  check('non-boolean permission value is NOT accepted', r.res.statusCode === 403);
}

console.log('\n=== requirePasswordChanged ===');
{
  // requireAdmin sets req.admin from the DB record; emulate that first.
  const mw = (req, res, nxt) => { req.admin = req.userRecord; requirePasswordChanged(req, res, nxt); };

  const gated = run(mw, makeReq(user('main_admin', { mustChangePassword: true })));
  check('mustChangePassword true -> 403 PASSWORD_CHANGE_REQUIRED', gated.res.statusCode === 403 && gated.res.body.code === 'PASSWORD_CHANGE_REQUIRED');

  const open = run(mw, makeReq(user('main_admin', { mustChangePassword: false })));
  check('mustChangePassword false -> next()', open.nexted);
}

console.log('\n=== role/permission matrix (explicit) ===');
{
  const matrix = [
    ['user', 'stats', false],
    ['user', 'manageUsers', false],
    ['co_admin', 'manageUsers', true],
    ['co_admin', 'deleteUsers', false],
    ['main_admin', 'deleteUsers', true],
  ];
  for (const [role, perm, expected] of matrix) {
    const rec = user(role, { adminPermissions: role === 'co_admin' ? { manageUsers: true } : {} });
    const r = run(requirePermission(perm), makeReq(rec));
    check(`${role} / ${perm} -> ${expected ? 'allow' : 'deny'}`, r.nexted === expected);
  }
}

console.log('\n' + '='.repeat(56));
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
