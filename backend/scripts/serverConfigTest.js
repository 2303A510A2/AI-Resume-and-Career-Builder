// Offline checks for production-sensitive Express configuration.
// Run: node scripts/serverConfigTest.js
/* eslint-disable no-console */

const { app } = require('../server');
const { errorHandler } = require('../middleware/errorMiddleware');
const { missingAuthSecrets, validateAuthConfig } = require('../utils/authConfig');
const { generateToken, generateResetToken } = require('../utils/generateToken');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (condition) pass += 1;
  else fail += 1;
};

check('Render trusts exactly one reverse-proxy hop', app.get('trust proxy') === 1);
check(
  'missing authentication secrets are identified by exact variable name',
  missingAuthSecrets({ JWT_SECRET: '', JWT_RESET_SECRET: 'present' }).join(',') === 'JWT_SECRET'
);
check(
  'complete authentication configuration validates',
  validateAuthConfig({ JWT_SECRET: 'secret', JWT_RESET_SECRET: 'reset-secret' }) === true
);
try {
  validateAuthConfig({ JWT_SECRET: '', JWT_RESET_SECRET: '' });
  check('missing authentication configuration is rejected', false);
} catch (err) {
  check(
    'missing authentication configuration is rejected safely',
    err.code === 'AUTH_CONFIG_MISSING'
      && err.message.includes('JWT_SECRET')
      && err.message.includes('JWT_RESET_SECRET')
      && !err.message.includes('secretOrPrivateKey')
  );
}

const originalJwtSecret = process.env.JWT_SECRET;
const originalResetSecret = process.env.JWT_RESET_SECRET;
const testUser = { _id: '000000000000000000000001', role: 'user' };
try {
  delete process.env.JWT_SECRET;
  delete process.env.JWT_RESET_SECRET;
  let tokenError;
  try { generateToken(testUser); } catch (err) { tokenError = err; }
  check('access-token signing rejects a missing JWT_SECRET', tokenError && tokenError.code === 'AUTH_CONFIG_MISSING');

  process.env.JWT_SECRET = 'test-access-secret';
  let resetError;
  try { generateResetToken(testUser); } catch (err) { resetError = err; }
  check('reset-token signing rejects a missing JWT_RESET_SECRET', resetError && resetError.code === 'AUTH_CONFIG_MISSING');
} finally {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalResetSecret === undefined) delete process.env.JWT_RESET_SECRET;
  else process.env.JWT_RESET_SECRET = originalResetSecret;
}

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const response = makeResponse();
errorHandler(new Error('simulated internal failure'), {}, response, () => {});
check(
  'server errors return a JSON 500 response',
  response.statusCode === 500
    && response.body
    && response.body.success === false
    && response.body.message === 'Something went wrong'
);

console.log(`\nserverConfigTest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
