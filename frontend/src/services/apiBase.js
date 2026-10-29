// Framework-agnostic API-base resolution: no import.meta, no window, no axios.
// Pure enough for plain Node to import and test (see scripts/apiBaseTest.mjs).
//
// RULES (the production-offline fix lives here):
//   1. VITE_API_URL (build-time env, inlined by Vite) wins.
//   2. window.APP_API_BASE (runtime override) wins next — lets a deployed build
//      be pointed at the real backend WITHOUT a redeploy (set it in devtools,
//      then press "Retry Connection").
//   3. A development base (computed in api.js from the dev-server hostname) is
//      used only when the callers says it is a dev build.
//   4. PRODUCTION with no configured URL returns API_BASE_NOT_CONFIGURED.
//      It NEVER silently falls back to http://localhost:5000. A production page
//      served from the internet calling localhost in the visitor's browser is
//      exactly how the deployed app reported "Backend server is offline".
//   5. An EXPLICIT localhost/127.0.0.1 URL in production is also rejected as a
//      config error (same symptom), instead of being used and failing with a
//      confusing network error.
export const API_BASE_NOT_CONFIGURED = '__API_BASE_NOT_CONFIGURED__';

// Loopback hosts that only ever mean "the visitor's own machine".
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const trimSlash = (value) => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

const isLocalhostUrl = (value) => {
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname).toLowerCase().replace(/^\[|\]$/g, '');
    return LOCALHOST_HOSTNAMES.has(host);
  } catch {
    return false; // relative/same-origin paths like "/api" are allowed
  }
};

/**
 * @param {object} env
 * @param {string|undefined} env.envUrl       VITE_API_URL (Vite-inlined)
 * @param {boolean|undefined} env.isDev       import.meta.env.DEV
 * @param {string|undefined} env.devBase      computed localhost base for DEV
 *                                            builds only (see api.js)
 * @param {string|undefined} env.runtimeBase  window.APP_API_BASE
 * @returns {string} API base (with trailing slashes removed) or the sentinel.
 */
export function resolveApiBase(env = {}) {
  const isDev = !!env.isDev;

  const fromEnv = trimSlash(env.envUrl);
  if (fromEnv) {
    if (isDev || !isLocalhostUrl(fromEnv)) return fromEnv;
    return API_BASE_NOT_CONFIGURED; // production: explicit localhost is a config error
  }

  const fromRuntime = trimSlash(env.runtimeBase);
  if (fromRuntime) {
    if (isDev || !isLocalhostUrl(fromRuntime)) return fromRuntime;
    return API_BASE_NOT_CONFIGURED;
  }

  // The dev localhost base is only ever supplied for dev builds (api.js gates
  // it on import.meta.env.DEV, which Vite replaces with a constant), so this
  // branch is unreachable in production bundles.
  const fromDev = trimSlash(env.devBase);
  if (fromDev) return fromDev;

  return API_BASE_NOT_CONFIGURED;
}

/** True when `base` is a real API URL (not the sentinel, not empty). */
export function isApiBaseConfigured(base) {
  return !!base && base !== API_BASE_NOT_CONFIGURED;
}