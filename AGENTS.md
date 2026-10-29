# AGENTS.md

## Current state

This is a complete, runnable full-stack application — not a scaffold.

- `backend\` — Node/Express REST API (auth + OTP, resume/JD parsing, RAG chat,
  interview/coding/roadmap, admin). Runs on `http://localhost:5000` via
  `npm run dev` (nodemon). Dependencies installed; MongoDB connected.
- `frontend\` — React 18 + Vite SPA with 20 pages (public, user dashboard,
  admin). Runs on `http://localhost:5173` via `npm run dev`. Dependencies
  installed. Production build verified.
- Root `README.md` documents features, config, run steps, and deployment.
- Not a git repository; `.gitignore` and `vercel.json` are provided so it can
  be initialized/deployed as-is.

## Implications for agents

- Server code belongs under `backend\`, client code under `frontend\`. Keep the
  separation.
- The executable ground truth for the backend is `backend\scripts\smokeTest.js`
  (end-to-end API suite). Run it after backend changes: `node scripts/smokeTest.js`
  from `backend\` (requires the backend and MongoDB running). The latest known
  passing run is **77 passed / 0 failed** (with the Groq key configured; every AI
  assertion is also graceful-failure safe when no key or quota is available). The
  executed total varies by one or two because a few assertions only run inside
  optional AI-backed branches. It also asserts requestId duplicate protection (a
  repeated requestId never double-calls the LLM), the voice endpoints'
  graceful/no-secret-leak behavior, and the image contract (health field, 401
  without a JWT on `/ai/generate-image` and `/ai/images/:id`, 400 on an empty
  prompt, 404 on an unknown image, and a text question never returning an image).
- Image generation lives entirely on the backend. `POST /api/ai/generate-image`
  plus `GET /api/ai/images/:id` (JWT + ownership scoped) and an image branch
  inside `POST /api/ai/career-assistant`. Routing is decided by
  `services\imageIntent.js` (GENERATE / UNDERSTAND / EDIT) — the frontend's
  `looksLikeImageRequest` in `chatService.js` is presentation-only and chooses
  the "Creating your image…" label; it must never decide behaviour. Provider
  logic is `services\imageService.js` (`pollinations` default, `openai`,
  `gemini`, plus a clearly-labelled offline `selftest` double used by tests).
  Bytes live in the `GeneratedImage` model (`imageData` is `select: false`) and
  chat messages carry only metadata. No provider key or provider URL may ever
  reach the frontend, and a simulated image must never be presented as real.
- Follow-up merging uses `GeneratedImage.basePrompt` (the subject prompt WITHOUT
  the quality suffix), not `prompt`. Both the chat follow-up path and the
  regenerate path must read `basePrompt` — feeding the suffixed `prompt` back in
  duplicates the suffix and poisons later follow-ups.
- Voice input: the primary recogniser is the browser Web Speech API, wrapped by
  `frontend\src\services\speechRecognition.js` (framework-agnostic ESM so it is
  Node-testable). It keeps interim + final results, dedups repeated `onresult`
  finals, never treats `onend` as "no speech" when finals exist, and only says
  "No speech detected" when the final transcript is genuinely empty. The
  transcript is dropped into the normal composer input — the voice path must
  never auto-send. MediaRecorder + Groq Whisper
  (`POST /api/ai/transcribe`) is only the fallback for browsers without the Web
  Speech API. `POST /api/ai/speech` is Groq TTS mp3 when `LLM_TTS_MODEL` is set;
  otherwise a clean 503 and the frontend falls back to browser
  `speechSynthesis`. No extra secrets — the LLM key/baseUrl are reused.
- Chat AI lives behind `POST /api/ai/career-assistant` (JWT-authenticated) with
  an optional `/regenerate` sub-route that re-runs the last question and replaces
  the previous answer. Every message carries a frontend-generated `requestId`;
  the backend dedups `(userId, requestId)` in-memory
  (`services\requestDedup.js`, TTL `REQUEST_DEDUP_TTL_MS`), so duplicate
  requests can never fire a second LLM call or double-persist history. The LLM
  provider layer (`services\llmService.js`) applies a ~60s timeout and up to 2
  backoff retries for transient failures (network/408/429/5xx, honoring
  Retry-After), never retries 401/403/404, and only ever surfaces clean
  client-safe error messages — raw provider URLs or keys must never reach the
  UI.
- **The chat-history layer is paginated and searchable, and titles mean something.**
  `GET /api/chat` (`listChats` in `chatController.js`) returns
  `{page,limit,total,hasMore,chats:[{_id,title,messageCount,updatedAt,createdAt}]}`
  ordered `updatedAt:-1,_id:-1` (stable, newest-activity first) — the sidebar must
  NEVER refetch full messages for the list, only on open. `GET /api/chat/search?q=`
  (`searchChats`, registered BEFORE `/:id`) escapes the query, matches user's own
  title OR message content, and is paginated the same way. A greeting-only
  conversation ("hi", "hello!", "good morning") is retitled by the first
  substantive question once ≥2 user turns exist (`retitleIfTrivial`, 48-char cap,
  never changes back). Ownership is enforced on read, list, search and delete —
  another user gets 404, never data. `backend\scripts\chatHistoryLiveTest.js`
  (**28/28**, live, throwaway users auto-cleaned via the admin endpoint) proves
  all of it end-to-end: retitling, metadata-only rows, paging with no cross-page
  duplicates incl. a partial last page, per-user search, and delete scoped to
  owner.
- Several fast, server-free unit suites also guard behaviour:
  `backend\scripts\outputRequirementsTest.js` (**164/164** — the output-requirement
  engine; includes §10b pinning that a real code request ("write a Java program…",
  incl. plural nouns like "queries" via `CODE_NOUN_RE`) carries the SHORTEST + cut-free
  CODE directive and the Explanation/Code/Output/Complexity STRUCTURE directive while
  "java interview questions" and code-only asks stay plain), `backend\scripts\intentTest.js`
  (**68/68** — the image-intent detector),
  `backend\scripts\chatHistoryTest.js` (**28/28** — offline helpers for the
  ChatGPT-style sidebar: greeting-title detection incl. trailing punctuation
  ("hey!", "good morning"), retitling by the first substantive question capped at
  48 chars, `pageParams` bounds, and the metadata-only `mapChat` shape), and
  `frontend\scripts\speechCaptureTest.mjs` (**50/50** — the speech-capture state
  machine, run with a fake `SpeechRecognition`) plus
  `frontend\scripts\codeHighlightTest.mjs` (**42/42** — the zero-dependency
  `syntaxHighlight.js` tokenizer: byte-for-byte roundtrip means Copy Code can never
  copy altered text, hostile `<script>`/`<svg>` content stays inert text, Java
  `String`/`List` are TYPES not keywords, Python indentation survives as one
  whitespace token, C++ preprocessor + Java annotations classify). The counter
  `numberedRuns` in `outputRequirements.js` is the SAME engine the live suite wraps
  for its independent `countItems` — parity by construction. `backend\scripts\imageTest.js`
  is the image end-to-end suite and needs the backend running; it retries
  throttled providers so a free-tier 402/429 does not fail the suite (latest
  passing run **59/59** against the live `pollinations` provider).
- **General-assistant behaviour is a real pipeline layer** (not a prompt tweak),
  pinned by `backend\scripts\generalAssistantTest.js` (**142/142** — offline, no
  LLM, no MongoDB, no network). `intentService.js` is the router: FIRST-PERSON
  emotional statements ("I failed my interview today", "I had an incident today",
  "my dog died today") now classify as `EMOTIONAL_SUPPORT` and BEAT topic
  keywords — the old ladder matched the word "interview" and steered a
  confession toward career coaching, the exact "feels like a career chatbot"
  failure. `ragService` consumes it: EMOTIONAL_SUPPORT gets the warm
  temperature, a per-intent empathetic `intentTail` in the layered system prompt
  (BASE + personality + facts + intent tail + output directive), and a plain
  one-call answer — never RAG, never career advice. Requests that only SHARE the
  words stay technical ("give me 10 interview questions" is still INTERVIEW).
  Entity lookups ("who is Jonathan Gaming?") flip `needsWeb` so current/outside
  information is searched instead of guessed — except personal/memory lookups
  ("who is my friend?", "who is Karri?" after the user already said it), which
  never search the web. Exam/study register ("explain for exam", "5 marks
  answer", "important questions", "numerical problems", "previous year paper")
  routes to LEARNING and adds an `exam` output format in `outputRequirements.js`
  (directive + budget bump, topic-agnostic like every other format).
  Link-worded requests ("give me Java YouTube links") now classify as
  RESOURCE_SEARCH so they are web-backed instead of answered from stale memory.
  The base system prompt carries the language-matching rule ("always reply in
  the language the user writes in") — that is the §19 Telugu/English support.
- **Identity is a first-class contract in the shared prompt, not a frontend
  label.** `services\prompts.js` (`CAREER_ASSISTANT_SYSTEM`) declares the app's
  own AI-companion identity: warm and friendly, NEVER ChatGPT/OpenAI/GPT/
  Gemini/Claude/Llama or any other product/model/company, NEVER claiming to be
  human, and NEVER disclosing model/provider/API/deployment details even if
  asked directly (STRICT RULES 2/3 plus rule 6: friendliness never replaces the
  answer). Introductions must VARY — no fixed script repeated twice in a
  conversation — and a nickname the user gives either side ("I'll call you Max",
  "call me Bunty") is remembered and used naturally for the rest of the
  conversation via `FACT_PATTERNS` in `ragService.js`. `intentService.js` gained
  `IDENTITY_RE` (name / who-are-you / "are you ChatGPT?" / "are you my friend?"
  route GENERAL with an `identity` signal) and `PRONOUN_ENTITY_RE`, so an
  identity question no longer misroutes as an `entity-lookup` with `needsWeb`
  (previously "Who are you?" set `needsWeb=true` and searched the web instead of
  answering) and pronoun "entities" ("this", "it", "you") are never treated as
  searchable names. The contract applies across every path because all of them
  flow through `ragService.askCareerAssistant` (new chats, existing
  conversations, regenerate, follow-ups, voice-transcribed input).
  `backend\scripts\identityTest.js` (**57/57** — offline, no LLM, no MongoDB, no
  network) pins the prompt's identity clauses, the `IDENTITY_RE`/
  `PRONOUN_ENTITY_RE` routing, and the nickname `FACT_PATTERNS`; live verification
  (throwaway users, auto-cleaned) confirmed "What is your name?" → an AI-companion
  introduction, "Are you ChatGPT?" → an honest "I'm not ChatGPT" that names no
  internal model, warm friend/emotional replies, unchanged Java explainer/program
  quality, a 1655-word "1000 words" answer, a follow-up that stayed on Java, and
  nickname recall both directions — with several distinct introducer wordings
  observed across turns (no fixed fallback).
- **The answer budget is dynamic, and it lives in exactly one place.**
  `services\outputRequirements.js` is the ONLY place that understands what a
  request demands: count ("give me 20 …"), range ("tables 1 to 100", "till 10"),
  word count ("in 500 words"), format (table / steps / code / comparison / MCQ /
  JSON / CSV / SQL / exam), code-only, no-comments, and follow-ups ("10 more", "make it
  20"). `ragService.pickMaxTokens(intent, req)` turns that into a token budget and
  `checkCompleteness(answer, req)` verifies what was actually delivered. Three
  layers then protect the user from a short answer: the budget, the
  `buildDirective(req)` block injected into the system prompt, and a bounded
  internal continuation loop. **Never reintroduce a fixed per-intent token table
  and never special-case a subject** — extend `outputRequirements.js`. The old
  table (`GENERAL 600`, `CODING 800`, `INTERVIEW 800`, `LEETCODE/DSA 1500`) is what
  silently truncated long answers.
- **Continuation must stay invisible and must never duplicate.** The extra turn is
  provider-only (`CONTINUATION_SYSTEM_TAIL`, a plain-markdown system message so the
  merge is trivial); only the merged `answer` is persisted, so no user ever sees a
  system message about being cut off. `mergeContinuation` de-duplicates both a
  restart-at-1 and a repeated preamble. It is bounded by `LLM_MAX_CONTINUATIONS`
  (default 3, hard cap 6) plus a no-growth bail-out, and a continuation failure
  keeps the existing answer instead of destroying it.
- **A completeness check that cannot read the delivered format is a bug in the
  check, not the answer.** `numberedRuns`/`bulletCount` must accept every marker a
  model really writes — `1.`, `1)`, `20: 20 40 60`, `**1.**`, `**1:**`,
  `### Table 4`, `Step 1:` — while rejecting clock times (`10:30 AM`) and prose
  (`Version 2: released`). A colon row that scored 0 items failed a complete
  20-row answer AND triggered a bogus continuation restarting at item 1.
- `backend\scripts\responseQualityTest.js` is the live proof of fulfilment
  (quantity, range incl. `20x20=400`, word count, code-only, table, no-RAG, and the
  follow-ups "10 more" / "make it 20" / "who is Karri?"). It re-counts items itself
  rather than trusting a canned answer, retries provider 429/5xx with backoff, and
  reports a spent daily quota as SKIP (`AI_DAILY_LIMIT` / `AI_RATE_LIMITED`) —
  never FAIL. `SKIP_SLOW=1` runs only the fast cases. Its independent re-counter
  accepts the SAME marker universe as `numberedRuns` (plain, bold `**N.**`,
  bullets, colon rows, `### Table N`, inline numbers) with an offline self-test
  (`countItemsSelfTest`, runs before any live call) so a checker regression can
  never masquerade as a product failure. If the backend restarts mid-run
  (nodemon + OneDrive touching files), a stale JWT/404 is healed by re-registering
  one fresh user (`reauth`) and the case is retried, not lost. `backend\package.json`
  also ships a `nodemonConfig.ignore` for `scripts/**`, `tests/**`, `coverage/**`
  so editing a test can never bounce the server under a live run.
- RAG is GATED, not always-on: retrieval runs only for `DOCUMENT_INTENTS`
  (RESUME / JOB_DESCRIPTION / DOCUMENT_ANALYSIS), when documents are attached, or
  when `DOCUMENT_HINT_RE` matches. `hi`, "what is Java?" and "explain polymorphism"
  get NO knowledge-base block at all. History trimming is role-aware too: assistant
  answers keep up to 9000 chars (the old flat 1200-char slice destroyed follow-ups
  like "make it 20" / "explain number 5") while user messages stay at 1500, all
  inside a 32000-char total window.
- **Backend liveness is load-bearing.** A "Backend server is offline" report is
  only ever correct when nothing is listening — the UI must never invent it from a
  failed AI request. `startListening` in `server.js` therefore RETRIES a busy port
  (`PORT_BIND_MAX_ATTEMPTS`, default 20 × `PORT_BIND_RETRY_MS` 1000ms) instead of
  calling `process.exit(1)`: under nodemon a non-zero exit parks it at
  "app crashed - waiting for file changes before starting…" and never returns, so
  one transient :5000 conflict used to kill the API until a file was saved.
  `backend\scripts\portConflictTest.js` (**6/6** — offline, port 54321, no MongoDB
  and no AI key) is the regression suite: it holds the port with a real socket,
  proves the process survives, then frees it and proves the backend binds by
  itself. Its squatter must listen on ALL interfaces (as Express does) — an
  IPv4-only `0.0.0.0` holder does not conflict on Windows and the test would pass
  for the wrong reason.
- **Dev CORS and the two-probe offline rule (the original "Backend server is
  offline" root cause).** The backend (`server.js`) allows any local origin in dev
  (`isLocalDevOrigin`: loopback, `*.localhost`/`.local`, machine hostname,
  RFC1918/169.254 IPv4) — a page served from, e.g., `http://legacy.localhost:5173`
  used to get 403 on the preflight, which browsers surface as bare
  `TypeError: Failed to fetch` (identical to a dead port), and the UI reported
  "Backend server is offline" against a healthy backend. `corsOfflineTest.js`
  (**36/36**) locks the allowed/refused origin matrix, the ACAO echo, and the
  no-secret-leak logging. Production stays CLIENT_URL-only. The legacy page's
  `confirmBackendOffline()` in `frontend/index.html` never calls the backend
  offline on a single failed request: the cross-origin probe (API origin) AND a
  CORS-free same-origin probe (`/api/health` on the page's own origin, through
  the Vite proxy when present) must both fail. Two traps that already bit:
  a same-origin probe must verify the response IS the backend's `/api/health`
  payload (`status === 'ok' && server === 'online' && services` object) — any HTTP
  answer (a static host's 404, the dev proxy's 500 when the backend behind it is
  down) proves only that SOME server answered here, so it must NOT count as
  "reachable", or a genuinely dead backend is told it is online; and a
  `new Promise(executor)` whose executor never calls the resolver never settles —
  that one-line bug silently hung the whole verdict chain on the genuine
  dead-port path (typing bubble stuck forever, `busy()` true, no error bubble),
  and it is invisible to syntax checkers. Both probes must also be bounded by the
  abort timeout so a probe can never hang the offline verdict.
- **The chat answer budget lives in ONE place.** `services\ragService.js` calls
  `pickMaxTokens(intent, req)`, which delegates to `planOutput()` in
  `services\outputRequirements.js` (count / range / word count / format), floored
  per intent by `STRUCTURED_JSON_MIN` and `DOCUMENT_INTENT_FLOOR` and clamped by
  `MAX_BUDGET_CAP`. This function was once missing while both call sites remained,
  so every `POST /api/ai/career-assistant` threw `ReferenceError: pickMaxTokens is
  not defined` and returned 500 while `/api/health` still answered 200 — the exact
  shape of the "Backend server is offline" report. Never reintroduce a separate
  budget table here; extend `outputRequirements.js` instead.
- **An undefined identifier cannot be caught by parsing.** `node --check` (and
  every lint-less build) accepts `pickMaxTokens(...)` happily, so this class of bug
  is invisible until the code runs. `backend\scripts\chatPathTest.js`
  (**45/45 — offline, no MongoDB, no AI key, no network**) guards it: it
  monkey-patches `llmService.chat` and calls `askCareerAssistant` in-process, so a
  `ReferenceError` anywhere in the chat path surfaces as a readable assertion
  failure. Use a conversational question ("hi") for cases that must not hit the
  database, because a document intent turns on RAG gating and would need a live
  MongoDB plus a real ObjectId. The same harness covers the continuation loop via
  a `replies` queue (a cut-off answer, then its remainder) and a `failAfter` that
  makes continuation calls throw — so the continuation's merge, budget, bound,
  no-growth bail-out and failure isolation are all asserted deterministically
  without spending quota. The stub also accepts `{ content, truncated:true }`
  replies, which is how the decisive rules are pinned: a PARTIAL LAST ROW
  ("20: … 20x10=200" of ×20) is detected from its CONTENT, continued once, and
  seam-joined into ONE line reaching 20x20=400 (section 14), and a provider that
  ADMITS finish_reason=length gets a second chance even when the markers look
  complete (section 15 — the old `if (check.complete) break;` shipped the short
  answer in one call). Current run **73/73** — section 16 additionally proves
  a continuation is PINNED to the provider that answered: the first reply claims
  `provider:'openai'`, the continuation must carry the same `preferProvider`/
  `preferModel`, and a fresh turn with no provider info pins nothing; section 17
  pins the general-assistant LAYERING: "I failed my interview today" reaches the
  stubbed provider as `EMOTIONAL_SUPPORT` with the empathetic `intentTail` in
  the system prompt and exactly ONE call (no RAG block), "give me 10 interview
  questions" stays INTERVIEW with no emotional tail, "Talk to me like my
  girlfriend. I had a bad day." applies BOTH the style layer and the emotional
  tail, greetings stay GENERAL, and the language-matching rule is present.
- **Provider errors are classified from the PROVIDER'S OWN BODY, never from the
  status alone, and a daily-quota 429 is never retried.** A real Groq body —
  `Rate limit reached for model … on tokens per day (TPD): Limit 200000, Used
  198880 …` (verified live; `type:"tokens"`, `code:"rate_limit_exceeded"`, so
  the `type` field alone would misread it as a per-minute limit) — must surface
  as `AI_DAILY_LIMIT` + `retryable:false` + EXACTLY ONE provider fetch, while
  `requests per minute (RPM)` / `tokens per minute (TPM)` must surface as
  `AI_RATE_LIMITED` + the "too many requests" wording + at most ONE bounded
  retry (<= 2 fetches) that HONORS the provider's own delay — read from the
  `retry-after` header OR parsed from the body ("Please try again in 18.33s")
  and bounded by `LLM_RATE_LIMIT_MAX_WAIT_MS` (default 40000) — instead of the
  old 3s cap that re-hit the same exhausted minute and surfaced a false outage;
  a hint beyond the cap fails fast (1 call) to the fallback chain / honest error.
  A `413` "Request too large … tokens per minute (TPM): Limit 8000, Requested
  8487, please reduce your message size" is a provider CAPACITY condition, not a
  dead 4xx: it is classified `AI_RATE_LIMITED` and is FALLBACKABLE, the reserved
  output budget is halved and retried promptly (waiting out a window cannot make
  an oversized request fit), and when EVERY configured provider rejects the size
  the chain surfaces `AI_REQUEST_TOO_LARGE` (502, "…too large for the AI
  provider's per-minute token budget. Please shorten your message…",
  `retryable:false`) instead of a misleading "temporarily unavailable".
  The live trace logs are `[CHAT REQUEST] requestId= provider= message=` (one per
  REAL run, inside the dedup guard) and `[AI PROVIDER REQUEST|RESPONSE|ERROR]`
  (`[AI PROVIDER REQUEST] … provider= model= attempt=i/n`, `… RESPONSE status=200`,
  `… ERROR status=<raw http> reason=<code>`) — safe fields only, no key/JWT/body.
  `backend\scripts\providerErrorTest.js` (**168/168** —
  offline, stubbed `global.fetch`, no MongoDB, no AI key, no network) locks
  that whole §4/§5/§12/§13/§14 contract: TPD/RPD/`insufficient_quota` 429 ->
  `AI_DAILY_LIMIT`, 1 call, `retryable:false`, `type=daily` in `[AI ERROR]`;
  RPM/TPM/unknown 429 -> `AI_RATE_LIMITED`, <= 2 calls; a 413 request-too-large
  shrinks the output budget and retries (2 calls, smaller max_tokens) and an
  all-413 chain -> `AI_REQUEST_TOO_LARGE` (retryable:false); 500/502 ->
  `AI_PROVIDER_ERROR`, 503 -> `AI_PROVIDER_UNAVAILABLE`, 401 ->
  `AI_AUTH_INVALID` with EXACTLY ONE fetch (auth is never retried); network
  throw -> `AI_UNREACHABLE` (bounded); 200 -> one fetch + `[AI RESPONSE]
  status=200 provider=… model=…`. The multi-provider fallback (§1-§10) is
  pinned here too: a fallback attempt runs exactly once and ONLY after a
  provider AVAILABILITY failure (`FALLBACKABLE_CODES`: daily/per-minute
  rate-limit, 5xx, network, empty 200) — a RAW 4xx from the provider (401/403/
  404/400, even when mapped to a fallbackable code) NEVER switches providers;
  a fully separate fallback (own base URL + own key) receives the byte-identical
  `messages` and is asserted to hit its own URL with its own Authorization
  header, never the primary's; a fallback PROVIDER declared WITHOUT its own key
  (e.g. `LLM_FALLBACK_PROVIDER=openai` with empty `LLM_FALLBACK_API_KEY`) is an
  incomplete config — `providers.fallback()` returns null and NOTHING is called,
  so the primary key can never be leaked to a foreign endpoint (and the same-key
  reuse still works when ONLY `LLM_FALLBACK_MODEL` is set, no provider declared);
  the fallback is a CHAIN — `LLM_FALLBACK2_*` (same rules, own key required, one
  attempt per slot) is tried after slot 1, so one user message costs at most
  1 primary + 2 fallback fetches and an error only when EVERY configured
  provider fails (a 3-deep daily 429 chain surfaces the honest quota message; a
  3-deep 503 chain surfaces the outage wording, still retryable); when the whole
  chain fails the error surfaces the
  TRUE cause: if a daily-quota error is involved on any side it is the honest
  `AI_DAILY_LIMIT` ("Today's AI provider quota has been reached…",
  `retryable:false`, `usedFallback:true` — a spent daily allowance is NEVER
  labeled a transient outage), otherwise `AI_PROVIDERS_UNAVAILABLE` (502, §10
  "AI services are temporarily unavailable. Please try again shortly.",
  `retryable` = true ONLY when every component failure could recover);
  a pinned continuation (`preferProvider`/`preferModel`) resolves against the
  primary AND every configured chain slot, costs EXACTLY one
  fetch to the survivor and is never re-fallen-back; and `[AI] Primary
  provider: <id>` / `[AI] Primary provider unavailable: <id> / Fallback
  provider: <id>` / `[AI FALLBACK] provider=<id> model=<id>` (one line per
  chain slot) log the switch
  without any secret material. It also asserts
  that one user message
  costs ONE generation while a duplicate `requestId` costs ZERO (controller
  level, `Chat.save` stubbed), that `[AI REQUEST]` / `[AI RESPONSE]` /
  `[AI ERROR]` carry only safe fields (a scan for key/Bearer/JWT material must
  come back empty), and that BOTH frontends map `AI_DAILY_LIMIT` to the §10
  wording with no Retry button while a per-minute 429 stays retryable and the
  both-failed `AI_PROVIDERS_UNAVAILABLE` branch respects the backend's
  `retryable` flag. It also
  source-pins the UI half of §13 (no browser tooling is available here): a send
  path must bail on a synchronous in-flight flag raised BEFORE any await and
  released when the response settles, Enter must preventDefault, the textarea
  and send button must be disabled while sending, no `useEffect` may auto-send,
  and the legacy page must flip `busy()` (the typing row) in the same tick as
  `sendMessage`.
- **Multi-provider AI fallback lives entirely in `services\llmService.js` (rules)
  + `services\providers.js` (config).** The primary is the existing `LLM_*` /
  `AI_*` / `GROQ_API_KEY` config; the fallback is a CHAIN of up to two slots:
  `LLM_FALLBACK_*` then `LLM_FALLBACK2_*` (slot 1:
  `LLM_FALLBACK_MODEL` alone = same-key model swap; `LLM_FALLBACK_PROVIDER` /
  `_BASE_URL` / `_API_KEY` = a fully separate provider; slot 2 follows the
  same rules via `LLM_FALLBACK2_*`, so the app keeps answering whenever ANY
  configured provider has quota). Each fallback attempt runs
  EXACTLY ONCE, only after the primary exhausted its retries, and only for
  provider-availability codes (`allowsFallback`: AI_DAILY_LIMIT, AI_RATE_LIMITED,
  AI_PROVIDER_ERROR, AI_PROVIDER_UNAVAILABLE, AI_UNREACHABLE, AI_EMPTY_RESPONSE)
  AND only when the fallback config is itself fully configured
  (`providers.isConfigured(fallbackCfg)` — an empty/incomplete fallback is never
  called; `providers.allFallbacks()` returns only the configured, key-bearing
  slots in order)
  — a raw 4xx (401/403/404/400) NEVER switches providers even when its mapped
  code is fallbackable (error cache: `err.providerHttpStatus` carries the RAW
  provider status). A spent daily quota is NOT retried on the primary — it goes
  straight to the chain, or surfaces the daily message when none exists. When
  the WHOLE chain fails the surfaced error carries the TRUE cause: a daily-quota
  failure on any side surfaces `AI_DAILY_LIMIT` ("Today's AI provider quota
  has been reached…", `retryable:false`, `usedFallback:true`) — a spent daily
  allowance must never be mislabeled "temporarily unavailable" (that bug put a
  quota error behind the outage wording and invited pointless retries); only
  non-quota chain-fails surface `AI_PROVIDERS_UNAVAILABLE` (502, §10 "AI
  services are temporarily unavailable. Please try again shortly."), tagged
  `usedFallback:true` (lets `chatWithBrowserSearch` degrade to a tool-free
  answer), with `retryable` = true ONLY when EVERY component failure could
  recover (daily-involved -> false). `chat`/`requestCompletion` accept
  `preferProvider`/`preferModel` (resolved against the primary OR any configured
  chain slot, no
  inline fallback when pinned); `ragService` returns the answering provider in
  the chat meta and pins every continuation turn to it, so a long answer that
  survived on the fallback continues on the fallback — never re-probing a dead
  primary (§6/§7/§8). Dev logs: `[AI] Primary provider: <id>` then, on a
  switch, `[AI] Primary provider unavailable: <id> / Fallback provider: <id>`
  plus one `[AI FALLBACK] provider=<id> model=<id>` line per chain slot —
  names only, never keys. `errorMiddleware` now echoes `err.retryable` to the
  client body so both frontends gate the Retry button per-error (chain-failed =
  backend-decided; daily = always off).
  `backend\scripts\dedupLiveTest.js` is the live counterpart (needs the backend
  on :5000 + a real key): register -> POST with requestId R (`200`,
  `deduped:false`, real answer) -> the SAME requestId (`200`, `deduped:true`,
  byte-identical answer and conversationId, no second generation) -> a NEW
  requestId (`deduped:false`, normal traffic unaffected). A spent provider
  quota is reported as SKIP, never FAIL, and the throwaway user + its
  conversations are deleted at the end. Latest live run (2026-10-06, after the
  daily window rolled): **11/11 PASS** — 2ms `deduped:true` replay, byte-identical
  answer, same conversationId.
- `backend\scripts\offlineBugE2E.js` is the chat end-to-end guard for this area
  (13 assertions): register → JWT → `GET /auth/me` → 401 without a token → "hi" →
  "What is Java?" → "explain it simply" (asserts the follow-up is still about Java
  and that history persisted server-side). It needs the backend running and a real
  Groq key, and it is slow. Two free-tier realities are handled explicitly:
  - **Pacing**: one turn costs ~3000-4000 input tokens against an 8000 tokens/min
    limit, so turns are spaced (`AI_PAUSE_MS`, default 30000; the follow-up gets
    1.5x because it carries both prior answers). Set `AI_PAUSE_MS=0` to run fast.
  - **Quota is not a failure**: when the 200000 tokens/day daily cap is spent the
    backend correctly returns 502 `AI_DAILY_LIMIT` / `AI_RATE_LIMITED`, and those
    assertions are reported as SKIP, never FAIL — blaming the app for a spent quota
    would also train us to ignore real regressions. Rate-limit exhaustion of the
    app's own limiter is opt-in via `RUN_LIMIT_TEST=1`, because tripping the
    300-per-15-minutes limiter locks every other endpoint out for 15 minutes.
- The root `scripts\dev.js` launcher supervises the backend: it re-arms the exit
  handler on EVERY respawn (attaching it only to the first child meant one restart
  then permanent silence), and it preflights the port to name the PID already
  holding it. Duplicate/stale backends are surfaced, never worked around by moving
  to another port. It is also the fix for the original outage: the root `npm run
  dev` used to depend on `concurrently`, which was declared in devDependencies but
  never installed (no root `node_modules`, and `npm run setup` never installed
  root deps), so the launcher died instantly, :5000 was never bound, and every
  page reported "Backend server is offline". `dev.js` has ZERO dependencies and
  blocks on a REAL `GET /api/health` 200 before starting the frontend — if the
  API never answers, the frontend is NOT started and the reason is printed.
  `concurrently` is no longer a dependency; do not re-add it.
- Real-browser verification has to go through the Chrome DevTools Protocol (the
  `browser.*` tools are not attached in this environment). Three gotchas: in dev
  the React SPA is served for **every** app route by `spaEntryPlugin()` in
  `frontend\vite.config.js`, so `/` and `/dashboard/career-assistant` both render
  `react-app.html` and a deep link is safe — the legacy single-file demo stays at
  `/index.html` and `/legacy`; headless Chrome freezes the renderer after a
  while, which makes `Runtime.evaluate` hang forever — launch with
  `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
  --disable-background-timer-throttling` and call `Page.bringToFront`
  periodically; and once a few tabs accumulate every non-foreground tab starts
  answering `Runtime.evaluate` with a timeout, so close stale tabs
  (`Target.closeTarget`) before trusting a hang as an app bug.
- **The status pill must never be able to take the API offline.**
  `<BackendStatus />` is rendered in both the dashboard topbar and the assistant
  header, and React 18 StrictMode double-invokes effects, so a per-component
  poller issued a measured **43 `GET /api/health` per 30s (~1290 per 15 min)**
  against a 300-per-15-min global limiter: the API 429'd ~70s after page load and
  then every call, chat included, failed. `BackendStatus.jsx` therefore uses ONE
  module-level singleton poller (30s online / 5s offline, interval chosen from the
  LIVE snapshot — a captured render value is always stale), and `server.js`
  exempts `GET /api/health` from the global rate limiter so a status check can
  never lock out a real request. Do not reintroduce a second poller.
- Live web answers: for current/web intents the assistant calls Groq's built-in
  `browser_search` tool (`services\llmService.js#chatWithBrowserSearch`, a
  2-request round trip that needs the tools array present on both requests)
  when Tavily is not configured; `sources` are sanitized to http(s) and stored
  structured `{title,url,domain,snippet}` on Chat messages. Tavily
  (`services\webSearchService.js`) remains the optional 1-call alternative.
- `services\webSearchService.js` is the optional web-search layer: it is OFF by
  default and answers from the curated verified registry; enabling it needs
  `WEB_SEARCH_PROVIDER` + `WEB_SEARCH_API_KEY` (Tavily) and every result URL is
  sanitized against the same allowlist. Never put search keys in frontend code.
- RAG without embeddings falls back to keyword search, and then to the user's
  full resume + JD text when retrieval legitimately misses (`mode: full-docs`),
  so chat answers stay grounded in uploaded documents.
- Backend and frontend use `.env` files (local, git-ignored); `.env.example`
  files document every setting. Do not commit real credentials.
- AI features are provider-agnostic (OpenAI-compatible endpoints). With no
  `LLM_API_KEY` they return honest 503/config states — do not fake AI success.
  RAG is always scoped to the authenticated user's own resume + job description.
- **The admin system is one protected Main Admin Leader + server-side RBAC, all on the `User` collection.** Roles are `user` / `co_admin` / `main_admin`; authorization is decided ONLY on the server from the DB record loaded by `protect()` (`req.userRecord`), never from JWT claims or the frontend. `adminMiddleware` exposes `requireAdmin`, `requireMainAdmin`, `requirePermission(perm)`, and `requirePasswordChanged`; a fake token role or a hidden/forged frontend control can never grant access. The single Main Admin Leader is bootstrapped from `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` (`utils/seedAdmin.js` → `bootstrapMainAdmin`): bcrypt-hashed, never returned by any API, set to `mustChangePassword` on first login (enforced by middleware, not just the UI), and NEVER overwritten/reset once the account exists. A second `main_admin` can never be created, and the Main Admin Leader can never be deleted, suspended, or demoted by an ordinary user or a co-admin (`PROTECTED_ACCOUNT`, 403). Co-admins are ordinary users promoted via the **request → approval** flow: a request records a reason and grants NO session/permissions; duplicate pending requests are rejected; only the Main Admin Leader approves/rejects; status is Pending/Approved/Rejected/Revoked. Admin sessions are stateless JWTs carrying `av` = `User.adminTokenVersion`; revoking access increments it, instantly invalidating every existing admin token (no server-side session store). Co-admins are ALWAYS blocked from deleting/modifying any administrator and the Main Admin Leader regardless of their permissions, and admin-account deletion is Main-Admin-only. **Dashboard/monitoring show real MongoDB counts only** — no fabricated numbers — and backend health is kept separate from AI-provider health. The audit log is append-only and records safe fields only (actor, action, target id/label, IP/UA, timestamp) — never PII/secrets. No admin response ever exposes a password/hash, OTP secret, JWT secret, provider key, full resume, or chat message body. The legacy separate `Admin` collection / `ADMIN_EMAIL` / `ADMIN_PASSWORD` is left in the DB but authenticates nothing (`/api/admin/login` now resolves `User` roles only).
- **Three admin suites guard the above, and they restore state.** `backend\scripts\adminRbacTest.js` (**23/23** — offline, no server/DB/key) pins the middleware role/permission matrix, main-admin protection, and session-version revocation. `backend\scripts\adminSystemTest.js` (**83/83** — live, needs backend + MongoDB, throwaway users auto-cleaned, Main Admin Leader password/forced-change RESTORED in `finally`) proves bootstrap, forced first-login change, request→approval (incl. concurrent double-approval = exactly one 200 + one 409), RBAC denial, co-admin permissions/revocation, user suspend/restore/delete + cascade, **a blocked user being refused at sign-in (403 `ACCOUNT_BLOCKED`) and a restored user signing in again**, **malformed admin path ids returning 400 `INVALID_ID` instead of a CastError 500**, **a profile-update payload that tries to change role/email/status/permissions being ignored in the response AND in the database**, real stats (**including `totalChats` as a true alias of `totalConversations`**), settings/maintenance mode, append-only audit, secret redaction, and that ordinary chat still works. `backend\scripts\adminUiSmokeTest.js` (**41/41** — real headless Chrome over CDP, needs the frontend on :5173 + backend) drives the built SPA: admin login, forced-password gate, exactly TWO primary dashboard stat cards (**Total Users / Total Chats**), the top-right profile dropdown (**My Profile / Settings / Admin Controls / Logout**), the compact section menu (Dashboard / Users / Admin Controls / Audit Log / Profile & Settings), the consolidated `/admin/controls` page, dashboard search + delete, a **block → status Blocked → unblock → status Active** flow verified against the database, **blocking by email from Admin Controls**, every section route, real user/audit rows, logout redirect, no uncaught runtime errors. The `smokeTest.js` admin section (**77/77** total) now tests the NEW contract: the legacy separate-admin login is rejected, a normal account is told `NOT_ADMIN` + `canRequest`, and it promotes a throwaway co-admin **directly in the database** (there is deliberately no self-service escalation API), signs in, lists users/resumes, asserts a co-admin cannot delete an administrator (`PROTECTED_ACCOUNT`), and cleans up — so `smokeTest.js` now needs MongoDB as well as the backend. Backend rate limits: admin login 10/15 min per IP, admin `/request` 8/15 min — restart the backend to reset before re-running credential-bearing suites.
- **The Main Admin dashboard is focused; Admin Controls is a separate Main-Admin-only page.** `AdminOverview.jsx` renders exactly two real cards (`Total Users`, `Total Chats` from `GET /api/admin/stats`; `totalChats` is a real alias of `totalConversations`) plus a searchable regular-user table with Block/Unblock (confirmation modal) and optional Delete. Blocking reuses the existing `POST /api/admin/users/:id/suspend` / `restore` routes; there is no duplicate endpoint and no block-by-email endpoint — the email form in Admin Controls resolves the account through `GET /api/admin/users?search=&role=user` and then uses the same routes. `/admin/controls` (route guarded `mainOnly`) consolidates the existing `AdminRequests`, `AdminCoAdmins` and `AdminUsers` components via an `embedded` prop instead of duplicating tables. The `admin:refresh` window event refreshes badge counts and the signed-in admin's profile immediately after a mutation. A blocked account receives `403 ACCOUNT_BLOCKED` at login, at `/admin/request`, and on every protected route; role/approval/privilege fields can never be changed from the settings form. Admin path params are validated by `validObjectId` (`400 INVALID_ID`) so a malformed id can never surface as a CastError 500.
- **The maintenance middleware and the settings/usage reads must never hang the API when MongoDB is down.** `middleware\maintenanceMiddleware.js` checks its exempt paths (health, auth, admin, root) BEFORE any DB access, and `services\settingsService.getSettings` + `services\usageService` short-circuit to defaults/zero when `mongoose.connection.readyState !== 1`. A Mongoose query issued while disconnected BUFFERS for ~10s instead of failing, so an unguarded settings read on the hot path would stall EVERY request — `/api/health` included — and make a briefly-disconnected MongoDB look like a dead backend (it broke `portConflictTest` and `corsOfflineTest`). Never read settings/usage unconditionally in middleware before the connection state is checked.
- The skill parser is a shared, curated matcher in
  `backend\services\skillData.js` (`matchSkills` export). Plural-tolerant,
  longest-match-aware; update the dictionary there, not per parser.
- Test users created by the smoke test are cleaned up automatically at the end
  of the run. The OTP email prints to the backend console in dev (console mail
  mode) — that is expected behavior when SMTP is unconfigured.
- **Starting the stack twice is the most common local self-inflicted outage.** A
  second `npm run dev` cannot bind :5000 and logs 20 "Port 5000 is busy" retries;
  the FIRST backend keeps serving, so edits appear to do nothing. Check with
  `netstat -ano | findstr :5000` (Windows) / `lsof -i :5000` (macOS/Linux) and stop
  the extra launcher rather than moving to another port. Related: this project
  lives in a OneDrive-synced folder, which touches files on its own and makes
  nodemon restart the backend unpredictably — a transient
  `SyntaxError: Missing catch or finally after try` in the log is usually nodemon
  reading a half-written file, not a real defect. Re-run before investigating.
  `nodemonConfig.ignore` in `backend\package.json` already excludes
  `scripts/**`, `tests/**` and `coverage/**` so test files cannot bounce the
  server; a mid-run restart of a live suite is healed by `responseQualityTest`'s
  `reauth` recovery rather than failing the case.
- Frontend dev server binds only `[::1]:5173` by default, so use
  `http://localhost:5173` — `http://127.0.0.1:5173` is refused. The in-dev React
  SPA is `/react-app.html`; the chat page is `/dashboard/career-assistant` under
  that document.
