// LIVE (MongoDB, no HTTP, no AI key) regression suite for the Main Admin
// Leader bootstrap. It proves the production contract end-to-end:
//
//   create -> adopt an existing ordinary owner account (no flag needed)
//   -> never promote a non-owner ordinary account
//   -> repair role/active/approval/permissions of the owner in place
//   -> restore a drifted password from INITIAL_ADMIN_PASSWORD (bcrypt)
//   -> never rehash a password that already matches (no churn per deploy)
//   -> demote any previous/different/duplicate leader, preserving its record
//   -> exactly ONE main_admin at all times
//   -> no password/hash ever appears in the bootstrap logs
//
// It runs against a THROWAWAY database (dbName=admin_bootstrap_test_<timestamp>)
// on the configured MongoDB server and drops only that database. It never touches
// the application database, existing users, or the real Main Admin Leader.
//
// Run: node scripts/adminBootstrapTest.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const assert = require('assert');
const mongoose = require('mongoose');

const BASE_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const TEST_DB = `admin_bootstrap_test_${Date.now()}`;

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail += 1;
    console.error(`FAIL  ${name} :: ${err.message}`);
  }
};

const ENV_KEYS = [
  'INITIAL_ADMIN_EMAIL', 'INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_NAME',
  'INITIAL_ADMIN_RECOVER', 'INITIAL_ADMIN_RESET_PASSWORD', 'INITIAL_ADMIN_TRANSFER_LEADER',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'ADMIN_RECOVER',
];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const setEnv = (values) => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
};
const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
};

// Capture console output so the suite can prove no credential leaks into logs.
let captured = [];
const originalLog = console.log;
const originalWarn = console.warn;
const captureStart = () => { captured = []; };
const captureStop = () => {
  const text = captured.join('\n');
  captured = [];
  return text;
};
const withCapture = async (fn) => {
  captureStart();
  const result = await fn();
  return { result, logs: captureStop() };
};

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const leaks = (logs, secrets) => {
  if (secrets.some((secret) => secret && logs.includes(secret))) return 'plaintext password present';
  if (/\$2[aby]\$/.test(logs)) return 'bcrypt hash present';
  return null;
};

const { bootstrapMainAdmin, FULL_PERMISSIONS } = require('../utils/seedAdmin');
let User;

const fullPermissions = (p) =>
  Object.keys(FULL_PERMISSIONS).every((k) => p && p[k] === true);

const main = async () => {
  if (!BASE_URI) {
    console.log('FAIL  MONGO_URI / MONGODB_URI is required (MongoDB must be reachable).');
    process.exit(1);
  }

  await mongoose.connect(BASE_URI, { dbName: TEST_DB, serverSelectionTimeoutMS: 8000 });
  User = require('../models/User');

  const stamp = Date.now();
  const EMAIL_OWNER = `owner_bootstrap_${stamp}@test.dev`;
  const EMAIL_OTHER = `other_leader_${stamp}@test.dev`;
  const EMAIL_BYSTANDER = `bystander_${stamp}@test.dev`;
  const INITIAL_PW = 'Init#Pass1';
  const EXISTING_PW = 'Existing#1';
  const CHANGED_PW = 'Changed#Pass2';
  const FORGOTTEN_PW = 'Forgotten#9';
  const SECRETS = [INITIAL_PW, EXISTING_PW, CHANGED_PW, FORGOTTEN_PW];

  try {
    // ======================================================================
    // 1. Create when nothing exists
    // ======================================================================
    console.log('\n=== 1. create the single Main Admin Leader ===');
    setEnv({
      INITIAL_ADMIN_EMAIL: EMAIL_OWNER,
      INITIAL_ADMIN_PASSWORD: INITIAL_PW,
      INITIAL_ADMIN_NAME: 'Owner Leader',
    });

    const created = await withCapture(() => bootstrapMainAdmin());
    await check('bootstrap creates the leader from INITIAL_ADMIN_EMAIL/PASSWORD', () => {
      assert.strictEqual(created.result.created, true);
    });
    await check('bootstrap log names the account but leaks no password/hash', () => {
      assert.ok(created.logs.includes(EMAIL_OWNER));
      assert.strictEqual(leaks(created.logs, SECRETS), null);
    });

    let owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    const ownerId = String(owner._id);
    const firstHash = owner.password;
    await check('created account has the main_admin role and is active', () => {
      assert.strictEqual(owner.role, 'main_admin');
      assert.strictEqual(owner.isActive, true);
    });
    await check('the env-managed owner is not forced through a password change', () => {
      assert.strictEqual(owner.mustChangePassword, false);
    });
    await check('created account has full Main Admin permissions and approval state', () => {
      assert.ok(fullPermissions(owner.adminPermissions));
      assert.ok(owner.adminApprovedAt);
    });
    await check('password is stored ONLY as a bcrypt hash', async () => {
      assert.ok(BCRYPT_HASH.test(owner.password), 'not a bcrypt hash');
      assert.notStrictEqual(owner.password, INITIAL_PW);
      assert.strictEqual(await owner.matchPassword(INITIAL_PW), true);
    });

    // Idempotency: run again with the same env. A deploy must not rehash.
    const second = await withCapture(() => bootstrapMainAdmin());
    const afterSecond = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('a restart creates NO duplicate and does NOT change the password hash', () => {
      assert.strictEqual(second.result.created, false);
      assert.strictEqual(second.result.existing, true);
      assert.strictEqual(second.result.passwordSynced, false);
      assert.strictEqual(afterSecond.password, firstHash);
      assert.strictEqual(leaks(second.logs, SECRETS), null);
    });
    await check('exactly one main_admin exists after repeated boots', async () => {
      assert.strictEqual(await User.countDocuments({ role: 'main_admin' }), 1);
    });

    // ======================================================================
    // 2. The configured owner already exists as an ordinary account
    // ======================================================================
    console.log('\n=== 2. adopt an existing ordinary owner account (no flag needed) ===');
    await User.deleteMany({});
    const existing = await User.create({
      name: 'Existing Owner',
      email: EMAIL_OWNER,
      password: EXISTING_PW,
      profile: { bio: 'owner data that must survive' },
    });
    const existingId = String(existing._id);

    setEnv({
      INITIAL_ADMIN_EMAIL: EMAIL_OWNER,
      INITIAL_ADMIN_PASSWORD: INITIAL_PW,
    });
    const adopted = await withCapture(() => bootstrapMainAdmin());
    owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('the configured owner account is adopted as main_admin', () => {
      assert.strictEqual(adopted.result.promoted, true);
      assert.strictEqual(owner.role, 'main_admin');
      assert.strictEqual(owner.isActive, true);
      assert.ok(fullPermissions(owner.adminPermissions));
      assert.ok(owner.adminApprovedAt);
    });
    await check('adoption preserves the SAME account (_id) and its data', () => {
      assert.strictEqual(String(owner._id), existingId);
      assert.strictEqual(owner.profile.bio, 'owner data that must survive');
    });
    await check('adoption sets the configured password as a bcrypt hash', async () => {
      assert.ok(BCRYPT_HASH.test(owner.password));
      assert.strictEqual(await owner.matchPassword(INITIAL_PW), true);
      assert.strictEqual(await owner.matchPassword(EXISTING_PW), false);
      assert.strictEqual(leaks(adopted.logs, SECRETS), null);
    });
    await check('adoption invalidates any pre-existing admin session version', () => {
      assert.ok(Number(owner.adminTokenVersion) >= 1);
    });

    const adoptedHash = owner.password;
    const rerun = await withCapture(() => bootstrapMainAdmin());
    owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('a redeploy of the adopted owner is a no-op (no duplicate, no rehash)', async () => {
      assert.strictEqual(rerun.result.created, false);
      assert.strictEqual(rerun.result.existing, true);
      assert.strictEqual(rerun.result.passwordSynced, false);
      assert.strictEqual(owner.password, adoptedHash);
      assert.strictEqual(await User.countDocuments({ role: 'main_admin' }), 1);
      assert.strictEqual(leaks(rerun.logs, SECRETS), null);
    });

    // ======================================================================
    // 3. A password changed outside the environment is restored on boot
    // ======================================================================
    console.log('\n=== 3. the Render/env password always works after a deployment ===');
    owner.password = CHANGED_PW;
    owner.mustChangePassword = false;
    await owner.save();
    const changedHash = (await User.findOne({ email: EMAIL_OWNER }).select('+password')).password;
    const afterChange = await withCapture(() => bootstrapMainAdmin());
    owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('a drifted password is restored to the configured value (bcrypt)', async () => {
      assert.strictEqual(afterChange.result.passwordSynced, true);
      assert.ok(afterChange.result.repaired.includes('password'));
      assert.notStrictEqual(owner.password, changedHash);
      assert.strictEqual(await owner.matchPassword(INITIAL_PW), true);
      assert.strictEqual(await owner.matchPassword(CHANGED_PW), false);
      assert.strictEqual(leaks(afterChange.logs, SECRETS), null);
    });
    await check('the next boot is a no-op again once the hash matches', async () => {
      const syncedHash = owner.password;
      const stable = await withCapture(() => bootstrapMainAdmin());
      owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
      assert.strictEqual(stable.result.passwordSynced, false);
      assert.strictEqual(owner.password, syncedHash);
    });

    // ======================================================================
    // 4. Repair role/active/approval/permissions, without touching the password
    // ======================================================================
    console.log('\n=== 4. repair a blocked or partially-provisioned leader ===');
    owner.isActive = false;
    owner.suspendedAt = new Date();
    owner.suspendReason = 'accidental block';
    owner.adminPermissions = { manageUsers: true };
    owner.adminApprovedAt = null;
    await owner.save();

    const repaired = await withCapture(() => bootstrapMainAdmin());
    owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('a blocked leader is reactivated and its suspension cleared', () => {
      assert.strictEqual(owner.isActive, true);
      assert.strictEqual(owner.suspendedAt, null);
      assert.strictEqual(owner.suspendReason, '');
    });
    await check('approval state and full permissions are restored', () => {
      assert.ok(owner.adminApprovedAt);
      assert.ok(fullPermissions(owner.adminPermissions));
      assert.ok(repaired.result.repaired.includes('active'));
      assert.ok(repaired.result.repaired.includes('permissions'));
      assert.ok(repaired.result.repaired.includes('approval'));
    });
    await check('repair does not reset a matching password', async () => {
      assert.strictEqual(await owner.matchPassword(INITIAL_PW), true);
      assert.ok(!repaired.result.repaired.includes('password'));
      assert.strictEqual(leaks(repaired.logs, SECRETS), null);
    });

    // A forgotten password (no longer matching the env value) self-heals.
    owner.password = FORGOTTEN_PW;
    await owner.save();
    const healed = await withCapture(() => bootstrapMainAdmin());
    owner = await User.findOne({ email: EMAIL_OWNER }).select('+password');
    await check('a forgotten leader password self-heals from INITIAL_ADMIN_PASSWORD', async () => {
      assert.strictEqual(healed.result.passwordSynced, true);
      assert.ok(BCRYPT_HASH.test(owner.password));
      assert.strictEqual(await owner.matchPassword(INITIAL_PW), true);
      assert.strictEqual(await owner.matchPassword(FORGOTTEN_PW), false);
      assert.strictEqual(leaks(healed.logs, SECRETS), null);
    });

    // ======================================================================
    // 5. A non-owner ordinary account is never promoted
    // ======================================================================
    console.log('\n=== 5. only the configured owner email can be the leader ===');
    await User.deleteMany({});
    const bystander = await User.create({
      name: 'Bystander',
      email: EMAIL_BYSTANDER,
      password: EXISTING_PW,
      role: 'user',
      mustChangePassword: false,
    });
    const bystanderId = String(bystander._id);

    setEnv({
      INITIAL_ADMIN_EMAIL: EMAIL_OWNER,
      INITIAL_ADMIN_PASSWORD: INITIAL_PW,
    });
    const fresh = await withCapture(() => bootstrapMainAdmin());
    const bystanderAfter = await User.findById(bystanderId).select('+password');
    await check('an existing non-owner account keeps role=user and its own password', async () => {
      assert.strictEqual(fresh.result.created, true);
      assert.strictEqual(bystanderAfter.role, 'user');
      assert.strictEqual(await bystanderAfter.matchPassword(EXISTING_PW), true);
      assert.strictEqual(await bystanderAfter.matchPassword(INITIAL_PW), false);
    });
    await check('the created leader is the configured owner, not the bystander', async () => {
      const leader = await User.findOne({ role: 'main_admin' });
      assert.strictEqual(leader.email, EMAIL_OWNER);
      assert.strictEqual(leaks(fresh.logs, SECRETS), null);
    });

    // ======================================================================
    // 6. A different (or duplicate) leader is demoted, never duplicated
    // ======================================================================
    console.log('\n=== 6. exactly one leader: any other main_admin is demoted ===');
    await User.deleteMany({});
    const oldLeader = await User.create({
      name: 'Old Leader',
      email: EMAIL_OTHER,
      password: EXISTING_PW,
      role: 'main_admin',
      adminPermissions: { ...FULL_PERMISSIONS },
      adminApprovedAt: new Date(),
      profile: { bio: 'old leader data' },
    });
    const oldId = String(oldLeader._id);
    const oldHash = (await User.findById(oldId).select('+password')).password;
    const duplicate = await User.create({
      name: 'Duplicate Leader',
      email: `duplicate_${stamp}@test.dev`,
      password: EXISTING_PW,
      role: 'main_admin',
    });
    await User.create({ name: 'Third Owner', email: EMAIL_OWNER, password: EXISTING_PW });

    setEnv({
      INITIAL_ADMIN_EMAIL: EMAIL_OWNER,
      INITIAL_ADMIN_PASSWORD: INITIAL_PW,
    });
    const enforced = await withCapture(() => bootstrapMainAdmin());
    const oldAfter = await User.findById(oldId).select('+password');
    const duplicateAfter = await User.findById(duplicate._id);
    const newLeader = await User.findOne({ email: EMAIL_OWNER }).select('+password');

    await check('a different previous leader is demoted to an ordinary account (record + data kept)', async () => {
      assert.strictEqual(enforced.result.demoted.length, 2);
      assert.strictEqual(oldAfter.role, 'user');
      assert.strictEqual(String(oldAfter._id), oldId);
      assert.strictEqual(oldAfter.profile.bio, 'old leader data');
      assert.strictEqual(oldAfter.password, oldHash);
      assert.strictEqual(await oldAfter.matchPassword(EXISTING_PW), true);
      assert.strictEqual(fullPermissions(oldAfter.adminPermissions), false);
      assert.strictEqual(duplicateAfter.role, 'user');
    });
    await check('the configured owner becomes the single Main Admin Leader', async () => {
      assert.strictEqual(newLeader.role, 'main_admin');
      assert.strictEqual(await newLeader.matchPassword(INITIAL_PW), true);
      assert.strictEqual(await User.countDocuments({ role: 'main_admin' }), 1);
      assert.strictEqual(leaks(enforced.logs, SECRETS), null);
    });

    // ======================================================================
    // 7. Global invariants
    // ======================================================================
    console.log('\n=== 7. invariants ===');
    await check('every password in the database is a bcrypt hash, never plaintext', async () => {
      const all = await User.find({}).select('+password');
      assert.ok(all.length >= 3);
      for (const u of all) {
        assert.ok(BCRYPT_HASH.test(u.password), `${u.email} is not bcrypt-hashed`);
      }
    });
    await check('exactly one Main Admin Leader exists at the end', async () => {
      assert.strictEqual(await User.countDocuments({ role: 'main_admin' }), 1);
      const leader = await User.findOne({ role: 'main_admin' });
      assert.strictEqual(leader.email, EMAIL_OWNER);
    });
    await check('no bootstrap log ever contained a password or a bcrypt hash', () => {
      assert.strictEqual(leaks(captured.join('\n'), SECRETS), null);
    });
  } finally {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    restoreEnv();
  }

  console.log(`\nRESULTS: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
};

console.log = (...args) => {
  captured.push(args.map(String).join(' '));
  originalLog(...args);
};
console.warn = (...args) => {
  captured.push(args.map(String).join(' '));
  originalWarn(...args);
};

main().catch((err) => {
  originalLog(`FAIL  suite crashed :: ${err.message}`);
  process.exitCode = 1;
});
