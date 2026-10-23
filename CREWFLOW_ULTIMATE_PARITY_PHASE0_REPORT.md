# Crewflow "Ultimate Twenty Engine Parity, Auth Security & Workspace Domain" — Phase 0

**Date:** 2026-10-22 (evening UTC; evidence folder is dated 2026-10-23 as requested)
**Mode:** read-only. No source, migration, compose, config or test file was changed. No DB writes, container restarts,
commits, pushes or deploys. No production, Neon or remote DB was contacted. No secret value was printed.
**Files created:** this report and `docs/evidence/ultimate-parity-phase0-2026-10-23/{00-current-state.txt,01-twenty-reference.txt}`.

This report **reuses** `CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md` (18 areas, F1–F6; same day) and updates it
rather than redoing it. It reconciles `docs/security/master-auth-audit/*`, `docs/security/twenty-auth-comparison/*`,
`docs/TWENTY_GOOGLE_AUTH_{GAP_ANALYSIS,PARITY_REPORT}.md`, `SECURITY.md`, `SECURITY_AUDIT.md` and `THREAT-MODEL.md`.
No dedicated subdomain comparison report existed; workstream C below is the first one.

Path prefixes: `S/` = `packages/rab-server/src/`, `M/` = `S/database/typeorm/core/migrations/`,
`WS/` = `S/database/typeorm/workspace-schema/v1/`, `W/` = `packages/rab-worker/src/`. Twenty paths are relative to
`packages/twenty-server/src/engine/core-modules/` unless they start with `twenty-shared`.

---

## 1. Current state (verified, with evidence)

Raw output: `docs/evidence/ultimate-parity-phase0-2026-10-23/00-current-state.txt`.

| Fact | Verified value | Matches the brief? |
|---|---|---|
| Branch / HEAD | `feat/venue-manager-teams-ui` @ `073aa17cd20bf62af20d5af670ecb892c06078d4` | yes |
| Uncommitted changes | **158** porcelain entries: 85 M, 3 D, 70 untracked (dirs counted once). By area: rab-server 72, rab-mobile 26, rab-docs 14, rab-front 13, rab-worker 10, rab-docker 6, rab-shared 5, rab-iphone 1 (new package), root reports 8, `.github` 1, `skills-lock.json` 1, `THREAT-MODEL.md` 1. They come from at least five sessions: server-path provisioning, foundation fixes, attendance check-in/offers/replacement, mobile VM redesign, docs/video, and the worker bundle. | ~150: yes |
| Other Claude sessions | **I cannot list sessions.** Indirect evidence that another session is live: `crewflow-test-db` was **recreated at 2026-10-22T22:30:56Z**, during this phase (it is not my doing). Of the dirty files, only `CREWFLOW_FOUNDATION_FIXES_REPORT.md` changed in the last hour. | n/a |
| rab-devdb migrations | **194**. The latest are 1786719620000, …610000, …600000, …520000, …510000, …500000, …450000, …400000. | yes |
| HWS on in the running containers | `HWS_RUNTIME_ENABLED=true` on **both** `rab-server-1` and `rab-worker-1` (started 19:26Z). It comes from the compose override `C:\Users\issac\AppData\Local\Temp\claude\c--Rab-recruit\1b19e164-6637-40ff-9cdb-999e37536ec0\scratchpad\spp\cutover\hws-on.override.yml`. | yes, with a caveat (see S1) |
| Business rows | core: 1 organisation, 1 user, 11 audit rows, **0** rows in all 12 business tables checked. `workspace_3035bcde…`: 0 rows. The registry has 1 workspace, `READY`, `schema_version` 1. | fresh install: yes |
| Provisioner in the worker bundle | Yes. `start-worker-bundle.cjs` (under tini) runs `dist/main.js` (uid 1000, `crewflow_app`) and `dist/workspace-provisioner.main.js` (uid 10001, `crewflow`, HWS forced true). The live identity probes agree. | yes |
| Server-path provisioning migrations applied | 1786719500000 / 510000 / 520000 are in the ledger. `core.provision_workspace` is called from `ManagerWorkspaceService.create()` (`workspace-provisioning.service.ts:74-77`). | yes |
| Shared test DB | **Changed since the brief.** `crewflow-test-db` (:15436) was recreated at 22:30:56Z by another session: **0 workspace schemas**, 194 migrations, `max_locks_per_transaction` **still 64**. That session's re-checks (`fresh-install-tests-2026-10-22/90-93-*.log`, written 22:31–22:32Z) show the shared-memory suites now pass: containment 5/5 and worker provisioning/entrypoint 11/11. The DB will regrow by roughly one schema per provisioning test. | the "~140 schemas / 16 failures" fact is now stale |
| Latest test evidence | `foundation-fixes-2026-10-22`: server unit 537/540 (3× `tenant-context.service.spec`, stale); server integration 1495 pass / 8 fail / 61 skip (identity-security-table-rls ×2, shift-team ×1, containment-suspend ×5 = out of shared memory); worker 413 / 21 fail (member-invitation-delivery ×9 stale DTO, the 91-day token cleanup ×1, provisioning ×6 + entrypoint ×5 = out of shared memory). `fresh-install-tests-2026-10-22/60-lint.log`: rab-utils `TS18003`. | all yes |

**Surprises**
- **S1.** The HWS-on setting exists only in a temporary scratchpad override. Recreating the stack from the repo compose files would **silently turn HWS off**, and the scratchpad can be deleted.
- **S2.** `docs/HANDOFF.md` is stale on the dev DB:
  - Its last state entry says rab-devdb has **4 workspace schemas, 292 business rows, HWS OFF**.
  - Actual state: a fresh install with 1 schema, 0 business rows and HWS on.
  - No HANDOFF entry records the fresh dev install or the HWS-on switch.
- **S3.** The reconciler logged `workspace provisioning: attempted=1 ready=0 failed=1` at 19:41:24, the same second the registry shows the workspace `READY` through the server path.
  - This is probably a lost race against `core.provision_workspace`, which is benign.
  - The **failure reason is not logged** (an observability gap). Not verified further.
- **S4. F1 is live on dev.** Both `email_outbox` rows (`WELCOME`, `ACCOUNT_INVITATION`) are `SENT` with `rendered_html` still stored. The invitation body carries an activation link.

## 2. Twenty reference (refreshed)

- **Commit examined:** `65354f9e1d040476f4f341055bce01ea83f46b07` (2026-10-22T20:35Z). It is a shallow sparse clone in the session scratchpad, outside the repo.
- It is only **4 commits** after `6a1e7de9…` (evidence `01-…txt`):
  - `65354f9e`: app connection-provider OAuth recovery. Not Crewflow-relevant.
  - `cf180c72`: refuses row-level-permission rule changes on non-editable roles.
  - `d975a8ea`: default-role picker shows only user-assignable roles.
  - `42708716`: a UI label.
- **Nothing changed** in two-factor-authentication, jwt/signing keys, user-session cookies, `ReservedSubdomains.ts` (124 lines) or `SubdomainPattern.ts`.
- `WorkspaceDomainsService.computeWorkspaceRedirectErrorUrl` changed only its signature (object args, plus `searchParams` and `hash`).
- Every Twenty fact in the 18-area report therefore still holds.

## 3. Classification matrix

### Status counts

| Workstream | PRESENT | PARTIAL | MISSING | DIFFERENT BY DESIGN | BLOCKED |
|---|---|---|---|---|---|
| A: 18 engine areas | 4 | 7 | 2 | 5 | 0 |
| B: auth B1–B9 | 1 | 7 | 1 | 0 | 0 (B8 live values are BLOCKED; the repo side is PARTIAL) |
| B10: further controls (13) | 5 | 4 | 3 | 1 (+1 n/a) | 0 |
| C: subdomain C1–C15 | 4 | 4 | 5 | 1 | 1 (C11 infrastructure) |
| D: critical findings | 15 open, 0 fixed in this phase (see §3.4) | | | | |

### 3.1 Workstream A: engine parity (update to the 18-area report)

17 of 18 classifications are unchanged. **Area 3 moved materially:** server-path provisioning is now PRESENT, but the area stays PARTIAL because runtime reads are core-only in production.

| # | Area | Status | Changed since the 18-area report | Smallest next step, reusing existing code | Gate | Days |
|---|---|---|---|---|---|---|
| 1 | Engine | DIFFERENT BY DESIGN | Packaging only (four-service prod compose, worker bundle) | none | — | 0 |
| 2 | ORM / binding | DIFFERENT BY DESIGN | no | Lint against `set_config(…,false)` and `SET SESSION`; test-only pool-checkout assertion; merge `WorkspaceExecutionContext` into `TenantContextService` | — | 1–2 |
| 3 | Tenant model / HWS | PARTIAL | **yes**: `core.provision_workspace` is SECURITY DEFINER (`search_path` pinned, GUC/owner match, advisory lock; M/1786719500000:127-236). The API calls it. The reconciler is still needed for `createFor` (Initial Manager) workspaces. | Cutover rehearsal tooling; reverse-copy script | G1-prod, G4 | 10–15 |
| 4 | Isolation (FORCE RLS) | PRESENT, but **F4 open** | no. `check-rls-coverage.ts:133` and `security-posture.ts:16-52` are still core-only; the golden file has 0 `workspace_*` lines | Iterate `^workspace_[0-9a-f]{32}$` with the schema name canonicalised; no-context zero-rows probe per workspace table | — | 1–1.5 |
| 5 | DB roles | PRESENT | `crewflow_app` gained exactly one grant: EXECUTE `core.provision_workspace` (self-verifying) | Golden coverage of `workspace_*` (with 4) | G1 | — |
| 6 | Schema evolution / migrator | PARTIAL (**worse**) | 3 more hand-looped migrations. A template change now needs 6 coordinated edits, including re-creating `provision_workspace` and `verify_workspace_schema_v1`. | `WorkspaceSchemaMigrator` + `core.workspace_schema_migration` ledger, owning the server-path template version | G2 | 8–10 |
| 7 | Version ledger / drift | PARTIAL | `verify_workspace_schema_v1` (count-based, `crewflow` only) added; `schema_version` hard-coded to 1 | Daily drift job as `crewflow` reusing `verify_workspace_schema_v1` plus a policy/grant fingerprint; alert-only first | G2 / G3 | 4–6 |
| 8 | Metadata / field permissions | PARTIAL | no | Add `attendance`, `offer` and `shift_report` objects to `member-object-registry.ts`; enforce `role_field_permission` in `attendance.service.ts` (`earnedPence`, `workedMinutes`, earned filters and sort), `shift-report.service.ts:245,262` and `offer.service.ts:172-215` (`payRatePence`, `estimatedPayPence`). **Custom objects: do not build** (see §5). | owner decision on venue_manager | 3–5 |
| 9 | Soft delete / archive | MISSING | no. Deletion is still hard (`user-deletion.service.ts:187`) | Named archive/restore actions for venue, job_role, staff leaver and draft shift; never for financial, attendance or audit rows | G5 + retention | 7–9 |
| 10 | Money / CHECKs | DIFFERENT BY DESIGN | no | `CHECK (earned_pence>=0 AND worked_minutes>=0)` with `NOT VALID` then `VALIDATE`, core and workspace; `assertSafePence` | G5 | 1–2 |
| 11 | Constraints | PRESENT | new CHECKs (offer_kind, check-in, on-behalf, 21 `_workspace_bound`) | `constraint-regression.integration.spec.ts` per schema (SQLSTATE 23P01/23514/23505) | — | 2–3 |
| 12 | Enums | DIFFERENT BY DESIGN | new transition `NO_SHOW→COMPLETED`. `OfferKind` lives in `S/modules/offer/constants`, not `@rab/shared`. | Test that each transition table equals its DB CHECK list | — | 1 |
| 13 | Search | MISSING | no (still `ILIKE`) | Generated `tsvector` + GIN, plus `pg_trgm`, through the migrator; email only with field permission | G5 | 3–4 |
| 14 | BullMQ / outbox | PRESENT, but **F1 open**, no retention | instance heartbeat only | Null token-bearing bodies at terminal state (now); purge plus replay after the retention decision | G6 | 1 + 3–5 |
| 15 | Audit / timeline | audit DIFFERENT BY DESIGN (stricter); timeline PARTIAL | identity trigger 1786719610000 added; still insert-only | `GET /<entity>/:id/timeline` read model over `audit_log`, with a concurrent index | — | 3 |
| 16 | Metadata cache | PARTIAL | no | L1 for non-auth metadata only (registry, catalogue, and later the host map, C13) | owner per environment | 3–4 |
| 17 | Encryption / rotation | PARTIAL | no. Columns: `smtp_password_encrypted` (rotated), `push_token_encrypted` (not rotated), `totp_secret_encrypted` (unused) | Extend `secret:rotate`; envelope-prefix CHECK; RAB3/AAD deferred | G7 | 2–3 (+5) |
| 18 | Flutter / iOS storage | DIFFERENT BY DESIGN, **F2 open** | no. `const FlutterSecureStorage()` in `api_client.dart:136`, `biometric_store.dart:9`, `onboarding_store.dart:10`, `push_device_store.dart:17` | `IOSOptions(first_unlock_this_device)`, Android options, a fresh-install marker wipe mirroring the iOS `FreshInstallGuard` | — | 1 |

Twenty references for every row are unchanged from the 18-area report §1/§3 (verified still valid at `65354f9e`).

### 3.2 Workstream B: auth security

| # | Item | Status | Twenty (65354f9e) | Crewflow (verified behaviour) | Gap / security difference | Smallest implementation, reusing existing code | Gate | Days |
|---|---|---|---|---|---|---|---|---|
| B1 | MFA: TOTP, recovery codes, replay protection | **MISSING** | `two-factor-authentication.service.ts` (`validateTwoFactorAuthenticationRequirement`, `validateStrategy`, step-up); otplib; secret `enc:v2` CHECK; recovery service. **Twenty has no used-step replay tracking.** | `user.totp_secret_encrypted` and `totp_enabled` are never read or written. `LoginSecondFactorPolicyService` always returns `'none'` and is consulted **only** by the OAuth flow (`oauth-sign-in-flow.service.ts:167,180`), **not** by `AuthService.completeLogin` (password and mobile). | CEO, Initial Manager and platform admins are single-factor. Step-up is password-only. | (1) Gate inside `completeLogin`. (2) Encrypt with `SecretEncryptionService` and add the column to `SecretRotationService`. (3) `totp_last_used_step` with an atomic compare-and-set (replay protection, stronger than Twenty); a `user_recovery_code` table with ENABLE+FORCE RLS; a DEFINER reader. (4) Attempt limits through `rate-limit/token-bucket.ts`. (5) `StepUpReauthService` accepts TOTP. | scope, recovery policy, reset authority | 5–8 |
| B2 | JWT key separation and rotation | PARTIAL | `jwt/` signing-key entity, ES256, `signing-key-rotation.service.ts` cron, legacy HS256 still accepted; **no JWKS** | `access-token.service.ts`: HS256, `kid` on sign, keyring `APP_JWT_SIGNING_KEYRING`/`APP_JWT_ACTIVE_KID`, **legacy key = raw `APP_SECRET`, always in the verify map** | `APP_SECRET` can never be retired as a JWT key | `APP_JWT_LEGACY_VERIFY_ENABLED` flag (false only when a keyring is set). Access TTL is 15 min, so cutover is quick. **Defer ES256/JWKS**: there are no external verifiers. | production key values | 0.5–1 |
| B3 | Cookies, `__Host-`, SameSite, CSRF | PARTIAL | `user-session-cookie.service.ts`: `__Host-twenty-session`, Path=/, SameSite from config | `crewflow_session` (Path=/rest/v1, SameSite **None** in prod), `rab_rt`, `crewflow_oauth_tx`, `crewflow_oauth_handoff`; no Domain attribute. CSRF = Origin allowlist (`jwt-auth.guard.ts:242-248`, `/refresh`, `CredentialRequestProvenanceGuard`, handoff); duplicate-cookie rejection. | No `__Host-` prefix (cookie tossing). Origin trust is over-broad (C9). | `__Host-crewflow_session` with Path=/ in production and a dual-name read for http dev; OAuth cookies to `__Host-`; stop issuing `rab_rt` to web. Lax only if production is same-site. | re-login; production topology (BLOCKED: hostnames not in repo) | 1–1.5 |
| B4 | Forgot-password timing | PARTIAL | `auth.resolver.ts` `emailPasswordResetLink`: captcha, per-email bucket, detached work | 150 ms floor (`auth.service.ts:771-802`). **DB writes only on the existing-account path**, with N× work for N orgs. | Leaks above the floor; no per-email throttle (email bombing) | Return after the floor and run the work detached with logging; per-email bucket. **Measured test:** 200 interleaved requests each for unknown, 1-org and 3-org emails on a disposable DB; p50/p95 Δ < 5 ms; KS p > 0.01; repeat with injected latency. | — | 0.5–1 |
| B5 | Lockout / rate-limit DoS | PARTIAL | No lockout; token-bucket throttler + captcha | 10 failures per **email** per 15 min, **checked before the password** (`auth.service.ts:161-173`). Per-IP 5/min. `TRUSTED_PROXY_CIDRS`. Fail-closed 503 on `@RateLimitRequired`. **Jest switch:** `throttler.module.ts:63` `skipIf` + `jest-setup.ts:15`. Real limiter covered by rate-limiting, client-ip-trust, throttler-redis-outage and attendance abuse specs. | **Targeted lockout DoS** (finding D-A1) | Key on (email, IP) through `login_history.ip` (new function version); global per-email ceiling with progressive delay | threshold policy | 1 |
| B6 | Org "password sign-in disabled" | PARTIAL | `assertPasswordAuthAllowedOnWorkspaceOrThrow` | Enforced at login (`passwordProviderPermits` :332-341), forgot and reset. **Not** at `refresh()` (:551-626). The toggle only bumps `security_version`. | Existing password sessions survive (up to 180 d) | On a true→false toggle, revoke password-provider families through the existing `RefreshTokenService` revoke paths | yes | 0.5–1 |
| B7 | OAuth transaction / handoff cleanup | PRESENT | express-session state | `oauth_transaction_state`: single-use atomic consume, browser binding, TTL 10/5 min, purge `worker_cleanup_oauth_transaction_state` | Verifier and nonce stored plaintext until purged (CF-33) | Optional encryption | — | 0.5 |
| B8 | Production DB role cutover in all deployment definitions | PARTIAL (repo) / BLOCKED (live OpenShip values) | n/a (Twenty uses one credential) | Committed HEAD production compose runs `start.sh` with `DATABASE_URL_UNPOOLED` (fits the crash-loop). The **uncommitted** diff fixes it: api on `crewflow_app` pooled, worker bundle, `rab-migrate` profile. `docker-compose.qa.yml:85,123` uses the **`crewflow` owner** for api and worker, which the boot guard refuses. `render.yaml` uses `rab_app`/`rab_owner` and migrates at start. | Stale QA and Render definitions; production values unverifiable | Commit the production compose diff; fix QA to `crewflow_app` + `CREWFLOW_PROVISIONER_DATABASE_URL`; archive `render.yaml` | production deploy approval | 0.5 + ops |
| B9 | Security docs reconciliation | PARTIAL (stale) | — | See §3.5 | — | One docs PR. CLAUDE.md edits only with the owner's explicit approval. | CLAUDE.md edit | 0.5 |

**B10: further controls.** Each is verified in code.

| Control | Status | Evidence |
|---|---|---|
| Login and logout server revoke | PRESENT | `auth.service.ts:638-656`; cookies cleared at `auth.controller.ts:294-299` |
| Account switching | DIFFERENT BY DESIGN | No switcher. An ambiguous multi-org email is refused (`auth.service.ts:219-229`). Single workspace per manager. |
| Session fixation | PRESENT | New `sid` on every login; web re-login revokes the presented session. Mobile does not supersede. |
| Device and session list | PRESENT | `profile.controller.ts:76-95`. `user_session` is never purged (CF-46). |
| Idle and absolute expiry | PRESENT | `session-policy.ts`, checked against DB time |
| CORS | PARTIAL | Wildcard workspace labels (C9) |
| OAuth PKCE, state, nonce | PRESENT | B7 plus `oidc-login.service.ts` |
| Own JWKS | n/a | HS256, no external verifiers (Twenty has none either) |
| API keys | MISSING | Not needed yet (defer) |
| Inbound webhooks | MISSING | No surface (defer until C12) |
| CAPTCHA | MISSING | Twenty guards every public auth mutation |
| SSRF | PARTIAL | Admin SMTP test `assertPublicHost` has a DNS-rebinding window (`admin-panel.service.ts:214`) |
| Step-up auth | PARTIAL | Password-only. OAuth-only users can never pass it. No throttle (CF-25). |

### 3.3 Workstream C: workspace subdomain system

**The prior claim is confirmed.** `S/engine/core-modules/environment/environment.service.ts:61-90` `isTrustedOrigin` trusts any origin that is either an exact `CORS_ORIGINS` entry or `scheme://<label>.<WORKSPACE_BASE_DOMAIN>`.
- `<label>` only has to pass `isValidSubdomainShape`.
- There is no registry lookup, no READY check and no reserved-label exclusion.
- That one predicate feeds CORS (`main.ts:91-96`), cookie CSRF (`jwt-auth.guard.ts:248`), login/refresh provenance (`credential-request-provenance.guard.ts:17`), `auth.controller.ts:227` and `oauth-handoff.controller.ts:50`.
- `environment.service.spec.ts:44` locks the behaviour in.
- Twenty, by contrast, trusts exact credentialed origins only (`user-session/utils/resolve-allowed-credentialed-origins.util.ts`).

| # | Item | Status | Twenty | Crewflow (verified) | Smallest implementation | Gate | Days |
|---|---|---|---|---|---|---|---|
| C1 | One namespace | PARTIAL | One `workspace.subdomain` | `manager_workspace.subdomain` (`M/1786667100000:58`) and `organisation.slug` (`M/1786665800000:51`) are separately UNIQUE. `workspace_subdomain_taken` and `organisation_slug_taken` each check one table. The UI renders **both** as `https://<x>.<base>`. Org slugs skip the reserved list (`update-subdomain.dto.ts:5`, `resolveUniqueSlug`). | If org slugs are not routable: stop rendering `<slug>.<base>`. If they are: both `*_taken` functions check both tables plus the reserved list (one migration). | is org slug routable? | 0.5–1 |
| C2 | Reserved names | PARTIAL | `twenty-shared/src/constants/ReservedSubdomains.ts` (≈120) + `SubdomainPattern.ts` (`^(?!api-)…{1,30}`) | 23 names (`rab-shared/src/constants/reserved-subdomains.ts:12-36`), used only in `checkAvailability`; shape 3–63 characters | Merge Twenty's operational entries plus Crewflow-specific ones (accounts, crewflow, rab, venue, staff, payroll, portal, console, webhooks, ns1, ns2, mx); block the `xn--`, `api-` and `www-` prefixes | final list | 0.5 |
| C3 | Suggestions | PARTIAL | `subdomain-manager.service.ts` `generateSubdomain`, `findAvailableSubdomains` | Authenticated check endpoint, throttled, CSPRNG suggestions, boolean only. Doesn't pass `excludeWorkspaceId`, so the manager's own label shows as taken. | Pass the caller's own workspace; optional suggestion from the name | — | 0.5 |
| C4 | Rename / reclaim quarantine | MISSING | none (soft-deleted workspaces keep their label) | `updateSubdomain` frees the old label immediately; only an audit row records it | `core.released_subdomain` (FORCE RLS, DEFINER-only); `*_taken` treats quarantined labels as taken except by the prior owner; optional 301 during the window | quarantine length | 1–1.5 |
| C5 | Host→workspace routing | MISSING | `domain-server-config/utils/get-subdomain-and-custom-domain-from-hostname.util.ts`; `getPublicWorkspaceDataByDomain`; front `domain-manager` hooks | No code reads Host or XFH. `trust proxy` is a CIDR predicate. Workspace identity is session-derived. | Public `GET /rest/v1/public/workspace-by-host` keyed on browser `Origin` (never Host/XFH); DEFINER `core.resolve_routable_workspace(label)` (READY, active, org not suspended; reuse `workspace_schema_routable()`); frontend bootstrap in a new `features/workspace-host/`. **The host never grants authority.** | yes | 3–4 |
| C6 | Unknown / non-READY host | MISSING | `WorkspaceNotFoundDefaultError`, `useRedirectToDefaultDomain` | — | Identical 404 for unknown, CREATING, suspended and foreign hosts; link to an apex built from `APP_URL`, never from the request | UX copy | 1 |
| C7 | Redirects without open redirect | PRESENT (relative only) | `oauth-propagator.controller.ts` `isValidDomain` | `sanitiseReturnToPath` + DB CHECK; front `safePath`; server redirects only to `APP_URL` | Cross-host targets built only from the DB label + env | — | 0.5 |
| C8 | Workspace-aware login handoff | DIFFERENT BY DESIGN | `login-token.service.ts` (jti single-use), origin↔workspace check | Fixed API host; host-only cookies on it; single-use browser-bound OAuth handoff | None while the API host is fixed. Revisit if workspace hosts get their own cookies. | if topology changes | 0 |
| C9 | CORS / CSRF trust | PARTIAL (**finding D-C1**) | exact origins only | shape-only wildcard, above | **Step 0:** gate case 2 behind `WORKSPACE_HOST_ROUTING_ENABLED=false` (nothing legitimate uses it today), exclude reserved labels, fix the "never auth-relevant" doc (`environment-variables.ts:436`, `.env.example:79`). **Step 1:** registry-backed `core.workspace_host_routable(label)`, cached (C13). Keep the no-Origin mobile path. | enable flag | 0.25 + 1.5–2 |
| C10 | Domain attribute on cookies | PRESENT | non-credential `lastAuthenticatedWorkspaceDomain` on `.domain` | No `Domain=` on any auth cookie | Regression test only | — | 0.25 |
| C11 | HTTPS / DNS / Cloudflare | **BLOCKED** | infrastructure | No wildcard DNS, certificate or proxy configuration in the repo. HSTS covers the API host only. The production value of `WORKSPACE_BASE_DOMAIN` cannot be verified. | Runbook: dedicated sub-zone (`*.workspaces.<domain>`, never the apex), wildcard certificate, HSTS | owner infrastructure | 1 + ops |
| C12 | Custom domains (Cloudflare for SaaS) | MISSING (design) | `custom-domain-manager`, `dns-manager` (`registerHostname`, `isHostnameWorking`), `cloudflare/…` webhook with a timing-safe secret guard | — | `core.workspace_custom_domain` (FORCE RLS), `engine/core-modules/dns-manager`, secret-guarded webhook; resolver and trust read ACTIVE rows. **Defer.** | plan and cost | 5–8 |
| C13 | Hostname cache invalidation | MISSING (no cache yet) | cache storage | `CoreEntityCacheService` epoch invalidation already called by the workspace mutators (`workspace-provisioning.service.ts:112-114`) | New kind `workspace_by_subdomain`; invalidate on rename, READY/FAILED and org suspension; TTL ≤60 s (negative ≤10 s) | — | 0.5 |
| C14 | Email links / Host injection | PRESENT | `buildWorkspaceURL` from the DB | Links built only from `ACCOUNTS_URL`/`APP_URL` (https and non-localhost enforced in production); no Host-header use | Later: `buildWorkspaceUrl(label)` from DB + env | — | 0 |
| C15 | Mobile compatibility | PRESENT | n/a | Flutter `API_URL` and iOS `API_BASE_URL` are fixed; bearer tokens; the no-Origin path passes CSRF | Keep the no-Origin path in C9 and test it | — | 0.25 |

### 3.4 Workstream D: findings register (all open; none fixed in Phase 0)

| ID | Severity | Summary | Location | Fix (wave) |
|---|---|---|---|---|
| **N1 (new)** | **Medium** | Dev-only / staged migrations sit in the production migration glob. The next authorised production `rab-migrate` would apply 1786719500000 (G1-prod **not** approved; adds the `crewflow_app` EXECUTE grant) and 1786719520000 (one-off privileged copy; requires SUPERUSER/BYPASSRLS, so it may abort the chain partway — unverified on Neon). | `M/1786719500000:10-13`, `M/1786719520000:15-18` ("keep in proposed-migrations/"), `core.datasource.ts:97`; `THREAT-MODEL.md:1350-1352` is stale | Per-environment allowlist in the guarded runner (`migration-identity.ts`/`prestart-migrate.ts`) refusing named migrations unless `DB_TARGET` is approved. Test: a static spec plus a runner refusal. (W1) |
| **D-C1** | **Medium** | Credentialed CORS and CSRF trust any shape-valid label under `WORKSPACE_BASE_DOMAIN`, including `api`, `admin`, `mail`. JS on any sibling host (takeover, XSS, third-party sibling) can drive a victim's session (`SameSite=None` in production). | `environment.service.ts:78-89` + the 5 call sites | C9 step 0 (W1), step 1 (W3). Tests: unregistered label false, `api.<base>` false, untrusted preflight gets no ACAO header, credentialed POST 403. |
| **F1** | **Medium** | Password reset, activation/invite, admin reset, email change and member invite bodies (raw token URLs) are retained in `email_outbox.rendered_html` and never purged. **Live on dev** (S4). | `auth.service.ts:830`, `account-lifecycle.service.ts:129,185`, `email-change.service.ts:91`, `member-invitation.service.ts:260`; `W/queues/rab-email/email-send.processor.ts:202` | Null `rendered_html`/`rendered_text` at terminal SENT/FAILED/CANCELLED for token-bearing job types (W1); retention purge (W5, G6) |
| **F3** | **Medium** | `payroll_record` (organisation, attendance, shift, staff_profile) is `ON DELETE CASCADE`. The full chain is `core.user` → staff_profile → attendance → payroll_record. Also cascades: attendance_correction, shift_report, shift_staff_review, payroll_* by organisation. **Now frozen into `provision_workspace`** (`server-path-template.ts:49`). | `WS/payroll-record.ts:91-95`, `workspace-schema-v1.template.ts:358,424-441`, core migrations | RESTRICT in core + every workspace + a template v2 + re-created `provision_workspace` (W1, G5) |
| **D-A1** | **Medium** | Targeted login lockout. Anyone can lock any known email out indefinitely (keyed on email, checked before the password). | `auth.service.ts:161-173`, `auth_count_recent_login_failures` | Key on (email, IP), check after a failed verify, global ceiling (W1) |
| **F4** | Medium (latent; dev already HWS-on) | RLS coverage and posture golden ignore `workspace_*` | `tools/check-rls-coverage.ts:133`, `security-posture.ts:16-52` | W1 |
| **F2** | Low–Medium | Flutter secure storage defaults; no reinstall wipe | `api_client.dart:136` and 3 stores | W1 |
| D-A2 | Low | Disabling password sign-in leaves password sessions alive (≤180 d) | `auth.service.ts:551-626`, `organisation-auth-providers.service.ts:119-140` | W1 (owner gate) |
| D-A3 | Low (latent) | The MFA policy gate is not called on password or mobile login; its doc comment is false | `login-second-factor-policy.service.ts`, `auth.service.ts` `completeLogin` | W1 (wire the gate); MFA itself in W4 |
| D-A4 | Low | Forgot-password timing tail; reset email bombing | `auth.service.ts:771-846` | W1/W4 |
| D-C2 | Low → High once routing ships | Org slug / workspace subdomain collision; org slugs skip the reserved list | C1 locations | W3 (after the owner's C1 decision) |
| F5 | decision | Deleted user's email kept in immutable audit metadata | `user-deletion.service.ts:177` | owner |
| F6 | Low | GCM without AAD | `secret-encryption.service.ts` | W5 (deferred) |
| D-O1 | Low (ops) | The HWS-on dev configuration lives only in a temporary scratchpad file (S1); HANDOFF is stale (S2) | — | W0 |
| D-O2 | Info | QA compose and `render.yaml` describe identities the boot guards refuse | `docker-compose.qa.yml:85,123`, `render.yaml` | W1 (B8) |

**Cross-organisation sweep of the new uncommitted code: found clean.** Checked:
- `provision_workspace` and `verify_workspace_schema_v1` (`search_path`, organisation and owner checks, PUBLIC revoked);
- the definers in 1786719610000 and 1786719620000;
- check-in and on-behalf punches (permission re-check, 404 scope, `assertTransition`);
- confirm/reopen no-show (row lock);
- replacement/standby offers (server-decided kind, recipient workspace check);
- the shift-monitor compare-and-set;
- DTOs (no `organisationId` or `status` accepted).

No new tables, so no RLS gaps. **Owner question:** the system `venue_manager` role has no `payroll.view` but receives `earnedPence`/`payRatePence` (`shift-report.service.ts:245,262`; consumed by `rab-mobile/.../shift_report.dart:28`).

### 3.5 Stale documentation (to fix in the B9 docs PR)

1. **CLAUDE.md**
   - It says "Ten tables" are NOT FORCED and names `staff_profile`/`manager_profile`, `rab_app` and `rab_owner`.
   - Actual: 11 allowlisted + `organisation` + `platform_admin` = 13. Both profile tables are FORCEd. The runtime role is `crewflow_app`.
   - `oauth_transaction_state` and `permission` have RLS disabled; document why.
   - **Owner approval is required to edit CLAUDE.md.**
2. **SECURITY.md:** "auth not built yet"; Render; `rab_*` roles.
3. **SECURITY_AUDIT.md**
   - Bearer-only and "no CSRF surface" (:130); `localStorage` tokens (:364,386); runtime as `rab_owner` (:16); "5 not FORCEd"; unpinned JWT algorithms.
   - The lockout is presented as purely positive (:12), with no mention of D-A1.
4. **master-auth-audit SECURITY_FINDINGS / EXECUTIVE_SUMMARY (2026-10-15)**
   - Lists as open CF-05/06/07/08/09/13/17/20/21/36/37/41/42/43, which THREAT-MODEL.md:955-972 records as fixed. CF-06 is only partly fixed (D-A2).
   - Still open: CF-03, 14, 25, 26, 33, 44, 46, 50, 51.
5. **TWENTY_GOOGLE_AUTH_PARITY_REPORT.md:95,338** and the policy-service doc comment claim that the MFA gate covers all sign-in (D-A3).
6. **TWENTY_GOOGLE_AUTH_GAP_ANALYSIS.md:66:** the "previous session not revoked" claim is outdated for web.
7. **THREAT-MODEL.md**
   - :1350-1352 says the staged migrations are outside the glob (N1).
   - :953 notes the CI workflow roles `rab_app`/`rab_owner` are stale, and that is still unfixed.
8. **Code comments:**
   - `environment-variables.ts:436` and `.env.example:79` call `WORKSPACE_BASE_DOMAIN` presentation-only.
   - The stale comments listed in the 18-area report §9 are still present.
9. **docs/HANDOFF.md:** the dev DB state (S2).

## 4. Wave plan

### 4.1 Principles

**Reuse, don't duplicate.** Each item reuses an existing service or table:
- `SecretEncryptionService`/`SecretRotationService` for TOTP;
- `RefreshTokenService` revoke paths for B6;
- `token-bucket.ts` for OTP and per-email limits;
- `CoreEntityCacheService` for the host cache;
- `verify_workspace_schema_v1` for drift;
- `workspace_schema_routable()` for the host resolver;
- `AuditService` for everything.

**Never weaken any of these:**
- FORCE RLS;
- `crewflow_app` no-DDL / NOSUPERUSER / NOBYPASSRLS;
- the NOLOGIN owner;
- server-derived workspace identity;
- one workspace per manager, no picker;
- insert-only audit;
- immutable payroll snapshots;
- transactional outboxes.

### 4.2 File-ownership lanes

These lanes let several subagents run in parallel without touching the same file.

| Lane | Exclusive files | Notes |
|---|---|---|
| **SCHEMA** (one agent, serialised) | `S/database/typeorm/**` (all migrations, `workspace-schema/**`, `provision-workspace-schema.ts`, `server-path-template*.ts`, `security-posture*`, golden), `tools/check-rls-coverage.ts`, `S/database/typeorm/scripts/*`, `migration-identity.ts` | Other lanes **request** migrations from SCHEMA, or get a reserved timestamp block: AUTH `17867200xxxxx`, HOST `17867210xxxxx`, OPS `17867220xxxxx`. The golden file is regenerated only by SCHEMA at wave end. |
| **AUTH** | `S/engine/core-modules/auth/**` (incl. `auth.service.ts`: single owner), `token/**`, `rate-limit/**`, `organisation-auth-providers.service.ts`, `step-up-reauth.service.ts`, `rab-front/src/features/auth/**` | B1/B4/B5/B6 all edit `auth.service.ts`, so they stay serialised inside this lane |
| **HOST** | `S/engine/core-modules/environment/**`, `env.validation.ts`, `.env.example`, `S/main.ts`, `S/modules/manager-workspace/**` (except `workspace-provisioning.service.ts`, which is SCHEMA's), `S/modules/identity/{dto/update-subdomain.dto.ts,services/workspace.service.ts}`, `organisation-onboarding.service.ts`, `rab-shared/src/{constants/reserved-subdomains.ts,utils/subdomain.ts}`, `rab-front/src/features/settings/domains/**`, new `rab-front/src/features/workspace-host/**` | AUTH env additions (B2 flag) go through HOST or are sequenced after it |
| **OPS / WORKER** | `packages/rab-worker/**`, `S/engine/core-modules/email/**`, `S/modules/audit/**`, `secret-encryption/**`, `push-device.service.ts`, `S/modules/search/**` | |
| **DOMAIN** | `S/modules/{attendance,offer,payroll,scheduling,venue,staff}/**`, `member-object-registry.ts`, `user-deletion.service.ts` | |
| **MOBILE** | `packages/rab-mobile/**`, `packages/rab-iphone/**` | |
| **DEPLOY** | `packages/rab-docker/**`, `render.yaml`, `.github/workflows/**`, `docs/DEPLOYMENT.md`, runbooks | These files carry foreign uncommitted diffs, so commit them first (W0) |
| **DOCS** (lead only) | `THREAT-MODEL.md`, `docs/HANDOFF.md`, `SECURITY*.md`, `docs/security/**` | Append-only. Lanes hand their entries to the lead, who merges once per wave. |

### 4.3 Waves

**W0: hygiene and decisions (lead, 1 day; no product code)**
- The owner commits, or branch-partitions, the 158 uncommitted changes, so lanes don't edit files carrying foreign hunks.
- Record the actual dev state in HANDOFF.
- Move the HWS-on override into a repo-tracked, dev-only override, or document it.
- Test infrastructure: per-lane disposable compose (`-p crewflow-<lane>-<run>`, `postgres:16-alpine -c max_locks_per_transaction=256`, tmpfs, random ports, `down -v`). The shared `crewflow-test-db` was just recreated (0 schemas) but keeps `max_locks=64`. **Owner:** approve raising it to 256 in its compose definition, or mandate per-run disposable DBs for suites over 50 provisioning tests.
- **Gate G-W0:** owner decisions 1–4 in §6.

**W1: critical security fixes (parallel by lane; ≈ 11–14 dev-days; 3–4 calendar days with 5 lanes)**

| Lane | Work | Gate |
|---|---|---|
| SCHEMA | **N1**: migration environment allowlist (0.5–1 d) | must land **before any production migrate** |
| SCHEMA | **F4**: workspace_* RLS coverage and golden (1–1.5 d) | — |
| SCHEMA | **F3**: RESTRICT for payroll/attendance/report FKs (core + workspaces + template v2 + `provision_workspace` re-create), with a violating-row pre-check (2–3 d) | **G5** (devdb apply) |
| HOST | **C9 step 0**: flag the wildcard off, exclude reserved labels, fix docs, add the spec (0.5 d) | — |
| OPS | **F1**: null token-bearing bodies at terminal state; no purge yet (1 d) | owner OK on nulling (no retention period needed) |
| AUTH | **D-A1** lockout keyed on (email, IP) (1 d); **D-A3** MFA gate into `completeLogin` (0.5 d); **D-A2** revoke password sessions on toggle (0.5–1 d); **B4** detached forgot-password + per-email bucket + measured timing test (1 d). All tests run with `RAB_DISABLE_RATE_LIMIT=false`. | lockout policy; D-A2 re-login |
| MOBILE | **F2**: secure-storage options + reinstall wipe (1 d) | — |
| DEPLOY | **B8**: commit production compose; fix QA compose; archive `render.yaml` (0.5 d) | production deploy approval (separate) |

- **Gate G-W1:** owner review of the findings closure, the THREAT-MODEL entries, the posture diff and the devdb apply of F3.

**W2: schema and auth foundations (≈ 19–27 dev-days)**
- SCHEMA: `WorkspaceSchemaMigrator` + ledger (8–10 d, **G2**); drift alert-only (4–6 d, **G3** before fail-closed); constraint and enum parity suites (3–4 d); money CHECKs (1–2 d, G5).
- Lead/DOMAIN: ORM binding consolidation, GUC lint, pool guard (1–2 d).
- AUTH: B2 legacy-JWT flag (0.5–1 d, production keys); B3 `__Host-` cookies (1–1.5 d, re-login and topology gate).

**W3: workspace host system (≈ 10–13 dev-days; HOST lane, with SCHEMA for 3 migrations)**
- Prerequisites: C1 and C2 decisions; C11 infrastructure runbook.
- Order: C5 resolver + C6 → C13 cache → C9 step 1 (registry-backed trust) → C4 quarantine → C3/C7 → C10/C15 tests.
- **Gates:** org-slug routability, reserved list, quarantine length, wildcard sub-zone and certificate, enabling `WORKSPACE_HOST_ROUTING_ENABLED`.

**W4: MFA and auth completeness (≈ 8–11 dev-days)**
- B1 TOTP + recovery + replay (5–8 d; web + Flutter + iOS screens);
- TOTP step-up (1 d);
- `user_session` purge (CF-46, 0.5 d);
- SSRF rebinding fix (0.5 d);
- B9 docs PR (0.5 d).
- **Gates:** MFA scope, recovery policy, CLAUDE.md edit.

**W5: data engine and operations (≈ 24–33 dev-days, +5 optional)**
- Archive/restore (G5 + retention);
- search (G5);
- field permissions for attendance, offer and report (venue_manager decision);
- outbox retention purge + replay (**G6**);
- timeline read model;
- L1 non-auth cache (per-environment enablement);
- rotation coverage + envelope CHECK (**G7**);
- RAB3/AAD (optional, deferred).

**W6: validation and HWS production cutover rehearsal (≈ 10–15 dev-days)**
- Full suite with HWS on, using disposable DBs only, with two tenants over HTTP;
- the §1.2 abuse cases;
- k6 load test;
- restored-copy rehearsal;
- reverse-copy script.
- **G4** per sub-step (18-area report §5).
- C12 custom domains only after W3 is proven and the owner approves Cloudflare for SaaS (5–8 d).

### 4.4 Effort (honest)

| Wave | Dev-days |
|---|---|
| W0 | 1 |
| W1 | 11–14 |
| W2 | 19–27 |
| W3 | 10–13 (+ ops) |
| W4 | 8–11 |
| W5 | 24–33 (+5) |
| W6 | 10–15 |
| **Total** | **≈ 83–114 dev-days (17–23 developer-weeks)**, plus about 10–13 for deferred items (C12, RAB3) |

- With 4–5 parallel lanes, the **calendar time is about 8–12 weeks**.
- The binding constraint is **owner gate latency and review bandwidth**, not agent throughput: about 14 gates are listed.
- Estimates assume disposable-DB test runs. They exclude production deployment work, which is gated and depends on the OpenShip/Oracle topology (BLOCKED in the repo).

## 5. Items to drop or defer

| Item | Recommendation | Reason |
|---|---|---|
| ClickHouse / analytics store | Drop | Optional even in Twenty. Adds 2–4 GB RAM. Its TTL-deletable audit is weaker than the PG insert-only `audit_log`. |
| Generic custom objects / metadata-driven DDL | Drop | Needs runtime DDL, which conflicts with `crewflow_app`. Multiplies drift. If fields are ever needed, use a FORCE-RLS `custom_field_definition` + a validated `custom_fields jsonb` on staff, venue and shift + `role_field_permission` keys, and never read it in payroll or attendance. |
| Pence → `amountMicros` + currency | Drop | Twenty's float transform is weaker; high-risk money migration with no benefit |
| Native PG enums | Drop | Twenty's rebuild nulls unmapped values |
| Twenty trash auto-purge | Drop for financial, attendance and audit | Record-retention obligations |
| Merged / mutable timeline | Drop | Use a read model over insert-only audit |
| L1 cache for authorisation data | Drop | Adds a revocation window Crewflow doesn't have |
| ES256 + DB signing keys + rotation cron + JWKS | Defer | No external verifiers. The legacy-key flag plus a production keyring removes `APP_SECRET` exposure for 0.5–1 d. |
| Apex→workspace login handoff token (C8) | Defer | Not needed while the API host is fixed and cookies are host-only |
| Custom domains (C12) | Defer to after W3/W6 | Takeover and TLS risk, Cloudflare for SaaS cost, webhook surface |
| API keys, inbound webhooks, CAPTCHA | Defer | No surface today. Revisit CAPTCHA if D-A1/B4 abuse appears. |
| RAB3 / AAD envelope | Defer | Do rotation coverage first. Critical key-loss risk. |
| Offline attendance | Defer | Conflicts with server-time-authoritative attendance |
| Cross-workspace double-booking | Owner decision | Would need a core reservation table spanning tenants |

## 6. Decisions needed from the owner

1. **N1:** approve the environment-allowlist fix, and **do not run any production `rab-migrate`** until it lands, unless G1-prod is explicitly approved.
2. Commit or partition the 158 uncommitted changes before parallel lanes start.
3. Test DB: raise `max_locks_per_transaction` to 256 on `crewflow-test-db`, or mandate per-run disposable DBs.
4. Keep dev HWS-on? If so, move the override into the repo.
5. F3: approve RESTRICT (G5) on rab-devdb.
6. F1: approve nulling token bodies now; retention periods (G6) later.
7. Lockout policy: keying, threshold, global ceiling.
8. D-A2: revoke password sessions when password sign-in is disabled (forces re-login).
9. MFA: scope (platform admin, CEO, Initial Manager); recovery codes (self-generated vs admin-issued); who may reset another user's 2FA.
10. Cookie `__Host-` rename (re-login), and the production web/API topology (same-site or cross-site).
11. Subdomains:
    - Is the org slug routable?
    - Final reserved list.
    - Quarantine length.
    - The production `WORKSPACE_BASE_DOMAIN` value, and a dedicated wildcard sub-zone.
    - Cloudflare for SaaS: yes or no.
12. Should `venue_manager` see `earnedPence`/`payRatePence` without `payroll.view`?
13. Carried over: F5 (deleted-user email in audit), one-time bootstrap closure, and approval to edit CLAUDE.md (stale NOT_FORCED list).
