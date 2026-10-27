import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
const webRoot = path.resolve('web');

// The Supabase project the app talks to. Override with VITE_SUPABASE_URL and
// VITE_SUPABASE_KEY to point a build at another project. The publishable key
// is safe to ship: every table is closed to it (see supabase/migrations).
process.env.VITE_SUPABASE_URL ||= 'https://lmllhebtzizohtimulfs.supabase.co';
process.env.VITE_SUPABASE_KEY ||= 'sb_publishable_xq2Hx_XCa_k7D3E4jUMrrg_-5XDuC3x';
const supabaseHost = new URL(process.env.VITE_SUPABASE_URL).host;

// Where the app is served from: "/" locally, "/Mom-express/" on GitHub Pages.
const base = process.env.BASE_PATH || '/';

// One id per build, so an open app can tell when a newer version is deployed.
const builtAt = new Date();
const buildId = `${builtAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Builds the service worker from web/sw.js, filling in this build's id and
 * the files to keep for offline use. Also writes version.json, and 404.html so
 * that GitHub Pages serves the app for paths like /requests/4.
 */
function serviceWorker(): Plugin {
  const template = () => fs.readFileSync(path.join(webRoot, 'sw.js'), 'utf8');
  const render = (id: string, precache: string[]) =>
    template().replace('__BUILD_ID__', id).replace('__PRECACHE__', JSON.stringify(precache, null, 2));

  return {
    name: 'momexpress-service-worker',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use(`${base}sw.js`, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(render('dev', []));
      });
    },
    generateBundle(_options, bundle) {
      const publicFiles = fs
        .readdirSync(path.join(webRoot, 'public'), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.relative(path.join(webRoot, 'public'), path.join(d.parentPath, d.name)).split(path.sep).join('/'));
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'index.html')
        // Only the Latin fonts are needed up front; other scripts load on demand.
        .filter((f) => !/\.woff2$/.test(f) || /-latin-wght-normal/.test(f));
      // Paths are relative to the service worker's scope.
      const precache = ['index.html', ...built, ...publicFiles.filter((f) => !f.endsWith('robots.txt') && f !== '.nojekyll')];
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: render(buildId, precache) });
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, version: pkg.version, builtAt: builtAt.toISOString() }),
      });
      const html = bundle['index.html'];
      if (html?.type === 'asset') this.emitFile({ type: 'asset', fileName: '404.html', source: html.source });
    },
  };
}

/** A content security policy for the built app: its own files, plus Supabase for data. */
function securityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://${supabaseHost} wss://${supabaseHost}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'momexpress-security-policy',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  root: webRoot,
  base,
  publicDir: path.join(webRoot, 'public'),
  plugins: [react(), serviceWorker(), securityPolicy()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILT_AT__: JSON.stringify(builtAt.toISOString()),
  },
  build: {
    outDir: path.resolve('dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
});
