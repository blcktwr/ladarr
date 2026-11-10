import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The .env file at the root of the repository holds the server that the proxy calls.
const root = fileURLToPath(new URL('../..', import.meta.url));

// Relative asset paths plus the <base> tag in index.html let the server mount the app under a URL base.
export default defineConfig(({ mode }) => {
  const { LADARR_SERVER_URL = 'http://localhost:3000' } = loadEnv(mode, root, '');
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    // nebula is a workspace package. It must use the copies of these packages that the app uses.
    resolve: { dedupe: ['react', 'react-dom', '@base-ui/react', 'lucide-react'] },
    // A fixed port, because other Vite apps use 5173. With strictPort, Vite stops if the port is busy and does not move to another one.
    server: {
      host: true,
      port: 36590,
      strictPort: true,
      proxy: {
        '/api': {
          target: LADARR_SERVER_URL,
          // The event stream has no end. When the server restarts, the proxy must end the answer of the browser too.
          // Without this end, the page keeps a dead connection and shows no change until the person loads the page again.
          configure: (proxy) =>
            proxy.on('proxyRes', (proxyRes, _req, res) => {
              proxyRes.on('close', () => {
                if (!res.writableEnded) res.end();
              });
            }),
        },
      },
    },
  };
});
