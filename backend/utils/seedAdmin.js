const User = require('../models/User');
const { emailLookup } = require('./validators');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FULL_PERMISSIONS = Object.freeze({
  manageUsers: true,
  deleteUsers: true,
  manageResumes: true,
  manageRequests: true,
  viewAudit: true,
  manageSettings: true,
});

const EMPTY_PERMISSIONS = Object.freeze({
  manageUsers: false,
  deleteUsers: false,
  manageResumes: false,
  manageRequests: false,
  viewAudit: false,
  manageSettings: false,
});

const hasFullPermissions = (perms) =>
  !!perms && Object.keys(FULL_PERMISSIONS).every((key) => perms[key] === true);

const safeEmail = (value) => String(value || '').trim().toLowerCase();

/**
 * Idempotent, owner-authoritative bootstrap of the single Main Admin Leader.
 *
 * CONTRACT
 *  - The account is identified ONLY by INITIAL_ADMIN_EMAIL. No caller-supplied
 *    value can select it, and no other account can ever become the leader.
 *  - Credentials come ONLY from backend environment variables (local `.env` for
 *    development, Render environment variables in production). They are never
 *    hardcoded, committed, returned by an API, or logged.
 *  - The password is hashed by the User model's existing bcrypt pre-save hook.
 *    A plaintext password is never persisted.
 *  - The configured password is VERIFIED first and rewritten only when it does
 *    not already match. A restart/deploy therefore never churns the hash, and it
 *    also guarantees the operator can always sign in with the configured value
 *    (rotate it by changing the env var, then restart/redeploy).
 *  - The configured owner is the ONLY account allowed to hold `main_admin`. If a
 *    different account still has the role, it is demoted to an ordinary user
 *    (`role=user`, no admin permissions/approval, admin sessions revoked). Its
 *    record, profile, resumes and chats are preserved — nothing is deleted.
 *  - The owner account is created when missing, and otherwise repaired in place:
 *    `_id`, profile and all data are kept. Role, active/suspension state, full
 *    permissions and `adminApprovedAt` are made valid. There is exactly ONE
 *    leader after every run.
 *  - `mustChangePassword` is NOT forced for the env-managed owner, because the
 *    operator already controls that credential through the environment; forcing
 *    a UI change would be silently reverted by the next deployment. Co-admins
 *    approved through the UI still get the forced-change gate.
 *
 * Safe logs only: emails, roles and repair names — never passwords, hashes,
 * tokens or provider keys.
 */
const bootstrapMainAdmin = async () => {
  const email = safeEmail(process.env.INITIAL_ADMIN_EMAIL || process.env.ADMIN_EMAIL);
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.INITIAL_ADMIN_NAME || process.env.ADMIN_NAME || 'Main Admin Leader').trim();

  if (!email || !password) {
    console.log('ℹ️  Main Admin Leader bootstrap skipped — set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD in the backend environment.');
    return { created: false, reason: 'not-configured' };
  }
  if (!VALID_EMAIL.test(email)) {
    console.warn('⚠️  Main Admin Leader bootstrap skipped — INITIAL_ADMIN_EMAIL is not a valid email.');
    return { created: false, reason: 'invalid-email' };
  }
  if (password.length < 6) {
    console.warn('⚠️  Main Admin Leader bootstrap skipped — INITIAL_ADMIN_PASSWORD must be at least 6 characters.');
    return { created: false, reason: 'weak-password' };
  }

  // ---- 1. Enforce "exactly one leader, and it is the configured owner" ----
  const leaders = await User.find({ role: 'main_admin' }).select('+password');
  let owner = leaders.find((doc) => safeEmail(doc.email) === email) || null;
  if (!owner) owner = await User.findOne(emailLookup(email)).select('+password');

  const demoted = [];
  for (const leader of leaders) {
    if (owner && String(leader._id) === String(owner._id)) continue;

    leader.role = 'user';
    leader.adminPermissions = { ...EMPTY_PERMISSIONS };
    leader.adminApprovedAt = null;
    leader.adminApprovedBy = null;
    leader.mustChangePassword = false;
    // Revoke every administrator token issued to the previous leader.
    leader.adminTokenVersion = Number(leader.adminTokenVersion || 0) + 1;
    await leader.save();
    demoted.push(safeEmail(leader.email));
    console.warn(`⚠️  Demoted previous Main Admin Leader ${leader.email} to an ordinary user (record and data preserved).`);
  }

  // ---- 2. No account for the configured owner yet: create it --------------
  if (!owner) {
    await User.create({
      name: name || 'Main Admin Leader',
      email,
      password, // hashed by the User model's bcrypt pre-save hook
      role: 'main_admin',
      mustChangePassword: false,
      isActive: true,
      adminPermissions: { ...FULL_PERMISSIONS },
      adminApprovedAt: new Date(),
    });
    console.log(`👑 Main Admin Leader created: ${email} (bcrypt hash; credential from INITIAL_ADMIN_PASSWORD).`);
    return { created: true, demoted };
  }

  // ---- 3. Repair the configured owner in place (never recreate the record) -
  const repairs = [];
  const adopted = owner.role !== 'main_admin';

  if (adopted) {
    owner.role = 'main_admin';
    owner.adminApprovedBy = null;
    repairs.push('role');
  }
  if (owner.isActive === false) {
    owner.isActive = true;
    repairs.push('active');
  }
  if (owner.suspendedAt || owner.suspendReason) {
    owner.suspendedAt = null;
    owner.suspendReason = '';
    if (!repairs.includes('active')) repairs.push('suspension');
  }
  if (!hasFullPermissions(owner.adminPermissions)) {
    owner.adminPermissions = { ...FULL_PERMISSIONS };
    repairs.push('permissions');
  }
  if (!owner.adminApprovedAt) {
    owner.adminApprovedAt = new Date();
    repairs.push('approval');
  }
  if (adopted) {
    // A promotion is a privilege change: drop any admin token issued before it.
    owner.mustChangePassword = false;
    owner.adminTokenVersion = Number(owner.adminTokenVersion || 0) + 1;
  }

  // Verify BEFORE writing: an existing password that already matches is never
  // overwritten, but a deployment can always restore the operator's configured
  // credential when it has drifted (e.g. changed in the UI).
  let passwordSynced = false;
  let passwordMatches = false;
  try {
    passwordMatches = await owner.matchPassword(password);
  } catch {
    passwordMatches = false;
  }
  if (!passwordMatches) {
    owner.password = password; // hashed by the pre-save hook
    owner.adminTokenVersion = Number(owner.adminTokenVersion || 0) + 1;
    passwordSynced = true;
    repairs.push('password');
  }

  if (repairs.length) {
    await owner.save();
    console.log(`👑 Main Admin Leader verified and repaired: ${email} (${repairs.join(', ')}).`);
    return { created: false, promoted: adopted, repaired: repairs, passwordSynced, demoted };
  }

  console.log(`👑 Main Admin Leader ready: ${email} (role/active/approval verified; password from INITIAL_ADMIN_PASSWORD verified).`);
  return { created: false, existing: true, passwordSynced, demoted };
};

// Backward-compatible alias (server.js historically imported `seedAdmin`).
const seedAdmin = bootstrapMainAdmin;

module.exports = {
  bootstrapMainAdmin,
  seedAdmin,
  FULL_PERMISSIONS,
  EMPTY_PERMISSIONS,
  hasFullPermissions,
};
