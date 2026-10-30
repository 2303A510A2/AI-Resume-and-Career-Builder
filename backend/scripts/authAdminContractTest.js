// Offline authentication/admin regression checks.
// Run: node scripts/authAdminContractTest.js
/* eslint-disable no-console */

const assert = require('assert');
const User = require('../models/User');
const { emailLookup, normalizeEmail } = require('../utils/validators');
const { bootstrapMainAdmin } = require('../utils/seedAdmin');

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

const originalFindOne = User.findOne;
const originalCreate = User.create;
const originalEnv = {
  INITIAL_ADMIN_EMAIL: process.env.INITIAL_ADMIN_EMAIL,
  INITIAL_ADMIN_PASSWORD: process.env.INITIAL_ADMIN_PASSWORD,
  INITIAL_ADMIN_NAME: process.env.INITIAL_ADMIN_NAME,
};

const restore = () => {
  User.findOne = originalFindOne;
  User.create = originalCreate;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

process.env.INITIAL_ADMIN_EMAIL = 'admin@example.com';
process.env.INITIAL_ADMIN_PASSWORD = 'temporary-password';
process.env.INITIAL_ADMIN_NAME = 'Main Admin';

let saveCalled = false;
let lookupCount = 0;
User.findOne = async () => {
  lookupCount += 1;
  if (lookupCount === 1) return null;
  return {
    email: 'ADMIN@EXAMPLE.COM',
    role: 'user',
    save: async () => { saveCalled = true; },
  };
};
User.create = async () => {
  throw new Error('create must not run when the bootstrap email is already in use');
};

bootstrapMainAdmin()
  .then((result) => {
    check('bootstrap does not promote or reset an existing ordinary account', () => {
      assert.strictEqual(result.reason, 'email-in-use');
      assert.strictEqual(saveCalled, false);
    });

    let created;
    User.findOne = async () => null;
    User.create = async (payload) => {
      created = payload;
      return payload;
    };

    return bootstrapMainAdmin().then((createdResult) => {
      check('bootstrap creates a new main admin with forced password change', () => {
        assert.strictEqual(createdResult.created, true);
        assert.strictEqual(created.role, 'main_admin');
        assert.strictEqual(created.mustChangePassword, true);
        assert.strictEqual(created.email, 'admin@example.com');
      });
    });
  })
  .catch((err) => {
    console.error(`FAIL  bootstrap contract :: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    restore();
    console.log(`RESULTS: ${passed} passed`);
  });
