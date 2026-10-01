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
