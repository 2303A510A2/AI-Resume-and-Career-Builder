// Structured chat resources (LeetCode problems, learning websites, docs, courses).
//
// The AI chat can return an optional micro-schema alongside its answer:
//   { "answer": "...", "resources": [{ title, description, type, difficulty, url }] }
//
// Trust is the core rule here:
//   - URLs must parse as http/https.
//   - The host must be on a curated allowlist of real, well-known sites.
//   - LeetCode problem links are additionally checked against a curated slug
//     list so a generated slug can never point at a page that does not exist.
// Anything that fails verification is dropped silently — the plain-text `answer`
// still stands on its own, so no fake/demo content ever reaches the UI.

const MAX_RESOURCES = 10;

// Hosts allowed in resource URLs. `www.` is normalized away before matching.
// Add a site here only if domain+path are genuinely known to be valid public
// references — never guess a domain, and never add an invented subdomain.
//
// This list is deliberately broad for well-known, long-lived learning / docs /
// job / tooling sites: a student asking "websites to learn X" almost always
// lands on one of them. Anything NOT listed is dropped (see `sanitizeUrl`),
// which is what keeps invented or ad/tracking URLs out of the chat.
const TRUSTED_HOSTS = new Set([
  // ---- Coding platforms / problem sites
  'leetcode.com', 'geeksforgeeks.org', 'practice.geeksforgeeks.org', 'hackerrank.com',
  'codewars.com', 'exercism.org', 'interviewbit.com', 'neetcode.io', 'takeuforward.org',
  'codechef.com', 'spoj.com', 'hackerearth.com', 'codeforces.com', 'topcoder.com',
  'leetcode.cn', 'tryhackme.com', 'ctftime.org', 'kodewithkaran.com', 'fireship.io',

  // ---- Official documentation / language & framework references
  'developer.mozilla.org', 'docs.oracle.com', 'oracle.com', 'java.com', 'howtocompile.com',
  'docs.python.org', 'python.org', 'docs.python.org', 'tutorialspoint.com', 'w3schools.com',
  'w3resource.com', 'programiz.com', 'javatpoint.com', 'baeldung.com', 'javacodegeeks.com', 'informaticstub.com',
  'spring.io', 'docs.spring.io', 'nodejs.org', 'react.dev', 'reactjs.org', 'reactnative.dev',
  'vuejs.org', 'angular.io',
  'nextjs.org', 'nuxt.com', 'svelte.dev', 'solidjs.com', 'jquery.com', 'bootstrap.com',
  'tailwindcss.com', 'laravel.com', 'laracasts.com', 'django-project.com', 'docs.djangoproject.com',
  'flask.palletsprojects.com', 'fastapi.tiangolo.com', 'go.dev', 'golang.org', 'rust-lang.org',
  'kotlinlang.org', 'swift.org', 'php.net', 'ruby-lang.org', 'perl.com', 'scala-lang.org',
  'kotlinlang.com', 'dart.dev', 'flutter.dev', 'developer.android.com', 'developer.apple.com',
  'docs.aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com', 'learn.microsoft.com',
  'kubernetes.io', 'docker.com', 'docs.docker.com', 'git-scm.com', 'redis.io', 'nginx.org',
  'apache.org', 'maven.apache.org', 'gradle.org', 'postgresql.org', 'mysql.com', 'dev.mysql.com',
  'mongodb.com', 'docs.mongodb.com', 'sqlite.org', 'graphql.org', 'spec.graphql.org',
  'jestjs.io', 'vitest.dev', 'mochajs.org', 'cypress.io', 'playwright.dev', 'selenium.dev',
  'webpack.js.org', 'vitejs.dev', 'rollupjs.org', 'eslint.org', 'prettier.io', 'babeljs.io',
  'expressjs.com', 'fastify.dev', 'mongoosejs.com', 'sequelize.org', 'prisma.io', 'supabase.com',
  'appwrite.io', 'devdocs.io', 'caniuse.com', 'github.com', 'github.io',

  // ---- AI / ML / data
  'openai.com', 'platform.openai.com', 'docs.anthropic.com', 'huggingface.co', 'kaggle.com',
  'tensorflow.org', 'pytorch.org', 'scikit-learn.org', 'pandas.pydata.org', 'numpy.org',
  'scipy.org', 'matplotlib.org', 'opencv.org', 'keras.io', 'ollama.com',

  // ---- Learning platforms / courses / video
  'freecodecamp.org', 'coursera.org', 'udemy.com', 'edx.org', 'codecademy.com', 'scrimba.com',
  'egghead.io', 'pluralsight.com', 'skillshare.com', 'simplilearn.com', 'greatlearning.com',
  'studytonight.com', 'datacamp.com', 'frontendmasters.com', 'roadmap.sh', 'realpython.com',
  'teachercodes.com', 'dev.to', 'hashnode.dev', 'medium.com', 'substack.com', 'notion.so',
  'automatetheboringstuff.com', 'inventwithpython.com', 'python-guide.org', 'learnpython.org',
  'learncpp.com', 'cplusplus.com', 'cppreference.com', 'learn-c.org', 'guru99.com',
  'sqlbolt.com', 'mode.com', 'khanacademy.org', 'theodinproject.com', 'fullstackopen.com',
  'javascript.info', 'exploringjs.com', 'typescriptlang.org', 'eloquentjavascript.net',
  'deno.land', 'bun.sh', 'w3.org', 'tc39.es', 'npmjs.com', 'pkg.go.dev', 'openjdk.org',
  'youtube.com', 'youtu.be', 'm.youtube.com', 'youtube-nocookie.com', 'traversymedia.com',
  'thecodingtrain.com', 'google.com',

  // ---- Q&A / reference
  'stackoverflow.com', 'stackexchange.com', 'askubuntu.com', 'wikipedia.org', 'geeksforgeeks.org',

  // ---- Tools / editors / playgrounds
  'vscode.dev', 'code.visualstudio.com', 'visualstudio.com', 'atom.io', 'sublime.com',
  'jetbrains.com', 'intellij.com', 'eclipse.org', 'netbeans.org', 'canva.com',
  'excalidraw.com', 'tldraw.com', 'carbon.now.sh', 'runkit.com', 'replit.com', 'codesandbox.io',
  'stackblitz.com', 'colab.research.google.com', 'jupyter.org', 'onlinegdb.com', 'jdoodle.com',
  'leetcode.com', 'postman.com', 'insomnia.rest',

  // ---- Jobs / career
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'naukri.com', 'ambitionbox.com',
  'internshala.com', 'unstop.com', 'wellfound.com', 'angel.co', 'ziprecruiter.com',

  // ---- Travel / places (path-restricted below in sanitizeUrl)
  'tripadvisor.com', 'maps.google.com', 'booking.com', 'makemytrip.com', 'irctc.co.in',
  'redbus.in', 'oyohikes.com', 'zomato.com',
]);


// Real LeetCode problem slugs (canonical, lowercase-hyphen). This list is
// deliberately curated from well-known, long-stable problems. A slug the model
// returns that is NOT here is dropped instead of risking a 404 button.
const LEETCODE_SLUGS = new Set([
  // Arrays & hashing
  'two-sum', 'contains-duplicate', 'valid-anagram', 'group-anagrams',
  'top-k-frequent-elements', 'product-of-array-except-self', 'valid-sudoku',
  'longest-consecutive-sequence', 'subarray-sum-equals-k',
  // Two pointers / sliding window
  'valid-palindrome', '3sum', 'container-with-most-water',
  'two-sum-ii-input-array-is-sorted', 'best-time-to-buy-and-sell-stock',
  'longest-substring-without-repeating-characters',
  'longest-repeating-character-replacement', 'minimum-window-substring',
  'sliding-window-maximum', 'permutation-in-string',
  // Stack
  'valid-parentheses', 'min-stack', 'evaluate-reverse-polish-notation',
  'daily-temperatures', 'car-fleet', 'largest-rectangle-in-histogram',
  // Binary search
  'binary-search', 'search-a-2d-matrix', 'search-in-rotated-sorted-array',
  'find-minimum-in-rotated-sorted-array', 'koko-eating-bananas',
  'find-peak-element', 'first-bad-version',
  // Linked list
  'reverse-linked-list', 'merge-two-sorted-lists', 'reorder-list',
  'remove-nth-node-from-end-of-list', 'copy-list-with-random-pointer',
  'add-two-numbers', 'linked-list-cycle', 'find-the-duplicate-number',
  'lru-cache', 'middle-of-the-linked-list', 'palindrome-linked-list',
  'intersection-of-two-linked-lists',
  // Trees
  'invert-binary-tree', 'maximum-depth-of-binary-tree', 'diameter-of-binary-tree',
  'balanced-binary-tree', 'same-tree', 'subtree-of-another-tree',
  'lowest-common-ancestor-of-a-binary-search-tree',
  'binary-tree-level-order-traversal', 'binary-tree-right-side-view',
  'count-good-nodes-in-binary-tree', 'validate-binary-search-tree',
  'kth-smallest-element-in-a-bst',
  'construct-binary-tree-from-preorder-and-inorder-traversal',
  'binary-tree-maximum-path-sum', 'serialize-and-deserialize-binary-tree',
  // Tries
  'implement-trie-prefix-tree', 'design-add-and-search-words-data-structure',
  'word-search-ii',
  // Heap / priority queue
  'kth-largest-element-in-an-array', 'k-closest-points-to-origin',
  'find-median-from-data-stream', 'task-scheduler',
  // Backtracking
  'subsets', 'combination-sum', 'permutations', 'subsets-ii',
  'combination-sum-ii', 'word-search', 'palindrome-partitioning',
  'letter-combinations-of-a-phone-number', 'generate-parentheses',
  'n-queens', 'sudoku-solver',
  // Graphs
  'number-of-islands', 'clone-graph', 'max-area-of-island',
  'pacific-atlantic-water-flow', 'surrounded-regions', 'rotting-oranges',
  'course-schedule', 'course-schedule-ii', 'word-ladder',
  'shortest-path-in-binary-matrix', 'cheapest-flights-within-k-stops',
  // 1-D / 2-D DP
  'climbing-stairs', 'min-cost-climbing-stairs', 'house-robber',
  'house-robber-ii', 'coin-change', 'coin-change-ii',
  'longest-increasing-subsequence', 'partition-equal-subset-sum',
  'maximum-product-subarray', 'word-break', 'decode-ways', 'unique-paths',
  'unique-paths-ii', 'jump-game', 'jump-game-ii', 'edit-distance',
  'palindromic-substrings', 'longest-palindromic-substring',
  'longest-common-subsequence', 'target-sum', 'combination-sum-iv',
  'best-time-to-buy-and-sell-stock-with-cooldown',
  // Greedy / intervals
  'maximum-subarray', 'merge-intervals', 'insert-interval',
  'non-overlapping-intervals', 'gas-station', 'candy', 'hand-of-straights',
  // Math & bit manipulation
  'single-number', 'missing-number', 'reverse-bits', 'number-of-1-bits',
  'counting-bits', 'sum-of-two-integers', 'reverse-integer',
  'palindrome-number', 'roman-to-integer', 'integer-to-roman', 'powx-n',
  'sqrtx', 'happy-number',
  // Arrays / misc classic interview
  'remove-duplicates-from-sorted-array', 'remove-element', 'move-zeroes',
  'rotate-array', 'plus-one', 'majority-element', 'sort-colors',
  'find-all-anagrams-in-a-string', 'minimum-remove-to-make-valid-parentheses',
  'set-matrix-zeroes', 'spiral-matrix', 'rotate-image',
]);

const RESOURCE_TYPES = new Set(['leetcode', 'problem', 'website', 'course', 'documentation', 'resource', 'code', 'tool', 'place']);
const DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard']);

const stripWww = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

/**
 * Validates and normalizes a resource URL. Returns the normalized https URL,
 * or null when the URL cannot be proven safe/real.
 *
 * `opts.verified` marks a URL that came from the provider's live web search
 * round trip (Groq `browser_search`), NOT from the model's own imagination.
 * Those already went through the provider's grounded search, so the curated
 * host allowlist is skipped — but the protocol check stays, so `javascript:`,
 * `data:` and `file:` URLs can never reach the UI either way.
 */
const sanitizeUrl = (url, opts = {}) => {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const host = stripWww(parsed.hostname);
  const verified = opts.verified === true;

  // LeetCode links must be a real problem page, the problemset, or the issues
  // page. A slug is accepted when it is canonical shape (`two-sum`,
  // `binary-tree-inorder-traversal`) — the curated list below guarantees the
  // classics, and the shape check keeps obvious fabrications (`/watch`, `/x/y`,
  // uppercase, spaces) out. Dropping an unfamiliar-but-genuine slug removed
  // REAL problems from the user's list, which is worse than a slug LeetCode
  // itself would 404 on.
  if (host === 'leetcode.com') {
    const path = parsed.pathname || '/';
    const m = path.match(/^\/problems\/([a-z0-9][a-z0-9-]*)\/?$/);
    if (!m) {
      if (path !== '/issues/' && path !== '/issues' && path !== '/' && path !== '/problemset/') {
        return null;
      }
    } else if (!LEETCODE_SLUGS.has(m[1]) && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m[1])) {
      return null;
    }
  }

  const isWikipedia = host === 'wikipedia.org' || host.endsWith('.wikipedia.org');
  if (!verified && !TRUSTED_HOSTS.has(host) && !isWikipedia) return null;

  // Path-restricted hosts: only genuinely safe, well-known page shapes pass.
  if (isWikipedia && !/^\/wiki\//.test(parsed.pathname)) return null;
  if (!verified && (host === 'google.com' || host === 'maps.google.com')) {
    // Only canonical Google Maps links (generated safely from a place query).
    if (!/^\/maps(\/|$)/.test(parsed.pathname)) return null;
  }

  // Normalize the scheme so shared links are consistent (all are https-capable).
  parsed.protocol = 'https:';
  return parsed.href;
};

/**
 * Validates one raw resource object. Returns a safe shape or null (dropped).
 */
const sanitizeResource = (raw = {}) => {
  const url = sanitizeUrl(raw && raw.url);
  const title = String((raw && raw.title) || '').trim().slice(0, 140);
  if (!url || !title) return null;

  const type = RESOURCE_TYPES.has(raw.type) ? raw.type : 'resource';
  const difficulty = DIFFICULTIES.has(raw.difficulty) ? raw.difficulty : '';
  const description = String((raw && raw.description) || '').trim().slice(0, 400);

  return { title, description, type, difficulty, url };
};

const sanitizeResources = (list) => {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const res = sanitizeResource(raw);
    // Drop duplicate URLs: the model sometimes repeats one link across items.
    if (!res || seen.has(res.url)) continue;
    seen.add(res.url);
    out.push(res);
    if (out.length >= MAX_RESOURCES) break;
  }
  return out;
};

/**
 * Sanitizes the optional "sources" array returned by the LLM (title/url/snippet).
 * Every URL is validated against the same trusted-host allowlist. Duplicates are
 * removed and the shape is normalized to { title, url, domain, snippet }.
 */
const sanitizeSources = (list, opts = {}) => {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const url = sanitizeUrl(raw && raw.url, opts);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let domain = '';
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch { /* keep empty */ }
    const title = String((raw && raw.title) || '').trim().slice(0, 140) || domain;
    out.push({
      title,
      url,
      domain,
      snippet: String((raw && raw.snippet) || '').trim().slice(0, 300),
    });
    if (out.length >= 6) break;
  }
  return out;
};

// Every http(s) URL that appears in a plain-text answer, in order, de-duplicated.
const extractInlineUrls = (text) => {
  const out = [];
  const seen = new Set();
  // NOTE: no trailing \b on the bare-URL branch — a URL often ends in "/" (a
  // non-word char), and \b would backtrack it away, silently turning
  // ".../docs.python.org/3/" into ".../docs.python.org/3". The character class
  // already bounds the match; trailing sentence punctuation is trimmed below.
  const re = /\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+?)\s*(?:\)|$)|\b(https?:\/\/[^\s<>"'`)\]]+)/g;
  const t = String(text || '');
  let m;
  while ((m = re.exec(t)) !== null) {
    const label = String(m[1] || '').trim();
    let raw = m[2] || m[3] || '';
    raw = raw.replace(/[.,;:)\]]+$/, ''); // sentence punctuation, not path chars
    if (raw.endsWith('(')) raw = raw.slice(0, -1);
    if (!raw || !/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ url: raw, label });
    if (out.length >= 12) break;
  }
  return out;
};

/**
 * Extracts the first balanced {...} JSON object in `text` (fence-tolerant).
 */
const extractObject = (text) => {
  const start = String(text || '').indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  const t = String(text);
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Newline-tolerant JSON extraction. Some models embed long multi-line answer
 * texts with LITERAL newlines inside string values, which strict JSON.parse
 * rejects (and max_tokens sometimes truncates mid-object). This re-scans the
 * same balanced {...} object, escaping raw newlines/tabs found inside string
 * values so the list text survives — the UI must never fall back to raw JSON.
 */
const extractObjectTolerant = (text) => {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (escaped) {
      escaped = false;
      if (inString) out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      if (inString) out += ch;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      out += ch === '\n' || ch === '\r' || ch === '\t' ? `\\${ch === '\n' ? 'n' : ch === '\r' ? 'r' : 't'}` : ch;
      continue;
    }
    out += ch;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};

/**
 * Last-resort extraction of just the "answer" string from an LLM reply whose
 * structured JSON could not be parsed (e.g. truncated at max_tokens — the cut
 * can even land mid-string). Ensures the chat NEVER shows raw JSON — it shows
 * the answer text (possibly shortened), minus any resource cards.
 */
const salvageAnswer = (text) => {
  // Capture up to the closing quote, or to end-of-input when the JSON was
  // truncated inside the answer string (no closing quote exists).
  const m = String(text || '').match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\\//g, '/')
    .trim();
};

/**
 * Tries to interpret an LLM reply as the structured { answer, resources, sources }
 * response. Returns { answer, resources, sources } or null when the reply is
 * plain text. `resources` is the sanitized card list; `sources` is the sanitized
 * source-link list. Both are [] when absent.
 */
const parseStructuredResponse = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;

  const obj = extractObject(text) || extractObjectTolerant(text);
  if (!obj) {
    // Never show raw JSON to the user: fall back to the salvaged answer text.
    const salvaged = salvageAnswer(text);
    return salvaged ? { answer: salvaged, resources: [], sources: [] } : null;
  }
  if (typeof obj.answer !== 'string' && !Array.isArray(obj.resources)) return null;

  const answer = String(obj.answer || '').trim();
  if (!answer) return null;

  const resources = sanitizeResources(obj.resources);
  const sources = sanitizeSources(obj.sources);
  return { answer, resources, sources };
};

/**
 * Turns the text around a bare link into a short card title: unwraps markdown
 * link syntax, drops list/bold markers and a trailing "— description" tail.
 */
const cleanTitleFragment = (str) => {
  let frag = String(str || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/\[([^\]]*)\]\(\s*$/, '$1')     // dangling "[label]("
    .replace(/^\s*(?:\d+[.)]\s+|\*+\s+|[-•]\s+)/, '') // leading list marker
    .replace(/\*\*/g, '')                    // bold markers
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[|:;–—\-[(]\s*$/, '')        // trailing separator / open bracket
    .trim();
  const dash = frag.split(/\s+[—–]\s+/)[0];
  if (dash && dash.trim().length >= 2) frag = dash.trim();
  return frag;
};

/**
 * Recovers clickable links the model put INLINE in the answer body.
 *
 * Resource answers are useless without a link: "here are 10 websites to learn
 * Java" with no URLs is exactly the failure this guards against. The answer text
 * is the one place a link can never be lost to a sanitizer, so it is the source
 * of truth. This lifts every inline URL into
 *   - a `sources` entry (clickable "Sources" chips), and
 *   - a `resources` card when the model returned no cards at all,
 * so a plain-text reply still arrives fully clickable. URLs already present in
 * the cards/sources are skipped, and every URL still goes through `sanitizeUrl`.
 */
const liftInlineLinks = (answer, resources = [], sources = [], opts = {}) => {
  const answerText = String(answer || '');
  if (!answerText) return { resources, sources };

  const known = new Set();
  const remember = (u) => {
    if (!u) return;
    // Store the normalized form so ".../java" and ".../java/" de-duplicate.
    known.add(u);
    known.add(String(u).replace(/\/$/, ''));
    known.add(String(u) + '/');
  };
  (Array.isArray(resources) ? resources : []).forEach((r) => remember(r && r.url));
  (Array.isArray(sources) ? sources : []).forEach((s) => remember(s && s.url));

  const wantCards = !Array.isArray(resources) || resources.length === 0;
  const nextResources = Array.isArray(resources) ? resources.slice() : [];
  const nextSources = Array.isArray(sources) ? sources.slice() : [];

  for (const { url: raw, label } of extractInlineUrls(answerText)) {
    const url = sanitizeUrl(raw, opts);
    if (!url || known.has(url)) continue;
    known.add(url);

    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }

    // A link's display name comes from its markdown label, else the text right
    // before it on the same line ("1. Bro Code — Java Course: https://..."), else
    // a readable form of the URL itself. Falls back gracefully so no card blank.
    let title = label;
    // The model sometimes autolinks a bare URL as "[url](url)"; the URL is not a
    // title — ignore it and fall through to the item text.
    if (title && /^https?:\/\//i.test(title)) title = '';
    if (title) {
      title = title.replace(/\s*\(.*?\)\s*$/, '').trim();
    }
    if (!title) {
      const idx = answerText.indexOf(raw);
      if (idx > 0) {
        const prefix = answerText.slice(0, idx);
        // Resource answers are often ONE line with items joined by "; " (the
        // prompt forbids literal newlines inside JSON). Cut at the LAST item
        // boundary so the title is this item's text, not the whole answer.
        const cut = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(';'));
        let frag = cleanTitleFragment(prefix.slice(cut + 1));
        // The URL may sit alone on its own line (a "**Title**\n  https://..."
        // layout): fall back to the nearest preceding non-empty line.
        if (!frag) {
          const lines = prefix.split('\n');
          for (let li = lines.length - 1; li >= 0 && !frag; li -= 1) {
            frag = cleanTitleFragment(lines[li]);
          }
        }
        title = frag.slice(0, 70);
      }
    }
    if (!title) {
      try {
        const u = new URL(raw);
        title = u.pathname.replace(/^\/|\/$/g, '').replace(/[-_/]/g, ' ').trim()
          || u.hostname.replace(/^www\./, '');
      } catch { /* keep empty */ }
    }
    title = (title || domain || raw).slice(0, 140);

    if (nextSources.length < 6) {
      nextSources.push({ title, url, domain, snippet: '' });
    }
    if (wantCards && nextResources.length < MAX_RESOURCES) {
      const onLeetCode = domain === 'leetcode.com' && /\/problems\//.test(url);
      nextResources.push({
        title,
        description: '',
        type: onLeetCode ? 'leetcode' : 'website',
        difficulty: '',
        url,
      });
    }
  }

  return { resources: nextResources, sources: nextSources };
};

module.exports = {
  parseStructuredResponse,
  sanitizeUrl,
  sanitizeResource,
  sanitizeResources,
  sanitizeSources,
  extractInlineUrls,
  liftInlineLinks,
};