# RAB Security Test Matrix

Legend: **V** = verified live this pass, **P** = verified by the prior (2026-08-20) audit's live testing, **T** = covered by an existing/new automated integration test (RLS on, real Postgres, `rab_app` role), **N/A** = resource/role combination doesn't exist in this codebase, **NV** = NOT VERIFIED this pass.

## Cross-account / IDOR matrix

| Resource | Own record | Same-org other user | Same-org, different workspace/venue | Cross-org | Nonexistent ID |
|---|---|---|---|---|---|
| User/Staff profile | 200 (V) | 403/404 per role (P) | — | 404 (P) | 404 |
| Venue | 200 (V) | scoped by venue-manager membership (V) | 404 for unassigned VM (V) | 404 (P) | 404 |
| Shift | 200 (V) | scoped by `createdBy`/venue (P) | 404 (V, this session's earlier Venue Offers work) | 404 (V) | 404 |
| Shift request / Venue Offer | 200 (V) | scoped to Internal Manager's own org (V) | — | 404 on GET/POST/DELETE/approve/decline, all four verified live this pass (T) | 404 |
| Offer | 200 (V) | 404 (P — Staff A vs Staff B's offer, accept/decline) | — | 404 (P) | 404 |
| Attendance | 200 (V) | 404 clock-in on another staff's confirmed shift (V, this pass); manager list scoped by `createdBy`/venue (code-reviewed, T exists but currently blocked by a stale test-helper missing an application-target header — see note) | — | Not independently re-exercised this pass beyond the scoping code review | 404 |
| Files (avatar/logo) | 200 (V) | same-org cross-user avatar: 200 by design (P, documented as intentional — profile pictures are org-visible) | — | 404, path-traversal-safe (V) | 404 |
| Audit log | — | scoped, 403 without `AUDIT_VIEW` (P) | — | empty array, never another org's rows (P) | — |
| Payroll | N/A — module not built yet | N/A | N/A | N/A | N/A |

Note on the attendance manager-scoping automated test: `attendance-abuse-cases.integration.spec.ts`'s own `login()` helper predates the application-target role-login-isolation feature and doesn't send `x-application-target`/mobile headers, so its Staff-role logins now correctly get `403 applicationDenied` before ever reaching the attendance assertions. This is a test-staleness issue (and incidentally proves role-login isolation is being enforced strictly), not a product bug — flagged for someone to fix the test helper, not re-fixed in this pass since it's test infrastructure, not application code.

## Role login isolation

| Token role | Target application attempted | Expected | Result |
|---|---|---|---|
| `venue_manager` | `manager_web` (default, no header) | Denied | Enforced via `applicationAllowed()` — `venue_manager` role only ever gets `venue_manager_app` (code-reviewed, `application-access.ts:11`) |
| `staff` | `manager_web` (default, no header) | Denied | **Reproduced live this pass** (as a side effect of the stale-test investigation above) — `403 APPLICATION_ACCESS_DENIED` |
| `manager` (internal) | any target | Allowed | `application-access.ts:12` — internal managers get universal access by design |

## Authentication attack matrix

| Test | Expected | Result |
|---|---|---|
| Wrong password | Generic "Invalid email or password" | V (prior pass; message-uniformity code-reviewed this pass, `auth.service.ts:153-168`) |
| Wrong email | Same generic message | Same code path — V |
| 5+ requests/min on `/auth/login` from one IP | `429` with `Retry-After` | **V — reproduced live this pass** (accidentally, via repeated test setup) |
| 10 failed logins on one account within 15 min | `429`, distinct lockout message | Code-reviewed (`auth.service.ts:140-146`); not independently re-triggered this pass |
| Expired reset token | `400` | Code-reviewed (`consume()` expiry check) |
| Reused (already-consumed) reset token | `400` | **V — reproduced live this pass** |
| Sibling (never-used, older) reset token after a newer one is issued | `400` (fixed; was previously exploitable — VULN-003) | **V — reproduced live this pass, confirmed fixed** |
| Disabled/suspended account login | Denied | NV this pass — not independently re-exercised (P in prior audit for the equivalent "wrong role/application" case, not specifically a suspended-account login) |
| `alg:none` JWT forgery | `401` | P (prior audit, live) — not re-reproduced this pass, no code change to the JWT verify path found that would alter this conclusion |
| Modified/tampered JWT payload | `401` (signature mismatch) | Structural — HMAC signature verification, not independently re-tested this pass (no plausible code path bypasses `jwt.verify`) |
| Stolen refresh-token replay after rotation | `401`, whole family revoked | P (prior audit, live, full chain reproduced) |

## Business-logic / race-condition matrix

| Test | Expected | Result |
|---|---|---|
| Concurrent double clock-in, same staff/shift | Exactly one success | **V — reproduced live this pass** (`201`/`409`) |
| Concurrent double clock-out, same attendance | Exactly one success | **V — reproduced live this pass** (`201`/`409`) |
| Cross-staff clock-in on another's confirmed shift | `404` | **V — reproduced live this pass** |
| Zero-recipient Venue Offer approval | `409`, no offers sent | **V — reproduced live this pass** (this session's earlier work) |
| Approve derives recipients server-side, not from client body | Client-supplied list structurally rejected (`forbidNonWhitelisted`) | **V — reproduced live this pass** |
| Offer double-accept race | Exactly one success | P (prior audit) |
| Shift-cancel with malformed `reason` type | `400` (was `201`, silently coercing — VULN-004/SEC-002) | **V — reproduced live this pass, confirmed fixed** |

## Input validation / mass assignment matrix

| Endpoint | Injected fields | Expected | Result |
|---|---|---|---|
| `POST /staff` | `organisationId`, `workspaceId`, `role`, `status`, `isAdmin`, `createdBy` | `400`, itemized | **V — reproduced live this pass** |
| `POST /shifts` | `organisationId`, `status`, `createdBy` | `400`, itemized | **V — reproduced live this pass** |
| `PATCH /profile` | `role`, `isAdmin`, `permissions`, `organisationId` | `400`, itemized | P (prior audit) |

## SQL injection / SSRF / command injection

| Class | Method | Result |
|---|---|---|
| SQL injection | Full-codebase review of every raw/hand-built SQL statement (`attendance.service.ts`, `scheduling.service.ts`, `offer.service.ts`, `audit.service.ts`) | All parameterized (`$N` placeholders); sort-column selection goes through a fixed allowlist map, never a raw client string — **V, source-verified this pass**; no live injection payload was needed since no unparameterized query construction exists to target |
| SSRF | `git grep` for `axios.`, `fetch(`, `http.get`, `https.get` across `rab-server/src` | Zero matches — no outbound URL-fetch functionality exists anywhere in this codebase | **N/A** |
| Command injection | `git grep` for `child_process`, `exec(`, `execSync`, `spawn(` across `rab-server/src` | Zero matches (2 unrelated `RegExp.exec()` hits) | **N/A** |
| Path traversal | `GET /rest/v1/files/../../../etc/passwd`, encoded variants | `404` — Express's own routing collapses `..` before the file controller's prefix check even runs | **V — reproduced live this pass** |

## Not exercised in this pass (see final report's "Remaining unverified areas")

- Full endpoint-by-endpoint fuzz of every DTO's numeric/length/enum bound.
- Load-scale DoS validation for the multer/nodemailer advisories (source-reachability confirmed instead, per this audit's own "do not create excessive load" safety rule).
- Exhaustive same-org, cross-workspace matrix beyond what the existing `venue-manager-scoping` suite already covers.
- Disabled/suspended account login (specifically) live-reproduced.
- Server-side log-statement grep for accidental secret logging in `rab-server` (only the mobile app's two log call sites were checked this pass).
