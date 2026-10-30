// Load backend/.env by an explicit path so this works no matter what directory
// `npm run dev` is started from (cd backend, npm --prefix backend, etc.).
// This MUST run before any service reads process.env.LLM_* / MONGO_* / JWT_*.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Express 4 does not forward rejections from async route handlers to the error
// middleware on its own; this patch does (prevents unhandled-rejection crashes,
// e.g. an LLM 503 error thrown by an async controller).
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const os = require('os');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { dbState } = connectDB;
const { seedAdmin } = require('./utils/seedAdmin');
const llmService = require('./services/llmService');
const embeddingService = require('./services/embeddingService');
const webSearchService = require('./services/webSearchService');
const voiceService = require('./services/voiceService');
const imageService = require('./services/imageService');
const maintenanceMode = require('./middleware/maintenanceMiddleware');
const { trackAiUsage } = require('./middleware/aiUsageMiddleware');

const authRoutes = require('./routes/authRoutes');
const resumeRoutes = require('./routes/resumeRoutes');
const careerRoutes = require('./routes/careerRoutes');
const chatRoutes = require('./routes/chatRoutes');
const interviewRoutes = require('./routes/interviewRoutes');
const adminRoutes = require('./routes/adminRoutes');
const fileRoutes = require('./routes/fileRoutes');
const aiRoutes = require('./routes/aiRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { validateAuthConfig } = require('./utils/authConfig');

const app = express();

// Render places one trusted reverse proxy in front of the Node process. Trust
// exactly that hop so Express can derive req.ip for rate limiting from
// X-Forwarded-For without trusting an arbitrary client-supplied proxy chain.
// Do not use `true` here: that would let a caller spoof the address used by
// express-rate-limit and bypass the per-IP limits.
app.set('trust proxy', 1);

// ---- Security middleware ----
app.use(helmet());

// CORS: explicit origin list from CLIENT_URL, plus automatic allowance for any
// origin that points at the DEVELOPER'S OWN MACHINE in development.
//
// WHY THIS IS NOT THE OLD TWO-LINE RULE
// -------------------------------------
// The previous rule allowed only origins whose hostname was literally
// `localhost` or `127.0.0.1`. That is NOT the same machine as every other way a
// developer legitimately reaches it:
//
//   http://<pc-name>:5173          the browser resolves the machine's own name
//   http://<pc-name>.local:5173    mDNS / .local form
//   http://192.168.x.x:5173        LAN address (phone/tablet on the same Wi-Fi)
//   http://legacy.localhost:5500   any *.localhost alias
//
// Each of those was rejected with 403 ON THE PREFLIGHT. The browser hides a
// blocked preflight from JavaScript: fetch rejects with a bare
// `TypeError: Failed to fetch` and NO response object, which is byte-for-byte
// identical to "the server is not running". The app therefore reported
// "Backend server is offline" for requests this process had actually received
// and answered — the exact symptom in the bug report, on a fully healthy
// backend (GET /api/health answering 200 from every non-browser client).
//
// Development therefore now allows every origin that resolves to this machine
// or to a private network, while production still accepts ONLY the origins
// listed in CLIENT_URL/FRONTEND_URL. Authenticated requests still require the
// JWT in the Authorization header, so API access is never open to anonymous
// cross-origin callers, and there is no unrestricted '*' anywhere.
const allowedOrigins = `${process.env.CLIENT_URL || ''},${process.env.FRONTEND_URL || ''}`
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// `localhost`, `127.0.0.1`, `::1`, plus this machine's own hostname(s).
const localHostnames = new Set(
  ['localhost', '127.0.0.1', '0.0.0.0', '::', '::1']
    .concat(os.hostname() || [])
    .concat(String(os.hostname() || '').split('.'))
    .filter(Boolean)
    .map((h) => String(h).trim().toLowerCase())
);

// RFC1918 + link-local IPv4. Deliberately NOT any public address: a site on the
// internet still cannot read this API from a browser.
const PRIVATE_IPV4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * True when `origin` is served by this development machine (or its LAN).
 * Exported for the regression test that locks this rule in place.
 */
function isLocalDevOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // `new URL('http://[::1]:5173').hostname` is '[::1]' on Node.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (localHostnames.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.localdomain')) return true;
  return PRIVATE_IPV4.test(host);
}

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser clients (curl, scripts)
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (process.env.NODE_ENV !== 'production' && (origin === 'null' || isLocalDevOrigin(origin))) {
        return cb(null, true);
      }
      // Reject with a real 403 instead of throwing a bare Error. A bare Error
      // was rendered as HTTP 500 by the error middleware, which made a blocked
      // cross-origin request indistinguishable from a genuine server fault in
      // the logs. The browser still blocks the response (no ACAO header is ever
      // set), but the backend log now states the actual reason.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[CORS] Denied origin ${origin} — it is not this machine or a private address.`);
        console.warn(`[CORS] Add it to CLIENT_URL in backend/.env, or open the app on localhost.`);
      }
      const denied = new Error('Not allowed by CORS');
      denied.statusCode = 403;
      denied.code = 'CORS_ORIGIN_DENIED';
      denied.expose = true;
      denied.isOperational = true;
      return cb(denied);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Request size limits (resume uploads handled separately by multer)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global rate limiter (auth routes get stricter limits)
//
// /api/health is EXCLUDED on purpose. A status poll is not API usage, and the
// measured failure this prevents was severe: the UI polls health, so a poll
// storm could burn the whole 300-request budget within ~70 seconds and then make
// EVERY real call — including POST /api/ai/career-assistant — fail with 429.
// Excluding health means a probe can never take the API offline, so the UI can
// only ever learn the truth about the backend.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const isHealthProbe = (req) =>
  req.method === 'GET' && (req.path === '/api/health' || req.path === '/health');

app.use((req, res, next) => (isHealthProbe(req) ? next() : globalLimiter(req, res, next)));

// Maintenance mode (admin-configurable). Disabled by default; exempts admin,
// auth, health and the root route so the operator can always disable it and
// users can still authenticate.
app.use(maintenanceMode);

// ---- Health ----
app.get('/api/health', async (req, res) => {
  const db = dbState();
  const mongodbConnected = db.connected;
  let ai;
  try {
    ai = await llmService.probeStatus();
  } catch (err) {
    console.error(`[AI HEALTH] provider probe failed category=internal status=-`);
    ai = llmService.providerStatus();
  }
  const payload = {
    success: mongodbConnected,
    status: 'ok',
    server: 'online',
    mongodb: mongodbConnected ? 'connected' : 'disconnected',
    // AI provider state (never the API key): configured | unreachable | checking | not-configured
    aiProvider: ai.status,
    aiProviderName: ai.provider,
    aiProviderBaseUrl: ai.baseUrl,
    aiProviderDetail: ai.detail,
    aiProviderHttpStatus: ai.httpStatus,
    aiProviderErrorCategory: ai.errorCategory,
    message: 'AI Resume Career Builder API is running',
    services: {
      database: mongodbConnected ? 'connected' : 'disconnected',
      llm: ai.status,
      provider: ai.provider,
      providerBaseUrl: ai.baseUrl,
      providerDetail: ai.detail,
      providerHttpStatus: ai.httpStatus,
      providerErrorCategory: ai.errorCategory,
      model: ai.model,
      aiModelAvailable: ai.modelAvailable,
      embeddings: embeddingService.isConfigured() ? 'configured' : 'not-configured',
      webSearch: webSearchService.status(),
      ocr: 'not-configured',
      vision: llmService.isVisionConfigured() ? 'configured' : 'not-configured',
      speechToText: voiceService.isSttConfigured() ? 'configured' : 'not-configured',
      textToSpeech: voiceService.isTtsConfigured() ? 'configured' : 'not-configured',
      imageGeneration: imageService.status(),
      imageProvider: imageService.getConfig().provider,
      imageModel: imageService.getConfig().model,
    },
  };
  // Render must not mark the service ready while its required database is down.
  // The process remains alive so the connection retry loop can heal it.
  res.status(mongodbConnected ? 200 : 503).json(payload);
});

// ---- Routes ----
app.use('/api/auth', authRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/resumes', resumeRoutes); // spec-compatible alias: /api/resumes/upload
app.use('/api/career', careerRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/interview', interviewRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/settings', settingsRoutes);

// ---- Development-only request logging for the AI pipeline ----
//
// This exists to answer ONE question without a debugger: did the browser's
// request actually reach this process, and what came back? The "Backend server
// is offline" report is only ever correct when the request never arrives, so the
// arrival itself is the evidence that settles it.
//
// SAFETY: the Authorization header, the JWT, the API key and the request body
// are NEVER logged. Only the method, the path, whether a Bearer token was
// present, the authenticated user id and the outcome.
// Enable with AI_REQUEST_LOG=1 (or run in development with LOG_AI_REQUESTS=1).
const aiRequestLogEnabled =
  process.env.NODE_ENV !== 'production' &&
  /^(1|true|yes|on)$/i.test(String(process.env.AI_REQUEST_LOG || process.env.LOG_AI_REQUESTS || ''));

if (aiRequestLogEnabled) {
  app.use('/api/ai', (req, res, next) => {
    const started = Date.now();
    const hasAuth = /^Bearer\s+\S+/i.test(req.headers.authorization || '');
    console.log(
      `\n[AI REQUEST]  method: ${req.method}\n` +
        `              path:   ${req.originalUrl}\n` +
        `              authenticated: ${hasAuth}\n` +
        `              origin: ${req.headers.origin || '(none)'}`
    );
    res.on('finish', () => {
      const ms = Date.now() - started;
      const line = `[AI RESPONSE] status: ${res.statusCode} (${ms}ms) ${req.method} ${req.originalUrl}`;
      console.log(res.statusCode >= 400 ? `\n${line}` : line);
      if (res.statusCode >= 400) {
        console.log(`[AI ERROR]    status: ${res.statusCode} ${req.method} ${req.originalUrl}`);
      }
    });
    next();
  });
  console.log('   AI request logging: ON ([AI REQUEST] / [AI RESPONSE] / [AI ERROR])');
}

// Real usage counters for the admin dashboard. Hooked before the router so it
// observes every AI response outcome (success/failure/quota) without altering it.
app.use('/api/ai', trackAiUsage);

// MUST come before the router itself, otherwise the router answers first and
// this logger never runs.
app.use('/api/ai', aiRoutes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'AI Resume & Career Builder API' });
});

// ---- Error handling ----
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    validateAuthConfig();
  } catch (err) {
    console.error(`❌ Authentication configuration invalid: ${err.message}`);
    console.error('   Set the missing variables in the backend service environment and restart it.');
    process.exitCode = 1;
    return;
  }

  // Safe startup diagnostics for the AI provider. The API key is NEVER printed.
  {
    const ai = llmService.describe();
    console.log('── AI provider ─────────────────────────────────────────');
    console.log(`   Provider:    ${ai.provider}`);
    console.log(`   AI API key:  ${ai.apiKeyConfigured ? 'configured' : 'not-configured'}`);
    console.log(`   AI model:    ${ai.model}`);
    console.log(`   AI base URL: ${ai.baseUrl}`);
    if (!ai.apiKeyConfigured && ai.provider !== 'ollama') {
      console.log('   ⚠️  Add LLM_API_KEY=gsk_... to backend/.env to enable REAL AI chat.');
      console.log('   ⚠️  Until then, /api/ai/career-assistant returns an honest 503 — no fake answers.');
    }
    if (ai.baseUrl.includes('groq.com') && /llama-3\.3-70b-versatile/i.test(ai.model)) {
      console.log('   ⚠️  llama-3.3-70b-versatile is Enterprise-only on Groq — free keys need openai/gpt-oss-120b or openai/gpt-oss-20b.');
    }
    console.log('───────────────────────────────────────────────────────');
    const ws = webSearchService.status();
    console.log(`   Web search:  ${ws === 'configured' ? 'ENABLED (' + webSearchService.getConfig().provider + ')' : ws === 'not-configured' ? 'not-configured (verified registry only)' : 'misconfigured — check WEB_SEARCH_PROVIDER / WEB_SEARCH_API_KEY'}`);
    const img = imageService.describe();
    console.log(`   Image gen:   ${img.configured ? 'ENABLED' : 'not-configured'} (provider=${img.provider} model=${img.model} key=${img.apiKeyConfigured ? 'configured' : 'not-configured'})`);
    if (!img.configured) {
      console.log('   ⚠️  Set IMAGE_PROVIDER (+ IMAGE_API_KEY when the provider needs one) in backend/.env to enable real image generation.');
    }
    console.log('───────────────────────────────────────────────────────');
  }

  // Production CORS misconfiguration warning. In production the backend accepts
  // ONLY the origins listed in CLIENT_URL / FRONTEND_URL. If neither is set,
  // every browser request from the deployed frontend is denied on the preflight,
  // which the browser hides as a bare network error — the exact shape of the
  // "Backend server is offline" report against a healthy backend. The server
  // cannot invent the deployed origin, so it names the gap loudly instead.
  {
    const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const corsOrigins = `${process.env.CLIENT_URL || ''},${process.env.FRONTEND_URL || ''}`
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (prod && corsOrigins.length === 0) {
      console.warn('⚠️  NODE_ENV=production but CLIENT_URL / FRONTEND_URL are NOT set.');
      console.warn('   Every request from the deployed frontend origin will be DENIED by CORS and');
      console.warn('   the app will report "Backend server is offline" on a healthy backend.');
      console.warn('   Set CLIENT_URL to the exact deployed frontend origin (e.g. https://my-app.vercel.app)');
      console.warn('   in the hosting dashboard, then restart this service.');
    }
  }

  // The HTTP server starts regardless of MongoDB state. /api/health reflects the
  // real connection status, and config/db.js keeps retrying in the background.
  const db = await connectDB();

  // The Main Admin Leader bootstrap must run against a REAL connection. It is
  // idempotent and owner-authoritative: it creates/repairs only the account at
  // INITIAL_ADMIN_EMAIL, never creates a second leader, and only rewrites the
  // password when the configured value no longer verifies. Previously it ran
  // only when the very first connection attempt succeeded: a Render cold start
  // that reached MongoDB a few seconds late left the deployment with NO Main
  // Admin Leader at all (Admin Sign In then answered 401 forever, until the next
  // manual redeploy).
  const runAdminBootstrap = async () => {
    if (!dbState().connected) return;
    try {
      await seedAdmin();
    } catch (err) {
      console.error('⚠️  Admin seed skipped:', err.message);
    }
  };

  if (db.connected) {
    await runAdminBootstrap();
  } else {
    console.log('⏳ Starting API without MongoDB — /api/health will report mongodb: disconnected until the database is reachable.');
    // Run the bootstrap once, as soon as the background retry loop succeeds.
    mongoose.connection.once('connected', () => {
      runAdminBootstrap();
    });
  }

  // Warm the provider reachability probe in the background. The health route
  // also awaits the coalesced probe when its cache is stale, so it never leaves
  // callers in an indefinite "checking" state.
  if (llmService.isConfigured()) {
    llmService.doProbe().catch(() => {});
  }

  startListening(app, PORT);
};

/**
 * Binds the HTTP server, RETRIES a busy port, and only then gives up loudly.
 *
 * WHY THIS IS THE FIX FOR "Backend server is offline"
 * ---------------------------------------------------
 * The old code called `process.exit(1)` on EADDRINUSE. Under the documented
 * `npm run dev` command that runs nodemon, a non-zero exit puts nodemon into:
 *
 *     [nodemon] app crashed - waiting for file changes before starting...
 *
 * and it NEVER retries on its own. The backend was therefore permanently dead —
 * it looked started in the terminal, the port was momentarily bound, and then
 * nothing listened again until somebody happened to save a file inside a watched
 * folder. Every request in that window (a plain "hi" included) failed to connect,
 * so the UI correctly — and misleadingly — reported "Backend server is offline".
 *
 * A transient conflict is ROUTINE here, not exotic:
 *   - nodemon.json watches config/controllers/middleware/models/routes/services,
 *     so every save restarts the backend and the previous process may not have
 *     released :5000 yet.
 *   - This project lives in a OneDrive-synced folder, which touches files on its
 *     own and makes those restarts unpredictable.
 *   - An orphaned backend from a previous run (or a second copy of this folder)
 *     keeps holding the port.
 *
 * So a busy port is now retried for a bounded window instead of killing the
 * process. A stale holder that frees the port is picked up automatically; a
 * genuinely foreign holder still produces the same precise, actionable error
 * after the window expires.
 */
function startListening(app, port) {
  const maxAttempts = Math.max(1, Number(process.env.PORT_BIND_MAX_ATTEMPTS || 20));
  const retryDelayMs = Math.max(100, Number(process.env.PORT_BIND_RETRY_MS || 1000));
  let attempt = 0;

  const bind = () => {
    attempt += 1;
    const server = app.listen(port, '0.0.0.0');

    server.on('listening', () => {
      if (attempt > 1) {
        console.log(`\n✅ Port ${port} became free — backend bound it on attempt ${attempt}.`);
      }
      console.log(`\n✅ Backend running on http://localhost:${port}`);
      console.log(`   Server running on port ${port}`);
      console.log(`   Health check: http://localhost:${port}/api/health\n`);
    });

    server.on('error', (err) => {
      // ---- Transient port conflict: keep the process alive and retry. ----
      if (err && err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        console.warn(
          `⚠️  Port ${port} is busy (attempt ${attempt}/${maxAttempts}). ` +
            `Retrying in ${retryDelayMs}ms — the backend stays up and binds as soon as the port frees.`
        );
        try {
          server.close(); // never listened; released on close, ignore the error
        } catch {
          /* ERR_SERVER_NOT_RUNNING — nothing to release */
        }
        setTimeout(bind, retryDelayMs);
        return;
      }

      if (err && err.code === 'EADDRINUSE') {
        console.error(`\n❌ Cannot start: port ${port} is still in use after ${attempt} attempt(s).`);
        console.error(`   Another process is holding it, so THIS backend never bound the port`);
        console.error(`   and the UI will keep reporting "Backend server is offline".`);
        console.error('');
        console.error('   Find the process that owns it:');
        console.error(`     Windows:      netstat -ano | findstr :${port}`);
        console.error(`     macOS/Linux:  lsof -i :${port}`);
        console.error('');
        console.error('   If it is an old copy of THIS backend, stop it and retry:');
        console.error(`     Windows:      taskkill /PID <pid> /F`);
        console.error(`     macOS/Linux:  kill <pid>`);
        console.error('');
        console.error(`   Or point this backend at a different port: PORT=5001 npm run dev`);
      } else if (err && err.code === 'EACCES') {
        console.error(`\n❌ Cannot start: not allowed to bind port ${port}.`);
        console.error(`   Use a port above 1024, e.g. PORT=5001 npm run dev`);
      } else {
        console.error(`\n❌ HTTP server error: ${err && err.message ? err.message : err}`);
      }
      // Exit non-zero so nodemon / any supervisor reports a real failure
      // instead of silently pretending the backend is up.
      process.exit(1);
    });

    return server;
  };

  return bind();
}

module.exports = { app, isLocalDevOrigin, allowedOrigins, PORT, start };

// Only auto-start when executed directly (`node server.js` / `npm start` /
// nodemon). `require('../server')` from a test must import the app WITHOUT
// binding a port or opening a MongoDB connection.
if (require.main === module) start();