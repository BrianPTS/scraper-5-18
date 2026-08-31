#!/usr/bin/env node
/**
 * Ticket Reconciler — local server.
 *
 *   node server.js            # http://localhost:4173
 *   PORT=8080 node server.js
 *
 * Runs on your own machine: a long-lived process, data in a JSON file, live
 * updates over Server-Sent Events, and a watched ./inbox folder. The hosted
 * deployment (api/index.js) serves the same routes from `src/api.js` but backed
 * by Postgres, because a serverless function has neither a disk nor a lifetime.
 *
 * Google sign-in is optional here and on by default nowhere: set
 * GOOGLE_CLIENT_ID and friends and this server will demand it too, which is a
 * useful way to test the hosted configuration before deploying it.
 */

import { existsSync, mkdirSync, watch } from 'node:fs';
import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClientError, handleApi, importFile, sendJson } from './src/api.js';
import { getSession, handleCallback, handleLogin, handleLogout, readAuthConfig, signInPage } from './src/auth.js';
import { readDeploymentConfig } from './src/deployment.js';
import {
  getPasswordSession,
  handlePasswordLogout,
  handlePasswordSubmit,
  servePasswordPage,
} from './src/password-routes.js';
import { serveStatic } from './src/static.js';
import { Store, defaultStorePath } from './src/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const INBOX_DIR = process.env.INBOX_DIR ? resolve(process.env.INBOX_DIR) : join(ROOT, 'inbox');
const PROCESSED_DIR = join(INBOX_DIR, 'processed');
// Not `Number(PORT) || 4173`: PORT=0 is a legitimate request for "any free
// port" and 0 is falsy, so that form would quietly bind 4173 instead.
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;
const HOST = process.env.HOST || '127.0.0.1';

const store = new Store(process.env.STORE_FILE || defaultStorePath(ROOT));
const authConfig = readAuthConfig();
// The hosted configuration runs here too, which is how it gets tested before
// it is deployed anywhere.
const deployment = readDeploymentConfig();
const passwordMode = deployment.accessMode === 'password';

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

// ---------------------------------------------------------------------------
// Watched inbox — drop today's exports in ./inbox and they load themselves
// ---------------------------------------------------------------------------

const inboxSeen = new Map();

async function scanInbox() {
  if (!existsSync(INBOX_DIR)) return;
  let entries;
  try {
    entries = await readdir(INBOX_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== '.csv' && ext !== '.xlsx') continue;

    const full = join(INBOX_DIR, entry.name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }

    // Wait for the file to stop growing before reading it — a large export
    // copied into the folder can otherwise be picked up half-written.
    const prev = inboxSeen.get(full);
    if (!prev || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      inboxSeen.set(full, { size: info.size, mtimeMs: info.mtimeMs });
      continue;
    }

    try {
      const buffer = await readFile(full);
      const entryLog = await importFile({
        filename: entry.name,
        bytes: new Uint8Array(buffer),
        source: 'inbox',
        store,
      });
      mkdirSync(PROCESSED_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await rename(full, join(PROCESSED_DIR, `${stamp}__${entry.name}`));
      console.log(
        `[inbox] imported ${entry.name} (${entryLog.kind}: +${entryLog.added} new, ${entryLog.updated} updated)`,
      );
    } catch (err) {
      console.error(`[inbox] ${entry.name}: ${err.message}`);
    } finally {
      inboxSeen.delete(full);
    }
  }
}

function startInboxWatcher() {
  mkdirSync(INBOX_DIR, { recursive: true });
  let timer = null;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => scanInbox().catch(() => {}), 400);
    timer.unref?.();
  };
  try {
    watch(INBOX_DIR, kick).unref?.();
  } catch {
    // Some filesystems (network mounts, containers) do not support watch;
    // the interval below keeps the folder working anyway.
  }
  setInterval(() => scanInbox().catch(() => {}), 5000).unref?.();
  scanInbox().catch(() => {});
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  // Comment frames keep proxies from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  ping.unref?.();

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

function broadcast(event) {
  const frame = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (passwordMode) {
      if (url.pathname === '/api/auth/password' && req.method === 'POST') {
        return handlePasswordSubmit(req, res, deployment);
      }
      if (url.pathname === '/api/auth/logout') return handlePasswordLogout(req, res);
      if (url.pathname === '/api/auth/login') {
        return servePasswordPage(req, res, { next: url.searchParams.get('next') || '/' });
      }

      const session = getPasswordSession(req, deployment);
      if (!session) {
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Please sign in.' });
        return servePasswordPage(req, res, { next: url.pathname });
      }
      if (url.pathname === '/api/me') {
        return sendJson(res, 200, { user: session, realtime: true, authEnabled: true, mode: 'password' });
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, { store, realtime: true, handleStream });
        return;
      }
      return serveStatic(res, url.pathname);
    }

    if (url.pathname.startsWith('/api/auth/')) {
      if (!authConfig.enabled) return sendJson(res, 404, { error: 'Sign-in is not configured on this server.' });
      if (authConfig.reason) return sendJson(res, 500, { error: authConfig.reason });
      if (url.pathname === '/api/auth/login') return handleLogin(req, res, authConfig, url);
      if (url.pathname === '/api/auth/callback') return handleCallback(req, res, authConfig, url);
      if (url.pathname === '/api/auth/logout') return handleLogout(req, res);
      return sendJson(res, 404, { error: 'Unknown auth route.' });
    }

    const session = getSession(req, authConfig);

    if (url.pathname.startsWith('/api/')) {
      if (!session) return sendJson(res, 401, { error: 'Please sign in.' });
      if (url.pathname === '/api/me') {
        return sendJson(res, 200, { user: session, realtime: true, authEnabled: authConfig.enabled });
      }
      await handleApi(req, res, url, { store, realtime: true, handleStream });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    if (!session && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(signInPage({ misconfigured: authConfig.reason }));
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err instanceof ClientError ? err.status : 500;
    if (status === 500) console.error('[http]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

async function main() {
  await store.load();
  store.onChange((event) => broadcast(event));
  startInboxWatcher();

  server.listen(PORT, HOST, () => {
    const counts = `${store.purchases().length} purchases, ${store.charges().length} charges`;
    const bound = server.address();
    console.log(`\n  Ticket Reconciler  →  http://${HOST}:${bound.port}`);
    console.log(`  Store: ${store.file} (${counts})`);
    console.log(`  Inbox: drop CSV or XLSX exports in ${INBOX_DIR} and they import automatically`);
    if (passwordMode) console.log('  Sign-in: shared password (secrets.json)');
    if (authConfig.enabled) {
      console.log(
        authConfig.reason
          ? `  Sign-in: MISCONFIGURED — ${authConfig.reason}`
          : `  Sign-in: Google, limited to ${[...authConfig.allowedEmails, ...authConfig.allowedDomains].join(', ')}`,
      );
    }
    console.log('');
  });
}

const shutdown = async () => {
  await store.flush().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
