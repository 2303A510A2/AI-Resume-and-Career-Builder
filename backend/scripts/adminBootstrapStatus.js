// Read-only inspection + optional repair of the Main Admin Leader account.
//
// This is the operator tool for a deployment where the Admin Sign In page says
// "Invalid email or password." It answers, without ever printing a credential:
//   - is INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD configured (names only)?
//   - does that email exist, and with which role/active/approval state?
//   - are the administrator permissions complete?
//   - is the stored password really bcrypt, and does the configured password
//     currently verify?
//   - how many main_admin accounts exist (must be exactly 1)?
//   - is the account HEALTHY for sign-in, or what exactly is missing?
//
// Default: READ-ONLY report (no writes, safe to run anywhere). It prints no
// password, no hash, no JWT and no provider key — only booleans, roles, emails
// and counts. Exit code is 0 only when the account is healthy, so it can gate a
// deployment check.
//
// Add --apply to run the exact same idempotent bootstrap as server startup
// (create / adopt / repair / demote, verify-then-write password).
//
// Run locally:        node scripts/adminBootstrapStatus.js [--apply]
// Render Shell:       node scripts/adminBootstrapStatus.js [--apply]
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const {
  bootstrapMainAdmin,
  hasFullPermissions,
} = require('../utils/seedAdmin');

// Same precedence as config/db.js: production uses MONGODB_URI, MONGO_URI is
// the local alias. Reading them in the opposite order could inspect the wrong
// database when both are present.
const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const APPLY = process.argv.includes('--apply');
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const safeEmail = (v) => String(v || '').trim().toLowerCase();

const baseUriInfo = () => {
  try {
    const parsed = new URL(URI);
    // Host only: never echo a username/password embedded in the URI.
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(unparseable MongoDB URI)';
  }
};

const main = async () => {
  const email = safeEmail(process.env.INITIAL_ADMIN_EMAIL || process.env.ADMIN_EMAIL);
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');

  console.log('── Main Admin Leader diagnostics ─────────────────────');
  console.log(`   INITIAL_ADMIN_EMAIL:    ${email || '(not set)'}`);
  console.log(`   INITIAL_ADMIN_PASSWORD: ${password ? 'configured' : '(not set)'}`);
  console.log(`   INITIAL_ADMIN_NAME:     ${process.env.INITIAL_ADMIN_NAME || process.env.ADMIN_NAME || '(default)'}`);
  console.log(`   MongoDB:                ${URI ? baseUriInfo() : '(not set)'}`);
  console.log(`   Node env:               ${process.env.NODE_ENV || 'development'}`);

  if (!URI) {
    console.log('❌ MONGO_URI / MONGODB_URI is not set — nothing to inspect.');
    process.exitCode = 1;
    return;
  }
  if (!email || !password) {
    console.log('⚠️  Bootstrap is NOT configured — provision the leader by setting INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD.');
  }

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`   Database:               ${mongoose.connection.name} @ ${mongoose.connection.host}`);

  const leaders = await User.find({ role: 'main_admin' }).select('email isActive mustChangePassword adminPermissions adminApprovedAt');
  console.log(`   main_admin accounts:    ${leaders.length}${leaders.length === 1 ? '' : '  <-- must be exactly 1'}`);
  for (const l of leaders) {
    console.log(`     - ${l.email} | active=${l.isActive !== false} | approved=${!!l.adminApprovedAt} | permissions=${hasFullPermissions(l.adminPermissions) ? 'full' : 'incomplete'}`);
  }

  const problems = [];
  if (!email) problems.push('INITIAL_ADMIN_EMAIL is not configured');
  if (!password) problems.push('INITIAL_ADMIN_PASSWORD is not configured');
  if (leaders.length !== 1) problems.push(`expected exactly 1 main_admin, found ${leaders.length}`);
  if (leaders.length === 1 && safeEmail(leaders[0].email) !== email) {
    problems.push(`the leader is ${leaders[0].email}, not the configured owner`);
  }

  if (email) {
    const owner = await User.findOne({ email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).select('+password');
    if (!owner) {
      console.log(`   ${email}: NO account exists yet${leaders.length ? ' (a different leader exists and will be demoted on the next bootstrap)' : ''}.`);
      problems.push('the configured owner account does not exist');
    } else {
      let matches = false;
      try {
        matches = password ? await owner.matchPassword(password) : false;
      } catch {
        matches = false;
      }
      const bcryptStored = BCRYPT_HASH.test(owner.password || '');
      console.log(`   ${email}: account EXISTS`);
      console.log(`     role=${owner.role} active=${owner.isActive !== false} mustChangePassword=${!!owner.mustChangePassword}`);
      console.log(`     adminApprovedAt=${owner.adminApprovedAt ? 'set' : 'not set'} permissions=${hasFullPermissions(owner.adminPermissions) ? 'full' : 'incomplete'}`);
      console.log(`     passwordIsBcrypt=${bcryptStored} configuredPasswordVerifies=${password ? matches : 'n/a (password not set)'}`);
      console.log(`     suspended=${owner.isActive === false || !!owner.suspendedAt}`);

      if (owner.role !== 'main_admin') problems.push('the configured owner is not the Main Admin Leader');
      if (owner.isActive === false) problems.push('the configured owner is inactive/blocked');
      if (!hasFullPermissions(owner.adminPermissions)) problems.push('the configured owner is missing admin permissions');
      if (!owner.adminApprovedAt) problems.push('the configured owner has no admin approval timestamp');
      if (!bcryptStored) problems.push('the stored password is not a bcrypt hash');
      if (password && !matches) problems.push('the configured INITIAL_ADMIN_PASSWORD does not verify');
    }
  }

  if (!APPLY) {
    if (problems.length) {
      console.log('\nVERDICT: UNHEALTHY');
      for (const p of problems) console.log(`   - ${p}`);
      console.log('Re-run with --apply to create/adopt/repair the account using the environment above.');
      process.exitCode = 1;
    } else {
      console.log(`\nVERDICT: HEALTHY — ${email} is the single Main Admin Leader and the configured password verifies.`);
    }
    await mongoose.disconnect();
    return;
  }

  console.log('\n── Applying idempotent bootstrap ─────────────────────');
  const result = await bootstrapMainAdmin();
  console.log('   result:', JSON.stringify(result));
  console.log('\nSign in at the deployed /admin/login page with INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD.');
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(`❌ Diagnostics failed: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
