# Putting this on Vercel

The result: a private URL your team opens from any browser, signing in with
Google. Imported files are remembered in a database, so what you upload on
Monday is still there on Friday, and everyone sees the same data.

Budget about 20 minutes the first time. Nothing here needs a credit card —
Vercel's Hobby plan and Neon's free database tier both cover this comfortably.

There are five steps. Do them in order; step 4 needs a URL that only exists
after step 2.

---

## 1. Get the code onto GitHub

The code currently lives on the branch `claude/daily-transaction-reconciler-wy6aqb`
of your `scraper-5-18` repository. Either point Vercel at that branch directly,
or copy it into a repository of its own:

```bash
git clone --single-branch -b claude/daily-transaction-reconciler-wy6aqb \
  https://github.com/BrianPTS/scraper-5-18 ticket-reconciler
cd ticket-reconciler
git remote set-url origin https://github.com/BrianPTS/ticket-reconciler
git branch -m main
git push -u origin main
```

(The second form needs an empty `ticket-reconciler` repository created on
GitHub first. Nothing from the scraper project comes along — the branch has its
own history.)

## 2. Create the Vercel project

1. Go to [vercel.com/new](https://vercel.com/new) and import that repository.
2. Leave every build setting alone. There is no build step — Vercel serves
   `public/` as static files and runs `api/index.js` as a function.
3. Click **Deploy**.

It will finish in under a minute and give you a URL like
`ticket-reconciler.vercel.app`. **Opening it now will say the deployment is not
configured** — that is correct, and it is deliberate: an unconfigured
deployment refuses to serve anything rather than leaving your data open. Note
the URL down; you need it in step 4.

## 3. Add the database

1. In your new project: **Storage** → **Create Database** → **Neon** (Postgres).
2. Accept the defaults and connect it to this project.

Vercel sets `DATABASE_URL` for you. The tables create themselves on first use —
there is no migration to run.

## 4. Create the Google sign-in credentials

At [console.cloud.google.com](https://console.cloud.google.com):

1. Create a project (or pick an existing one).
2. **APIs & Services** → **OAuth consent screen**.
   - If your team is on Google Workspace, choose **Internal**. That alone
     restricts sign-in to your own company accounts.
   - Otherwise choose **External**, and add each person under **Test users**
     (external apps in testing mode allow up to 100).
   - Fill in an app name and your email. No verification is required for a
     private tool like this.
3. **Credentials** → **Create Credentials** → **OAuth client ID**.
   - Application type: **Web application**
   - **Authorized redirect URI** — this must match exactly, including `https`
     and with no trailing slash:

     ```
     https://YOUR-PROJECT.vercel.app/api/auth/callback
     ```

     Add a second one for a custom domain later if you set one up. A mismatch
     here is the single most common cause of a failed sign-in, and Google will
     say `redirect_uri_mismatch` when it happens.
4. Copy the **Client ID** and **Client secret**.

## 5. Set the environment variables

In Vercel: **Settings** → **Environment Variables**. Add these for
**Production** (and Preview, if you want the preview URLs to work too):

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 4 |
| `GOOGLE_CLIENT_SECRET` | from step 4 |
| `SESSION_SECRET` | any long random string — run `openssl rand -hex 32` |
| `ALLOWED_DOMAINS` | `primetimestubs.com` — everyone at that domain gets in |
| `ALLOWED_EMAILS` | *or* a comma-separated list of individual addresses |

`DATABASE_URL` is already there from step 3.

Set at least one of `ALLOWED_DOMAINS` / `ALLOWED_EMAILS`; you can set both, and
the two lists are additive. **If neither is set, nobody can sign in** — that is
the safe direction to fail.

Then **Deployments** → the latest one → **Redeploy**, so the new variables are
picked up.

Open the URL. You should get the sign-in screen.

---

## Running it day to day

Same as the local version: drag both exports onto the page, or use **Import**.
The data lands in Postgres, so everyone with access sees the same thing and it
is still there tomorrow.

Two differences from running it on your own machine:

- **The watched `inbox/` folder does not exist.** A serverless function has no
  disk to watch. Import through the page instead.
- **Updates arrive by polling, not instantly.** The page re-checks every 20
  seconds while the tab is visible. On your own machine it is instant, because
  there is a real server to push from.

## Managing who has access

Editing `ALLOWED_EMAILS` or `ALLOWED_DOMAINS` and redeploying is the whole
process. Removing someone takes effect within 12 hours (the life of a session
cookie); to cut access immediately, change `SESSION_SECRET` as well — that
signs everybody out at once, including them.

## What is and is not protected

- **Protected:** every route that touches your data. `/api/report`,
  `/api/import`, `/api/export`, linking, ignoring, settings — all refuse
  anonymous requests with a `401`, and refuse a forged or expired session
  cookie the same way. There are tests for each of these.
- **Not secret:** the dashboard's own HTML, CSS and JavaScript. Someone who
  guesses your URL and has no session sees the sign-in screen; if they fetch
  `/app.js` directly they get the application code, which contains no data of
  yours. This is how every hosted web app works.
- **Sessions** are HttpOnly, Secure, SameSite=Lax cookies signed with
  `SESSION_SECRET`. They cannot be edited by a browser or by JavaScript, and
  they expire after 12 hours.
- **Your card data** goes to Vercel and Neon, both of which encrypt it at rest
  and in transit. If you would rather it never leave your building, keep using
  the local version or the single-file browser build — they are unchanged.

## If something goes wrong

| What you see | What it means |
| --- | --- |
| "This deployment is not configured" | An environment variable is missing; the page names which one. Add it and redeploy. |
| Google says `redirect_uri_mismatch` | The redirect URI in Google Cloud does not exactly match `https://your-domain/api/auth/callback`. |
| "…is not on the access list" | Sign-in worked, but that address is not in `ALLOWED_EMAILS`/`ALLOWED_DOMAINS`. |
| "That sign-in attempt did not start here" | A stale or bookmarked callback link. Go to the site root and sign in again. |
| Everything is empty after a deploy | Check that `DATABASE_URL` is set on the environment you are looking at (Production vs Preview are separate). |

## Testing it before you deploy

The hosted configuration runs locally too, which is the quickest way to check
your credentials without a deploy cycle:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
SESSION_SECRET=$(openssl rand -hex 32) \
ALLOWED_DOMAINS=primetimestubs.com \
node server.js
```

Add `http://localhost:4173/api/auth/callback` to the same Google client's
redirect URIs and the whole sign-in flow works on your own machine.

To exercise the Postgres store as well, point it at any Postgres and run:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

Those database tests skip themselves when no `TEST_DATABASE_URL` is set, so
`npm test` on its own stays fast and dependency-free.
