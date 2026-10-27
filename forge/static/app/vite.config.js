import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Forge serves Custom UI from static/app/dist with relative asset paths.
// VITE_DOWSER_FIXTURE=1 (or `npm run dev:fixture`, i.e. --mode fixture) swaps @forge/bridge for the in-memory fixture (src/dev/bridge.js) so the UI renders
// outside Jira. Never set it for a build that Forge deploys.
export default defineConfig(({ mode }) => {
  const fixture = mode === 'fixture'
    || (process.env.VITE_DOWSER_FIXTURE ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_DOWSER_FIXTURE) === '1';
  return {
    plugins: [react()],
    base: './',
    build: { outDir: 'dist', emptyOutDir: true },
    resolve: fixture ? { alias: { '@forge/bridge': fileURLToPath(new URL('./src/dev/bridge.js', import.meta.url)) } } : {},
  };
});
