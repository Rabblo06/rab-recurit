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

## Auth, attendance, payroll

Pending — these land in M1 (auth, already built — entry above covers tenant
context binding but not the full auth flow), M4 (attendance) and M5
(payroll) per `rab-workforce-architecture.md` §14. Each gets its own entry
here in the PR that builds it, before merge.
