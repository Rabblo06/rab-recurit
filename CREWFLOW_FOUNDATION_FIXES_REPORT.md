# Crewflow foundation fixes P1–P3 (2026-10-22)

**Overall: PASS for P1, P2 and P3. Verification is PARTIAL in two places, both listed under "Remaining blockers":**
- the long-lived test DB fails 16 tests with `out of shared memory`. Those suites pass on a fresh database.
- I did not run a live HTTP smoke with HWS switched on and two tenants.

Nothing was committed, pushed or deployed. No production, Neon or remote database was touched, and no database was reset.
No `rab-*` container was rebuilt or restarted.

| Priority | Verdict | One line |
| --- | --- | --- |
| P1 audit cross-organisation identity | **PASS** | Enforced in the service AND by a database trigger for every role. Platform-admin cross-org actions still audit. |
| P2 first-admin bootstrap | **PASS** | A fresh DB gets its first admin from `crewflow` through one narrow DEFINER function. It is one-time, locked, audited and refused for `crewflow_app`. |
| P3 `navigation_layout` ownership | **PASS** | A new migration reconciles superuser-owned `core` objects. A fresh install matches the golden snapshot with no manual step. |

---

## 1. Findings (§5.8 format)

### P1

```
[MEDIUM]
Failure:      any server code path (or a direct SQL writer) running in org A → records an audit entry whose actor or target
              is a real user of org B → the audit trail attributes cross-tenant identities (forged attribution).
Actor:        any writer of core.audit_log. API/Worker as crewflow_app; CLIs as crewflow; migrations as superuser.
Location:     packages/rab-server/src/engine/core-modules/audit/audit.service.ts:272 (before the fix; the check is now at :285)
              and the core.audit_log schema (no rule existed at all).
Root cause:   1786692000000 dropped the actor/target FKs. 1786704000000 replaced them with
              core.audit_existing_user_ids, a SECURITY DEFINER existence test that deliberately ignores the
              organisation. It was written so that platform-admin grant/revoke would stop failing. The result: "exists
              anywhere" counted as valid. The database layer had no identity rule at all, because audit_log_tenant only
              constrains the row's own organisation_id.
Fix:          Service: AuditService.record pre-checks via core.audit_identity_violations(actor, target), which is
              evaluated against the transaction's bound organisation.
              Database: BEFORE INSERT/UPDATE OF identity columns trigger audit_log_recorded_identities. It fires for
              every role, including the owner and the superuser, and raises 23503.
              Both layers call ONE rule function, core.audit_identity_violations_in (rab_secure_owner, no login role may
              execute it). The rule: every non-null id must be a core.user of the row's organisation. The only exception
              is an ACTIVE platform-admin actor.
              RLS, FORCE and insert-only grants are unchanged. Existing rows are not re-validated.
Regression:   - audit-log-immutable-identifiers (5/5, its cross-org case failed in the baseline).
              - New audit-log-cross-organisation-identity (11):
                - service layer: same-org accepted; cross-org target/actor refused; actor-less system entry not exempt;
                  an active admin is allowed and a revoked admin is refused;
                - direct DB inserts as crewflow_app, as crewflow (owner) and as superuser are refused, same-org is
                  accepted, and RLS still blocks writing another org's row;
                - no login role can execute the org-parameterised function, and no tenant context makes the check
                  fail closed;
                - API: a cross-org staff deactivation returns 404 with no audit row; platform-admin grant/revoke and
                  organisation suspend/reactivate still audit with the expected organisation and actor.
```

Severity rationale: this is an integrity / defence-in-depth gap. It is not a read: RLS still hides the foreign rows, and no
API path that passes a foreign id was found (the API test gets a 404).

**Legitimate platform-admin actions are preserved.** The cross-organisation shapes recorded today all have an active admin
actor, and the full suite passes for all of them:
- grant/revoke: the row is in the admin's org and the target is elsewhere;
- organisation suspend/reactivate, organisation and CEO creation, and Initial Manager replacement: the row is in the
  target org and the actor is the admin;
- Admin Inspect: the actor is `inspectedBy`.

Covered by settings-abuse (13/13), organisation-suspension (12), organisation-onboarding (10), admin-inspect (10 + 34) and
initial-manager.

### P2

```
[MEDIUM]
Failure:      operator → runs bootstrap-admin on a fresh install as crewflow → "new row violates row-level security policy
              for table organisation" → no first admin. The process still exited 0, so start.sh and scripts saw success.
              The only working path was an undocumented manual run as the database superuser.
Actor:        deployment operator (crewflow identity).
Location:     packages/rab-server/src/command/bootstrap-admin.command.ts:284/291 (before: direct INSERTs into
              organisation, user and platform_admin); packages/rab-server/src/command/main.ts:13 (exit code).
Root cause:   The command predates the role split. It relied on rab_owner owning those NOT-FORCE tables. After the split
              they belong to the NOLOGIN rab_secure_owner, and crewflow is (by design) never a member of it.
              create_organisation() and platform_admin_write both require an ALREADY active admin: a chicken-and-egg.
              Separately, nest-commander's default serviceErrorHandler swallows errors and exits 0.
Fix:          New SECURITY DEFINER function core.bootstrap_first_platform_admin (rab_secure_owner). It:
              - takes the command's existing advisory lock and returns ALREADY_BOOTSTRAPPED or CLOSED once any admin
                has existed;
              - applies the existing resolution rules, moved verbatim and executed atomically;
              - creates an INVITED user with no password and inserts the first platform_admin row.
              EXECUTE is granted to crewflow ONLY. PUBLIC and crewflow_app are revoked.
              The command now:
              - checks authority first, with an actionable refusal for crewflow_app;
              - calls the function;
              - binds context through TenantContextService.bindCoreIdentityGucs;
              - reuses ensureOperationalIdentity, AccountLifecycleService.sendAccountInvite and AuditService unchanged.
              CLI main sets exitCode=1 on any command error.
Regression:   - New bootstrap-admin-crewflow-identity (9, runs as current_user=crewflow): fresh, idempotent with 3
                concurrent runs, existing-admin block, one-time CLOSED, existing user granted;
              - abuse cases: crewflow_app refused by both the command and the DB (42501); crewflow cannot write
                platform_admin/organisation or call create_organisation directly; malformed input → 22023.
              - The existing bootstrap-admin (9) and bootstrap-cli-platform-admin (4) still pass.
              - The fresh-install proof is §4.
```

### P3

```
[LOW]
Failure:      fresh install → phase-B migration NavigationLayout1786718600000 creates core.navigation_layout as the
              bootstrap superuser → the table is superuser-owned and the posture golden snapshot drifts (2 lines). Every
              fresh install then needed a manual `ALTER TABLE core.navigation_layout OWNER TO crewflow`.
Actor:        migration runner (phase B, superuser).
Location:     packages/rab-server/src/database/typeorm/core/migrations/1786718600000-NavigationLayout.ts:29 (no OWNER TO).
Root cause:   PostgreSQL makes the creating role the owner. ReconcileCoreOwnershipAndRuntimeGrants1786717700000 only
              fixed objects that existed when it ran.
              I checked the whole catalog on a fresh install for other objects with the same problem: only
              navigation_layout and its two indexes were superuser-owned (evidence fresh-install/00-baseline/06).
Fix:          New migration ReconcileSuperuserOwnedCoreObjects1786719600000 (the applied migration is NOT edited).
              - It hands superuser-owned core relations, non-definer functions, types and the schema to crewflow, and
                existing grants are kept.
              - It REFUSES to guess for NOT-FORCE RLS tables and for SECURITY DEFINER functions.
              - It verifies that nothing superuser-owned remains.
              - It is idempotent: a no-op on rab-devdb and on the test DB.
Regression:   - Static migration-object-ownership.spec.ts (3): every later migration must state OWNER TO for each core
                object it creates.
              - Integration core-object-ownership (6): no superuser-owned core objects; navigation_layout is owned by
                crewflow and crewflow_app has SELECT, INSERT and UPDATE only. The migration itself is exercised in a
                rolled-back transaction: the fix case, both refusal cases, and idempotency.
              - db-security-posture checks the golden snapshot.
```

---

## 2. Changed and added files

**Added (all untracked)**

Migrations, under `packages/rab-server/src/database/typeorm/core/migrations/`:
- `1786719600000-ReconcileSuperuserOwnedCoreObjects.ts` (P3)
- `1786719610000-AuditLogRecordedIdentityOrganisationCheck.ts` (P1)
- `1786719620000-BootstrapFirstPlatformAdminFunction.ts` (P2)

Tests:
- `packages/rab-server/src/database/typeorm/core/migration-object-ownership.spec.ts`
- Under `packages/rab-server/src/__tests__/integration/`:
  - `audit-log-cross-organisation-identity.integration.spec.ts`
  - `bootstrap-admin-crewflow-identity.integration.spec.ts`
  - `core-object-ownership.integration.spec.ts`

Report and evidence:
- `CREWFLOW_FOUNDATION_FIXES_REPORT.md` (this file)
- `docs/evidence/foundation-fixes-2026-10-22/**` (gitignored)

**Modified.** Every one of these files except `bootstrap-admin.command.ts` and `main.ts` already contained other sessions'
uncommitted hunks; those hunks were preserved and my edits are additive.
- `packages/rab-server/src/engine/core-modules/audit/audit.service.ts`: `assertRecordedIdentitiesExist` only.
- `packages/rab-server/src/command/bootstrap-admin.command.ts`: `run()` now calls the function. Added
  `assertBootstrapAuthority` and `bindContext`. Removed `resolveOrCreateUser`, which moved into the function. The
  constructor gains `TenantContextService`.
- `packages/rab-server/src/command/main.ts`: `serviceErrorHandler` → non-zero exit.
- `packages/rab-server/src/__tests__/integration/bootstrap-admin.integration.spec.ts`: passes the new 4th constructor
  argument. No assertion changed.
- `packages/rab-server/src/database/typeorm/core/security-posture.golden.txt`: +16 lines, all additive (the 4 new
  functions' owner and EXECUTE lines). It was regenerated from the fresh-install DB and diffed.
- `packages/rab-server/.env.example`: 3 comment lines on the crewflow identity.
- `THREAT-MODEL.md`: appended; the prior content was verified byte-identical.
- `docs/HANDOFF.md`: appended.

---

## 3. Test results vs the baseline (`docs/evidence/fresh-install-tests-2026-10-22/`)

| Suite | Baseline | Now | Notes |
| --- | --- | --- | --- |
| server unit | 534/537 (3 fail) | **537/540** (3 fail) | +3 new. The same stale `tenant-context.service.spec` fails. |
| server integration (crewflow-test-db) | 1473 pass / 4 fail / 61 skip, 120 suites | **1495 pass / 8 fail / 61 skip, 123 suites** | See below. |
| worker (crewflow-test-db) | 424 pass / 10 fail | 413 pass / 21 fail | The same 10, plus 11 `out of shared memory`. All 41 tests in the 4 affected suites pass on the fresh DB. |
| targeted on the FRESH DB (15494) | — | server 64/64; worker 41/41 | Server: 51 passed in the combined run plus settings-abuse 13/13 when re-run alone (it hit a 5 s cold-compile `beforeAll` timeout in the combined run). Worker: provisioning, provisioner-entrypoint, invite-cleanup, email-reliability. |
| rab-server `tsc` build / rab-worker typecheck | exit 0 | exit 0 | |
| front 678, shared 77, launcher 30 | — | not re-run | No change in those packages. |

**Server integration in detail:**
- Fixed: `audit-log-immutable-identifiers` (cross-org case).
- Still failing as before:
  - `identity-security-table-rls` ×2: test-DB grant visibility;
  - `shift-team` 404-vs-400.
- Newly failing in this run: `containment-suspend-test-accounts` ×5. The cause is `out of shared memory` at its fixture
  `TRUNCATE core.organisation CASCADE` (spec line 152). It passes 5/5 on the fresh DB.
- The shared test DB has grown to 140 workspace schemas (15,094 relations). Its lock table holds 64 locks per transaction
  × 100 connections. My aborted parallel run added to that growth (see §6).

**Security, RLS and HWS-relevant suites, all green:**
- the 4 new or changed specs;
- server-path-provisioning db/api/no-redis 26+11+1;
- hws-backfill 10 (includes the HWS-on runtime read path);
- workspace-execution-context 18, workspace-cross-tenant-rls-attack, composite-workspace-fk-attack;
- organisation-isolation 30, staff-profile-rls 22, workspace-membership 31, admin-inspect 10+34;
- check-rls-coverage OK, 57 tables (test DB, fresh DB and rab-devdb).

## 4. Fresh-install proof (new disposable compose project `crewflow-ff-fresh`, 127.0.0.1:15494; evidence `fresh-install/`)

**Before the fixes** (`fresh-install/00-baseline-before-fixes/`):
- posture DRIFT: 2 missing and 2 unexpected lines, all `navigation_layout`;
- `bootstrap-admin` as crewflow → RLS error with **exit 0**.

**After the fixes**, on an empty cluster:
1. Phase A as `rab_owner` stops at the role split, by design.
2. Phase B as the bootstrap superuser applies 194 migrations.
3. **posture matches the golden snapshot (624 lines), with no manual step.** `navigation_layout` is owned by `crewflow`. RLS
   coverage OK.
4. `bootstrap-admin` as `crewflow_app` → refused, exit 1.
5. `bootstrap-admin` as `crewflow`, the real login (not a superuser) → exit 0. The result:
   - `first-admin@example.test` is **INVITED** with no password;
   - 1 platform_admin with `granted_by` NULL;
   - an operational CEO profile, role and membership;
   - 1 pending invite;
   - email_outbox `ACCOUNT_INVITATION` PENDING, "Activate your Crewflow Super Admin account";
   - audit `user.invite_queued` + `platform_admin.bootstrapped`.
6. A re-run and a different email both → "already exists", with nothing created.
7. A direct `bootstrap_first_platform_admin` call as `crewflow_app` → permission denied.

## 5. rab-devdb (test DB, owner-approved)

- Identity re-verified: cluster 7699569147858477090, 191 migrations, `navigation_layout` already owned by crewflow (from
  the manual fix).
- Backup: `C:\Users\issac\crewflow-db-backups\rab-devdb-20261022-222033-pre-foundation-fixes.dump`, 886,794 bytes,
  sha256 `abf48d282427cb2c56d51ad77934acf1ff2378074c1455ffaf23834e1cd11905`. A restore test into a scratch database matched:
  191 migrations, 1 user, 11 audit rows.
- I applied the 3 migrations with the guarded runner, as a one-shot superuser phase B. The result is 194 migrations,
  **posture matches 624 lines**, RLS coverage OK, and `issac@gmail.com` is preserved (the platform admin, now ACTIVE).
- Containers were not restarted:
  - `rab-server-1` `/healthz` 200;
  - the Worker bundle is healthy, with both heartbeats under 10 s old after the migration;
  - no errors in the logs.
- The running (pre-change) API image still calls `audit_existing_user_ids`. That function is kept on purpose, and the new
  trigger also enforces the rule for that image's writes.
- I did **not** run bootstrap-admin on rab-devdb: an admin already exists there, so the bootstrap is closed.

## 6. Remaining blockers / notes

1. **Test-DB lock capacity.**
   - crewflow-test-db has accumulated 140 workspace schemas. `TRUNCATE ... CASCADE` and the provisioning fixture cleanup now
     exceed `max_locks_per_transaction` (64), which accounts for 16 test failures (5 server, 11 worker).
   - An aborted parallel run of mine contributed to this: a mis-set unit-test filter ran integration suites concurrently
     with the integration run for a few minutes. I stopped both runs and re-ran everything sequentially.
   - Owner choice: either raise `max_locks_per_transaction` (needs a restart of the disposable test container) or rebuild
     the disposable test DB. I did neither, because both were outside what was authorised.
2. **HWS isolation was not live-tested over HTTP with two tenants.** The old smoke needs the `wstest*` fixture data, which
   was discarded with the fresh install. Isolation is covered by the passing integration suites listed in §3, and the dev
   stack runs with HWS on and stayed healthy.
3. **Owner decision (flagged, permissions rule): bootstrap is now strictly one-time.**
   - It is `CLOSED` once any platform_admin row has ever existed. Before, it re-opened when no admin was *active*.
   - To veto: let the `CLOSED` branch fall through.
   - The security trade-off (crewflow EXECUTE) is in THREAT-MODEL.md.
4. **`grant-platform-admin` still writes `core.platform_admin` directly and needs a superuser.** It is the same class of
   problem as P2, but it was not in scope.
5. **Deferred removal of `core.audit_existing_user_ids`.** Nothing calls it now. Drop it in a later migration once no
   deployed image uses it.
6. **CLI exit behaviour changed.** Every CLI command that throws now exits 1 instead of 0. This is intended fail-closed
   behaviour.
7. **Throwaway resources.** `crewflow-ff-fresh` was removed after the evidence was captured. Its scripts are in the session
   scratchpad. No other resources were created.

Stopped here. The Full Twenty Engine Parity programme was **not** started.
