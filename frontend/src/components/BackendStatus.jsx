import { useCallback, useEffect, useRef, useState } from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { getHealthResilient, getHealthSameOrigin } from '../services/healthService';

const POLL_MS = 30000;
// While the backend looks unreachable, look again quickly so a freshly started
// backend connects on its own instead of after a full 30s poll cycle.
const POLL_MS_OFFLINE = 5000;

/**
 * ONE shared health poller for the whole app.
 *
 * Why this is shared: `<BackendStatus />` is rendered in BOTH the dashboard
 * topbar and the assistant header, and React 18 StrictMode double-invokes
 * effects in development. With one poller per component the page issued a
 * measured **43 GET /api/health calls per 30 seconds (~1290 per 15 minutes)**
 * while the backend allows only 300 requests per 15 minutes. The budget was
 * therefore exhausted about 70 seconds after the page loaded, after which EVERY
 * call — including POST /api/ai/career-assistant — came back 429. A status pill
 * must never be able to take the API offline.
 *
 * A module-level singleton fixes the multiplier, and the interval is chosen from
 * the LIVE result (not from a stale render closure) so a healthy backend is
 * polled slowly and an unreachable one quickly.
 */
let pollTimer = null;
let inFlight = false;
let subscriberCount = 0;
const subscribers = new Set();

const snapshot = {
  state: 'checking', // checking | online | offline
  aiProvider: '',
  model: '',
  mongodb: false,
  configError: false, // true => no backend URL configured for this build
};

const emit = () => {
  for (const fn of subscribers) fn({ ...snapshot });
};

const scheduleNext = () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (subscriberCount === 0) return;
  // Read the LIVE snapshot, not a captured render value. The previous code read
  // `state` from the mount-time closure, which was always the initial value, so
  // the "slow when online" branch could never be taken.
  pollTimer = setTimeout(pollOnce, snapshot.state === 'online' ? POLL_MS : POLL_MS_OFFLINE);
};

/**
 * The OFFLINE verdict needs TWO probes on two different origins (the documented
 * two-probe rule). The cross-origin probe can be blocked by the browser even
 * against a perfectly healthy backend, and the same-origin probe is immune to
 * CORS — so calling the backend offline on ONE failed path is how a healthy
 * backend used to be reported as down.
 *
 * ORDER MATTERS for the request budget: the cross-origin probe runs first and,
 * when it answers, the second probe is NEVER fired — a healthy backend still
 * costs exactly one GET /api/health per poll tick. The same-origin probe only
 * runs when the first path failed, which is exactly when its verdict is needed.
 *
 * Returns the winning probe's snapshot (so tooltip fields stay real), or the
 * failed direct result when neither path produced proof.
 */
const probeTwoPaths = async (direct) => {
  if (direct.reachable) return direct;
  const sameOrigin = await getHealthSameOrigin();
  return sameOrigin.reachable ? sameOrigin : direct;
};

async function pollOnce() {
  if (inFlight) { scheduleNext(); return; }
  inFlight = true;
  try {
    // While the backend is already known to be up, a single probe is enough.
    // Only an offline/unknown state uses the resilient multi-attempt probe, so a
    // freshly started backend still survives a nodemon restart window without the
    // online case ever firing three requests per tick.
    const knownOnline = snapshot.state === 'online';
    const direct = knownOnline ? await getHealthResilient(8000, 1) : await getHealthResilient();
    const h = await probeTwoPaths(direct);
    snapshot.state = h.reachable ? 'online' : 'offline';
    snapshot.aiProvider = h.aiProvider;
    snapshot.mongodb = h.mongodb;
    snapshot.model = h.model;
    snapshot.configError = h.configError === true;
    emit();
  } finally {
    inFlight = false;
    scheduleNext();
  }
}

function subscribe(fn) {
  subscribers.add(fn);
  subscriberCount += 1;
  // First consumer starts the single poller; later ones just add a subscriber.
  if (subscriberCount === 1) pollOnce();
  else fn({ ...snapshot });
  return () => {
    subscribers.delete(fn);
    subscriberCount -= 1;
    if (subscriberCount === 0 && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

/**
 * Small backend status pill with a REAL Retry Connection action.
 *
 * The green/online state means the backend API is reachable — nothing more. It
 * never asserts that the AI provider, web search, or voice services are up; the
 * real provider state from GET /api/health is shown in the tooltip only.
 *
 * "Retry Connection" issues a genuine GET /api/health (see healthService) and
 * updates the connection state from that REAL response. It never flips the pill
 * optimistically.
 */
export default function BackendStatus() {
  const [snap, setSnap] = useState(() => ({ ...snapshot }));
  const aliveRef = useRef(true);
  const checkingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return subscribe((next) => {
      if (aliveRef.current) setSnap(next);
    });
  }, []);

  // A real GET /api/health, run immediately (bypassing the shared poll timer),
  // updating the state from the response. No optimistic transition. The offline
  // verdict goes through the same two-probe rule as the poller.
  const check = useCallback(async () => {
    if (checkingRef.current) return snap;
    checkingRef.current = true;
    try {
      const direct = snapshot.state === 'online' ? await getHealthResilient(8000, 1) : await getHealthResilient();
      const h = await probeTwoPaths(direct);
      snapshot.state = h.reachable ? 'online' : 'offline';
      snapshot.aiProvider = h.aiProvider;
      snapshot.mongodb = h.mongodb;
      snapshot.model = h.model;
      snapshot.configError = h.configError === true;
      emit();
      return h;
    } finally {
      checkingRef.current = false;
    }
  }, [snap]);

  const onRetry = async () => {
    setSnap((s) => ({ ...s, state: 'checking' }));
    await check();
  };

  const { state, aiProvider, model, mongodb, configError } = snap;

  const label =
    state === 'online'
      ? 'Backend Connected'
      : state === 'offline'
        ? 'Backend Offline'
        : 'Checking backend…';

  const title =
    state === 'online'
      ? `Backend reachable · MongoDB ${mongodb ? 'connected' : 'disconnected'} · AI provider: ${aiProvider}${model ? ` (${model})` : ''}`
      : state === 'offline'
        ? configError
          ? 'This build has no backend API URL configured. Set VITE_API_URL at build time (or window.APP_API_BASE on this page), then Retry Connection.'
          : 'Backend API is not reachable — start it in backend/ (npm run dev), then Retry Connection.'
        : 'Contacting the backend API…';

  return (
    <span className="backend-status-group">
      <span className={`backend-status ${state}`} title={title} role="status" aria-live="polite">
        {state === 'online' ? (
          <Wifi size={12} />
        ) : state === 'offline' ? (
          <WifiOff size={12} />
        ) : (
          <span className="backend-status-checking" aria-hidden="true" />
        )}
        <span className="backend-status-label">{label}</span>
      </span>
      {state === 'offline' && (
        <button
          type="button"
          className="btn btn-outline btn-sm backend-retry-btn"
          onClick={onRetry}
          title="Retry the real GET /api/health request"
          aria-label="Retry Connection"
        >
          <RefreshCw size={12} />
          <span className="backend-retry-btn-text">Retry Connection</span>
        </button>
      )}
    </span>
  );
}
