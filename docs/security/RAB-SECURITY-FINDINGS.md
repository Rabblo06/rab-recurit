# RAB Security Findings

Severity counts (this pass, current state after in-pass fixes):

- CRITICAL: 0 open (1 found already fixed prior to this audit)
- HIGH: 2 open (dependency), 1 found already fixed prior to this audit
- MEDIUM: 1 found already fixed prior to this audit
- LOW: 3 open (1 fixed in this pass)
- INFORMATIONAL: 5 (including a real test-suite-integrity gap, SEC-010)

---

## SEC-001

**Title:** `assertShiftViewable`'s `PENDING_MANAGER_APPROVAL` shortcut had no explicit organisation check — single enforcement layer (RLS only)

**Severity:** MEDIUM (defense-in-depth gap; not independently exploitable under the correctly-configured runtime role — see below)

**Affected component:** `packages/rab-server/src/modules/scheduling/services/scheduling.service.ts` — `assertShiftViewable` (used by `get()` and `getRequestedStaff()`), plus the sibling methods `removeRequestedStaff`, `addRequestedStaff` (same file), and `OfferService.approveShiftRequest`/`SchedulingService.declineRequest`, all of which loaded a `Shift` by id and acted on it with no explicit `shift.organisationId === ctx.organisationId` check — relying entirely on RLS to have already scoped the `findOne`.

**Evidence:**
```
packages/rab-server/src/modules/scheduling/services/scheduling.service.ts:92-97 (before fix)
  private async assertShiftViewable(manager, ctx, shift): Promise<void> {
    if (shift.status === ShiftStatus.PENDING_MANAGER_APPROVAL) {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind === 'owner') return;   // <- no org check
    }
    await this.assertShiftOwned(manager, ctx, shift);
  }
```

**Attack prerequisite:** A connection to Postgres that does not correctly enforce RLS (i.e., not the real `rab_app` runtime role) — under the actual production/runtime role this path is not reachable, because `manager.findOne(Shift, {where:{id}})` already returns `null` for a cross-org id before this method is ever called.

**Safe reproduction:** Built a fresh integration test (`venue-manager-scoping.integration.spec.ts`, new "Venue Offers" describe block) creating two isolated organisations, granting Org B's Internal Manager the real `SCHEDULE_VIEW`/`STAFFING_REQUEST_APPROVE` permissions, and calling `GET /shifts/:id/requested-staff` for Org A's pending shift. Ran the test twice: once against the local Postgres connected as the Postgres bootstrap superuser (`rolbypassrls=true`, an environment mistake on my part, not a claim about production) to isolate the application layer from RLS, and once against the real, correctly-configured `rab_app` role (`rolbypassrls=false`, confirmed via `pg_roles`).

**Expected result:** `404` regardless of which role backs the connection — CLAUDE.md's own "five enforcement layers, not one" rule means the service layer should independently reject a cross-org shift even if RLS were somehow bypassed.

**Actual result (before fix):** Under the RLS-bypassing connection, `GET .../requested-staff` returned `200` with the other org's real staff-selection data — confirming the service layer had zero independent check for this specific path. Under the real `rab_app` role, RLS alone correctly blocked it (`404`) both before and after the fix, since RLS was never actually broken.

**Impact:** None under the current, verified production role configuration (`rab_app`, `NOBYPASSRLS`, boot-time-asserted — see SEC-001-related control in RAB-SECURITY-CONTROLS.md). The real risk this closes is architectural: a future misconfiguration, a migration/admin script accidentally running under the owner role, or a Postgres upgrade/config change that silently weakens RLS would previously have had zero backstop on this exact code path family, exactly the scenario CLAUDE.md's five-layer doctrine exists to prevent.

**Why it happens:** `assertShiftOwned` (the normal/strict path) is safe without an explicit org check because it also requires `shift.createdBy === ctx.userId`, and a user can't have created a shift outside their own org. The `PENDING_MANAGER_APPROVAL` shortcut exists specifically because a Venue-Manager-submitted request's `createdBy` is the Venue Manager, not the reviewing Internal Manager — so that same implicit safety net doesn't apply, and nothing was added to replace it.

**Existing protection:** RLS (`shift_tenant` policy, `organisation_id = core.current_org()`), correctly FORCE'd and correctly bound to the real `rab_app` role.

**Missing protection (now fixed):** An explicit, service-layer `shift.organisationId === ctx.organisationId` check, independent of RLS.

**Exact remediation (implemented):** Added `if (!shift || shift.organisationId !== ctx.organisationId) throw new NotFoundException(...)` immediately after the `Shift` lookup in `assertShiftViewable`, `removeRequestedStaff`, `addRequestedStaff` (scheduling.service.ts), `approveShiftRequest` (offer.service.ts), and `declineRequest` (scheduling.service.ts).

**Regression test:** `venue-manager-scoping.integration.spec.ts` → `'cross-org isolation: another organisation's Internal Manager gets 404, never the data, on every Venue Offers action'` — passes under the real `rab_app` role, both before this fix (RLS alone already caught it there) and after (now caught at two independent layers).

**Status:** FIXED (this session).

---

## SEC-002

**Title:** `POST /shifts/:id/cancel` accepted an unvalidated request body field (re-confirmation of prior audit's VULN-004)

**Severity:** LOW

**Affected component:** `packages/rab-server/src/modules/scheduling/controllers/scheduling.controller.ts`

**Evidence (before fix):**
```
cancel(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body('reason') reason: string) {
```
Nest's `@Body('reason')` property-extraction form bypasses the DTO/`ValidationPipe` entirely — the one handler in the codebase that did.

**Attack prerequisite:** Any authenticated caller with `SCHEDULE_CREATE` on a shift they own.

**Safe reproduction:** `POST /shifts/{id}/cancel` with body `{"reason": [1,2,3]}` (a JSON array, not a string) against a disposable test shift created for this purpose.

**Expected result:** `400 Bad Request`, matching every other mutating handler in the codebase.

**Actual result (before fix):** `201 Created` — the array was silently coerced by the Postgres driver into `{"1","2","3"}` and persisted into the `cancelled_reason text` column.

**Impact:** Low — no downstream logic branches on `cancelledReason`'s type or content, and (per SEC-006 below) there is no HTML-rendering sink for it to corrupt in a security-relevant way. Realistic impact was data-integrity/display corruption and unbounded storage (no length cap), not an authorization or injection bypass.

**Why it happens:** The one handler in the codebase reading a body field directly instead of through a validated DTO class.

**Existing protection:** Global `forbidNonWhitelisted: true` `ValidationPipe` — but only for handlers that actually declare a `@Body() dto: SomeDto` parameter for the pipe to validate against.

**Missing protection (now fixed):** A `CancelShiftDto`.

**Exact remediation (implemented):**
```ts
// dto/cancel-shift.dto.ts
export class CancelShiftDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
```
Controller changed to `@Body() dto: CancelShiftDto`, service signature changed to `reason?: string`.

**Regression test:** Live re-reproduction of the exact PoC — `{"reason":[1,2,3]}` now returns `400` with `["reason must be shorter than or equal to 1000 characters","reason must be a string"]`; a valid string reason still succeeds (`201`, no regression).

**Status:** FIXED (this session).

---

## SEC-003

**Title:** `multer` below 2.3.0 — three High-severity DoS advisories, production-reachable via avatar upload

**Severity:** HIGH

**Affected component:** `packages/rab-server` direct dependency, `multer@2.2.0`. Reachable via `FileInterceptor` in `packages/rab-server/src/modules/identity/controllers/profile.controller.ts` (avatar upload).

**Evidence:** `yarn npm audit` — GHSA advisories for DoS via crafted multipart field names, file-descriptor leak on aborted uploads, and oversized array index. Fixed in `multer@2.3.0+`.

**Attack prerequisite:** Any authenticated caller able to reach the avatar-upload endpoint (every role that can log in).

**Safe reproduction:** NOT independently re-reproduced against the live stack in this pass (a DoS PoC against the running dev server was judged out of scope for "do not create excessive load"). Reachability confirmed by source: `profile.controller.ts` wires `FileInterceptor` directly to this vulnerable version.

**Expected result:** N/A (dependency-version finding, not a logic finding).

**Actual result:** N/A.

**Impact:** Potential denial-of-service (CPU exhaustion or file-descriptor leak) against the API process via a crafted multipart upload from any authenticated account.

**Why it happens:** Outdated direct dependency; no automated dependency-update coverage for the `npm`/`yarn` ecosystem in this repo's Dependabot config (see SEC-009).

**Existing protection:** A 10MB body-size cap on the interceptor limits payload size, but the advisories are about parsing behavior/field-name handling, not raw size.

**Missing protection:** Updated `multer` version.

**Exact remediation:** Bump `multer` to `^2.3.0` or later in `packages/rab-server/package.json`, then `yarn install` and re-run the upload flow's existing tests.

**Regression test:** Not added in this pass (requires a lockfile change, which this audit's safety rules treat as a "propose, don't implement blindly for a version bump with real behavioral surface" — see Fix Plan).

**Status:** OPEN.

---

## SEC-004

**Title:** `nodemailer` below 9.1.0 — High-severity ReDoS via `addressparser`, production-reachable via transactional email

**Severity:** HIGH

**Affected component:** `packages/rab-server` direct dependency, `nodemailer@9.0.5`. Used in `engine/core-modules/email/drivers/smtp.driver.ts` and the email-send worker processor for password-reset, invite, and notification email — some recipient/address data traces back to user-supplied email input at signup/invite time.

**Evidence:** `yarn npm audit` — GHSA advisory: quadratic-time address parsing → CPU DoS on a crafted address list. Also carries 3 Moderate advisories (recipient-domain/IDN allow-list bypass, could route mail to an attacker-controlled domain under specific conditions) fixed in the same version bump.

**Attack prerequisite:** Ability to get a crafted string into an address field `nodemailer` parses — bounded by whatever email-address validation already exists upstream (e.g., `@IsEmail()` on `CreateStaffDto`), which narrows but does not eliminate the reachable surface (display names / additional address-list fields are less strictly validated in places).

**Safe reproduction:** Not attempted live (same reasoning as SEC-003 — DoS PoC against the running dev server is out of scope for this pass's safety rules).

**Impact:** Potential CPU-exhaustion DoS on the email worker process; secondary risk of the address-parsing correctness bugs affecting delivery routing.

**Exact remediation:** Bump `nodemailer` to `^9.1.0` or later.

**Status:** OPEN.

---

## SEC-005

**Title:** No `Permissions-Policy` header

**Severity:** INFORMATIONAL

**Affected component:** `packages/rab-server/src/main.ts:77` — Helmet v8's default header bundle does not include `Permissions-Policy`, and nothing else in the codebase sets it.

**Impact:** Browser features (camera, microphone, geolocation, etc.) are not explicitly restricted via this header for the API's own responses. Low real-world impact for a pure JSON API with no HTML-rendering surface of its own, but worth adding for defense-in-depth and because `rab-front` (the actual browser-rendered surface) is a separate deployment not covered by this header at all.

**Exact remediation:** Add `app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); next(); })` (or Helmet's own `permissionsPolicy` option, if upgrading) in `main.ts`, and confirm `rab-front`'s own hosting layer (Vercel) sets an equivalent header for the actual browser-rendered pages.

**Status:** OPEN.

---

## SEC-006

**Title:** Attendance clock-in has no validation against the shift's scheduled time window

**Severity:** LOW (business logic, not a security-boundary bypass)

**Affected component:** `packages/rab-server/src/modules/attendance/services/attendance.service.ts` — `clockIn()` checks the shift's *status* (rejects `CANCELLED`/`COMPLETED`) but never compares `new Date()` against `shift.startsAt`/`shift.endsAt`.

**Evidence:** Full method read (`attendance.service.ts:127-180`) — no time-window comparison exists.

**Attack prerequisite:** A legitimate, currently-confirmed staff member for the shift (this is not a cross-account or authorization issue — it only affects a staff member's own confirmed shift).

**Impact:** A confirmed staff member could clock in arbitrarily early or late relative to the scheduled shift window, and the server would accept it as a normal clock-in with server-authoritative timestamps used for pay calculation from whenever the request actually arrives. Since pay is computed from the real clock-in/out timestamps (never a false client-supplied one — that part is correctly enforced), this is a business-process gap (no "you're too early" nudge, no manager alert for an out-of-window clock-in) rather than a way to inflate paid hours beyond what was actually recorded as worked.

**Exact remediation:** Decide the intended tolerance (e.g., ±15 minutes of `startsAt`/`endsAt`) and either reject or flag-for-review a clock-in/out outside it — a product decision, not purely a security one, so proposed here rather than implemented.

**Status:** OPEN (flagged for product decision).

---

## SEC-007

**Title:** Mobile app's HTTP base-URL fallback is a hardcoded dev default, not fail-closed at the code level

**Severity:** LOW / process risk, not a code vulnerability

**Affected component:** `packages/rab-mobile/lib/core/api/api_client.dart:49-54`.

**Evidence:** `baseUrl` reads `String.fromEnvironment('API_URL')` and falls back to `http://localhost:3000/rest/v1` (or `10.0.2.2` on Android) if unset — nothing in the Dart source itself prevents a release build from shipping with this fallback if the build pipeline omits `--dart-define=API_URL=https://...`.

**Impact:** If a release build is ever produced without the dart-define, it would try to reach `localhost`, not a real backend — a functional failure, not a data-exposure one (Android's `network_security_config.xml` restricts cleartext HTTP to exactly the two dev hosts, so it could not accidentally leak to some *other* plaintext HTTP endpoint). This is a build-pipeline/CI-enforcement question, not a code fix.

**Exact remediation:** Confirm (outside this codebase, in the mobile release CI job) that `API_URL` is always passed and always `https://`; optionally add a Dart-level assertion that fails the release build if `API_URL` is empty in a `kReleaseMode` build.

**Status:** OPEN (process verification, not a code change).

---

## SEC-008

**Title:** `docker-compose.yml`'s local Redis and Postgres run without auth exposed on host ports; `adminer:latest` is unpinned

**Severity:** INFORMATIONAL — dev-only, does not affect production (production Redis is managed Upstash with TLS+auth per `render.yaml`)

**Affected component:** `packages/rab-docker/docker-compose.yml` — `redis` (no `--requirepass`, port 6379 published to host), `postgres` (plaintext dev password, expected/labeled as such), `adminer` (`image: adminer:latest`, unpinned, port 8080 published).

**Impact:** None to production. Relevant only if this compose file is ever run on a host reachable from an untrusted network (e.g., a shared dev box) rather than a developer's own machine.

**Exact remediation:** Pin `adminer` to a specific version tag; optionally add `--requirepass` to the local Redis for parity with production even though it's dev-only. Low priority.

**Status:** OPEN, low priority.

---

## SEC-009

**Title:** Dependabot does not cover the `npm`/`yarn` or `pub` (Flutter) ecosystems

**Severity:** INFORMATIONAL

**Affected component:** `.github/dependabot.yml` — only `github-actions` and `docker` entries exist.

**Impact:** Findings like SEC-003/SEC-004 will not get automated update PRs; they were only caught because this audit ran a manual `yarn npm audit`.

**Exact remediation:** Add `package-ecosystem: "npm"` (root, and/or per-workspace) and `package-ecosystem: "pub"` entries to `dependabot.yml`.

**Status:** OPEN.

---

## SEC-010

**Title:** At least 5 security-relevant integration test files predate the application-target (role-login-isolation) feature and cannot currently exercise their Staff/Venue-Manager-role test paths at all — they fail at the login step, not at the assertion under test

**Severity:** INFORMATIONAL (testing-integrity gap, not an application vulnerability — if anything it's a side-effect of the role-login-isolation control, SEC-related item in Controls doc, working *too* strictly for these older tests to keep up with)

**Affected component:** `AuthService.login()`'s `applicationTarget` resolution (`dto.applicationTarget ?? 'manager_web'` for a non-mobile request) combined with `applicationAllowed()` (`application-access.ts`) — both intentional, correct application code — versus at least 5 integration test files' `login()` helpers, which predate this feature and send neither an `applicationTarget` body field nor an `x-client-platform: mobile` header:

- `attendance-abuse-cases.integration.spec.ts`
- `scheduling-offer-abuse-cases.integration.spec.ts`
- `account-deactivation-abuse-cases.integration.spec.ts`
- `account-lifecycle-abuse-cases.integration.spec.ts`
- `bulk-email-abuse-cases.integration.spec.ts`

(24 of this repo's 24 integration test files have no `login()` helper sending an application-target signal at all; the 5 above are the ones confirmed to actually authenticate a `staff`/`venue_manager` role account somewhere in their test bodies, which is what triggers the failure — a Manager-role login is unaffected, since `manager` gets universal access regardless of target.)

**Evidence:** Live re-run of `scheduling-offer-abuse-cases.integration.spec.ts` against the correctly-configured `rab_app` role: 24/37 tests fail with `403 {"code":"APPLICATION_ACCESS_DENIED","message":"This account does not have access to the Manager system."}` — confirmed via a temporary diagnostic `console.error` on the failing response body (added and removed within this pass, not left in the codebase). `venue-manager-scoping.integration.spec.ts` (the one file this session's own earlier Venue Offers work already touched) is current — its `login()` helper explicitly sends `applicationTarget` — and passes cleanly, including the new SEC-001 regression test.

**Attack prerequisite:** None — this is not exploitable, it's a test harness gap.

**Why this matters anyway:** Every one of these 5 files exists specifically to prove a security property (BOLA, cross-tenant isolation, attendance ownership, etc.) using a Staff or Venue-Manager account. While their login step fails, **the actual assertions under test never run at all** — a `403` on the setup call is not the same as the intended assertion passing, even though earlier CI runs of these exact files (before this application-target feature shipped) may have reported green. This audit's own live, direct HTTP testing against the running server (see RAB-SECURITY-CONTROLS.md and SECURITY-TEST-MATRIX.md) independently re-proved the underlying security properties these tests were meant to cover (cross-staff attendance IDOR, offer BOLA, etc.) without relying on these specific test files — so this pass's conclusions do not rest on their broken state. But anyone relying on "the integration suite is green" as their signal for these specific security properties going forward should not trust it until this is fixed.

**Exact remediation:** Update each affected file's `login()` helper to send `applicationTarget` in the request body (matching `venue-manager-scoping.spec.ts`'s own pattern: `email.startsWith('staff-') ? 'staff_app' : email.startsWith('venuemgr-') ? 'venue_manager_app' : 'manager_web'`, or equivalent per-file logic based on how each file names its fixtures) — a small, mechanical fix per file, but real engineering time across 5 files plus verifying each file's full suite goes green afterward. Not implemented in this pass: it's test-code maintenance, not a security fix, and fixing 5 files' worth of test helpers without introducing new bugs into tests that are supposed to be the safety net deserves its own focused pass with each file's full result reviewed, not a rushed fix bundled into a security audit already carrying two real application-code fixes.

**Status:** OPEN — flagged for a dedicated test-maintenance pass, not fixed in this audit.

---

## Previously-identified findings — verified current status (from `SECURITY_AUDIT.md`, 2026-08-20)

| ID | Title | Then | Now | Evidence this pass |
|---|---|---|---|---|
| VULN-001 | Runtime DB role (`rab_owner`) RLS-exempt on 5 tables | CRITICAL, confirmed live | **FIXED** | `docker-compose.yml:56,107` now use `rab_app`; `main.ts:24-34` (`assertRuntimeDbRole`) refuses to boot on any other role — this guard did not exist in the prior audit's description |
| VULN-002 | Unscoped cross-org `Organisation` lookup in `updateSubdomain` | MEDIUM, code-verified | **FIXED** | `workspace.service.ts:50-65` now calls `core.organisation_slug_taken(slug, orgId)`, a boolean-returning SECURITY DEFINER function — exactly the prior audit's own recommended remediation |
| VULN-003 | Password-reset tokens not invalidated as a set | HIGH, confirmed live (this was the primary reason for that audit's FAIL verdict) | **FIXED** | `password-reset-token.service.ts:36-57` (`issue()`) now invalidates every prior unused token for the user, and cancels any still-pending outbox email for it, before issuing a new one — reproduced live this pass: issuing a second token immediately invalidates the first, confirmed by attempting to consume the older token afterward (`400`) |
| VULN-004 | Unvalidated `reason` on shift cancel | LOW, confirmed live | **FIXED — by this audit** (see SEC-002 above) | |

No other finding from that engagement remains open; this pass did not find a reason to disagree with its other conclusions (auth enumeration resistance, JWT forgery resistance, BOLA/IDOR blocking, CORS, headers, XSS absence) and, where practical, independently re-verified them (see RAB-SECURITY-CONTROLS.md).
