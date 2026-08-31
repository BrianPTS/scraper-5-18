/**
 * The three routes password mode needs, in one place so the local server and
 * the Vercel function behave identically.
 *
 *   GET  /                     the sign-in form, when there is no session
 *   POST /api/auth/password    check the password, issue a session
 *   GET  /api/auth/logout      throw the session away
 */

import { clearSessionCookie, createSessionToken, readSessionCookie, readSessionToken, requestIsSecure, sessionCookie } from './auth.js';
import { passwordPage, verifyPassword } from './password.js';
import { readBody } from './api.js';

/** @returns {{email: string, name: string}|null} */
export function getPasswordSession(req, deployment) {
  return readSessionToken(readSessionCookie(req), deployment.sessionSecret);
}

/** Serve the sign-in form. */
export function servePasswordPage(req, res, options = {}) {
  res.writeHead(options.status ?? 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(passwordPage(options));
}

/**
 * Check a submitted password. Deliberately vague on failure — "that password
 * was not right" and nothing else, because a more helpful message would only
 * ever help someone guessing.
 */
export async function handlePasswordSubmit(req, res, deployment) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const candidate = form.get('password') || '';
  const requested = form.get('next') || '/';
  // Only ever return to a path on this site, never an absolute URL.
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  if (!(await verifyPassword(candidate, deployment.password))) {
    return servePasswordPage(req, res, { error: 'That password was not right.', next, status: 401 });
  }

  const token = createSessionToken({ email: 'team', name: 'Team' }, deployment.sessionSecret);
  res.writeHead(302, {
    location: next,
    'set-cookie': sessionCookie(token, { secure: requestIsSecure(req) }),
    'cache-control': 'no-store',
  });
  res.end();
}

export function handlePasswordLogout(req, res) {
  res.writeHead(302, {
    location: '/',
    'set-cookie': clearSessionCookie({ secure: requestIsSecure(req) }),
    'cache-control': 'no-store',
  });
  res.end();
}
