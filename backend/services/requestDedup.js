// In-memory duplicate-request guard for the chat endpoints.
//
// Every user message gets a client-generated requestId. Before the controller
// runs the RAG/LLM pipeline it asks this module whether the same
// `${userId}:${requestId}` was already seen:
//   - pending   -> an identical request is already in flight; wait for that run
//                  instead of firing a SECOND Groq request (prevents duplicate
//                  AI calls + duplicate message history from double-clicks,
//                  React StrictMode re-renders, or client retries).
//   - done (within TTL) -> the identical request already completed; replay the
//                  stored response body so a network retry on the client gets
//                  the same answer without hitting the provider again.
//   - expired / unknown -> run the job and cache the result for TTL ms.
//
// A failed job is NOT cached (the entry is removed) so a genuine Retry later on
// re-runs the LLM as expected. The cache is bounded (pruned periodically).
//
// This guard is best-effort per server process — it cannot deduplicate across
// multiple Node instances — but it fully covers the single-process dev/prod
// setup of this app, which is exactly where React double-effects and double
// clicks cause duplicate provider calls.

const DEFAULT_TTL_MS = Number(process.env.REQUEST_DEDUP_TTL_MS || 60000);
const MAX_ENTRIES = 500;

const store = new Map(); // key -> { status: 'pending'|'done', promise, payload, expiresAt }

/**
 * Runs `fn` once per unique key within the TTL window. Returns the shared result.
 * @param {string} key  `${userId}:${requestId}`
 * @param {() => Promise<any>} fn
 * @param {{ ttlMs?: number }} [opts]
 * @returns {Promise<{ deduped: boolean, payload: any }>}
 */
const runOnce = async (key, fn, { ttlMs = DEFAULT_TTL_MS } = {}) => {
  if (!key) return { deduped: false, payload: await fn() };

  const now = Date.now();
  const existing = store.get(key);

  if (existing) {
    if (existing.status === 'pending') {
      // Same requestId already being processed: share that single LLM run.
      const payload = await existing.promise;
      return { deduped: true, payload };
    }
    if (existing.expiresAt > now) {
      // Already completed inside the TTL: replay, no new provider call.
      return { deduped: true, payload: existing.payload };
    }
    store.delete(key); // stale entry
  }

  const promise = (async () => fn())();
  const entry = {
    status: 'pending',
    promise,
    payload: undefined,
    expiresAt: now + ttlMs,
  };
  store.set(key, entry);
  prune();

  try {
    const payload = await promise;
    entry.status = 'done';
    entry.payload = payload;
    return { deduped: false, payload };
  } catch (err) {
    // Never cache a failure: a later genuine retry must be able to re-run.
    store.delete(key);
    throw err;
  }
};

/** Removes expired entries and hard-caps the map size. */
const prune = () => {
  const now = Date.now();
  if (store.size > MAX_ENTRIES) {
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }
  if (store.size > MAX_ENTRIES) {
    // Still oversized: drop the oldest (insertion order).
    const it = store.keys();
    let drop = store.size - MAX_ENTRIES;
    while (drop > 0 && it) {
      const k = it.next();
      if (k.done) break;
      store.delete(k.value);
      drop -= 1;
    }
  }
};

const size = () => store.size;

module.exports = { runOnce, size };