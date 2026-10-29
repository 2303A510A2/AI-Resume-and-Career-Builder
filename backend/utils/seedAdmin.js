const User = require('../models/User');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FULL_PERMISSIONS = {
  manageUsers: true,
  deleteUsers: true,
  manageResumes: true,
  manageRequests: true,
  viewAudit: true,
  manageSettings: true,
};

/**
 * One-time bootstrap of the single Main Admin Leader.
 *
 * SECURITY
 *  - Credentials are read ONLY from backend environment variables — never from a
 *    client request, never hardcoded in frontend code.
 *  - The password is hashed by the User model's existing bcrypt pre-save hook.
 *  - Exactly ONE main_admin may exist. If one already exists the function is a
 *    no-op: it NEVER overwrites the account and NEVER resets the password on a
 *    server restart.
 *  - The initial password must be changed at first login (mustChangePassword).
 *  - The email comes from server-side env, so promoting a pre-existing account is
 *    an operator decision, not a client-supplied privilege escalation. It happens
 *    at most once (guarded by the single-main-admin check).
 */
const bootstrapMainAdmin = async () => {
  const email = String(process.env.INITIAL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.INITIAL_ADMIN_NAME || process.env.ADMIN_NAME || 'Main Admin Leader').trim();

  if (!email || !password) {
    console.log('ℹ️  Main Admin Leader bootstrap skipped — set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD in backend/.env.');
    return { created: false, reason: 'not-configured' };
  }
  if (!VALID_EMAIL.test(email)) {
    console.warn(`⚠️  Main Admin Leader bootstrap skipped — INITIAL_ADMIN_EMAIL is not a valid email.`);
    return { created: false, reason: 'invalid-email' };
  }
  if (password.length < 6) {
    console.warn('⚠️  Main Admin Leader bootstrap skipped — INITIAL_ADMIN_PASSWORD must be at least 6 characters.');
    return { created: false, reason: 'weak-password' };
  }

  // Guard: never create a second Main Admin Leader.
  const existingMain = await User.findOne({ role: 'main_admin' });
  if (existingMain) {
    if (String(existingMain.email).toLowerCase() !== email) {
      console.warn(`⚠️  A Main Admin Leader already exists (${existingMain.email}); NOT creating ${email}.`);
    } else {
      console.log(`👑 Main Admin Leader ready: ${existingMain.email}${existingMain.mustChangePassword ? ' (password change still required)' : ''}`);
    }
    return { created: false, existing: true };
  }

  // No Main Admin Leader yet. If the env email already belongs to an ordinary
  // account, promote it ONCE (server-side env only) and reset its password to the
  // configured initial password, forcing a change at first login.
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    existingUser.role = 'main_admin';
    existingUser.mustChangePassword = true;
    existingUser.password = password; // hashed by the pre-save hook
    existingUser.isActive = true;
    existingUser.adminPermissions = { ...FULL_PERMISSIONS };
    existingUser.suspendedAt = null;
    existingUser.suspendReason = '';
    await existingUser.save();
    console.log(`👑 Main Admin Leader bootstrapped from an existing account: ${email}`);
    console.log('   The initial password is set and MUST be changed at first login.');
    return { created: true, promoted: true };
  }

  await User.create({
    name: name || 'Main Admin Leader',
    email,
    password, // hashed by the pre-save hook
    role: 'main_admin',
    mustChangePassword: true,
    isActive: true,
    adminPermissions: { ...FULL_PERMISSIONS },
  });
  console.log(`👑 Main Admin Leader created: ${email} (initial password must be changed at first login).`);
  return { created: true };
};

// Backward-compatible alias (server.js historically imported `seedAdmin`).
const seedAdmin = bootstrapMainAdmin;

module.exports = { bootstrapMainAdmin, seedAdmin };
