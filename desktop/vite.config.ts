import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts?(x)'],
  },
});
