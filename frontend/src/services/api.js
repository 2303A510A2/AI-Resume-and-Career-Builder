import axios from 'axios';
import { resolveApiBase, isApiBaseConfigured, API_BASE_NOT_CONFIGURED } from './apiBase';

// Single axios instance for the whole app.
//
// The API base comes from ONE place (src/services/apiBase.js), in this order:
//   1. VITE_API_URL            — build-time env, inlined by Vite. REQUIRED for a
//                                deployed build (set it in the hosting dashboard
//                                BEFORE each production build).
//   2. window.APP_API_BASE     — runtime override, no redeploy needed.
//   3. dev localhost defaults  — development only.
//   4. API_BASE_NOT_CONFIGURED — production with no URL configured. Requests are
//                                refused BEFORE any network call (see the request
//                                interceptor) so a deployed page can never
//                                silently target http://localhost:5000 — which is
//                                the exact mechanism behind the deployed
//                                "Backend server is offline" report.
const getRuntimeApiBase = () => {
  if (typeof window === 'undefined') return undefined;
  return window.APP_API_BASE || undefined;
};

// Comprises the DEVELOPMENT localhost base. `import.meta.env.DEV` is replaced
// by Vite with a constant at build time, so in a production bundle the ternary
// below folds to `undefined` and these localhost strings are DROPPED entirely —
// a production build provably contains no localhost API fallback (verified by
// the build audit in the README).
const getDevApiBase = () => {
  if (!import.meta.env.DEV) return undefined;
  const host = typeof window !== 'undefined' ? window.location?.hostname : 'localhost';
  if (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return 'http://127.0.0.1:5000/api';
  }
  return 'http://localhost:5000/api';
};

const getApiBase = () =>
  resolveApiBase({
    envUrl: import.meta.env.VITE_API_URL,
    isDev: import.meta.env.DEV,
    devBase: import.meta.env.DEV ? getDevApiBase() : undefined,
    runtimeBase: getRuntimeApiBase(),
  });

/**
 * The effective API base, exported so the health layer can reason about it.
 *
 * `http://localhost:5000/api` from a page served by `http://localhost:5173` is a
 * DIFFERENT ORIGIN. That is the only reason CORS exists in this app, and CORS is
 * what made "Backend server is offline" appear on a perfectly healthy backend: a
 * rejected cross-origin request is reported to JavaScript as a bare
 * `TypeError: Failed to fetch` with no response object, which is indistinguishable
 * from "the server is not running".
 */
export const getApiBaseUrl = getApiBase;

/** True when this build has a real backend URL configured (not the sentinel). */
export const isApiConfigured = () => isApiBaseConfigured(getApiBase());

/** True when API calls leave this page's origin and therefore need CORS. */
export const isCrossOriginApi = () => {
  try {
    const base = new URL(getApiBase());
    return base.origin !== window.location.origin;
  } catch {
    return false;
  }
};

const api = axios.create({
  baseURL: getApiBase(),
  // Client-side ceiling for a single API call.
  //
  // The backend owns the real AI deadline, and that deadline is now BUDGET-SCALED:
  // llmService derives the per-attempt timeout from the requested output budget
  // (llmService.perAttemptTimeoutMs, floor LLM_TIMEOUT_MS=20s, ceiling
  // LLM_LONG_TIMEOUT_MS=180s) so "explain in 2000 words" or "100 interview
  // questions" is never aborted mid-generation. The worst case is therefore
  // roughly per-attempt x attempts + backoff, plus up to LLM_MAX_CONTINUATIONS
  // internal continuation turns for a very large request.
  //
  // 3.5 minutes of client patience covers that worst case with room to spare, so a
  // slow provider still returns a REAL 200 with the complete answer (or an accurate
  // 502/503) instead of being aborted here. Its only job is to stop an unbounded
  // hang (a socket that never closes).
  //
  // When it does fire, axios rejects with ECONNABORTED and NO response object,
  // which the UI classifies as an AI timeout ("The AI took too long to answer") —
  // never as "Backend server is offline", because a timeout is not a
  // proof of an unreachable server.
  timeout: 210000,
});

api.interceptors.request.use((config) => {
  // Production build with no backend URL configured: refuse synchronously with a
  // clear code instead of firing a request at localhost (or at a garbage URL).
  // axios propagates a rejected promise from the interceptor, so NO network
  // request is ever attempted, and the UI can show the precise configuration
  // error instead of a misleading "backend offline".
  if (!isApiBaseConfigured(getApiBase())) {
    const error = new Error(
      'This build has no backend API URL configured. Set VITE_API_URL at build time, or window.APP_API_BASE on this page.'
    );
    error.code = API_BASE_NOT_CONFIGURED;
    error.config = config;
    error.isAxiosError = true;
    return Promise.reject(error);
  }

  // Admin calls carry the admin token. The two EXCEPTIONS use the ordinary user
  // token instead: `/admin/login` (no token at all) and the access-request
  // endpoints `/admin/request` + `/admin/request/status` (a normal signed-in user
  // files/checks a request). Getting this wrong sent the admin token (or none) to
  // an endpoint guarded by `protect`, which would 401 a legitimate request.
  const url = String(config.url || '');
  const isAdminCall = url.startsWith('/admin') && !url.includes('/admin/login') && !url.includes('/admin/request');
  const token = isAdminCall ? localStorage.getItem('adminToken') : localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const apiCode = String(error.response?.data?.code || '').toUpperCase();
    const message = error.response?.data?.message || error.message || 'Something went wrong';

    // A token is only thrown away when the backend actually says the token is
    // no longer usable (expired or cryptographically invalid).
    //
    // Network failures, Groq/provider errors, 429, 500, 502 and 503 arrive with
    // NO response object at all or with a non-401 status, so they can never
    // reach this branch. `TOKEN_MISSING` also does not invalidate anything: it
    // means the request carried no Authorization header, not that a stored
    // session stopped working — clearing the token there logged users out while
    // a perfectly valid JWT was still present.
    const tokenIsDead =
      status === 401 &&
      (apiCode === 'TOKEN_EXPIRED' || apiCode === 'TOKEN_INVALID' || apiCode === 'ACCOUNT_NOT_FOUND');

    if (tokenIsDead) {
      const onAdminPage = window.location.pathname.startsWith('/admin');
      if (onAdminPage) {
        localStorage.removeItem('adminToken');
        localStorage.removeItem('admin');
        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/admin/login';
        }
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        if (!['/login', '/signup'].includes(window.location.pathname)) {
          window.location.href = '/login';
        }
      }
    }

    error.message = message;
    return Promise.reject(error);
  }
);

export default api;