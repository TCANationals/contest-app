import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'TCA Timer',
        short_name: 'TCA Timer',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#111111',
        icons: [],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts?(x)'],
  },
});
