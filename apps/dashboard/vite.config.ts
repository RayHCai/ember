import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig(({ command }) => {
    // The operator key stays in this process: the proxy adds it, the bundle never sees it.
    const key = process.env.EMBER_OPERATOR_KEY;
    const live = command === 'serve' && process.env.EMBER_LIVE !== '0';
    return {
        plugins: [react(), cesium()],
        define: { __EMBER_LIVE__: JSON.stringify(live) },
        server: {
            port: 5173,
            strictPort: true,
            proxy: live
                ? {
                      '/ember-api': {
                          target: process.env.EMBER_API_URL ?? 'http://localhost:4001',
                          changeOrigin: true,
                          rewrite: (path: string) => path.replace(/^\/ember-api/, ''),
                          headers: key ? { Authorization: `Bearer ${key}` } : undefined,
                      },
                  }
                : undefined,
        },
    };
});
