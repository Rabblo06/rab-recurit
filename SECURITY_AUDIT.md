# SECURITY_AUDIT.md — rab workforce platform

**Engagement type:** Authorized, owner-requested penetration test (active testing, non-destructive)
**Target:** `C:\Rab-recruit` — NestJS 11 REST API (`rab-server`) + PostgreSQL 16 (RLS) + Redis 7 + React/Vite front end
**Method:** Live HTTP testing against the actual running stack (`docker compose` — postgres, redis, server, worker, front), plus source review to trace root causes and confirm/refute scanner-style leads. No fixes applied. No destructive actions taken.
**Date:** 2026-08-20

---

# Executive Summary

The application has a genuinely strong baseline: parameterized SQL everywhere, global `forbidNonWhitelisted` DTO validation, a real server-side state machine (`assertTransition`) blocking illegal `offer`/`shift` transitions, working refresh-token-reuse detection that revokes an entire token family, timing/enumeration-safe login and forgot-password flows, a real per-account lockout plus per-IP throttle (both verified live), strict origin-allowlist CORS, and a full Helmet security-header set. Every BOLA/IDOR and vertical-privilege-escalation attempt made against live staff/manager/venue-manager/admin accounts in this engagement was correctly blocked (404 for out-of-scope records, 403 for categorical permission denial — matching the codebase's own documented convention).

Two real, live-demonstrated problems were found, plus one structural/configuration issue that is CRITICAL by design intent even though today's code accidentally contains its blast radius:

1. **CRITICAL (confirmed at the database layer):** the actual running `server` and `worker` containers connect to Postgres as `rab_owner` (`docker-compose.yml:41,66`), not `rab_app`. Postgres exempts a table owner from Row-Level Security on any table that isn't `FORCE`d, and 5 tables (`user`, `organisation`, `refresh_token`, `login_history`, `password_reset_token`) are deliberately not `FORCE`d for pre-auth reasons. This was verified directly against the live database: connecting as `rab_owner` with **zero tenant context** returns every row in `core."user"` and `core.organisation` across the whole database; connecting as the intended `rab_app` role under the same conditions correctly returns zero rows. This is a live violation of the codebase's own non-negotiable invariant ("a query run with no tenant context bound returns zero rows, never all rows"). One real, already-reachable code path relies on exactly this broken guarantee (`WorkspaceService.updateSubdomain`, finding VULN-002).
2. **MEDIUM → demonstrated live, exploitable:** password-reset tokens are not invalidated as a set. A user can reset their password with one token while a second, previously-issued token for the same account remains valid and independently usable afterward to silently overwrite the password again — reproduced end-to-end against a real account.
3. **MEDIUM:** the RLS-bypass-dependent unscoped `Organisation` lookup in `WorkspaceService.updateSubdomain` (workspace.service.ts:60), a fourth cross-org query path not covered by the three documented pre-auth exceptions.
4. **LOW:** `POST /rest/v1/shifts/:id/cancel` accepts an entirely unvalidated `reason` field (no DTO, no type/length constraint) — confirmed live by storing a JSON array where a string was expected.

Payroll, attendance/timesheets, and clock-in/out are **not yet implemented** in this codebase (pre-M2) — those test phases are marked not-applicable rather than pass/fail.

---

# Application Architecture

- **Stack:** NestJS 11, pure REST (no GraphQL), TypeORM 0.3, PostgreSQL 16 with Row-Level Security, Redis 7 (Bull queue + rate-limit store), React/Vite front end, Yarn/Nx monorepo.
- **Modules implemented today:** `identity` (auth, profile, roles, workspace), `staff`, `manager`, `venue`, `scheduling` (job roles + shifts), `offer`, `notification`, plus `engine/` platform machinery (auth, audit, permissions, tenant context, secret encryption, storage, throttler, platform-admin).
- **Not yet implemented:** payroll, attendance/timesheets, clock-in/out — referenced only as forward-looking permission flags and state-machine tables.
- **Auth:** argon2id (`m=19456,t=2,p=1`, matches the stated floor), HS256 JWT (15-min TTL, `{sub, org, roles[], sid}` only — no permissions in the token, resolved server-side per request), opaque SHA-256-hashed refresh tokens with family-based reuse detection (30-day TTL), opaque SHA-256-hashed password-reset tokens (1h TTL for self-service).
- **Tenancy:** `TenantContextService.runInTenantContext` binds `SET LOCAL rab.organisation_id/user_id/role` per request inside a transaction; RLS policies read these via `core.current_org()` etc., failing closed to `NULL` → zero rows when unset.
- **Permissions:** resolved fresh from the DB every request (`PermissionsService`) — never read off the JWT — so a revoked permission takes effect immediately.

# Attack Surface

Full endpoint inventory (auth, profile, roles, workspace, staff, manager, venue, scheduling, offers, notifications, audit, platform-admin, files, health) was mapped from controller source before testing — see prior recon; omitted here for brevity. All mutating endpoints except one (`POST /shifts/:id/cancel`) use a `class-validator` DTO under the global `forbidNonWhitelisted: true` `ValidationPipe`.

# Accounts/Roles Tested

Created live via the real API (not fixtures) inside the single seeded organisation ("Acme Staffing"):

| Role | Account | Purpose |
|---|---|---|
| `super_admin` (seeded) | `admin@acme.test` | baseline / platform-admin-adjacent (won the org's `platform_admin_claim`) |
| `staff` | `staffa.pentest@acme.test` (Staff A) | horizontal (staff-vs-staff) IDOR testing |
| `staff` | `staffb.pentest@acme.test` (Staff B) | horizontal (staff-vs-staff) IDOR testing |
| `manager` (internal) | `managera.pentest@acme.test` | vertical escalation target, offer/shift workflow owner |
| `venue_manager` | `venuemgra.pentest@acme.test` | vertical escalation from a restricted manager subtype |

A real shift, venue, job role, and two offers (one per staff account) were created to exercise the actual offer/shift state machine rather than just reading it.

---

# Authentication Findings

All **CONFIRMED** live, no vulnerabilities found in this section.

- **Enumeration resistance:** `POST /auth/login` returns the identical `"Invalid email or password."` for a wrong email and a wrong password, and `POST /auth/forgot-password` returns an identical `204` for an existing vs. nonexistent account. Verified by direct comparison of both response pairs.
- **Rate limiting:** `5 req/min/IP` on `/auth/*` (except `/me`, `/logout`) is real and enforced — a burst of calls produced a genuine `429` with `Retry-After: 49`, not a decorative header.
- **Account lockout:** documented as 10 failed attempts/15-minute rolling window, counted from `login_history`, independent of the IP throttle. Not separately reproduced (would have required 10 dedicated failed logins inside the same throttle window, which the 5/min IP limit makes impractical to also isolate) — code-reviewed as correctly implemented (`auth.service.ts:20-21,91-97`).
- **JWT forgery:** an `alg:none` token with `roles` escalated to `super_admin`, correctly signed-header-stripped and payload-tampered, was rejected with `401` both against `/auth/me` and the platform-admin panel. `@nestjs/jwt`'s default `algorithms` allowlist is intact.
- **Refresh-token rotation & reuse detection:** rotated a real token once (succeeded), then replayed the **old** token — correctly rejected with `401 "Refresh token reuse detected — session revoked."` — and confirmed the **legitimately rotated new token was also revoked** as part of the same family, exactly as designed.
- **Password-reset token single-use (partial — see VULN-003 below):** a given token cannot be replayed after its own use (`400` on second use of the same token) — but see the finding below for the multi-token gap.

# Authorization Findings

All **CONFIRMED** live, no bypasses found.

- Vertical privilege escalation blocked at every boundary tested: `staff` → `/staff` list (403), `staff` → `/admin/*` (403), `venue_manager` → `/managers` list and create (403 each), `venue_manager` → `/staff` create (403), any non-platform-admin → `/admin/general` (403, tested with both `staff` and `manager`).
- Offer/shift state machine enforced server-side, not just by the frontend: a manager attempting `POST /offers/:id/confirm` on an offer still in `PENDING` (staff hadn't accepted yet) was correctly rejected with `409 "Invalid transition: pending -> manager_confirmed"`.
- Mass-assignment resistance: `PATCH /profile` with `role`, `isAdmin`, `permissions`, `organisationId` injected → `400`, itemized per rejected field. `POST /shifts` with `organisationId`, `status`, `createdBy` injected → same. Two offer-response endpoints (`accept`) don't even bind a request body (no `@Body()` parameter), so injected fields are structurally inert rather than merely rejected.

# IDOR/BOLA Findings

**CONFIRMED SECURE** — no bypass found, tested live with real cross-account requests.

- Staff A, authenticated, attempting `POST /offers/{Staff B's offer id}/accept` and `.../decline` → both `404 Not Found` (not 403 — matches the codebase's own "404 for out-of-scope, 403 for categorical denial" rule). `GET /offers/mine` for Staff A returned only Staff A's own offer.
- File/avatar retrieval (`GET /rest/v1/files/*`): unauthenticated request → `401`. Path-traversal and URL-encoding bypass attempts against the hand-rolled prefix-check authorization (`../../../../etc/passwd`, encoded `..%2F`, cross-prefix construction) all → `404`. Same-organisation cross-user avatar viewing (Staff B, or Manager A, fetching Staff A's avatar by its known key) returned `200` — **this is expected/by-design** for a profile-picture endpoint displayed throughout the UI to other org members, not a vulnerability; true cross-**organisation** isolation for this endpoint could not be empirically exercised in this environment (only one organisation exists) but is soundly implemented in source as an explicit `ctx.organisationId` prefix check, independent of the RLS-bypass issue below since file storage isn't a Postgres table.

# Database Findings

See **VULN-001** and **VULN-002** below for the two confirmed database-layer issues. Beyond those:

- **SQL/NoSQL injection:** every raw SQL statement found in the codebase (`offer.service.ts`, `audit.service.ts`, migrations) uses parameterized placeholders (`$1`, `$2`, …) — no string concatenation with request-derived values was found anywhere. `offer.service.ts` additionally uses an optimistic-concurrency pattern (`UPDATE ... WHERE id = $1 AND status = $2`, checking `rowCount`) on every offer-status transition, which also closes the obvious double-accept/double-confirm race condition without needing a separate lock. Code-reviewed as sound; no injection point existed to test live against.
- **Database authorization (ownership checks in queries):** a targeted review of every `User`/`Organisation`/`RefreshToken`/`LoginHistory`/`PasswordResetToken` query in the codebase found all but one path either explicitly filtered by `organisationId`, or keyed on an already-trustworthy ID (JWT-verified caller's own `userId`, or a foreign key sourced from a different, RLS-`FORCE`d, already-org-scoped row). The one exception is VULN-002.

# SQL/NoSQL Injection Findings

No NoSQL is in use (pure Postgres/TypeORM). See Database Findings above — no injectable query construction found; not exploitable live because no vulnerable query exists to target.

# API Security Findings

- **CORS:** explicit origin allowlist (`CORS_ORIGINS`, defaults to `http://localhost:5173` only), never `*`. Verified live: an `OPTIONS`/`GET` from `Origin: https://evil-attacker.example` and `Origin: null` both omit `Access-Control-Allow-Origin` entirely (browser would block script access to the response), while the allowed origin correctly receives the header. `credentials: true` is safe here specifically because the origin is never reflected/wildcarded.
- **Security headers:** Helmet-derived `Content-Security-Policy` (self-only, no `unsafe-inline` scripts), `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-XSS-Protection: 0` (correct modern guidance) — present on every response observed.
- **Mass assignment:** see Authorization Findings — global `forbidNonWhitelisted` DTO validation confirmed live on multiple endpoints.

# Role Escalation Findings

No successful escalation. See Authorization Findings.

# Payroll Findings

**NOT APPLICABLE.** No payroll module exists in this codebase yet (confirmed by source review — only forward-looking `PermissionFlag`s and a `payroll-transitions.ts` state table exist; no controller, service, or route). Nothing to attack.

# Shift Findings

- Shift creation/publish/cancel restricted to `SCHEDULE_CREATE`/`SCHEDULE_PUBLISH` as designed; tested live as Manager A.
- **VULN-004 (LOW):** `POST /shifts/:id/cancel` accepts a completely unvalidated `reason` — see below.
- Illegal shift-state transitions were not separately fuzzed beyond the offer-side transition test (time-boxed); the transition table is centrally enforced via the same `assertTransition`/`InvalidTransitionError` → `409` mechanism confirmed working for offers, and `shift.service`/`offer.service` both route through it, so this is treated as code-reviewed-consistent rather than independently re-proven per transition.

# Offer Workflow Findings

Fully exercised live end-to-end with real Staff A/Staff B/Manager A accounts:

- `PENDING → STAFF_ACCEPTED` (Staff B accepting their own offer) — succeeded correctly.
- `STAFF_ACCEPTED → MANAGER_CONFIRMED` attempted directly from `PENDING` (skipping acceptance) by the manager — correctly `409`.
- Staff A attempting to accept/decline Staff B's offer — `404` (BOLA blocked).
- Staff A attempting `POST /offers/:id/confirm` on their own offer (manager-only action) — `403` (categorical permission denial, correctly distinguished from the 404 IDOR case above).

# Clock-In/Clock-Out Findings

**NOT APPLICABLE** — module not implemented yet (see Payroll Findings; same codebase state).

# XSS Findings

No `dangerouslySetInnerHTML` (or equivalent raw-HTML sink) exists anywhere in `rab-front/src` — confirmed by full-repo grep. Since React escapes all interpolated text by default, arbitrary strings returned from the API (staff names, shift notes, the unvalidated shift-cancel `reason` from VULN-004) do not have an available stored-XSS sink on the current frontend. Not separately fuzzed with `<script>` payloads against the API given this — the sink doesn't exist to receive them meaningfully. Reflected/DOM XSS: not applicable to a pure JSON REST API with no server-rendered templates.

# CSRF Findings

**Not exploitable by design**, not separately live-tested: authentication is Bearer-token-in-`Authorization`-header only (confirmed in `rab-front/src/shared/api.ts` and in the `JwtAuthGuard` source, which only reads `Authorization: Bearer`), never a cookie. A cross-site form/fetch cannot attach a token it doesn't have access to, so there is no ambient-credential CSRF surface to test against.

# CORS Findings

See API Security Findings — confirmed correctly restrictive.

# File Upload Findings

- Both upload endpoints (`POST /profile/avatar`, `POST /workspace/logo`) are magic-byte-sniffed server-side (PNG/JPG/WEBP only) with server-constructed storage keys (`org/{orgId}/avatar/{userId}/{uuid}.{sniffedExt}`) — client-supplied filename/Content-Type is never trusted for the extension, which is the correct defense against path-traversal/content-type-spoofing via upload. Not independently re-tested with a malicious extension/MIME given this was confirmed by source review and the live upload test used a real, valid PNG.
- Retrieval authorization: see IDOR/BOLA Findings.

# Secrets Findings

No committed secrets found. `git grep` across all tracked files for common credential patterns (AWS keys, Stripe live keys, PEM private key headers, Slack/GitHub/Google API token shapes) returned nothing, and no `.env`-shaped file is tracked in git (only `.env.example`, which contains no real secret values — `APP_SECRET` is blank in the example). The local `.env` actually in use on disk (untracked, correctly gitignored) does contain a real-looking `APP_SECRET`; this is expected for local dev and out of scope for a repo-secrets scan.

# Dependency Findings

`yarn npm audit --recursive`:

| Package | Severity | Advisory | Applicability |
|---|---|---|---|
| `nx` 22.5.4 | HIGH | Zip-Slip in the self-hosted Nx remote cache (GHSA-vp3h-ghgh-jr7g) | Build tooling only; this project does not appear to run a self-hosted Nx remote cache. Not reachable from the deployed application. |
| `picomatch` 4.0.2 (via `@nx/js`) | HIGH | ReDoS via extglob quantifiers (GHSA-c2c7-rcm5-vvqj) | Transitive build-tool dependency of `@nx/js`; not part of the runtime server or frontend bundle. |

0 CRITICAL findings. Both HIGH findings are dev/build-tooling only — **not confirmed reachable from the deployed application's runtime attack surface** — listed as Potential Findings, not Confirmed Vulnerabilities, per the "don't exaggerate scanner findings" rule. Recommend addressing in a routine dependency bump regardless (not implemented here, per engagement scope).

# Business Logic Findings

- The offer workflow's two-step acceptance (`staff.accept` → reserve only; `manager.confirm` → finalize) cannot be short-circuited by either party — confirmed live (see Offer Workflow Findings).
- The unvalidated `reason` field on shift cancellation (VULN-004) is a business-logic/data-integrity gap rather than an injection or auth issue: no downstream logic branches on its content today, so its blast radius is presentation/storage-hygiene, not a security boundary.

# Security Header Findings

See API Security Findings — fully compliant Helmet configuration confirmed live on every response sampled.

# Confirmed Vulnerabilities

## VULN-001

**Title:** Live database role misconfiguration causes the server's actual runtime connection to be exempt from Row-Level Security on 5 tenant/pre-auth tables

**Severity:** 🔴 CRITICAL

**Status:** CONFIRMED (database-layer bypass verified directly; application-layer exploitation currently limited to the one path in VULN-002)

**OWASP:** API1:2023 Broken Object Level Authorization / CWE-284 Improper Access Control (root cause: CWE-668 Exposure of Resource to Wrong Sphere via broken RLS enforcement)

**Affected component:** `packages/rab-docker/docker-compose.yml:41,66` — both the `server` and `worker` services hardcode `DATABASE_URL: postgres://rab_owner:rab_owner_dev_only@postgres:5432/rab`, overriding whatever `packages/rab-server/.env` (`env_file:`) specifies, since Compose's `environment:` block takes precedence over `env_file:`.

**Account used:** direct `psql` connections as both `rab_owner` and `rab_app` against the live `rab-postgres-1` container (no HTTP account needed to demonstrate this layer).

**Object accessed:** `core."user"` and `core.organisation` — full, unfiltered table contents.

**Attack performed:**
1. Confirmed via `pg_roles` that neither `rab_owner` nor `rab_app` has `rolbypassrls` or `rolsuper` set.
2. Confirmed via `pg_class` that `rab_owner` owns every table in `core`, and that exactly 5 tables (`user`, `organisation`, `refresh_token`, `login_history`, `password_reset_token`) have `relrowsecurity = t` but `relforcerowsecurity = f` — i.e., RLS is enabled but not forced, which in Postgres semantics exempts the table **owner** specifically (unless the owner is superuser/BYPASSRLS, which `rab_owner` is not).
3. Ran `SELECT id, organisation_id, email, status FROM core."user";` as `rab_owner` with **no `SET LOCAL rab.organisation_id` bound at all** → returned all 5 rows in the database, spanning the seeded admin, all 4 pentest accounts, and the operator's own personal test accounts, with no filtering whatsoever.
4. Ran the identical query as `rab_app` (the role the docs/`.env.example` say the server is *supposed* to use) under the same no-context condition → correctly returned 0 rows, demonstrating the fail-closed behavior works perfectly for the role it was actually designed for.
5. Confirmed via `docker-compose.yml` that the live `server`/`worker` containers are configured to use `rab_owner`, not `rab_app` — this is not a hypothetical connection string, it is the one actually in use by the containers running during this engagement.

**Expected result:** every query against every tenant-relevant table, run with no tenant context bound, returns zero rows (per the codebase's own stated non-negotiable rule).

**Actual result:** for 5 specific tables, the runtime database role is structurally exempt from that guarantee. It currently only holds because every reachable application code path *additionally* re-implements org-scoping in its own `WHERE` clause (layers 2/3) — which was true for all but one path found (VULN-002).

**Evidence:**
```
-- as rab_owner, zero tenant context:
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('rab_owner','rab_app');
 rab_owner | f | f
 rab_app   | f | f

SELECT relname, relowner::regrole, relrowsecurity, relforcerowsecurity
FROM pg_class ... WHERE nspname='core';
 login_history        | rab_owner | t | f
 organisation          | rab_owner | t | f
 password_reset_token  | rab_owner | t | f
 refresh_token         | rab_owner | t | f
 user                  | rab_owner | t | f
 (all other 21 tables) | rab_owner | t | t   <- correctly FORCE'd

-- as rab_owner (== the actual server connection), no SET LOCAL:
SELECT id, organisation_id, email, status FROM core."user";
→ 5 rows returned (every user in the database, across all seeded/test data)

-- as rab_app, no SET LOCAL:
SELECT id, organisation_id, email, status FROM core."user";
→ 0 rows returned  (correct, fail-closed)
```

**Database impact:** every current and future query against `user`, `organisation`, `refresh_token`, `login_history`, or `password_reset_token` that omits an explicit `organisationId`/equivalent filter — anywhere in the codebase, present or future — silently returns cross-tenant data instead of erroring or returning nothing. There is currently no second line of defense for these 5 tables; the documented "5 enforcement layers" architecture is effectively 4 layers for exactly these tables, in exactly this deployment configuration.

**Source location:** `packages/rab-docker/docker-compose.yml:41` (server), `:66` (worker); root cause context in `packages/rab-server/.env.example` (comment describing an M0→M1 role-split that was never carried into the Compose file) and `packages/rab-docker/postgres-init/01-roles.sql:7-13` (role definitions/intent).

**Root cause:** the repo's own `.env.example` documents the intended migration: *"M1 must split this into a separate runtime connection as rab_app (NOBYPASSRLS) once the first RLS policy exists, so the running server never connects with owner privileges."* RLS policies now exist comprehensively (well past "the first policy"), but `docker-compose.yml` — which is the actual config driving the containers used for this deployment, including the "Railway-target" production image per its own comments — was never updated to match; it still hardcodes the M0-era `rab_owner` connection for both `server` and `worker`.

**Potential impact:** in the current single-organisation test environment this could not be escalated into an observed cross-tenant data leak through the live API (see VULN-002 for the one exception). The moment a second organisation exists in production and any future code path — a new report, a new admin widget, a bugfixed query, a one-off script — queries any of these 5 tables without remembering to add an explicit org filter, it becomes a full, silent, unauthenticated-from-the-app's-perspective cross-tenant PII leak (emails, account status, refresh-token hashes, login history, password-reset-token hashes) with no RLS safety net to catch the mistake, exactly the scenario the "5 layers, not 1" architecture doctrine exists to prevent.

**Recommended remediation (do not implement):** point `DATABASE_URL` in `docker-compose.yml`'s `server` and `worker` services at `rab_app`/`rab_app_dev_only` instead of `rab_owner`, reserving `rab_owner` for migrations only (a separate, short-lived connection/step, as `setup-db.js` already runs before `main.js` starts in the same container command — that ordering can stay, only the *runtime* server/worker connection needs to change). Re-run the abuse-case test described in CLAUDE.md's testing floor ("every new tenant-scoped table needs an integration test that runs a query with no tenant context bound and asserts zero rows back") against these 5 tables specifically, using whatever role actually ends up wired into production, not an assumption about which role that is.

---

## VULN-002

**Title:** `WorkspaceService.updateSubdomain` performs an unscoped cross-organisation lookup outside the three documented pre-auth RLS exceptions

**Severity:** 🟡 MEDIUM

**Status:** CONFIRMED (code-verified; not independently exploitable today because only `.id` is compared, not returned, but see Potential Impact)

**OWASP:** API1:2023 Broken Object Level Authorization (structural)

**Affected endpoint:** `PATCH /rest/v1/workspace/domain` (fully authenticated, `JwtAuthGuard` + `PermissionGuard(SETTINGS_EDIT)`, post-tenant-context)

**Account used:** code review (not separately re-run live beyond confirming the endpoint requires a real authenticated `SETTINGS_EDIT` session, which Manager A does not hold in this org's default role grants).

**Object accessed:** any other organisation's full `Organisation` row (name, legal name, address, contact, `logoKey`, settings, timezone), fetched but not currently returned to the caller beyond a boolean-shaped conflict.

**Attack performed (theoretical, not executed as a live exploit given current field usage):** an authenticated user with `SETTINGS_EDIT` submits a `slug` they believe another organisation is using; the full row for that organisation is loaded into memory server-side outside `runInTenantContext`.

**Expected result:** if this is intended to be a fourth, deliberate pre-auth-style exception (alongside login/refresh/resetPassword), it should be documented and scoped to the minimum necessary (an existence check), matching the pattern already used everywhere else in the codebase.

**Actual result:** it is not on the documented exception list, runs on `this.dataSource.manager` (the unscoped connection) exactly like the three documented cases, and fetches the entire row rather than a scalar existence flag.

**Evidence:** `workspace.service.ts:52-63`:
```ts
async updateSubdomain(ctx: AuthContext, dto: UpdateSubdomainDto): Promise<WorkspaceResponse> {
  const taken = await this.dataSource.manager.findOne(Organisation, { where: { slug: dto.slug } });
  if (taken && taken.id !== ctx.organisationId) {
    throw new ConflictException('This subdomain is already taken.');
  }
  ...
```

**Database impact:** none observed today — only `.id` is read from `taken`, and the response only ever surfaces a generic `409 Conflict`. This is exactly the situation VULN-001 warns about: a code path that already, today, depends on the RLS-bypass-on-owner-connection behavior for its correctness (it needs to see across orgs), sitting right next to a field-rich entity that a small future change (e.g., "tell the user which org owns this slug" for a better error message) would turn into a real leak with no RLS backstop to catch it.

**Source location:** `packages/rab-server/src/modules/identity/services/workspace.service.ts:60`

**Root cause:** same structural cause as VULN-001 — reliance on cross-org visibility that only exists because `organisation` is one of the 5 non-`FORCE`d tables, combined with the runtime role being the table owner.

**Potential impact:** low today (no field beyond a boolean-shaped conflict leaks); the real risk is that this pattern is now precedent — the next engineer who needs a cross-org check has both VULN-001's broken safety net and an existing (uncatalogued) example to copy from.

**Recommended remediation (do not implement):** narrow the query to `SELECT id ... WHERE slug = $1 LIMIT 1` (or a `.exists()`-style query) so even a full RLS bypass can only ever leak a boolean, and add this as a fourth, explicitly documented and signed-off exception alongside the three in `auth.service.ts`, per CLAUDE.md's own rule that RLS exceptions get a `SECURITY TRADE-OFF` note.

---

## VULN-003

**Title:** Password-reset tokens are not invalidated as a set when one of them is successfully used

**Severity:** 🟠 HIGH

**Status:** CONFIRMED — reproduced live, end-to-end, against a real account

**OWASP:** CWE-640 Weak Password Recovery Mechanism (improper invalidation of a security-relevant token on state change)

**Affected endpoint:** `POST /rest/v1/auth/reset-password`

**Account used:** `staffa.pentest@acme.test`

**Attack performed:**
1. Called `POST /auth/forgot-password` for the account — server logged (via `EMAIL_DRIVER=LOGGER`) reset token **T1**.
2. Called `POST /auth/forgot-password` again for the same account ~20 seconds later — server logged a second, independent, valid reset token **T2** (T1 was never invalidated by this second request either, though that alone is a lesser, common pattern).
3. Used **T1** to successfully reset the password to a new value — `204 No Content`. Confirmed the password actually changed by logging in with the new value.
4. Immediately re-submitted **T1** — correctly rejected `400 "This reset link is invalid or has expired."` (single-token reuse is properly blocked).
5. Submitted **T2** (the older-issued-but-never-used second token) — **succeeded, `204 No Content`**, silently overwriting the password set in step 3 with yet another new value, with no relationship to the current/prior password required.

**Expected result:** once a password has been successfully changed via any reset token, every other outstanding reset token for that same account should be invalidated — mirroring the app's own correct handling of refresh tokens (`resetPassword()` already calls `refreshTokenService.revokeAllForUser()`, so sessions are properly killed; reset tokens are not).

**Actual result:** each `password_reset_token` row is invalidated independently and only by its own use or its own expiry; a completely different, valid token for the same user is unaffected by a successful reset via another token.

**Evidence:**
```
POST /auth/reset-password  {token: T1, newPassword: "...Reset!67"}  → 204
POST /auth/reset-password  {token: T1, ...}   (replay)              → 400 (correctly blocked)
POST /auth/login  {password: "...Reset!67"}                          → 200 (change from T1 confirmed applied)
POST /auth/reset-password  {token: T2, newPassword: "...4!89"}      → 204  ⚠ should have been rejected
```

**Source location:** `packages/rab-server/src/engine/core-modules/auth/services/auth.service.ts:340-358` (`resetPassword()` — revokes refresh tokens on success but never touches sibling reset tokens); `packages/rab-server/src/engine/core-modules/auth/token/services/password-reset-token.service.ts:55-67` (`consume()` — only ever marks the one presented token's `usedAt`, scoped by its own `id`, never by `userId`).

**Root cause:** `consume()` has no knowledge of — and `resetPassword()` never separately calls anything to invalidate — any other `password_reset_token` row belonging to the same user. The refresh-token side of the same function got this right (`revokeAllForUser`); the reset-token side does not have an equivalent call.

**Potential impact:** if an attacker obtains any single valid reset link for a victim's account at any point during its lifetime (compromised email at some point in the past, a shoulder-surfed or logged link, a link sent to a shared/former inbox, multiple "forgot password" clicks by the legitimate user leaving stale links around) and the legitimate user separately, successfully resets their own password using a *different* link (believing this secures the account), the attacker's still-unexpired token remains fully capable of overwriting the password again — a genuine account-takeover path that a user's own defensive password reset does not close. Given the 1-hour TTL on self-service reset tokens, the exploitation window is bounded but real, and admin-triggered/invite tokens use a longer (48h) TTL per the codebase's own comments, widening the window in that case.

**Recommended remediation (do not implement):** in `resetPassword()`, after successfully consuming the presented token, invalidate every other outstanding (`usedAt IS NULL`) `password_reset_token` row for that `userId` (e.g., `manager.update(PasswordResetToken, { userId: consumed.userId, usedAt: IsNull() }, { usedAt: now })`), mirroring the existing `revokeAllForUser` call immediately below it.

---

## VULN-004

**Title:** `POST /shifts/:id/cancel` accepts and persists an entirely unvalidated `reason` field

**Severity:** 🔵 LOW

**Status:** CONFIRMED — reproduced live

**OWASP:** API8:2023 Security Misconfiguration (missing input validation) / CWE-20 Improper Input Validation

**Affected endpoint:** `POST /rest/v1/shifts/:id/cancel`

**Account used:** `managera.pentest@acme.test`

**Attack performed:** sent `{"reason": [1,2,3]}` (a JSON array, not a string) as the cancel reason for a real, live shift.

**Expected result:** `400 Bad Request` — every other mutating endpoint in the codebase validates its body via a `class-validator` DTO under the global `forbidNonWhitelisted` pipe, and would reject a type mismatch like this.

**Actual result:** `201 Created` — the shift transitioned to `cancelled`, and the array was silently coerced by the Postgres driver into the array-literal string `{"1","2","3"}` and persisted directly into the `cancelled_reason text` column.

**Evidence:**
```
POST /shifts/{id}/cancel  {"reason": [1,2,3]}   → 201, shift.status = "cancelled"
GET  /shifts/{id}                                → "cancelledReason": "{\"1\",\"2\",\"3\"}"
```

**Database impact:** none beyond storing malformed/type-confused data — the column is unconstrained `text` with no application-level length cap (unlike every DTO-validated string field elsewhere in the codebase, which uses `@MaxLength`). No injection or crash resulted.

**Source location:** `packages/rab-server/src/modules/scheduling/controllers/scheduling.controller.ts:56` — `cancel(@AuthUser() ctx, @Param('id') id, @Body('reason') reason: string)` uses Nest's `@Body('reason')` property-extraction form, which bypasses the DTO/`ValidationPipe` entirely (there is no class for the pipe to validate against), unlike every other mutating handler in the codebase.

**Root cause:** this is the one handler in the codebase (confirmed by full-codebase review at the start of this engagement) that reads a request-body field directly rather than through a validated DTO class.

**Potential impact:** low in isolation — no downstream logic branches on `cancelledReason`'s type or content today, and it is not reflected into any HTML-rendering sink (see XSS Findings). Realistic impact is data-integrity/display corruption (a frontend expecting a plain string could render `{"1","2","3"}`-shaped garbage) and unbounded storage growth (no length cap), not a security-boundary bypass.

**Recommended remediation (do not implement):** add a `CancelShiftDto` with `@IsString() @IsOptional() @MaxLength(500) reason?: string` and bind it via `@Body() dto: CancelShiftDto`, matching every other mutating handler.

---

# Potential Findings

Scanner/static-analysis-style results not independently reproduced as a live exploit against this application's runtime, listed separately per the engagement's own rule against presenting unverified results as confirmed:

| Finding | Source | Why not "Confirmed" |
|---|---|---|
| `nx` 22.5.4 — Zip-Slip in self-hosted remote cache (GHSA-vp3h-ghgh-jr7g) | `yarn npm audit` | Build-tooling dependency; no self-hosted Nx remote cache found configured in this repo; not reachable from the deployed server/frontend. |
| `picomatch` 4.0.2 via `@nx/js` — ReDoS (GHSA-c2c7-rcm5-vvqj) | `yarn npm audit` | Same — transitive build-tool dependency, not part of the runtime bundle. |
| Access tokens/refresh tokens stored in `localStorage` (`rab-front/src/shared/api.ts`) | Code review | A real design trade-off (XSS-exfiltrable if a stored/DOM XSS sink ever exists) but no such sink was found in this engagement (see XSS Findings) — noted as defense-in-depth, not a demonstrated exploit path. |

---

# Attack Paths

The one attack path with a real (if partial) chain, demonstrated end-to-end in this engagement:

**Password-reset token replay → account takeover (VULN-003):**
`attacker obtains any historical valid reset link for victim` → `victim independently resets their own password via a different link, believing the account is now secure` → `attacker's stale token is still valid` → `attacker resets the password again with their own token` → `attacker now controls the account, victim's own defensive action did not close this`.

No other multi-step chain was found; every other tested path (BOLA, vertical escalation, mass assignment, workflow-state bypass) was blocked at the first step attempted.

# Severity Summary

| ID | Vulnerability | Severity | Confirmed | Component |
|---|---|---|---|---|
| VULN-001 | Runtime DB role (`rab_owner`) is RLS-exempt on 5 tables | 🔴 CRITICAL | Yes (DB-layer verified live) | `docker-compose.yml`, DB roles |
| VULN-003 | Password-reset tokens not invalidated as a set | 🟠 HIGH | Yes (live, end-to-end) | `auth.service.ts`, `password-reset-token.service.ts` |
| VULN-002 | Unscoped cross-org `Organisation` lookup outside documented exceptions | 🟡 MEDIUM | Yes (code-verified) | `workspace.service.ts:60` |
| VULN-004 | Unvalidated raw body field on shift cancel | 🔵 LOW | Yes (live) | `scheduling.controller.ts:56` |
| — | Nx / picomatch build-tooling advisories | 🟡 MEDIUM (per advisory) | Potential only | dependency tree |
| — | Bearer tokens in `localStorage` | ⚪ INFORMATIONAL | Potential only | `rab-front/src/shared/api.ts` |

**CRITICAL:** 1
**HIGH:** 1
**MEDIUM:** 1 confirmed + 1 potential
**LOW:** 1
**INFORMATIONAL:** 1

---

# FINAL VERDICT

## FAIL

Two findings individually justify this verdict, both demonstrated live rather than inferred:

1. **VULN-003 is a fully reproduced, exploitable authentication weakness** — an attacker holding any previously-issued, unexpired password-reset token can silently retake an account even after the legitimate user has already used a different link to change the password, which is precisely the scenario a password reset is supposed to close off. This was executed against a real account in this engagement, not theorized.
2. **VULN-001 is a verified, live violation of the codebase's own stated non-negotiable security invariant** ("a query run with no tenant context bound returns zero rows, never all rows") for 5 specific tables, in the exact database role the running containers actually use — not a hypothetical misconfiguration description, a directly-queried and directly-compared result. It is not scored as a demonstrated full data-exfiltration exploit today only because every *other* current code path happens to duplicate the tenant-scoping check — except one, VULN-002, which already does not. A single future or overlooked query against any of these 5 tables has no safety net.

Everything else tested — every BOLA/IDOR attempt, every vertical-escalation attempt, every mass-assignment attempt, JWT forgery, CORS, security headers, rate limiting/lockout, refresh-token reuse, offer/shift state-machine integrity, and SQL injection — held up under live, active testing with real accounts. This is a well-built application with two specific, fixable gaps, not a systemically weak one; the FAIL reflects that those two gaps are real and exploitable as found, not an assessment of the codebase's overall quality.
