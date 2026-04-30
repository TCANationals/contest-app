import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts?(x)'],
  },
});
