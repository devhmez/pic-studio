import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildCsp, injectCsp, inlineScripts, serializeCsp } from './src/host/csp';

/**
 * Content-Security-Policy <meta>: strict in the build (own files only, inline theme script allowed by its
 * sha256), relaxed on the dev server (React refresh preamble, HMR websocket).
 */
function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: 'pic-studio-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const scriptHashes = dev
          ? []
          : inlineScripts(html).map((body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
        return injectCsp(html, serializeCsp(buildCsp({ dev, scriptHashes })));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  // Relative URLs everywhere: the Mac app loads the build from file://…/app.asar/app/dist/index.html.
  base: './',
  // Module workers (simulation, pdf.js): same format as the page, loaded relative to it (works under file://).
  worker: { format: 'es' },
  build: {
    // The Mac app runs Chromium 152; the browser version targets current Safari/Chrome/Firefox.
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
  },
  server: { port: 5173, strictPort: true },
});
