// Content-Security-Policy of the page (a <meta> in index.html, completed at build time by vite.config.ts).
// The built app (file:// in PIC Studio.app) only runs its own scripts: the bundle, the simulation worker, pdf.js and
// its worker, plus the inline theme script of index.html (allowed by its hash). Nothing is fetched from the network.
// The dev server (npm run dev / app:dev) needs inline scripts (React refresh) and its HMR websocket.
// Pure and DOM-free: used by vite.config.ts (Node) and unit-tested.

export type CspDirectives = Record<string, string[]>;

/** Policy of the built app. `scriptHashes` are 'sha256-…' sources of the inline scripts of index.html. */
export function buildCsp(options: { dev: boolean; scriptHashes?: string[] }): CspDirectives {
  const { dev, scriptHashes = [] } = options;
  return {
    'default-src': ["'self'"],
    'script-src': dev
      ? ["'self'", "'unsafe-inline'"]
      : ["'self'", "'wasm-unsafe-eval'", ...scriptHashes.map((h) => `'${h}'`)],
    // Workers: the simulator and pdf.js (module workers from the app's own files).
    'worker-src': ["'self'", 'blob:'],
    // React style props, CodeMirror and the SVG charts set inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev ? ["'self'", 'ws:', 'wss:', 'http://localhost:*', 'data:', 'blob:'] : ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'data:', 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
}

export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives).map(([name, values]) => [name, ...values].join(' ')).join('; ');
}

/** Bodies of the inline (no src) classic scripts of an HTML document, exactly as the browser hashes them. */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[^"'\s>]+/i.test(attrs)) continue;
    if ((m[2] ?? '').length > 0) scripts.push(m[2] ?? '');
  }
  return scripts;
}

const CSP_META = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;

/** Replace the CSP <meta> of `html` (or insert one right after <meta charset>). */
export function injectCsp(html: string, policy: string): string {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}" />`;
  if (CSP_META.test(html)) return html.replace(CSP_META, tag);
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (charset) return html.replace(charset[0], `${charset[0]}\n    ${tag}`);
  return html.replace(/<head>/i, `<head>\n    ${tag}`);
}
