// Regression test for the "Backend server is offline" bug.
//
// THE BUG
//   server.js used to call process.exit(1) when the port was busy. Under the
//   documented `npm run dev` (nodemon) that puts nodemon into
//       "[nodemon] app crashed - waiting for file changes before starting..."
//   and it NEVER retries. The API stayed dead until a file happened to be saved,
//   so every request in that window — a plain "hi" included — failed to connect
//   and the UI reported "Backend server is offline".
//
// WHAT THIS TEST PROVES
//   Start the backend while something else already holds the port. The process
//   must NOT die. When the holder frees the port, the backend must bind it by
//   itself, with no file change and no manual restart.
//
// Runs entirely offline on an unused port; no MongoDB and no AI key needed.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 54321; // deliberately unused
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true when GET /api/health answers 200 within `timeoutMs`. */
async function waitForHealth(timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(HEALTH, { signal: controller.signal });
      clearTimeout(t);
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(intervalMs);
  }
  return false;
}

const main = async () => {
  // ---- 1. Occupy the port with a foreign holder (stale/duplicate backend) ----
  // Listen with NO host argument on purpose: that is how Express binds (the `::`
  // / all-interfaces socket). An IPv4-only squatter (`0.0.0.0`) does NOT conflict
  // with it on Windows — both sockets can coexist and the test would pass for the
  // wrong reason. Binding all interfaces reproduces the real EADDRINUSE.
  const squatter = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(PORT, resolve);
  });
  console.log(`\n[setup] foreign process is holding port ${PORT} (all interfaces)`);

  // ---- 2. Start the real backend on that busy port -------------------------
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // never touch the developer's real database for this test
      MONGO_URI: '',
      MONGODB_URI: '',
      NODE_ENV: 'test',
      PORT_BIND_MAX_ATTEMPTS: '60',
      PORT_BIND_RETRY_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });

  // Give it far longer than the bind-retry window to (wrongly) die.
  await sleep(6000);

  check('backend SURVIVES a busy port (the nodemon-crash bug)', !exited, exited ? `process exited with code ${exitCode}` : 'still running, retrying the bind');
  check('backend never printed the fatal "Cannot start" error', !/Cannot start/.test(out));
  check(
    'backend reported the busy port and that it will retry',
    /busy/i.test(out),
    /busy/i.test(out)
      ? (out.match(/.*busy.*/) || [''])[0].trim().slice(0, 120)
      : `no busy-port notice captured. Output was:\n----\n${out.slice(-1500)}\n----`
  );

  // ---- 3. Free the port; the backend must bind it by ITSELF ----------------
  await new Promise((resolve) => squatter.close(resolve));
  console.log(`[setup] foreign holder released port ${PORT}; waiting for the backend to bind it…`);

  const bound = await waitForHealth(30000);
  check('backend bound the port on its own once it freed', bound);
  check('backend reported the successful late bind', /became free|Backend running/i.test(out), (out.match(/.*(became free|Backend running).*/) || [''])[0].trim());
  check('backend served GET /api/health with 200', bound);

  if (child.exitCode == null) child.kill('SIGTERM');
  await sleep(500);
  if (child.exitCode == null) child.kill('SIGKILL');

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
