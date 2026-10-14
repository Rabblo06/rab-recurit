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
