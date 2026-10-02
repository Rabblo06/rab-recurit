# Deploying rab (free tier)

Stack: **Neon** (Postgres) + **Upstash** (Redis) + **Render** (API) + **Vercel**
(web console). All four have a free-forever tier; none but Render require a
card on file. This is a single `production` environment — no staging, to keep
the number of free accounts to one each. See the trade-offs at the bottom
before pointing real users at it.

## 1. Database — Neon

Already provisioned: project `lucky-grass-30655804` (org
`org-old-queen-65138718`), region `aws-us-east-2`. Two branches exist —
`production` (default, is what Render deploys against) and `dev` (branched
off production, for local work — see below). The repo is CLI-linked via
`packages/rab-server/.neon` (gitignored), currently checked out on `dev`.

1. **Both branches have `rab_owner`/`rab_app` roles, matching local dev's
   `postgres-init/01-roles.sql`** — migrations run as `rab_owner`, the
   running server connects only as `rab_app` (`NOBYPASSRLS`), so RLS is
   actually enforced (CLAUDE.md §5.7). These are **not** created via
   `neon roles create`/the Neon Console — Neon auto-enrolls any role made
   that way into `neon_superuser`, which carries `BYPASSRLS` unconditionally
   with no way to strip it back off afterward (confirmed against
   `pg_roles`/`pg_auth_members` directly — `neondb_owner` itself isn't an
   admin over roles it didn't create through the API, so it can't `ALTER
   ROLE ... NOBYPASSRLS` one after the fact). Instead they're created with
   plain `CREATE ROLE ... LOGIN PASSWORD '...'` SQL run as `neondb_owner`,
   which Neon does *not* auto-enroll — same as any self-hosted Postgres.
   `neondb_owner` also needs `GRANT CREATE ON DATABASE neondb TO rab_owner;`
   first (Postgres 15+ dropped the implicit CREATE-on-database grant for
   non-owners), then `rab_owner` connects with its own password and creates
   `core` schema + grants exactly as `01-roles.sql` does locally.
   Passwords for both roles aren't Neon-managed (`neon connection-string
   --role-name` won't find them) — they're embedded directly in the
   connection strings below.
2. Get the two connection strings Render needs — **as `rab_app`/`rab_owner`,
   not `neondb_owner`**:
   - `DATABASE_URL` — pooled, `rab_app`
   - `DATABASE_URL_UNPOOLED` — direct, `rab_owner`

   Use each as-is, including the trailing `?sslmode=require` —
   `core.datasource.ts` passes the URL straight to `pg`, which parses
   `sslmode` from the URL itself; don't strip it. **Don't swap them** — the
   pooled one goes through PgBouncer in transaction mode, which silently
   breaks migrations (see the neon-postgres skill's pooling gotcha); the
   `rab_owner`/unpooled one is what `start.sh`'s migration step runs
   against.
3. Neon's free tier autosuspends the compute after a few minutes of
   inactivity and wakes on the next connection (a few hundred ms) — unlike
   some free Postgres tiers, it does **not** delete the database after
   inactivity.
4. **Local dev uses the `dev` branch, not `production`.** `packages/rab-server/.env`
   points at `dev`'s `rab_app`/`rab_owner` roles, never at what Render/real
   users hit. `neon checkout <branch>` (run from `packages/rab-server`)
   switches branches but only pulls `neondb_owner`-based URLs automatically
   — if you ever need to inspect data as `rab_app`/`rab_owner` directly on
   another branch, rebuild the URL by hand the same way this setup did (swap
   the username/password in a `neondb_owner` connection string), since those
   roles' passwords aren't Neon-managed.

## 2. Redis — Upstash

1. [upstash.com](https://upstash.com) → Redis → create database (same
   region family as Render/Neon if offered).
2. Copy the **TLS** connection string — starts `rediss://`. `ioredis`
   (used by `queue-worker` and the throttler) enables TLS automatically from
   that scheme, no code change needed.
3. That's `REDIS_URL`.

## 3. API — Render

1. [render.com](https://render.com) → New → Blueprint → connect this repo.
   Render reads [`render.yaml`](./render.yaml) at the root and creates the
   `rab-server` web service from `packages/rab-docker/rab/Dockerfile`.
2. Render will prompt for every `sync: false` env var in `render.yaml` —
   fill in:
   - `DATABASE_URL` and `DATABASE_URL_UNPOOLED` — from step 1 (pooled and
     direct, respectively — do not swap them)
   - `REDIS_URL` — from step 2
   - `CORS_ORIGINS` — your Vercel URL from step 4, e.g.
     `https://rab-console.vercel.app` (no trailing slash; comma-separate if
     you add more origins later — never `*`, see `environment-variables.ts`).
     If you've set up the separate accounts domain below, this must include
     **both** origins, e.g.
     `https://app.rabworkspaceteams.co.uk,https://accounts.rabworkspaceteams.co.uk`
   - `APP_URL` — the Manager app's own URL (e.g.
     `https://app.rabworkspaceteams.co.uk`, or the same Vercel URL as
     `CORS_ORIGINS` if you haven't set up a custom domain yet). Used only for
     the absolute "Continue to Manager Portal" link shown after
     activation/password-reset — **not** for the activation/reset email links
     themselves, see `ACCOUNTS_URL` below.
   - `ACCOUNTS_URL` — the public, pre-authentication account pages' own URL
     (e.g. `https://accounts.rabworkspaceteams.co.uk`). This is what the
     activation and password-reset emails actually link to, kept separate
     from `APP_URL` so those pages never look like part of the authenticated
     Manager app. If you haven't set up the second custom domain (§4), set
     this to the same value as `APP_URL` for now.
   - `EMAIL_FROM_ADDRESS` — e.g. `rab <no-reply@yourdomain.com>`
   - `APP_VERSION` — a version string for the Admin Panel, e.g. `0.1.0`
   - `SENTRY_DSN` — leave blank if you don't have Sentry set up
   - `APP_SECRET` is auto-generated by the blueprint (`generateValue: true`)
     — you don't need to supply it.
3. Deploy. The start command runs pending migrations
   (`setup-db.js`) before `main.js` boots, same as local dev — first deploy
   creates the schema.
3.5. **First Platform Admin, on a fresh database only**: `start.sh` also
   runs `bootstrap-admin` (see `command/bootstrap-admin.command.ts`) right
   after migrations. It's a no-op unless you explicitly set BOTH
   `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in Render's
   Environment tab — set them only for the very first deploy against a
   brand-new database, confirm you can log in as that account, then
   **remove `BOOTSTRAP_ADMIN_PASSWORD` from Render** (the account itself is
   unaffected — this only ever seeds a normal user row through the same
   password hashing every other account uses, never a standing credential
   check). `BOOTSTRAP_ADMIN_FIRST_NAME`/`_LAST_NAME` are optional. If a
   Platform Admin already exists, or if the two required vars aren't both
   set, this step does nothing and logs why.
4. **Free-tier trade-off**: the free web service sleeps after 15 minutes
   with no traffic. The next request wakes it — expect ~30-50s on that one
   request, then normal latency until it idles out again. If that's not
   acceptable for real users, upgrade this one service to a paid Starter
   instance ($7/mo) later; nothing else in this setup needs to change.
5. **`rab-worker` is deployed as a second Render service** (`render.yaml`'s
   `type: worker` entry, `dockerCommand: ./start-worker.sh`, `autoDeploy:
   true`). It runs the real `packages/rab-worker` package: one BullMQ
   consumer (`rab-email`) plus 13 scheduled polling jobs (email dispatch,
   shift reminders, no-show/late-clock-in/missing-clock-out detection,
   offer expiry, manager-confirmation-timeout, replacement staff,
   cancellation follow-up, account-invite/token cleanup, storage cleanup,
   pre-shift roster PDF, final timesheet PDF). Render's `type: worker`
   services have no free tier — this is a paid instance type; budget for it
   accordingly (or use Fly.io's allowance instead, per this doc's own
   alternative-platform notes elsewhere). Every `sync: false` env var on the
   `rab-worker` service in `render.yaml` must be set to the *same* value as
   the matching var on `rab-server` — they operate against the same
   database, Redis, and email/storage providers.

## 4. Web console — Vercel

`packages/rab-front/vercel.json` is already configured (Nx build, SPA
rewrites). It lives inside `packages/rab-front`, not the repo root, because
this project's **Root Directory is set to `packages/rab-front`** in the
Vercel dashboard — Vercel only reads `vercel.json` from within the
configured Root Directory, so a copy at the repo root is silently ignored
(this was a real, shipped bug: the SPA rewrite never applied, and any direct
navigation/refresh to a non-root route 404'd at Vercel's edge instead of
loading the app). `outputDirectory`'s `../../dist/packages/rab-front` is
correct as-is — Nx always resolves its output relative to the workspace
root regardless of the invoking directory, so the same relative path works
whether `nx build` runs from the repo root or from `packages/rab-front`.

1. New Project → import this repo → set **Root Directory** to
   `packages/rab-front` → framework preset should auto-detect from
   `vercel.json`.
2. Project → Settings → Environment Variables → add `VITE_API_URL` =
   `https://<your-render-service>.onrender.com/rest/v1` (matches
   `packages/rab-front/src/shared/api.ts`'s default shape).
3. Deploy.

**Note on Vercel's free tier**: the Hobby plan's terms restrict it to
non-commercial use. If this becomes a paying product, that's worth revisiting
— Cloudflare Pages has no such restriction and is a drop-in swap (same Vite
static output, no `vercel.json`-equivalent needed beyond a build command).

### 4.1 Separate accounts domain (activate-account / reset-password / forgot-password)

These pages already exist as plain public routes in the same `rab-front`
bundle — no second React app or build pipeline is needed. Vercel supports
attaching more than one custom domain to the same project/deployment, so the
accounts domain is just a second domain on this exact project:

1. Vercel dashboard → this project → **Settings → Domains → Add** →
   `accounts.rabworkspaceteams.co.uk`. Vercel will show you the exact DNS
   record to create (typically a CNAME to `cname.vercel-dns.com`, but follow
   whatever Vercel's UI actually asks for at the time) — add it in Cloudflare
   (or wherever DNS for `rabworkspaceteams.co.uk` is managed). **Do not** point
   this record at the API, Redis, or any backend port — it's a frontend
   hosting record, exactly like `app.rabworkspaceteams.co.uk`'s own record.
2. Once the domain is verified and serving, set `ACCOUNTS_URL` on `rab-server`
   (§3 above) to `https://accounts.rabworkspaceteams.co.uk`, and add that same
   origin to `CORS_ORIGINS`.
3. No change to `vercel.json`, `VITE_API_URL`, or the build itself — both
   domains serve the identical deployment; React Router renders whichever
   route the URL asks for regardless of which domain loaded it.

## 5. Verify

```bash
curl https://<your-render-service>.onrender.com/healthz
```

Then load the Vercel URL and confirm login works end-to-end (it exercises
DB + Redis + CORS all at once).

## Known gaps on this free setup

- **File storage is ephemeral.** `STORAGE_DRIVER=LOCAL` writes to Render's
  container disk, which is wiped on every restart/redeploy — there's no S3
  driver built yet (`environment-variables.ts` only allows `LOCAL` today).
  Not an issue right now since nothing uses file storage, but don't add a
  feature that uploads/persists files without addressing this first.
- **No staging environment.** Render/Vercel deploy only from the Neon
  `production` branch. A `dev` branch already exists (for local work, see
  step 1) — to add a real staging *deployment*, point a second free Render
  service at that branch (or a new one) rather than duplicating
  Upstash/Vercel too.
- **Worker isn't running.** See step 3.5 above.
- **Cold starts** on the free Render tier (step 3.4) are the main
  real-user-facing cost of "free forever" here.
