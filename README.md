# AI Resume & Career Builder

A full-stack, production-ready app that turns a resume + a target job description
into a personal career cockpit: resume analysis, skill-gap insights, a
RAG-based AI career assistant, interview & mock-interview prep, a learning
roadmap, resume rewriting, coding preparation, and a moderation admin panel.

- **Frontend** — React 18 + Vite (SPA), `frontend/`
- **Backend** — Node.js + Express REST API, `backend/`
- **Database** — MongoDB (local for dev, Atlas-ready via `MONGO_URI`), Atlas
  Vector Search used when embedding keys are configured
- **Auth** — JWT access tokens, bcrypt-hashed passwords, 6-digit email OTP for
  password reset (rate limited, hashed, expiring, non-enumerating)

> Honest-by-design: nothing is faked. If an AI key is missing, the app shows a
> clear "AI provider is not configured" state. If MongoDB is down, the API
> reports the connection problem. RAG never answers outside the authenticated
> user's own resume/job knowledge base.

---

## Features

| Area | What it does |
| --- | --- |
| Landing & auth | Marketing landing, register / login / forgot password → OTP → reset |
| Resume upload | PDF / DOCX / TXT parsing (name, contact, skills, projects, experience, education — only what is in the file) |
| Job description | Paste a JD; structured extraction of required/preferred skills, responsibilities, qualifications |
| Analysis | Resume ↔ JD match percentage, matched / missing / preferred / additional skills, ranked next-steps |
| Skill gap | Per-skill gap view with the missing set and priority list |
| AI career assistant | Auto-detecting ChatGPT-style chat (13 intents, never manually selected): RAG over your own resume + JD (Atlas Vector Search when embeddings configured, keyword retrieval otherwise), Groq-native **live web search** (`browser_search`) when the question needs current info — with a real **Sources** list (`{title, url, domain, snippet}`) — and a verified-registry fallback that never invents links. Rich answers: headings/tables/blockquotes, clickable resource cards (LeetCode "Solve" → real `/problems/<slug>/` page, everything else "Open" → new tab). **Code answers are written to work** — shortest clear correct solution, `Explanation / Code / Output / Time and space complexity` structure, code-only when asked — and rendered with **syntax-highlighted code blocks** (language label, light theme, per-block Copy button that copies the exact bytes) plus **Copy / Share / Listen on every answer**. **History sidebar**: meaningful titles (greetings retitle from the first real question), Today/Yesterday/date labels, **search across your titles + messages** (debounced, paginated), **See-more pagination** (no duplicates, hides when exhausted), delete with confirm, newest-activity sorting, and the conversation survives a refresh (`?chat=` URL). In-chat file uploads (+ button & drag & drop: PDF/DOC/DOCX/TXT/images/JD/any supported file), **image vision analysis** (small images are stored as pixels and sent to vision-capable models; previewed as real thumbnails in chat, honest note when the model can't see them), voice **input** (speech recognised live, transcript lands in the composer for you to edit and send) |
| Image generation | Ask for a picture in plain language — "create an image of a red sports car on a beach", "design a poster for my DSA roadmap", "draw a neon city skyline" — and a **real** image is generated **on the backend** and rendered inside the chat bubble. A general natural-language detector (`backend/services/imageIntent.js`) separates three operations: **generate**, **understand** (an uploaded picture → vision analysis, never a generated picture) and **edit** (a reference image). Conversational follow-ups work ("make it at night", "add flying cars", "make it more realistic") because the original request is stored as `basePrompt` and merged — so "it" resolves from history. `View` (lightbox, Escape closes), `Regenerate`, `Share`, `Download`; aspect ratio preserved from the real pixels; "Creating your image…" while it works. Bytes live server-side in `GeneratedImage` and are served only through the JWT-protected, ownership-checked `GET /api/ai/images/:id`, so no provider key or URL ever reaches the browser. See [Image generation](#image-generation) |
| Voice | 🎤 **input**: live speech recognition (Web Speech API) shows interim words while you talk; the final transcript is dropped into the normal composer so you can read, edit and then press Send — it is **never auto-sent**. Browsers without the Web Speech API fall back to MediaRecorder + Groq `whisper-large-v3-turbo` (`POST /api/ai/transcribe`). "No speech detected" is only ever shown when the recogniser genuinely produced no words; a permission / no-microphone / network failure is reported as itself. 🔊 **output**: **Listen** on any AI answer plays it back (Groq TTS mp3 when `LLM_TTS_MODEL` is set, browser `speechSynthesis` always works as fallback) with Pause / Resume / Stop |
| Duplicate protection | Every message carries a frontend-generated `requestId`; the backend dedups it in-memory (`REQUEST_DEDUP_TTL_MS`), so double-clicks / re-renders / client retries can never fire a second LLM call or double-persist history (`deduped: true` in the reply) |
| Resilient errors | Provider 429s read `Retry-After`/rate-limit headers, back off (max 2 retries), then a **fallback chain** — up to two automatic fallback-provider attempts (`LLM_FALLBACK_*` then `LLM_FALLBACK2_*`) — and surface only clean product strings — "The AI is temporarily busy. Please try again shortly." / "I'm having trouble generating that response right now. Please try again." with **Try Again** — never a URL, key, or HTTP status |
| Interview prep | Question banks (+LLM generation when configured), categorized |
| Mock interview | Start a session, answer, get heuristic evaluation (+LLM feedback when configured) |
| Learning roadmap | Phased, topic-level plan generated from the skill gap; track progress |
| Resume improver | Section-by-section rewrite guidance (LLM when configured, deterministic tips otherwise) |
| Coding prep | Problems by topic/difficulty from a curated bank (+LLM when configured) |
| Admin | One protected **Main Admin Leader** (bootstrap, forced first-login password change, can never be deleted/suspended/demoted), server-side RBAC (`user` / `co_admin` / `main_admin`), admin **request → approval** workflow, real-Mongo stats dashboard, user suspension vs. deletion with cascade, co-admin management + session revocation, append-only audit log, monitoring (backend health separate from AI-provider health), settings — no passwords, OTP hashes or chat bodies ever exposed |

---

## Tech stack

- **Frontend:** React 18, React Router 6, Axios, lucide-react icons, plain CSS
  (custom design system with dark theme, toasts, loading/empty states,
  responsive layouts).
- **Backend:** Express 4, Mongoose 8, JSON Web Token, bcryptjs, nodemailer 10,
  multer 2, helmet, express-rate-limit, pdf-parse, mammoth.
- **AI abstraction:** OpenAI-compatible `/chat/completions` + `/embeddings` +
  `/audio/transcriptions` + `/audio/speech` — works with OpenAI, Groq, DeepSeek,
  Together, OpenRouter, and local Ollama. Fully optional; deterministic
  fallbacks keep every feature usable without it. Groq-native `browser_search`
  tool use powers live web answers for current-information questions.
- **Speech input:** the browser Web Speech API
  (`frontend/src/services/speechRecognition.js`) is the primary recogniser;
  MediaRecorder + Groq Whisper is the fallback.
- **Image generation:** a pluggable backend provider layer
  (`backend/services/imageService.js`) supporting `pollinations` (default,
  key-less), `openai`, `gemini` and a clearly-labelled `selftest` test double.
  There is no image key in the frontend and no provider URL in any response.

---

## Project structure

```
├── backend/
│   ├── config/          # DB + mail transport
│   ├── controllers/     # auth, resume, career, chat, interview, admin
│   ├── middleware/      # auth (JWT), admin gate, upload (multer), errors
│   ├── models/          # User, Admin, Resume, JobDescription, Chat, GeneratedImage,
│   │                    # Interview, Roadmap, RAGDocument, OTP
│   ├── routes/          # REST route files
│   ├── scripts/         # smokeTest, realAiTest, intentTest, imageTest,
│   │                    # setupVectorIndex (Atlas), debugSkills
│   ├── services/        # llm, image, imageIntent, embedding, rag, parsing, career,
│   │                    # prompts, email, ...
│   └── server.js
├── frontend/
│   ├── src/
│   │   ├── components/  # layouts, guards, UI primitives
│   │   ├── contexts/    # Auth, Toast
│   │   ├── hooks/       # useAuth, useToast
│   │   ├── pages/       # 20 pages (public + dashboard + admin)
│   │   ├── services/    # API clients (api, chat, voice, speechRecognition, files, ...)
│   │   └── styles/
│   └── vite.config.js
│   frontend/scripts/    # speechCaptureTest.mjs (voice capture unit tests)
├── vercel.json          # frontend deployment (SPA routing)
└── README.md
```

---

## Getting started (local development)

### Prerequisites
- Node.js ≥ 18 (tested on Node 24) and npm
- MongoDB running locally (default `mongodb://localhost:27017`) or an Atlas URI

### 1. Backend

```bash
cd backend
npm install
copy .env.example .env   # Windows) or: cp .env.example .env
npm run dev              # http://localhost:5000
```

`.env` highlights — fill in real values in production:

| Key | Purpose |
| --- | --- |
| `MONGO_URI` | MongoDB connection string (defaults to local in `config/db.js`) |
| `JWT_SECRET` / `JWT_RESET_SECRET` | Long random strings |
| `LLM_API_KEY` | Drives the REAL AI chat. Unset → AI returns an honest 503 ("not configured"). Canonical vars: `LLM_API_KEY` → `LLM_BASE_URL` → `LLM_MODEL`. Accepted aliases with a clear fallback chain: apiKey = `LLM_API_KEY` \|\| `AI_API_KEY` \|\| `GROQ_API_KEY` \|\| `OPENAI_API_KEY`; baseUrl = `LLM_BASE_URL` \|\| `AI_BASE_URL`; model = `LLM_MODEL` \|\| `AI_MODEL` (`LLM_*` wins). Optional `LLM_FALLBACK_*` and `LLM_FALLBACK2_*` (provider/baseUrl/model/apiKey each) add up to two automatic fallback attempts (a chain) when the primary is temporarily down |
| `LLM_VISION` | Set `1` to enable image analysis in chat on vision-capable models (`LLM_VISION_MAX_IMAGE_BYTES` caps stored pixels, default 1.5 MB). Off → attached images get an honest "cannot analyze images" note |
| `IMAGE_PROVIDER` | Image-generation engine: `pollinations` (default, **no key needed**), `openai`, `gemini`, or `selftest` (offline test double — see [Image generation](#image-generation)) |
| `IMAGE_API_KEY` / `IMAGE_MODEL` / `IMAGE_BASE_URL` | Provider key / model / base URL. Only `openai` and `gemini` need a key; `pollinations` works anonymously |
| `EMBEDDING_API_KEY` | Optional. Enables Atlas Vector Search retrieval |
| `EMAIL_USER` / `EMAIL_PASSWORD` | Optional SMTP. Unset → OTPs print to the backend console |
| `INITIAL_ADMIN_NAME` / `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | Bootstraps the single **Main Admin Leader** on startup (bcrypt-hashed; never reset once the account exists; `mustChangePassword` on first login). The legacy `ADMIN_EMAIL` / `ADMIN_PASSWORD` separate `Admin` collection is no longer used by the admin routes |
| `ADMIN_JWT_EXPIRES_IN` | Admin session lifetime (default `8h`); admin JWTs also carry a session version (`av`) so revoking access invalidates existing tokens |

### 2. Frontend

```bash
cd frontend
npm install
copy .env.example .env
npm run dev              # http://localhost:5173
```

`VITE_API_URL` points the SPA at the backend (`http://localhost:5000/api`).

For the Render deployment, set the frontend service variable to
`https://ai-resume-and-career-builder-1.onrender.com/api` and set the backend
service's `CLIENT_URL` and/or `FRONTEND_URL` to the exact deployed frontend
origin. The backend trusts exactly one Render reverse-proxy hop for
`express-rate-limit`; it does not trust arbitrary forwarded proxy chains.

The Main Admin Leader is bootstrapped only from backend environment variables:
`INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, and optionally
`INITIAL_ADMIN_NAME`. If no Main Admin Leader exists, the backend creates one
with the initial password marked for mandatory change. If the configured email
already belongs to an ordinary user, that existing record is promoted once
server-side. If a Main Admin Leader already exists, bootstrap does nothing and
never resets its password. The legacy `ADMIN_*` names remain supported as a
local/backward-compatible fallback, but new Render deployments should use the
`INITIAL_ADMIN_*` names explicitly. Never put these values in frontend code.

In dev every application route (`/`, `/dashboard`, `/dashboard/career-assistant`,
`/react-app.html`) serves the React SPA, so deep links work on a plain reload; the
legacy single-file demo stays available at `/index.html` and `/legacy`. Production
is unaffected — the build still emits `dist/react-app.html`.

### 3. Or run both services with one command

```bash
npm run dev              # from the repo root
```

`scripts/dev.js` starts the backend and **waits for a real `GET /api/health` 200**
— printing the MongoDB and AI-provider state it read from that response — before
it starts the frontend. It then supervises both processes (a crashed service is
restarted automatically) and preflights port 5000 so a second `npm run dev` names
the PID already holding it instead of silently colliding. The launcher has no
dependencies of its own. If the API never answers, the frontend is **not** started
and the real reason is printed, so a dead backend can never masquerade as a
working app.

### 4. Verify

```bash
curl http://localhost:5000/api/health
cd backend  && node scripts/outputRequirementsTest.js  # output-requirement engine (no server needed)
cd backend  && node scripts/chatPathTest.js   # chat path runs without a ReferenceError (no server/key/DB needed)
cd backend  && node scripts/smokeTest.js     # end-to-end API suite (BACKEND must be running)
cd backend  && node scripts/intentTest.js    # image-intent detector unit tests (no server needed)
cd backend  && node scripts/imageTest.js     # image end-to-end suite (BACKEND must be running)
cd backend  && node scripts/responseQualityTest.js  # live "did it fulfil the request?" suite (needs backend + quota)
cd frontend && node scripts/speechCaptureTest.mjs   # voice-capture unit tests (no browser needed)
```

The smoke test exercises: health (incl. `aiProvider` state and the
`services.vision` / `speechToText` / `textToSpeech` / `imageGeneration` /
`imageProvider` statuses), register/login/validation, OTP flow (incl.
non-enumeration), resume upload + parsing, job save + analysis, skill gap, chat
(graceful with and without an AI key), the
`/ai/career-assistant/regenerate` endpoint (re-runs the last question and
replaces the previous answer; 400/404 guards are checked deterministically),
requestId duplicate protection (a repeated requestId is deduped and never fires
a second LLM call — skipped gracefully when no AI key is set), the voice
endpoints (`/api/ai/transcribe` 400/graceful-invalid-audio/401 guards with no
secret leakage, `/api/ai/speech` 400 + graceful 503/audio), the **image
contract** (`services.imageGeneration` reported by health; `POST
/api/ai/generate-image` and `GET /api/ai/images/:id` both 401 without a JWT;
empty prompt → 400; unknown image id → 404; and a plain text question never
returns an image), REAL-AI-only roadmap/coding/interview (honest 503/502 without
a key, real content when one is configured — no question-bank or heuristic
fallbacks), chat history, cross-user isolation, image upload + vision endpoints
(a generated 32x32 PNG — Groq's vision models reject images under 32px per
dimension with a 400 — is stored with `hasImage:true`, `GET /api/files/:id/image`
enforces 200-owner / 401-no-token / 404-other-user, and a chat with the image
attached is handled gracefully with no secret leakage), and the full admin flow
(admin auth boundary → approved co-admin sign-in → stats → users → detail →
server-side RBAC denial → cascade delete).
Latest passing run: **77 passed / 0 failed** (with a Groq key configured; every AI
assertion is graceful-failure safe when no key or quota is available). The
executed total varies slightly because a few assertions only run inside
optional AI-backed branches (regenerate / dedup) that are reached only when the
provider actually answers. The admin section promotes a throwaway co-admin
directly in the database (there is deliberately no self-service escalation API)
and removes it again, so it needs MongoDB as well as the backend.

### Output fulfilment (no silent truncation)

`backend/services/outputRequirements.js` is the single, topic-agnostic place where
a request's **output requirements** are understood. It reads the question and the
recent conversation (pure text — no LLM, no network, no DB) and returns the count,
range, word count, format, code-only flag, and whether this is a follow-up
("10 more", "make it 20"). Nothing is hardcoded per subject: "give 20 Java
projects", "10 LeetCode problems" and "multiplication tables 1 to 100" all go
through the same code path.

Three independent layers protect the answer from being short:

1. **Dynamic budget.** `ragService.pickMaxTokens(intent, req)` sizes the output
   from the request instead of a fixed per-intent table (which used to cap
   `GENERAL` at 600 and `CODING` at 800 tokens — the direct cause of answers that
   stopped mid-list). Floored per intent for the structured-JSON replies, clamped
   to `LLM_MAX_OUTPUT_TOKENS`.
   Measured: `hi` → 700, `what is Java?` → 900, `explain in 100 words` → 1575,
   `1000 words` → 3150, `100 interview questions` → 6700,
   `multiplication tables 1 to 100` → 10200.
2. **A fulfilment directive.** `buildDirective(req)` renders the exact quantity /
   length / format into the system prompt, including a distinctness requirement
   for numbered items ("QUANTITY (mandatory): produce 10 tables — 1 through 10
   inclusive…" / "ONLY the code, no explanation").
3. **Verified completeness + internal continuation.** After the answer comes back,
   `checkCompleteness` counts what was actually delivered. If it is short, or the
   provider reports `finish_reason: "length"`, the service issues an **internal**
   continuation turn (a provider-only message that is never persisted or
   rendered) asking for the missing items, then de-duplicates the seam with
   `mergeContinuation` — so nothing is repeated, numbering is preserved, and the
   user sees one seamless answer when the provider completes it. Bounded by
   `LLM_MAX_CONTINUATIONS` (default 5, hard cap 6) and by a no-growth bail-out.
   If the provider fails or repeats existing content, the saved assistant message
   records that it is incomplete and the chat offers a **Continue response**
   action; partial output is never silently represented as complete.

Timeouts scale with the budget instead of a flat 20 s, so a legitimately large
answer is never killed as "AI unreachable" — see `LLM_LONG_TIMEOUT_MS`,
`LLM_TOKENS_PER_SEC_BUDGET` and `LLM_MAX_OUTPUT_TOKENS` in `.env.example`.

Retrieval is **gated**: RAG runs only for resume / job-description /
document-analysis intents, when documents are attached, or when the question
explicitly refers to "my resume". "hi", "what is Java?" and "explain
polymorphism" are answered from the model's own knowledge with no knowledge-base
block in the prompt, and follow-ups ("give me 10 more", "who is Karri?") keep the
previous answer's context instead of a 1200-character slice of it.

`backend/scripts/outputRequirementsTest.js` is the deterministic suite for this
whole engine — **151 assertions**, no server, key or database needed: quantity
and range detection across phrasings, word-count modes, format selection, the
budget scaling (including the real `pickMaxTokens` path), list markers in every
format a model actually writes (`1.`, `1)`, `20:`, `**1.**`, `### Table 4`) while
rejecting clock times and prose, the completeness check, and the
non-duplicating merge. Latest passing run: **151/151**.

`backend/scripts/chatPathTest.js` (**45/45**, no server / key / DB) monkey-patches
`llmService.chat` and calls `askCareerAssistant` in-process, so an undefined
identifier anywhere in the chat path surfaces as a readable failure instead of a
500 that looks like an offline backend. It also drives the continuation loop
deterministically by feeding the stub a cut-off answer and then its remainder:
it proves the remainder is merged without duplication, that the continuation is
never rendered as a message, that its budget is sized to what is *missing*
(735 tokens for 5 missing items of 100, vs 6700 for the first pass), that the
loop bails out when nothing grows, that a failed continuation keeps the answer
we already have, and that a complete answer costs exactly one call.

`backend/scripts/responseQualityTest.js` is the live end-to-end proof that the
assistant fulfils what was asked: quantity ("20 projects"), a range ("tables 1 to
20", incl. `20x20=400`), a word count ("500 words"), code-only (no prose, closed
fence), a markdown table, no-RAG general questions, plus the follow-ups "give me
10 more", "make it 20" and "who is Karri?". Every assertion re-counts the
delivered items itself instead of trusting a canned answer, and provider 429/5xx
responses are retried with backoff and reported as SKIP rather than FAIL — a spent
daily quota is not a product regression. `SKIP_SLOW=1` runs only the fast cases.

`backend/scripts/intentTest.js` is a fast, deterministic unit suite for the
image-intent detector: 68 assertions covering generation vs understanding vs
edit, text-artifact requests ("Design a poster for my DSA roadmap" is a picture,
not a poster of text), follow-up precedence ("Add flying cars and make it a night
scene" modifies the previous image, while "Draw a cat" starts a new one), prompt
cleaning and the "no empty merge base" guarantee. Latest passing run: **68/68**.

`backend/scripts/imageTest.js` is the image end-to-end suite: real generation
through `POST /api/ai/career-assistant`, prompt/follow-up merging, regenerate,
stored-history replay, ownership isolation on `GET /api/ai/images/:id`, and the
guarantee that text questions never produce images. It retries throttled
providers (`reqWithRetry`) so a free-tier 402/429 does not fail the suite. Latest
passing run: **59/59** against the deterministic `selftest` provider; against
the live `pollinations` anonymous tier every routing/auth/prompt/history/text
assertion passes and only uncached generations fail, because that tier currently
answers HTTP 402 "Insufficient balance" (the app reports this honestly as "The
image provider is busy right now" with a **Try Again** button).

`frontend/scripts/speechCaptureTest.mjs` unit-tests the voice fix with a fake
`SpeechRecognition`: interim+final merge, no duplicated words across repeated
`onresult` events, multi-segment sessions, `onend` after real speech, genuine
silence → "No speech detected", fast tap-and-release recovery, permission /
no-microphone / network errors, and the guarantee that the capture path never
calls `fetch`/`getUserMedia` and never auto-sends. Latest passing run: **50/50**.

`frontend/scripts/legacyChatSessionTest.mjs` covers the legacy page's local
conversation state: unique chat IDs, isolated messages and account namespaces,
restoring the saved active chat after reload, and chat hash routes for
Back/Forward navigation. Run it with `npm run test:legacy-chat` from `frontend/`.

A second, REAL-provider suite lives at `backend/scripts/realAiTest.js`. It
asserts end-to-end against a live provider+backend+MongoDB: register, image
upload + real vision analysis (32x32 PNG built at runtime with zlib/CRC32 — no
deps), a real knowledge answer, LeetCode problem resource cards (all URLs
`https://`), websites answer with resources/sources or inline https links,
latest-AI web-intent answer with sanitized sources, `/regenerate`, and chat
history persistence — then deletes the temp user via the admin API. It paces
calls (`REAL_AI_PAUSE_MS`) and auto-retries `/ai/` calls that hit
`AI_RATE_LIMITED` (`REAL_AI_RETRY_PAUSE_MS`) so free-tier bursts don't flake it:
```bash
cd backend
node scripts/smokeTest.js            # 77 assertions / 0 failures (BACKEND + MongoDB must be running)
$env:REAL_AI_BASE='http://localhost:5050/api'   # point at a non-watched instance
node scripts/realAiTest.js            # real-provider verification (10 checks)
```

The app is an **index.html** SPA (`frontend/index.html`) wired directly to the
REST API — no simulated AI replies anywhere. Real end-to-end chat flow:

- `POST /api/ai/career-assistant` — accepts `{ message, conversationId,
  documentIds, requestId }`; the user id comes from the JWT only, never the body.
  Runs RAG retrieval over the user's own documents + resume/JD, detects the
  intent (13 categories, no manual selection), calls the LLM, and persists the
  conversation. For resource questions the reply includes a sanitized
  `resources` array — `{ title, description, type, difficulty, url }` — where
  every URL is validated against a curated allowlist
  (`backend/services/resourceService.js`). LeetCode links must match a curated
  real-slug list, so a fake/problem URL can never reach the UI; plain-text
  answers work with or without resources. Up to 10 resource cards per answer
  (LeetCode "Solve", everything else "Open" — both open a new tab). Web-intent
  questions return a `sources` array — `{ title, url, domain, snippet }` — from
  the **real** Groq `browser_search` results (or Tavily when configured), all
  URLs sanitized to `https://`/`http://` only.
- `POST /api/ai/career-assistant/regenerate` — re-runs the last user question
  through the same RAG pipeline and **replaces** the previous answer (ChatGPT
  "regenerate" behavior); history stays consistent on success or failure.
- `POST /api/ai/transcribe` — voice input fallback: multipart `audio` → Groq
  `whisper-large-v3-turbo` → `{ transcript }`. The primary input path is the
  browser Web Speech API (see [Voice input](#voice-input)); this endpoint is used
  only when the Web Speech API is unavailable. Either way the transcript goes
  into the composer for the user to edit and send — it is never auto-sent.
- `POST /api/ai/generate-image` — real image generation on the backend
  (JWT-protected): `{ prompt, size?, previousPrompt?, isFollowUp?,
  referenceDocumentId? }` → `{ image: { id, prompt, provider, model, mimeType,
  width, height, isFollowUp } }`. The bytes are **not** in the response.
  `GET /api/ai/images/:id` returns the real image bytes for the owning user only
  (401 without a JWT, 404 for someone else's id). The normal chat endpoint routes
  image requests to the same code path, so a generation request never goes
  through the text-only answer pipeline and a text question never produces an
  image.
- `POST /api/ai/speech` — AI answer voice: `{ text }` → Groq TTS mp3 when
  `LLM_TTS_MODEL` is set; otherwise a clean 503 and the frontend falls back to
  the browser `speechSynthesis` API. Never fake audio, never a provider error.
- Provider resilience (`backend/services/llmService.js`): ~60s per-attempt
  timeout (`LLM_TIMEOUT_MS`), up to 2 retries with a capped backoff
  (`LLM_MAX_RETRIES`) that respects `Retry-After`/rate-limit headers for
  transient failures (network errors, 408/429/5xx), no retries for auth/config
  errors (401/403/404). When the primary is still unavailable after its retries
  and `LLM_FALLBACK_*`/`LLM_FALLBACK2_*` are configured, the fallback CHAIN runs —
  one attempt per slot (primary → slot 1 → slot 2) — before the clean message is returned (provider config is centralized in
  `backend/services/providers.js`). Raw provider URLs/keys are never shown to
  users. The frontend renders exactly two product strings on failure: "The AI is
  temporarily busy. Please try again shortly." (429) or "I'm having trouble
  generating that response right now. Please try again." with a **Try Again**
  button.
- Duplicate protection: the frontend generates a fresh `requestId` per message
  and refuses to send while a request is in flight (button/Enter disabled,
  stale-response guard); the backend dedups `${userId}:${requestId}` for
  `REQUEST_DEDUP_TTL_MS` (default 60s) so a duplicate can never double-call the
  LLM or double-persist chat history.
- Live web answers: when the intent needs current/web info and `LLM_API_KEY` is
  a Groq key, the assistant uses Groq's built-in `browser_search` tool
  (2-call round trip; honest single-call degradation if the tool round trip
  fails — the model re-answers without it, `toolUsed: false`). Tavily
  (`WEB_SEARCH_PROVIDER` + `WEB_SEARCH_API_KEY`) remains the optional
  alternative (1-call pre-search). With neither, the assistant honestly answers
  from its curated verified registry only.
- `POST /api/files/upload` — real PDF/DOC/DOCX/TXT/PNG/JPG/JPEG upload with
  MIME + extension + 10 MB limit (executables/scripts such as `.exe`, `.sh`
  are rejected). PDF (pdf-parse) / DOCX (mammoth) / TXT are genuinely
  extracted; images up to `LLM_VISION_MAX_IMAGE_BYTES` (default 1.5 MB) are
  stored as real pixels (`hasImage: true`) for AI vision analysis — larger
  images get an honest "too large for vision" note instead of pretending.
  `GET /api/files/:id/image` returns the stored bytes (ownership-checked, used
  by the chat UI for real thumbnails).
  Chat uploads use `/api/files/upload` + `/api/files/:id/text` with ownership
  checks; the + button and drag-&-drop attach files to the next message and the
  verbatim text is grounded into the LLM context.
- Image vision in chat: when `LLM_VISION=1` and the primary model actually
  accepts `image_url` content parts, attached images are sent to the LLM as
  `image_url` parts alongside the RAG context — analyzed for real, never
  described as if seen. Which models qualify is provider-aware and verified live
  against Groq: the default `qwen/qwen3.8-27b` accepts images (real 200 +
  grounded pixel analysis; Groq rejects images under 32px per side), while
  `openai/gpt-oss-120b` is TEXT-ONLY on Groq (400 "content must be a string")
  and the old `llama-3.2-11b-vision-preview` is decommissioned (400
  model_decommissioned). So the default configuration analyzes images out of the
  box. When vision is off or the model can't see, the AI is honestly told a file
  was attached but it cannot analyze images, and suggests uploading a PDF/text
  instead.
- Chat history: `GET /api/chat`, `POST /api/chat`, `GET /api/chat/:id`,
  `POST /api/chat/:id/messages`, `DELETE /api/chat/:id` — all user-scoped via
  JWT. Deleting a conversation also deletes the images it owns.

---

## Image generation

Ask for a picture the way you would ask a person. No command, no mode switch, no
special syntax:

```
create an image of a red sports car on a beach
design a poster for my DSA roadmap
draw a neon city skyline at night
make it at night            <- conversational follow-up
add flying cars             <- conversational follow-up
make it more realistic      <- conversational follow-up
```

The picture is generated **on the backend** and rendered in the chat bubble.

### How a request is routed

`backend/services/imageIntent.js` is a general detector — there is no
hard-coded phrase list for "make me an image". For every message it returns one
of three operations, and the controller routes on that:

| Operation | Triggered by | What happens |
| --- | --- | --- |
| `GENERATE` | "create/generate/draw/design/illustrate … a photo/picture/logo/poster/scene of …" | `POST /api/ai/generate-image` / the image branch of the chat endpoint |
| `UNDERSTAND` | "what do you see?", "explain this image", an attached picture | the existing vision path — **never** a generated picture |
| `EDIT` | "make it warmer", "change the background" **plus** an attached image | image-to-image, only on providers that really support a reference image |

Anything else stays a normal text chat. Two rules keep the routing honest:

- A **text artifact** request is still a picture request: *"Design a poster for my
  DSA roadmap"* generates a poster image, it is not answered as text.
- A **question** after an image stays a question: *"Now explain the symbolism."*
  is a text answer, not a new picture.

### Follow-ups resolve "it"

Each generated image stores two prompts: `prompt` (exactly what went to the
provider, including the quality suffix) and `basePrompt` (the subject only). A
follow-up merges the new modification onto **`basePrompt`**, so *"make it at
night"* becomes `a red sports car on a beach, at night, high quality, highly
detailed` — the subject survives, the suffix is never duplicated, and no "it" is
ever sent to a provider. Regenerating an image reuses `basePrompt` too, so it
cannot poison a later follow-up.

### Where the pixels live

- The provider returns real bytes; the backend reads the real pixel dimensions
  (`imageDimensions`, PNG/JPEG/GIF/WebP), stores the image in `GeneratedImage`
  (base64, `select: false`) and writes only metadata into the chat message.
- The browser fetches the bytes itself from
  `GET /api/ai/images/:id` **with its JWT**; the endpoint is
  ownership-scoped, so another user's id is a `404` and no id is a `401`.
- The `<img>` therefore uses a short-lived `blob:` URL. No provider URL, no
  provider key, and no base64 ever reaches the page, and history replays exactly
  the same way as a fresh generation.
- Aspect ratio comes from the stored `width`/`height`, so the picture is never
  squashed, and it is responsive inside the chat bubble.

### Provider configuration

```env
# backend/.env
IMAGE_PROVIDER=pollinations     # pollinations (default, key-less) | openai | gemini | selftest
IMAGE_API_KEY=                  # only for openai / gemini
IMAGE_MODEL=flux                # provider-specific model name
IMAGE_BASE_URL=                 # optional override
IMAGE_SIZE=1024                 # requested edge length in px
IMAGE_TIMEOUT_MS=90000          # per attempt
IMAGE_MAX_RETRIES=2             # transient retries
IMAGE_MAX_BYTES=8388608         # refuse to store anything larger
IMAGE_PROMPT_SUFFIX=high quality, highly detailed   # "" disables
```

| Provider | Key required | Notes |
| --- | --- | --- |
| `pollinations` | no | Default. Anonymous free tier; may answer `402 Insufficient balance`, which is treated as a **throttle** (short backoff, then one honest "The image provider is busy right now" with **Try Again**) |
| `openai` | yes | `IMAGE_API_KEY` + `IMAGE_MODEL` (e.g. `gpt-image-1`); supports image-to-image edit |
| `gemini` | yes | `IMAGE_API_KEY` + `IMAGE_MODEL` (e.g. `gemini-2.5-flash-image`) |
| `selftest` | no | **Test double only.** Renders real PNG bytes in-process so the whole pipeline (routing, auth, storage, rendering, follow-ups) is deterministically verifiable offline/CI. It is never a default and never pretends to be a real model — responses are tagged `provider: "selftest"` and the UI hides the provider name for them. |

`GET /api/health` reports `services.imageGeneration` and `services.imageProvider`
so a deployment can be checked at a glance.

### Errors are honest

`backend/services/imageService.js` maps every failure to a clean product
message and a stable `code`; the frontend (`friendlyError` in
`CareerAssistant.jsx`) renders one specific string per code:
`IMAGE_NOT_CONFIGURED`, `IMAGE_PROVIDER_UNSUPPORTED`, `IMAGE_RATE_LIMITED`,
`IMAGE_SAFETY_BLOCKED`, `IMAGE_EDIT_UNSUPPORTED`, `IMAGE_TOO_LARGE`,
`IMAGE_EMPTY_PROMPT`. Because these all arrive as real HTTP responses, an image
failure can **never** be reported as "backend offline" or "your session expired",
and the session is never cleared because of one. There is no simulated image
anywhere: if no provider is configured you get an honest 503, not a placeholder
picture.

## Voice input

The composer used to record with `MediaRecorder` and post the clip to Whisper.
That fails in exactly the most common case: you speak, release, and the recorder
produces zero (or a too-short) chunk — Whisper returns an empty transcript and
the app says *"I couldn't understand the audio"* even though the microphone heard
you perfectly. The literal string *"No speech detected"* is the Web Speech API's
own `no-speech` error message, which is why the symptom appeared to come from the
recogniser even though the recogniser was never being used.

`frontend/src/services/speechRecognition.js` is now the primary path (it is a
framework-agnostic ES module so it can be unit-tested in Node):

| Event | Behaviour |
| --- | --- |
| `onstart` | live listening begins, the banner appears |
| `onresult` | **interim and final results are both kept.** Interim text is shown live; a final entry is appended to `finalTranscriptRef` exactly once, so repeated `onresult` events never duplicate words |
| `onerror` | `no-speech` is *not* a failure — it is only surfaced when the final transcript is genuinely empty. Permission / no-microphone / network failures are classified (`classifySpeechError`) and reported as themselves |
| `onend` | the browser always ends the session. It is **never** treated as "no speech" when final words already exist — those are delivered. The transcript is never cleared before the final result is used |
| `stop()` | returns the accumulated final transcript to the composer |

The result lands in the **normal composer input**, so you can read it, fix it, and
then press Send yourself. Nothing in the voice path sends a message.
MediaRecorder + Groq `whisper-large-v3-turbo` remains the fallback for browsers
without the Web Speech API.

## Configuration & AI providers

The LLM layer speaks to any OpenAI-compatible endpoint. Canonical config:

```env
# backend/.env
LLM_API_KEY=gsk_...            # your provider key (Groq: console.groq.com/keys)
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=qwen/qwen3.8-27b  # Groq default: FAST (~0.2-0.6s) and VISION-capable
                           # (image analysis works out of the box). For the
                           # text-only reasoning flagship set an explicit
                           # LLM_MODEL=openai/gpt-oss-120b (slow, ~8s/call).
LLM_TIMEOUT_MS=60000           # ~60s per attempt (optional)
LLM_MAX_RETRIES=2              # transient-failure retries (optional)
REQUEST_DEDUP_TTL_MS=60000     # in-memory requestId dedup window (duplicate protection)
# Optional FALLBACK AI providers — automatic CHAIN used ONLY when the primary is
# temporarily unavailable after its retries (rate limits / 5xx / network). Each
# slot must have its OWN key; never reuses the primary silently:
LLM_FALLBACK_PROVIDER=
LLM_FALLBACK_BASE_URL=
LLM_FALLBACK_MODEL=
LLM_FALLBACK_API_KEY=
# Slot 2 of the chain (fully optional): a SECOND independent provider. Same
# rules; an error is shown only when EVERY configured provider fails:
LLM_FALLBACK2_PROVIDER=
LLM_FALLBACK2_BASE_URL=
LLM_FALLBACK2_MODEL=
LLM_FALLBACK2_API_KEY=
# Vision (image analysis in chat): 1 + a vision-CAPABLE model => attached images
# are really analyzed. The default qwen/qwen3.8-27b is vision-capable on Groq
# (verified), so images are analyzed out of the box. gpt-oss-120b = text-only;
# llama-3.2-11b-vision-preview = decommissioned. Otherwise the AI honestly says
# it cannot see them.
LLM_VISION=1
LLM_VISION_MAX_IMAGE_BYTES=1500000  # cap for stored image pixels (raw bytes)
# Voice — speech-to-text uses the same Groq key (default whisper-large-v3-turbo):
LLM_STT_MODEL=whisper-large-v3-turbo
# Text-to-speech for the [ Listen ] button (Groq TTS mp3). Leave EMPTY to use the
# always-available browser speechSynthesis fallback instead.
LLM_TTS_MODEL=
LLM_TTS_VOICE=Sonia
# Optional web search for current/external resources (Tavily; Groq's built-in
# browser_search is used automatically when this is empty and LLM is Groq):
WEB_SEARCH_PROVIDER=           # empty -> browser_search / verified registry
WEB_SEARCH_API_KEY=
```

Groq quick-start: `LLM_PROVIDER=groq`, base URL `https://api.groq.com/openai/v1`,
model `qwen/qwen3.8-27b` — the verified default: fast (~0.2-0.6s per answer),
low token burn (fewer free-tier 429s), and vision-capable (image analysis in
chat works out of the box). `openai/gpt-oss-120b` (text-only reasoning flagship)
remains supported for users who opt into it, but it is notably slower (~8s per
call) and burns the free-tier token budget quickly. Note: Groq moved
`llama-3.3-70b-versatile` to Enterprise tier. On startup the backend safely
prints provider / model / base URL / key-set state, and it probes `GET /models`
in the background so `/api/health` reports `aiProvider: configured | unreachable
| checking | not-configured` plus `aiModelAvailable` (whether `LLM_MODEL` is
valid for your key). Helpers:

```bash
cd backend
node scripts/testLLM.js            # one real call: "Reply with exactly: AI CONNECTION WORKING" (never prints the key)
node scripts/cleanupDemoChats.js   # dev-only: removes old "SIMULATED DEMO REPLY" messages from MongoDB
node scripts/smokeTest.js          # 77 assertions, 0 failures (end-to-end)
node scripts/outputRequirementsTest.js  # 151/151 output-requirement engine checks (no server/key needed)
node scripts/chatPathTest.js       # 73/73 chat-path + continuation checks, stubbed provider (no server/key/DB)
node scripts/providerErrorTest.js  # 168/168 provider-error + fallback-chain + retry-honoring + 413 checks, stubbed fetch (no server/key/DB)
node scripts/responseQualityTest.js # live "did it fulfil the request?" suite (needs quota)
node scripts/intentTest.js         # 68/68 image-intent detector checks (no server needed)
node scripts/imageTest.js          # image end-to-end suite (needs a running backend)
node scripts/realAiTest.js         # REAL-provider verification (needs a working LLM_API_KEY)
```

- No LLM key → chat/roadmap/interview/coding return clear honest 503s. There are
  **no question-bank / template / demo fallbacks** anywhere — if the real provider
  is missing or fails, the app shows the real error instead of a fake answer.
- No embedding key → RAG retrieval falls back to keyword search over the user's
  own chunks; when a query legitimately misses (e.g. "analyze my resume" shares no
  literal tokens with the text), the assistant falls back to the user's FULL
  resume + JD text so answers stay grounded in what was uploaded (`mode:
  full-docs` in the chat meta). To enable vector search on Atlas, create the
  search index and run `node scripts/setupVectorIndex.js`.
- Email without SMTP creds → OTP emails are printed to the backend console.

## Deployment

### Frontend (Render Static Site or Vercel)
1. For Render, create a **Static Site** from this repository with root directory
   `frontend`, build command `npm install && npm run build`, and publish directory
   `dist`. The checked-in `render.yaml` defines this service automatically.
   Vercel is also supported with the existing `vercel.json`.
2. `vercel.json` already sets `buildCommand: npm --prefix frontend run build`,
   `outputDirectory: frontend/dist`, and SPA rewrites to `react-app.html`
   (the React app; the chat-first `index.html` is the local dev interface).
3. Set this environment variable in the frontend hosting dashboard
   (Render/Vercel → Environment Variables):
   `VITE_API_URL=https://<your-render-app>.onrender.com/api`.
   Vite inlines it at build time, so add it **before** each production build.
   This is **required**: a production build without `VITE_API_URL` refuses to
   silently target localhost (see `frontend/src/services/apiBase.js`). Requests
   fail fast with an explicit "no backend API URL configured" state — the UI
   would report the backend as offline until the URL is configured.
   ⚠️ `frontend/.env` (with its `localhost` value) is git-ignored and must never
   be committed; it only affects LOCAL builds.
4. No-rebuild emergency fix: on the deployed page run in the browser console
   `window.APP_API_BASE = 'https://<your-render-app>.onrender.com/api';` and
   press **Retry Connection**. The runtime override is read on every request
   (a reload clears it).

### Backend (Render)
1. Create a Web Service pointing at the repo, root directory `backend`,
   build command `npm install`, start command `npm start`
   (script is `node server.js`, no nodemon).
2. Environment variables (Render → Environment): `MONGODB_URI`, `JWT_SECRET`,
   `JWT_RESET_SECRET`, `LLM_API_KEY`, `LLM_BASE_URL=https://api.groq.com/openai/v1`,
   `LLM_MODEL=qwen/qwen3.8-27b`, `NODE_ENV=production`,
   `CLIENT_URL=https://<your-vercel-app>.vercel.app` and
   `FRONTEND_URL=https://<your-vercel-app>.vercel.app` (CORS accepts either —
   if BOTH are missing in production the backend logs a loud warning and denies
   every browser origin, which the browser surfaces as "Backend server is
   offline"), plus optional `INITIAL_ADMIN_NAME`/`INITIAL_ADMIN_EMAIL`/
   `INITIAL_ADMIN_PASSWORD` and
   `EMAIL_HOST`/`EMAIL_PORT`. Do NOT set `PORT`: Render injects it (the backend
   binds `process.env.PORT || 5000`).
3. The server binds `0.0.0.0:<PORT>` on Render and stays running while the
   MongoDB retry loop attempts recovery. `GET /api/health` returns HTTP 200 only
   when MongoDB is connected and HTTP 503 with the real disconnected state
   otherwise, so Render cannot mark a database-disconnected service healthy.

### Database (MongoDB Atlas)
1. Create a free M0 cluster → Database Access (user) → Network Access (allow
   `0.0.0.0/0` for Render) → connect → copy the SRV string.
2. Set it as `MONGODB_URI` on Render (never commit it). `MONGO_URI` is the
   accepted local alias; `MONGODB_URI` wins for production/spec compliance.
3. Vector search (optional, for real embedding RAG): enable Atlas Search on the
   `ragdocuments` collection with an index on `embedding` (dimensions must match
   `EMBEDDING_MODEL`, e.g. 1536 for text-embedding-3-small) filtered by `userId`,
   then run `node scripts/setupVectorIndex.js` and set `EMBEDDING_API_KEY`/
   `EMBEDDING_BASE_URL`/`EMBEDDING_MODEL` on Render. Without it, RAG uses honest
   keyword retrieval and reports so in `/api/health`.

### AI (Groq)
1. Get a free key at https://console.groq.com/keys → set `LLM_API_KEY` on Render.
2. Keep `LLM_MODEL=qwen/qwen3.8-27b` (fast, vision-capable). For the text-only
   reasoning flagship, set `LLM_MODEL=openai/gpt-oss-120b` explicitly (slower).
   `llama-3.3-70b-versatile` is Enterprise-only. If the model is invalid for
   your key, `/api/health` reports `aiModelAvailable: false`.

### Production verification
1. `GET https://<your-render-app>.onrender.com/api/health` →
   `server: online`, `mongodb: connected`, `aiProvider: configured`.
2. Log in (or sign up) from the deployed Vercel URL, send `Hi`, `What is Java?`,
   upload a resume and ask `Analyze my resume`, then follow up in the same chat.
3. Old simulated/demo content is gone: no template answers exist anywhere, and
   any legitimately old "demo" chats can be purged with
   `cd backend && node scripts/cleanupDemoChats.js` (dev only).

### Verifying the deployed build really targets the backend
A production build must never silently fall back to `localhost` (that fallback
was the root cause of the deployed "Backend server is offline" report). After
`npm --prefix frontend run build`, audit the bundle:

```bash
# With VITE_API_URL set (the required deployed config):
grep -c "localhost:5000" frontend/dist/assets/react-app-*.js   # => 0
grep -c "<your-render-app>.onrender.com/api" frontend/dist/assets/react-app-*.js  # => 1

# With no VITE_API_URL, the build must refuse instead of guessing:
grep -c "__API_BASE_NOT_CONFIGURED__" frontend/dist/assets/react-app-*.js  # => 1
```

The resolution rules live in ONE place: `frontend/src/services/apiBase.js`
(unit-tested by `cd frontend && node scripts/apiBaseTest.mjs`, 23 checks:
`VITE_API_URL` → `window.APP_API_BASE` runtime override → dev localhost →
`sentinel`). `VITE_API_URL` must be set in the Vercel dashboard **before** each
production build.

## Admin access

The whole admin surface lives on the `User` collection. Three roles are enforced
**server-side only** — `user`, `co_admin`, `main_admin` — and the frontend is
never the authority: hiding a button or forging a role in a request body/token
can never grant access. Admin middleware always reads the effective role and
session version from the database record, never from the JWT claims.

- **Main Admin Leader (exactly one).** Bootstrapped from
  `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` (bcrypt-hashed, never returned
  by any API, never reset once the account exists). It must change the password
  on first sign-in (`mustChangePassword`, enforced by backend middleware, not just
  the UI) and can never be deleted, suspended, or demoted by an ordinary user or a
  co-admin.
- **Becoming an admin.** A normal user opens the admin portal at `/admin` (also
  reachable from *Settings → Account → Administrator access*) and submits a
  **request with a reason**. A request by itself grants **no** session and **no**
  permissions; only the Main Admin Leader can approve or reject it, duplicate
  pending requests are rejected, and the request list shows
  Pending/Approved/Rejected/Revoked.
- **Co-admins.** The Main Admin Leader grants fine-grained permissions
  (`manageUsers`, `deleteUsers`, `manageResumes`, `manageRequests`, `viewAudit`,
  `manageSettings`). Revoking access bumps the account's admin session version so
  every existing admin token dies immediately. Co-admins can never delete or
  modify another administrator or the Main Admin Leader — regardless of
  permissions.
- **Dashboard** shows two headline **real-MongoDB** counts only — **Total Users**
  and **Total Conversations** — plus recent sign-ups and recent admin activity.
  Every value is a real count from `GET /api/admin/stats`; nothing is fabricated.
  Backend/provider status (health only, never keys) lives under **Profile &
  Settings → System**, reported separately from AI-provider health. No secrets,
  JWTs, full resumes, or chat message bodies are ever exposed.
- **Audit log** is append-only and records admin actions with safe fields only
  (actor, action, target id/label, IP/UA, timestamp); co-admins who can view it
  cannot alter or delete it.
- **User management** separates suspension (reversible, blocks sign-in) from
  deletion (requires explicit confirmation and cascades to the user's data).
  Admin-account deletion is Main-Admin-only.
- Legacy note: the old separate `Admin` collection and `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` bootstrap are no longer used by `/api/admin`; the document is
  left in place but authenticates nothing.

Sign in at `/admin` (or `/admin/login`). Admin APIs never expose passwords, OTP
hashes, or chat message bodies — all queries are metadata-only.

## Testing & status

See the top of this document for the feature list. The executable suites are:

| Suite | Command | Covers |
| --- | --- | --- |
| API end-to-end | `cd backend && node scripts/smokeTest.js` | 77 assertions over the whole REST surface, including the admin auth boundary + RBAC + cascade delete (needs the backend and MongoDB running) |
| Admin RBAC (offline) | `cd backend && node scripts/adminRbacTest.js` | 23 checks of the server-side role/permission matrix, main-admin protection, and session-version revocation (no server, no DB, no key) |
| Admin E2E (live) | `cd backend && node scripts/adminSystemTest.js` | 77 live checks: bootstrap, forced first-login change, request→approval, RBAC, co-admin revoke, suspend/restore/delete + cascade, real stats, settings/maintenance, audit, redaction (needs the backend + MongoDB; restores the Main Admin Leader) |
| Admin UI (real browser) | `cd backend && node scripts/adminUiSmokeTest.js` | 15 checks driving headless Chrome over CDP through the SPA: login, forced-password gate, exactly two primary dashboard cards (Total Users / Total Conversations), all 5 admin sections, real user/audit rows, logout (needs the frontend dev server + backend; restores the Main Admin Leader) |
| Output requirements | `cd backend && node scripts/outputRequirementsTest.js` | 116 deterministic checks: quantity/range/word-count/format detection, dynamic budget (incl. the real `pickMaxTokens`), list markers, completeness, non-duplicating merge (no server/key/DB) |
| Chat path | `cd backend && node scripts/chatPathTest.js` | 73 checks that `askCareerAssistant` runs end to end with a stubbed provider — no ReferenceError, budget always a usable integer, and the continuation loop merges/bounds/fails safely (no server/key/DB) |
| Response quality (live) | `cd backend && node scripts/responseQualityTest.js` | does it fulfil the request? quantities, ranges, word counts, code-only, tables, no-RAG, follow-ups (needs the backend + provider quota) |
| Image intent | `cd backend && node scripts/intentTest.js` | 68 deterministic checks of the detector |
| Image end-to-end | `cd backend && node scripts/imageTest.js` | generation, follow-ups, regenerate, history, ownership, no-image-for-text |
| Voice capture | `cd frontend && node scripts/speechCaptureTest.mjs` | 50 checks of the speech-capture state machine |
| Port-bind retry | `cd backend && node scripts/portConflictTest.js` | 6 checks that the backend survives a busy port and binds by itself (offline, port 54321) |
| Chat offline E2E | `cd backend && node scripts/offlineBugE2E.js` | 13 checks: register → JWT → 401 → chat → follow-up memory → persisted history (needs the backend + a real key) |
| Real provider | `cd backend && node scripts/realAiTest.js` | live LLM/vision/web verification (needs keys) |
| Production build | `cd frontend && npm run build` | Vite bundle |

### Why the UI never says "offline" for a reachable backend

The status pill answers exactly one question — *did the API respond at all?* —
from `frontend/src/services/healthService.js`:

- **Any** HTTP response proves the server was reached: 200, 401, 429, 500, 502 and
  503 are all reported as **online**, because none of them can exist unless the
  request arrived.
- Only a failure that never produced a response (`ERR_CONNECTION_REFUSED`,
  `ERR_NAME_NOT_RESOLVED`, an aborted or CORS-blocked request) is reported as
  **offline**.
- **Retry Connection** issues that same real `GET /api/health` and updates the
  pill from the real response. It never flips optimistically.
- A 401 clears the session (that is the one genuine auth failure); a 429/500/502/503
  or an AI-provider failure keeps the JWT and shows the real reason. A session is
  never dropped because the AI provider was busy, and an AI failure is never
  dressed up as an outage.

Two supporting fixes keep this honest. `BackendStatus.jsx` runs **one**
module-level health poller for the whole app (it is rendered in two places and
React StrictMode double-invokes effects): the previous per-component poller issued
~1290 health calls per 15 minutes against a 300-per-15-minutes limit, so the API
answered 429 about 70 seconds after page load and then *every* request failed.
`GET /api/health` is additionally exempt from the global rate limiter in
`backend/server.js`, so a status check can never lock out a real request.

Every reported feature is implemented and the suites are green; items that need
external credentials (LLM, Atlas vectors, SMTP, a paid image provider) are
designed to fail loudly with clear guidance instead of faking success.