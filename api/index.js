/**
 * Vercel entry point — every /api/* request lands here.
 *
 * A serverless function has no disk and no lifetime between requests, so this
 * differs from `server.js` in exactly two ways: the store is Postgres, and
 * there is no Server-Sent Events stream (the browser polls instead). The routes
 * themselves are the same module, so the hosted dashboard and the local one
 * cannot drift apart.
 *
 * Required environment variables, all set in the Vercel dashboard:
 *   DATABASE_URL          Postgres connection string (Neon, from the Vercel marketplace)
 *   GOOGLE_CLIENT_ID      OAuth client from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET
 *   SESSION_SECRET        any long random string; rotating it signs everyone out
 *   ALLOWED_EMAILS        comma-separated addresses, and/or
 *   ALLOWED_DOMAINS       comma-separated domains (e.g. primetimestubs.com)
 */

import { ClientError, handleApi, sendJson } from '../src/api.js';
import {
  getSession,
  handleCallback,
  handleLogin,
  handleLogout,
  readAuthConfig,
  signInPage,
} from '../src/auth.js';
import { PostgresStore } from '../src/store-postgres.js';

const authConfig = readAuthConfig();

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`);

  try {
    // --- refuse to serve anything if this deployment is half-configured -----
    // Better a clear error than a dashboard that quietly lets the world in.
    if (!authConfig.enabled || authConfig.reason) {
      const detail = !authConfig.enabled
        ? 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set'
        : authConfig.reason;
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) {
        return sendJson(res, 503, { error: `This deployment is not configured: ${detail}.` });
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(signInPage({ misconfigured: detail }));
    }

    // --- the sign-in flow, which is the only thing open to the public -------
    if (url.pathname === '/api/auth/login') return handleLogin(req, res, authConfig, url);
    if (url.pathname === '/api/auth/callback') return handleCallback(req, res, authConfig, url);
    if (url.pathname === '/api/auth/logout') return handleLogout(req, res);

    const session = getSession(req, authConfig);
    if (!session) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Please sign in.' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(signInPage());
    }

    if (url.pathname === '/api/me') {
      // `realtime: false` is what tells the dashboard to poll rather than open
      // a stream it would only lose.
      return sendJson(res, 200, { user: session, realtime: false, authEnabled: true });
    }

    // --- everything else needs the workspace loaded ------------------------
    const store = new PostgresStore();
    await store.load();
    await handleApi(req, res, url, { store, realtime: false });
  } catch (err) {
    const status = err instanceof ClientError ? err.status : 500;
    if (status === 500) console.error('[api]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
}
