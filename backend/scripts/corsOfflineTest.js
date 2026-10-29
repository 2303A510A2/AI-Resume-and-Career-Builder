// Regression test for the "Backend server is offline" bug — the CORS variant.
//
// THE BUG
//   The backend's development CORS rule allowed only origins whose hostname was
//   literally `localhost` or `127.0.0.1`. Every other way of reaching the SAME
//   development machine — `http://<pc-name>:5173`, `http://192.168.x.x:5173`,
//   `http://anything.localhost:5500` — was rejected with 403 ON THE PREFLIGHT.
//
//   A browser hides a blocked preflight from JavaScript: `fetch` rejects with a
//   bare `TypeError: Failed to fetch` and NO response object, which is
//   byte-for-byte identical to "the server is not running". The frontend then
//   reported "Backend server is offline" for requests this process had actually
//   received and answered — the reported symptom, on a fully healthy backend
//   (GET /api/health answering 200 from every non-browser client).
//
// WHAT THIS TEST PROVES
//   1. An origin that points at this machine or a private LAN is ALLOWED, so the
//      request is never blocked in the first place.
//   2. A genuinely foreign origin is still REJECTED — the fix is not "*".
//   3. The verdict is derived from the ORIGIN, never from the AI provider, the
//      database or an authenticated session.
//   4. A denied origin is invisible to a browser (no ACAO => the browser throws
//      the response away and JS sees the same bare error a dead port produces),
//      so "offline" is only ever claimed after probes on TWO different origins —
//      and both frontends are asserted to do exactly that.
//   5. A real, reachable backend answers 200 on a normal GET /api/health.
//
// Runs entirely offline: no MongoDB, no AI key, no network.
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 54322; // deliberately unused
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET /api/health with an explicit Origin; returns the status or null. */
async function healthWithOrigin(origin) {
  try {
    const res = await fetch(`${BASE}/api/health`, { headers: { Origin: origin } });
    return res.status;
  } catch {
    return null;
  }
}

/** The preflight a browser actually sends for an authenticated JSON POST. */
async function preflight(origin) {
  try {
    const res = await fetch(`${BASE}/api/ai/career-assistant`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    return res.status;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await healthWithOrigin('http://localhost:5173');
    if (status === 200) return true;
    await sleep(300);
  }
  return false;
}

const main = async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGO_URI: 'mongodb://127.0.0.1:27099/offline-cors-test',
      MONGODB_URI: 'mongodb://127.0.0.1:27099/offline-cors-test',
      LLM_API_KEY: '',
      // Make the allowlist deterministic: no machine-specific entries.
      CLIENT_URL: '',
      FRONTEND_URL: '',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  try {
    const up = await waitForHealth();
    if (!up) {
      check('backend started and answered GET /api/health', false, log.slice(-600));
      return;
    }
    check('backend started and answered GET /api/health', true);

    // ---- 1. The exact origins that used to be rejected with 403 -------------
    const host = String(os.hostname() || '').toLowerCase();
    const mustAllow = [
      ['http://localhost:5173', 'the documented dev origin'],
      ['http://127.0.0.1:5173', 'IPv4 loopback'],
      ['http://localhost:5500', 'VS Code Live Server'],
      ['http://127.0.0.1:5500', 'IPv4 Live Server'],
      ['http://legacy.localhost:5173', 'an *.localhost alias of this machine'],
      ['http://app.localhost:5500', 'another *.localhost alias'],
      ['http://192.168.1.50:5173', 'a private LAN address'],
      ['http://10.0.0.7:5173', 'a private LAN address'],
      ['http://172.20.3.4:5173', 'a private LAN address'],
    ];
    if (host) mustAllow.push([`http://${host}:5173`, "this machine's own hostname"]);
    if (host) {
      const short = host.split('.')[0];
      if (short && short !== host) mustAllow.push([`http://${short}:5173`, 'the short hostname']);
    }

    for (const [origin, why] of mustAllow) {
      const status = await healthWithOrigin(origin);
      check(`allows ${origin} (${why})`, status === 200, `got ${status}`);
    }

    // The preflight is what actually blocked the browser.
    for (const origin of ['http://legacy.localhost:5173', 'http://192.168.1.50:5173']) {
      const status = await preflight(origin);
      check(`allows the CORS preflight from ${origin}`, status === 204 || status === 200, `got ${status}`);
    }

    // ---- 2. Still NOT "*": foreign origins are refused ----------------------
    for (const origin of ['https://evil.example.com', 'https://attacker.test', 'http://8.8.8.8:5173']) {
      const status = await healthWithOrigin(origin);
      check(`refuses foreign origin ${origin}`, status === 403, `got ${status}`);
    }

    // ---- 3. The verdict comes from the origin, nothing else ----------------
    const { isLocalDevOrigin } = require(path.join(ROOT, 'server.js'));
    check('isLocalDevOrigin: LAN IP is local', isLocalDevOrigin('http://192.168.1.50:5173') === true);
    check('isLocalDevOrigin: *.localhost is local', isLocalDevOrigin('http://x.localhost:1') === true);
    check('isLocalDevOrigin: public IP is NOT local', isLocalDevOrigin('http://8.8.8.8:5173') === false);
    check('isLocalDevOrigin: public host is NOT local', isLocalDevOrigin('https://example.com') === false);
    check('isLocalDevOrigin: a non-HTTP scheme is NOT local', isLocalDevOrigin('ftp://localhost') === false);
    check('isLocalDevOrigin: garbage is NOT local', isLocalDevOrigin('not-a-url') === false);

    // ---- 4. A denied origin is INVISIBLE to the browser --------------------
    // This is the mechanism behind the bug report, asserted from the only side
    // that can be observed without a browser.
    //
    // Node's `fetch` deliberately does NOT enforce CORS, so it happily returns
    // the 403 body here. A BROWSER does enforce it, and what it acts on is the
    // ABSENCE of `Access-Control-Allow-Origin`: with no ACAO the browser discards
    // the response entirely and hands JavaScript a bare `TypeError: Failed to
    // fetch` with no status and no body — the identical shape produced by a
    // refused connection to a port where nothing is listening. So the backend
    // contract to assert is "denial must carry no ACAO", and the frontend
    // contract is "offline requires two probes on two different origins".
    const deniedRes = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example.com' } });
    const deniedAcao = deniedRes.headers.get('access-control-allow-origin');
    check('a denied origin gets NO Access-Control-Allow-Origin', deniedAcao === null, `ACAO=${deniedAcao}`);
    check('...so the browser hides the 403 completely (no status reaches JS)', deniedRes.status === 403);

    const allowedRes = await fetch(`${BASE}/api/health`, { headers: { Origin: 'http://legacy.localhost:5173' } });
    check(
      'an allowed origin gets its own ACAO echoed back',
      allowedRes.headers.get('access-control-allow-origin') === 'http://legacy.localhost:5173',
      `ACAO=${allowedRes.headers.get('access-control-allow-origin')}`
    );
    check(
      'credentials stay enabled (no wildcard origin with credentials)',
      allowedRes.headers.get('access-control-allow-credentials') === 'true'
    );

    // A genuinely dead port, for contrast: nothing answers at all.
    const deadPort = await fetch('http://127.0.0.1:54399/api/health')
      .then(() => 'answered')
      .catch((e) => `rejected:${e.name}`);
    check('a dead port produces no response at all (control)', deadPort.startsWith('rejected'), deadPort);

    // The frontend half of the contract, checked against the real source so it
    // cannot silently regress.
    const fs = require('node:fs');
    const careerAssistant = fs.readFileSync(
      path.join(ROOT, '..', 'frontend', 'src', 'pages', 'CareerAssistant.jsx'),
      'utf8'
    );
    check(
      'React chat uses the CORS-free probe before claiming the backend is offline',
      /getHealthSameOrigin/.test(careerAssistant) && /Promise\.all\(\s*\[\s*getHealthResilient\(\)/.test(careerAssistant)
    );
    check(
      'React chat only says "offline" when BOTH probes fail',
      /if \(direct\.reachable \|\| sameOrigin\.reachable\)/.test(careerAssistant) &&
        /Backend server is offline/.test(careerAssistant)
    );
    const healthService = fs.readFileSync(
      path.join(ROOT, '..', 'frontend', 'src', 'services', 'healthService.js'),
      'utf8'
    );
    check('the CORS-free probe really is same-origin', /fetch\('\/api\/health'/.test(healthService));

    const legacy = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'index.html'), 'utf8');
    check(
      'the legacy page also uses two probes before claiming the backend is offline',
      /function confirmBackendOffline\(\)/.test(legacy) &&
        /if \(direct\.reachable \|\| sameOrigin\.reachable\) return \{ offline: false/.test(legacy)
    );
    check(
      'the legacy page distinguishes "browser blocked it" from "backend offline"',
      /backendBlockedText/.test(legacy) && /backendConfirmedOffline === false/.test(legacy)
    );

    // The dev server must never rewrite API traffic to an HTML document.
    const viteConfig = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'vite.config.js'), 'utf8');
    check(
      'the Vite SPA rewrite skips /api (otherwise the proxy is dead)',
      /clean === '\/api' \|\| clean\.startsWith\('\/api\/'\)\)\s*return null;/.test(viteConfig)
    );

    // ---- 5. A healthy backend still answers normally -----------------------
    const health = await fetch(`${BASE}/api/health`);
    const body = await health.json();
    check('GET /api/health returns 200 JSON', health.status === 200 && body.status === 'ok');
    check('health payload never leaks a key', !JSON.stringify(body).match(/gsk_|AI_API_KEY/i));

    // ---- 6. The AI request logging must be opt-in and token-safe ----------
    const logFlagged = /AI request logging: ON/.test(log);
    check('AI request logging is OFF unless explicitly enabled', logFlagged === false, `flagged=${logFlagged}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    if (!child.killed) child.kill('SIGKILL');
  }

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});