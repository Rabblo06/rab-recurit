# Integration test identities and login

## Why this exists (root cause)

Many integration suites used to seed users by hand and log in through the real
`/auth/login` endpoint. Their hand-made roles were named things like
`manager-<uuid>` or `owner-<uuid>`, with every permission granted. Production
authorisation is **role-key based**: `applicationAllowed(roles, target,
platformAdmin)` (`engine/core-modules/auth/application-access.ts`) admits a
role only if its *key* is exactly one of the canonical keys for the requested
application (`manager`, `venue_manager`, `ceo`, `staff`, …). The synthetic keys
matched nothing, so login returned `403 APPLICATION_ACCESS_DENIED` and the
suites died in `beforeAll` — **before a single assertion ran**, which read as
"security suite failed" (or, worse, was skipped as noise).

The guard was correct; the fixtures were wrong. The fix is in the fixtures, and
a permanent spec proves the guard was not loosened.

Explicitly **not** done (and forbidden): allowing all roles in tests, wildcard
role matching, skipping `ApplicationAccessGuard` when `NODE_ENV=test`, treating
`owner-*` as a production role, turning a 403 into a 200, removing application
access enforcement.

## The canonical factory

`packages/rab-server/src/__tests__/integration/helpers/test-identities.ts`

| Method | Creates |
|---|---|
| `createOrganisation(label)` | an isolated organisation |
| `createInternalManager(org, {permissions, platformAdmin, …})` | an Internal Manager with the *canonical* `manager` role (production permission set by default) |
| `createOrganisationWithManagers(n, …)` | n managers in one org (first can be platform admin) |
| `createVenueManager(org, {owner, venueIds, …})` | Venue Manager with canonical `venue_manager` role, optionally assigned to venues |
| `createStaff(org, {owner, …})` | Staff with the canonical staff role + `StaffProfile` |
| `createCeo`, `createOrgAdmin`, `grantPlatformAdmin` | other canonical identities |
| `login(identity)` / `loginRaw` / `loginTokens` / `loginByEmail` | **the only** login path — real `/auth/login` with the right application target |

Guarantees:

* Roles are provisioned from the same definitions production seeds
  (`ROLE_DEFS`, `STAFF_ROLE_*`). Asking for a *different* permission set for a
  canonical key in the same org throws `TestSetupError` (no silent drift).
* `login()` throws a `TestSetupError` naming the identity, role and target if
  the server answers non-200 — a setup failure can never masquerade as a
  passing (or skipped) suite.
* Helpers: `response-shapes.ts` (`rowsOf`/`idsOf` throw on a non-list body, so a
  403 body cannot be mistaken for "0 rows"), `worker-heartbeat.ts`,
  `throttle-state.ts` (clears leaked Redis throttle counters), `smtp-sink.ts`
  (real local SMTP endpoint that captures MIME + attachments).

## Regression guard

`test-identities.integration.spec.ts` asserts, per identity kind, which
applications are admitted and denied, and that non-canonical role keys
(`manager-<uuid>`, `owner-<uuid>`, `everything`, `Manager`, `MANAGER`,
`"manager "`) are **still denied** with `APPLICATION_ACCESS_DENIED`.

## Proving assertions execute

`src/jest-probe.ts` (opt-in via `RAB_ASSERTION_PROBE_FILE`) appends, after each
test, `expect.getState().assertionCalls` plus the factory's login counters. A
suite is only counted as "reached its assertions" when its tests report
assertion counts > 0 with zero login failures.

```
RAB_ASSERTION_PROBE_FILE=probe.jsonl npx jest --runInBand --json --outputFile=result.json
```

## Running the DB-backed suites

Serial only (`--runInBand`): the suites share one Postgres and one Redis;
parallel runs cause lock contention and spurious timeouts. The lifecycle spec
uses its own Redis DB index (8) and its own SMTP sink port; it must import
`helpers/lifecycle-env` **first**, because `AppModule` freezes its configuration
at import time.
