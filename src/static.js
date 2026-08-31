/**
 * Serving the dashboard's own files — HTML, CSS, the client script.
 *
 * These live in `client/`, deliberately not in `public/`. On Vercel, a
 * directory of static files is handed to the CDN, and the CDN answers before
 * any of this code runs: rewrites are consulted only for paths that did *not*
 * match a file. Keeping the dashboard in `public/` therefore meant `/` was
 * answered by the CDN and the sign-in check never happened — the shell was
 * served to anyone who asked. Nothing in it is secret (every figure on the page
 * arrives later, over /api/*, which does check), but "the leak was harmless"
 * is a poor thing to be relying on. So there is no static directory worth
 * serving, and every request goes through the function, which checks first and
 * reads from disk second.
 *
 * Both servers share this module so the two cannot answer differently.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Where `client/` is.
 *
 * Normally one directory up from this module. But a serverless build makes no
 * promise to leave this module where the repository put it, so the working
 * directory is tried too — the same reason `src/deployment.js` looks in two
 * places for its config.
 */
export function clientDir() {
  const candidates = [fileURLToPath(new URL('../client', import.meta.url)), resolve(process.cwd(), 'client')];
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Not here; try the next one.
    }
  }
  return candidates[0];
}

/**
 * Answer a request for one of the dashboard's files.
 *
 * Call this only once the caller is satisfied the request is allowed — it does
 * no checking of its own beyond refusing to escape the directory.
 */
export async function serveStatic(res, pathname, dir = clientDir()) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(dir, rel));
  // Path traversal guard: the resolved path must stay inside client/.
  if (target !== dir && !target.startsWith(dir + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    // The dashboard is behind a sign-in check, so a shared cache must never
    // keep a copy: `private` for proxies, `no-cache` so browsers revalidate.
    'cache-control': 'private, no-cache',
  });
  createReadStream(target).pipe(res);
}
