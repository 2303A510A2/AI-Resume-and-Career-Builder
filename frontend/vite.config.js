import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Serves the React SPA (react-app.html) for every application route in dev.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The repo has two frontends:
 *   - index.html      -> the legacy single-file demo (opened from file:// via
 *                       VS Code "Go Live"; never part of the Vite build)
 *   - react-app.html  -> the REAL React/Vite SPA (built to dist/react-app.html)
 *
 * Vite's dev server defaults to the ROOT index.html, so `npm run dev` served
 * the LEGACY DEMO at `/`, at `/dashboard`, at `/login` — every single route —
 * and the React SPA was reachable only at the odd-looking `/react-app.html`.
 * A reload after any client-side navigation dropped the developer straight back
 * into the other app. Two different chat/health/error-handling implementations
 * served the same origin, which is exactly how a fixed defect appears to
 * "keep coming back": changes to src/ had no effect on what ran at :5173.
 *
 * This middleware makes `/` and every app route serve the React SPA, so the
 * documented `npm run dev` → http://localhost:5173 flow exercises the real
 * application. The legacy demo is still available, untouched, at
 * `/index.html` and at the friendlier `/legacy`.
 *
 * Production is unaffected: the build still emits dist/react-app.html and
 * vercel.json still rewrites every route to it.
 */
function spaEntryPlugin() {
  // Returns the HTML document a dev request should be served, or null to let
  // Vite handle the request untouched (assets, modules, HMR endpoints).
  const resolveEntry = (rawUrl) => {
    const clean = (rawUrl || '/').split('?')[0].split('#')[0];

    // API REQUESTS ARE NEVER REWRITTEN. This rule must stay first.
    //
    // `/api/health` has no file extension, so the generic "no extension => an
    // app route" rule below used to rewrite it to /react-app.html. That served
    // the SPA's HTML from the backend's URL, so the proxy configured below never
    // ran: a same-origin GET /api/health returned HTML instead of the health
    // JSON. The status pill then could not verify anything, and — because a
    // CORS-blocked cross-origin probe looks exactly the same — a perfectly
    // healthy backend could be reported as offline.
    //
    // Rewriting API traffic to an HTML document is never correct, so this check
    // is unconditional and does not depend on where the proxy points.
    if (clean === '/api' || clean.startsWith('/api/')) return null;

    // The legacy single-file demo stays reachable on purpose: /index.html is its
    // real file and /legacy is a friendlier alias.
    if (clean === '/index.html') return '/index.html';
    if (clean === '/legacy' || clean === '/legacy/') return '/index.html';

    if (!clean || clean === '/') return '/react-app.html';
    // Vite internals, module requests and real assets must pass straight through
    // (rewriting them would break HMR and asset serving).
    if (clean.startsWith('/@')) return null;
    if (clean.startsWith('/src/')) return null;
    if (clean.startsWith('/node_modules/')) return null;
    if (clean.startsWith('/__')) return null;
    // Anything with a file extension is an asset, not an app route.
    if (/\.[a-z0-9]+$/i.test(clean)) return null;
    return '/react-app.html';
  };

  return {
    name: 'spa-entry-react-app',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const entry = resolveEntry(req.url);
        if (!entry || entry === req.url) return next();
        req.url = entry;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), spaEntryPlugin()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin escape hatch for /api. The dev server forwards these to the
      // backend, so a page on :5173 can reach the API WITHOUT a cross-origin
      // request — and therefore without any CORS involvement. That is what makes
      // an honest "is the backend actually up?" check possible from the browser
      // (see getHealthSameOrigin in src/services/healthService.js).
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // The single-file Live Server demo lives at frontend/index.html (never part
    // of this build). The real React/Vite SPA entry is react-app.html: it ships
    // as dist/react-app.html (matching vercel.json's rewrite).
    //
    // NOTE: `build.input` is a no-op in Vite - the input must live under
    // `build.rollupOptions.input` or the root index.html is built instead.
    rollupOptions: {
      input: {
        'react-app': fileURLToPath(new URL('./react-app.html', import.meta.url)),
      },
    },
    outDir: 'dist',
    sourcemap: false,
  },
});
