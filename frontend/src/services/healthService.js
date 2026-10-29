import api, { isApiConfigured } from './api';
import { API_BASE_NOT_CONFIGURED } from './apiBase';

// Lightweight backend reachability check for the UI status pill.
//
// IT ONLY ANSWERS ONE QUESTION: did the API server respond at all?
//
// Evidence rules (this is the whole point of the module):
//   - ANY HTTP response (200, 401, 429, 500, 502, 503, ...) proves the server is
//     listening and reachable. Reporting "offline" for those statuses is a lie:
//     401 is an auth answer, 429 a rate-limit answer, 5xx a server-side fault — all
//     of them can only exist if the backend was actually reached.
//   - ONLY a failure that never produced an HTTP response (ECONNREFUSED, ENOTFOUND,
//     ERR_NETWORK, a CORS-blocked request, a client-side abort) is a genuine
//     connection failure and is reported as unreachable.
//
// It deliberately never claims any external AI/voice/web service is available —
// GET /api/health reports the real provider state (configured | unreachable |
// checking | not-configured) and the UI shows that as a tooltip only.

// A real HTTP answer takes longer than a refused connection, so allow more than a
// bare ping on a cold start (nodemon + OneDrive can make the first request slow).
const DEFAULT_TIMEOUT_MS = 8000;

export const getHealth = async (timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data } = await api.get('/health', { signal: controller.signal });
    return normalize(data);
  } catch (error) {
    clearTimeout(timer);

    // The backend DID answer — it just answered with an error status. That is a
    // reachable server, never an offline one.
    if (error?.response) return normalize(error.response.data);

    // The build has no backend URL configured (production without VITE_API_URL /
    // window.APP_API_BASE). No request was ever attempted, so this is NOT proof
    // that a backend is down — it is a configuration gap with its own honest
    // state (configError), never a lie about the backend itself.
    if (error?.code === API_BASE_NOT_CONFIGURED) {
      return {
        reachable: false,
        configError: true,
        mongodb: false,
        aiProvider: 'not-configured',
        model: '',
        status: 0,
      };
    }

    // No response object at all => the request never reached a server.
    return { reachable: false, configError: false, mongodb: false, aiProvider: 'unreachable', model: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A SECOND, independent health probe that never touches the API origin.
 *
 * WHY THIS EXISTS
 * ---------------
 * `getHealth()` uses the shared axios instance, so it is subject to exactly the
 * same cross-origin rules as the failed AI request. If CORS rejected the page's
 * origin, this probe is blocked too and reports `reachable: false` — which is
 * exactly how a healthy backend ends up being reported as "Backend server is
 * offline": both probes failed for the SAME reason, so they agreed, and the app
 * believed them.
 *
 * `GET /api/health` on this page's OWN origin is served by the dev server's
 * proxy (see `frontend/vite.config.js`), which forwards to the backend without
 * any CORS involvement at all. So:
 *
 *   same-origin probe OK  + cross-origin probe blocked  => the backend IS online,
 *                                                            the browser blocked
 *                                                            the cross-origin call
 *   both probes fail                                     => genuinely unreachable
 *
 * ONLY the real backend health payload counts as reachable: `status === 'ok'`
 * AND `server === 'online'` AND a `services` object (the same rule the legacy
 * page's probeSameOriginHealth applies). Any OTHER HTTP answer — a static
 * host's 404, the dev proxy's 500 when the backend behind it is down — proves
 * only that SOME server answered here, not that the backend did. Reporting
 * those as reachable would tell a genuinely dead backend it was online
 * whenever this page was served by any HTTP server at all.
 */
export const getHealthSameOrigin = async (timeoutMs = DEFAULT_TIMEOUT_MS) => {
  // No backend URL is configured, so a same-origin probe cannot prove anything:
  // skip the network round trip and report the configuration gap itself.
  if (!isApiConfigured()) {
    return { reachable: false, configError: true, mongodb: false, aiProvider: 'not-configured', model: '', status: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `fetch` with no custom headers => a simple request => no CORS preflight.
    const res = await fetch('/api/health', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    const isApiAnswer = !!(
      data &&
      typeof data === 'object' &&
      data.status === 'ok' &&
      data.server === 'online' &&
      typeof data.services === 'object'
    );
    return {
      reachable: isApiAnswer,
      mongodb: data?.mongodb === 'connected',
      aiProvider: String(data?.aiProvider || 'unknown'),
      model: data?.services?.model || '',
      status: res.status,
    };
  } catch {
    return { reachable: false, mongodb: false, aiProvider: 'unreachable', model: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Health check that survives a brief restart window.
 *
 * `npm run dev` (nodemon) closes and re-binds port 5000 whenever a watched file
 * is saved, which lasts 1-3 seconds. A single probe landing inside that window
 * gets ERR_CONNECTION_REFUSED and would flip the UI to "offline" even though the
 * backend is up moments later. So a genuine connection failure is retried a few
 * times before it is believed — the pill only reports offline once the backend has
 * really failed to answer repeatedly.
 *
 * This is a retry of a REAL request; success is never assumed.
 */
export const getHealthResilient = async (timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 3) => {
  let last = { reachable: false, configError: false, mongodb: false, aiProvider: 'unreachable', model: '', status: 0 };
  for (let i = 0; i < attempts; i++) {
    last = await getHealth(timeoutMs);
    if (last.reachable) return last;
    // A missing configured URL cannot be fixed by retrying the same request,
    // so do not burn the remaining attempts (or the real requests they would
    // represent) on a config gap.
    if (last.configError) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return last;
};

function normalize(data) {
  return {
    // Reached the server: reachable, whatever the HTTP status was.
    reachable: true,
    mongodb: data?.mongodb === 'connected',
    aiProvider: String(data?.aiProvider || 'unknown'),
    model: data?.services?.model || '',
    status: 200,
  };
}

// Alias used by the Retry/Connect action: it is the SAME real request, so the
// button can never claim success it did not verify.
export const recheckHealth = getHealth;