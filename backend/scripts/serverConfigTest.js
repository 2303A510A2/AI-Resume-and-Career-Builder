// Offline checks for production-sensitive Express configuration.
// Run: node scripts/serverConfigTest.js
/* eslint-disable no-console */

const { app } = require('../server');
const { errorHandler } = require('../middleware/errorMiddleware');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (condition) pass += 1;
  else fail += 1;
};

check('Render trusts exactly one reverse-proxy hop', app.get('trust proxy') === 1);

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
