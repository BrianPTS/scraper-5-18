/**
 * Vercel entry point — every /api/* request lands here.
 *
 * A serverless function has no disk and no lifetime between requests, so this
 * differs from `server.js` in exactly two ways: the store is Postgres, and
 * there is no Server-Sent Events stream (the browser polls instead). The routes
 * themselves are the same module, so the hosted dashboard and the local one
 * cannot drift apart.
 *
 * Always required:
 *   DATABASE_URL          Postgres, set for you when you add a Neon database
 *                         to the Vercel project
 *
 * Required only when the app does its own sign-in (`accessMode: "google"` in
 * deployment.json — see src/deployment.js for the alternative):
 *   GOOGLE_CLIENT_ID      OAuth client from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET
 *   SESSION_SECRET        any long random string; rotating it signs everyone out
 *   ALLOWED_EMAILS        comma-separated addresses, and/or
 *   ALLOWED_DOMAINS       comma-separated domains (e.g. primetimestubs.com)
 *
 * Until whichever set applies is complete, the deployment serves a page of
 * setup instructions and nothing else.
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
import { readDeploymentConfig, setupPage } from '../src/deployment.js';
import {
  getPasswordSession,
  handlePasswordLogout,
  handlePasswordSubmit,
  servePasswordPage,
} from '../src/password-routes.js';
import { PostgresStore } from '../src/store-postgres.js';

const authConfig = readAuthConfig();
const deployment = readDeploymentConfig();

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`);
  const isApi = url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/');
  // Vercel may have parsed a form body already; the password route re-reads it.

  try {
    // --- an unfinished deployment shows what to do, and nothing else -------
    // Better a page of instructions than a dashboard that quietly lets the
    // world in, or one that errors with no hint of why.
    if (!deployment.ready) {
      const detail =
        deployment.blocker === 'auth'
          ? authConfig.reason || 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set'
          : 'DATABASE_URL is not set — no database is connected to this project';

      if (isApi) return sendJson(res, 503, { error: detail, setup: deployment.blocker });
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(setupPage({ blocker: deployment.blocker, detail }));
    }

    // --- who is asking? ----------------------------------------------------
    // In `gateway` mode Vercel already turned away anyone without the password
    // before this code ran, so there is nobody left to check.
    if (deployment.accessMode === 'google') {
      if (url.pathname === '/api/auth/login') return handleLogin(req, res, authConfig, url);
      if (url.pathname === '/api/auth/callback') return handleCallback(req, res, authConfig, url);
      if (url.pathname === '/api/auth/logout') return handleLogout(req, res);

      const session = getSession(req, authConfig);
      if (!session) {
        if (isApi) return sendJson(res, 401, { error: 'Please sign in.' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(signInPage());
      }
      if (url.pathname === '/api/me') {
        // `realtime: false` tells the dashboard to poll rather than open a
        // stream a serverless function could never hold open.
        return sendJson(res, 200, { user: session, realtime: false, authEnabled: true });
      }
    } else if (deployment.accessMode === 'password') {
      if (url.pathname === '/api/auth/password' && req.method === 'POST') {
        return handlePasswordSubmit(req, res, deployment);
      }
      if (url.pathname === '/api/auth/logout') return handlePasswordLogout(req, res);
      // The dashboard bounces an expired session to /api/auth/login. In this
      // mode that is simply the password form.
      if (url.pathname === '/api/auth/login') {
        return servePasswordPage(req, res, { next: url.searchParams.get('next') || '/' });
      }

      const session = getPasswordSession(req, deployment);
      if (!session) {
        if (isApi) return sendJson(res, 401, { error: 'Please sign in.' });
        return servePasswordPage(req, res, { next: url.pathname });
      }
      if (url.pathname === '/api/me') {
        return sendJson(res, 200, { user: session, realtime: false, authEnabled: true, mode: 'password' });
      }
    } else if (url.pathname === '/api/me') {
      return sendJson(res, 200, { user: { email: '', name: '' }, realtime: false, authEnabled: false });
    } else if (url.pathname.startsWith('/api/auth/')) {
      return sendJson(res, 404, { error: 'This deployment does not use Google sign-in.' });
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
