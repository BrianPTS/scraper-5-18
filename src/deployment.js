/**
 * How is this deployment protected, and is it finished being set up?
 *
 * A hosted copy of this dashboard holds real purchase and card data, so the
 * rule is: never serve it unless something is definitely guarding the door.
 * There are two ways that can be true, and this module is where the deployment
 * declares which one it is relying on.
 *
 *   google   — the app itself does the checking: Google sign-in against an
 *              email allowlist. Needs four environment variables.
 *   password — the app asks for one shared password. The hash and the session
 *              secret ride along in `secrets.json`, deployed but never
 *              committed, so this route needs no environment variables either.
 *   gateway  — something in front of the app already does it, before a request
 *              ever arrives: Vercel's own password or team protection. Needs no
 *              environment variables, which matters because they cannot be set
 *              from outside the Vercel dashboard.
 *
 * `gateway` is deliberately awkward to switch on by accident: it must be
 * written into `deployment.json` and deployed, which is the same act as turning
 * the protection on. It is a claim about the deployment, so it belongs in the
 * deployment, not in a runtime toggle someone could flip without thinking.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = fileURLToPath(new URL('../deployment.json', import.meta.url));
const SECRETS_PATH = fileURLToPath(new URL('../secrets.json', import.meta.url));

/** Read a JSON file, treating anything unreadable as absent. */
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Read the committed deployment declaration, if there is one. */
export function readDeploymentFile(path = CONFIG_PATH) {
  return readJsonFile(path);
}

/**
 * Read the deployed-but-uncommitted secrets, if there are any. Holds the
 * password hash and session secret for `password` mode; absent everywhere
 * except a real deployment.
 */
export function readSecretsFile(path = SECRETS_PATH) {
  return readJsonFile(path);
}

/**
 * @param {object} env
 * @param {object} [file] parsed deployment.json, for tests
 * @returns {{accessMode: 'google'|'gateway', hasDatabase: boolean, ready: boolean, blocker?: string}}
 */
export function readDeploymentConfig(env = process.env, file = readDeploymentFile(), secrets = readSecretsFile()) {
  const declared = String(env.ACCESS_MODE || file.accessMode || '').toLowerCase();
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  // Password mode takes *both* a declaration and the secrets. Secrets alone are
  // not enough: a stray secrets.json left in a checkout would otherwise put a
  // developer's machine into a different mode than the one they are testing,
  // which is how a deployment ends up behaving unlike everything that verified it.
  const hasSecrets = Boolean(secrets?.password?.hash && secrets?.sessionSecret);
  const passwordConfigured = declared === 'password' && hasSecrets;

  // Strongest available wins, and anything unrecognised falls back to `google`
  // — which, with no credentials set, refuses to serve. It fails closed.
  let accessMode = 'google';
  if (googleConfigured) accessMode = 'google';
  else if (passwordConfigured) accessMode = 'password';
  else if (declared === 'gateway') accessMode = 'gateway';
  else if (declared === 'password') accessMode = 'password'; // declared but unusable

  const hasDatabase = Boolean(env.DATABASE_URL);

  let blocker;
  if (accessMode === 'google' && !googleConfigured) blocker = 'auth';
  else if (accessMode === 'password' && !hasSecrets) blocker = 'auth';
  else if (!hasDatabase) blocker = 'database';

  return {
    accessMode,
    hasDatabase,
    ready: !blocker,
    blocker,
    sessionSecret: accessMode === 'password' ? secrets.sessionSecret : undefined,
    password: accessMode === 'password' ? secrets.password : undefined,
  };
}

/**
 * The page an unfinished deployment shows instead of the dashboard.
 *
 * Written for someone who has never opened a terminal: every step names the
 * button to click and where it is. It is the last thing standing between real
 * card data and the open internet, so it is also deliberately dead simple —
 * no data, no scripts, nothing to get wrong.
 */
export function setupPage({ blocker, detail } = {}) {
  const steps =
    blocker === 'database'
      ? `
      <li><strong>Open your project on Vercel</strong> — vercel.com, then click this project.</li>
      <li>Click <strong>Storage</strong> in the top row of tabs.</li>
      <li>Click <strong>Create Database</strong>, choose <strong>Neon</strong> (Postgres), and accept the defaults.</li>
      <li>Click <strong>Connect</strong> to attach it to this project.</li>
      <li>Come back here and <strong>reload the page</strong>.</li>`
      : `
      <li>This deployment has no way to check who you are, so it will not show anything.</li>
      <li>Either turn on Vercel's own protection for the project, or add the Google sign-in settings.</li>
      <li>Whoever set this up can finish it — the deployment guide has both routes.</li>`;

  const title = blocker === 'database' ? 'One step left: connect the database' : 'This deployment is not protected yet';
  const lede =
    blocker === 'database'
      ? 'Everything else is ready. The dashboard needs somewhere to keep what you import, so that it is still there tomorrow and everyone sees the same thing. Adding it takes about four clicks and costs nothing.'
      : 'Nothing will be shown until sign-in is configured. This is deliberate — the dashboard holds purchase and card data, so it refuses to serve rather than risk being left open.';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setup · Ticket Reconciler</title>
<style>
  :root { color-scheme: light dark; --bg:#eff0f4; --card:#fff; --text:#14162a; --muted:#5f6488; --line:#dfe1ec; --accent:#3a45c4; --warn:#8f5e00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0e16; --card:#161826; --text:#e8eaf6; --muted:#9ba1c4; --line:#272b40; --accent:#838cff; --warn:#e0a94a; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:34px 34px 30px; max-width:560px;
          box-shadow:0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.08); }
  .tag { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; letter-spacing:.16em;
         text-transform:uppercase; color:var(--warn); margin:0 0 10px; }
  h1 { margin:0 0 10px; font-size:21px; line-height:1.25; }
  p { color:var(--muted); margin:0 0 20px; }
  ol { margin:0; padding-left:22px; }
  li { margin-bottom:10px; }
  li strong { color:var(--text); }
  .detail { margin-top:22px; padding-top:16px; border-top:1px solid var(--line); font-size:12.5px; color:var(--muted); }
  code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:var(--bg);
         padding:1px 5px; border-radius:4px; }
</style></head>
<body>
  <div class="card">
    <p class="tag">Ticket Reconciler · setup</p>
    <h1>${title}</h1>
    <p>${lede}</p>
    <ol>${steps}</ol>
    ${detail ? `<p class="detail">Technical detail: ${escapeHtml(detail)}</p>` : ''}
  </div>
</body></html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
