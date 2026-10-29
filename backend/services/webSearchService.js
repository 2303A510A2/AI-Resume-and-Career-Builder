// Web / resource discovery layer for the career assistant.
//
// The main chat can enrich its answers with CURRENT, real links when the user
// asks for things the LLM cannot verify on its own (places to visit, current
// resources, "best websites for X"). This module is provider-driven:
//
//   WEB_SEARCH_PROVIDER=       (empty  -> feature OFF, verified registry only)
//   WEB_SEARCH_API_KEY=        (secret; NEVER logged, NEVER sent to the browser)
//
// Rules:
//   - When no provider/key is configured the assistant stays HONEST: it returns
//     { available: false } and the chat answers exclusively from the curated
//     verified registry (resourceService). No fake "search results" ever exist.
//   - Every result URL is run through resourceService.sanitizeUrl before it is
//     passed on. Unsafe or unverifiable links are dropped.
//   - The API key is never included in logs, errors, or API responses.
//
// Supported providers:
//   tavily  -> POST https://api.tavily.com/search (Bearer auth, modern API)

const resourceService = require('./resourceService');

const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 12000);

const getConfig = () => ({
  provider: String(process.env.WEB_SEARCH_PROVIDER || '').trim().toLowerCase(),
  apiKey: process.env.WEB_SEARCH_API_KEY || '',
});

const isConfigured = () => {
  const c = getConfig();
  return c.provider === 'tavily' && Boolean(c.apiKey);
};

/** Import from resourceService but never re-export sanitize implementation details. */
const verifyUrl = (url) => resourceService.sanitizeUrl(url);

// Keywords that signal external/current content is useful. Kept conservative so
// ordinary career questions (resume analysis, skill advice) do not burn a search.
const RESOURCE_INTENT_RE =
  /(leetcode|dsa|data structures|algorithms?|problem|practice|website|websites|sites?|where can i (learn|practice|study)|learn [a-z ]+|courses?|tutorial|documentation|docs\b|resource|interview (questions?|prep|preparation)|preparation|places? to visit|things to do|top (10|5|3)|best [a-z ]+|how to (learn|start|practice|prepare)|coding (platform|practice)|roadmap|current|latest|2026)/i;

/**
 * Heuristic for "does this question benefit from current web results?".
 * When false (common case), the chat uses the verified registry only.
 */
const intentNeedsSearch = (question) => {
  const q = String(question || '').trim();
  return q.length > 4 && RESOURCE_INTENT_RE.test(q);
};

/**
 * Runs a real web search when configured. Returns sanitized, verified results.
 * @param {string} query
 * @param {{maxResults?:number}} opts
 * @returns {Promise<{available:boolean, results:Array<{title:string,url:string,snippet:string}>,
 *                     provider?:string, error?:string}>}
 */
const search = async (query, { maxResults = 5 } = {}) => {
  const c = getConfig();
  if (!isConfigured()) {
    return {
      available: false,
      results: [],
      details: 'Web search is not configured — the assistant uses its verified resource registry only.',
    };
  }

  if (c.provider === 'tavily') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            query: String(query).slice(0, 300),
            max_results: Math.min(Math.max(maxResults, 1), 8),
            search_depth: 'basic',
            include_answer: false,
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        const status = resp.status;
        if (status === 401 || status === 403) {
          return { available: false, results: [], provider: 'tavily', error: 'WEB_SEARCH_AUTH' };
        }
        if (status === 429) {
          return { available: false, results: [], provider: 'tavily', error: 'WEB_SEARCH_RATE_LIMITED' };
        }
        return { available: false, results: [], provider: 'tavily', error: `WEB_SEARCH_ERROR_${status}` };
      }

      const data = await resp.json().catch(() => null);
      const raw = (data && data.results) || [];
      const results = [];
      const seen = new Set();
      for (const r of raw.slice(0, 8)) {
        const url = verifyUrl(r && r.url);
        if (!url) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({
          title: String(r.title || '').trim().slice(0, 160),
          url,
          snippet: String(r.content || r.snippet || '').trim().slice(0, 300),
        });
        if (results.length >= maxResults) break;
      }
      return { available: true, results, provider: 'tavily' };
    } catch (err) {
      return {
        available: false,
        results: [],
        provider: 'tavily',
        error: err && err.name === 'AbortError' ? 'WEB_SEARCH_TIMEOUT' : 'WEB_SEARCH_UNREACHABLE',
      };
    }
  }

  return { available: false, results: [], provider: c.provider || null, error: 'WEB_SEARCH_UNSUPPORTED_PROVIDER' };
};

/** Safe status for /api/health — never the key. */
const status = () => {
  const c = getConfig();
  if (!c.provider) return 'not-configured';
  if (c.provider === 'tavily' && c.apiKey) return 'configured';
  return 'misconfigured';
};

module.exports = { isConfigured, intentNeedsSearch, search, status, getConfig };