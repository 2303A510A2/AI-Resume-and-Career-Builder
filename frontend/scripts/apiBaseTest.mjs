// Unit tests for the deployed-offline root-cause fix
// (frontend/src/services/apiBase.js).
// Run: node scripts/apiBaseTest.mjs      (no browser, no network, no backend)
//
// What this pins down (the deployed "Backend server is offline" root cause):
//   * production without any configured URL returns API_BASE_NOT_CONFIGURED —
//     it NEVER silently falls back to http://localhost:5000 (that fallback is
//     exactly what made the deployed page call localhost in the visitor's
//     browser and report "backend offline");
//   * a build-time VITE_API_URL wins everywhere and is used verbatim (trimmed);
//   * the window.APP_API_BASE runtime override is honored without a rebuild;
//   * development keeps its localhost defaults;
//   * isApiBaseConfigured() distinguishes a real URL from the sentinel/empty.
/* eslint-disable no-console */
import {
  resolveApiBase,
  isApiBaseConfigured,
  API_BASE_NOT_CONFIGURED,
} from '../src/services/apiBase.js';

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const PROD = { isDev: false, hostname: 'myapp.vercel.app' };
const DEV = { isDev: true, devBase: 'http://localhost:5000/api' };

// ---- 1. Production with NO URL configured ---------------------------------
{
  const base = resolveApiBase(PROD);
  check('production without VITE_API_URL => NOT_CONFIGURED (never localhost)', base === API_BASE_NOT_CONFIGURED, base);
  check('production default does not contain localhost', !String(base).includes('localhost'));
}

// ---- 2. VITE_API_URL wins in production and is trimmed --------------------
{
  const base = resolveApiBase({ ...PROD, envUrl: 'https://backend.onrender.com/api/' });
  check('VITE_API_URL used verbatim in production', base === 'https://backend.onrender.com/api', base);
}
{
  const base = resolveApiBase({ ...PROD, envUrl: 'https://backend.onrender.com/api///' });
  check('trailing slashes trimmed', base === 'https://backend.onrender.com/api', base);
}

// ---- 3. Runtime override (window.APP_API_BASE) ----------------------------
{
  const base = resolveApiBase({ ...PROD, runtimeBase: 'https://backend.onrender.com/api/' });
  check('window.APP_API_BASE honored without rebuild', base === 'https://backend.onrender.com/api', base);
}
{
  const base = resolveApiBase({ ...PROD, envUrl: '', runtimeBase: 'https://other.onrender.com/api' });
  check('runtime override used when envUrl empty', base === 'https://other.onrender.com/api', base);
}

// ---- 4. Development uses the caller-supplied devBase ----------------------
{
  const base = resolveApiBase(DEV);
  check('development devBase localhost => localhost:5000/api', base === 'http://localhost:5000/api', base);
}
{
  const base = resolveApiBase({ isDev: true, devBase: 'http://127.0.0.1:5000/api' });
  check('development devBase 127.0.0.1 => 127.0.0.1:5000/api', base === 'http://127.0.0.1:5000/api', base);
}
{
  // A dev page on a LAN/other hostname still gets the caller's dev base
  // (api.js picks localhost for non-loopback dev hostnames).
  const base = resolveApiBase({ isDev: true, devBase: 'http://localhost:5000/api' });
  check('development devBase localhost for other hostnames', base === 'http://localhost:5000/api', base);
}
{
  // VITE_API_URL still wins over the dev default.
  const base = resolveApiBase({ isDev: true, devBase: 'http://localhost:5000/api', envUrl: 'http://127.0.0.1:5000/api' });
  check('VITE_API_URL wins over dev localhost default', base === 'http://127.0.0.1:5000/api', base);
}
{
  // A dev build without a devBase (defensive; api.js always supplies one in
  // dev) falls back to the sentinel, never to a guessed URL.
  const base = resolveApiBase({ isDev: true });
  check('dev without devBase => NOT_CONFIGURED, not a guess', base === API_BASE_NOT_CONFIGURED, base);
}

// ---- 5. isApiBaseConfigured ------------------------------------------------
check('sentinel is not a configured base', isApiBaseConfigured(API_BASE_NOT_CONFIGURED) === false);
check('empty is not a configured base', isApiBaseConfigured('') === false);
check('undefined is not a configured base', isApiBaseConfigured(undefined) === false);
check('https URL is a configured base', isApiBaseConfigured('https://x.onrender.com/api') === true);
check('http localhost URL is a configured base', isApiBaseConfigured('http://localhost:5000/api') === true);

// ---- 6. Weird inputs cannot sneak localhost into production ----------------
for (const bad of [undefined, null, '', '   ', 'http://localhost:5000/api', 42]) {
  const base = resolveApiBase({ ...PROD, envUrl: bad });
  check(`prod envUrl=${JSON.stringify(bad)} never yields localhost`, base === API_BASE_NOT_CONFIGURED || !String(base).includes('localhost'), base);
}
{
  // A genuinely configured production URL is the ONLY thing allowed.
  const base = resolveApiBase({ ...PROD, envUrl: 'https://api.example.com' });
  check('prod with real envUrl uses it', base === 'https://api.example.com', base);
}

console.log(`\napiBaseTest: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All apiBase checks passed.');