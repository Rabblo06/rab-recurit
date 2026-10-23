# Threat model

One entry per feature that touches authentication, money, or another
person's data, added in the same PR that ships the feature — not written
after the fact. See `rab-workforce-architecture.md` §5.8 for the question
set and `CLAUDE.md` for when this file must be updated.

Template for each entry:

```
## <feature>

Who can call this? —
Whose data is involved? —
What if that identity is compromised? —
What if it's malicious? —
What if the request is tampered with? —
What if two callers race? —
What if the DB returns data written by a lower-trust actor? —
What if a third party (email/push/storage provider) is compromised? —
What happens when authorisation fails? —
What happens when the operation fails halfway? —
```

---

## Health check (`GET /healthz`)

Who can call this? — Anyone; unauthenticated, unauthenticated by design
(Railway's healthcheck has no session). Whose data is involved? — None; it
reports DB connectivity only. What if it's malicious? — Read-only,
no side effects; worst case is a probe learning the service is up. What
if the request is tampered with? — No inputs to tamper with. What happens
when authorisation fails? — N/A, no authorisation gate. What happens when
the operation fails halfway? — `@nestjs/terminus` reports the DB check as
down; the process itself keeps running.

## Migration runner (`setup-db` / `migration:run`)

Who can call this? — Whoever can execute code with `DATABASE_URL` in its
environment: the Railway deploy pipeline, or a developer locally. Not
reachable over HTTP — there is no endpoint. Whose data is involved? —
Schema only in M0 (no rows exist yet); from M1 onward, migrations can touch
every tenant's data via `ALTER TABLE`, so a malicious or buggy migration is
a whole-database blast radius. What if that identity is compromised? — Same
blast radius as a compromised production DB credential — full schema
control. Mitigated by keeping `DATABASE_URL`/`rab_owner` credentials out of
the running server's runtime env once M1 splits owner vs. app connections
(§5.7). What happens when the operation fails halfway? — TypeORM wraps each
migration's `up()` in a transaction by default; a failure rolls back that
migration. Migrations must remain forward-only with no destructive DDL
absent a written data-migration plan (see `rab-workforce-architecture.md`
§14's sequencing rule).

## Tenant context binding (`TenantContextService`)

Who can call this? — Only application code, from within a service method —
not exposed to any transport layer directly. Whose data is involved? —
Whichever tenant's data the bound `organisation_id` scopes queries to for
the lifetime of the transaction. What if the request is tampered with? —
The values bound (`organisationId`, `userId`, `role`) come from
`AuthContext`, itself derived from a verified access token once auth exists
(M1) — never from a request body. A tampered request body claiming a
different `organisationId` is rejected by input validation before it ever
reaches this service (`CLAUDE.md`: "`organisationId` never comes from the
client"). What if two callers race? — Each call opens its own transaction;
`SET LOCAL` semantics mean one request's bound context can never leak into
a different request sharing the same pooled connection. What happens when
the operation fails halfway? — The transaction rolls back; no partial
tenant-context binding can persist past the failed transaction.

## Scheduling & offers (`shift`, `shift_assignment`, `job_offer`)

Who can call this? — Managers create/publish/cancel shifts and send/withdraw
offers, gated by `SCHEDULE_CREATE`/`SCHEDULE_PUBLISH`/`OFFER_SEND`/
`OFFER_WITHDRAW`; staff accept/decline their own offers, gated by
`OFFER_RESPOND`. All five gates are `PermissionGuard` on the controller —
`OfferService`/`SchedulingService` never trust the caller's own claim of
role. Whose data is involved? — Shift pay rates (money, snapshotted onto
`shift_assignment.pay_rate_snapshot_pence` only at confirmation, per A6 —
never recalculated later even if the venue's rate changes afterward) and
which staff member is rostered where and when. What if that identity is
compromised? — A compromised manager account could send offers or cancel
shifts within their own org only (RLS-bound); a compromised staff account
could accept/decline only offers addressed to that staff member's own
`staff_profile_id` (`OfferService.accept`/`decline` filter by
`staffProfileId: staffProfile.id` derived from the session, never from a
path/body parameter). What if it's malicious? — A staff member spamming
accept on an already-full shift gets a clean `409 SHIFT_FULL`, not a
double-booking; there is no endpoint that lets staff assign themselves to a
shift without a prior offer from a manager. What if the request is
tampered with? — `staffProfileId` in `SendOfferDto` is manager-supplied by
design (that's who the offer is for); `forbidNonWhitelisted` rejects any
extra field, including an attempted `status` or `organisationId`. What if
two callers race? — This is the core case this module is built around: two
staff accepting the last seat on a shift race on the atomic
`UPDATE core.shift SET filled_count = filled_count + 1 WHERE ... AND
filled_count < required_count RETURNING ...`; exactly one `UPDATE` returns a
row, the other gets zero rows and a `409 SHIFT_FULL`
(`offer.service.ts#accept`, covered by
`scheduling-offer-abuse-cases.integration.spec.ts`, concurrent-request
case). A second race — the same staff member holding two overlapping
confirmed shifts — is closed at the database level by the
`shift_assignment_no_double_booking` GiST exclusion constraint, not
application logic alone; the resulting Postgres exclusion-violation
(`23P01`) is caught and converted to a clean `409`, never a raw DB error
leaking to the client. What if the DB returns data written by a
lower-trust actor? — N/A, no lower-trust actor writes to these tables
directly (services only). What happens when authorisation fails? — 403 via
`PermissionGuard`; a shift/offer outside the caller's org is a 404, not a
403, matching the "existence itself is a disclosure" rule. What happens
when the operation fails halfway? — `send()`, `accept()`, `decline()`, and
`withdraw()` each run inside one `TenantContextService`-bound transaction
(`assignment` + `offer` created together in `send()`; `shift.filled_count`
+ `shift_assignment.status` + `job_offer.status` all updated together in
`accept()`); a failure at any point (including the exclusion-constraint
catch) rolls the whole transaction back, so a caller never observes a
half-confirmed offer or a shift counted as filled without a matching
confirmed assignment. A gap found while writing this entry: `assertTransition`
throws a plain `Error`, not a NestJS `HttpException`, and nothing mapped it
to a response — every state-machine-guarded mutation (shift publish/cancel,
offer accept/decline/withdraw) was returning a raw `500` instead of the
documented `409` on any invalid transition. Fixed with a global
`InvalidTransitionFilter` (`APP_FILTER` in `app.module.ts`) so this holds
for every current and future `assertTransition` call, not just this
module's.

## Settings (profile, sessions, workspace, roles, platform admin, storage, SMTP)

Who can call this? — Profile/Experience/Account routes (`/profile/*`):
any authenticated user, always scoped to their own `ctx.userId` — there is
no path/body parameter that names a different user. Workspace/Domains
(`/workspace/*`): gated by `SETTINGS_VIEW`/`SETTINGS_EDIT`. Roles
(`/roles/*`): gated by `ROLE_VIEW`/`ROLE_MANAGE`. Admin Panel (`/admin/*`):
gated by `PlatformAdminGuard`, checked against `platform_admin_claim` —
deliberately **not** a `PermissionFlag`, so it can never be granted through
the ordinary `user_permission_override` path (see finding below). Whose
data is involved? — Own PII (name, avatar), session metadata (IP,
user-agent, device), workspace identity (name, subdomain, logo), the
organisation's role/permission catalogue, and — in Admin Panel Config —
the organisation's SMTP credentials (password encrypted at rest via
`SecretEncryptionService`, never returned to the client). What if that
identity is compromised? — A compromised ordinary user can see/revoke only
their own sessions and edit only their own profile; RLS plus the
`userId`-scoped `WHERE` clause in `ProfileService.revokeSession` make a
cross-user session revoke a 404, not a 200. A compromised `ROLE_MANAGE`
holder can create/edit roles and their permission sets within their own
org, including granting themselves any `PermissionFlag` — but never
`platform.admin`, because that isn't a `PermissionFlag` at all. A
compromised platform admin has full Admin Panel access (by design — it is
the highest-trust actor in the org) but is still RLS-bound to their own
organisation; there is no cross-tenant "super admin" path. What if it's
malicious? — SMTP "Test Connection"/"Send Test Email" let a platform admin
open a real TCP connection to an admin-supplied host:port — throttled
(`@Throttle`, same 5/min shape as the auth endpoints) so it can't be used
as a network probe/oracle beyond "did it connect," and connection errors
are never reflected raw to the client. Avatar/logo upload content-type is
sniffed from magic bytes (PNG/JPEG/WEBP only), never trusted from the
client's declared `Content-Type` or filename; storage keys are always
server-constructed (`org/{orgId}/...`), so a malicious filename can't
influence the write path. What if the request is tampered with? —
`forbidNonWhitelisted` rejects an `organisationId`/`isSystem`/`isPlatformAdmin`
field on any Settings DTO; role permission sets are validated against the
real `PermissionFlag` enum (`@IsIn`), so a client can't grant a
non-existent or misspelled permission key. What if two callers race? —
The platform-admin claim: `platform_admin_claim.organisation_id` is a
primary key, so two concurrent `tryClaim` calls for the same org can only
ever have one `INSERT ... ON CONFLICT DO NOTHING` succeed — covered by
`settings-abuse-cases.integration.spec.ts`'s concurrent-claim test. A
revoked claim's row is never deleted, only marked `revokedAt`, so a later
`tryClaim` for that org can never re-insert (same `ON CONFLICT` guard) —
covered by the same suite's revocation test. What if the DB returns data
written by a lower-trust actor? — N/A for these tables; every writer is an
authenticated service call, no lower-trust direct-write path exists. What
happens when authorisation fails? — 403 for `/roles/*` and `/workspace/*`
(the caller knows these routes exist, just lacks the flag); 403 for
`/admin/*` too, by design — unlike a record lookup, "an admin panel
exists" isn't itself a meaningful disclosure. A session/avatar belonging
to a different user is a 404, not a 403, matching the existing
"existence is a disclosure" rule. What happens when the operation fails
halfway? — Profile/workspace/role mutations each run inside one
`runInTenantContext` transaction, so a role's name update and its
permission-set replacement either both commit or neither does. Avatar/logo
upload is the one two-step exception: the file is written to storage
*before* the DB row is updated, then the old file is deleted *after* — if
the DB update fails, the old avatar/logo remains the reachable one (no
dangling reference), and the newly-written-but-unreferenced file is an
orphan on disk rather than a broken pointer, which is the safer failure
mode to fail into.

**A finding from writing this entry**: modelling platform-admin as a
`PermissionFlag` (e.g. `PermissionFlag.PLATFORM_ADMIN`) instead of the
dedicated `platform_admin_claim` table would let any user holding
`user.manage_permissions` self-grant it via the existing
`user_permission_override` endpoint — this is exactly why `tryClaim`/
`PlatformAdminGuard` check that table directly and nothing in the Settings
module ever exposes a route that writes to it outside the `ON CONFLICT DO
NOTHING` claim path.

## Auth, attendance, payroll

### Application-bound authentication and Venue shift requests (2026-09-19)

**Universal mobile login amendment:** The mobile UI no longer selects, sends or
persists an application destination. Email/password authentication on the mobile
transport derives the session destination from database roles (Venue Manager uses
the Venue binding; other permitted mobile identities use the Staff binding).
`/auth/me` remains the sole dashboard role source. Internal Managers now receive
the existing Manager console-entry presentation, with their real identity intact.
Legacy explicit-target clients still pass the existing role matrix and cannot
promote their roles. The transport marker is not authorization: role, permission,
Manager-only API and RLS checks remain mandatory. Old local app preferences are
deleted. All mobile reset links open the same universal login; legacy query
parameters are ignored. The earlier description of manual mobile surface choice
below is superseded by this amendment.

The application target is a requested destination, never a role or tenant authority.
After password verification, login resolves roles from the tenant database and
checks the destination before issuing either token or activating an invited user.
Staff is limited to Staff, Venue Manager to Venue Manager; Internal Manager can
enter all three surfaces while retaining the same user and roles. Existing
administrative console entry is preserved. No profile is created by app selection.

Access tokens and refresh-token rows bind the allowed application. Refresh checks
the stored target and current roles before rotation. Protected requests re-resolve
roles, reject target/header mismatches, and reject mobile tokens on explicitly
Manager-only controllers/actions even when the caller omits the application header.
The existing active-account, forced-password-reset, maintenance, permission,
resource-scope and RLS checks still run. Legacy unbound refresh tokens are revoked
by migration; unbound access tokens require a fresh login. App-target validation
must remain centralized when adding a new application or Manager-only endpoint.

Venue Manager defaults grant `staffing_request.create`, not `offer.send`. Existing
system roles are backfilled additively; explicit permission revocations still win.
Mobile submission uses the existing shift-request service and its selected-staff
records. Both guard and service require request permission. Manager approval remains
the operation that creates staff offers; submitting a request must not notify staff
as if an offer had already been approved. No tenant policy or scope is loosened.

Password-reset return context is an enum persisted with the one-time token. The
success response derives its destination from the consumed token (or current
identity for legacy tokens), never an arbitrary redirect URL. Reset changes the
password and revokes refresh sessions but does not activate Staff or issue a login
session. The success page requires an explicit return action. Android return links
select the login surface and clear the previous local session; they grant no access.

The existing Redis IP throttle and failed-account limiter remain in place. Account
lockout now returns 429 with Retry-After rather than a misleading credential error.
Clients distinguish 401, application 403, 429, transport and server errors, disable
duplicate submissions and observe cooldowns. CORS exposes Retry-After. The existing
one-hop proxy trust and Cloudflare-header handling are unchanged: deployment must
ensure the origin is only reachable through the trusted proxy; local tests cannot
establish that production network boundary.

Regressions cover the full role matrix, denied-login token absence, role revocation,
refresh target binding, Manager API rejection without a header, invited Staff reset
and first-login activation, request-before-approval, RLS rejection, cooldown and
duplicate-submit UI behavior. See `.audit/auth-final-integration.log` for test
evidence. Local QA evidence was intentionally removed from source control.

### Attendance clock, shift QR and venue geofence configuration (2026-09-21)

Actor → action → consequence. A Staff member clocking in from home, or for a shift they
are not confirmed on, would create false paid hours. Controls (all server-side, all
re-checked on every request, none trusted from the device): `staffProfileId` comes from
the JWT only; a `CONFIRMED` `ShiftAssignment` is re-read fresh each time (a removed
Staff member's still-validly-signed QR is refused); server-clock window
`[start − CLOCK_IN_EARLY_MINUTES, end + QR_POST_SHIFT_GRACE_MINUTES]`; one signed QR per
shift (HKDF-derived key, never `APP_SECRET`; payload `{shiftId, venueId, ver}`, no
action, no tenant ids trusted); geofence distance computed on the server against the
stored `Venue` coordinates. The Staff request carries only `shiftId`, `qrToken`, `lat`,
`lng`, `accuracyM` — a `venueLat`/`venueLng`/`venueRadius` field is a 400. Clock-in is
race-safe via the partial unique index, not app logic. Clock actions are additionally
limited to 10/min per user (Redis, separate key space from the global per-IP tier).

Venue location is the trust anchor, so who can change it matters: `lat`/`lng`/
`geofenceRadiusM`/`enforceGeofence` are settable only through `POST/PATCH /venues`,
gated by `venue.create`/`venue.edit` (Internal Manager, CEO) and the existing
per-Manager ownership scope (404 outside it, never 403). Venue Manager, Staff and the
mobile client hold neither permission. The server rejects enforcement without both
coordinates and a radius ≥ 50 m, rejects a half location, and re-validates the merged
final state on update. Every change to the four fields is audited
(`venue.geofence_updated`, before/after). Accepted risk: a malicious or mistaken
Internal Manager can move a venue's pin or disable enforcement; the audit entry is the
detective control. Known limits: GPS can be spoofed on a rooted device (`accuracyM`
and the QR are the mitigations, not a proof); geofence-exit auto clock-out only runs
while the app process is alive. Tests: `attendance-abuse-cases`,
`venue-geofence-config`, `workspace-cross-tenant-rls-attack` (covers `shift_report` and
`attendance_correction`).

### Attendance review, correction, finalisation and the worker (2026-09-21)

**Venue Manager corrections.** The Venue Manager role now holds `attendance.edit` and
`report.export` (migration `VenueManagerAttendanceReviewPermissions`; the role definition
in `ManagerService.ROLE_DEFS` matches). Actor → action → consequence: a Venue Manager
who can rewrite clock times can inflate paid hours, so every correction is (a) confined to
their own venues by `ResourceScopeService` — another venue or organisation is a 404 —,
(b) a mandatory reason (≥ 10 chars), (c) a first-class `attendance_correction` row with
before/after/actor/reason plus an `attendance.corrected` audit entry, and (d) refused once
the report is finalised (409, serialised with `finalise` by an advisory lock so a correction
cannot slip in between "finalised" and "final PDF rendered"). Finalisation is idempotent
(same actor/time, one audit entry). Accepted risk: a dishonest Venue Manager can still
correct within their own venue before finalising; the correction table and audit log are the
detective control, and payroll approval remains a separate permission.

**Worker is not an authority.** BullMQ payloads and Redis contents are hints. The email
processor re-reads the outbox row under tenant context and re-validates it; an outbox row
without `target_user_id` is cancelled (fail closed) — the report jobs set it for every
recipient (a bug found by the end-to-end lifecycle test: without it every roster/timesheet
email was silently cancelled). Multi-worker safety: per-report session advisory lock,
re-check after lock, and a compare-and-set on `final_pdf_sent_at`, so N workers produce one
claim, one PDF, one email.

**Worker discovery vs the API.** Cross-tenant discovery brackets its read in
`ALTER TABLE … DISABLE/ENABLE ROW LEVEL SECURITY` on the owner connection (ACCESS
EXCLUSIVE). Measured: under 1000× the production scan rate this made 38 of 100
simultaneous clock-ins fail with deadlocks. Mitigation: every discovery transaction sets
`lock_timeout = 250 ms` (below `deadlock_timeout`), so the worker always loses and the API
transaction is never the deadlock victim; a yielded scan retries next tick and RLS is
restored by the rollback. Residual: the worker still takes an ACCESS EXCLUSIVE lock (bounded
to ≤ 250 ms of writer stall). The structural fix — per-organisation discovery under `rab_app`
with no RLS toggling — is recommended follow-up work.

**Boot/shutdown.** PID 1 ignores SIGTERM without a handler; both entry points install a
boot-time guard and `start.sh` traps it, so a deploy that replaces a container mid-boot
exits promptly instead of hanging until SIGKILL. Verified in Docker on Linux.

Pending — these land in M1 (auth, already built — entry above covers tenant
context binding but not the full auth flow), M4 (attendance) and M5
(payroll) per `rab-workforce-architecture.md` §14. Each gets its own entry
here in the PR that builds it, before merge.


### Post-shift Worker milestones (2026-09-22)

Threat: replayed/concurrent Worker scans or forged scope could advance another tenant's attendance or emit duplicate audit events. Mitigation: existing owner read-only discovery under advisory/DDL lock and bounded lock timeout; each candidate is reloaded with runtime tenant/workspace RLS, locked FOR UPDATE, checked for clock-out and eligible attendance state, and updated/audited atomically. API and Flutter cannot supply lifecycle transition timestamps. PostgreSQL time supplies eligibility. Payroll status, duration and money are unchanged. Clock-out corrections invalidate old milestones in a database trigger. Integration coverage includes exact boundaries, wrong/missing states, reruns, restart catch-up, concurrent workers, tenant denial and once-only audit. All six new integration cases passed against local PostgreSQL with runtime RLS; 78 offer/attendance abuse regressions also passed after migration.

### Object storage driver — Cloudflare R2 / S3-compatible (2026-09-24)

Actor -> action -> consequence: object storage holds avatars, workspace/organisation
logos and generated report PDFs (rosters, final timesheets — attendance/payroll
evidence, indirectly personal data). A storage misconfiguration or a driver that
mishandles provider errors could leak another tenant's file, silently drop upload
failures, or make a credential/permission fault look identical to "the file doesn't
exist" (masking a real incident instead of surfacing it).

Controls: object keys are always server-generated (`FileService.buildObjectKey` —
opaque UUIDs plus a server-chosen folder; no email/name/payroll value ever appears in
a key) and never trusted from a client — every route is addressed by `stored_file` id
only, there is no endpoint that accepts a raw object key or bucket. Access is decided
before a key is ever resolved: JWT -> `AuthContext` -> `stored_file` row under RLS
(organisation + workspace boundary, `FORCE ROW LEVEL SECURITY`, no DELETE grant to
`rab_app` — files are tombstoned, never hard-deleted by the application role) ->
per-kind `FileAccessRegistry` policy (e.g. `ReportFilePolicy` additionally requires
`report.view` and the same venue-scoping a Venue Manager's report endpoint uses) ->
only then is the object key resolved and the store touched.

Error semantics are deliberately NOT "anything failed = not found": `mapProviderError`
(`storage.errors.ts`) classifies a genuine 404/NoSuchKey as `OBJECT_NOT_FOUND`, but a
403/AccessDenied/bad-credential response is `STORAGE_PERMISSION_ERROR` and a
network/5xx/timeout is `STORAGE_TEMPORARILY_UNAVAILABLE` (retryable) — neither ever
returns `null` the way a missing object does, so a credential rotation gone wrong or a
provider outage surfaces as a real, alertable failure rather than looking like empty
storage. Every stored evidence file (report PDFs) is SHA-256-verified on every read
that returns bytes (`FileService.readVerified`); a same-size corruption is caught and
the bytes are never served or emailed. No object is ever public: the driver sends no
ACL field on any write, and R2/S3 credentials never reach a client (presigned URLs are
minted per-request after authorization, TTL-bounded 30-900s, never stored, never
logged).

`STORAGE_KEY_PREFIX` (the one thing an operator sets that becomes part of every key) is
normalised and validated at BOOT (`normaliseKeyPrefix`, `env.validation.ts`) — a
traversal segment (`../`) is refused before the process ever serves a request, not
discovered on the first write.

Accepted risk / residual: worker cross-tenant discovery (unrelated to this driver, see
the API+Worker entry above) still uses `ALTER TABLE ... DISABLE/ENABLE ROW LEVEL
SECURITY` under a bounded lock, not this storage layer. A leaked R2 access key/secret
grants read/write/delete on the whole bucket (R2 has no per-prefix IAM the way AWS STS
policies can express) — the mitigation is credential handling discipline (OpenShip's
secret UI, never committed, rotated on suspected exposure), not anything in this code.
Tests: `file-storage-security.integration.spec.ts` (cross-org/cross-workspace/raw-key/
injection/RLS attack matrix, real MinIO), `report-storage-multiworker.integration.spec.ts`
(failure injection: credential failure, network outage, corrupted/missing object,
forged queue payload — all real MinIO), `attendance-storage-outage.integration.spec.ts`
(the attendance hot path — clock-in/out — never depends on object storage being up),
`s3.driver.spec.ts` (mocked AWS SDK: error classification, no-ACL, R2's NONE encryption
sends no SSE header).


## Internal Manager staged staff selection (2026-09-28)
A manager with STAFFING_REQUEST_APPROVE may save the recipient list of a pending
request in their server-derived workspace. IDs and the expected prior selection
are untrusted. The existing staff list remains createdBy-scoped under tenant RLS;
the picker requests both ACTIVE account and ACTIVE employment. Atomic save checks
permission again in-service, org/workspace, private staff ownership, active status,
availability, uniqueness, capacity and an exact prior-selection snapshot. Existing
per-person audit and Venue Manager removal notification behavior is reused within
the transaction. No staff notification, offer creation or approval occurs on save.
Selection edits, approve and decline lock the parent shift before reading state;
a stale concurrent save fails rather than overwriting another review. Approval
still derives recipients from persisted rows and rechecks account/employment and
overlap, preserving its existing partial-send semantics. Failures roll back the
entire selection save; Cancel makes no write. No RLS or identity model changes.


## Shift-scoped selectable staff read (2026-09-28)
GET shifts/:id/selectable-staff requires ManagerApplication, STAFF_VIEW,
STAFFING_REQUEST_APPROVE and a resolved workspace, repeating permission checks
inside the service. Pending request, organisation, workspace and requestedBy are
validated before reading private createdBy-scoped staff. Account and employment
ACTIVE filters are mandatory SQL predicates. Only an explicit minimal projection
is returned; availability is calculated by canonical AvailabilityService from the
saved shift window, not client timestamps. Busy active rows are disabled in UI;
all eligibility is rechecked by existing atomic save and approval. Unknown query
scope/status/time overrides are rejected by the DTO. Venue directory unchanged.


## Venue Offer live staffing pipeline (2026-09-29)
The new GET /shifts/:id/pipeline, POST /pipeline/offers/:offerId/cancel and
POST /pipeline/replacements require manager application, JWT, resolved workspace
and the existing schedule.view / offer.withdraw / offer.send permissions. Services
repeat permissions and require explicit organisation, workspace, createdBy and
Venue Manager request origin. Unknown/foreign owners remain 404, including another
manager inside the same workspace. UUID route parsing and whitelisted DTOs reject
client scope/status/timestamp overrides. Existing forced RLS remains enabled.

Cancellation locks shift, offer and assignment, rechecks database clock_timestamp
strictly before startsAt minus 15 minutes, and refuses any attendance or terminal
booking. It reuses legal existing states, preserves confirmed offer evidence,
releases the confirmed seat once, and commits the optional existing UserNote,
audit and notification in the same transaction. Staff accept and clock-in share
parent-first serialization. Replacement uses active private staff, canonical
availability and existing OfferService/ReplacementRequestService, with no automatic
send and no client-controlled capacity or schedule.

Kanban states/counters/readiness are read projections. WAITING is persisted
notification.read_at for offer_sent, not a delivery/view claim. The existing late
predicate and Attendance values remain authoritative. Queries batch staff data;
POST /files/previews batches at most 32 opaque PROFILE_IMAGE IDs under the existing
StoredFile RLS and registered policy. It returns verified inline bytes up to 2 MB
per image (otherwise initials), excludes reports, exposes no keys or bearer URLs,
and sends Cache-Control: no-store. Existing single-file report policy authorizes
both original_file_id and final_file_id; foreign/missing downloads remain identical.

The existing final-timesheet worker now stores the immutable unsigned original
before the finalised PDF. Same renderer, FileService, report advisory lock and
email claim/outbox are retained. The additive original_file_id FK requires migration
before API/worker release. Discovery is bounded to 200 candidates per cycle and
restores RLS transactionally using the existing worker mechanism. Readiness rejects
unresolved relevant assignments, while legacy already-finalised records retain
worker compatibility. No handwritten signature flow was invented: finalisedBy/At
remain the existing sign-off evidence.


## Existing mobile auth presentation update (2026-09-29)
The sign-in design reuses AuthFlowShell, LoginSheetContent and
BiometricLockSheetContent; no backend/authentication API or storage changes.
The explicit Continue button calls the existing local_auth-backed
attemptBiometricRestore; biometric success still requires /auth/me acceptance.
The shell's password-fallback flag is presentation-only and remains under the
existing biometricLocked gate. It cannot create eligibility from unauthenticated
or reauthRequired, and is discarded when the provider leaves biometricLocked.
No new AuthPhase or login route. Hidden form focus is excluded; requests cannot
be submitted twice, and switching methods is disabled during authentication.

Returning email is not known before unlock: display a read-only Saved account
placeholder rather than a guessed email or new remembered credential. Editing
the password form email cannot change which saved session biometrics unlocks.
No passwords/tokens/emails newly persisted. Security text describes device
biometrics, without claiming WebAuthn, physical keys or phishing resistance.
Hardware loss uses existing password fallback; clean cancellation/retry and
lockout messaging never grant access. Regressions cover rejected server sessions,
mandatory password reauth, logout, account isolation and both mobile role routes.


## 2026-09-29 ? Existing-account mobile biometric persistence

Scope: existing Flutter AuthProvider/BiometricStore/ApiClient only; no backend authorization changes. A person holding an unlocked device may see the remembered account email, as explicitly required. That record is presentation data, never proof of identity. Local authentication remains biometric-only through local_auth; no passwords or biometric material are persisted.

[MEDIUM]
Failure: Device user -> reuses an account-independent/stale local binding -> wrong-account or expired biometric access could be attempted.
Actor: Person with access to the mobile installation.
Location: packages/rab-mobile/lib/core/auth/auth_provider.dart (_init, attemptBiometricRestore).
Root cause: Prior startup logic checked only a preference and password timestamp, not token presence, session ownership, native confirmation lifetime, or returned user identity.
Fix: Require stored session, matching remembered/session/preference user IDs, native confirmation strictly younger than the canonical 90 days, and current capability. Recheck before/after native prompt and backend validation; /auth/me must return the same user. Password and biometric unlock never advance confirmation time. Legacy bindings require password and new native setup. Different-account password login discards the old binding; explicit disable removes preference and confirmation. Normal logout keeps display identity/preference but removes tokens and session owner. Native-result generation checks prevent logout during a prompt from reopening the app.
Regression: biometric_reauth_boundary_test.dart covers exact boundary, no tokens, owner mismatch, backend identity mismatch, legacy/future timestamps, expired access refresh, rejected/transient sessions, logout/relogin, account switching, forced reset and logout during native prompt. Existing biometric_fallback_test.dart checks read-only email, form prefilling, native outcome UI, role routes and responsive layout.

Operational limits: Existing local_auth capability signals do not identify every enrollment-set change. No unsupported enrollment hash is invented. Secure timestamps use the device clock (future confirmation fails closed); this is an app unlock policy, not a new server session lifetime. Offline logout still clears local session, but cannot guarantee server revocation while the server is unreachable. Logout attempts revocation, refreshes expired access when necessary and retries with the current rotated refresh token, with a 10-second local-cleanup deadline. API refresh responses arriving after token clearing are rejected. Network/5xx failures do not erase biometric preference. General app-resume locking behavior is unchanged; expiry is enforced at startup and each biometric restore attempt.


## 2026-09-29 - Existing biometric setup presentation

No new credential flow or passkey implementation. The existing provider remains authoritative; binding creation still follows native success only. Requested UI integration keeps offeringBiometricSetup on native failure/cancellation instead of navigating to the app; explicit Skip still enters the already password-authenticated app without a binding. Both actions are disabled during pending native work. Regression coverage verifies no binding on failure, same mounted shell/no route push, skip without native call, and unchanged Staff/VM roots. Display wording Enable Passkey follows the supplied design; the footer truthfully says Protected by your device biometrics. Native QA uses synthetic memory-only identity/session collaborators and the real OS prompt, never production credentials or biometric storage.


## 2026-09-29 - Venue Manager History destination

History is a presentation filter over VenueManagerProvider's existing session-authorized /shifts, /venues, /job-roles and /offers responses. It supplies no organization/venue/identity override and makes no Staff-history call. Detail uses existing /shifts/:id authorization; reports remain capability/server-gated. No authorization changes or new backend endpoint. A refresh failure clears provider records and displays the existing error state. Tests cover filtering of pending/future/active records, data clearing on failed refresh, unchanged role routing and nested navigation; client tests do not substitute for existing server scope enforcement.


## Individual staff assignment windows (2026-09-30)

Venue request times are untrusted intent. The request and bulk DTOs accept optional per-staff full timestamps; services validate membership, uniqueness, containment, positive duration and the existing break rule. Request staff rows persist intent; approval revalidates eligibility and creates the existing canonical assignment.period. No client pay override is accepted on Venue Manager requests. Existing guards, venue/workspace ownership, tenant context and RLS remain authoritative. Confirmation retains its GiST no-double-booking exclusion; pending requests do not reserve time.

Staff offer/history, attendance admission, late/reminder/no-show/missing-clock-out and report scheduled fields consume the individual window through shared helpers. Actual attendance, QR/geofence, parent lifecycle, cancellation and replacement policies are unchanged. Missing-clock-out assignment reads remain tenant-scoped with RLS enabled; no new RLS-disable path was introduced. Migration adds nullable request intent only, with no historical backfill. See docs/VENUE-MANAGER-ASSIGNMENT-TIMES.md for evidence and release limits.

## Cold-launch local app unlock (2026-09-30)

Threat: possession of a previously signed-in device allowed an app cold launch to reveal authenticated content when biometrics were skipped. AuthProvider._init called _restore for an absent biometric preference, and _restore treated /auth/me success as sufficient UI authentication. Fix separates process-only AppUnlockState from server identity. Stored credentials never grant local unlock; the no-biometric restore requires canonical password login. Native success still requires /auth/me and account binding/deadline checks. Authenticated providers/root and navigator lifetime require canAccessAuthenticatedUi. No termination-triggered logout, persistent unlocked flag, new endpoint, password storage or biometric-template storage. Current ApiClient still stores access tokens in secure storage; the brief's memory-only assumption does not match this checkout and was not silently asserted or changed. See mobile cold-launch report for verification limits.

## Venue assignment defaults and individual breaks (2026-09-30)

Venue request times are defaults, not authority to bypass staff eligibility. Each submitted interval and effective break is server-validated; actual proposed intervals feed existing availability and overlap checks. Null break inherits; explicit zero remains a real override. Request intent and approved assignment breaks persist separately from actual attendance corrections. Parent operational times expand transactionally with LEAST/GREATEST; original defaults remain separate, and stale bulk snapshots cannot shrink a prior recipient's extension. Existing account/employment/venue/team/workspace/RLS/approval guards and GiST exclusion remain unchanged. Unknown top-level/nested authority properties are rejected by the existing whitelist. Submission confirmation is server-driven and truthfully indicates pending manager approval. The stale local Docker DTO was verified and refreshed, not worked around by relaxing validation. See docs/VENUE-SEND-SHIFT-BREAKS-DTO-SUCCESS.md.

## PRE-01 worker discovery (2026-09-30)
Removed report/staffing runtime RLS DDL: fixed read-only owner enumeration exposes workspace IDs only; read-only rab_app transactions discover candidates under org/workspace RLS. Final report creation/publication uses scoped re-fetch, readiness/cancellation checks, row/advisory locks, worker_event and CAS. No proven cross-tenant exploit claimed for old transactional DDL. Tests observe SQL and RLS flags, isolation, publication concurrency/failure. No migration or permission widening. Distinct email_outbox and stored_file privileged maintenance toggles remain PRE-02/PRE-03; broad worker least-privilege is not certified. See docs/PRE-01-WORKER-RLS-DISCOVERY.md for final test status and limitations.


## PRE-02 / PRE-03: runtime worker table-security changes (2026-10-01)

- Severity: privileged trust-boundary/availability risk; no demonstrated cross-tenant exploit. Actor -> action -> consequence: trusted maintenance worker used owner-level RLS DDL during queue/storage maintenance, creating table-wide security-state mutation and AccessExclusive lock contention.
- Original sources: packages/rab-worker/src/queues/rab-email/email-dispatch.job.ts and packages/rab-server/src/command/storage-reconcile.command.ts. Root cause: global discovery and mutation were coupled to owner transactions rather than existing organisation/workspace scope.
- Fix: fixed READ ONLY catalogue enumeration returns IDs only; rab_app performs per-org locked queue claims and scoped file reads/CAS/purge. Email claims commit before publish; existing token/provider fencing and ambiguity rules remain. File deletion follows a committed pending claim or locked terminal-state revalidation. Orphans stay report-only. No RLS toggles, new privileges or policy exemptions.
- Regression evidence: explicit before/after RLS flags, observed SQL, owner-connection query identification, unscoped/cross-org/workspace denial with positive controls, independent email OS processes, stale generation completion, publication failure, escaped payload retry, concurrent purge, storage timeout/database failure and MinIO report/private-file tests. See docs/PRE-02-PRE-03-WORKER-PRIVILEGE.md and .audit/pre02-pre03/verification-summary.json for exact outcomes.
- Residual boundary: the process retains broadly privileged owner credentials for existing token/invitation retention and catalogue/advisory-lock work, plus private object-store maintenance credentials. Scope enumeration has O(organisations + workspaces) cost; terminal deletion holds a row lock over object I/O. This change closes runtime RLS toggling, not arbitrary-code compromise of the worker, remote-storage atomicity, or production release certification.

## Submitted-shift projection boundary (2026-10-01)

Threat: Venue Manager changes a shift ID or shares a venue with a different submitter to read another request's staffing progress. New /shifts/sent routes require authenticated SCHEDULE_VIEW guard plus service permission, venue ResourceScopeService scope, session organisation, requested_by=session user and assigned venue under TenantContextService/RLS. Foreign-org, sibling-workspace and same-venue other-requester details return404 and lists exclude rows; non-Venue-Manager scope is forbidden. Aggregates use rab_app and authorized shift IDs. No owner connection, grant, policy, migration or RLS change. Read-only projection never drives transitions.

Regressions: venue-manager-scoping.integration.spec.ts checks all three foreign-read boundaries, five-offer mapping, requested_by continuity and cancelled-assignment counts. Workspace/ownership/offer abuse tests pass. Evidence .audit/sent-shifts-fix/verification-summary.json; docs/SENT-SHIFTS-KANBAN-FIX.md. Original screenshot's postapproval empty cause remains unproven; no cross-tenant exploit alleged. Runtime deployment remains separate.

## Dedicated accounts domain for activation/password-reset (2026-10-02)

Threat: activation/reset pages served under the Manager app's own domain (APP_URL) make a pre-authentication, public page indistinguishable from the authenticated Manager application — a phishing/trust-boundary concern, not a token-security one. Fix separates the public account-lifecycle pages onto their own domain (new ACCOUNTS_URL env var, same React Router app, same build — only the two email-link-building call sites in AccountLifecycleService and AuthService.forgotPassword() moved from APP_URL to ACCOUNTS_URL) while reusing every existing token/session control unchanged: AccountInviteService/PasswordResetTokenService's hashing, 24h/48h/1h TTLs, atomic single-use consume, AUTH_THROTTLE rate limiting, and RefreshTokenService.revokeAllForUser on reset all untouched. No new auth system, no new token type.

New disclosure, deliberately scoped: AuthService.activateAccount() now returns 200 with `{ applicationTarget, managerLoginUrl }` (previously 204/empty), computed via the same defaultApplication(roles) join resetPassword() already used and discloses identically — the caller already holds a single-use secret token proving invite possession, so disclosing their own resolved role/app-target back to them is not a new privilege boundary. The uniform "invalid or expired" failure message for unknown/expired/used/revoked tokens is preserved unchanged on both endpoints — the task's own "must not disclose whether an account exists" requirement was explicitly honored by NOT adding separate expired/used/invalid states, which would require the backend to leak which one occurred.

CORS: no wildcard, no code change — CORS_ORIGINS stays a plain comma-separated explicit allowlist (environment.service.ts); deploying this adds one more literal origin (ACCOUNTS_URL's own) to that list, same mechanism already used for the Manager app's origin.

Regressions: extended account-invite-abuse-cases.integration.spec.ts (activation email uses ACCOUNTS_URL not APP_URL; per-role applicationTarget/managerLoginUrl for Staff/Internal Manager/Venue Manager; all six pre-existing 204-expecting assertions updated to 200, no change to their actual pass/fail conditions) and account-lifecycle-abuse-cases.integration.spec.ts (reset email uses ACCOUNTS_URL; reset response's managerLoginUrl). authErrors.spec.ts covers the frontend's loginDestination()/postAuthSuccessCopy() absolute-URL-for-manager / rab://login-for-mobile split, including that a manager_web target is never produced for Staff/Venue Manager regardless of input. Full existing auth-abuse-cases/account-invite-abuse-cases/account-lifecycle-abuse-cases/session-auth-correctness/rate-limiting suites re-run to confirm no change to token expiry, single-use, no-enumeration, or session-revocation behavior.

## Durable offline push notifications — device registration and FCM/APNs delivery (2026-10-11)

Threat: a push device token is a bearer-ish credential for reaching a specific person's phone, and the notification content it ends up carrying can disclose business/venue/staff details to whoever controls the delivery provider or intercepts the token in transit. Two separate concerns follow: (1) the registration endpoint must never let a client claim a device under someone else's identity, organisation or workspace; (2) the payload actually sent to Firebase/Apple must not be the thing that could leak data if that third party is compromised — exactly the open question THREAT-MODEL.md's own intro ("What if a third party — email/push/storage provider — is compromised?") already poses for this feature class.

Mitigation, registration: `POST /rest/v1/push/devices` (`PushDeviceController`, `@UseGuards(JwtAuthGuard)`) derives `organisationId`/`userId` only from the verified JWT (`AuthContext`), never the body — `RegisterPushDeviceDto` has no `userId`/`organisationId`/`workspaceId` field at all, so `forbidNonWhitelisted` 400s any client attempt to supply one; `PushDeviceService.register()` upserts on `(userId, deviceId)`, so a forged `deviceId` under a different user's identity simply creates that OTHER user's own row, never overwrites the real owner's. `deactivate`/`deactivate-all` are scoped by `ctx.userId` in the WHERE clause, so one user can never deactivate another's device even if they guess its id. `core.push_device`/`core.push_delivery` carry `ENABLE`+`FORCE ROW LEVEL SECURITY`, org-scoped policy, same shape as `core.notification` — per-user ownership (not just per-org) is enforced in the service layer on top, matching that table's existing precedent. `pushTokenEncrypted` is `bytea`/`select:false`, AES-256-GCM via the existing `SecretEncryptionService` (same convention as `User.totpSecretEncrypted`), never returned by an ordinary `find()`, never logged.

Mitigation, payload minimality: the body actually sent to FCM/APNs is deliberately generic — `title: 'Crewflow'`, `body: 'You have a new notification. Tap to view.'`, `data: {notificationId, type}` only (`push-send.processor.ts`) — never `Notification.title`/`.message` verbatim, which can embed venue names, staff names or decline reasons. A compromised or merely curious FCM/APNs operator therefore learns "this user has a notification of this type," never its content; the real content is only ever retrieved through Crewflow's own already-authenticated `/notifications` API after the device taps through. Provider acceptance is explicitly never treated as read/delivery confirmation — `push_delivery.status = 'ACCEPTED'` records only that FCM/APNs took the message, not that the device displayed it; nothing in this system marks `Notification` content as read on that basis.

Mitigation, provider isolation: `PushDriverFactory.getDriver(platform)` routes android to `FcmDriver` (official `firebase-admin` SDK) and ios to the new `ApnsDriver` (direct Apple HTTP/2 Provider API, JWT ES256 signed from `APNS_AUTH_KEY_P8` via `node:crypto`) — neither driver is reachable unless `PUSH_PROVIDER=REAL` is explicitly set; the default `FAKE` driver requires no credential and is what every test uses. Both drivers classify an invalid/unregistered token as a trigger to deactivate that specific device row (`deactivateInvalidToken`), never anything broader. `audit_log`'s insert-only guarantee and the existing `assertTransition` state-machine discipline are untouched by this feature — push is additive delivery, not a new mutation path.

Regressions: `push-delivery.integration.spec.ts` (rab-server, 17/17) covers forged-identity registration (A7), cross-org RLS denial (D1/D2), no-tenant-context zero-rows (D1), and the HTTP endpoint ignoring any client-supplied identity field (E1). `push-delivery-dispatch.integration.spec.ts` (rab-worker, 8/8) covers invalid-token-triggers-deactivation, a device deactivated after the delivery row was created being revalidated and CANCELLED rather than sent to a dead registration, and duplicate-claim-is-a-no-op. `apns.driver.spec.ts` (8/8) verifies the ES256 JWT signature against a real generated EC keypair and the APNs status/reason classification. No test or `.env.example` entry carries a real Firebase/Apple credential.

## Staff Shift Reminders completion — clock-in window open reminder (2026-10-11)

Threat: a new reminder window is a new place to leak "which staff member is scheduled where, right now" across tenants or to the wrong recipient, and a new place for a scan-based worker to double-send or send past the moment it stopped being true (a cancelled shift, a reassigned staff member, a member who already clocked in).

Mitigation, identity/isolation: the new `CLOCK_IN_WINDOW_OPEN` window adds no new identity, recipient-resolution or tenant-scoping logic at all — it is one more entry in `shift-monitor.job.ts`'s existing `REMINDER_WINDOWS` loop, so it inherits, unchanged: `runScopedForOrg`'s `crewflow`-scoped transaction and RLS binding (never the owner connection for the mutation itself), `loadReminderCandidate`'s fresh re-check of assignment/shift/staff-profile/user state (CONFIRMED status, non-cancelled/completed shift, ACTIVE user), and the `core.worker_event` UNIQUE-claim idempotency ledger. A reassigned shift (old assignment transitioned to a terminal status, a new CONFIRMED assignment for a different staff member) is therefore handled for free by the SAME mechanism that already protects the pre-existing 24h/2h/30m windows — the previous staff member's assignment simply stops matching `loadReminderCandidate`'s CONFIRMED check, so no code path can address a reminder to them. Verified directly, not assumed: `shift-monitor-clock-in-reminder.integration.spec.ts` test 5 performs a real reassignment and asserts the former staff member's assignment ID receives nothing while the new owner receives exactly one reminder.

Mitigation, double-send and staleness: Pass A (before claiming the `worker_event`) and Pass B (immediately before the irreversible `notify()` call) both now additionally check for an existing `attendance` row when the window `requiresNoAttendance` — a member who clocks in in the exact gap between claim and send suppresses the reminder rather than sending a now-meaningless "clock-in is available" push after the fact. Two concurrent worker cycles and three sequential (simulated-restart) cycles against the same candidate both produce exactly one reminder — the `worker_event` UNIQUE constraint is the actual cross-replica guard, not timing. Staleness is bounded structurally: every window, including this one, sits inside `shift-monitor.job.ts`'s `if (msUntilStart > 0)` gate, so once a shift has actually started no clock-in-window reminder can ever fire regardless of how late a worker catches up — verified by a candidate deliberately discovered well past its no-show grace period, confirmed routed to the no-show branch instead, never producing a clock-in reminder.

Mitigation, duplicate-alert consolidation: when `CLOCK_IN_EARLY_MINUTES` exactly equals an existing fixed window's threshold (30 minutes), `buildReminderWindows` omits the new window entirely for that scan rather than sending two near-simultaneous pushes for the same moment — a deliberate, tested (test 18) UX/noise decision, not a security control, and documented as such so it is never mistaken for one.

Regressions: `shift-monitor-clock-in-reminder.integration.spec.ts` (18/18) and its push-enabled companion (2/2) are listed in full in `docs/HANDOFF.md`. Pre-existing coverage of the untouched 24h/2h/30m windows and no-show detection — `worker-operations-abuse-cases.integration.spec.ts` (20/20), `worker-event-idempotency.integration.spec.ts` (21/21) — re-run clean, confirming the refactor from a static window array to `buildReminderWindows(clockInEarlyMinutes)` changed no existing window's behaviour.

## P2.8 — reversible organisation suspension (2026-10-11)

Threat: a compromised or abusive tenant (billing dispute, ToS violation, compromised admin account) needs to be cut off from the platform without destroying its data, and the cutoff itself needs to be hard to trigger accidentally or by a hijacked session, fully reversible, and leak-proof against the suspended tenant's own staff continuing to use already-issued credentials.

Mitigation, authorization: suspend/reactivate are Platform-Super-Admin-only (`PlatformAdminGuard` class-level on `AdminPanelController`, plus `OrganisationSuspensionService`'s own `PlatformAdminService.isPlatformAdmin` recheck — CLAUDE.md's "layer 2 is the one people skip"), gated by step-up reauth (`StepUpReauthService.assertCurrentPassword` — a hijacked-but-live admin session alone cannot suspend a tenant) AND an explicit confirmation beyond the password: the caller must echo the target organisation's own `slug`, verified server-side against the real row (`SuspendOrganisationDto.confirmSlug`), never a bare boolean a UI could send without the admin having seen which tenant this is.

Mitigation, cross-tenant correctness: `core.organisation` carries its own RLS policy (`organisation_self`, `id = core.current_org()`) despite having no `organisation_id` column — discovered mid-implementation via `\d core.organisation` and NOT documented in the entity's own prior doc comment (fixed). A platform admin suspending someone else's org is not that org's member, so `OrganisationSuspensionService` deliberately binds `rab.organisation_id` to the TARGET organisation (never the actor's own) for every suspend/reactivate/status read — this also correctly lands the audit entry under the target's own audit trail rather than tripping `AuditService`'s cross-tenant existence check (see below).

Mitigation, session invalidation and the reactivation gap: `suspend()` bumps `Organisation.securityVersion` (reused `SecurityVersionService.bumpOrganisation`, under `core.enforce_organisation_security_version_monotonic()`'s existing +1-only trigger) — this busts every cached `AuthContextCacheService` key for that org, forcing a fresh `AuthSecuritySnapshotService` read on the very next request, which the new `organisationSuspended` snapshot field and `OrganisationSuspendedGuard` (same pattern as `MaintenanceModeGuard`) then denies. `AuthService.completeLogin()` and `RefreshTokenService.rotate()` carry their own direct `suspended_at` checks for the pre-guard login/refresh paths. Critically, `suspend()` ALSO calls a new `RefreshTokenService.revokeAllForOrganisation()` (genuinely sets `revoked_at`, not just a block-while-suspended check) — without this, a refresh token issued before suspension would silently start working again the moment `suspended_at` is cleared on reactivation, since nothing else would have marked it revoked. This is what makes "reactivation restores eligibility without restoring revoked sessions" true rather than aspirational. Platform admins are exempt from the login/API block (their own organisation is never suspended) so Crewflow staff can still investigate/reactivate a suspended tenant.

Mitigation, background jobs and onboarding: `NotificationService.notify()` — the single choke point for in-app/email/push across every worker job — silently no-ops for a suspended organisation rather than throwing (throwing would roll back the caller's own unrelated business-state write). `AccountLifecycleService.sendAccountInvite()` (every Staff/Internal-Manager/Venue-Manager invite and resend) and `AuthService.activateAccount()` (token redemption) both reject new invite creation/acceptance for a suspended org, while leaving existing pending `AccountInvite` rows and their normal expiry completely untouched. The realtime SSE gateway (`realtime-gateway.controller.ts`) needed no change — it already compares `organisationVersion` on every heartbeat, so `bumpOrganisation()` alone disconnects a live SSE connection on its next tick.

Mitigation, data preservation: no hard DELETE anywhere in this feature — `suspendedAt`/`suspendedBy`/`suspendedReason`/`reactivatedAt`/`reactivatedBy` are additive nullable columns (`OrganisationSuspension1786702000000`), enforced consistent in pairs by a DB CHECK constraint. Every organisation/workspace/staff/shift/payroll/attendance/notification/audit record is untouched by suspend or reactivate.

Three real defects were found and fixed while building this, every one via actually running the integration suite rather than trusting `tsc --noEmit` alone — none of these were caught by typechecking, because none is a type error:

1. `StepUpReauthService.assertCurrentPassword` (added earlier this session for platform-admin grant/revoke and user deletion) read `password_hash` via a plain ORM `findOne`, which `RevokeUserPasswordHashSelectFromApp1786669800000` had already, deliberately, made impossible for the runtime role — every real call was 500ing with "permission denied for table user." Fixed with a narrow SECURITY DEFINER lookup function (`core.auth_find_password_hash_by_user_id`, `AuthFindPasswordHashByUserId1786703000000`), same precedent as `auth_find_users_by_email`.
2. `AuditService.assertRecordedIdentitiesExist`'s cross-tenant existence check ran RLS-scoped to whichever single org the calling transaction had bound, which made every genuinely cross-org platform-admin grant/revoke 500 ("do not resolve to an existing core.user row") the moment actor and target belonged to different organisations — fixed with its own SECURITY DEFINER function (`core.audit_existing_user_ids`, `AuditUserIdsExist1786704000000`), deliberately NOT RLS-scoped since its actual job (per its own doc comment) is "catch a fabricated id," not "catch an out-of-tenant id."
3. `AuthService.completeLogin()`'s own suspension check — written earlier in THIS task, before the integration suite below existed — ran `this.dataSource.query('SELECT suspended_at FROM core.organisation ...')` on the raw, unbound connection pool. With no `rab.organisation_id` GUC set, `organisation_self`'s RLS policy silently returned zero rows; the check never fired, and a suspended organisation's users could still log in normally. Confirmed live by the first real run of `organisation-suspension.integration.spec.ts`. Fixed the same way as the other two: `core.organisation_is_suspended`, `OrganisationIsSuspended1786705000000`.

A fourth issue was a genuine concurrency bug, not a permissions one: `suspend()`/`reactivate()` originally read `org.suspendedAt` and then issued a separate `UPDATE` — two simultaneous suspend calls for the same organisation both passed that read (neither had committed yet under READ COMMITTED), so both proceeded to write a second audit row. Fixed by making the `UPDATE` itself the compare-and-swap (`WHERE suspended_at IS NULL`/`IS NOT NULL`), checking the affected row count rather than a separately-read snapshot — the same CAS idiom `RefreshTokenService.revokeFamily`/`revokeAllForUser` already use elsewhere in this codebase. Caught by this task's own new concurrent-suspension test, not inferred.

Regressions: new `organisation-suspension.integration.spec.ts` (12/12) covers authorization (non-admin 403, wrong password 403, wrong confirmSlug 403, correct path succeeds), session invalidation (a live access token and a live refresh token both rejected on the very next use after suspension), a fresh login attempt against a suspended org (401), platform-admin bypass, cross-organisation isolation (suspending A never touches B), concurrent suspension (two simultaneous calls, exactly one audit entry, no crash), and reactivation (eligibility restored via fresh login, but a refresh token issued before suspension stays dead afterward; reactivating an already-active org is a no-op). `p1d-security-versions.integration.spec.ts`, `settings-abuse-cases.integration.spec.ts` and `user-deletion-abuse-cases.integration.spec.ts` (44/44) re-confirm the unrelated-but-blocking fixes above didn't regress existing platform-admin/step-up-reauth/user-deletion behaviour.

## P2.9A — Secure Super Admin bootstrap, email-only (2026-10-11)

Threat: a hardcoded or env-var-configured initial administrator password is a durable, often-forgotten secret sitting in deploy config (Render dashboard, infra-as-code, CI logs) long after the one moment it's needed — exactly the shape of credential most likely to leak via a misconfigured log, a shared screenshot, or a departing operator's local `.env` copy. The previous `BootstrapAdminCommand` (`BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD`, both required together) created the first Platform Admin as `ACTIVE` with that password hashed in directly — functionally safe (real argon2id, never compared against a login attempt in code) but exactly the pattern the owner's P2.9A spec explicitly forbids: "Do not configure an initial administrator password in environment variables."

Mitigation: `BootstrapAdminCommand` now reads ONLY `BOOTSTRAP_ADMIN_EMAIL`. A brand-new admin account is created `INVITED`, with `password_hash` left `NULL` — structurally unable to authenticate (`AuthService.login()`'s own `ACTIVE || (INVITED && passwordHash !== null)` gate rejects it) — and is routed through the EXACT SAME invitation-token/`/auth/activate-account` mechanism every Staff/Manager/Venue-Manager invite already uses (`AccountInviteService.prepare`/`commit`, durable `EmailOutboxService.enqueue`, single-use atomic token consumption). No new activation mechanism, no new email queue. The only new piece is `AccountLifecycleService.sendAccountInvite()` gaining an optional `templateRenderer`/`actorUserId` override so this system-driven (no human actor) send can use a Super-Admin-specific subject line and attribute its audit/outbox rows to `null` rather than a nonexistent caller — every existing call site's behaviour is unchanged (both override params default to the original behaviour). A leftover `BOOTSTRAP_ADMIN_PASSWORD` in deploy config is detected and logged as a warning (never applied, never fatal) rather than silently ignored without a trace or treated as a hard boot failure.

Idempotency/no-duplication is unchanged from the previous implementation: a transaction-scoped Postgres advisory lock held for the whole check-then-act block, keyed on `core.platform_admin`'s row count. This also satisfies "permanently disable the initial bootstrap path after completion" — the condition this command checks can never become false again once satisfied, with no separate flag to maintain or to drift out of sync.

MFA/step-up integration point (owner's explicit requirement — not implemented, since no first-login MFA policy exists anywhere in this codebase yet): the correct hook for a future "require MFA before a Platform Admin's first login" policy is inside `AuthService.completeLogin()`, in the SAME block that already reads `isPlatformAdmin` (right before `applicationAllowed()` is evaluated) — this is the one place every login provider (password, Google, Microsoft) converges, already has `isPlatformAdmin` resolved, and already throws `UnauthorizedException` for the structurally identical organisation-suspension check beside it. No code was added for this; documented here per the owner's own instruction to "preserve a secure integration point and document the remaining requirement" rather than invent a bypass or a placeholder.

No privileged database-login account was created as a substitute for the application-level Super Admin role — `core.platform_admin` remains the sole mechanism, unchanged; no new Postgres role of any kind was added by this checkpoint.

Found and fixed while building this (not a type error — only surfaced by running the real test suite): a genuine PostgreSQL behaviour where `core.audit_log`'s `organisation_id` FK `ON DELETE CASCADE` from `core.organisation` unconditionally runs an internal `DELETE FROM ONLY audit_log` statement that fails with "permission denied for table audit_log" even for the Postgres superuser used in this dev environment, regardless of whether any row actually matches — reproduced directly via `psql`, unrelated to anything this checkpoint changed (CLAUDE.md's "no hard DELETE" rule means no production code path ever deletes an `organisation` row, so this never surfaces outside test cleanup). Worked around in the test's own fixture teardown only; not something application code needed to change.

Regressions: rewrote `bootstrap-admin.integration.spec.ts` (9/9) for the new email-only flow — fresh install, restart idempotency, existing-admin blocks a second bootstrap, email unset is a no-op, a leftover `BOOTSTRAP_ADMIN_PASSWORD` is ignored-with-warning, the pending admin cannot authenticate until activation, an email matching an already-active user is granted directly with no invite sent, concurrent overlapping boots produce exactly one admin, and email canonicalisation/uniqueness. Re-ran `account-invite-abuse-cases.integration.spec.ts`, `account-lifecycle-abuse-cases.integration.spec.ts` and `bootstrap-cli-platform-admin.integration.spec.ts` (46/46) to confirm the `sendAccountInvite()` signature extension didn't change behaviour for any existing Staff/Manager/Venue-Manager caller.

## P2.9B — Organisation + CEO invitation (2026-10-11)

Threat: a Platform Super Admin creating a new tenant and its first CEO is a genuinely cross-tenant action (the admin belongs to no organisation the new one yet), and any mechanism built for it is a natural place to either (a) silently widen who can create a CEO/organisation, (b) let client-supplied identity leak into the new tenant's authoritative role/org binding, or (c) weaken RLS broadly to make the cross-tenant write "just work."

Mitigation, authorization: every new `OrganisationOnboardingService` method re-checks `PlatformAdminService.isPlatformAdmin` itself (CLAUDE.md's "layer 2 is the one people skip"), beneath the existing `PlatformAdminGuard` at the route layer (`OrganisationOnboardingController`). CEO creation itself is NOT reimplemented — `ManagerService.createWithin()` already owns user/role/membership/profile/invite/audit for every manager type, including its own pre-existing `type === 'ceo'` platform-admin check (`CeoCreationGuard` at the HTTP layer, `assertCeoMutationAllowed`/an inline check in `createWithin` at the service layer) — confirmed by reading the code, not assumed, and confirmed STILL closed by this checkpoint's own regression run of `ceo-role-abuse-cases.integration.spec.ts` (an ordinary `MANAGER_MANAGE` holder, including an existing CEO, still cannot create or mutate a CEO account via the generic route).

Mitigation, no client-trusted identity: `CreateOrganisationDto` has no `organisationId`/`role` field at all (`forbidNonWhitelisted` 400s any attempt to supply one) — the new organisation's id is always server-generated (`core.create_organisation()`), and the CEO's role is always fixed to `'ceo'` by `OrganisationOnboardingService` itself, never read from the request. Acceptance reuses the EXISTING, unmodified `/auth/activate-account` endpoint verbatim — it already resolves organisation/role/identity purely from the stored `AccountInvite`→`User` row via a pre-auth SECURITY DEFINER lookup, never from anything client-supplied, and already correctly routes a platform-admin-but-zero-roles identity (and, by the same logic, a CEO) to `manager_web` rather than guessing (confirmed by reading `activateAccount()`'s own `isPlatformAdminTx` check before its `defaultApplication()` fallback). No second activation mechanism, no second email queue.

Mitigation, the RLS bootstrap problem: `core.organisation`'s `organisation_self` policy (`id = current_org()`) cannot be satisfied by any ordinary INSERT — a brand-new row's id can never already equal a bound `current_org()`, and no runtime code path had ever needed to insert this table before this checkpoint (every prior insert ran via a CLI command on the `rab_owner` superuser connection). Fixed the same way as every other pre-auth/cross-tenant write in this codebase: a single narrow SECURITY DEFINER function (`core.create_organisation`), owned by `rab_secure_owner`, taking only `name`/`slug`. Once the row exists, every subsequent write (CEO user, role, invite, audit) runs through the completely ordinary `runInTenantContext`/RLS-enforced path, bound to the new organisation's own id.

Three real, confirmed defects were found and fixed while building/testing this (none were type errors):

1. `core.manager_profile`'s own RLS policy requires the acting session to already be a member of the TARGET organisation (own row, same workspace, or `manager.manage` permission in that org) — which a Platform Super Admin creating a BRAND NEW organisation's first CEO structurally cannot be. The `WITH CHECK` happened to pass (a CEO's `workspace_id` is always NULL, satisfying one branch), but `ManagerService.createWithin()`'s `manager.insert(...)` implicitly asks for the row back (`RETURNING`), which Postgres enforces against the table's SELECT/USING policy — and that policy had no platform-admin exemption at all. Fixed by adding `core.is_active_platform_admin(core.current_uid())` to the policy (`ManagerProfilePlatformAdminRls1786708000000`).
2. That first fix was itself wrong on the first attempt: the new branch was nested INSIDE the existing `organisation_id = current_org() AND (...)` clause, so it remained gated by `current_org()` being bound — which a genuinely cross-tenant read (`listOrganisations()`, spanning every organisation) can never satisfy. `null AND true` is `null`, not `true`. Confirmed directly via `psql` before and after. Fixed by hoisting the platform-admin check to the TOP level, OR'd with the entire previous expression (`ManagerProfilePlatformAdminRlsFix1786711000000`) — the same shape `applicationAllowed()`'s own `if (platformAdmin) return true` already uses elsewhere in this codebase.
3. The new `core.list_organisations_for_admin()` SECURITY DEFINER function (needed because a platform-wide organisation list is, like organisation creation, structurally cross-tenant) is owned by `rab_secure_owner`, which turned out to hold NO grants at all on `core.manager_profile`, `core.user_role`, `core.role_permission` or `core.permission` — a SECURITY DEFINER function's privileges come from its owner's actual GRANTs, not merely from being SECURITY DEFINER, and `rab_secure_owner` had never needed to read any of these four tables before this function existed. Fixed with narrow, SELECT-only grants (`SecureOwnerManagerProfileSelectGrant1786709000000`, `SecureOwnerRolePermissionSelectGrant1786710000000`) — never write access, never broader than what this one function's join actually needs.

None of these three fixes grants `rab_secure_owner` `BYPASSRLS` (considered and explicitly rejected — CLAUDE.md: never weaken RLS broadly to solve one narrow case) or widens what an ORDINARY, non-platform-admin caller can see or do on `manager_profile`: every pre-existing branch of that table's policy is preserved byte-for-byte, confirmed by the full existing `ceo-role-abuse-cases`/`manager-profile-isolation`/`manager-venue-workspace-binding`/`manager-workspace-abuse-cases`/`manager-workspace-onboarding`/`venue-manager-creation`/`venue-manager-scoping`/`venue-manager-staff-composite-fk` regression suite (109/109) passing unchanged.

Regressions: new `organisation-onboarding.integration.spec.ts` (9/9) covers authorization (non-admin 403 on create/list/get/resend/revoke), creation (organisation + CEO user/role/invite/CEO-specific email subject, all verified directly against the database), duplicate-name slug collision avoidance, list/get reflecting the new organisation and its CEO, the full acceptance loop via the unmodified `/auth/activate-account` endpoint (activate → log in → correct role/`manager_web` target), resend (sendNumber advances) and revoke (password cleared), and compatibility with P2.8 (a suspended organisation rejects a CEO invite resend). The 109-test manager/CEO/venue-manager regression suite above re-confirms the `manager_profile` RLS change is additive only.

## P2.9C — Initial Manager invitation, invite-time workspace provisioning (2026-10-11)

Threat: the same class of cross-tenant-write problem P2.9B solved for `core.organisation`/`core.manager_profile` recurs for a THIRD table, `core.manager_workspace` — a Platform Super Admin or a CEO inviting a Manager who does not yet exist, and creating a private workspace OWNED BY that not-yet-active person, is structurally the same "actor ≠ the row's own owner" shape every one of this checkpoint's RLS fixes addresses.

Mitigation, authorization: two authorized actor types, not one — a Platform Admin (any organisation, via `OrganisationOnboardingController`) or the organisation's own CEO (their own organisation only, via `ManagerController`'s `initial-manager-invite` routes, where `organisationId` is always read from the CALLER's own session, never a client-supplied value). `OrganisationOnboardingService.assertActorCanManageOrganisation` is the actual (service-layer) gate for both paths — the CEO-side HTTP route's own guard (`PermissionGuard(MANAGER_MANAGE)`) is deliberately loose (any Manager holding that flag could reach the route), so an ordinary non-CEO Manager reaching it still gets rejected at the service layer (confirmed by a dedicated test). "Check the existing initial-manager condition" (owner's requirement 2) is enforced as: an organisation may receive exactly one Initial Manager invitation — once it has ANY Internal Manager profile at all, the route returns 409 and the CEO/admin is expected to use the unmodified, existing `POST /managers` (Add Manager) flow for every subsequent Manager, per the owner's own rule.

Mitigation, the approved direction (invite-time provisioning, not self-service): per the owner's explicit confirmation ("the previously selected product direction is invite-time workspace details and automatic provisioning after acceptance... do not silently change that direction back to Manager self-service"), the CEO/Super Admin names the workspace (`workspaceName`/`subdomain`) AT INVITE TIME, and `ManagerWorkspaceService.create()` was refactored into a reusable `createFor(manager, ctx, {ownerUserId, name, subdomain})` so the SAME subdomain-validation/uniqueness/membership-binding logic that already existed for self-service now also runs, atomically, inside the SAME transaction as the user/role/invite/email, with `ownerUserId` correctly separated from the ACTING caller (`ctx.userId`, used only for audit attribution) for the first time — the original method had always conflated "who is calling" with "who owns the workspace," which was only ever safe because self-service made them identical. The isolated Workspace Provisioner itself is untouched: a `ManagerWorkspace` row written `schemaStatus: 'CREATING'` is picked up by the SAME existing Worker job (`workspace-provisioning.job.ts`) regardless of whether the row was created via self-service or via this new invite path.

Mitigation, visibility: `ManagerWorkspaceResponse`/`getMine()`/the Redis entity-cache projection never exposed `schemaStatus` at all before this checkpoint — a genuine, confirmed gap, since nothing could ever answer "is this workspace ready yet" without it. Added as a new, additive field (every existing field and every existing caller unchanged); the cached code path relies on this service's ALREADY-EXISTING write-path invalidation contract (confirmed via that cache's own extensive doc comment: TTL is a hygiene backstop, not the correctness mechanism, for every field already cached there).

Two real, confirmed defects were found and fixed while building this (both via running tests, not type-checking — the same pattern as every other defect this checkpoint found):

1. `core.manager_workspace`'s `manager_workspace_write` policy (`FOR ALL`) was strictly `owner_user_id = current_uid()` — correct for self-service (caller always creates their own row) but structurally impossible for an invite, where the actor and the new owner are different people. Confirmed live: both the Super-Admin-side and the CEO-side integration tests failed with "new row violates row-level security policy for table manager_workspace" before the fix.
2. Fixed by OR-ing in two exemptions at the TOP level (same hoisted shape P2.9B's `manager_profile` fix already established, learned from that exact mistake the first time — never nested inside an existing `AND`): `core.is_active_platform_admin(core.current_uid())` for the Super-Admin path, and an EXISTS check for `manager.manage` held specifically IN THIS organisation (`ur.organisation_id = manager_workspace.organisation_id`, explicitly scoped — never "holds it anywhere") for the CEO path. `owner_user_id = current_uid()` is completely unchanged.

This widening was deliberately considered, not assumed safe: `manager_workspace_write` is a `FOR ALL` policy, so its `USING` clause also contributes to SELECT visibility via OR-combination with the separate `manager_workspace_member` SELECT policy — meaning this change also lets a CEO (or platform admin) SELECT every manager workspace row within their own organisation, not only write them. This table's RLS has its own documented history of a real, previously-fixed global enumeration vulnerability (`ManagerWorkspaceRls1786667900000`, referenced in `manager-workspace-abuse-cases.integration.spec.ts`'s own doc comment) — re-examined directly: the widening here is scoped to "a CEO can see their own organisation's manager workspaces" (a reasonable, expected administrative capability, not a reopened global leak) and "a platform admin can see any workspace" (already the most privileged role in the system). The suite's own dedicated enumeration test ("Manager A can read Workspace A directly; cannot SELECT Workspace B by id; cannot enumerate it through a list query") was re-run and still passes unchanged — an ORDINARY Manager with no `manager.manage` grant in the target org gains nothing.

Regressions: new `initial-manager-invitation.integration.spec.ts` (9/9) — Super-Admin-side creation (user/profile/workspace/invite/email, `ManagerProfile.workspaceId` correctly bound), the one-Initial-Manager-per-organisation rule (409 on a second attempt), subdomain collision handling with alternatives and no partial writes, resend/revoke, CEO-side creation within their own organisation, an ordinary non-CEO Manager rejected, a CEO rejected on the Super-Admin-side route for a DIFFERENT organisation, the full activate→login→`GET /manager-workspaces/me` loop confirming `schemaStatus` is now visible, and P2.8 suspension compatibility. The 148-test full manager/workspace/CEO/organisation regression suite (including the corrected, intentionally-widened pinned-policy assertion in `manager-workspace-abuse-cases.integration.spec.ts`) passes in full.

## CEO / Platform Super Admin — own workspace as operational home (2026-10-13)

Threat: granting a CEO (including a Platform Super Admin's CEO identity) operational membership could become a way to reach another Manager's workspace in the same organisation, override an existing operational assignment, or let Platform Admin status alone confer tenant-data access.

Context: `ManagerWorkspaceService.createFor` bound membership only for `type: 'internal'`; a CEO's self-created workspace was "inert". A Platform Super Admin with a CEO profile therefore owned a READY workspace they could not use — every workspace-scoped endpoint (`/staff`, `/venues`, `/shifts`, `/offers`, `/job-roles`, `/attendance`) correctly returned 404 via `WorkspaceRoutingError('missing-context')`. Owner decision (2026-10-13): own workspace becomes the operational home.

Mitigation: `ceoClaimsOwnWorkspaceAsHome` binds ONLY when all hold — profile `type = 'ceo'`; self-service (actor === owner; invite-time creation for someone else never binds); the profile is not already bound; and the user holds NO active `workspace_membership`. The workspace id is the one the server just created, never client input. Existing assignments are never overridden (also backstopped by `workspace_membership_one_active_per_user`). Platform Admin status is not consulted. Membership still writes through `WorkspaceMembershipService.assignOwnWorkspace` under the RLS insert predicate; Venue Managers keep the inert behaviour. No RLS policy, grant or guard changed.

Data change: the owner's existing READY workspace (created under the old rule) was bound once, in a single transaction that re-checked every condition above and wrote a `manager_workspace.updated` audit entry (`fields: ['operational_home']`).

Regressions: new `ceo-own-workspace-operational-home.integration.spec.ts` (3/3) — Super-Admin CEO bound to own workspace; existing assignment not overridden (new workspace stays inert); binding never grants another Manager's workspace. Existing `manager-workspace-abuse-cases`, `manager-workspace-onboarding`, `initial-manager-invitation`, `ceo-role-abuse-cases`, `workspace-membership-abuse-cases` pass unchanged (76/76 together).

## Email-first member invitations — Settings → Members → Invite (2026-10-14)

Threat: an administrator-facing "invite by email" flow is an account-creation primitive. The risks are (a) a pending invitation becoming an identity before its recipient proves control of the address; (b) a token that can be guessed, replayed, used after resend/revoke/expiry, or redeemed twice; (c) an inviter assigning a role above their authority, or into a workspace or organisation that is not theirs; (d) one Manager seeing or acting on another Manager's invitations in the same organisation; (e) the public redemption endpoint becoming an account-existence or token-state oracle; (f) the email worker delivering a stale link, or the long-standing "missing target user ⇒ cancel" safeguard being weakened to let target-less emails through; (g) Redis becoming a hang point or an authority.

Mitigations:
- **Intent, not identity.** `core.member_invitation` (MemberInvitationSchema1786715000000) stores organisation, the inviter's workspace UUID (mandatory), normalised email, a `role_id`, inviter, token hash and lifecycle timestamps. No `core.user`, role assignment or membership exists until acceptance; no placeholder names, no NOT NULL relaxation. **Revised 2026-10-14 (owner directive "exact role and access rules"):** only CUSTOM workspace-member roles are invitable — recruitment Staff, Venue Managers, Managers and leadership are never invited here (their Users-page / onboarding flows are unchanged). The composite FK `(role_id, workspace_id) → role(id, workspace_id)` makes any other role, or another workspace's role, unrepresentable.
- **Database-enforced invariants.** Partial unique index: one live invitation per organisation + email (concurrent duplicate sends cannot both win). `token_hash` UNIQUE, SHA-256 of 32 random bytes; the raw token exists only in the email. Terminal states (accepted / revoked / superseded) mutually exclusive; `send_count` 1–3; normalised-email CHECK. Runtime role has no DELETE.
- **RLS tighter than organisation.** Policy = organisation AND workspace = current_workspace(). Another Manager's invitations in the same organisation are invisible; out-of-scope ids return 404.
- **Authority re-derived from PostgreSQL in every transaction** (layer 2), independent of `PermissionGuard(ROLE_MANAGE)`: the caller must hold ROLE_MANAGE, OWN the workspace and have an active membership of it; the role must pass `MemberRolePolicyService` (custom, same workspace, member-safe permissions only, every permission held by the caller). Platform Admin status alone grants nothing. Resend re-checks the role against the caller (Twenty does not). No organisationId / workspaceId / managerId / names accepted (`forbidNonWhitelisted` 400).
- **Atomic, single-use acceptance.** Public `POST /rest/v1/invitations/accept` hashes the token, resolves routing ids through `core.auth_find_member_invitation` (SECURITY DEFINER, pinned search_path, PUBLIC revoked, returns ids only), then — under the invitation's own workspace context — locks the row `FOR UPDATE`, re-checks live/unexpired (DB clock), organisation not suspended, workspace active, no existing account for the email, and the INVITER's authority now (active, still owns the workspace with an active membership, still holds ROLE_MANAGE, and can still grant the role — re-checked, not trusted from send time). It then creates exactly: the user (recipient's own name + argon2id password), the one custom role, organisation membership and membership of the inviter's workspace — no staff/manager profile, never a new workspace; the one-active-membership index and (organisation, email) uniqueness are the backstops. A compare-and-set marks it accepted in the same transaction. Two simultaneous acceptances: one 200, one generic 400. Any re-check failure ⇒ invitation SUPERSEDED (committed), recipient sees the generic failure.
- **No oracle.** Unknown, expired, revoked, superseded, consumed, suspended-organisation and malformed tokens all return the same 400 message. No session is issued; the account stays INVITED (password set, email verified by token possession) and becomes ACTIVE through the unchanged login path, so suspension, application-target and session rules all still apply.
- **Worker.** New job type `MEMBER_INVITATION` is the only one allowed to lack `target_user_id`; a CHECK makes it inseparable from `member_invitation_id`. It is revalidated before delivery: invitation live, unexpired, same workspace as enqueued, this outbox row is the latest for the invitation (older links never delivered after a resend), organisation not suspended. Every other job type still goes through the untouched missing-target-user check. Delivery idempotency and fencing unchanged.
- **Redis, bounded and fail-closed.** `InvitationRateLimitService` runs one atomic multi-bucket token-bucket Lua script (Redis clock, deny-all-or-debit-all) on the bounded auth-cache client (150 ms command timeout, no offline queue). Buckets: recipient (hashed email, global), actor, organisation, redemption per IP. Keys `crewflow:{env}:invite-rate:{scope}:{sha256}` — no addresses in Redis. Any Redis failure ⇒ 503, never "unlimited", never a hang. Listing never touches Redis. Redis confers no authority.

SECURITY TRADE-OFF (recorded, unchanged from account invitations):
- Decision: `member_invitation` is RLS-ENABLED but not FORCEd, owned by `rab_secure_owner`, and added to `NOT_FORCED_ALLOWLIST`.
- Reason: the public acceptance endpoint must resolve organisation/workspace from a bare token before any tenant context exists, via a SECURITY DEFINER function running as the owner; FORCE would hide every row from it.
- Risk: only the NOLOGIN owner is exempt from the policy. `crewflow_app` remains fully bound.
- Mitigation: the function returns only ids; all validity checks run under RLS afterwards.
- Reversal: replace with a token-hash-scoped policy branch if the allowlist is ever retired.

SECURITY TRADE-OFF (recorded, parity with account invitations):
- Decision: the rendered invitation email (containing the raw link) is stored in `email_outbox.rendered_html/text` in plaintext until sent, and the LOGGER email driver prints bodies.
- Reason: identical to the existing account-invitation pipeline; encrypting outbox bodies is a cross-cutting change outside this feature.
- Risk: database or log readers could see live links within their 24-hour validity.
- Mitigation: single use, 24-hour expiry, rotated on resend, revoked links rejected; LOGGER is a development driver.
- Reversal: encrypt rendered bodies with `SecretEncryptionService` for all invitation job types.

### Custom workspace-member roles and member access (2026-10-14, owner-approved)

Threat: custom roles are a privilege-assignment primitive. Risks: (h) a role named "Manager"/"Admin" inheriting a privileged system key and with it full application access or venue scoping; (i) a Manager granting a role more than they hold, or leadership / role-management / user-management / recruitment-Staff flags; (j) a Manager changing an organisation-wide system role for everyone; (k) Manager B seeing, editing or assigning Manager A's roles; (l) a member escaping creator-based ownership (seeing another Manager's Staff/Venues/Shifts) or writing records that end up mis-owned; (m) a member reaching any application other than the web console, or keeping access after their membership ends.

Mitigations (WorkspaceMemberRoles1786714500000 + services):
- **Unforgeable member-role identity.** Custom role keys are always `custom_…`; `role_member_key` CHECK: prefix ⇔ workspace-bound; system roles can't be workspace-bound; `role_identity_immutable` forbids moving or re-keying a role. Authentication recognises a member role only by that prefix (`application-access.ts`): `manager_web` only, never widening a Staff/Venue Manager identity, and `memberWithoutWorkspace` refuses a member with no active membership at login, refresh and every request.
- **Per-workspace roles.** `role.workspace_id` + RLS (system roles, or custom roles of `current_workspace()`); `role_permission`/`user_role` writes require a visible role. Other workspaces' roles are 404.
- **No escalation, member-safe flags only.** `MemberRolePolicyService`: permissions ⊆ `MEMBER_ROLE_ALLOWED_PERMISSIONS` (`staff.view`, `venue.view`, `schedule.view`) AND ⊆ the actor's own permissions, at create, edit, invite, resend and acceptance. Database backstop: `role_permission_member_allowlist` trigger. This also keeps `manager.manage` (honoured by `manager_workspace_write`) off member roles.
- **System roles read-only** via the API (organisation-wide effect). `role.view`/`role.manage` granted to the system `manager` and `ceo` roles (owner decision), version-bumped.
- **Creator-based ownership preserved.** A pure member's `ResourceScope` is `owner` with `ownerUserId = workspace owner`, `delegated: true`; only read paths (Staff list/get, Venue list/get, Shift list/get, Job roles list) accept it, each keeping its original check plus one delegated branch; no org-wide pending-approval widening for members. Every write path still checks `created_by = ctx.userId`. RLS layer: `staff_profile_member_select` via `core.member_holds_workspace_permission` (SECURITY INVOKER) — requires an active membership AND a non-system role bound to that same workspace granting `staff.view`, so Venue Managers/Staff never satisfy it. Member writes are impossible (no write flags on member roles).
- **Team** lists `workspace_membership` rows of the caller's workspace — owner-only (`workspace_membership_owner_select` + service check) — excluding recruitment Staff and Venue Managers.

Assumptions flagged (CLAUDE.md "never invent a business rule silently"): the member-safe allowlist is read-only (`staff.view`, `venue.view`, `schedule.view`) until an owner decides how member-created records are attributed; only the workspace OWNER administers invitations and Team; legacy organisation-level custom roles (no `custom_` key) are read-only and not invitable.

Not covered yet (fail closed): the per-workspace HWS schema template has no member branch on `staff_profile` (members see no staff there); dashboard, search, attendance, payroll and offers filter by `ctx.userId` (members see nothing); removing a member from a workspace has no UI/API action yet.

Regressions: `member-invitation.integration.spec.ts` (35/35, server — roles, invite authority, sending, acceptance, member access, Team, Add/leadership denial, RLS, Redis) and `member-invitation-delivery.integration.spec.ts` (9/9, worker) on a disposable PostgreSQL 16 database; `application-access.spec.ts`; `check-rls-coverage` OK; frontend `MembersPage.spec.tsx` and `AcceptInvitation.spec.tsx`.

Not changed: leadership onboarding (CEO, Initial Manager) still creates the account at invite time with inviter-supplied names — moving it email-first is an owner decision (it changes the CEO/Initial Manager slot and replacement lifecycle). The Initial Manager has Invite but never Add (server: `PermissionGuard(MANAGER_MANAGE)` + `assertActorCanManageOrganisation`; `PlatformAdminGuard` on admin routes).

### Object, field and record-level permissions for custom member roles (2026-10-14)

Threat: the role editor lets a workspace owner restrict which Staff / Venue / Shift records and which fields a member can read. Risks: (n) a "restriction" enforced only in the UI, so the API, search, counts or another read path still return the hidden data; (o) a record filter becoming an injection vector or an oracle (user-controlled field names, operators or values reaching SQL text; filtering, searching or sorting on a hidden field to infer its value); (p) an invalid, tampered or stale stored filter widening access instead of denying it; (q) escalation through fields (revealing phone, address or pay data the editor cannot see) or through assignment (handing out a role that reveals more than the assigner holds); (r) stale cached permissions after a role or membership change; (s) a partially applied save leaving a role half-changed; (t) cross-workspace reference through relation ids in filters; (u) Team actions (role change, suspend) reaching the owner, leadership, Staff, Venue Managers or another workspace's members.

Mitigations (RoleObjectFieldPermissions1786716000000 + services):
- **Server-owned registry** (`member-object-registry.ts`) is the only source of object keys, field keys, response properties, filterable columns and operators. Client strings are looked up, never used as identifiers. Only objects with a real delegated read path are listed (Staff, Venues, Shifts). Edit, Delete and Destroy are reported as unsupported, never as fake toggles.
- **One enforcement point per read path, in the service (layer 2).** `MemberAccessPolicyService.resolveTx` is read fresh from PostgreSQL in the request transaction and is a no-op for everyone except pure custom members.
  - Staff list and get, Venue list and get, Shift list and get, job roles, requested staff, dashboard counts and global search all apply object read, the record filter (ANDed onto the unchanged owner/workspace scope) and whitelist projection.
  - A record outside the filter is a 404. A denied object is a 403 on lists and a 404 on details.
  - Hidden fields are never search targets, filter targets or sort keys.
  - Offers are never searched for members.
- **Whitelist projection.** A member response contains only base properties plus properties of visible fields; unknown or new properties are hidden by default. Sensitive fields default to hidden; locked identity fields cannot be hidden.
- **Filters are data, never SQL.**
  - Strict validation: allowlisted fields and operators, typed values (enum options, UUIDs, ISO dates, at most 100 characters of text), at most 20 conditions, at most one nested level, no extra properties.
  - SQL is generated only from registry column names with bound parameters (`CAST($n AS t)`).
  - Relation ids must exist in the actor's own workspace.
  - Database CHECK on the stored shape.
  - A stored filter that no longer validates compiles to `FALSE` (deny).
  - Multiple roles intersect (AND); a missing role denies.
- **No escalation.**
  - Effective object reads materialise into the existing route flags through `MemberRolePolicyService.assertGrantableTx`, which enforces the allowlist and that the actor holds each flag.
  - Revealing a sensitive field requires the editor to hold its authority (`staff.view_sensitive`, `payroll.view`, `venue.edit`).
  - The same field check runs at every assignment: invite, resend, acceptance and Team role change.
  - "Assignable to Workspace Members" off ⇒ 404 at assignment.
  - New roles start with nothing granted.
- **Atomic saves and version consistency.** Settings, object rows, field rows, flags and `role.permission_version` change in one transaction; a failed save changes nothing. Team role change and suspend/reinstate bump `user.security_version` (suspend also bumps the membership version inside the SECURITY DEFINER function), so cached auth snapshots are invalidated before the next request. No new cache was added.
- **G5:** `PermissionsService.userHasPermissionTx` and the auth snapshot now join `core.role`, so only RLS-visible roles contribute permissions; another workspace's custom role never counts.
- **Team actions** are owner-only. They re-check ROLE_MANAGE and ownership in the service and require the target to be an active or suspended member of this workspace who holds only custom roles. The owner, self, other workspaces → 404; leadership, Staff and Venue Managers → 409. The new role must pass `loadAssignableTx`. `organisationId` in a body is a 400.
- **Role deletion:** custom roles of this workspace only; refused (409 with counts) while any member holds it or any invitation references it; system roles 409; other workspaces 404; audited (`role.deleted`).
- **RLS:** `role_object_permission` and `role_field_permission` are ENABLE + FORCE with `organisation_id = current_org() AND workspace_id = current_workspace()` on USING and WITH CHECK. Composite FKs to `role(id, workspace_id)` make a grant on a system role impossible.

Regressions: `member-role-record-field-permissions.integration.spec.ts` (21/21) and `member-invitation.integration.spec.ts` with `p1d-security-versions.integration.spec.ts` (47/47), all on the disposable PostgreSQL 16 database; `check-rls-coverage` OK (47 tables); frontend `RoleEditor.spec.tsx` (7/7) and `MembersPage.spec.tsx` (18/18).

Not covered (fail closed): members still have no write paths. Invite-by-link and approved-domain joining are not implemented: no secure backend design exists yet, and both would weaken the invitation-controlled model.

**Repair addendum (2026-10-14, later).**
- **Legacy custom roles.**
  - **Threat:** roles created before the editor hold route flags but no object rules. Under the per-request policy their members would silently lose access, and the obvious "fix" would be to widen defaults.
  - **Mitigation:** `BackfillCustomRoleObjectRules1786717200000` adds exactly one `grant` rule per object whose `*.view` flag the role already holds. It binds each role's own organisation and workspace before inserting, so RLS WITH CHECK still applies.
  - **Scope:** it reveals no field, adds no filter and changes no flag. It is idempotent (ON CONFLICT DO NOTHING).
  - **Field visibility:** sensitive fields stay hidden for backfilled roles, as the least-privilege default.
- **Redis-cached path (gate J).** `member-role-redis-cache.integration.spec.ts` runs two API instances against one isolated Redis DB with both caches on (7/7):
  - role definition, Team role and suspension changes apply on the other warm instance on the next request;
  - logout survives a Redis flush;
  - a Redis outage fails over to PostgreSQL with enforcement intact;
  - concurrent reads cannot race past a revocation;
  - keys are per organisation, session and workspace, and contain no raw token.
- **Editor error states.** The editor no longer maps every failure to "deleted or no access".
  - A 404/400 (including another workspace's role) shows "Role not found".
  - A 401/403 shows "no access".
  - A 5xx or network failure is retryable.
  - None of these discloses whether a foreign role exists.

## Google / Microsoft sign-in, one-time login handoff and persistent web sessions (2026-10-14)

There was no entry for P1C.1B (OAuth) or the `crewflow_session` cookie before this one (audit F13). This entry covers the OAuth flow as it now stands. Details: `TWENTY_GOOGLE_AUTH_GAP_ANALYSIS.md` and `TWENTY_GOOGLE_AUTH_PARITY_REPORT.md`.

**Threats**
- (a) **Login CSRF / session swap:** an attacker makes a victim's browser finish the attacker's OAuth callback.
- (b) **Forged ID tokens:** a forged, replayed or mis-addressed ID token (signature, issuer, audience, nonce, PKCE, expiry).
- (c) **Unverified email at first link:** account takeover by first-linking an unverified email. This includes Microsoft "nOAuth", where any Entra tenant administrator asserts any address.
- (d) **Unauthorised entry:** a provider identity entering an account or workspace it is not authorised for: unknown, ambiguous, suspended, wrong organisation setting, membership ended mid-login.
- (e) **Credential leakage:** credentials in URLs, logs or Referer; replay or double redemption of the post-callback credential.
- (f) **Invitations:** a Google account accepting or burning someone else's invitation; joining a workspace without consent.
- (g) **Long-lived sessions:** longer theft windows.
- (h) **False logouts / account mixing:** transient failures logging users out, or responses being mixed across accounts.

**Mitigations**
- **Browser binding (F2).** `GET /auth/{provider}` sets HttpOnly `crewflow_oauth_tx` (SameSite=Lax, `/rest/v1/auth`, 10 min). Its SHA-256 is stored in `oauth_transaction_state.browser_binding_hash`. The state is consumed only by one atomic `UPDATE … WHERE browser_binding_hash = …`. A callback from another browser fails without burning the real attempt.
- **Unchanged OIDC validation.** `openid-client` checks the code exchange with PKCE S256, state, nonce, JWKS signature, iss, aud and exp. Google additionally requires `email_verified === true`.
- **Microsoft first link (F1).** Linking by email now requires `xms_edov === true`. An existing `tid:oid` link keeps working without it.
- **Identity resolution.**
  - The stable `(provider, subject)` link is used first.
  - Otherwise there must be exactly one eligible account with that email (`ACTIVE`, or `INVITED` with a password).
  - Users are never auto-created.
  - Linked accounts must be `ACTIVE` (or `INVITED` from a Google invitation acceptance); suspended or deactivated accounts get no session and no `USER_LOGIN` (F4).
  - The organisation provider flag is re-checked.
  - The first link is written inside the session transaction, after every access gate (F10). Link races roll back.
  - A different Google subject can never take over an already-linked account.
- **One-time handoff (`AUTH_OAUTH_HANDOFF_ENABLED`).**
  - The callback issues no session. It stores a 32-byte secret as SHA-256 on the same transaction row (5 min) and sends it only as HttpOnly `crewflow_oauth_handoff` (`/rest/v1/auth/oauth`). The redirect URL carries `handoff=1` and nothing else.
  - `POST /auth/oauth/complete` requires a trusted `Origin` (a missing one is refused).
  - The second-factor gate runs before consumption.
  - Redemption is a single conditional `UPDATE`, so concurrent or replayed redemptions get one session. The provider identity is erased from the row at redemption.
  - The account, status, provider flags, invitation and workspace membership are re-validated, and the resolved account must equal the one fixed at the callback.
  - Sessions are cookies only, never in the response body.
  - A session the browser already presented is revoked as superseded (F11).
  - PostgreSQL is authoritative. Redis is not used, so behaviour is atomic across replicas and unaffected by Redis outages.
- **Invitations with Google.** The invitation token travels in a form-POST body. The verified provider email must equal the invited email, and this is checked before anything can supersede the invitation. The user confirms "Join X as Y" before acceptance. Acceptance reuses the password path's transaction, inviter-authority and role re-checks, then creates only the invited membership and the provider link (no password).
- **Failures.** All failures return one generic message. The specific reason goes to the security log, plus a provider-tagged `login_history` failure row (F7). Discovery failures are not cached (F6).
- **Logout (F9).** Logout also revokes the authenticated session (`ctx.sessionId`). A mismatched refresh token still revokes nothing.
- **Transient failures (F5).** A non-auth failure while checking a session returns `503 AUTH_UNAVAILABLE`, not 401. The web app logs out only on 401/403. A network failure, 5xx or 429 shows reconnect/retry, and the 401 interceptor does not log out when identity could not be checked.

**SECURITY TRADE-OFF (owner decision 2026-10-14 — longer web sessions)**
- **Decision:** Manager, CEO and member sessions now last 180 days absolute and 30 days idle (was 24 h / 30 min), following Twenty's defaults. Platform administrators keep 24 h / 30 min on every target. Mobile workers are unchanged (90 d / 7 d).
- **Risk:** a stolen `crewflow_session` cookie, or an unattended signed-in shared office computer, stays usable for up to 30 idle days and 180 days in total, instead of 30 minutes and 24 hours.
- **Mitigations:**
  - HttpOnly opaque cookie, hashed at rest.
  - Origin-checked unsafe requests.
  - Server-side revocation on logout, password change, suspension and organisation suspension, plus "log out other devices".
  - Superseded-session revocation on re-login.
  - Sensitive actions (platform-admin grants, organisation suspension, user deletion) still require password step-up.
  - Platform administrators are excluded.
  - Cleanup retention was raised to 181 days (`WebSessionRetention1786717100000`) so reuse evidence outlives every session.
- **Reversal:** change `ABSOLUTE_SESSION_TTL_MS.manager_web` and `IDLE_SESSION_TIMEOUT_MS.manager_web` in `session-policy.ts`. Existing sessions keep their frozen absolute deadline, and the idle deadline re-evaluates on each bump.

**Not covered**
- No TOTP / second factor exists. The gate hook always answers "none", deliberately: no cosmetic screen.
- No workspace chooser (one active membership per user is a schema invariant).
- Password-provider toggles are still not enforced on `/auth/login` (F3, owner decision — mobile is password-only).
- `oauth_transaction_state` cleanup is still not scheduled in rab-worker (F8). Provider fields are nulled at redemption, but unredeemed rows keep them until cleanup.

**Regressions:** `google-oauth-handoff.integration.spec.ts` (23) and `google-oauth-legacy-mode.integration.spec.ts` (4), against a local mock OpenID provider (not real Google). Also updated: p1c1b, auth-abuse, session, retention specs; frontend `OAuthCallbackComplete.spec.tsx`, `AcceptInvitation.spec.tsx` and `SessionProvider.spec.tsx`; Playwright browser runs on the disposable stack.

## Organisation isolation: Initial Manager onboarding, platform-admin reach, ambiguous login (2026-10-15)

**Threat.** An identity holding authority in Organisation A creates, controls or reaches leadership accounts or data in Organisation B. The owner's new policy forbids this for Initial Manager onboarding, superseding P2.9C's "a platform admin may onboard any organisation".

**Found.**
- A platform admin could invite, resend, revoke and replace any organisation's Initial Manager. `assertActorCanManageOrganisation` returned early for any platform admin, and the `:organisationId` route parameter set the tenant.
- The RLS platform-admin branches on `manager_workspace` (not organisation-scoped at all) and on `manager_profile` gave a platform-admin identity database-level reach into every organisation.
- A password login could silently pick one of two accounts that share an email and password across organisations.

**Not found.** No cross-organisation data exposure or mutation by the Initial Manager. Their session always resolved their own organisation (`organisation-isolation.integration.spec.ts`, reproduced before the fix).

**Mitigation, by layer:**
1. **Routes.** The admin `:organisationId/initial-manager-invite*` routes are removed (404).
2. **Service.** `OrganisationOnboardingService.assertActorCanManageOwnInitialManager`:
   - takes no organisation parameter; the organisation is the actor's verified one;
   - re-reads the actor's user row in that organisation, which must be active;
   - requires the CEO profile there, or platform-admin status within that same organisation;
   - returns 404 when the organisation is missing or foreign, and 403 during Admin Inspect or when the actor isn't authorised.
3. **Concurrency.** A concurrent second invite is settled by the unique index (409).
4. **Replacement cap.** Applies to every actor.
5. **RLS** (`OrganisationIsolationHardening1786717300000`):
   - the `manager_workspace_write` platform-admin branch is removed;
   - the `manager_profile_tenant` platform-admin branch is limited to `type = 'ceo'`, the minimum CEO onboarding needs (SECURITY TRADE-OFF recorded in `CREWFLOW_ORGANISATION_ISOLATION_SECURITY_REPORT.md` §17).
6. **Constraints.**
   - Composite same-organisation foreign keys on `manager_profile` (user, workspace), `manager_workspace` (owner), `user_role`, `organisation_member`, `account_invite`, `user_session` (user, workspace) and `refresh_token`. Any one row's organisation can't disagree with its user's or workspace's, and a user can never be moved into another organisation underneath their rows.
   - A CHECK that only internal Managers can be Initial Managers.
7. **Login.** Two accounts accepting the same password for one email → 401 `AMBIGUOUS_ACCOUNTS`, the same fail-closed rule as provider sign-in.
8. **UI.** No organisation picker. Capabilities come from the server (`GET /leadership/capabilities`, scope `own` or `none` only).
9. **Admin drawer.** No Initial Manager actions for other organisations.

**Data.** Read-only review of the dev database found no affected real organisation and no live session on any affected account. Structural integrity was zero on all 17 checks. Nothing was repaired or revoked.

**Regressions:**
- `organisation-isolation.integration.spec.ts`: 30/30, and 37/37 together with `member-role-redis-cache` with both caches on.
- The converted `initial-manager-invitation`, `initial-manager-replacement`, `organisation-onboarding` and `manager-workspace-abuse-cases` suites (superseded assertions now expect denial).
- Frontend 431/431, Playwright members UI 17/17, Flutter authentication 59/59.

**Not covered (owner decision):**
- Recovery beyond the replacement cap.
- Blocking invitations for an email that already has an account in another organisation (it would create an existence oracle).

## Unlimited Initial Manager replacement, email uniqueness across organisations, Redis integrity (F-06) (2026-10-15)

**Threats:**
- Removing the replacement cap enables unbounded churn, or two current Initial Managers through racing requests.
- A replaced identity keeps a credential.
- A new account reuses another organisation's address (identity confusion), and the refusal leaks that organisation's existence or details.
- A Redis writer forges authentication cache entries (F-06).

**Mitigations, unlimited replacements:**
- Only the lifecycle, the one-current-Initial-Manager unique index and request throttling bound replacement. There is no count.
- Rows are locked in activation's order (profile → invitation → user), which removed a deadlock found by test.
- The replaced identity's invitation is revoked, its password nulled, every refresh family and web session revoked, and its security version bumped, in the same transaction.
- Activated Initial Managers stay unreplaceable until there is a data ownership-transfer policy.

**Mitigations, email uniqueness:**
- The single enforcement point is the `user_email_unique_across_organisations` trigger (SECURITY DEFINER, owned by `rab_secure_owner`), race-safe through an advisory transaction lock on the canonical email.
- Refusals are one fixed generic 409 (`EMAIL_UNAVAILABLE`) for every state of the other account. Member invitations return the existing generic `unavailable` outcome, rate-limited before lookup.
- Organisation creation and CEO onboarding are now one transaction.
- Historical duplicates are untouched. SECURITY TRADE-OFF: existence "somewhere" is inferable by authorised actors; recorded in `GLOBAL_EMAIL_UNIQUENESS_SECURITY_REPORT.md` §2.

**Mitigations, F-06:**
- The cookie hash is bound to the session row in `assertActive`.
- `authctx` values carry an HMAC.
- Negative controls proved both forgeries worked before the fix.

**Regressions:**
- `initial-manager-replacement` (23)
- `email-unique-across-organisations` (15)
- `auth-cache-integrity` (4)
- `organisation-isolation` (30)
- the worker `email-send.processor.spec`
- the live Docker acceptance (45/45)

**Open:** F-08 (custom-role backfill under a non-superuser owner; a fix is prepared, see the next section); replacing an activated Initial Manager (kept blocked by owner decision); deferred email-confirmed onboarding (to remove the existence inference; the generic refusal is kept by owner decision).

## Devices and active sessions (2026-10-15)

**Threats:**
- The device list shows sessions the server no longer accepts, which hides the real state.
- A login from the same browser leaves the previous session alive (session pile-up).
- An administrator using Admin Inspect revokes the inspected person's sessions (CF-02: `JwtAuthGuard` rewrites `userId`; `/profile` routes have no `PermissionGuard`).
- A spoofed or invalid forwarded IP is recorded (CF-45).
- A private gateway address is presented as the user's IP.

**Mitigations:**
- `ProfileService.listSessions` uses the same liveness predicate as `SessionValidityService.assertActive`: not revoked, not absolutely or idle expired, refresh family live. Nothing valid is hidden, and nothing invalid is shown.
- A web password login revokes only the session whose cookie the browser presented. This is the owner-approved rule, already used for OAuth (F11, Twenty's SUPERSEDED).
- Session mutations refuse during Admin Inspect (403).
- Forwarded IPs must pass `node:net` `isIP` and are still honoured only from configured trusted proxies.
- Private and loopback addresses are labelled "Private network (…)" for display, and the stored value is unchanged.
- Revocation stays authoritative in PostgreSQL: a cached session projection cannot revive a session, and the cookie hash is bound to it (F-06).

**Regressions:**
- `profile-devices-sessions.integration.spec.ts` (7)
- `client-ip.util.spec.ts` (35 with trusted-proxy)
- `DevicesList.spec.tsx`, `device-label.spec.ts`
- the 18-suite session matrix, with caches off and on (237/237 each)

**Open:**
- `CF-Connecting-IP` restricted to Cloudflare ranges.
- Session-row retention (CF-46).
- CF-02 for `PATCH /profile` and push-device routes.
- An optional browser-installation id.

## Custom-role backfill under the restricted migration role, and test-database isolation (2026-10-15)

**Threats:**
- **F-08.** A data backfill that reads FORCE-RLS tables before binding tenant context silently does nothing under the real migration role. Members of legacy custom roles then keep losing access they were granted, with no error anywhere.
- **The opposite risk.** A "fix" that disables RLS, uses BYPASSRLS or borrows `rab_secure_owner` would widen what migrations can touch.
- **Overreach.** A backfill could overwrite or extend a role definition saved in the editor.
- **Test isolation.** A test that reads the developer's `.env`, or a hardcoded URL, writes to or reads from a database other than the verified test target (the development database, in the case found).

**Mitigations:**
- **`BackfillCustomRoleObjectRulesUnderForcedRls1786717600000`:**
  - It discovers workspaces only through the existing SECURITY DEFINER routing function `core.worker_list_workspaces` (ids only).
  - It binds `rab.organisation_id` / `rab.workspace_id` per workspace before any role table is read or written, so every USING and WITH CHECK clause applies.
  - It never disables RLS and needs no role membership.
  - It touches only legacy roles: custom, no object rules, not "All Objects". It never overrides an existing rule, grants only the objects whose view flag the role already holds, and adds no field visibility or record filter.
- **Worker tests** reach the database only through `resolveVerifiedRoleDatabaseUrl`:
  - TEST_* variable only;
  - a live check of the same database and cluster as the fixture connection;
  - the exact expected role, with no SUPERUSER or BYPASSRLS.
  - Anything else fails the test. Spawned processes get every DB and Redis variable explicitly, so `dotenv` can't substitute values.

**Regressions:**
- `custom-role-backfill-forced-rls.integration.spec.ts` (5): runs both migrations under `SET LOCAL ROLE crewflow`, with a mutation check.
- `verified-role-database.integration.spec.ts` (5): each refusal path.
- The real migration runner, logged in as `crewflow`, on a disposable copy of development data (applied, then re-run: byte-identical).

**Open:**
- Migrations 1786717300000–1786717500000, and seven earlier ones, need the privileged bootstrap connection. Under `crewflow` they fail loudly, not silently. A CI guard is proposed.
- CI workflow database roles (`rab_app` / `rab_owner`) are stale.

## Authentication and authorisation remediation (2026-10-15, October 15 master audit)

Report: `docs/security/remediation/SECURITY_REMEDIATION_REPORT.md`. Nothing committed or deployed; the new migrations are not applied to the development database.

**Threats addressed (each with an adversarial integration test):**
- Admin Inspect acting as the inspected user on routes without PermissionGuard, surviving demotion, never expiring (CF-02). Now: guard-level read-only for every route, current platform-admin authority per request, 30-minute expiry, rows ended on revocation, and READ ONLY tenant transactions in PostgreSQL.
- Email change + password reset as an account takeover (CF-04). Now: verified pending change for active accounts, step-up with the actor's own password, notice to the old address, atomic confirmation that ends sessions, bumps the version, unlinks providers and voids reset tokens; platform admins protected.
- Login CSRF (CF-05): JSON only, untrusted Origin refused, no cookie for a forged request.
- Organisation "password sign-in off" not enforced (CF-06): enforced at the single sign-in convergence point, forgot and reset; owner-approved mobile-workforce exemption (SECURITY TRADE-OFF in the report).
- Promotion to platform admin keeping long-lived sessions (CF-07): all three grant paths revoke the target's sessions.
- Manager-tier mobile tokens reaching manager APIs (CF-08): mobile credentials default-denied except on `@MobileApplication` routes.
- Fresh-install grant/ownership drift (CF-09, CF-41) and runtime DML on the ledger/permission catalogue (CF-42): enforced migration identity sequence, a self-verifying reconciliation migration, and a golden posture snapshot checked on every test run.
- DEFINER functions without in-function authorisation, PUBLIC EXECUTE, core-first search paths (CF-13, CF-12, CF-58); cross-workspace role-link deletion (CF-30).
- Redis outage hanging every request (CF-17): bounded client; credential routes fail closed (SECURITY TRADE-OFF in the report); clock-in/out stays available.
- Background polling defeating idle timeouts (CF-20); cookie tossing via duplicate session cookies (CF-14, part); production booting on development defaults (CF-40, CF-16, CF-34 part); runtime-role check satisfied by SET ROLE (CF-43); push notifications delivered to the previous holder of a device (CF-35, part); mobile stale-401 token wipe, deep-link logout, unbounded requests and token write order (CF-36, CF-37, CF-19 part); Android backups (CF-57 part).
- Tests writing to a non-disposable loopback database (incident 2026-10-05 recurrence): the test guard now also requires a catalog-stored `crewflow.disposable_test_database = 'true'` marker.

**Open (see the report's sections G and H):** CF-01 containment, CF-03 MFA, CF-11 down() approval, deploy path (CF-52, CF-12 credential placement), `__Host-` cookies and SameSite, CF-15/CF-16/CF-49 production values, real OAuth verification, low-severity items CF-22–CF-29, CF-31–CF-33, CF-38, CF-44, CF-47, CF-54, CF-59.

## Staff availability warning at offer dispatch; Manager lifecycle actions (2026-10-15)

Report: `STAFF_AVAILABILITY_AND_MANAGER_ACTIVATION_FIX_REPORT.md`. No migration; nothing committed or deployed.

**Availability acknowledgement ("Send anyway") — threats and controls:**
- *Reading another workspace's staff availability through the warning.* The check runs inside the caller's workspace transaction (RLS + search_path) and only after the existing eligibility check, so a foreign or invisible staff id is refused 404 with no availability data (`scheduling-offer-abuse-cases` › "another organisation's manager…").
- *Using the acknowledgement as an authorisation bypass.* It authorises nothing: every send/approve permission, ownership, venue-team scope, eligibility and duplicate guard still runs unchanged; a Venue Manager's acknowledgement only lets a REQUEST be submitted, approval re-evaluates and needs the approver's own acknowledgement (`venue-manager-scoping` › "staff availability warning…").
- *Stale or forged acknowledgements.* The acknowledgement names exact London dates; the server recomputes conflicts at dispatch and accepts only full coverage, so a moved shift is warned again. Malformed input is a 400 (`forbidNonWhitelisted` + DTO). Each acknowledged dispatch is audited (`offer.availability_conflict_acknowledged`, `shift.request_availability_conflict_acknowledged`).
- *Silently thinned batches / duplicate offers on retry.* Multi-recipient paths pre-check every recipient before any insert; retries are absorbed by the existing (shift, staff) uniqueness and eligibility guard.
- Unknown availability (NULL / empty) is never treated as unavailable.

**Manager lifecycle UI — threats and controls:**
- The panel no longer offers Reactivate / Reset password for never-activated accounts (the server's 409 refusals are unchanged and still tested); an accepted-but-not-signed-in account is reported as `accepted`, not "invite not sent".
- Delete now sends the actor's own current password (the existing server step-up); none → 400, wrong → 403 (`account-invite-abuse-cases` › "accepted invitation awaiting first sign-in").

**Local development only:** `localhost` vs `127.0.0.1` makes the console and API cross-site, so the `SameSite=Lax` session cookie is never stored and a reload signs the user out. Fixed by a DEV-only same-host redirect (`shared/lib/loopback-host.ts`) and compose `APP_URL`/`ACCOUNTS_URL` on `127.0.0.1`; cookie attributes are unchanged.

**Open:** whether "Send anyway" should require `schedule.override_conflict` (granted to manager and CEO, used nowhere today) — owner decision.

## Workspace-scoped Venue Manager → Venue assignment (2026-10-16)

`POST /rest/v1/venue-managers/:id/venues` (owner-approved, local development; not committed). Before this, only the CEO-only `POST /managers/:id/venues` could write `manager_venue`, and it sees only the CEO's own workspace, so a Venue Manager created by an Initial/Internal Manager could never be given a venue (no shift requests, no pre-shift QR roster, no timesheet report).

**Threats and controls:**
- *A Manager linking a Venue Manager or a Venue of another workspace (horizontal escalation).* The service looks up both rows with the caller's server-derived `workspaceId` as an explicit predicate, and FORCE RLS on `manager_profile`, `venue` and `manager_venue` (`organisation_id = current_org() AND workspace_id = current_workspace()`, USING + WITH CHECK) binds it again. Cross-workspace and unknown ids are 404 and write nothing (`venue-manager-venue-assignment` › "cannot link a Venue Manager of Workspace B", "…a Venue of Workspace B", "Manager B cannot link…", "unknown … 404").
- *Granting venue scope to a non-Venue-Manager profile.* Only `type: venue` profiles match; an Internal Manager's profile is 404.
- *Tenancy taken from the request.* The body is `{ venueId }` only; `organisationId`/`workspaceId` are 400 (`forbidNonWhitelisted`).
- *Skipping the route guard.* `PermissionGuard(VENUE_MANAGER_CREATE)` + `RequireWorkspaceGuard` + `@ManagerApplication` at the route; `VenueManagerService.assignVenueInOwnWorkspace` re-checks `VENUE_MANAGER_CREATE` itself (layer 2 test calls the service directly). Mobile Venue Manager tokens are refused.
- *Unaudited scope changes.* Every assignment writes `manager.venue_assigned` with actor, Venue Manager, venue and workspace; no secrets.
- The CEO route and its permission are unchanged (`venue-manager-scoping`, `manager-venue-workspace-binding` suites pass; a Manager still gets 403 there).

**Follow-up (same day, owner-approved): Managers see and add their own Venue Managers.** `GET /rest/v1/venue-managers` lists ONLY `type = venue` profiles of the caller's server-derived workspace (forced predicates, plus FORCE RLS), each with its own-workspace venues; guarded by `VENUE_MANAGER_CREATE` at the route and re-checked in `VenueManagerService.listInOwnWorkspace`. `ListVenueManagersDto` has no type/workspace/organisation field, so `?workspaceId=`, `?organisationId=`, `?type=` are 400. `/auth/capabilities` now also reports `venue_manager.create` (presentation only). Web: a Manager gets a read-only "Venue managers" tab and "New venue manager" (POST /venue-managers + POST /venue-managers/:id/venues); the CEO roster (`/managers`, `manager.manage`) is unchanged and a Manager still gets 403 there; someone with neither permission sees no managers tab instead of a 403 screen. Tests: `venue-manager-venue-assignment` (19, incl. cross-workspace list isolation, query widening, no-permission, mobile token, layer 2), `Users.spec`, `CreateUserModal.spec`.

Detail panel: `GET /rest/v1/venue-managers/:id` reuses the same workspace-forced query with an id filter; another workspace, an Internal Manager or an unknown id is 404, and the service re-checks `VENUE_MANAGER_CREATE` (tests in `venue-manager-venue-assignment`, 21 total). The web panel is read-only.

**Account actions (owner request, 2026-10-16) — SECURITY TRADE-OFF:** a Manager now manages the Venue Managers of their OWN workspace with the same panel the CEO uses for Managers: edit (name/phone/job title only — `UpdateManagerDto` has no type/role/workspace field), suspend/reactivate, reset password, resend/cancel invite, change pending email, verified email change, timeline, notes, email history, send email, and delete. Routes mirror `/managers/:id/*` under `/venue-managers/:id/*`; every one passes `VenueManagerService.assertOwnWorkspaceVenueManager` first (re-checks `VENUE_MANAGER_CREATE`, then requires a `type: venue` profile of the caller's workspace, else 404), then the existing ManagerService rules (delete step-up password + `UserDeletionService` gates, invitation state machine, audit). Reset/resend/cancel/pending-email also need `USER_RESET_PASSWORD`; the verified email change checks `VENUE_MANAGER_CREATE` instead of `MANAGER_MANAGE`. Bulk email silently drops ids outside the caller's own Venue Managers. *Widened:* previously only `MANAGER_MANAGE` (CEO) could do these to a Venue Manager. *Risk accepted:* a compromised Manager account can suspend/delete its own workspace's Venue Managers (not other workspaces', not Internal Managers, not the CEO). *Residual:* the scope check and the delegated action run in separate transactions (a profile's type/workspace does not change after creation). Tests: `venue-manager-venue-assignment` (28).

**Open:** no workspace-scoped venue *unassign* (CEO route only).
# Staff same-shift Teams read (2026-10-16, local implementation)

- Actor/data: authenticated Staff in `staff_app`, holding `attendance.clock`, can read first-name display labels and scheduled assignment intervals for confirmed coworkers on their own current confirmed shift. Response has only `displayName`, `startsAt`, `endsAt`, `isYou`; no IDs, last names, contact data, rates or attendance.
- Enforcement: application-target and permission guards; service repeats permission/application/role checks, resolves own profile under ordinary RLS, locks shift then caller assignment, and scopes every join to organisation/workspace/shift/venue. Unknown/unassigned/cancelled/completed shifts return 404. Invalid UUIDs return 400.
- Database: migration `1786718100000` adds a SELECT-only policy. `rab.team_shift_id` and `rab.team_staff_id` are transaction-local capabilities derived by the service, never HTTP fields. Policy checks org/workspace, Staff role, both confirmed assignments and nonterminal shift. Tenant binding resets these capabilities; existing profile policies, RLS/FORCE and write policies remain unchanged. Physical-workspace provisioning installs the same additive policy.
- SECURITY TRADE-OFF: like the existing worker capability, this uses the shared runtime DB identity and trusts server-bound GUCs. A future server/SQL-injection bug that binds these GUCs incorrectly could broaden profile-row visibility for that transaction. Mitigations are one binding site, self-resolution before binding, scope/assignment checks at both layers, minimal HTTP projection and denial/pooled-context tests. Stronger separation would require a dedicated narrowly privileged database projection/role. No general Staff-directory access is granted by the endpoint.
- Concurrent cancellation/removal: parent-first shared lock serializes shift cancellation; assignment is checked after locking. Roster SELECT filters current confirmed rows and uses canonical assignment periods. No persisted roster cache; mobile clears rows while refreshing and on failure/resume.
- Failure: missing migration returns 503 instead of an incomplete self-only roster. Network failures display retry; never mock coworkers or attendance success. Existing QR signature/window/geofence/payroll logic is unchanged. Scanner lifecycle now explicitly stops the externally controlled camera on interruptions/disposal, and accepts only one detection.
- Verification: `shift-team.integration.spec.ts` covers minimal fields, own/foreign workspace and organisation, unconfirmed caller/peers, wrong application, anonymous requests, changed intervals, cancellation, no-context RLS and pooled scope reset. Execution status is recorded in `FLUTTER_CLOCK_TEAMS_QR_REDESIGN_REPORT.md`; test source alone is not proof of passing integration.

## Owner-assigned Venue Manager teams; Venue Manager discovery removed (2026-10-16)

Report: `VENUE_MANAGER_ASSIGNED_STAFF_UI_AND_SENT_SHIFTS_REPORT.md`. Migration `1786718200000-VenueManagerStaffAssignment` (applied to dev with owner approval; backup `C:\Crewflow-Docker-Archive\20261016T193838Z-pre-1786718200000`).

**Threats and controls:**
- *A Venue Manager discovering or self-adding workspace staff.* `GET /staff/venue-directory/pool` and `POST /staff/venue-directory/team/:id` (and `StaffService.venueStaffPool` / `addVenueTeamMember`) are removed; RLS no longer lets a Venue Manager INSERT/DELETE `venue_manager_staff` (policies `vm_select` + `vm_update` only). Tests: `venue-manager-scoping` › owner-assigned team…, `staff-profile-rls-abuse-cases` › a Venue Manager can no longer insert….
- *Assignment by the wrong manager.* `POST/GET/DELETE /venue-managers/:id/staff`: `VENUE_MANAGER_CREATE` at the route, then `assertOwnWorkspaceVenueManager` + `assertWorkspaceOwner` in the service, then the RLS `venue_manager_staff_owner` policy (workspace owner only; WITH CHECK requires a Venue Manager of the same workspace); composite FKs pin both sides to the workspace. Other workspace / organisation / unknown ids are 404, all-or-nothing. Tests: `venue-manager-venue-assignment` › Manager A assigns…, assignment needs VENUE_MANAGER_CREATE….
- *Stale access after removal.* Every team read is a live query (no cache); `assertVenueTeamSelection` re-checks at `/shifts/request` and bulk offers, so a removed id is refused on the next request (`venue-manager-scoping` › a removed assignment is refused…).
- *Over-exposure of staff records to Venue Managers.* `GET /staff/venue-directory/:id` returns operational fields only (name, role, employment type, experience, skills, availability, preferred shift, max hours, own tags); exact key set asserted. Staff Notes / Email / timeline remain inaccessible to Venue Manager tokens (owner decision; `venue-manager-scoping` › owner decision: a Venue Manager has no Staff Notes or Email access…).
- *Tags crossing teams.* `PATCH /staff/venue-directory/:id/tags` updates only the caller's own team row (404 otherwise); tags are per Venue Manager.

**Residual (open):** the `vm_update` policy's WITH CHECK pins the row to the calling Venue Manager but not its `staff_profile_id`; the service only writes the two tag columns, so a change of the key columns would need SQL injection. Hardening follow-up: a BEFORE UPDATE trigger rejecting changes to `organisation_id`, `workspace_id`, `manager_profile_id`, `staff_profile_id`.

## Venue Manager profile photo routes (2026-10-16)

`POST /venue-managers/:id/avatar` and `DELETE /venue-managers/:id/avatar`, used by the create form's photo tile and the Venue Manager panel.

**Threats and controls:**
- *Setting another account's photo.* The route needs `VENUE_MANAGER_CREATE` and a workspace. The service then calls `assertOwnWorkspaceVenueManager`: the target must be a `type=venue` manager profile in the caller's own workspace and organisation. Any other id, including an internal Manager or another workspace's Venue Manager, gets a 404. The write runs in tenant context under RLS on `user` and `file`.
- *Malicious or oversized upload.* The routes reuse the staff avatar pipeline: `singleImageUploadOptions(AVATAR_MAX_BYTES)`, an image MIME/magic-byte check in `FileService`, private `PROFILE_IMAGE` storage, and a tombstone for the replaced file (`retireAvatar`). Each upload and removal writes an audit row (`FILE_UPLOADED`, `PROFILE_UPDATED`).
- Tests: `venue-manager-venue-assignment.integration.spec.ts` covers own-workspace upload, read-back and remove, 404 for another workspace's Venue Manager, and rejection of a non-image (31/31). An internal Manager id is excluded by the same `type=venue` filter but has no dedicated test yet.

## Five-hour report lifecycle, expired offer actions, staff reviews, typed timesheet sign-off (2026-10-17)

Report: `VENUE_REPORTS_HISTORY_FIVE_HOUR_LIFECYCLE_REPORT.md`. Migration `1786718300000-ShiftReviewSignoff` (verified on the disposable test DB; dev application pending owner approval).

**Threats and controls:**
- *Acting on a shift long after it ended (accepting or confirming a stale offer, or sending new offers for it).* `assertShiftActionWindowOpen` (`scheduling/utils/shift-action-window.ts`) refuses with a 409 once DB `now()` is at or past the shift's `ends_at + 5h`. It runs in the service layer that every path calls: `OfferService.sendOne` (all offer creation), `staffAccept`, and `applyOfferConfirmation`. Before this, an offer's own 48-hour `expires_at` was the only limit, so a shift that ended an hour ago could still be accepted. Confirmed assignments, attendance and the QR window are untouched. Tests: `venue-manager-scoping` › expired offer actions are refused by the API….
- *A stale "In progress" misleading the Venue Manager.* Display status comes from `reportLifecycle` against DB time; the canonical `shift.status` is never force-completed. Tests: `report-lifecycle.spec.ts` (19 boundary cases), `venue-manager-scoping` › Reports vs History….
- *Hiding unfinished work by moving it to History.* A report moves to History only five hours after outbox-confirmed delivery (every non-cancelled outbox row for the final PDF is `SENT`). An unfinalised report, a failed delivery or a report with no recipients stays in current Reports as needing attention. Nothing is deleted. Tests: `venue-manager-scoping` › a delivered report moves to History….
- *Reading another venue's reports or reviews.* `GET /attendance/report/shifts` filters in SQL by the same scope rule as `canReadShift` (Venue Manager: assigned venues; Manager: own shifts), under workspace RLS. `shift_staff_review` adds the service checks (`review.create` + `canReadShift` + staff must hold an assignment on the shift), the `shift_staff_review_scope` RLS policy (tenant + shift creator or venue-linked Venue Manager; `reviewer_user_id` pinned to the caller in WITH CHECK), and composite FKs to `shift(id, workspace_id)` and `shift_assignment(shift_id, staff_profile_id)`. The runtime role has no DELETE grant. Tests: `venue-manager-scoping` › staff reviews… (404 out of scope, zero rows with no tenant context, RLS rejects a reviewer swap).
- *Forged or invented sign-off evidence.* `finalise` accepts `{signedOffName, breakConfirmed: true}` only together (400 otherwise; unknown fields 400). The signer and time are the server's `finalised_by` / `finalised_at`, never client-supplied. Finalisation stays idempotent, so a second call never re-stamps the sign-off. Older finalisations are not back-filled. The typed name is printed on the final PDF. Test: `venue-manager-scoping` › typed sign-off….
- *Ratings becoming a hidden global score.* Reviews are per shift and per assignment, never aggregated, not exposed on any staff endpoint, and locked once the report is finalised (409, under the same advisory lock as finalise).

**Security trade-off (vetoable):** the mobile "Download PDF" fetches report bytes through the authenticated `GET /files/:id` (which never redirects) and hands them to the Android share sheet via a file in the app's private cache (`path_provider` + `share_plus`, two new dependencies). The copy leaves app control once the user shares or saves it. The alternative, a URL-token download link, was rejected because it puts a credential in a URL.

**Residual (open):** the 5-hour constant is code (`SHIFT_ACTION_WINDOW_HOURS`), not per-organisation configuration.

## Time-sheet routing, PDF view/download, Adolphus templates (2026-10-18)

Report: `TIMESHEET_BUTTONS_PDF_VIEW_DOWNLOAD_ADOLPHUS_TEMPLATE_REPORT.md`.

**Threats and controls:**
- *Finalising before the shift starts.* `ShiftReportService.finalise` now refuses with a 409 while DB `now() < starts_at`, in the service and not only by hiding the button. Tests: `venue-manager-scoping` › typed sign-off…, worker `attendance-lifecycle-42` Step 37.
- *The client deciding when actions are allowed.* `report-actions.ts` derives the footer stage (scheduled / pre_shift / started / finalised) and the document from DB time and `REPORT_AVAILABLE_BEFORE_MINUTES`. Finalise is enabled only when `isReportReady` holds. The app renders this and never computes windows.
- *Downloading another workspace's or venue's PDF.* Unchanged path: `GET /files/:id/download` → RLS → `ReportFilePolicy` → `canReadShift`. Verified live: venutest1 downloads its own attendance sheet (200), venutest2 gets 404 for both the file and the report.
- *Leaking the bearer token to object storage or into URLs.* `ApiClient.downloadFile` sends the token only to the API with `followRedirects = false`. A 302 to a presigned storage URL is fetched with no `Authorization` header. Test: `report_review_timesheet_test` › a presigned storage redirect is followed WITHOUT the bearer token.
- *Showing or saving a non-PDF or a placeholder.* `DownloadedFile.isPdf` (the `%PDF-` magic) gates both viewing and saving. A missing stored object shows "Document unavailable" with Retry, never a fake success.
- *Template injection.* Every shift, venue, staff and notes value in the Adolphus templates passes through `escapeHtml`. Optional fields are omitted, not printed as placeholders. Worker test asserts no `{{` or `}}` and no old branding.
- *QR integrity.* The attendance sheet embeds the existing signed Shift QR (`AttendanceQrService` + `QrImageService`). No new QR format, no account token.
- *Worker reading reviews.* Migration `1786718400000` adds `shift_staff_review_worker_scan` (SELECT only, `rab.actor_type = 'worker'`, organisation + workspace bound), mirroring `staff_profile_worker_scan`. User sessions never set `actor_type`. Not yet applied to dev (pending approval); until then the final PDF prints "Not reviewed".

**Security trade-off (vetoable):** Android "Download PDF" writes authorised bytes into the public Downloads collection (MediaStore, `MainActivity` channel `rab/downloads`). Once saved, the file is outside app control, readable by the user's file apps and backups. Below Android 10, and on iOS, it uses the share sheet. New dependency `pdfx` renders with the platform PDF engines and needs no network access.

**Dev infrastructure:** server and worker now share the `rab-local-storage` volume for LOCAL storage. Before this, each container wrote to its own disk, which was lost on every rebuild.

## Forgotten clock-out recovery, explicit attendance review, finalise gate, pipeline lanes, web Staff Reviews (2026-10-18)

Report: `CREWFLOW_ATTENDANCE_OFFERS_PIPELINE_STAFF_REVIEWS_MASTER_FIX_REPORT.md`. Migration `1786718500000-AttendanceReview` (plus the earlier `1786718400000`) is verified on the disposable test DB only; applying it to dev is pending owner approval.

**Threats and controls:**
- *A manager force-closing a shift that is still running, or inventing a clock-out.* `AttendanceService.correct` recovers a missing clock-out only for a `MISSING_CLOCK_OUT` record, or an open record already past `assignment end + MISSING_CLOCK_OUT_GRACE_MINUTES` (30, the same constant the worker monitor uses), measured on DB `now()`. Other rules: the time must be after clock-in and not in the future; a reason of at least 10 characters is required; there must be an attendance row (no clock-in is ever fabricated); and nothing changes after finalisation. The row is locked, a repeat is an idempotent no-op, and every change is audited with `clock_out_method = manager_correction`. Tests: `venue-manager-scoping` › recovers a genuinely forgotten clock-out…, never force-closes a shift still running…, concurrent identical recoveries….
- *A staff clock-out racing a manager recovery.* QR clock-out stays open for 120 minutes after the end and recovery opens at 30, so the two can overlap. Both paths lock the attendance row: the result is one clock-out, one correction row, and derived minutes consistent with the stored timestamps. Test: `attendance-abuse-cases` › race: a staff QR clock-out and a manager … recovery (stable over repeated runs).
- *"Reviewed" without a review, or finalising unreviewed attendance.* `shift_assignment.attendance_reviewed_at/_by` is set only by `POST …/attendance-review` (`attendance.edit`, scope 404, finalise advisory lock, 409 while still clocked in or while the clock-out is missing) and is cleared by any later correction. `finalise` refuses with 409 "N attendance review(s) remaining". The mobile badge and the Finalise button render server fields only (`attendanceReviewed`, `finalisable`). Five concurrent finalisations produce one finalisation and one audit row. Tests: `venue-manager-scoping` › Reviewed means a completed attendance review…; `attendance-abuse-cases` › five concurrent Finalise & send…; `report_review_timesheet_test` (badge rules, a rejected save is never shown as success).
- *Board miscounting people.* Each staff member's latest offer decides exactly one lane, by documented precedence (`resolveVenueOfferKanbanStage`). Every staff counter is that lane's card count, so the header reconciles with the board, and an unknown state falls to Deleted Offer, never to a live lane. Test: `venue-manager-scoping` › `expectReconciled` on every board read.
- *Enumerating staff performance reviews.* Web `GET /staff/:id/reviews[/:reviewId]` checks, in order: `@ManagerApplication()` (mobile tokens refused), then `PermissionGuard(STAFF_VIEW)`, then the service re-checks the permission and requires a creator-owned staff profile (404, the same rule as Notes and Timeline), then a query pinned to the caller's own shifts (`shift.created_by`) under a workspace-bound transaction, then `shift_staff_review_scope` FORCE RLS. Filters are validated (unknown fields and an unknown range give 400). Tests: `venue-manager-scoping` › web Staff Reviews… (another organisation, a sibling manager in the same workspace, and a review id under the wrong staff member all give 404).
- *Sent offers overcounting.* `GET /shifts/sent` classifies requests in SQL (All excludes genuinely expired requests; Expired holds only them) and returns `counts.submitted` (distinct requests). Pagination and totals agree with the tabs.

**Policy change to confirm:** the 2026-10-17 note "reviews are per shift, never aggregated" is superseded, for the owning Initial Manager's web view only, by this brief's aggregate Staff Reviews tab (average, distribution, category averages). Staff never see reviews, and Venue Managers get no aggregate.

**Residual (open):** a delegated workspace member (custom role) sees no Staff Reviews, because ownership is creator-only like Notes. Widening it would be a separate permission decision.

## Crewflow new web UI: dashboard, sidebar and bulk bar (2026-10-19)

This change is presentation only; no endpoint, DTO, guard, service or RLS policy changed. The new Dashboard shows other people's data (offer counts, hours worked, shift staffing), so it is recorded here.

**Threats and controls:**
- *Dashboard widgets showing data the caller may not see.* Every widget calls an existing list endpoint that is already guarded and tenant-scoped (`/offers`, `/shifts`, `/attendance`, `/venues`, `/shifts/:id/pipeline`, `/dashboard/summary`). It uses only filters those DTOs already whitelist, and `limit` stays at most 1000. A 403 or 404 shows that card's error with Retry. Nothing falls back to cached or fabricated numbers.
- *Counts that lie.* Counts come from the server's `total` for a filtered query (`limit: 1`), never `.length` of a page-capped download. Hours worked sums only the server's `workedMinutes`, so open attendance contributes nothing. When attendance exceeds the 1,000-row page, the card says it covers the latest 1,000 records.
- *Sidebar links reading as permission grants.* The Audit Log link shows only for `manager`/`ceo`, and `PermissionGuard(AUDIT_VIEW)` stays the authority. Venue Offers was already routable. Hiding a link never replaces a server check.
- *Bulk bar adding destructive actions.* `BulkActionBar` only hosts actions the page already had. Users keeps Send Email, through the unchanged `open-bulk-email` → `BulkEmailPanel` path. The other lists get a count and Clear only, and no Delete was added.
- *Identity confusion on the profile card.* The card shows the signed-in user's own `avatarKey`, fetched through the authenticated `/files` route, or their initials. It never shows a stock portrait.

**Residual:** none new.

## Devices: one usable-session definition; "Sign out everywhere" removed from the UI (2026-10-19)

**Threats and controls:**
- *The Devices list disagreeing with authentication (hiding a live session, or showing a dead one as active).* Listing and "log out all other devices" now use `usableUserSessionSql()`, the same conditions `SessionValidityService.assertActive` denies on: revoked, absolute or idle expiry (PostgreSQL `now()`), and a live refresh family for the same user and organisation. The integration suite asserts that every listed session is accepted and every hidden one gets 401, with the Redis caches both on and off, and after an API restart.
- *Client metadata as an identity.* User-Agent and IP are display only. Automation, script and mobile-app clients are labelled truthfully, never grouped or merged, and never used for supersession or revocation. Supersession still uses only the session cookie the browser presents.
- *Removing a containment control.* Only the Profile button was removed. `RefreshTokenService.revokeAllForUser` and `POST /profile/sessions/logout-all` keep their guards, the Admin Inspect refusal and audit, and password change/reset, suspension and containment still revoke every session.

**Residual (open):** Automated tooling that signs in to a real account leaves sessions that stay valid for up to 30 days idle under the manager web policy. The account owner should end them with "Log out all other devices", and QA should use disposable identities.

## Users bulk actions, Venue manager count, sidebar shortcuts, Support (2026-10-20)

**Threats and controls:**
- *A bulk action acting on records the caller may not touch, or on the wrong type.*
  - The bar only calls the existing single-record routes (`/staff`, `/managers`, `/venue-managers` `:id/reactivate|deactivate`, `DELETE :id`, `bulk-email`), each with its own PermissionGuard, service-level permission and ownership/workspace checks (404 outside scope), lifecycle 409s, audit and session revocation.
  - The selection is per roster and keyed by id; switching roster clears it, so ids never cross types.
  - Runs are sequential and capped at 100 records.
  - Delete keeps step-up: the current password is sent with each request, and the run stops on a refusal.
  - Results are reported per record; nothing claims success the server did not confirm.
- *Capability hints leaking or granting access.* `staff.create` and `staff.deactivate` are the caller's own permissions and only hide or show UI; every route re-checks.
- *A dashboard count revealing another workspace.* `venueManagerCount` counts `manager_profile` rows of the caller's server-derived workspace, organisation and `type=venue` only, under tenant context and RLS, with the list's own `VENUE_MANAGER_CREATE` gate. Without that gate the field is `null`. The integration test covers a foreign workspace and a caller without the permission.
- *Shortcut injection.*
  - Links accept only internal Crewflow roots or https URLs without credentials; `javascript:`, `data:`, `file:`, `http:` and protocol-relative URLs are refused.
  - External links open with `noopener noreferrer`.
  - Stored entries are re-validated on every read.
  - Storage is per user and workspace; a shortcut never grants access, because the destination route re-checks.
- *Support data exfiltration.* Support shows only a build-configured channel (validated). It sends nothing and never collects logs or account data.

**Residual (open):** Shortcuts live in `localStorage`, so anyone using the same unlocked browser profile and account can see their labels (these are the account's own record names). There is no server-side copy.


## Personal navigation layout Save/Cancel (2026-10-20, server only so far)

- **Asset:** a user's own sidebar layout, including pointers to Staff/Manager/Venue/Shift records.
- **Threats and controls:**
  - Writing or reading another user's, workspace's or organisation's layout: owner/workspace/organisation come only from the session, and the DTO rejects them (400). RLS `navigation_layout_own` is FORCEd; this is tested as crewflow_app, including with no context.
  - Using a shortcut to learn about records outside the caller's scope: every record is re-checked through its owning service at Save, and opening a shortcut still goes through the destination's guard.
  - Stored script or open redirect: kinds, icons and keys are allowlisted; links must be an internal Crewflow root or https without credentials; control characters are refused; there is a size cap of 40 items, 60-character labels and 32 KB.
  - Lost update: an optimistic revision check returns a 409.
  - Duplicate apply after a lost response: the requestId is replayed.
  - Admin Inspect impersonation: writes are refused with a 403.
  - CSRF: the JwtAuthGuard origin check applies to cookie requests.
  - Mobile tokens: refused by `@ManagerApplication()`.
- **Residual:** labels are user-chosen text (rendered as text, never HTML). Shared layouts are not implemented (not approved).

## Venue profile photo (2026-10-20, server + web; migration not applied to dev)

`POST /rest/v1/venues/:id/photo` (multipart `file`) and `DELETE /rest/v1/venues/:id/photo`; read through `GET /rest/v1/files/:fileId`. New file kind `VENUE_PHOTO`, column `venue.photo_file_id` (migration `1786718700000-VenuePhoto`). The photo id is also projected to Staff as `venuePhotoFileId` on `GET /offers/mine` and `GET /attendance/me/active|history|shift/:id`.

- **Asset:** an image a Manager attaches to a venue (may show a building, entrance or people), and the existence of that venue to people outside its scope.
- **Threats and controls:**
  - *Setting or removing another workspace's / Manager's venue photo.* Route: `JwtAuthGuard` + `PermissionGuard(VENUE_EDIT)` + `RequireWorkspaceGuard` (no `@MobileApplication`, so mobile tokens are refused). Service (`VenueService.uploadPhoto/removePhoto`): re-checks `VENUE_EDIT` in the transaction, then the same write scope as `PATCH /venues/:id` (`assertVenueOwned`: creator, or a Venue Manager's assigned venue); anything else is 404. Tested: another workspace's Manager gets 404 on upload and remove, the photo is unchanged.
  - *Reading a photo you should not see.* Layer 4: the file is stored with the venue's own non-NULL `workspace_id`, so `stored_file_tenant` RLS admits it only inside that organisation + workspace (tested: no context = 0 rows; another workspace context = 0 rows). Layer 2: `VenuePhotoFilePolicy` (registered by `VenueModule`, engine never imports modules) requires the file to be the venue's CURRENT photo, then — staff_app tokens — the caller's own staff profile must have LIVE work only (owner decision 2026-10-20): a job offer that is `pending` with `expires_at` still in the future, `staff_accepted` or `manager_confirmed`, whose assignment is `offered`/`staff_accepted`/`confirmed`; or an assignment that is `staff_accepted`/`confirmed`; and the shift is not `cancelled`/`declined`. Declined, expired (including a lapsed pending offer the expiry job has not swept yet), manager-rejected, withdrawn, cancelled, no-show and completed work grants nothing at that venue; every other caller must pass exactly `GET /venues/:id` visibility (`VENUE_VIEW` + owner/assigned/delegated rules + custom-role record filter). Every denial is 404 and audited `file.access_denied`. Tested: other-workspace Manager 404, Staff with no offer 404, Staff with an offer elsewhere 404, declined, expired (lapsed and swept), manager-rejected and withdrawn offers 404, completed or cancelled seat 404, unassigned Venue Manager 404; pending, accepted and confirmed Staff and the assigned Venue Manager 200.
  - *Malicious, mislabelled or oversized upload.* `singleImageUploadOptions(5 MB)` (one file part, zero other fields, no bracket names; oversize = 413 before storage), then `FileService.validateContent` re-decides type from magic bytes (PNG/JPEG/WebP only, 5 MB cap again) whatever the filename or Content-Type. Served with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `inline` disposition. Tested: text, PDF-as-.jpg and GIF are 400, 5 MB+ is 413, the existing photo is kept.
  - *Mass assignment / tenant spoofing.* organisationId and workspaceId of the stored file come from the verified context. `organisationId` in the multipart body is a 400 (Multer `fields: 0`); `photoFileId` is not a field of Create/UpdateVenueDto, so `PATCH {photoFileId}` is a 400. Tested.
  - *Stale or swapped files.* Replace/remove tombstone the old row (`DELETED`, object purged later by `storage:reconcile`, now listed as an image kind) and the policy refuses any file that is not the venue's current `photo_file_id`. Tested: the replaced and removed ids return 404.
  - *Audit.* `file.uploaded` + `venue.photo_updated` (previous and new file id) in the same transaction; removal writes `venue.photo_updated`.
- **Security trade-off (resolved by the owner, 2026-10-20):** the first version granted access for any non-withdrawn offer, including declined, expired and completed work. The owner narrowed it to live work only, as above. Consequence: once a seat is `completed`, the Staff app's history entries for that venue still carry `venuePhotoFileId`, but loading the bytes is a 404. The app must fall back to its placeholder.
- **Residual:** custom-role workspace members with field restrictions do not receive `photoFileId` (it is not in the member field catalogue, least privilege) and so see no photo; `POST /files/previews` is still PROFILE_IMAGE-only (unchanged). The provisioner applies the same SQL (`V1_EXPECTED.foreignKeys = 96`, proven by the worker `workspace-provisioning` suite, 6/6), but the photo routes and policy were exercised with `HWS_RUNTIME_ENABLED` off (core tables), not against a routed physical workspace schema.

## Payroll approval gates staff History (2026-10-20, server + web; migration not applied to dev)

Owner rule: Clock out → the shift report is finalised (attendance `approved`) → one payroll record per finalised attendance is created `pending_approval` in the same transaction → a manager holding `payroll.approve` in THEIR OWN workspace approves (or rejects with a reason) → only then does the staff member's History show the shift. Migration `1786718800000-PayrollRecord` (table `payroll_record`, core + every workspace schema; frozen SQL `workspace-schema/v1/payroll-record.ts`). Routes: `GET /rest/v1/payroll/records`, `POST /rest/v1/payroll/records/:id/approve`, `POST /rest/v1/payroll/records/:id/reject` `{reason}`, `POST /rest/v1/payroll/records/bulk-approve` `{ids}`. Staff projection: `payrollStatus` / `payrollApprovedPence` on every `AttendanceSummary` (`/attendance/me/history`, `/me/active`, `/me/shift/:id`, console list).

- **Asset:** gross pay per staff shift (bigint pence), the approval decision, and whether another person's pay is visible.
- **Threats and controls:**
  - *Approving or rejecting payroll you should not.* Layer 1: `PermissionGuard(PAYROLL_APPROVE)` + `RequireWorkspaceGuard` + `@ManagerApplication()` (staff / venue-manager mobile sessions are 403). Layer 2: `PayrollService` re-checks the flag in the transaction, refuses Venue Managers categorically (403, architecture §1.2), requires the session workspace. Layer 3: every lookup is pinned to `ctx.organisationId` AND `ctx.workspaceId`; another workspace's record is 404. Layer 4: `payroll_record` RLS ENABLE + FORCE, tenant predicate on every command. Layer 5: UPDATE only for a non-venue manager of the bound workspace (`manager_profile.type <> 'venue'`), and WITH CHECK refuses an `approved_by` equal to the worker whose hours these are. Tested: other-workspace manager (holds the flag) 404 on approve / reject / bulk and sees nothing in the list; manager without the flag 403; staff 403; Venue Manager 403; DB-level own-hours UPDATE 42501.
  - *Invented or edited pay.* INSERT WITH CHECK only admits a `pending_approval`, undecided row whose shift the caller may finalise (creator or linked Venue Manager) and whose figures mirror an `approved` attendance exactly (worked minutes, `earned_pence`, assignment `pay_rate_snapshot_pence`). The service additionally re-derives the gross with `payForMinutes` and refuses finalisation (409) if it disagrees with the stored figure. The runtime role has column-level UPDATE on the decision columns only and no DELETE grant. Tested: invented-figure INSERT 42501, `UPDATE amount_pence` 42501, DELETE 42501; amount = BigInt half-up of rate × minutes / 60.
  - *Seeing another person's pay.* SELECT policy: non-venue workspace manager, or the staff member whose `staff_profile` the row is. Venue Managers can create the row at finalise (INSERT without RETURNING) but never read it. Tested: staff bound context sees only its own row, naming another staff member's attendance returns nothing; Venue Manager and other-workspace manager contexts see 0 rows; staff history lists only their own attendance; no-context query 0 rows.
  - *Raw status from the client / mass assignment.* Actions are named; `assertTransition(PAYROLL_RECORD_TRANSITIONS, …)` on every change, 409 otherwise (approve twice, reject approved, approve/reject rejected: tested). DTOs `forbidNonWhitelisted`: `status` or `organisationId` in a reject body is 400 (tested). Conditional UPDATE `WHERE status = 'pending_approval'` under `FOR UPDATE` row locks (id order) closes concurrent-approver races.
  - *Bulk approve approving more than intended.* All-or-nothing in one transaction: any unknown / out-of-workspace id is 404, any non-pending id 409, own hours 403, and nothing is approved. 1–100 unique UUIDs. Tested.
  - *Audit.* `payroll_record.approved` (per record, `bulk` flag, amount) and `payroll_record.rejected` (reason) in the same transaction; finalise metadata carries `payrollRecords`.
- **Security trade-off (flagged for owner veto):** the payroll record is the only gate; the History projection still returns every past attendance with `payrollStatus`, and the Flutter app filters to approved / processing / paid. A different client could display unapproved attendance (its own data only — never another person's pay, and `payrollApprovedPence` is null unless approved). Stricter alternative: filter `/me/history` server-side, which would change an existing contract the mobile app already uses for "awaiting payroll approval".
- **Who approves (owner decision 2026-10-20):** `1786718900000-ManagerPayrollApproveDefault` adds `payroll.approve` to the system `manager` role (Initial and Internal Managers) in every existing organisation and in `ROLE_DEFS` for new ones; never `venue_manager`, `staff` or `ceo`; custom member roles stay capped by `MEMBER_ROLE_ALLOWED_PERMISSIONS`. The flag is broad by role but every use is still confined to the approver's own workspace and never their own hours (tested: non-Initial Internal Manager 200 in own workspace, other-workspace Manager 404, Venue Manager 403).
- **Residual / not built:** the architecture's mandatory 2FA for `payroll.approve` holders is not enforced; no `processing`/`paid` writer; a rejected record has no path back (`rejected → draft → pending_approval` needs a report-reopen flow that does not exist; correction after finalisation is 409, tested); reports finalised before the migration have no record (no back-fill); no realtime event (the staff app reloads History); hws:backfill of non-pending payroll rows would be refused by the INSERT policy (HWS is off everywhere).

## Pay statement on payroll approval; Payroll page redesign (2026-10-21, server + worker + web; migration 1786719000000 NOT applied to dev)

Approving a payroll record now also REQUESTS a pay statement. The worker (`rab-worker/src/queues/rab-reports/pay-statement.job.ts`, every 20 s) renders a PDF from the record's frozen figures only, stores it as `PAY_STATEMENT_PDF`, and notifies the staff member (in-app + push outbox via `NotificationService.notify`, type `pay_statement_ready`). Migration `1786719000000-PayStatement`: statement state columns on `payroll_record`, `stored_file` kind, notification-preference type, two worker-only policies, and the human UPDATE policy tightened. New routes: `GET /rest/v1/payroll/period?month=YYYY-MM` (manager read model), `GET /rest/v1/payroll/me/statements` (staff app). `POST /payroll/records/bulk-approve` now returns per-id results.

- **Asset:** a person's gross pay document, and the claim that it was delivered.
- **Threats and controls:**
  - *Reading someone else's pay statement.* Layer 4: `stored_file_tenant` RLS (file carries the record's non-NULL workspace). Layer 2: `PayStatementFilePolicy` — the file must be the CURRENT `statement_file_id` of a payroll record visible to the caller under `payroll_record` RLS, and the caller is the staff member it belongs to (with `payslip.view_own`) or a non-venue manager of that workspace with `payroll.view`. Everything else is 404 + `file.access_denied` audit. Tested (worker suite): owner staff 200 with a real `%PDF-`; other staff, other-workspace manager and Venue Manager 404; same-workspace payroll manager 200.
  - *Staff listing other people's statements.* `GET /payroll/me/statements` resolves the staff profile from the session (unknown query params are 400), filters to approved/processing/paid, and payroll_record RLS (staff-own predicate) backs it. `@MobileApplication('staff_app')` + `payslip.view_own`: managers and Venue Managers 403 (tested).
  - *Duplicate documents / duplicate notifications on retries or two workers.* Per-record session advisory lock, then in ONE transaction: row lock, re-check `statement_file_id IS NULL`, claim the UNIQUE worker event `pay-statement:<id>`, register the file, mark generated, notify. Any failure rolls back and discards the uploaded object. Tested: a second cycle and two concurrent cycles produce exactly one file and one notification.
  - *Claiming delivery that did not happen.* Approval, document and notification are separate columns. `statement_notified_at` is set only if the in-app notification row exists afterwards (a user preference or a suspended organisation can suppress it). The web shows "Payroll approved successfully." on approval and "Pay statement generated." only when a later read shows `statement.state = 'generated'`. A render/storage failure stores only a fixed safe code (`generation_failed` / `error_<SQLSTATE>`), never the driver message (tested), and is retried up to 5 attempts.
  - *Humans forging document state.* `payroll_record_update` WITH CHECK now also requires `statement_status IN ('none','pending')` with no file, generated time or notification — only the worker (`rab.actor_type = 'worker'`, which no user session carries) can record them (`payroll_record_worker_update`, approved/processing/paid rows only). Tested: a manager setting `statement_status = 'failed'` or `statement_notified_at` gets 42501. Column grants still keep the money snapshot immutable.
  - *Approving records without verified hours/pay.* Only `payroll_record` ids are approvable; a record exists only after finalisation with figures that mirror an approved attendance (INSERT policy). The period read model gives attendance-only rows no record id and null figures. Tested: an attendance id sent to approve is 404 / bulk `not_found`.
  - *Bulk approve approving more than intended.* Per-id results: each id is locked and validated on its own; only `pending_approval`, own-workspace, not-own-hours ids are approved; every other id is returned as `blocked` (`not_found` does not distinguish unknown from other-workspace) and untouched. Tested with a mixed batch (unknown, approved, rejected, attendance id) and a re-sent batch.
  - *Document content.* Gross only, from the frozen snapshot; the PDF states it shows no tax, National Insurance or deductions and is not a payslip; every value HTML-escaped; rendered by the existing Playwright pipeline.
- **Security trade-off (for owner veto):** bulk approve changed from all-or-nothing to partial success with per-id reporting (owner request). A manager who selects 10 rows may approve 8; the response and the toast name what was skipped. Single-record approve keeps 404/409/403.
- **Residual:** statements are not regenerated if a record is later corrected (no correction path exists after finalisation); no email copy of the statement (in-app + push only); a statement that fails 5 times stays `failed` with no UI retry button; the 20 s worker interval is the latency between approval and the "generated" confirmation.

### Amendment (owner scope update 2026-10-21): Approved Shift Statement via durable outbox + BullMQ (migration 1786719100000)

The document above is renamed and re-plumbed; every control above still applies with these changes:
- **Name and content:** "Approved Shift Statement" (file kind `APPROVED_SHIFT_STATEMENT_PDF`, notification `shift_statement_ready`), explicitly **not a payslip**. It states "Shift earnings approved — payment scheduled according to the agency payroll calendar." and prints "Payroll period" / "Official scheduled payday" as "To be confirmed" (never computed) until the agency payment calendar exists.
- **Durability:** the approval transaction commits `statement_status = 'pending'` (the durable event). A worker dispatcher claims due rows one at a time (`queued`, `statement_dispatch_generation + 1`) and only after that commit publishes a BullMQ job (`rab-shift-statements`, jobId carries the generation, attempts 1). The consumer refuses any job whose generation is not the row's current one. If Redis/BullMQ is down the claim stays committed and the 10-minute lease re-queues it with a new generation (tested). Retries are the dispatcher's (back-off, 5 attempts, counted on the row); reconciliation also picks up approved records whose statement was never requested (tested).
- **What staff see:** `processing` (requested / queued / generating / retrying), `available` (PDF exists, `fileId` set), `failed` (all retries used). History visibility depends only on the committed approval, never on the PDF (tested).
- **Residual:** the BullMQ hop is exercised through the dispatcher's publish callback in tests; a live Redis-outage test against the real queue was not run.

## Agency payment calendar, payroll runs and official payslips (2026-10-21, server + worker + web; migration 1786719200000 on the test DB only)

Migration `1786719200000-PayrollCalendarRunsPayslips`: core `payroll_calendar` / `payroll_calendar_period` (organisation = agency), workspace `payroll_run` / `payroll_run_line` / `payslip` / `payslip_document`, `core.payroll_record_guard()` trigger, file kind `PAYSLIP_PDF`, notification types `payslip_available` / `payroll_period_attention`. Routes under `/rest/v1/payroll`: `GET calendar`, `POST calendar/import`, `GET runs`, `POST runs/prepare`, `GET runs/:id`, `POST runs/:id/finalise`, `GET runs/:id/export`, `POST runs/:id/payslips/:staffProfileId/document`, `PUT …/net`, `POST …/mark-paid`, `POST records/:id/statement/retry`; staff `GET me/payslips`, `GET me/statements` (now with real period/payday). CLI `payroll:import-calendar`.

- **Asset:** when people are paid (payday), how much (gross snapshot, provider net), the official payslip documents, and the paid/unpaid fact.
- **Threats and controls:**
  - *Wrong or invented payday.* The calendar is data (never hardcoded, never shift+14). Allocation = period containing the SCHEDULED START DATE in Europe/London (`payroll-allocation.ts`, tested incl. DST and the published February periods); no period → `unallocated`, shown as "Unallocated — no payroll calendar period". Active periods of an organisation cannot overlap (GiST exclusion; overlapping import 409, another year's overlap 409, tested). Re-import creates a new version; previous versions and their periods are kept (runs keep pointing at them).
  - *Changing the calendar.* `payroll.calculate` (route + service; Venue Managers refused) and RLS (non-venue manager of the organisation). Read: any session of the organisation (staff need their payday). Calendar rows are never deleted or edited except deactivation (column grants).
  - *Paying a record twice / issued payslips changing.* `payroll_run_line.payroll_record_id` UNIQUE (tested 23505); lines are INSERT-only and only into a `prepared` run whose records are still `approved` with identical figures (RLS predicate); a finalised run is locked (409 on prepare/finalise). Late approvals after finalisation are carried forward to the next non-finalised period with `late_approval`, the original period and work date, and an audit row (tested).
  - *State machine bypass.* `core.payroll_record_guard()` refuses any status change not in PAYROLL_RECORD_TRANSITIONS (23514, tested) and any non-worker change of statement state other than request (none→pending) or retry (failed→pending, attempts reset) (42501, tested). Finalise moves records approved→processing; mark paid processing→paid; both via assertTransition.
  - *Paid without confirmation.* Only `POST …/mark-paid` with `payroll.mark_paid` sets paid (never automatic, never on payday); the confirmer can never be the staff member (service + RLS); audited with the payment reference (tested). No system role holds `payroll.mark_paid` by default (owner decision needed).
  - *Forged or replaced payslip documents.* Upload: `payroll.calculate`, finalised run only, one PDF part (no other multipart fields), 10 MB, magic bytes re-checked; stored privately via FileService; each replacement is a new immutable `payslip_document` version (old kept, audited); identical bytes are a no-op (no new version, no second notification). Net pay is optional, labelled `provider_document`, only after a document exists, never computed (tested).
  - *Reading other people's payslips/runs.* PayslipFilePolicy: own staff member gets the CURRENT version only (with `payslip.view_own`); non-venue `payroll.view` managers of the workspace any version; everyone else 404 (tested: other staff, other-workspace manager, Venue Manager, old version for staff). RLS: payslips/lines/documents staff-own; runs readable by staff of the workspace (no personal data). Cross-workspace manager in the same organisation: 404 on every run action (tested).
  - *Worker abuse.* The period-attention job only reads and notifies the workspace owner once per (workspace, period) (worker event); it never prepares, finalises or pays (tested).
- **Security trade-offs (for owner veto):** (1) any Initial/Internal Manager of the organisation (`payroll.calculate`) can import a new calendar version for the whole agency — audited, versioned, overlap-checked; a stricter alternative is an org-admin-only flag. (2) Mark paid does not require an uploaded document (the owner's rule only requires explicit confirmation). (3) Payroll runs are readable by every staff member of the workspace (status/period only).
- **Residual:** if a calendar version is replaced with different period boundaries after a run was finalised, carry-forward for a record whose old period was finalised is evaluated against the new periods' runs; no Staff History payday on `AttendanceSummary` (the statements endpoint carries it); `payroll.mark_paid` 2FA not enforced.

### Amendment (owner decisions 2026-10-21, later): mark paid for Managers; calendar writes for the Initial Manager only (migration 1786719300000)

- `1786719300000-ManagerMarkPaidInitialManagerCalendar` grants `payroll.mark_paid` to every organisation's system `manager` role (Initial + Internal Managers; `ROLE_DEFS` for new organisations; permission_version bumped); never venue_manager / staff / ceo. Scope unchanged and tested: own workspace only (other workspace 404, other organisation 404), Venue Manager / staff 403, and never one's own pay (a staff member who is also a manager gets 403 from the service; the `payslip_update` WITH CHECK refuses `paid_by` = the staff member, 42501).
- The agency calendar import/replace is restricted to the organisation's current Initial Manager (`manager_profile.is_initial_manager`, internal, not superseded): service check (403 for any other manager, even with `payroll.calculate`), RLS write policies of `payroll_calendar` / `payroll_calendar_period` re-created with the same predicate (direct INSERT by an Internal Manager 42501, tested), CLI `payroll:import-calendar` refuses a non-Initial `--actor`. Reads unchanged. `GET /payroll/calendar` returns `canManage` (display hint for the web import button).
- This supersedes the earlier trade-off notes "no role holds payroll.mark_paid" and "any Initial/Internal Manager can replace the calendar".
- Fix (2026-10-21): the `payroll:import-calendar` CLI now runs on the runtime role with RLS in force (pre-auth routing list + per-organisation tenant contexts; no owner/bypass connection). Regression-tested as `crewflow_app`.

## Manual attendance recording vs confirmed no-show (2026-10-21, server + worker + Venue Manager app; no migration)

Owner rule: missing attendance is not a confirmed no-show. Routes (all `@MobileApplication('venue_manager_app')` + `PermissionGuard(attendance.edit)`, UUID-validated): `POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/record-attendance`, `…/confirm-no-show`, `…/reopen-no-show`. Shared transition table: `no_show → completed` added (only `AttendanceService.recordAttendance` drives it).

- **Asset:** another person's worked hours and pay (manager-entered times feed `attendance.worked_minutes/earned_pence` → payroll at finalisation), and the no-show fact (no pay).
- **Threats and controls:**
  - *A Venue Manager inventing or changing someone's hours outside their scope.* Five layers: route guard + application gate → service permission re-check (`attendance.edit`, also added to `correct()`) → report scope `canReadShift` (assigned venue / own shift; 404 outside, unknown staff 404) → workspace-bound transaction (organisation/workspace from the session; a body with `organisationId`/`status` is 400) → attendance / shift_assignment RLS. Tests: `manual-attendance` › scope (other-workspace VM, other-organisation VM, other-venue VM: 404 on all three routes; Staff token and Internal Manager web token refused; nothing written).
  - *Pretending the staff member clocked in with the app.* A manager-created row has no coordinates, `location_verified = false`, `clock_out_method = manager_correction`, and `attendance_correction` rows with an empty old value for every field (report `manuallyEntered`, shown as "Entered by manager"); audit `attendance.manager_recorded` with before/after, reason code and text, actor = the manager. Tests: `manual-attendance` › records attendance for a provisional no-show….
  - *Implausible or manipulated times.* Absolute instants with a mandatory offset (DST/overnight safe); not in the future (DB `now()`); clock-out strictly after clock-in; clock-in ≥ scheduled start − `CLOCK_IN_EARLY_MINUTES`, both ≤ scheduled end + `QR_POST_SHIFT_GRACE_MINUTES` (the Shift-QR window); break 0..1440 and shorter than the span; worked minutes via `@rab/shared` `computeWorkedMinutes`, pay via the assignment's confirmation-time rate snapshot. Tests: `manual-attendance` › rejects invalid times…, overnight, DST.
  - *Lost updates and double submits.* `expectedVersion` (opaque `updated_at` token) → 409 when another manager action landed first; identical resubmissions are no-ops (no second row/correction/audit). Concurrent creates are serialised by the shift's finalise advisory lock + shift/assignment row locks (same parent-first order as clock-in) and the UNIQUE `attendance.shift_assignment_id`. Tests: duplicate submit (sequential + 3 concurrent), concurrent corrections (one 200, one 409).
  - *No-show overriding recorded attendance, or recording over a confirmed no-show.* `confirm-no-show` is refused (409) whenever any attendance row exists, and before scheduled start + 30 min; `record-attendance` is refused on a CONFIRMED no-show until it is reopened (reason ≥ 10, audited `attendance.no_show_reopened`). Both take the same advisory + seat row lock. Test: race Record vs Confirm (exactly one wins, consistent state).
  - *The worker finalising or overriding a manager.* The shift monitor's `no_show` is provisional (`attendance_reviewed_at` stays NULL, audit `provisional: true`); it now locks the assignment row before its final re-check and compare-and-sets `confirmed → no_show`, cancelling its event otherwise. Worker tests: `no-show-provisional` (provisional only, retries idempotent, manager-acted seats untouched, mid-cycle manager commit wins).
  - *Changing finalised/paid records.* Every route refuses after report finalisation (payroll records exist from then on); no silent recalculation. Test: `manual-attendance` › timesheet readiness and payroll….
- **Security trade-offs (for owner veto):** (1) the time window reuses the Shift-QR bounds (15 min early / 120 min late) — real overtime beyond that cannot be entered here; (2) `reopen-no-show` is allowed to any `attendance.edit` holder in scope (the Venue Manager), not only the Internal Manager; (3) provenance is derived from correction rows rather than a dedicated column (no migration); `attendance_correction` remains deletable by `crewflow_app` at the grant level (pre-existing), but every manual entry is also in the insert-only `audit_log`.
- **Residual:** the legacy single-field `POST /attendance/:id/correct` keeps its older policy (no window/break-vs-span bounds); a staff member arriving after the 30-minute provisional mark still cannot clock in themselves (a manager records it); the web pipeline lane and the VM "Confirmed staff" line still label a provisional mark "No show"/"No-show recorded".

## Check In → Clock In → Clock Out, geofence on all three, Venue Manager on-behalf punches (2026-10-21, server + worker; migration 1786719450000 on the test DB only)

Migration `1786719450000-AttendanceCheckIn` (additive columns + CHECKs + 2 FKs on `shift_assignment` / `attendance`, core and every workspace schema; no new table, existing ENABLE+FORCE row-level policies unchanged). Routes: staff `POST /rest/v1/attendance/check-in`, `GET /rest/v1/attendance/me/shift/:shiftId/check-in` (`staff_app`, `attendance.clock`); Venue Manager `POST /rest/v1/attendance/report/shift/:shiftId/staff/:staffProfileId/clock-in-on-behalf` and `…/clock-out-on-behalf` (`venue_manager_app`, `attendance.edit`).

- **Asset:** proof that a person was physically at the venue before paid time starts; another person's clock-in/out (worked minutes → pay); staff location evidence.
- **Threats and controls:**
  - *Clocking in remotely / skipping arrival.* Clock In requires the booking's Check In (`CHECK_IN_REQUIRED`), checked before the Shift QR so a valid QR never substitutes for it; at a geofence-enforcing venue Check In, Clock In and Clock Out each need a fresh fix inside the radius. Tests: `attendance-check-in` › Clock In is refused before Check In…, geofence on….
  - *Fake or replayed location.* Evidence is evaluated server-side only (`evaluateLocationEvidence`, @rab/shared): lat/lng + accuracy + device `capturedAt` required; accuracy ≤ min(`GEOFENCE_MAX_ACCURACY_M`, venue radius); `capturedAt` within `LOCATION_EVIDENCE_MAX_AGE_SECONDS` (120) and ≤ 30 s in the future; each step's fix must be strictly newer than the previous step's (check-in → clock-in → clock-out / geofence exit). A device can still spoof GPS itself (residual; QR + check-in raise the bar, they do not eliminate it). Tests: stale, future, replayed at clock-in and clock-out, accuracy, outside.
  - *Misconfigured venue silently allowing everyone.* Enforced geofence with no usable lat/lng/radius → `GEOFENCE_MISCONFIGURED` (strict policy). Test: geofence enforced but the venue has no coordinates….
  - *A manager clocking someone in who is not there.* On-behalf clock-in requires the staff member's OWN Check In for that booking (`STAFF_NOT_CHECKED_IN`), and at an enforcing venue that Check In must be geofence-verified (`PRESENCE_NOT_VERIFIED`); the manager's phone location is never used. On-behalf clock-out at an enforcing venue is refused (`PRESENCE_EVIDENCE_REQUIRED`) — the staff member clocks out on their phone or the manager uses the reviewed "Record attendance" correction after the shift. Reason ≥ 10 words; `clock_in_by/clock_out_by`, reason, `manager_on_behalf` provenance and SERVER time stored on the row (DB CHECK pins them together) and in `audit_log`. Tests: VM clock-in on behalf…, geofence + manager….
  - *Out-of-scope manager or staff using the routes.* Guard → service permission re-check → `canReadShift` scope (other-venue VM, other-workspace VM, unknown staff: 404) → workspace-bound transaction → RLS; staff tokens 403; `organisationId` in a body 400; staff check-in resolves the booking from the session (someone else's shift 404). Tests: on-behalf scope…, scope and state….
  - *Races.* Check In is a compare-and-set under the booking row lock and idempotent (repeat returns the original, no new timestamp/audit). Staff and manager clock-in take the same shift → booking locks and the UNIQUE `attendance.shift_assignment_id`; clock-out is the shared status compare-and-set: exactly one wins (tested concurrently). The worker never flags a checked-in seat as a no-show and re-reads `checked_in_at` under the row lock (worker test: check-in committing mid-cycle wins).
  - *Data minimisation.* Check In stores only source, verified flag, rounded distance/accuracy and capture time — no coordinates (tested: no lat/lng in the row or the audit metadata). Clock In/Out keep the pre-existing coordinate columns (unchanged practice).
- **Security trade-offs (for owner veto):** (1) Rollout: bookings that existed at migration time (`check_in_required = false`) keep the old flow AND the legacy geofence behaviour (lat/lng only; a misconfigured enforcing venue fails soft, unverified) so active attendance is never stranded; every later booking is strict. (2) Check In opens with Clock In (`CLOCK_IN_EARLY_MINUTES`) and closes at the QR post-shift grace — a check-in hours after start is accepted (the worker's provisional no-show at +30 min blocks it in practice). (3) A checked-in staff member who never clocks in is never flagged by the worker; the manager must clock them in, record attendance or confirm the no-show (shown as `attendance_missing` after the booking's end). (4) `attendance` and `shift_assignment` still have only the tenant-level RLS predicate (no staff-own second predicate) — pre-existing; staff scoping is enforced in the service.
- **Residual:** no realtime event for check-in/on-behalf punches (clients poll as today); GPS spoofing on a rooted device; the auto geofence-exit keeps its own (lenient-on-misconfiguration) 409.
- **Mobile client (rab-mobile, 2026-10-21):** the app never decides presence; it only gathers evidence and renders server state. Location is requested only when the shift's `geofenceEnforced` is true (unknown from an older server → previous behaviour); background geofence-exit monitoring is not started for a venue known not to enforce it. Venue Manager on-behalf actions are shown only with `attendance.edit` and pre-explain the known refusals (no Check In, unverified Check In at an enforcing venue, clock-out at an enforcing venue) without sending a request; the server stays authoritative for all of them. **Security trade-off (for owner veto):** `capturedAt` is sent as `serverNow-anchor − (deviceNow − fix.timestamp)` — the fix's age measured on the device, placed on the server's timeline — so a phone whose wall clock is minutes off is not refused as `LOCATION_STALE` on every step. This does not weaken the server check (a client can send any `capturedAt` anyway; the server still bounds age/skew/replay), but it means the server's freshness check measures the client-reported age, not the device clock. Alternative: send the raw device timestamp and accept refusals on skewed phones.

## Replacement & standby offers on the ORIGINAL shift (2026-10-21, server + worker + web; migration 1786719400000 on the test DB only)

Migration `1786719400000-OfferKind`: `job_offer.offer_kind text NOT NULL DEFAULT 'standard'` + value CHECK (`standard|replacement|standby`), core and every workspace schema (metadata-only default, no new table/FK/index/policy; existing ENABLE+FORCE RLS on `job_offer` unchanged; provisioner counts unchanged). Routes: `GET /rest/v1/shifts/:shiftId/replacement-context` (new read), `POST /rest/v1/shifts/:shiftId/offers/bulk` with `mode: 'replacement'` (existing endpoint, new optional intent field) — both `@ManagerApplication()` + `PermissionGuard(offer.send)`.

- **Asset:** who gets booked (and paid) on another person's vacated seat; shift capacity; the no-show history of the absent staff member.
- **Threats and controls:**
  - *Sending offers on another manager's / workspace's shift, or probing ids.* Guard → service re-check of `offer.send` (`loadReplacementShift`, so jobs/other services cannot skip it) → shift must be the caller's own (`created_by`) in the caller's own workspace and organisation, else 404 (never 403) → workspace-bound transaction → `shift`/`job_offer`/`shift_assignment` RLS. Malformed ids are 404 (UuidPathParamsInterceptor). Tests: `replacement-standby-offers` R11 (same-org other workspace + other org: 404 on context and send, nothing written), R14.
  - *Selecting staff outside the workspace.* Per-recipient check `staff_profile.workspace_id = shift.workspace_id` on top of RLS; the recipient is refused (no offer, no notification). Test: R12.
  - *Capability escalation by a Venue Manager.* No `offer.send` and not a manager-web application → 403 on both routes. Test: R13.
  - *Mass assignment / client-chosen kind.* `mode` is an intent (`standard|replacement`), never a kind or a status; the server decides `replacement` (vacant seat) vs `standby` (no vacant seat) under the shift row lock. `mode: 'standby'`, an `offerKind` field, or per-staff times in replacement mode → 400. Test: R6.
  - *Overstaffing / double booking.* Approval (`applyOfferConfirmation`, shared by the manager click, auto-confirm and the timeout worker) claims the seat in ONE `UPDATE … WHERE effectiveFilled < required_count` under the shift row lock, with effectiveFilled = GREATEST(live occupied seats, filled_count − confirmed no-shows): a manager-CONFIRMED no-show frees its seat, a provisional one does not; for a shift without confirmed no-shows this equals the previous `filled_count` check, and drifted counters can only make it stricter. Tests: R8 (two accepted replacements for one vacancy approved concurrently: one 201, one 409, occupied = required), R9 (standby refused with 409 "No vacancy — the original staff member is still assigned" while the absence is provisional; allowed once confirmed).
  - *Standby silently turning into a booking.* Standby/replacement offers never auto-confirm on accept (even on a request-born shift); a standby acceptance gets no manager-confirmation-timeout pointer and the worker ignores any stray one. Tests: R7, R9, worker `replacement-standby-timeout` W1.
  - *Duplicate sends / retries.* Per-recipient "already offered this shift" (shift row lock serialises concurrent submits); worker retries go through the existing `worker_event` claim + offer-status CAS. Tests: R5 (two concurrent submits → one offer, one notification), W2 (timeout cycle run 3× incl. 2 concurrent → one confirmation, one audit, one notification, one seat).
  - *Erasing the absent person's record.* The no-show assignment is never updated, deleted or re-statused; the replacement is a separate assignment + offer on the same shift id. Tests: R4, R7, W2.
  - *Paying unworked time.* A replacement sent after the shift started is booked from the database time of sending, re-anchored to the approval time if later; attendance (and pay) still come only from their own check-in/clock-in. Test: R7 (period starts after the original start, no attendance row at booking).
- **Security trade-offs (for owner veto):** (1) Replacement/standby acceptances on a directly-created shift still follow the existing manager-confirmation timeout (system auto-confirm after the configured minutes) — standby is excluded; (2) the manager may send more replacement offers than vacancies (as for ordinary sends) — capacity is enforced at approval, losers stay `staff_accepted` until rejected/expired; (3) sending is allowed until the original shift's scheduled end (stricter than the generic end + 5 h offer window), with no minimum remaining time beyond the break length.
- **Residual:** `reopen-no-show` (attendance module) does not yet check whether a replacement has taken that seat — reopening after a replacement was booked can leave occupied > required for that shift (no double pay without real attendance, but the seat count is over). `job_offer.offer_kind` has no staff-own second RLS predicate (pre-existing table posture).
- **Amendment (same day):** reopening a confirmed no-show is refused (409 `SEAT_TAKEN_BY_REPLACEMENT`) once a replacement holds the freed seat — decided under the shift row lock with agent R's `loadShiftVacancy`, so concurrent replacement approvals and reopens serialise (test: `manual-attendance` › Reopen no-show is refused once a replacement holds the freed seat…).

## Native iPhone client (packages/rab-iphone) — session and credential handling (2026-10-22)

- **Surface:** a second mobile client on the existing mobile auth contract (no new server endpoints). Email/password login only (Google/Microsoft remain browser-only); `X-Client-Platform: mobile` on every request; `/auth/me` is the identity source, capabilities are display hints only.
- **Threats and controls:**
  - *Refresh-token reuse revoking the session family / token theft:* refresh is single-flight; the rotated refresh token is persisted before the access token; replay of the failed request at most once and only within the same identity generation; tokens live only in Keychain (`AfterFirstUnlockThisDeviceOnly`, no iCloud sync), never UserDefaults/logs.
  - *Stale-account data / late refresh after logout:* identity epoch + generation counter; responses from a previous epoch are dropped; logout deactivates the push device, revokes the refresh token (10 s bound), then wipes Keychain and per-session files.
  - *Bearer leakage to storage hosts:* `/files/:id/download` 302s are followed manually without the Authorization header.
  - *Biometric bypass:* Face ID/Touch ID is a local unlock of an existing valid session only; the password is never stored.
  - *Unsafe retries:* no Idempotency-Key exists server-side, so clock-in/out, accept/decline and shift requests are never auto-retried; ambiguous outcomes re-fetch state first.
  - *Transport:* Release builds refuse to start without an HTTPS API base URL; any ATS exception is Debug-only.
- **Not yet verified:** the app has not been compiled or run (Windows host has no Swift/Xcode). APNs entitlement, Team ID, bundle id and API host are placeholders.

## Native iPhone client — Staff and Venue Manager features (2026-10-22)

- **Surface:** the same server routes the Flutter app uses; no new endpoints. Access is decided server-side; capabilities only hide buttons.
- **Threats and controls:**
  - *Venue Manager seeing other people's attendance and identity:* data comes only from the manager's own directory, shift report and offer routes, which already enforce venue scope and RLS; nothing is cached across sign-in identities. `chargeRatePence` is not decoded by any iPhone model.
  - *Duplicate clock-in/out or offer actions:* every mutation defaults to no retry; a timeout re-fetches attendance/offer state before showing a result. Send Shift locks after an uncertain result until Sent Shifts is checked.
  - *Location over-collection:* a single location fix is taken only at the moment of a check-in/clock action at a geofenced venue (when-in-use only); no background location, no geofence monitoring.
  - *QR handling:* the scanner reads a check-in code and sends it to the server for verification; the app never generates staff QR codes.
  - *Payroll and timesheet integrity:* worked minutes are never computed on the phone; record attendance starts with empty times and echoes the server attendance version (optimistic concurrency); no automatic signing or timesheet generation.
  - *Downloaded PDFs (payslips, statements, reports):* written to the per-session temporary folder, wiped on sign-out, then handed to the share sheet at the user's request. Once shared, the copy is outside app control.
  - *Test stubs:* the canned UI-test backends are `#if DEBUG` and gated on two launch arguments; they do not exist in Release binaries.
- **Security trade-off (vetoable):** background polls (Sent Shifts 5 s, Teams 30 s, Staff refreshes) send `X-Crewflow-Background: 1`, so they never extend the idle session. This is stricter than Flutter and means an app left open but untouched signs out on schedule.
- **Not yet verified:** nothing compiled or run; no device camera, location, Face ID or UI test has been exercised.


## Worker bundle: ordinary jobs + workspace provisioner in ONE Worker container (2026-10-22, packaging only; no migration)

Four core deployment services (API, Worker, Redis, PostgreSQL) instead of five: the former always-on `rab-provisioner` service now runs as a second supervised OS process inside the Worker container (`packages/rab-docker/rab/Dockerfile.worker-bundle`, launcher `packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs`). Both existing entrypoints (`rab-worker/dist/main.js`, `rab-worker/dist/workspace-provisioner.main.js`) and the provisioning logic are unchanged; the only source change is an additive per-instance heartbeat file (`rab-worker/src/core/runtime/instance-heartbeat.ts`, `WorkerRuntime.progress()`), a no-op unless `CREWFLOW_INSTANCE_HEALTH_FILE` is set. Evidence: `CREWFLOW_FOUR_SERVICE_WORKER_BUNDLE_REPORT.md`, `docs/evidence/worker-bundle-2026-10-22/`.

- **Asset:** the privileged `crewflow` credential (owns the business tables, can `CREATE SCHEMA`, executes `core.provision_workspace_schema`) and the code that runs with it; previously isolated by a container boundary from the ordinary jobs process, which handles attacker-influenced input (email/push payloads, report HTML rendered by Chromium, storage objects).
- **Changed trust boundary (stated plainly):** jobs and provisioner now share one kernel namespace set, one network namespace, one `/dev/shm`, one Redis, one restart/resource fate, and a root supervisor that holds the provisioning credential in its environment. This is weaker than separate containers. A kernel or container-runtime escape from the jobs process now lands next to the credential instead of in a different container.
- **Threats and controls:**
  - *Compromised jobs process reads the provisioning credential.* The credential is never in the jobs environment (explicit allowlist, `process.env` never inherited; tested on the real `/proc/<pid>/environ`). The jobs UID (1000) cannot read the provisioner's or the launcher's/PID 1's `environ`, `mem` or `fd` (different UID; no `CAP_SYS_PTRACE`/`CAP_DAC_*`), cannot list the provisioner's 0700 temp dir, and no readable file anywhere in the container contains the password (whole-filesystem grep as uid 1000). No dotenv file is packaged (build-time check + launcher preflight). Tests: launcher test 22; integration 13, 14, 28.
  - *Compromised jobs process rewrites code the provisioner then executes as `crewflow`.* All of `/app` (code + `node_modules`) and `/opt/crewflow-bundle` are root-owned and not group/other-writable (verified: 0 files otherwise); the root filesystem is read-only; each child writes only its own tmpfs dirs. Writes were refused both with `read_only` (EROFS/EACCES) and, on a writable root, by ownership alone (EACCES). Tests: integration 14, 28; launcher preflight refuses child-writable code (test 24).
  - *Compromised jobs process signals, stops or impersonates the provisioner.* Different UID, no capabilities (CapEff/CapPrm/CapAmb = 0, NoNewPrivs = 1, no supplementary groups), so `kill`, `ptrace` and `/proc` access are refused; it cannot forge the provisioner's per-instance heartbeat (directory owned by 10001). Tests: integration 12, 14.
  - *Misrouted credentials (privileged URL on the jobs process, runtime URL on the provisioner, connections to different clusters).* Launcher refuses by name only: `DATABASE_URL_UNPOOLED`/migration/bootstrap variables on the service, wrong login per URL, database-name mismatch, Neon pooler where a direct connection is needed. The existing live guards still run in each child (`runtime-database-guard`, `assert-runtime-db-role`, `hws-startup-guard`), and the launcher additionally compares the cluster/database both children's own live probes reported. Tests: launcher 1–13, 20, 21; integration 18 (jobs guard intact), 26, 27 (different cluster refused; a SUPERUSER posing as `crewflow_app` refused by the live role guard).
  - *Runtime credential performs provisioning DDL / cross-workspace reads.* Unchanged and re-verified on the bundle: `crewflow_app` gets permission-denied / must-be-owner for CREATE SCHEMA, CREATE TABLE, DROP, DISABLE RLS, `core.provision_workspace_schema`, `SET ROLE crewflow`; RLS returns 0 rows without context and for another workspace's context. Test: integration 17.
  - *Duplicate provisioning by two Worker replicas.* Unchanged session advisory lock + registry row lock; 6 workspaces raced by two bundles → exactly one registry row and one schema each. Test: integration 21.
  - *A dead/hung child hidden behind a healthy replica.* Health is per instance and covers both roles (fresh event-loop heartbeat, recent settled + successful cycle, recent Redis write, no hung cycle) from files only this container's children can write; the global Redis keys stay global (documented masking). A hung child is ended by the launcher's watchdog (stale heartbeat), so the platform's restart policy replaces the service. Tests: launcher 19, 26–28; integration 22.
- **Security trade-offs (for owner veto):**
  ```
  SECURITY TRADE-OFF
  Decision:   Run the workspace provisioner (privileged `crewflow`) as a second process inside the Worker container,
              under a root supervisor, instead of as its own container/service.
  Reason:     Owner goal of four core deployment services; the separate provisioner service was a fifth always-on card.
  Risk:       A container/kernel escape or a Linux privilege-escalation bug reachable from the jobs process (which parses
              untrusted input and runs Chromium) now reaches a namespace where root holds the provisioning credential;
              shared /dev/shm, network namespace and Redis; one OOM or restart takes both roles down.
  Mitigation: Distinct non-root UID/GID per child, no capabilities, no-new-privileges, read-only root-owned code,
              per-child 0700 tmpfs, explicit env allowlists, no dotenv, no Docker socket/host PID/privileged mode, the
              launcher's only capabilities are SETUID/SETGID/KILL; all existing DB identity/RLS guards unchanged.
  Reversal:   Restore the separate rab-provisioner service (runbook section 12.6) — packaging only, no schema/role change.
  ```
  (2) The launcher runs as root (only SETUID/SETGID/KILL) and keeps the provisioning URL in its own environment for the container's lifetime; anyone with Docker/OpenShip access to the container's configuration sees it, as before. (3) `docker exec` into the Worker container inherits the container environment, which now includes the provisioning URL — an operator shell is privileged by design. (4) The shared image's `chown -R` adds ~1.1 GB to the Worker image.
- **Residual:** both children share Redis (the jobs process can still write the global `rab:workspace-provisioner:heartbeat` key, as before); `/dev/shm` is shared (Chromium runs with `--disable-dev-shm-usage`); OpenShip support for `user`, `read_only`, tmpfs uid/mode options, `cap_add`/`cap_drop`, `security_opt`, `stop_grace_period`, health checks and `additional_contexts` is UNVERIFIED (no access) — if any is dropped, the deployment must stop and be reported, not weakened.
- **Also (same change):** `runtime-database-guard.ts` now refuses a non-empty `CREWFLOW_PROVISIONER_DATABASE_URL` in the api/worker/provisioner environment (only the launcher may hold it; spec 8d2, integration 11b/18). Finding (LOW, pre-existing, not fixed): the provisioner's single pg `Client` has no `'error'` listener, so a database connection drop crashes it — in the bundle this also restarts the jobs process (integration 30: 4 restarts during a 77 s outage, bounded by the launcher's 30 s failure-exit delay).


## Server-path workspace provisioning (Twenty-style) — STAGED behind two owner gates (2026-10-22)

Proposal + tested foundation only. Nothing is applied to any shared, dev or production database, and the default compose
topology is unchanged. Report: `CREWFLOW_TWENTY_ARCHITECTURE_PARITY_REPORT.md`. Evidence: `docs/evidence/server-path-provisioning-2026-10-22/`.

- **What it does:** `POST /rest/v1/manager-workspaces` (existing route, JwtAuthGuard + manager application) creates the
  workspace row and then, on the same request and the same restricted `crewflow_app` connection, calls
  `core.provision_workspace(uuid)` — a narrow SECURITY DEFINER function (migration staged at
  `packages/rab-server/src/database/typeorm/core/proposed-migrations/1786719500000-ServerPathWorkspaceProvisioning.ts`,
  outside the loaded `migrations/` glob until approved). It builds the frozen V1 workspace template, binds every table to
  the workspace with a CHECK, verifies the structure in the same transaction and marks READY. No privileged connection or
  credential exists in the API; the Worker would no longer need one (gate 2).
- **Update (N1, 2026-10-22):** the migration has since moved into the loaded `core/migrations/` glob for the dev cutover
  (G1 approved for DEV only), together with the one-off `HwsHistoricalRowsPrivilegedCopy1786719520000`. The statement
  above that it sits outside the glob is no longer true. Control: the guarded runner now refuses, as a whole and before
  any DDL, a production-target run with any pending migration not on the reviewed production approval list
  (`core/production-migration-approval.ts`: baseline through 1786719300000, plus explicit by-name approvals — none
  yet). Tests: `production-migration-approval.spec.ts`. Runbook: `docs/PRODUCTION_RELEASE_RUNBOOK_2026-10-22.md` §7.0 1a.
- **Asset:** DDL authority over workspace schemas (table ownership by `crewflow`, schema CREATE), the READY/FAILED lifecycle
  attestation, and tenant isolation of the new tables (FORCE RLS).
- **Who can call it:** only `crewflow_app` (EXECUTE) and its owner `crewflow`; PUBLIC revoked. Inside it, the caller's
  server-bound GUCs (`rab.organisation_id`, `rab.user_id`, set by `TenantContextService` from the verified session — never
  client input) must equal the workspace row's organisation and owner, read AS `crewflow` under `manager_workspace` RLS.
- **Threats and controls (all tested on a throwaway PostgreSQL 16 as the real `crewflow_app` login):**
  - *Runtime role gains DDL.* It does not: still owns nothing, no CREATE on the database/`core`/any workspace schema, no
    membership in `crewflow`/`rab_secure_owner`, cannot ALTER/DROP/DISABLE or NO FORCE RLS, cannot create/drop policies or
    triggers, cannot replace/alter/re-grant the function, cannot SET ROLE / SET SESSION AUTHORIZATION, still cannot EXECUTE
    `provision_workspace_schema`, the four lifecycle mutators, the verification helper or the worker discovery functions
    (db spec, 26 cases). The migration's own verification block refuses to record itself otherwise.
  - *Arbitrary SQL / identifier injection.* Input is one `uuid`; the schema name is derived (`workspace_<32 hex>`, regex
    checked); the template is a migration-frozen literal; the only dynamic SQL is `format('%I…%L')`. A non-uuid is refused
    by the type (22P02); NULL 22004; nil/unknown uuid P0002.
  - *Provisioning someone else's workspace (IDOR) / cross-tenant.* Other organisation, same organisation other owner, the
    victim's owner id under another organisation's binding, no binding → all P0002 (HTTP 404) and the victim untouched;
    service layer re-checks owner + organisation first (API spec).
  - *Forging READY without a real schema (plan §8A.9 Check A).* READY is written only by the function, after its own
    structural verification (table/FORCE/owner/index/policy/FK/CHECK counts and values, schema owner) in the SAME
    transaction as the DDL. Tampering injected mid-transaction (a dropped policy, a dropped table, FORCE removed) is
    detected: everything rolls back and FAILED records a fixed label. A READY workspace is never re-provisioned; drift on a
    READY schema raises CWV02 and changes nothing.
  - *Races / replays.* Per-workspace transaction advisory lock + row locks: 3 concurrent DB callers and 3 concurrent HTTP
    requests over two API replicas → one schema, READY exactly once (audit `manager_workspace.provisioned` = 1); a
    duplicate/retried create with the same body is an idempotent replay (no second workspace); a different body is still 409.
  - *Partial failure / crash / outage.* Template failure, lost connection mid-template (backend terminated while blocked)
    and statement failure all roll back to zero objects; the response is 201 with the real lifecycle state (never a 500 for
    these); a retry from FAILED or stranded CREATING succeeds. Correctness never depends on Redis (API booted with Redis
    unreachable and the Redis cache ON: READY once).
  - *Search-path / temp-object shadowing by the caller.* search_path pinned `pg_catalog, pg_temp`, every relation
    schema-qualified; a caller that creates temp tables named `manager_workspace`/`workspace_schema_registry`/`shift` first
    changes nothing; zero dependencies of workspace objects on temp schemas.
  - *Error leakage.* FAILED stores only a fixed label or a SQLSTATE (an injected error containing "password=…" is not stored
    or audited).
- **Residual risks:** (1) a caller who is a Manager without a workspace can make the database run the fixed template for
  their own one workspace (bounded: one workspace per manager, idempotent); (2) provisioning takes ShareRowExclusive locks on
  referenced core tables (`core.user`, `organisation`, ...) for ~1 s inside the request — same footprint as the Worker
  provisioner, now on the request path; (3) the function runs with `crewflow` authority, so a bug in its FIXED body would run
  as `crewflow` — mitigated by review, the frozen template, and the parity test (identical catalog to the TypeScript
  provisioner); (4) the function's owner is the LOGIN role `crewflow`, not a NOLOGIN owner (see trade-off 1).
- **Security trade-offs (for owner veto):**
  ```
  SECURITY TRADE-OFF
  Decision:   Grant the restricted runtime role crewflow_app EXECUTE on ONE DDL-performing SECURITY DEFINER function,
              core.provision_workspace(uuid), owned by crewflow (the migration/ownership identity).
  Reason:     Twenty-style topology: the API creates the workspace in the request that activates it, with no separate
              provisioner service/process and no privileged credential in any runtime environment.
  Risk:       Code running as crewflow_app (an API RCE or SQL injection) can trigger the fixed V1 template for the caller's
              OWN CREATING/FAILED workspace, and a defect in the fixed function body would execute with crewflow's DDL
              authority. Owner = crewflow (LOGIN) rather than a NOLOGIN owner: tables created in a DEFINER function are owned
              by its owner, and every existing workspace's tables are crewflow-owned.
  Mitigation: uuid-only input; derived schema name; frozen template; in-function trusted-state checks (row exists,
              lifecycle, org + owner = server-bound GUCs, active); advisory lock; same-transaction verification before
              READY; pinned search_path; PUBLIC revoked; lifecycle mutators and provision_workspace_schema still denied;
              migration self-verification; 26 DB + 11 API + 1 no-Redis tests on the real runtime login.
  Reversal:   Keep the Worker provisioner (default today): leave the migration staged, or run its down() to drop both
              functions; the API then answers CREATING and the provisioner completes it.
  ```
  ```
  SECURITY TRADE-OFF (Phase 7, test-only, not wired into any default compose file)
  Decision:   An opt-in api prestart (packages/rab-docker/rab/api-prestart.sh) that, only when
              CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations is set for that deploy, runs pending migrations with a
              one-time credential before main.js starts.
  Reason:     Twenty parity (migrations triggered by the server start) without automatic privileged migration.
  Risk:       The one-time credential sits in the api service's orchestrator config for that deploy and in PID 1 until
              the migration child exits; a restart before the operator removes it re-runs the (no-op) step.
  Mitigation: Disabled by default; refuses the credential without approval; env -i allowlist for the child; advisory lock;
              fail closed (main.js never starts after a failed step or with migrations pending); exec env -u scrub proven
              on /proc/1/environ; runtime-database-guard refuses any migration variable in api/worker.
  Reversal:   Do not adopt it; keep the one-shot rab-migrate service as the only migration path.
  ```

## HWS dev cutover: backfill fidelity fixes + one-off privileged copy (2026-10-22, rab-devdb ONLY, owner-approved)

Owner decision: Option 1 (one-off approved copy) for historical rows the workspace tables' runtime-actor policies reject;
development migration of rab-devdb approved; production NOT approved; HWS_RUNTIME_ENABLED NOT enabled; no container restarted.
Report: CREWFLOW_TWENTY_ARCHITECTURE_PARITY_REPORT.md §15. Evidence: docs/evidence/server-path-provisioning-2026-10-22/dev-cutover-apply/.

- **Asset:** historical payroll approvals, attendance, timesheets, reviews and their audit trail; tenant isolation of the
  copies; the restricted runtime role.
- **Threats and controls:**
  - *Silent data loss in the cutover (visibility under-count).* `hws:backfill` now reads source and target with the
    workspace owner bound (all policies PERMISSIVE: binding only adds visibility) and `--verify` FAILS unless the visible
    count equals the TRUE count recorded by the privileged census (migration identity, audit_log
    `workspace.hws_backfill_privileged_copy`); no census = fail. Full-row comparison at full precision (canonical jsonb text).
  - *Precision / value drift (timestamps, money).* Rows are copied as jsonb text through `jsonb_populate_record` against the
    target row type; nothing passes through JS Date/number. Verified 292/292 identical at full precision on rab-devdb, plus
    per-table/per-workspace counts, sorted-id digests and money/minutes sums (80/80 equal).
  - *Authority escalation to copy actor-bound rows.* The copy of shift_staff_review + the payroll family runs ONLY as the
    one-off migration `HwsHistoricalRowsPrivilegedCopy1786719520000` through the guarded runner as the migration identity
    (must be SUPERUSER/BYPASSRLS — refuses otherwise). It adds no policy, grant, function, role or GUC bypass: the full
    security posture was byte-identical before and after it (608 lines, rab-devdb and every rehearsal). crewflow_app is
    unchanged by it. The runtime tool never writes these tables.
  - *Forcing a mismatch through.* The migration verifies all 21 workspace tables against core at full precision in its own
    transaction and raises on any difference (rolls back, no audit row); the runtime verify independently fails.
  - *Loss of rollback.* Core rows are never modified or deleted (verified: every core business/platform table unchanged;
    only migrations, backfill checkpoints and 4 audit rows grew). With HWS off nothing reads the copies.
- **Residual risks:** (1) the one-off migration is in the canonical chain: on another database it needs an RLS-exempt
  migration identity (Neon's bootstrap role is unverified) and it skips (audits) workspaces never backfilled — those then
  need a newly approved step; a backfilled workspace that differs from core makes it raise and block the chain until fixed;
  (2) the census is a snapshot: any core change after it makes `--verify` fail until re-reconciled (intended, fail-closed);
  (3) until HWS is enabled, new writes land in core only — enabling HWS later requires a fresh reconciliation first.
- **Security trade-off (for owner veto):**
  ```
  SECURITY TRADE-OFF
  Decision:   Copy historical shift_staff_review / payroll rows with an RLS-exempt migration identity (one-off migration),
              not through the runtime-actor policies.
  Reason:     Those policies are actor-bound (reviewer = current user; payroll inserts must be pending_approval), so a
              historical row authored by someone else or already approved can never be written through them without
              inventing a permanent bypass (rejected) or falsifying the actor/state (rejected).
  Risk:       The migration identity bypasses RLS while it runs; a bug in its fixed body could write into the wrong workspace.
  Mitigation: Destination = authoritative core.workspace_id -> registry schema (canonical name checked); FK + CHECK
              (<table>_workspace_bound) enforced by PostgreSQL; ON CONFLICT DO NOTHING; full-precision verification of all
              21 tables before commit; audit row per workspace; posture diff proves no privilege change; rehearsed 3x on
              restored copies before rab-devdb.
  Reversal:   down() deletes only the copied rows (core untouched); or restore the verified backup.
  ```

## Foundation fixes P1–P3: audit identity scope, first-admin bootstrap, core object ownership (2026-10-22)

Migrations `1786719600000-ReconcileSuperuserOwnedCoreObjects`, `1786719610000-AuditLogRecordedIdentityOrganisationCheck`,
`1786719620000-BootstrapFirstPlatformAdminFunction`. Report: `CREWFLOW_FOUNDATION_FIXES_REPORT.md`.

### P1 — audit entries naming another organisation's users

- **Asset:** integrity and attribution of the insert-only audit trail; tenant isolation of identities recorded in it.
- **Who can write:** every service through `AuditService.record()` (crewflow_app), Worker jobs inserting directly, CLIs
  (crewflow), migrations (bootstrap superuser).
- **Threat:** a scoping bug upstream (or a direct SQL writer) records org B's user as actor/target of org A's entry —
  forging cross-tenant attribution. Before this fix the only check was "the id exists anywhere"
  (`core.audit_existing_user_ids`) and the database had no rule at all.
- **Controls now:** service pre-check `core.audit_identity_violations(actor, target)` against the transaction's bound
  organisation; BEFORE INSERT/UPDATE trigger `audit_log_recorded_identities` (SECURITY DEFINER, `rab_secure_owner`) enforcing
  the same single rule function for every role incl. the table owner and superuser (23503); the organisation-parameterised
  rule function is executable by no login role (no membership oracle); no tenant context → every id is a violation.
  Exception: an ACTIVE platform-admin actor (grant/revoke, suspension, organisation/CEO creation, Initial Manager
  replacement, Admin Inspect). Revoked admins and actor-less system entries get no exception.
- **Unchanged:** FORCE RLS + `audit_log_tenant`, insert-only grants, no re-validation of existing rows, user deletion.
- **Residual:** `audit_existing_user_ids` kept (still EXECUTE for crewflow/crewflow_app) for rolling-deploy compatibility
  with images built before this change; drop it in a later migration once no deployed image calls it. An active platform
  admin can still attach any organisation's user to an entry in any organisation — by design, platform admins are global.

### P2 — first Platform Admin bootstrap without a superuser

- **Asset:** platform-wide administrator authority.
- **Who can call `core.bootstrap_first_platform_admin`:** only `crewflow` (and a superuser). PUBLIC and `crewflow_app` have
  no EXECUTE, so no API/Worker request path can reach it.
- **Threats and controls:**
  - *Minting extra/replacement admins:* one-time inside the database — ALREADY_BOOTSTRAPPED once an active admin exists,
    CLOSED once any platform_admin row has ever existed; nothing is written in either case.
  - *Races (two boots/replicas):* `pg_advisory_xact_lock(hashtext('rab_bootstrap_platform_admin'))` inside the function,
    held to commit; exactly one admin/user/invite under 3 concurrent runs (tested).
  - *Credential in env:* none — new admin is INVITED with no password; activation is the existing emailed single-use token.
  - *Silent failure:* CLI now exits non-zero when any command throws (nest-commander's default exited 0).
  - *Audit:* `platform_admin.bootstrapped` (actor NULL, target = admin, same organisation) + `user.invite_queued`.
- **Residual:** a stolen `crewflow` credential on a database that has NEVER had a platform admin can create the first one
  (it already owns most tables, so this adds little). `grant-platform-admin` still assumes the retired `rab_owner` and
  needs a superuser — out of scope, flagged.

```
SECURITY TRADE-OFF
Decision:   Give the LOGIN role crewflow EXECUTE on a SECURITY DEFINER function owned by rab_secure_owner that can create an
            organisation, a user and the first platform_admin row.
Reason:     The stricter option (superuser-only bootstrap) is exactly the undocumented manual superuser step the owner asked
            to remove; crewflow_app must never get it; crewflow is already the operator/provisioner identity.
Risk:       Whoever holds the crewflow password on a never-bootstrapped database becomes the first platform admin.
Mitigation: One-time in the database (CLOSED/ALREADY_BOOTSTRAPPED), advisory lock, input validation, PUBLIC and
            crewflow_app revoked, audited, INVITED-without-password + emailed activation.
Reversal:   REVOKE EXECUTE ... FROM crewflow and run bootstrap as the bootstrap superuser again.
```

**Owner decision flagged (permissions rule):** the bootstrap is now strictly one-time. Before, it re-opened whenever no
ACTIVE admin existed (e.g. after every admin was revoked). Recovery after all admins are revoked is now a deliberate DBA
action, never an env-driven boot side effect. Veto → change the `CLOSED` branch to fall through.

### P3 — superuser-owned `core.navigation_layout`

- **Threat:** phase-B migrations run as the bootstrap superuser; any object created without `OWNER TO` belongs to the
  superuser (SECURITY DEFINER objects would run with superuser authority) and the posture drifts on every fresh install.
- **Controls:** `ReconcileSuperuserOwnedCoreObjects1786719600000` hands superuser-owned core objects to `crewflow`, refuses to
  guess for NOT-FORCE RLS tables and SECURITY DEFINER functions, and verifies nothing superuser-owned remains; static spec
  `migration-object-ownership.spec.ts` requires OWNER TO for every core object created by later migrations; integration
  `core-object-ownership` + `db-security-posture` check the database.

## Flutter mobile secure storage: device-only Keychain + reinstall wipe (F2, 2026-10-23, Wave 1 Lane M)

- **Asset:** the mobile session (`rab.accessToken`, `rab.refreshToken`, `rab.sessionUserId`) and the biometric binding /
  remembered account that gate biometric re-auth.
- **Threats:** (1) iOS Keychain items outlive an uninstall, so a reinstall silently resumes the previous install's session;
  (2) the plugin default `kSecAttrAccessibleWhenUnlocked` is not device-only, so items can move to another device via an
  encrypted backup or device migration.
- **Controls:** one shared `appSecureStorage` (`packages/rab-mobile/lib/core/storage/secure_storage.dart`) with
  `first_unlock_this_device` + `synchronizable: false` on iOS and the v11 hardened Android cipher (byte-identical to the
  pre-F2 defaults, so no Android migration); a test forbids any other `FlutterSecureStorage` construction under `lib/`.
  `SecureStorageBootstrap` runs in `main()` before any token read: install marker file (Application Support, deleted on
  uninstall) + keychain sentinel; marker absent with sentinel present → `deleteAll()`. Pre-F2 iOS items are re-written with
  the new accessibility (same keys/values, no forced logout). Android storage already dies with the app and
  `allowBackup="false"`.
- **Residual / trade-off:** a reinstall whose previous install was a pre-F2 iOS build resumes once (no such Flutter iOS
  build ever shipped; see the SECURITY TRADE-OFF block in `WAVE1_LANE_M_REPORT.md`). Same-device encrypted-backup restore
  brings back items and marker, exactly like the native app.
- **Tests:** `packages/rab-mobile/test/secure_storage_config_test.dart` (options, single-instance scan, reinstall wipe,
  no wipe on restart/update, legacy migration, fail-closed marker error, logout clearing).

## Wave 1 Lane A: credentialed origin trust, login limiter, password-off revocation, MFA gate wiring, legacy JWT key (2026-10-23)

Full findings (§5.8 format), tests and evidence: `WAVE1_LANE_A_REPORT.md`, `docs/evidence/wave1-lane-a/`. No migration.

### D-C1: credentialed CORS / CSRF trust of any workspace-shaped sibling host
- **Threat:** JavaScript on any `<label>.<WORKSPACE_BASE_DOMAIN>` host, including reserved operational hosts (`api`, `admin`,
  `mail`) or a taken-over or third-party sibling, could make credentialed requests with a victim's `SameSite=None` cookies.
- **Controls:** `EnvironmentService.isTrustedOrigin` trusts the wildcard only when `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true`
  (default false; boot refuses true without `WORKSPACE_BASE_DOMAIN`). When the flag is on, it never trusts `RESERVED_SUBDOMAINS`,
  `xn--` labels, a non-canonical Origin (path, userinfo, case, trailing slash) or another port, and it trusts only https in production.
  The one predicate feeds CORS, cookie CSRF, login/refresh provenance, `/auth/refresh` and the OAuth handoff.
- **Residual:** while the flag is on, trust is shape-only. Registry-backed trust (registered READY hosts only) is wave 3.

### D-A1: targeted login lockout
- **Threat:** an attacker who knows an email address keeps its owner locked out (previously 10 failures for that email
  refused everyone for 15 minutes).
- **Controls:** `LoginAttemptLimiterService` uses the existing atomic Redis token bucket. It meters attempts per (normalised email,
  client IP via `TRUSTED_PROXY_CIDRS`) in two tiers (a burst, then a 24 h ceiling), plus an account-wide ceiling. The account
  ceiling applies only to addresses with no recent successful sign-in to that account. Buckets refill, so the limiter slows
  attempts and never locks the account. A refused attempt writes nothing. The limiter runs before the account lookup for every
  address (uniform). Successful sign-ins clear counters only after the session is issued; refusals after a correct password clear
  nothing, which would otherwise be an oracle. If Redis fails, the request fails closed with 503.
- **Residual:** during an active distributed attack, the account owner signing in from a never-seen address is slowed for up to
  one account window. CAPTCHA or step-up is wave 4.

### D-A2: password sessions outliving "password sign-in off" (owner decision 2026-10-23: "log them out")
- **Controls:** a true→false change revokes the organisation's live `auth_provider='password'` sessions inside the setting
  change's own transaction. It uses `RefreshTokenService.revokeFamily` (refresh family + `user_session` + its security
  version) and bumps the organisation's security version. It writes an `organisation.password_sessions_revoked` audit row.
  SSO sessions are untouched. The exempt mobile workforce (the same predicate as login) is kept. A failed revocation rolls back
  the setting change.

### D-A3: MFA gate not consulted on password sign-in
- **Controls:** `LoginSecondFactorPolicyService` is now called in `AuthService.completeLogin` for every provider. It runs after
  every access gate and before any session, success row or provider link. Any answer other than 'none' fails closed with 409
  SECOND_FACTOR_REQUIRED. It is inert today because the policy returns 'none' and enrolment is wave 4.

### B2: legacy APP_SECRET JWT key
- **Controls:** `APP_JWT_LEGACY_VERIFY_ENABLED` defaults to true, which keeps current behaviour. When set to false, the `legacy`
  kid and every kid-less token are removed from the verify map. Boot is refused when the flag is false without a keyring.
  The flag is forwarded to the worker bundle.

## Wave 1 Lane S: payroll evidence RESTRICT (F3), token-bearing email bodies (F1), workspace-aware RLS gate and posture snapshot (F4) (2026-10-23)

Full findings (§5.8 format), tests and evidence: `WAVE1_LANE_S_REPORT.md`, `docs/evidence/wave1-lane-s/`. Migrations
`PayrollEvidenceRestrict1786719700000` and `EmailOutboxSecretBodyScrub1786719710000` are approved for the development TEST
database only; neither is in `production-migration-approval.ts`.

### F3: approved payroll evidence deleted by cascade (money / another person's data)
- **Threat:** any code path, CLI or ad-hoc SQL that deletes a `staff_profile` (directly or through `core."user"` CASCADE),
  `shift`, `shift_assignment` or `attendance` silently deleted the approved `payroll_record` rows pointing at it. Only
  `UserDeletionService.assertCanDelete` (layer 2) stood in the way.
- **Controls:** `payroll_record`'s three parent FKs are `ON DELETE RESTRICT` in `core`, in every existing `workspace_<32 hex>`
  schema, and in both provisioning paths (the TypeScript `WORKSPACE_TEMPLATE_STEPS` and `core.provision_workspace`,
  re-created with `CREATE OR REPLACE` so the owner, DEFINER, `search_path` and ACL are unchanged). Such a delete now fails with
  23503 for every role, the superuser included. A unit drift guard requires both paths to compose the identical template,
  and the posture snapshot records the FK action per workspace. The runtime role still has no DELETE on payroll rows.
- **Residual:** `payroll_record → organisation` stays CASCADE (tenant offboarding is an owner retention decision). Deleting
  an organisation is already refused while any user exists (`user_organisation_id_fkey`). Unapproved attendance (no payroll
  record yet) still cascades with its staff profile, which is the existing behaviour.

### F1: bearer link tokens retained in `core.email_outbox`
- **Threat:** a reader of the outbox (a backup, a replica, a future SQL-read bug) takes over an account through a
  still-valid reset, activation, invitation or email-change link stored in `rendered_html`/`rendered_text`.
- **Controls:**
  - Service layer: the worker processor clears the body in the same write that makes a secret-bearing row SENT, FAILED
    or CANCELLED (`emailBodyCarriesSecret`).
  - Database layer: `core.email_outbox_scrub_secret_body` is a SECURITY INVOKER trigger, owned by crewflow, with EXECUTE
    revoked from PUBLIC. It runs for every writer (the dispatcher recovery, cancellations, older images, ad-hoc SQL) and
    stops a body from being written back.
  - The rule covers three job types (ACCOUNT_INVITATION, PASSWORD_RESET, MEMBER_INVITATION) and any body with a `token=`
    query parameter, which catches the email-change verification sent as a NOTIFICATION.
  - Existing terminal rows were reconciled per organisation under RLS.
  - Unsent rows keep their body, so retries still work. Subject, delivery metadata and audit rows are kept.
  - The processor now refuses to send an email with no body (FAILED, never an empty send).
- **Residual:** tokens are still persisted while a row is PENDING/RETRY (needed to retry). Detection by content assumes
  every token link uses a `token` query parameter (true for every producer today; the unit spec renders each template). A
  retention period for the other bodies is the owner's G6 decision.

### F4: workspace schemas outside the RLS gate and the posture snapshot
- **Threat:** a workspace-schema migration or a hand change that drops FORCE, a policy or ownership, or adds a grant, passes
  CI. With `HWS_RUNTIME_ENABLED` on, that change is exploitable.
- **Controls:**
  - `tools/check-rls-coverage.ts` checks every `^workspace_[0-9a-f]{32}$` schema with no exemptions:
    - schema owner and ACL;
    - only tables and indexes in the schema;
    - every table has ENABLE + FORCE, is owned by crewflow, and has a policy with USING / WITH CHECK for each command;
    - table and column grants equal the table's core counterpart's;
    - zero rows are visible with no tenant context bound.
  - The posture golden holds one canonical workspace-template fingerprint (`ws|` lines). Each schema is compared with that
    fingerprint separately, so the golden stays the same whatever the number of workspaces, and a drifted schema is named.
  - Proven against deliberately broken disposable schemas (`workspace-security-coverage.integration.spec.ts`).
- **Residual:** with zero workspace schemas the template section is not exercised (stated in the output). Two test suites that
  leave deliberately broken workspace schemas behind now drop them. Long-lived test databases holding such leftovers from
  older runs will report them until they are dropped or the database is rebuilt.
