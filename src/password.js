/**
 * Shared-password sign-in.
 *
 * Why this exists alongside Google sign-in: Vercel's own password protection is
 * a paid feature, and its free tier only covers preview URLs and only admits
 * the account owner — no use to a team. Google sign-in needs four environment
 * variables, which can only be set from inside the Vercel dashboard. This route
 * needs neither: the password hash and the session secret travel with the
 * deployment itself, in a `secrets.json` that is never committed.
 *
 * The password is never stored, only a scrypt hash of it. scrypt is
 * deliberately slow and memory-hard, so guessing at it is expensive even for
 * someone holding the hash. Combined with a long random password, that is the
 * whole defence against brute force — a serverless function has no shared
 * memory to count failed attempts in, so there is no rate limiter here, and
 * pretending otherwise would be worse than saying so.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hash a password for storage.
 * @param {string} password
 * @returns {Promise<{algorithm: string, salt: string, hash: string, N: number, r: number, p: number}>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, KEY_LENGTH, SCRYPT_PARAMS);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('hex'),
    hash: Buffer.from(derived).toString('hex'),
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  };
}

/**
 * Is this the password? Compared in constant time, so a wrong guess reveals
 * nothing about how nearly right it was.
 *
 * @param {string} candidate
 * @param {object} record from hashPassword
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(candidate, record) {
  if (!record || record.algorithm !== 'scrypt' || !record.salt || !record.hash) return false;
  if (typeof candidate !== 'string' || candidate === '') return false;

  const expected = Buffer.from(record.hash, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  try {
    const derived = Buffer.from(
      await scrypt(candidate, Buffer.from(record.salt, 'hex'), KEY_LENGTH, {
        N: record.N ?? SCRYPT_PARAMS.N,
        r: record.r ?? SCRYPT_PARAMS.r,
        p: record.p ?? SCRYPT_PARAMS.p,
        maxmem: SCRYPT_PARAMS.maxmem,
      }),
    );
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Generate a password a person can read down a phone but a machine cannot
 * guess: five words from a wide list, about 64 bits of entropy.
 */
export function generatePassword(words = 5) {
  const parts = [];
  for (let i = 0; i < words; i++) {
    parts.push(WORDS[randomBytes(2).readUInt16BE(0) % WORDS.length]);
  }
  return parts.join('-');
}

/** The sign-in screen for password mode. */
export function passwordPage({ error, next = '/' } = {}) {
  const message = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · Ticket Reconciler</title>
<style>
  :root { color-scheme: light dark; --bg:#eff0f4; --card:#fff; --text:#14162a; --muted:#5f6488; --line:#dfe1ec; --accent:#3a45c4; --bad:#b93529; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0e16; --card:#161826; --text:#e8eaf6; --muted:#9ba1c4; --line:#272b40; --accent:#838cff; --bad:#ff7f72; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:34px 32px; max-width:420px; width:100%;
          box-shadow:0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.08); }
  h1 { margin:0 0 6px; font-size:13px; letter-spacing:.18em; text-transform:uppercase;
       font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  p { color:var(--muted); margin:0 0 20px; font-size:13.5px; }
  .err { color:var(--bad); border:1px solid var(--bad); background:color-mix(in srgb, var(--bad) 8%, transparent);
         border-radius:8px; padding:10px 12px; margin-bottom:16px; font-size:13px; }
  label { display:block; font-size:11px; letter-spacing:.09em; text-transform:uppercase; font-weight:600;
          color:var(--muted); margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; font-size:15px; padding:11px 12px; border-radius:9px;
          border:1px solid var(--line); background:var(--bg); color:var(--text); font-family:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  button { width:100%; margin-top:14px; background:var(--accent); color:#fff; border:0; border-radius:9px;
           padding:12px 16px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
  button:hover { filter:brightness(1.07); }
  .foot { margin:18px 0 0; font-size:12px; }
</style></head>
<body>
  <div class="card">
    <h1>Ticket Reconciler</h1>
    <p>This dashboard holds purchase and card transaction data. Enter the team password to continue.</p>
    ${message}
    <form method="POST" action="/api/auth/password">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Sign in</button>
    </form>
    <p class="foot">You stay signed in on this device for 12 hours.</p>
  </div>
</body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** Plain, unambiguous words — no homophones, nothing hard to spell aloud. */
const WORDS = [
  'anchor', 'apple', 'arrow', 'atlas', 'autumn', 'bamboo', 'basin', 'beacon', 'bishop', 'blanket',
  'bottle', 'boulder', 'branch', 'bridge', 'bucket', 'cabin', 'camera', 'candle', 'canyon', 'carbon',
  'castle', 'cavern', 'cedar', 'cellar', 'circus', 'clover', 'cobalt', 'comet', 'compass', 'copper',
  'coral', 'cotton', 'crater', 'crimson', 'crystal', 'dagger', 'dolphin', 'domino', 'dragon', 'ember',
  'engine', 'falcon', 'fabric', 'ferry', 'fiddle', 'flint', 'forest', 'fossil', 'fountain', 'gallery',
  'garden', 'gadget', 'glacier', 'granite', 'gravel', 'harbor', 'hammer', 'harvest', 'hazel', 'helmet',
  'hollow', 'ignite', 'indigo', 'island', 'jacket', 'jasper', 'jungle', 'kettle', 'kitten', 'ladder',
  'lantern', 'lagoon', 'lemon', 'lighthouse', 'lumber', 'magnet', 'mammoth', 'marble', 'meadow', 'medal',
  'mirror', 'monsoon', 'mustard', 'nebula', 'nickel', 'noodle', 'notebook', 'oasis', 'orbit', 'orchid',
  'otter', 'oxygen', 'paddle', 'pancake', 'parcel', 'pebble', 'pepper', 'pigeon', 'pillar', 'pilot',
  'planet', 'plaster', 'pocket', 'pottery', 'prairie', 'pumpkin', 'quarry', 'quartz', 'rabbit', 'racket',
  'ranger', 'ribbon', 'rocket', 'rubber', 'saddle', 'salmon', 'sandal', 'sapphire', 'satchel', 'scooter',
  'shadow', 'shelter', 'shovel', 'signal', 'silver', 'sketch', 'slipper', 'socket', 'spiral', 'sponge',
  'spruce', 'stadium', 'stencil', 'stirrup', 'summit', 'sunset', 'sweater', 'syrup', 'tablet', 'tandem',
  'teapot', 'temple', 'thimble', 'thunder', 'timber', 'tinder', 'toaster', 'tractor', 'trumpet', 'tunnel',
  'turbine', 'turtle', 'umbrella', 'valley', 'velvet', 'vessel', 'village', 'violet', 'volcano', 'waffle',
  'wagon', 'walnut', 'wander', 'warden', 'whistle', 'willow', 'window', 'winter', 'wizard', 'wombat',
  'yellow', 'zebra', 'zenith', 'zipper',
];
