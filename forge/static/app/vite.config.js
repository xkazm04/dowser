import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Forge serves Custom UI from static/app/dist with relative asset paths.
export default defineConfig({ plugins: [react()], base: './', build: { outDir: 'dist', emptyOutDir: true } });
