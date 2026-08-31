/**
 * Google sign-in, without an authentication library.
 *
 * The standard OAuth 2.0 authorization-code flow, which is about 100 lines when
 * you talk to Google directly:
 *
 *   1. /api/auth/login  → redirect to Google, carrying a signed `state` value
 *   2. Google sends the person back to /api/auth/callback with a one-time code
 *   3. we exchange that code for an ID token, server to server
 *   4. we check the email against the allowlist and issue our own session cookie
 *
 * On verifying the ID token: it arrives over a direct TLS connection to
 * Google's token endpoint, in response to a request carrying our client secret.
 * That channel is the proof of authenticity, so the JWT signature does not need
 * separate checking — but its claims do, and `audience`, `issuer`, `expiry` and
 * `email_verified` are all checked below. (A token that arrived any other way —
 * pasted by a browser, say — would need full signature verification. We never
 * accept one.)
 *
 * Sessions are our own: a compact HMAC-SHA256 signed payload in an HttpOnly,
 * Secure, SameSite=Lax cookie. No session table, so signing out everywhere is a
 * matter of rotating SESSION_SECRET.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'reconciler_session';
const STATE_COOKIE = 'reconciler_oauth_state';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // a working day, then sign in again

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Read the auth configuration from the environment.
 * @returns {{enabled: boolean, clientId: string, clientSecret: string,
 *            secret: string, allowedEmails: string[], allowedDomains: string[], reason?: string}}
 */
export function readAuthConfig(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  const secret = (env.SESSION_SECRET || '').trim();

  const allowedEmails = (env.ALLOWED_EMAILS || '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const allowedDomains = (env.ALLOWED_DOMAINS || '')
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  // Auth is opt-in so `node server.js` on your own machine needs no setup, but
  // a deployment missing half its configuration must fail loudly rather than
  // quietly serving the data to anyone.
  const configured = Boolean(clientId || clientSecret);
  if (!configured) return { enabled: false, clientId, clientSecret, secret, allowedEmails, allowedDomains };

  const missing = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!secret) missing.push('SESSION_SECRET');
  if (!allowedEmails.length && !allowedDomains.length) missing.push('ALLOWED_EMAILS or ALLOWED_DOMAINS');

  return {
    enabled: true,
    clientId,
    clientSecret,
    secret,
    allowedEmails,
    allowedDomains,
    reason: missing.length ? `Missing ${missing.join(', ')}` : undefined,
  };
}

/** Is this email allowed in? */
export function isAllowed(email, config) {
  const address = String(email || '').trim().toLowerCase();
  if (!address.includes('@')) return false;
  if (config.allowedEmails.includes(address)) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return config.allowedDomains.includes(domain);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Compare two signatures without leaking their contents through timing. */
function signatureMatches(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {{email: string, name?: string, picture?: string}} user
 * @returns {string} a signed session token
 */
export function createSessionToken(user, secret, ttlSeconds = SESSION_TTL_SECONDS) {
  const payload = {
    email: String(user.email).toLowerCase(),
    name: user.name || '',
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * @returns {{email: string, name: string, exp: number}|null} null when the
 * token is missing, tampered with, or expired.
 */
export function readSessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  if (!signatureMatches(token.slice(dot + 1), sign(body, secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.email) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const isSecureRequest = (req) =>
  (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket?.encrypted);

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** Where Google should send people back to. */
function redirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URL) return process.env.OAUTH_REDIRECT_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isSecureRequest(req) ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/callback`;
}

/**
 * Who is making this request?
 * @returns {{email: string, name: string}|null}
 */
export function getSession(req, config) {
  if (!config.enabled) return { email: 'local', name: 'Local' };
  const cookies = parseCookies(req.headers.cookie);
  return readSessionToken(cookies[SESSION_COOKIE], config.secret);
}

/** Step 1: send the browser to Google. */
export function handleLogin(req, res, config, url) {
  const nonce = randomBytes(16).toString('base64url');
  // The state is signed and mirrored in a cookie, so a callback that did not
  // start here (a CSRF attempt) cannot be mistaken for one that did.
  const returnTo = url.searchParams.get('next') || '/';
  const state = `${nonce}.${b64url(returnTo)}`;
  const signedState = `${state}.${sign(state, config.secret)}`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: signedState,
    prompt: 'select_account',
    access_type: 'online',
  });
  // Nudge Google to the right account chooser when a single domain is allowed.
  if (config.allowedDomains.length === 1) params.set('hd', config.allowedDomains[0]);

  res.writeHead(302, {
    location: `${GOOGLE_AUTH_URL}?${params}`,
    'set-cookie': cookie(STATE_COOKIE, signedState, { maxAge: 600, secure: isSecureRequest(req) }),
    'cache-control': 'no-store',
  });
  res.end();
}

/** Step 2–4: verify the callback, then issue our own session. */
export async function handleCallback(req, res, config, url) {
  const fail = (message, status = 400) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(signInPage({ error: message }));
  };

  const error = url.searchParams.get('error');
  if (error) return fail(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google returned: ${error}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return fail('That sign-in link was incomplete. Please try again.');

  const cookies = parseCookies(req.headers.cookie);
  if (!cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
    return fail('That sign-in attempt did not start here. Please try again.');
  }
  const lastDot = state.lastIndexOf('.');
  if (!signatureMatches(state.slice(lastDot + 1), sign(state.slice(0, lastDot), config.secret))) {
    return fail('That sign-in attempt could not be verified. Please try again.');
  }

  let profile;
  try {
    profile = await exchangeCode(code, redirectUri(req), config);
  } catch (err) {
    return fail(`Google would not complete the sign-in: ${err.message}`, 502);
  }

  if (!profile.email_verified) return fail('That Google account has no verified email address.', 403);
  if (!isAllowed(profile.email, config)) {
    return fail(`${profile.email} is not on the access list for this dashboard.`, 403);
  }

  let returnTo = '/';
  try {
    const decoded = Buffer.from(state.slice(state.indexOf('.') + 1, lastDot), 'base64url').toString('utf8');
    // Only ever return to a path on this site — never to an absolute URL.
    if (decoded.startsWith('/') && !decoded.startsWith('//')) returnTo = decoded;
  } catch {
    /* keep the default */
  }

  const token = createSessionToken({ email: profile.email, name: profile.name }, config.secret);
  res.writeHead(302, {
    location: returnTo,
    'set-cookie': [
      cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isSecureRequest(req) }),
      cookie(STATE_COOKIE, '', { maxAge: 0, secure: isSecureRequest(req) }),
    ],
    'cache-control': 'no-store',
  });
  res.end();
}

/** Trade the one-time code for an ID token, server to server. */
async function exchangeCode(code, uri, config) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: uri,
      grant_type: 'authorization_code',
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
  if (!body.id_token) throw new Error('no ID token in the response');

  const claims = decodeJwtPayload(body.id_token);
  if (!claims) throw new Error('the ID token could not be read');
  if (claims.aud !== config.clientId) throw new Error('the ID token was issued for a different app');
  if (!/^(https:\/\/)?accounts\.google\.com$/.test(String(claims.iss))) throw new Error('unexpected token issuer');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('the ID token had expired');

  return {
    email: String(claims.email || '').toLowerCase(),
    email_verified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name || '',
  };
}

export function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function handleLogout(req, res) {
  res.writeHead(302, {
    location: '/',
    'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecureRequest(req) }),
    'cache-control': 'no-store',
  });
  res.end();
}

/**
 * The sign-in screen. Deliberately its own tiny page rather than part of the
 * dashboard: nothing about the data should render before someone is let in.
 */
export function signInPage({ error, misconfigured } = {}) {
  const message = misconfigured
    ? `<p class="err"><strong>This deployment is not configured.</strong> ${escapeHtml(misconfigured)}. Set it in your Vercel project settings and redeploy.</p>`
    : error
      ? `<p class="err">${escapeHtml(error)}</p>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · Ticket Reconciler</title>
<style>
  :root { color-scheme: light dark; --bg:#eff0f4; --card:#fff; --text:#14162a; --muted:#5f6488; --line:#dfe1ec; --accent:#3a45c4; --bad:#b93529; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0e16; --card:#161826; --text:#e8eaf6; --muted:#9ba1c4; --line:#272b40; --accent:#838cff; --bad:#ff7f72; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:15px/1.5 "Archivo", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:34px 32px; max-width:420px; width:100%;
          box-shadow:0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.08); }
  h1 { margin:0 0 6px; font-size:13px; letter-spacing:.18em; text-transform:uppercase;
       font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  p { color:var(--muted); margin:0 0 22px; font-size:13.5px; }
  .err { color:var(--bad); border:1px solid var(--bad); background:color-mix(in srgb, var(--bad) 8%, transparent);
         border-radius:8px; padding:10px 12px; margin-bottom:18px; font-size:13px; }
  a.btn { display:flex; align-items:center; justify-content:center; gap:10px; background:var(--accent); color:#fff;
          text-decoration:none; font-weight:600; padding:12px 16px; border-radius:9px; font-size:14px; }
  a.btn:hover { filter:brightness(1.07); }
  .foot { margin:20px 0 0; font-size:12px; }
  svg { width:18px; height:18px; background:#fff; border-radius:2px; }
</style></head>
<body>
  <div class="card">
    <h1>Ticket Reconciler</h1>
    <p>This dashboard holds purchase and card transaction data. Sign in with an approved Google account to continue.</p>
    ${message}
    <a class="btn" href="/api/auth/login" rel="nofollow">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.9-1.5 4.7-4.4 6.6l6.7 5.2c4-3.7 6.7-9.1 6.7-15z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"/><path fill="#EA4335" d="M24 10.6c3.3 0 5.5 1.4 6.7 2.6l5.9-5.8C33 4 29 2 24 2 15.4 2 8.1 7 4.4 14.1l7.1 5.5c1.8-5.3 6.7-9 12.5-9z"/></svg>
      Sign in with Google
    </a>
    <p class="foot">Only accounts on the access list can open this dashboard.</p>
  </div>
</body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
