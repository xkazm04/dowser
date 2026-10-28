import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Forge serves Custom UI from static/app/dist with relative asset paths.
// VITE_DOWSER_FIXTURE=1 (or `npm run dev:fixture`, i.e. --mode fixture) swaps @forge/bridge for the in-memory fixture (src/dev/bridge.js) so the UI renders
// outside Jira. `vite --mode local` (npm run dev:local) swaps it for src/dev/http-bridge.js instead, which POSTs every
// invoke to the local dowser server (VITE_DOWSER_LOCAL_PORT, default 4710). The two are mutually exclusive.
// Never set either for a build that Forge deploys.
export default defineConfig(({ mode }) => {
  const local = mode === 'local';
  const fixture = !local && (mode === 'fixture'
    || (process.env.VITE_DOWSER_FIXTURE ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_DOWSER_FIXTURE) === '1');
  const stand = (file) => ({ alias: { '@forge/bridge': fileURLToPath(new URL(file, import.meta.url)) } });
  return {
    plugins: [react()],
    base: './',
    build: { outDir: 'dist', emptyOutDir: true },
    resolve: local ? stand('./src/dev/http-bridge.js') : fixture ? stand('./src/dev/bridge.js') : {},
  };
});
