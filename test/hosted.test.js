/**
 * The hosted deployment: a Postgres-backed store and Google sign-in.
 *
 * The store tests run against a real Postgres if one is reachable — set
 * TEST_DATABASE_URL and they exercise actual SQL, transactions and all. Without
 * one they skip rather than pretend, because a green run against a stub would
 * say nothing about whether the SQL is valid.
 *
 * The auth tests need nothing: session signing, the allowlist and the config
 * checks are pure functions, and they are where the security actually lives.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { parseCsv } from '../src/csv.js';
import { normalizeParsed, parseTimestamp } from '../src/normalize.js';
import {
  createSessionToken,
  decodeJwtPayload,
  isAllowed,
  parseCookies,
  readAuthConfig,
  readSessionToken,
  signInPage,
} from '../src/auth.js';
import { readDeploymentConfig, readDeploymentFile, setupPage } from '../src/deployment.js';

const SAMPLES = join(fileURLToPath(new URL('..', import.meta.url)), 'samples');
const DB = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('who is allowed in', () => {
  const config = {
    allowedEmails: ['brian@primetimestubs.com', 'ops@example.com'],
    allowedDomains: ['primetimestubs.com'],
  };

  test('an allowlisted address is let in', () => {
    assert.equal(isAllowed('ops@example.com', config), true);
    assert.equal(isAllowed('OPS@Example.com', config), true, 'addresses are compared case-insensitively');
  });

  test('any address on an allowed domain is let in', () => {
    assert.equal(isAllowed('someone.else@primetimestubs.com', config), true);
  });

  test('everyone else is refused', () => {
    assert.equal(isAllowed('stranger@gmail.com', config), false);
    assert.equal(isAllowed('', config), false);
    assert.equal(isAllowed(null, config), false);
  });

  test('a lookalike domain does not slip through', () => {
    // The check must compare the domain, not merely find it in the string.
    assert.equal(isAllowed('attacker@primetimestubs.com.evil.net', config), false);
    assert.equal(isAllowed('attacker@notprimetimestubs.com', config), false);
    assert.equal(isAllowed('primetimestubs.com@gmail.com', config), false);
  });

  test('an empty allowlist admits nobody', () => {
    const closed = { allowedEmails: [], allowedDomains: [] };
    assert.equal(isAllowed('anyone@anywhere.com', closed), false);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('session cookies', () => {
  const secret = 'test-secret-value-not-a-real-one';

  test('a freshly issued token reads back', () => {
    const token = createSessionToken({ email: 'Brian@Example.com', name: 'Brian' }, secret);
    const session = readSessionToken(token, secret);
    assert.equal(session.email, 'brian@example.com');
    assert.equal(session.name, 'Brian');
    assert.ok(session.exp > Math.floor(Date.now() / 1000));
  });

  test('a tampered payload is rejected', () => {
    const token = createSessionToken({ email: 'reader@example.com' }, secret);
    const [body, signature] = token.split('.');

    // Swap in a different email while keeping the original signature.
    const forgedBody = Buffer.from(JSON.stringify({ email: 'admin@example.com', exp: 9999999999 })).toString(
      'base64url',
    );
    assert.equal(readSessionToken(`${forgedBody}.${signature}`, secret), null);
    assert.equal(readSessionToken(`${body}.${signature}x`, secret), null);
    assert.equal(readSessionToken(`${body}.`, secret), null);
  });

  test('a token signed with another secret is rejected', () => {
    const token = createSessionToken({ email: 'brian@example.com' }, 'a-different-secret');
    assert.equal(readSessionToken(token, secret), null);
  });

  test('an expired token is rejected', () => {
    const token = createSessionToken({ email: 'brian@example.com' }, secret, -60);
    assert.equal(readSessionToken(token, secret), null);
  });

  test('nonsense is rejected without throwing', () => {
    for (const bad of ['', null, undefined, 'not-a-token', 'a.b.c.d', '....']) {
      assert.equal(readSessionToken(bad, secret), null);
    }
  });

  test('cookies are parsed, including values with = in them', () => {
    const jar = parseCookies('a=1; reconciler_session=abc.def%3D%3D; other=x');
    assert.equal(jar.a, '1');
    assert.equal(jar.reconciler_session, 'abc.def==');
    assert.deepEqual(parseCookies(''), {});
    assert.deepEqual(parseCookies(undefined), {});
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('deployment configuration', () => {
  test('no Google credentials at all means auth is simply off (local use)', () => {
    const config = readAuthConfig({});
    assert.equal(config.enabled, false);
  });

  test('half-configured is reported, never silently open', () => {
    const config = readAuthConfig({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' });
    assert.equal(config.enabled, true);
    assert.match(config.reason, /GOOGLE_CLIENT_SECRET/);
    assert.match(config.reason, /SESSION_SECRET/);
    assert.match(config.reason, /ALLOWED_EMAILS/);
  });

  test('a complete configuration has nothing to report', () => {
    const config = readAuthConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'long-random-string',
      ALLOWED_DOMAINS: '@primetimestubs.com, example.com',
    });
    assert.equal(config.enabled, true);
    assert.equal(config.reason, undefined);
    assert.deepEqual(config.allowedDomains, ['primetimestubs.com', 'example.com']);
  });

  test('an allowlist with only emails is enough', () => {
    const config = readAuthConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'x',
      ALLOWED_EMAILS: 'a@b.com,c@d.com',
    });
    assert.equal(config.reason, undefined);
    assert.deepEqual(config.allowedEmails, ['a@b.com', 'c@d.com']);
  });
});

test('the sign-in page escapes whatever it is handed', () => {
  const page = signInPage({ error: '<script>alert(1)</script>' });
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
});

test('a JWT payload is read without trusting it', () => {
  const payload = { email: 'a@b.com', aud: 'client-id' };
  const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  assert.deepEqual(decodeJwtPayload(token), payload);
  assert.equal(decodeJwtPayload('nonsense'), null);
});

// ---------------------------------------------------------------------------
// Is the deployment finished, and what is guarding it?
// ---------------------------------------------------------------------------

describe('deployment readiness', () => {
  test('a bare deployment refuses to serve, and says why', () => {
    const config = readDeploymentConfig({}, {});
    assert.equal(config.ready, false);
    assert.equal(config.blocker, 'auth', 'with nothing configured, the door is the first problem');
  });

  test('sign-in configured but no database is still not ready', () => {
    const config = readDeploymentConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }, {});
    assert.equal(config.ready, false);
    assert.equal(config.blocker, 'database');
  });

  test('both present is ready', () => {
    const config = readDeploymentConfig(
      { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', DATABASE_URL: 'postgres://x' },
      {},
    );
    assert.equal(config.ready, true);
    assert.equal(config.accessMode, 'google');
  });

  test('gateway mode needs a database but no credentials', () => {
    // Vercel's own password protection turns people away before the app runs,
    // so there is nothing for the app to check — but it still needs somewhere
    // to keep the data.
    assert.equal(readDeploymentConfig({}, { accessMode: 'gateway' }).blocker, 'database');
    const ready = readDeploymentConfig({ DATABASE_URL: 'postgres://x' }, { accessMode: 'gateway' });
    assert.equal(ready.ready, true);
    assert.equal(ready.accessMode, 'gateway');
  });

  test('gateway mode cannot be reached by accident', () => {
    // Anything other than the exact declaration leaves the app doing its own
    // checking, which fails closed rather than open.
    for (const file of [{}, { accessMode: '' }, { accessMode: 'none' }, { accessMode: 'open' }, { accessMode: true }]) {
      assert.equal(readDeploymentConfig({ DATABASE_URL: 'x' }, file).accessMode, 'google');
      assert.equal(readDeploymentConfig({ DATABASE_URL: 'x' }, file).ready, false);
    }
  });

  test('real Google credentials override a gateway declaration', () => {
    const config = readDeploymentConfig(
      { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', DATABASE_URL: 'x' },
      { accessMode: 'gateway' },
    );
    assert.equal(config.accessMode, 'google', 'the stronger check wins');
  });

  test('the setup page tells you which button to press', () => {
    const page = setupPage({ blocker: 'database' });
    assert.match(page, /Storage/);
    assert.match(page, /Create Database/);
    assert.match(page, /Neon/);
    assert.ok(!page.includes('<script'), 'the setup page runs nothing');
  });

  test('the setup page escapes the detail it is handed', () => {
    const page = setupPage({ blocker: 'database', detail: '<img src=x onerror=alert(1)>' });
    assert.ok(!page.includes('<img src=x'));
    assert.match(page, /&lt;img/);
  });

  test("the committed deployment.json is valid and fails closed", () => {
    const config = readDeploymentConfig({}, readDeploymentFile());
    assert.ok(['google', 'gateway'].includes(config.accessMode));
    assert.equal(config.ready, false, 'nothing is configured in a test environment, so it must refuse');
  });
});

// ---------------------------------------------------------------------------
// The Postgres store
// ---------------------------------------------------------------------------

describe('postgres store', { skip: DB ? false : 'set TEST_DATABASE_URL to run these' }, () => {
  let PostgresStore;
  let resetPool;
  const workspace = `test_${Date.now()}`;

  before(async () => {
    ({ PostgresStore, resetPool } = await import('../src/store-postgres.js'));
  });

  after(async () => {
    if (!resetPool) return;
    const store = new PostgresStore({ connectionString: DB, workspace });
    await store.query('delete from purchases where workspace = $1', [workspace]).catch(() => {});
    await store.query('delete from charges where workspace = $1', [workspace]).catch(() => {});
    await store.query('delete from documents where workspace = $1', [workspace]).catch(() => {});
    await resetPool();
  });

  const freshStore = async () => {
    const store = new PostgresStore({ connectionString: DB, workspace });
    await store.load();
    return store;
  };

  const samples = async () => {
    const purchases = normalizeParsed(parseCsv(await readFile(join(SAMPLES, 'sample-inventory.csv'), 'utf8')));
    const charges = normalizeParsed(parseCsv(await readFile(join(SAMPLES, 'sample-transactions.csv'), 'utf8')));
    return { purchases: purchases.records, charges: charges.records };
  };

  test('creates its own schema on first use', async () => {
    const store = await freshStore();
    assert.deepEqual(store.purchases(), []);
    assert.deepEqual(store.charges(), []);
  });

  test('imported rows survive a completely new process', async () => {
    // This is the whole point of the hosted store: the next request is a
    // different function instance with no memory of this one.
    const { purchases, charges } = await samples();
    const writer = await freshStore();
    writer.upsert('purchases', purchases);
    writer.upsert('charges', charges);
    await writer.save('test');

    const reader = await freshStore();
    assert.equal(reader.purchases().length, 10);
    assert.equal(reader.charges().length, 12);

    const po = reader.purchases().find((p) => p.id === '500001');
    assert.equal(po.amount, 205.89);
    assert.equal(po.vendor, 'TicketMaster');
    assert.equal(po.paymentState, 'Paid');
    assert.equal(
      po.purchasedAt,
      parseTimestamp('8/26/2026 4:50:13 PM +00:00'),
      'timestamps must survive the round trip as numbers, not become strings',
    );
    assert.equal(typeof po.purchasedAt, 'number');
  });

  test('re-importing updates in place rather than duplicating', async () => {
    const { purchases } = await samples();
    const store = await freshStore();
    const result = store.upsert('purchases', purchases);
    assert.equal(result.added, 0);
    assert.equal(result.updated, 10);
    await store.save('test');

    const reader = await freshStore();
    assert.equal(reader.purchases().length, 10);
  });

  test('settings and manual links persist', async () => {
    const store = await freshStore();
    store.updateSettings({ timeWindowMinutes: 90, requireLast4: true });
    store.link('500003', 'tx_sample_10', 'checked by hand');
    store.setIgnored('charge', 'tx_sample_11', true);
    await store.save('test');

    const reader = await freshStore();
    assert.equal(reader.settings.timeWindowMinutes, 90);
    assert.equal(reader.settings.requireLast4, true);
    assert.equal(reader.overrides.links.length, 1);
    assert.equal(reader.overrides.links[0].purchaseId, '500003');
    assert.deepEqual(reader.overrides.ignoredCharges, ['tx_sample_11']);

    // Put the defaults back for the tests that follow.
    reader.updateSettings({ timeWindowMinutes: 240, requireLast4: false });
    reader.unlinkPurchase('500003');
    reader.setIgnored('charge', 'tx_sample_11', false);
    await reader.save('test');
  });

  test('the cross-export PO eviction reaches the database', async () => {
    const poExport = normalizeParsed(parseCsv(await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8')));
    const store = await freshStore();
    const result = store.upsert('purchases', poExport.records);
    assert.equal(result.replaced, 9);
    await store.save('test');

    const reader = await freshStore();
    const ids = reader.purchases().map((p) => p.id).sort();
    // The nine inventory rows are gone, replaced by their per-ticket versions;
    // 500011 had no counterpart in that file and stays.
    assert.ok(ids.includes('500011'));
    assert.ok(!ids.includes('500001'), 'the inventory copy of PO 500001 should be gone');
    const poIds = reader.purchases().map((p) => p.poId).filter(Boolean);
    assert.equal(new Set(poIds).size, poIds.length, 'no purchase order may appear twice');
  });

  test('two workspaces cannot see each other', async () => {
    const other = new PostgresStore({ connectionString: DB, workspace: `${workspace}_other` });
    await other.load();
    assert.equal(other.purchases().length, 0);

    const { charges } = await samples();
    other.upsert('charges', charges.slice(0, 2));
    await other.save('test');

    const mine = await freshStore();
    assert.equal(mine.charges().length, 12, 'the other workspace must not leak in');

    await other.query('delete from charges where workspace = $1', [`${workspace}_other`]);
  });

  test('clearing removes the rows from the database, not just from memory', async () => {
    const store = await freshStore();
    store.clearData();
    await store.save('test');

    const reader = await freshStore();
    assert.equal(reader.purchases().length, 0);
    assert.equal(reader.charges().length, 0);
    assert.deepEqual(reader.overrides.links, []);
  });

  test('a failed write leaves the previous data intact', async () => {
    const { purchases } = await samples();
    const store = await freshStore();
    store.upsert('purchases', purchases);
    await store.save('test');

    // Force a failure mid-transaction by corrupting one record into something
    // that cannot be serialized, and confirm the earlier rows are still there.
    const broken = await freshStore();
    broken.upsert('purchases', [{ id: 'bad', poId: '', source: 'inventory', day: '2026-08-26' }]);
    broken.data.purchases.bad.self = broken.data.purchases.bad; // circular
    await assert.rejects(() => broken.save('test'));

    const reader = await freshStore();
    assert.equal(reader.purchases().length, 10, 'the good rows must still be there');
    assert.ok(!reader.purchases().some((p) => p.id === 'bad'));
  });
});

// ---------------------------------------------------------------------------
// The gate itself, over real HTTP
// ---------------------------------------------------------------------------

describe('a server with sign-in switched on', () => {
  let child;
  let baseUrl;
  let workDir;

  const SECRET = 'test-session-secret';

  before(async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const ROOT = fileURLToPath(new URL('..', import.meta.url));

    workDir = await mkdtemp(join(tmpdir(), 'reconciler-auth-'));
    child = spawn(process.execPath, [join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        STORE_FILE: join(workDir, 'store.json'),
        INBOX_DIR: join(workDir, 'inbox'),
        GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
        SESSION_SECRET: SECRET,
        ALLOWED_DOMAINS: 'primetimestubs.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    baseUrl = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('server did not start')), 10_000);
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/http:\/\/[\d.]+:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolvePromise(match[0]);
        }
      });
      child.stderr.on('data', (chunk) => process.stderr.write(`[auth-server] ${chunk}`));
      child.on('exit', (code) => rejectPromise(new Error(`server exited: ${code}`)));
    });
  });

  after(async () => {
    child?.kill('SIGTERM');
    if (workDir) {
      const { rm } = await import('node:fs/promises');
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('every data route refuses an anonymous request', async () => {
    for (const path of ['/api/report', '/api/export', '/api/me']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} should be refused`);
    }
    for (const [path, body] of [
      ['/api/import', { files: [{ filename: 'x.csv', text: 'a,b\n1,2\n' }] }],
      ['/api/link', { purchaseId: '1', chargeId: '2' }],
      ['/api/reset', {}],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 401, `${path} should be refused`);
    }
  });

  test('the front page is the sign-in screen, with no data on it', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sign in with Google/);
    assert.ok(!html.includes('Import CSV'), 'the dashboard shell must not render before sign-in');
  });

  test('sign-in sends the browser to Google with the right request', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);

    const target = new URL(res.headers.get('location'));
    assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(target.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
    assert.equal(target.searchParams.get('response_type'), 'code');
    assert.equal(target.searchParams.get('scope'), 'openid email profile');
    assert.equal(target.searchParams.get('hd'), 'primetimestubs.com');
    assert.match(target.searchParams.get('redirect_uri'), /\/api\/auth\/callback$/);

    // The state must be pinned to a cookie, or the callback could be forged.
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /reconciler_oauth_state=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('a callback that did not start here is refused', async () => {
    const res = await fetch(`${baseUrl}/api/auth/callback?code=stolen&state=made-up`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /did not start here/);
  });

  test('a valid session cookie opens the door', async () => {
    const token = createSessionToken({ email: 'brian@primetimestubs.com' }, SECRET);
    const res = await fetch(`${baseUrl}/api/me`, { headers: { cookie: `reconciler_session=${token}` } });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.user.email, 'brian@primetimestubs.com');
    assert.equal(body.realtime, true, 'the local server can stream');
    assert.equal(body.authEnabled, true);
  });

  test('a forged session cookie does not', async () => {
    const forged = createSessionToken({ email: 'attacker@evil.com' }, 'the-wrong-secret');
    const res = await fetch(`${baseUrl}/api/report`, { headers: { cookie: `reconciler_session=${forged}` } });
    assert.equal(res.status, 401);
  });

  test('signing out clears the cookie', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('set-cookie'), /reconciler_session=;/);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });
});

// ---------------------------------------------------------------------------
// Shared-password mode
// ---------------------------------------------------------------------------

describe('password hashing', () => {
  test('a correct password verifies, a wrong one does not', async () => {
    const { hashPassword, verifyPassword } = await import('../src/password.js');
    const record = await hashPassword('correct-horse-battery-staple');

    assert.equal(await verifyPassword('correct-horse-battery-staple', record), true);
    assert.equal(await verifyPassword('correct-horse-battery-stapl', record), false);
    assert.equal(await verifyPassword('', record), false);
    assert.equal(await verifyPassword(null, record), false);
  });

  test('the password itself is never stored', async () => {
    const { hashPassword } = await import('../src/password.js');
    const record = await hashPassword('super-secret-value');
    assert.ok(!JSON.stringify(record).includes('super-secret-value'));
    assert.equal(record.algorithm, 'scrypt');
    assert.equal(Buffer.from(record.hash, 'hex').length, 32);
  });

  test('two hashes of the same password differ', async () => {
    const { hashPassword } = await import('../src/password.js');
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    assert.notEqual(a.hash, b.hash, 'each hash must carry its own salt');
    assert.notEqual(a.salt, b.salt);
  });

  test('a malformed record verifies nothing', async () => {
    const { verifyPassword } = await import('../src/password.js');
    for (const bad of [null, undefined, {}, { algorithm: 'md5' }, { algorithm: 'scrypt', hash: 'zz' }]) {
      assert.equal(await verifyPassword('anything', bad), false);
    }
  });

  test('generated passwords are long and varied', async () => {
    const { generatePassword } = await import('../src/password.js');
    const a = generatePassword();
    const b = generatePassword();
    assert.equal(a.split('-').length, 5);
    assert.ok(a.length >= 20);
    assert.notEqual(a, b);
  });
});

describe('a server in password mode', () => {
  let child;
  let baseUrl;
  let workDir;
  let secretsPath;
  const PASSWORD = 'test-password-for-the-suite';

  before(async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { hashPassword } = await import('../src/password.js');
    const ROOT = fileURLToPath(new URL('..', import.meta.url));

    workDir = await mkdtemp(join(tmpdir(), 'reconciler-pw-'));
    // secrets.json is read from the project root, so write a real one and
    // remove it afterwards — this is exactly what a deployment carries.
    secretsPath = join(ROOT, 'secrets.json');
    await writeFile(
      secretsPath,
      JSON.stringify({ sessionSecret: 'test-session-secret', password: await hashPassword(PASSWORD) }),
    );

    child = spawn(process.execPath, [join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: '0', STORE_FILE: join(workDir, 'store.json'), INBOX_DIR: join(workDir, 'inbox') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    baseUrl = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('server did not start')), 10_000);
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/http:\/\/[\d.]+:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolvePromise(match[0]);
        }
      });
      child.stderr.on('data', (c) => process.stderr.write(`[pw-server] ${c}`));
      child.on('exit', (code) => rejectPromise(new Error(`server exited: ${code}`)));
    });
  });

  after(async () => {
    child?.kill('SIGTERM');
    const { rm } = await import('node:fs/promises');
    if (secretsPath) await rm(secretsPath, { force: true });
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const signIn = async (password) => {
    const res = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password, next: '/' }),
      redirect: 'manual',
    });
    return res;
  };

  test('the front page is the password form', async () => {
    const res = await fetch(baseUrl);
    const html = await res.text();
    assert.match(html, /Enter the team password/);
    assert.ok(!html.includes('Import CSV'), 'no dashboard before sign-in');
  });

  test('data routes refuse an anonymous request', async () => {
    for (const path of ['/api/report', '/api/export', '/api/me']) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401, path);
    }
  });

  test('the wrong password is refused, and says nothing useful', async () => {
    const res = await signIn('not-the-password');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null, 'no session may be issued');
    const html = await res.text();
    assert.match(html, /was not right/);
    assert.ok(!html.includes(PASSWORD));
  });

  test('the right password opens the door', async () => {
    const res = await signIn(PASSWORD);
    assert.equal(res.status, 302);

    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /reconciler_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const token = cookie.split(';')[0];
    const me = await fetch(`${baseUrl}/api/me`, { headers: { cookie: token } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).mode, 'password');

    const report = await fetch(`${baseUrl}/api/report`, { headers: { cookie: token } });
    assert.equal(report.status, 200);
    assert.ok(Array.isArray((await report.json()).matches));
  });

  test('a forged session cookie is refused', async () => {
    const forged = createSessionToken({ email: 'team' }, 'the-wrong-secret');
    const res = await fetch(`${baseUrl}/api/report`, { headers: { cookie: `reconciler_session=${forged}` } });
    assert.equal(res.status, 401);
  });

  test('the sign-in form only ever returns to this site', async () => {
    const res = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD, next: 'https://evil.example.com/steal' }),
      redirect: 'manual',
    });
    assert.equal(res.headers.get('location'), '/', 'an off-site redirect must be discarded');
  });

  test('signing out clears the session', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { redirect: 'manual' });
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });
});
