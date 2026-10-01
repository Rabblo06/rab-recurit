# RAB Full Security Audit

**Engagement type:** Authorized, owner-requested defensive security audit (active testing against the owner's own local dev stack — real Postgres/RLS, real Redis-backed rate limiter — plus source review). No production system was targeted; no destructive action was taken; no real email was sent (`EMAIL_DRIVER=LOGGER` in this environment).
**Target:** `C:\Rab-recruit` — NestJS 11 REST API (`rab-server`), PostgreSQL 16 with Row-Level Security, Redis 7, React/Vite web console (`rab-front`), Flutter mobile app (`rab-mobile`).
**Date:** 2026-09-19
**Builds on:** `SECURITY_AUDIT.md` (2026-08-20, this repo's own prior engagement) — this pass independently re-verified all four of that engagement's findings rather than assuming their status, and found three already fixed and fixed the fourth itself (see RAB-SECURITY-FINDINGS.md for the reconciliation).

---

## RAB SECURITY STATUS

```
CRITICAL:                    0
HIGH:                        2   (both: outdated dependency, production-reachable)
MEDIUM:                      0 open   (1 found and fixed in this pass — see SEC-001)
LOW:                         3 open   (1 found and fixed in this pass — see SEC-002)
INFORMATIONAL:               5   (includes SEC-010: 5 integration test files cannot
                                   currently exercise their Staff/Venue-Manager test
                                   paths — see Findings)

VERIFIED SECURITY CONTROLS:  27   (see RAB-SECURITY-CONTROLS.md)
MISSING CONTROLS:            2    (Permissions-Policy header; npm/pub Dependabot coverage)
P0 PRODUCTION BLOCKERS:      0
```

No security score/percentage is given — see "Coverage, not a score" below.

---

## Security Skills Used

Per the request's instruction to inspect and use installed security skills before auditing. The repo's `.claude/skills/` (symlinked from a large security-skill library) was enumerated and filtered for relevance; two were already loaded from earlier in this session and six more were loaded specifically for this audit.

| Skill | What it contributed |
|---|---|
| `testing-api-for-broken-object-level-authorization` | BOLA/IDOR test methodology (object-ID substitution across owners/tenants) — applied to the Venue Offers, file-retrieval, and attendance cross-account tests in this pass |
| `testing-api-for-mass-assignment-vulnerability` | Framework for the mass-assignment injection tests against `POST /staff` and `POST /shifts` (organisationId/role/status/isAdmin/createdBy) |
| `testing-jwt-token-security` | Checklist used to reason through this codebase's JWT design (none-alg attack, algorithm confusion, HMAC secret strength, revocation window) — see Authentication Findings for the applicability conclusion (this system is HS256-symmetric-only, so RS256↔HS256 confusion doesn't apply; `jsonwebtoken`'s default behavior already rejects `alg:none` without explicit opt-in, and none was found) |
| `testing-cors-misconfiguration` | Origin-reflection test technique — applied live against `main.ts`'s CORS config |
| `implementing-api-rate-limiting-and-throttling` | Reference architecture used to evaluate `RabThrottlerModule` against (sliding-window vs. fixed, distributed-safety, per-route overrides) — confirmed this codebase already matches the reference design (Redis-backed, not in-memory) |
| `testing-for-business-logic-vulnerabilities` | Prompted the attendance time-window check (SEC-006) and the race-condition tests (concurrent clock-in/out) |
| `exploiting-sql-injection-vulnerabilities` | Methodology used while auditing the hand-built SQL in `attendance.service.ts`/`scheduling.service.ts` (parameterization + column-name allowlisting review) |
| `implementing-secret-scanning-with-gitleaks` | Pattern list used to drive the manual `git grep` secrets sweep (a live `gitleaks` binary was not available in this environment, so its documented regex patterns were applied manually instead) |
| `testing-mobile-api-authentication` | Checklist applied to the mobile token-storage/logout/biometric audit |
| `exploiting-broken-function-level-authorization` | Vertical-escalation test technique — applied to the role-login-isolation checks (Phase 4) |

No skill in the library directly covers PostgreSQL RLS testing, NestJS-specific guard architecture, or BullMQ/worker-payload trust as its own topic — those sections were audited from first principles (source read + live query testing) rather than a packaged skill.

---

## Architecture Inspected

- **Web:** React/Vite (`rab-front`), Bearer-token-in-header auth (no ambient cookie for API calls except the one narrowly-scoped refresh cookie).
- **Mobile:** Flutter (`rab-mobile`), Android checked in depth; no iOS project exists yet in this checkout.
- **API:** NestJS 11, pure REST, TypeORM 0.3, modules: `identity` (auth/profile/roles/workspace), `staff`, `manager`, `manager-workspace`, `venue`, `scheduling` (shifts/job-roles/venue-offers), `offer`, `attendance` (new since the prior audit), `notification`, `dashboard`, `search`, plus `engine/` platform machinery (auth, audit, permissions, tenant-context, storage, throttler, platform-admin, email).
- **Database:** PostgreSQL 16, RLS on 35 core tables (25 FORCE'd, 10 deliberately-exempted pre-auth tables matching CLAUDE.md's own documented allowlist exactly), two roles (`rab_owner` migration-only, `rab_app` runtime/`NOBYPASSRLS`), a boot-time assertion that refuses to start if connected as anything but `rab_app`.
- **Queue/cache:** Redis 7 — BullMQ for email delivery, and the Redis-backed distributed rate limiter (`@nest-lab/throttler-storage-redis`). Production Redis is managed Upstash (TLS, provider-authenticated) per `render.yaml`; the local dev Redis (docker-compose) has no auth, which is fine for a loopback-only dev box.
- **Object storage:** avatar/logo uploads only (no other file-upload surface found); magic-byte-sniffed, server-generated keys, org-prefixed retrieval authorization.
- **Not yet implemented:** payroll as its own module (still forward-looking permission flags only, matching the prior audit); no GraphQL; no Swagger/OpenAPI endpoint exists at all (nothing to gate).
- **Deployment:** Render (`render.yaml`) for the API/worker, Vercel implied for the front end (not present in this repo to audit directly), Neon for a cloud Postgres instance (found configured in `.env` but not the database actually backing the live dev server or this audit's live tests — see the note in "Remaining unverified areas"). No Cloudflare, DigitalOcean, or Kubernetes configuration exists anywhere in this repo to audit — those phases of the original request are marked NOT APPLICABLE, not silently assumed secure.

### Trust boundary summary

```
Browser/Mobile device
   │  (Bearer JWT in Authorization header; one narrow HttpOnly
   │   refresh cookie scoped to /rest/v1/auth only)
   ▼
NestJS API (rab-server)
   │  JwtAuthGuard: verifies signature, re-resolves workspaceId
   │  and role fresh from DB every request (never trusted from
   │  the token itself beyond userId/organisationId)
   │  PermissionGuard: re-resolves permission grants fresh, per request
   ▼
TenantContextService (SET LOCAL rab.organisation_id/workspace_id/user_id,
   inside a transaction, per request)
   │
   ├─► PostgreSQL (rab_app role, NOBYPASSRLS) — RLS policies read the
   │      above session variables; 25/35 tables FORCE-enforced even
   │      against the table owner; 10 documented pre-auth exceptions
   │
   └─► Redis (rate limiter state, BullMQ job queue — email delivery
          worker re-runs inside its own tenant-context-bound transaction,
          never trusting a queued organisationId/userId as authorization
          on its own — see Redis/BullMQ Findings)
```

---

## Threat Model

| Attacker | Primary entry points | Key controls observed |
|---|---|---|
| A. Unauthenticated | `/auth/*`, `/healthz` | Rate limiting (5/min on auth routes, verified live), timing-uniform login/forgot-password, no unauthenticated data endpoints found |
| B. Malicious Staff | Any `staff_app`-permitted endpoint | 404-not-403 BOLA blocking (offers, attendance — verified live this pass and prior pass); `staffProfileId` always server-derived from JWT `userId`, never client-supplied |
| C. Malicious Venue Manager | Venue-scoped endpoints, Venue Offers submission | `assertVenueTeamSelection`/`assertStaffSelectable` (from this session's earlier work); venue-membership-scoped RLS clause |
| D. Malicious Internal Manager | Org-wide manager endpoints, admin-inspect | Server-side re-derived role/permission per request; admin-inspect mechanism fails closed to the admin's real identity on any invalid/foreign session id |
| E. Compromised account (any role) | Whatever that account is genuinely permitted | Refresh-token rotation + reuse-family revocation limits blast radius of a stolen refresh token; 15-min access-token TTL bounds a stolen access token's window (see SEC-related note on stateless-JWT revocation in Controls doc) |
| F. Compromised mobile device | On-device token store | `flutter_secure_storage` (Keychain/Keystore-backed), verified — a device compromise sophisticated enough to defeat OS-level secure storage is outside this audit's scope |
| G. Leaked JWT (e.g., logged, shoulder-surfed) | Any endpoint the token's role permits | 15-min TTL bounds exposure; no permissions embedded in the token itself, so a permission revoked mid-session takes effect on the very next request even with a still-valid token |
| H. Compromised worker process | BullMQ job payloads | Worker re-runs inside `runInTenantContext` per job, not a raw trusted payload — see Redis/BullMQ Findings |
| I. Malicious uploaded file | Avatar/logo upload | Magic-byte sniffing, 10MB cap, server-generated key/extension — verified by source; `multer` version itself has open DoS advisories (SEC-003) |
| J. Automated bot / credential stuffing | `/auth/login` | Per-IP (5/min, Redis-backed, distributed-safe) + per-account (10/15min) lockout, both verified |
| K. Cross-organisation attacker | Any resource-by-id endpoint | RLS + service-layer checks, verified live this pass across Venue Offers, attendance, file retrieval; one gap found and fixed (SEC-001) |
| L. Cross-workspace attacker | Manager-scoped endpoints within one org | `createdBy`/venue-membership scoping, consistent with the prior audit's findings; not independently re-exercised at length in this pass beyond what the existing `venue-manager-scoping` test suite already covers (see Remaining unverified areas) |

---

## Coverage, not a score

Per the audit's own instruction, no invented percentage is given. Instead:

- **27 controls** were independently verified this pass (live test or direct source read) — listed with evidence in `RAB-SECURITY-CONTROLS.md`.
- **9 findings** were opened this pass (2 by fixing them immediately, 7 remaining — see `RAB-SECURITY-FINDINGS.md`), plus **4 findings from the prior audit reconciled** (3 already fixed independently of this pass, 1 fixed by this pass).
- **2 missing controls** identified (`Permissions-Policy` header; `npm`/`pub` Dependabot coverage).
- **0 P0 production blockers.**
- A substantial list of requested phases are marked **NOT APPLICABLE** (no Cloudflare/DigitalOcean/Kubernetes/CI-deploy-to-cloud config exists in this repo to audit) or **NOT VERIFIED** (exhaustive fuzzing/load-scale DoS testing was out of this pass's time and safety budget) — see the final report's own itemization. These are not claimed as secure; they are disclosed as unverified.

---

## Detailed findings

See `RAB-SECURITY-FINDINGS.md` for the full per-finding writeups (SEC-001 through SEC-009, plus the VULN-001–004 reconciliation) in the mandated format (ID/Title/Severity/Evidence/Attack prerequisite/Safe reproduction/Expected/Actual/Impact/Why it happens/Existing protection/Missing protection/Exact remediation/Regression test/Status).

## Fix plan

See `RAB-SECURITY-FIX-PLAN.md`.

## Verified controls

See `RAB-SECURITY-CONTROLS.md`.

---

## Final table

| Area | Existing Security | Missing | Risk | Fix | Priority | Verified |
|---|---|---|---|---|---|---|
| Authentication | argon2id, timing-uniform login/reset, dual-layer rate limiting (IP+account), refresh rotation+reuse-detection, single-use+set-invalidated reset tokens | Stateless-JWT revocation window (~15min after logout/reset) | Low (bounded window, industry-standard tradeoff) | Consider a short-lived access-token blocklist if the 15-min window is ever judged too long for this domain | P3 | Yes |
| Authorization | 404-not-403 BOLA blocking, server-re-derived role/permission every request, mass-assignment rejection | — | — | — | — | Yes |
| RLS | 25/35 tables FORCE'd, exactly the 10 documented pre-auth exceptions, fail-closed (no/wrong/null context → 0 rows), boot-time role assertion | — | — | — | — | Yes |
| Organisation isolation | Verified live (Venue Offers, files, attendance); one single-layer gap found and fixed (SEC-001) | — | — | — | Fixed | Yes |
| Workspace isolation | `createdBy`/venue-membership scoping, existing test suite | Not independently re-exercised at length beyond existing coverage this pass | Low | Extend the existing `venue-manager-scoping` suite with a same-org, two-internal-manager-workspace matrix | P2 | Partially |
| Venue isolation | `manager_venue`-scoped RLS + explicit service checks | — | — | — | — | Yes |
| Rate limiting | Redis-backed, distributed-safe, per-route overrides on all auth-sensitive endpoints | No explicit limit on non-auth "expensive" endpoints (search, exports, bulk offer actions) beyond the global 120/min | Low-Medium | Add `@Throttle` overrides on search/export/bulk-offer routes if usage patterns ever show abuse | P2 | Partially |
| Sessions | 15-min access JWT, 30-day rotating refresh token, family-revocation on reuse | — | — | — | — | Yes |
| Password reset | Single-use, set-invalidated on new issuance (VULN-003 fixed), 1h self-service / 48h admin TTL | — | — | — | — | Yes |
| API | `forbidNonWhitelisted` everywhere except the one now-fixed handler (SEC-002) | — | — | — | — | Yes |
| Web | No raw-HTML sink, Bearer-header auth (no ambient CSRF surface for the API itself), one narrowly-scoped refresh cookie with independent Origin check | — | — | — | — | Yes |
| Flutter | Secure OS-backed token storage, real logout, server-verified biometric gate, no WebView/TLS-bypass | Release build's `API_URL` enforcement lives outside this repo | Low | Confirm release CI always sets `API_URL` | P3 | Yes (code); process item open |
| Database | Parameterized SQL throughout (including hand-built attendance/scheduling queries, verified column-allowlist pattern for sort columns) | — | — | — | — | Yes |
| Redis | Production: managed, TLS, provider-authenticated. Dev: no auth, loopback-only | — | None (production is fine; dev is a non-issue) | — | — | Yes |
| BullMQ | Worker re-validates via `runInTenantContext` per job | — | — | — | — | Code-reviewed |
| Files | Magic-byte sniffing, server-generated keys, org-prefix-scoped retrieval, path-traversal-safe | — | — | — | — | Yes |
| Object storage | Same as Files (no separate S3/R2 integration exists yet to audit) | N/A — not yet built | — | — | — | N/A |
| Email | React-SSR-escaped templates (no HTML injection), single-use tokens, superseded-token outbox cancellation | `nodemailer` version (SEC-004) | High (dependency) | Version bump | P1 | Yes (logic); dependency open |
| Secrets | Zero committed secrets found (full history + tracked-tree scan) | — | — | — | — | Yes |
| Docker | Non-root, digest-pinned server image, `NOBYPASSRLS` DB role, no privileged/socket-mount/host-networking anywhere | `adminer:latest` unpinned (dev-only) | Informational | Pin version | P3 | Yes |
| Cloud | No Cloudflare/DigitalOcean config exists in this repo | N/A | — | — | — | N/A — not deployed there per this repo |
| Backups | No backup configuration exists in this repo to audit (managed-provider responsibility, e.g. Render/Neon/Upstash backups) | Not verifiable from this repo | Unknown | Confirm provider-side backup/PITR settings directly in each provider's dashboard | P2 | NOT VERIFIED |
| CI/CD | Every workflow SHA-pins third-party actions, explicit least-privilege `permissions:` blocks, no `pull_request_target`, no hardcoded deploy secrets | `npm`/`pub` Dependabot coverage (SEC-009) | Low | Add ecosystem entries | P2 | Yes |
| Logging | No password/JWT/refresh-token/reset-token logging found in the two `debugPrint` calls that exist in the mobile app; server-side logging not exhaustively grepped for every field in this pass | Not fully verified for `rab-server`'s own log statements | Unknown | A dedicated grep for `logger\.(log\|debug\|warn)\(.*\b(password\|token\|secret)\b` across `rab-server/src` | P2 | Partially |
| Audit | Login/logout, account activation, password change/reset, Venue Offers staff add/remove/approve/decline, clock-in/out all write real `audit_log` rows; table is insert-only at the DB grant level (documented, not re-verified live this pass) | — | — | — | — | Mostly (grant-level insert-only not re-queried live this pass) |
| Monitoring | Sentry DSN wired in `render.yaml` (`sync: false`, provider-managed) | Not exercised in this pass | Unknown | N/A — out of scope for a code audit | — | NOT VERIFIED |
