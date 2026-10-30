// Offline authentication/admin regression checks (no MongoDB, no server, no key).
// Run: node scripts/authAdminContractTest.js
/* eslint-disable no-console */

const assert = require('assert');
const User = require('../models/User');
const { emailLookup, normalizeEmail } = require('../utils/validators');
const { bootstrapMainAdmin, FULL_PERMISSIONS, EMPTY_PERMISSIONS } = require('../utils/seedAdmin');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} :: ${err.message}`);
    process.exitCode = 1;
  }
};

check('normalizes case and surrounding whitespace', () => {
  assert.strictEqual(normalizeEmail('  Admin@Example.COM '), 'admin@example.com');
});

check('email lookup is exact but case-insensitive', () => {
  const query = emailLookup(' Admin+test@Example.com ');
  assert.strictEqual(query.email.$options, 'i');
  assert.strictEqual(query.email.$regex, '^admin\\+test@example\\.com$');
});

check('the exported permission sets are complete', () => {
  assert.deepStrictEqual(Object.keys(FULL_PERMISSIONS).sort(), [
    'deleteUsers', 'manageRequests', 'manageResumes', 'manageSettings', 'manageUsers', 'viewAudit',
  ]);
  assert.ok(Object.values(FULL_PERMISSIONS).every((v) => v === true));
  assert.ok(Object.values(EMPTY_PERMISSIONS).every((v) => v === false));
});

// The bootstrap calls User.find(...).select('+password') for the leader set and
// User.findOne(...).select('+password') for the configured owner.
const originalFind = User.find;
const originalFindOne = User.findOne;
const originalCreate = User.create;

const query = (value) => ({ select: async () => value });

const ENV_KEYS = ['INITIAL_ADMIN_EMAIL', 'INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_NAME'];
const originalEnv = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

const resetEnv = (values = {}) => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
};

const fakeUser = (overrides = {}) => ({
  _id: 'existing-id',
  email: 'admin@example.com',
  role: 'user',
  isActive: true,
  suspendedAt: null,
  suspendReason: '',
  adminPermissions: {},
  adminApprovedAt: null,
  adminApprovedBy: null,
  adminTokenVersion: 0,
  mustChangePassword: true,
  password: 'hash',
  saved: false,
  matches: false,
  matchPassword: async function matchPassword() { return this.matches; },
  async save() { this.saved = true; },
  ...overrides,
});

const main = async () => {
  // ---- create when nothing exists ------------------------------------------
  resetEnv({
    INITIAL_ADMIN_EMAIL: ' Admin@Example.com ',
    INITIAL_ADMIN_PASSWORD: 'temporary-password',
    INITIAL_ADMIN_NAME: 'Main Admin',
  });

  let created = null;
  User.find = () => query([]);
  User.findOne = () => query(null);
  User.create = async (payload) => { created = payload; return payload; };

  const createdResult = await bootstrapMainAdmin();
  check('bootstrap creates the configured owner when nothing exists', () => {
    assert.strictEqual(createdResult.created, true);
    assert.strictEqual(created.email, 'admin@example.com'); // normalized
    assert.strictEqual(created.role, 'main_admin');
    assert.strictEqual(created.isActive, true);
    assert.strictEqual(created.password, 'temporary-password'); // hashed by the MODEL
    assert.ok(created.adminApprovedAt instanceof Date);
    assert.strictEqual(created.mustChangePassword, false);
    assert.ok(Object.keys(FULL_PERMISSIONS).every((k) => created.adminPermissions[k] === true));
  });

  // ---- the configured owner already exists as an ordinary account ----------
  // No recovery flag: the configured owner is repaired in place, keeping _id.
  resetEnv({
    INITIAL_ADMIN_EMAIL: 'admin@example.com',
    INITIAL_ADMIN_PASSWORD: 'temporary-password',
  });

  const ordinaryOwner = fakeUser({ email: 'ADMIN@example.com', matches: false });
  let createCalled = false;
  User.find = () => query([]); // nobody is a leader yet
  User.findOne = (filter) => {
    assert.strictEqual(filter.email.$options, 'i');
    return query(ordinaryOwner);
  };
  User.create = async () => { createCalled = true; };

  const adopted = await bootstrapMainAdmin();
  check('an existing ordinary account at the configured owner email is adopted, never recreated', () => {
    assert.strictEqual(createCalled, false);
    assert.strictEqual(adopted.promoted, true);
    assert.strictEqual(ordinaryOwner.saved, true);
    assert.strictEqual(ordinaryOwner._id, 'existing-id');
    assert.strictEqual(ordinaryOwner.role, 'main_admin');
    assert.strictEqual(ordinaryOwner.isActive, true);
    assert.strictEqual(ordinaryOwner.mustChangePassword, false);
    assert.ok(ordinaryOwner.adminApprovedAt instanceof Date);
    assert.ok(Object.keys(FULL_PERMISSIONS).every((k) => ordinaryOwner.adminPermissions[k] === true));
    assert.ok(adopted.repaired.includes('role'));
  });

  // ---- an already valid leader is a NO-OP (no password churn) --------------
  const healthyLeader = fakeUser({
    role: 'main_admin',
    mustChangePassword: false,
    adminApprovedAt: new Date('2026-01-01T00:00:00Z'),
    adminPermissions: { ...FULL_PERMISSIONS },
    matches: true,
  });
  User.find = () => query([healthyLeader]);
  User.findOne = () => query(healthyLeader);

  const ready = await bootstrapMainAdmin();
  check('a healthy leader is left untouched (password never rewritten on restart)', () => {
    assert.strictEqual(ready.created, false);
    assert.strictEqual(ready.passwordSynced, false);
    assert.strictEqual(ready.repaired, undefined);
    assert.strictEqual(healthyLeader.saved, false);
    assert.strictEqual(healthyLeader.password, 'hash');
  });

  // ---- a drifted password is restored to the configured value --------------
  const drifted = fakeUser({
    role: 'main_admin',
    mustChangePassword: false,
    adminApprovedAt: new Date('2026-01-01T00:00:00Z'),
    adminPermissions: { ...FULL_PERMISSIONS },
    matches: false,
  });
  User.find = () => query([drifted]);
  User.findOne = () => query(drifted);

  const synced = await bootstrapMainAdmin();
  check('a drifted password is restored from INITIAL_ADMIN_PASSWORD (bcrypt on save)', () => {
    assert.strictEqual(synced.passwordSynced, true);
    assert.strictEqual(synced.repaired.includes('password'), true);
    assert.strictEqual(drifted.password, 'temporary-password'); // the MODEL hashes it
    assert.strictEqual(drifted.saved, true);
  });

  // ---- a different leader is demoted; the owner becomes the single leader --
  const oldLeader = fakeUser({
    _id: 'old-leader-id',
    email: 'old-leader@example.com',
    role: 'main_admin',
    mustChangePassword: false,
    adminPermissions: { ...FULL_PERMISSIONS },
    adminApprovedAt: new Date('2025-01-01T00:00:00Z'),
  });
  const newOwner = fakeUser({ _id: 'owner-id', email: 'admin@example.com', role: 'user', matches: true });

  User.find = () => query([oldLeader]);
  User.findOne = () => query(newOwner);

  const transferred = await bootstrapMainAdmin();
  check('only the configured owner can hold main_admin; the previous leader is demoted, record kept', () => {
    assert.strictEqual(transferred.demoted.length, 1);
    assert.strictEqual(transferred.promoted, true);
    assert.strictEqual(oldLeader.role, 'user');
    assert.strictEqual(oldLeader._id, 'old-leader-id'); // record preserved
    assert.strictEqual(oldLeader.isActive, true);
    assert.ok(Object.values(oldLeader.adminPermissions).every((v) => v === false));
    assert.strictEqual(oldLeader.adminApprovedAt, null);
    assert.ok(oldLeader.adminTokenVersion >= 1); // prior admin session revoked
    assert.strictEqual(newOwner.role, 'main_admin');
    assert.strictEqual(newOwner.isActive, true);
  });

  // ---- a non-owner ordinary account is never promoted ----------------------
  // The bootstrap only ever looks up INITIAL_ADMIN_EMAIL, so a different ordinary
  // account cannot reach the main_admin role through this path.
  resetEnv({
    INITIAL_ADMIN_EMAIL: 'admin@example.com',
    INITIAL_ADMIN_PASSWORD: 'temporary-password',
  });
  let createdPayload = null;
  User.find = () => query([]);
  User.findOne = (filter) => {
    assert.strictEqual(filter.email.$regex, '^admin@example\\.com$');
    return query(null);
  };
  User.create = async (payload) => { createdPayload = payload; return payload; };

  await bootstrapMainAdmin();
  check('a non-owner ordinary account is never promoted', () => {
    assert.strictEqual(createdPayload.email, 'admin@example.com');
    assert.strictEqual(createdPayload.role, 'main_admin');
  });
};

main()
  .catch((err) => {
    console.error(`FAIL  bootstrap contract :: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    User.find = originalFind;
    User.findOne = originalFindOne;
    User.create = originalCreate;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    console.log(`RESULTS: ${passed} passed`);
  });
