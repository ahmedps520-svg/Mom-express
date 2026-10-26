import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
const webRoot = path.resolve('web');

// One id per build. The server reports it too, so an open app can tell when a
// newer version has been deployed.
const builtAt = new Date();
const buildId = `${builtAt.toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Builds the service worker from web/sw.js, filling in this build's id and
 * the files to keep for offline use, and writes version.json for the server.
 */
function serviceWorker(): Plugin {
  const template = () => fs.readFileSync(path.join(webRoot, 'sw.js'), 'utf8');
  const render = (id: string, precache: string[]) =>
    template().replace('__BUILD_ID__', id).replace('__PRECACHE__', JSON.stringify(precache, null, 2));

  return {
    name: 'momexpress-service-worker',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(render('dev', []));
      });
    },
    generateBundle(_options, bundle) {
      const publicFiles = fs
        .readdirSync(path.join(webRoot, 'public'), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => '/' + path.relative(path.join(webRoot, 'public'), path.join(d.parentPath, d.name)).split(path.sep).join('/'));
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && f !== 'index.html')
        // Only the Latin fonts are needed up front; other scripts load on demand.
        .filter((f) => !/\.woff2$/.test(f) || /-latin-wght-normal/.test(f))
        .map((f) => `/${f}`);
      const precache = ['/index.html', ...built, ...publicFiles.filter((f) => !f.endsWith('robots.txt'))];
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: render(buildId, precache) });
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, version: pkg.version, builtAt: builtAt.toISOString() }),
      });
    },
  };
}

export default defineConfig({
  root: webRoot,
  publicDir: path.join(webRoot, 'public'),
  plugins: [react(), serviceWorker()],
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
    proxy: {
      '/api': { target: 'http://localhost:3000' },
    },
  },
});
