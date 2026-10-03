import { defineConfig } from 'vite';

// Tauri loads the dev server at this fixed port (src-tauri/tauri.conf.json devUrl).
export default defineConfig({
    clearScreen: false,
    server: { port: 5180, strictPort: true },
    build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
