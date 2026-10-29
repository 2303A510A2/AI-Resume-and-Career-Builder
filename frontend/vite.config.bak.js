import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend talks to the backend via VITE_API_URL (see frontend/.env).
// The dev proxy below is a convenience fallback for local development.
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // The single-file Live Server demo lives at frontend/index.html. The real
    // React/Vite SPA entry was moved to react-app.html so both coexist: this
    // Vite build (and deploy) always ships the React app (as dist/react-app.html,
    // matching vercel.json's rewrite), while index.html opens directly via
    // VS Code "Go Live" with no build step required.
    input: { 'react-app': fileURLToPath(new URL('./react-app.html', import.meta.url)) },
    outDir: 'dist',
    sourcemap: false,
  },
});