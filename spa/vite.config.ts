import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `process` is available because Vite's config runs under Node, but the
// SPA's tsconfig deliberately doesn't include `@types/node` (the
// runtime is the browser). Declare just the bits we touch so the
// config still type-checks under `tsc -b --noEmit`.
declare const process: { cwd(): string };

// In dev the SPA fetches `/api/...` and opens WebSockets at `/judge`
// and `/contestant`, which on prod sit behind Cloudflare on the same
// origin as the SPA. Locally we point Vite's dev-server proxy at the
// Fastify backend so those same relative URLs reach the server.
//
//   * `VITE_API_PROXY` — base URL of the server, e.g.
//     `http://localhost:3000` for `npm run dev` on the host or
//     `http://server:3000` when the SPA runs in `docker compose`
//     (where `server` is the compose service name).
//   * Falls back to `http://localhost:3000` so a bare `npm run dev`
//     against a host-side server keeps working.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY ?? 'http://localhost:3000';
  const wsTarget = apiTarget.replace(/^http/, 'ws');

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
          navigateFallback: '/index.html',
          // SPA shell: keep recent state accessible while offline (§10.3).
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === 'document',
              handler: 'NetworkFirst',
              options: { cacheName: 'tca-html' },
            },
            {
              urlPattern: ({ request }) =>
                ['script', 'style', 'font', 'image'].includes(request.destination),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'tca-assets' },
            },
          ],
        },
        manifest: {
          name: 'TCA Timer',
          short_name: 'TCA Timer',
          description: 'Judge control surface for the TCA Timer & Help-Call System.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait-primary',
          background_color: '#ffffff',
          theme_color: '#111111',
          icons: [],
        },
      }),
    ],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        // The judge/contestant WebSocket endpoints are mounted at the
        // root by Fastify (see `server/src/ws/{judge,contestant}.ts`).
        // `ws: true` lets Vite's proxy upgrade the connection.
        '/judge': { target: wsTarget, ws: true, changeOrigin: true },
        '/contestant': { target: wsTarget, ws: true, changeOrigin: true },
        // `/healthz` is occasionally useful for connectivity checks from
        // the SPA bundle when debugging.
        '/healthz': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      include: ['test/**/*.test.ts?(x)'],
    },
  };
});
