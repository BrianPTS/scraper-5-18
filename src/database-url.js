/**
 * Finding the Postgres connection string, whatever it ended up being called.
 *
 * Connecting a database on Vercel sets the environment variable for you, and
 * which name it picks depends on the integration and the year: the Neon
 * marketplace listing sets `DATABASE_URL`, the older Vercel Postgres product set
 * `POSTGRES_URL`, Prisma-flavoured setups add `POSTGRES_PRISMA_URL`, and any of
 * them will happily take a custom prefix if you tick the box. Someone who has
 * done everything right should not then be told there is no database.
 *
 * So: check the names that are actually used, in order of preference, and then
 * fall back to looking for any variable that simply holds a Postgres URL. The
 * fallback is what makes a custom prefix work without anyone knowing it exists.
 */

/**
 * Names worth checking first, best-for-us first.
 *
 * Pooled connections come before direct ones because a serverless function
 * opens and drops connections constantly, which is exactly what a pooler is
 * for — a direct connection per invocation exhausts Postgres' connection limit
 * under any real load.
 */
const KNOWN_NAMES = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'NEON_DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
];

const POSTGRES_URL = /^postgres(ql)?:\/\/\S/i;

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} the connection string, or undefined if there is none
 */
export function resolveDatabaseUrl(env = process.env) {
  // A recognised name is taken at its word, whatever the value looks like —
  // someone who sets DATABASE_URL has said what they mean, and a local socket
  // or an unusual scheme is theirs to get right. The shape check below applies
  // only to the guessing pass, where it is the only thing distinguishing a
  // connection string from every other variable in the environment.
  for (const name of KNOWN_NAMES) {
    if (env[name]) return env[name];
  }

  // Nothing recognised by name. Take any variable that holds a Postgres URL,
  // in sorted order so the same environment always resolves the same way.
  // TEST_* is skipped: it points at a throwaway database for the test suite,
  // and quietly running the real app against it would be a bad surprise.
  for (const name of Object.keys(env).sort()) {
    if (name.includes('TEST')) continue;
    const value = env[name];
    if (value && POSTGRES_URL.test(value)) return value;
  }

  return undefined;
}

/** Which variable name a value came from, for the setup page's benefit. */
export function databaseUrlSource(env = process.env) {
  const url = resolveDatabaseUrl(env);
  if (!url) return undefined;
  return Object.keys(env)
    .sort()
    .find((name) => env[name] === url);
}
