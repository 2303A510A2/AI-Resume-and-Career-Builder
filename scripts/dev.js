#!/usr/bin/env node
/**
 * One-command local dev launcher: backend + frontend, supervised.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The root `npm run dev` used to be:
 *
 *     concurrently -n backend,frontend "npm --prefix backend run dev" \
 *                            "npm --prefix frontend run dev"
 *
 * `concurrently` was declared in root devDependencies but was never installed
 * (there is no root node_modules, and `npm run setup` did not install root deps
 * either). So `npm run dev` died instantly with "concurrently: not found", the
 * backend never bound port 5000, and every page reported
 * "Backend server is offline" — correctly, because nothing was listening.
 *
 * This script has ZERO dependencies (node:child_process + fetch only), so
 * `npm run dev` works on a fresh clone without `npm install` at the root.
 *
 * It also fixes the second half of the problem. The UI used to be able to report
 * the backend as offline for reasons that had nothing to do with the request it
 * made, so this launcher removes those causes instead of papering over them:
 *
 *   1. ORDER + PROOF — the backend starts FIRST and the launcher blocks on a REAL
 *      `GET http://localhost:5000/api/health` 200 before the frontend is started
 *      or reported ready. Nothing here is optimistic: a refused connection, a
 *      timeout or a non-200 all keep it waiting. If the API never answers, the
 *      frontend is NOT started and the reason is printed.
 *   2. SUPERVISION — BOTH services are restarted if they exit. Previously only
 *      the first backend child had an exit handler, so the launcher went deaf
 *      after one crash and a dead API stayed dead for the rest of the session.
 *   3. STALE-PORT DIAGNOSIS — an orphaned/duplicate backend holding port 5000 is
 *      named (with its PID) instead of silently serving old code, which is the
 *      classic cause of "I fixed it but nothing changed".
 *
 * Ctrl-C / SIGINT / SIGTERM shuts every child down.
 */
'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_PORT = Number(process.env.PORT || 5000);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 5173);
const HEALTH_URL = `http://localhost:${BACKEND_PORT}/api/health`;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}/`;
const HEALTH_TIMEOUT_MS = 60_000;
const POLL_MS = 400;

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const children = new Set();
let shuttingDown = false;

const colour = (code, s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const tag = (name, colourCode, line) => {
  const label = colour(colourCode, `[${name}]`.padEnd(10));
  process.stdout.write(`${label} ${line}\n`);
};

function run(name, colourCode, args, cwd) {
  // On Windows npm is a .cmd, which Node cannot exec without a shell. We build
  // ONE quoted command string rather than passing `args` alongside `shell: true`,
  // which is what triggers DEP0190. The arguments here are fixed literals, never
  // user input.
  const cmd = isWindows ? `${npmCmd} ${args.join(' ')}` : npmCmd;
  const spawnArgs = isWindows ? [] : args;
  const child = spawn(cmd, spawnArgs, {
    cwd: path.join(ROOT, cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    windowsHide: true,
    env: process.env,
  });
  children.add(child);

  const pipe = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) tag(name, colourCode, line);
    });
    stream.on('end', () => {
      if (buffer.trim()) tag(name, colourCode, buffer);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  return child;
}

/**
 * Starts one dev service and RESTARTS it whenever it exits unexpectedly.
 *
 * The exit handler is re-armed on every respawn, so supervision never goes deaf.
 * Restarting the FRONTEND matters just as much as the backend: a frontend that
 * dies once (port clash, OOM, a stray Ctrl-C in the wrong window) otherwise stays
 * dead for the whole session, leaving `npm run dev` running while
 * http://localhost:5173 answers nothing — which looks exactly like a broken app.
 */
function startService(name, colourCode, cwd, onRestart) {
  const spawnService = () => {
    const child = run(name, colourCode, ['run', 'dev'], cwd);
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      tag(name, 31, `exited (${signal || code}) — restarting in 2s …`);
      setTimeout(() => {
        if (shuttingDown) return;
        spawnService();
        if (onRestart) onRestart();
      }, 2000);
    });
    return child;
  };
  return spawnService();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Real readiness probe. Returns the parsed health payload on a genuine 200, or
 * null on any failure. It NEVER fabricates success.
 */
async function probeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBackend() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  process.stdout.write(colour(36, `\n⏳ Waiting for the backend API on ${HEALTH_URL} …\n`));
  while (Date.now() < deadline) {
    const health = await probeHealth();
    if (health) return health;
    await sleep(POLL_MS);
  }
  return null;
}

function reportReady(health) {
  const db = health.mongodb === 'connected' ? 'connected' : 'disconnected';
  process.stdout.write(
    '\n' +
      colour(32, '✅ Backend ONLINE  ') + colour(90, `http://localhost:${BACKEND_PORT}`) + '\n' +
      colour(32, '✅ Health 200     ') + colour(90, HEALTH_URL) + '\n' +
      colour(32, '✅ MongoDB        ') + colour(90, db) + '\n' +
      colour(32, '✅ AI provider    ') +
        colour(90, `${health.aiProvider}${health.services?.model ? ` (${health.services.model})` : ''}`) + '\n' +
      colour(32, '✅ Frontend        ') + colour(90, FRONTEND_URL) + '\n\n'
  );
}

/** Resolves the PID owning a TCP listening port, or null. Never throws. */
async function lookupPid(port) {
  try {
    const out = await new Promise((resolve, reject) => {
      const file = isWindows ? 'netstat' : 'sh';
      const args = isWindows ? ['-ano'] : ['-c', `lsof -i :${port} -sTCP:LISTEN -t || true`];
      execFile(file, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const lines = String(out).split(/\r?\n/);
    for (const line of lines) {
      if (!isWindows) return line.trim() || null;
      if (new RegExp(`[:.]${port}\\s`).test(line) && /LISTENING/i.test(line)) {
        const parts = line.trim().split(/\s+/);
        return parts[parts.length - 1] || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Names whatever already owns the API port.
 *
 * A duplicate or orphaned backend is the usual reason the port is busy, and the
 * point is to make it visible instead of quietly serving old code. Read-only and
 * non-blocking: an already-healthy backend is simply reported, because the UI
 * would otherwise connect to a stale copy and your edits would appear to do
 * nothing.
 */
async function reportPortOwner() {
  const healthy = (await probeHealth()) !== null;
  const pid = await lookupPid(BACKEND_PORT);
  if (!pid) return;

  if (healthy) {
    process.stdout.write(
      colour(
        33,
        `\n⚠️  Port ${BACKEND_PORT} is already served by PID ${pid}.\n` +
          '   A backend is already running here. If it is a stale copy of this project,\n' +
          `   stop it so your edited code actually loads:  taskkill /PID ${pid} /F\n`
      )
    );
    return;
  }

  process.stdout.write(
    colour(
      33,
      `\n⚠️  Port ${BACKEND_PORT} is held by PID ${pid}, which is not answering /api/health.\n` +
        '   This is almost always a duplicate/stale backend. Free it before continuing:\n' +
        `     taskkill /PID ${pid} /F        (Windows)\n` +
        `     kill ${pid}                   (macOS/Linux)\n`
    )
  );
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(isWindows ? undefined : 'SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  process.stdout.write('\n🛑 Stopping backend + frontend …\n');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

async function main() {
  process.stdout.write(colour(1, '\n▶ AI Resume & Career Builder — local development\n'));

  await reportPortOwner();

  // ---- 1. Backend first, and only announce it once it REALLY answers. ----
  startService('backend', 34, 'backend', async () => {
    const h = await waitForBackend();
    if (h) reportReady(h);
    else tag('backend', 31, `still not answering GET ${HEALTH_URL}`);
  });

  const health = await waitForBackend();
  if (!health) {
    process.stderr.write(
      colour(
        31,
        `\n❌ The backend did not answer GET ${HEALTH_URL} within ${HEALTH_TIMEOUT_MS / 1000}s.\n` +
          '   The UI would now show "Backend server is offline" — so the frontend is NOT started.\n' +
          '   Check the [backend] log above for the real reason (bad .env, MongoDB, port in use).\n\n'
      )
    );
    shutdown(1);
    return;
  }

  // ---- 2. Frontend, only after the API is provably up. ----
  startService('frontend', 35, 'frontend');
  reportReady(health);
}

main().catch((err) => {
  process.stderr.write(colour(31, `\n❌ dev launcher crashed: ${err && err.message ? err.message : err}\n`));
  shutdown(1);
});
