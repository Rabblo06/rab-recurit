# Crewflow ↔ Twenty architecture parity — PROVISIONING FOUNDATION ONLY (Wave B, step 1)

> **Latest status (2026-10-22, §15):**
> - The owner approved Option 1 and the development migration of rab-devdb.
> - G1 and the backfill (with the one-off privileged copy) are now **applied to rab-devdb**: 292/292 rows identical, posture verified, core intact.
> - **HWS is not enabled, no container was restarted, and G2 (the compose topology) is still unapplied.**
> - Sections 0–14 describe the earlier, staged state; §15 supersedes them where they differ.

Date: 2026-10-22. Branch `feat/venue-manager-teams-ui`. Nothing committed, pushed, deployed, or migrated on any dev, shared or
remote database. Every database test ran on two throwaway PostgreSQL 16 containers created for this work
(`crewflow-spp-test` on 127.0.0.1:15491 and `crewflow-spp-test2` on 127.0.0.1:15492, each with its own Redis).

This report covers **only** the server-path provisioning foundation:
- the narrow SECURITY DEFINER provisioning function, with trusted-state validation;
- server wiring;
- setup UI stages;
- the test-only migration prestart;
- tests.

The other parity areas (metadata, search, soft-delete, cache, encryption, and the rest) are out of scope. Another agent is
auditing them.

It replaces `CREWFLOW_SERVER_PATH_PROVISIONING_REPORT.md`. That file was never created.

**Overall: PARTIAL.** The foundation is built and tested, and stops at the two owner gates (section 0):
- **Server-path provisioning works through the restricted runtime connection.** 26 DB tests, 11 API tests and 1 no-Redis
  test pass on a throwaway database. The tests also prove that `crewflow_app` gained no broad DDL authority.
- **Gate 1 is not applied.** The migration that grants the new privilege is staged outside the migrations folder.
- **Gate 2 is not applied.** The default deployment topology is unchanged; the proposed version is in a separate file.
- **The ordinary-job Worker regression passes.** A few existing suites fail for reasons outside this change (section 8).

---

## 0. High-risk gates: STOPPED for owner approval

| Gate | State | Evidence | To approve |
|---|---|---|---|
| **G1.** Grant `crewflow_app` EXECUTE on a DDL-performing SECURITY DEFINER function (`core.provision_workspace(uuid)`) | **STAGED.** The migration is in `packages/rab-server/src/database/typeorm/core/proposed-migrations/`, outside the `migrations/*` glob, so no migration run can apply it. It was applied only to the two throwaway databases. | §4–§9, THREAT-MODEL entry "Server-path workspace provisioning" | `git mv` the file into `core/migrations/`; apply `proposed/security-posture.golden.diff`; run the approved migration path (`rab-migrate`). |
| **G2.** Remove the provisioner and the Worker bundle from the default compose topology | **NOT APPLIED.** `packages/rab-docker/docker-compose.yml` and `docker-compose.production.yml` are exactly as the bundle work left them. | `docs/evidence/server-path-provisioning-2026-10-22/proposed/docker-compose{,.production}.server-path.{yml,diff}` | Apply only **after G1** is live. Without G1 nothing would provision new workspaces. |

**The server code is safe with both gates closed.** Without the function, `core.provision_workspace` does not exist:
- `WorkspaceProvisioningService` returns `DEFERRED`;
- the API answers 201 with `schemaStatus: CREATING`;
- the Worker provisioner (today's default) completes the workspace as before.

Both paths can coexist, because the per-workspace advisory lock and the row locks serialise them.

---

## 1. Twenty source findings (pinned)

**Pinned commit.** `twentyhq/twenty` `main` at **`ea1a68e3047d145ec5431d977f18c403a3cd6dab`**, committed 2026-10-22T16:20:25Z.
Every file below was read at that SHA.

**Brief commit `f836a286…`.** It is 22 commits behind. Of the 19 key files, 18 are byte-identical. Only
`twenty-docker/twenty/Dockerfile` differs, and the difference is base-image staging with no behavioural change.

**Nothing was BLOCKED.**

**Not verified:**
- whether every activation step is idempotent;
- how workspace queries are qualified to the workspace schema;
- whether TypeORM `runMigrations` takes its own lock.

**Call graph** (paths under `packages/twenty-server/src/`):
1. `engine/core-modules/workspace/workspace.resolver.ts` L133-155: GraphQL `activateWorkspace`.
   - Guard: `AuthPrincipalGuard(userSession…)`.
   - Runs synchronously, in the API process, inside the HTTP request.
2. `engine/core-modules/workspace/services/workspace.service.ts` L506-608: `activateWorkspace`.
   - Compare-and-set `PENDING_CREATION → ONGOING_CREATION` (L509-515).
   - Reclaims a stale `ONGOING_CREATION` older than 5 min (L517-528, constant L118-119).
   - ACTIVE/CREATED returns idempotently (L530-546).
   - Invalidates the cache (L548-551).
   - Then: `workspaceManagerService.init` → feature flags → workspace member → prefill → `activateAndInitializeUpgradeState`.
   - Enqueues pre-installed apps (BullMQ `workspace-queue`).
   - On error: back to `PENDING_CREATION` and a cache invalidation (L576-586). **Created schema and metadata are not rolled back.**
3. `engine/workspace-manager/workspace-manager.service.ts` L38-90: `init`.
   - `createWorkspaceDBSchema`, then the standard application sync (runs DDL, `SET LOCAL lock_timeout='8s'`, cache invalidation
     after commit), then default roles.
4. `engine/workspace-datasource/workspace-schema.service.ts` L34-47: `createWorkspaceDBSchema`.
   - Runs `CREATE SCHEMA IF NOT EXISTS "workspace_<base36>"` (TypeORM `createSchema`).
   - Uses the **core DataSource**, which is the same `PG_DATABASE_URL`.
   - **No owner clause.**

**Topology and roles:**
- **Compose** (`packages/twenty-docker/docker-compose.yml`): server and worker share one image and **one `PG_DATABASE_URL`**,
  which defaults to the bootstrap superuser `postgres` (L12, L71, L119-126).
- **Worker:** `DISABLE_DB_MIGRATIONS: "true"` and `DISABLE_CRON_JOBS_REGISTRATION: "true"` (L75-76). Redis is a peer of both.
- **Migrations:** `twenty-docker/twenty/entrypoint.sh` L5-27 runs `database:init:prod` (only when there is no `core` schema),
  then `cache:flush`, `upgrade`, `cache:flush`. Failures only **warn**.
- **No lock:** `twenty-server/docs/UPGRADE_COMMANDS.md` L202 says "Nothing in `upgrade` prevents two concurrent sequences… the
  sequence runner takes no advisory lock".
- **No database-enforced tenant isolation:**
  - 0 hits for `ROW LEVEL SECURITY`, `SECURITY DEFINER`, `CREATE POLICY` and `BYPASSRLS` in GitHub code search. That search is
    default-branch only.
  - Isolation is schema-per-workspace plus application-compiled row predicates (`engine/twenty-orm/types/row-access-policy.type.ts`).

**Classification** (the full table is in the research hand-off):

| Adopt directly | Needs security adaptation |
|---|---|
| Separate server/worker processes | Migrate-on-start with swallowed failures and no lock |
| Activation status machine plus idempotent return | One credential for runtime and DDL |
| Post-commit cache invalidation | DDL on the runtime connection with no owner clause |
| BullMQ follow-ups | Application-only isolation |
| Healthchecks | |

---

## 2. Original rationale for the rule this changes, and why the design mitigates it (pre-step)

**The rule** (`packages/rab-server/src/engine/utils/assert-runtime-db-role.ts`, comment above `RUNTIME_DB_ROLE`):
> "`crewflow_app` is deliberately never granted EXECUTE on `provision_workspace_schema` — only the worker's dedicated,
> non-pooled provisioning connection (authenticated as `crewflow`) may run it."

| # | Recorded reason (source) | Risk | Does the new design mitigate it? |
|---|---|---|---|
| R1 | `1786687000000-CrewflowAppRestrictedRuntimeRole` header: "introduce `crewflow_app`, a new LOGIN role that owns NOTHING and therefore cannot run any DDL"; provisioning needs `crewflow`'s CREATE on the schema and table ownership, so it stays on the provisioner connection | The runtime credential gaining DDL authority, e.g. `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, demonstrated live in `P2-PRODUCTION-READINESS.md` Phase C | **Yes.** `crewflow_app` still owns nothing and has no CREATE anywhere. It gets the *result* of a fixed template, not the authority. Proven by 18 attempted DDL/role-switch operations, all 42501 (§6) |
| R2 | `1786677800000-WorkspaceLifecycleGrantTightening` and plan §8A.9 Check A: the lifecycle mutators "are pure state-machine, never structural verification … any `rab_app` query … `mark_workspace_schema_ready` … would succeed … for an arbitrary workspace" | Attesting READY with no real schema; targeting a foreign workspace id | **Yes.** The mutators are still denied to `crewflow_app` (tested). READY is written only inside the function, after its own verification, in the same transaction. Org and owner are bound to the server-set GUCs and checked against the row read under RLS |
| R3 | `SECURITY_FINDINGS.md` CF-12 / `DATABASE_RLS_SECURITY.md` F1: the `crewflow` credential lives in runtime containers (start.sh, provisioner) and can escalate to `rab_secure_owner` through search_path shadowing and crewflow-owned helpers | Leaked privileged credential, then reads of password/TOTP hashes | **Improved.** G2 removes the last runtime holder of the `crewflow` credential. The function pins `search_path = pg_catalog, pg_temp`; temp-object shadowing by the caller is tested. The CF-12 residue (crewflow can still escalate if *its* credential leaks) is pre-existing and unchanged |
| R4 | `workspace-provisioning.job.ts` doc: the isolation was "no HTTP-reachable code path calls it … enforced by application-code discipline and this being a separate, dedicated worker process" | Request-path code reaching privileged provisioning | **Replaced by a database boundary.** The request path can call only the narrow function (EXECUTE on one function, uuid-only input). It cannot reach `provision_workspace_schema` or the mutators |

**No original reason describes a risk the new design cannot mitigate.** I therefore proceeded, with the SECURITY TRADE-OFF
recorded in §5 and in THREAT-MODEL.md.

---

## 3. Architecture before and after

**Before (today's default, the four-service bundle):**
```
Frontend → rab-api ──────────────── crewflow_app ──┐
              └── Redis                            ├── PostgreSQL (FORCE RLS)
rab-worker container (root launcher)               │
   ├── jobs child ─────────────────  crewflow_app ─┤
   └── provisioner child ──────────  crewflow  ────┘   (privileged DDL credential in a runtime container)
       (polls CREATING/FAILED, applies template via TypeScript)
```

**After (proposed: G1 + G2; implemented and tested on throwaway databases):**
```
Frontend → rab-api ── crewflow_app ── SELECT core.provision_workspace(id)   (SECURITY DEFINER, owner crewflow, fixed template)
              └── Redis (peer: cache, queues; never needed for provisioning correctness)
rab-worker (one ordinary process) ── crewflow_app (DATABASE_URL + DATABASE_DIRECT_URL) ── Redis
rab-migrate (one-shot, profile-gated) ── bootstrap identity, explicit approval only
```

**Database roles and credentials (after):**
```
LOGIN crewflow_app  (NOSUPERUSER NOBYPASSRLS, owns nothing)  ← rab-api, rab-worker      [the only runtime credential]
      └─ EXECUTE core.provision_workspace(uuid) ──runs as──▶ crewflow (owner of business + workspace tables, CREATE on ws schemas)
                     └─ calls (as crewflow) begin/register/provision_workspace_schema/mark_ready/mark_failed
                                    └─ run as rab_secure_owner (NOLOGIN; owns manager_workspace + workspace schema namespaces)
LOGIN crewflow       ← no runtime service (migration/ownership identity only)
bootstrap identity   ← rab-migrate, or the opt-in api prestart (Phase 7), one run at a time, removed afterwards
```

---

## 4. Function design

File (staged): `packages/rab-server/src/database/typeorm/core/proposed-migrations/1786719500000-ServerPathWorkspaceProvisioning.ts`.
The template module is the frozen `workspace-schema/v1/server-path-template.ts`.

**`core.provision_workspace(p_workspace_id uuid) RETURNS text`**
- Declaration: `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `SET lock_timeout = '30s'`.
- Owner: `crewflow`.
- Privileges: `REVOKE ALL FROM PUBLIC`; `GRANT EXECUTE TO crewflow_app` only.

**Validation:**
1. **Input.** NULL → 22004. Nil uuid → P0002. A non-uuid is refused by the type (22P02).
2. **Trusted caller state.** `rab.organisation_id` and `rab.user_id`, set by `TenantContextService` from the verified session,
   must both be bound. Otherwise → P0002.
3. **Derived name.** The schema name is `'workspace_' || replace(uuid::text,'-','')` and is checked against
   `^workspace_[0-9a-f]{32}$`.
4. **Lock.** `pg_advisory_xact_lock(hashtext('rab_workspace_provisioning'), hashtext(id))`, transaction-scoped, so it is never
   left held by a crash.
5. **Trusted database state.** The row is read **as `crewflow` under `manager_workspace` RLS**, so only the caller's own
   workspace is visible. Its `organisation_id` and `owner_user_id` must equal the bound GUCs, otherwise → P0002 (404). Its
   `status` must be `active`, otherwise → 55000.

**Lifecycle:**
- `READY`: read-only verification, then `'ALREADY_READY'`. If the READY schema has drifted, raise CWV02; nothing is changed.
- `CREATING`/`FAILED`: provision.
- `NULL`, `SUPERSEDED` or `MIGRATING`: 55000.

**Provisioning steps:**
1. The unchanged lifecycle functions run first, as `crewflow`: `begin_workspace_schema_attempt`, `register_workspace_schema`
   and `provision_workspace_schema`. The schema is created `AUTHORIZATION rab_secure_owner`, with USAGE+CREATE to `crewflow`
   and USAGE only to `crewflow_app`.
2. The registry row is locked `FOR UPDATE`.
3. **Sub-transaction (atomic):**
   1. Refuse a non-empty schema.
   2. `EXECUTE replace(<frozen template literal>, sentinel, derived name)`.
   3. Add the 21 `<table>_workspace_bound` CHECKs (`format('%I…%L')`).
   4. Run `core.verify_workspace_schema_v1()`, which checks:
      - tables (21), FORCE RLS (21) and crewflow ownership (21);
      - indexes (90), policies (39) and FKs (128);
      - the CHECK count, value and NULL exclusion;
      - the schema owner, and `user_note.workspace_id NOT NULL`.
   5. `mark_workspace_schema_ready(id, 1)` and return `'READY'`.
   - On any error the sub-transaction rolls back, `mark_workspace_schema_failed(id, <safe label | SQLSTATE>)` runs, and the
     function returns `'FAILED'`.

**`core.verify_workspace_schema_v1(uuid)`** is a read-only, non-DEFINER, crewflow-owned helper with no grants. `crewflow_app`
cannot call it (tested).

**Why the owner is `crewflow`.** A DEFINER function's DDL produces objects owned by the function owner, and every existing
workspace table is crewflow-owned. A `rab_secure_owner` owner would either give that NOLOGIN pre-auth owner 21 business tables
per workspace, or require `GRANT crewflow TO rab_secure_owner`. The precedent is `worker_cleanup_oauth_transaction_state`.
This choice is flagged in the trade-off.

**Server wiring:**
- `packages/rab-server/src/modules/manager-workspace/services/workspace-provisioning.service.ts` performs layer 2: owner and
  organisation re-check, lifecycle check, audit `manager_workspace.provisioned` / `.provisioning_failed`, and cache
  invalidation after commit.
- `manager-workspace.service.ts` `create()`:
  1. Runs the existing create transaction, or recognises an **idempotent replay** (same name and normalised subdomain).
  2. Catches the unique-violation race and turns it into a replay.
  3. Provisions in a second transaction on the same restricted DataSource.
  4. Returns the real lifecycle.
- There is no new endpoint. The one-workspace-per-manager rule is kept: a different body is still 409.

---

## 5. Role and grant changes (all inside G1, all staged)

| Object | Owner | EXECUTE |
|---|---|---|
| `core.provision_workspace(uuid)` (new, DEFINER) | crewflow | crewflow, **crewflow_app**; PUBLIC false |
| `core.verify_workspace_schema_v1(uuid)` (new, INVOKER) | crewflow | crewflow only |

**Nothing else changes.** The migration's verification block refuses to be recorded unless all of the following hold:
- `crewflow_app` still lacks every `PROVISIONER_ONLY_FUNCTIONS` entry;
- `crewflow_app` has no CREATE on the database, on `core` or on any workspace schema;
- `crewflow_app` is not a member of `crewflow`, `rab_secure_owner` or `rab_owner`;
- `crewflow_app` is NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE and NOCREATEDB, and owns 0 relations.

`down()` drops both functions, which restores the prior grants exactly.

**Golden snapshot.** The changes to `security-posture.golden.txt` are kept in `proposed/security-posture.golden.diff` (7
lines), not applied.

```
SECURITY TRADE-OFF
Decision:   Grant crewflow_app EXECUTE on ONE DDL-performing SECURITY DEFINER function, core.provision_workspace(uuid),
            owned by crewflow.
Reason:     Twenty-style topology: the API creates the workspace in the request that activates it; no provisioner
            service/process and no privileged credential in any runtime environment.
Risk:       Code running as crewflow_app (API RCE / SQL injection) can trigger the fixed V1 template for the caller's OWN
            CREATING/FAILED workspace; a defect in the fixed body would run with crewflow's DDL authority; the owner is a
            LOGIN role.
Mitigation: uuid-only input; derived name; frozen template; in-function trusted-state checks (exists, active, lifecycle,
            org+owner = server-bound GUCs read under RLS); advisory lock; same-transaction verification before READY;
            pinned search_path; PUBLIC revoked; lifecycle mutators and provision_workspace_schema still denied; migration
            self-verification; tests on the real runtime login.
Reversal:   Leave the migration staged (default today) or run its down(); the Worker provisioner keeps working.
```

---

## 6. Abuse assessment of the function (required) and RLS evidence

Every case below ran as the real **`crewflow_app` login**. Results are in `server-path-provisioning-db.integration.spec.ts`:
26 of 26 pass on throwaway DB 1.

| Abuse attempt | Result |
|---|---|
| Provision another organisation's workspace / same org, another owner / owner id under another org binding / org only / no context | P0002 (404). Victim unchanged (no registry row, no schema) |
| NULL / nil / unknown uuid / `'workspace_x; DROP SCHEMA core'` | 22004 / P0002 / P0002 / 22P02. Nothing created |
| SUPERSEDED, legacy NULL lifecycle, or a suspended workspace | 55000, no schema |
| Call again on READY | `ALREADY_READY`. Catalog, `ready_at` and `last_migrated_at` byte-identical |
| 3 concurrent connections, same workspace | `READY` once and `ALREADY_READY` twice. One schema, 21 tables |
| Template failure mid-way (event trigger at table 18 of 21) | `FAILED`, **0 relations**. Safe error `V1 provisioning failed at apply (SQLSTATE P0001)`, so the injected "password=…" text is not stored. A retry gives `READY` |
| Pre-existing stray object in the schema | `FAILED: schema is not empty; refusing to apply`. Not adopted. Retry after removal gives READY |
| Backend killed while the template is blocked mid-way (proven: blocked on a Lock wait while holding AccessExclusive locks on new tables) | Full rollback: CREATING, no registry row, no schema. Retry gives READY |
| Tampering injected inside the transaction after binding: drop a policy / drop a table / NO FORCE on a table | Detected (`verification failed: policy count` / `table count` / `FORCE RLS`). Full rollback, never READY. Retry gives READY |
| Drift on an already-READY schema: dropped policy / table / FORCE | CWV02 with the label. Nothing re-provisioned or re-marked. The helper returns the same label |
| Caller pre-creates temp tables `manager_workspace`, `workspace_schema_registry`, `shift` | No effect. READY. 0 dependencies on `pg_temp*` |
| CREATE SCHEMA, CREATE TABLE in core/public/workspace, ALTER/DROP a workspace table, DISABLE RLS, NO FORCE RLS, DROP/CREATE POLICY, DROP SCHEMA, CREATE TRIGGER, CREATE OR REPLACE / ALTER the function, SET ROLE crewflow / rab_secure_owner, SET SESSION AUTHORIZATION | **all 42501**. RLS/FORCE still on |
| GRANT the function to PUBLIC | No-op: PUBLIC still absent from the ACL |
| A role with only PUBLIC rights plus USAGE on core | 42501 |
| EXECUTE `provision_workspace_schema`, the 4 mutators, `verify_workspace_schema_v1`, the worker discovery functions | all 42501 |

**RLS evidence:**
- Every created table has ENABLE + FORCE RLS, crewflow ownership and at least one policy; the schema is `rab_secure_owner`.
- `crewflow_app` sees 0 rows with no context and 0 rows with another workspace bound.
- **Template parity:** the server-path schema is **identical** to the legacy TypeScript provisioner's schema, built as
  `crewflow`. The comparison covered over 500 normalised catalog facts: columns, defaults, column ACLs, constraints, indexes,
  policies, triggers, owners, RLS flags and namespace ACL.
- An existing workspace is byte-for-byte unchanged when another workspace is provisioned.
- `tools/check-rls-coverage.ts` as `crewflow_app` reports "RLS coverage OK — 57 tenant table(s)" on both throwaway databases
  (`force-rls-coverage.log`).

---

## 7. Files changed

**Created:**

| Area | Files |
|---|---|
| Staged migration (G1) | `packages/rab-server/src/database/typeorm/core/proposed-migrations/1786719500000-ServerPathWorkspaceProvisioning.ts` |
| Template | `packages/rab-server/src/database/typeorm/workspace-schema/v1/server-path-template.ts` and `.spec.ts` |
| Server service | `packages/rab-server/src/modules/manager-workspace/services/workspace-provisioning.service.ts` |
| Phase 7 | `packages/rab-server/src/engine/utils/assert-no-pending-migrations.ts`; `packages/rab-server/src/database/typeorm/scripts/prestart-migrate.ts`; `packages/rab-server/src/database/typeorm/scripts/check-pending-migrations.ts`; `packages/rab-docker/rab/api-prestart.sh`; `packages/rab-docker/rab/api-prestart-test/run-prestart-shell-tests.cjs` |
| Server tests | `packages/rab-server/src/__tests__/integration/server-path-provisioning-{db,api,no-redis}.integration.spec.ts`; `packages/rab-server/src/__tests__/integration/helpers/redis-unavailable-env.ts` |
| Front | `packages/rab-front/src/features/onboarding/setupStages.ts` and `.spec.ts` |
| Report and evidence | this report; `docs/evidence/server-path-provisioning-2026-10-22/**` (gitignored, like all of `/docs/`) |

**Modified:**

| File | Change |
|---|---|
| `packages/rab-server/src/modules/manager-workspace/services/manager-workspace.service.ts` | `create()`, `findReplay()`, a comment |
| `packages/rab-server/src/modules/manager-workspace/manager-workspace.module.ts` | Provider added |
| `packages/rab-server/src/engine/core-modules/audit/audit.service.ts` | 2 actions added. Another session's hunks were preserved |
| `packages/rab-server/src/database/typeorm/core/runtime-database-guard.ts` and `.spec.ts` | Refuses `CREWFLOW_PRESTART_MIGRATION_DATABASE_URL`, `CREWFLOW_MIGRATION_DATABASE_URL` and `CREWFLOW_MIGRATION_APPROVED` in api/worker (spec 8d3). Additive; the bundle session's hunks were preserved |
| `packages/rab-server/src/__tests__/integration/initial-manager-invitation.integration.spec.ts` | Accepts CREATING or READY |
| `packages/rab-front/src/features/onboarding/WorkspacePreparationScreen.tsx` and `.spec.tsx` | Server-derived stages, resume, retry, connection loss. The decorative stage timers are removed |
| `THREAT-MODEL.md` | Appended |
| `docs/HANDOFF.md` | Appended |

**Deliberately unchanged:**
- `packages/rab-server/src/main.ts`: edited, then reverted (no diff);
- `security-posture.golden.txt`: reverted (no diff);
- every file in `core/migrations/`;
- both compose files and both Dockerfiles;
- the worker sources;
- the bundle files.

---

## 8. Tests executed

All runs used throwaway databases only. The logs are in `docs/evidence/server-path-provisioning-2026-10-22/`.

**New suites for this change**

| Suite | Result |
|---|---|
| `server-path-provisioning-db.integration.spec.ts` | **26/26 PASS**, with caches off and again with the entity and auth caches on |
| `server-path-provisioning-api.integration.spec.ts` | **11/11 PASS**, with caches off and with caches on |
| `server-path-provisioning-no-redis.integration.spec.ts` | **1/1 PASS** |
| `workspace-schema/v1/server-path-template.spec.ts` (unit drift guard) | **4/4 PASS**. The first run failed because of a bug in my own regex (it missed `CREATE TABLE IF NOT EXISTS`); fixed and rerun |
| `runtime-database-guard.spec.ts`, including the new case 8d3 | **33/33 PASS** |
| `manager-workspace.create.spec.ts`, updated for the new dependency | **1/1 PASS** |

**Front-end**
- **87/87 PASS:** `setupStages.spec.ts`, `WorkspacePreparationScreen.spec.tsx`, the other onboarding specs and `OnboardingRouteGuard.spec.tsx`.
- `tsc` is clean for rab-front and rab-server (app config).

**Phase 7**
- **Shell tests, 15/15 PASS** (`run-prestart-shell-tests.cjs`, real BusyBox sh, real `/proc`).
- **Database tests, 13/13 PASS** (`phase7-prestart-db-tests.log`, throwaway DB 2, the real compiled scripts and `main.js`):
  - a pending migration without approval is refused (exit 65);
  - two replicas racing apply the migration once;
  - a failed migration exits 70, records nothing, and `main.js` never starts;
  - recovery after the failure works;
  - a leaked migration credential is refused;
  - a repeat run is a no-op.

**Runtime evidence, 10/10 PASS** (`runtime-api-worker-evidence.log`, DB 2)
- API and Worker reported the same cluster identity.
- Health checks passed.
- The Worker survived SIGKILL and restarted.
- No privileged session was opened.

**RLS coverage:** `tools/check-rls-coverage.ts`, run as `crewflow_app`, reports OK for 57 tables on both throwaway databases.

**Existing suites, cache off, targeted rerun after fixes** (`jest-rerun-cacheoff.log`)
- 22 suites and 293 tests: **292 pass**.
- The single failure was my template spec, fixed above.
- The rerun covered:
  - workspace onboarding, abuse cases and fresh-poll;
  - the initial-manager invitation;
  - definer authorisation, the runtime DB role and lifecycle grant tightening;
  - organisation isolation and workspace execution context;
  - custom roles and forced RLS;
  - auth, session and cookie handling;
  - staff-profile RLS and the composite FK attack.

**Existing suites, cache ON** (`jest-rerun-cacheon.log`)
- 11 suites and 150 tests: **148 pass**.
- Neither failure is caused by this change:
  - **`manager-workspace-fresh-poll` test 1:** it asserts cache-OFF behaviour by design.
  - **`initial-manager-invitation`, the "maxed-out invite … deleted by CEO" test:** fails with PostgreSQL `out of shared memory`, reproduced alone (`jest-rerun-cacheon-imi.log`).
    - DB 1 had accumulated 183 provisioned workspace schemas, which means 5,606 foreign keys reference `core."user"`.
    - Deleting a user must lock every referencing table, which exhausts `max_locks_per_transaction` (64).
    - This is a pre-existing property of the per-workspace FK design (§12, finding 7).

**Full rab-server suite, run before my fixes, on DB 1** (`jest-full-server-run1.log`)
- 155 of 163 suites ran: 142 passed, 13 failed.
- 1,944 tests passed, 26 failed.
- **Two failures were caused by this change. Both are fixed and pass:**
  - `manager-workspace.create.spec`, a constructor argument;
  - `initial-manager-invitation`, which asserted the old always-CREATING contract.
- **One failure is expected:** `db-security-posture`. The staged function exists on DB 1 but the golden file was not updated, by design; see `proposed/security-posture.golden.diff`. It also shows the pre-existing `navigation_layout` drift.
- **One failure was environmental:** `manager-workspace-onboarding` hit a host "Memory allocation error". It passes in the rerun.
- **Nine failures do not touch workspace creation, provisioning or any file I changed:**
  - `tenant-context.service.spec`: a stale `set_config` expectation;
  - `identity-security-table-rls`: column-grant assertions;
  - `shift-team`: expects 400, gets 404, for a non-uuid id;
  - `audit-log-immutable-identifiers`;
  - `hws-backfill`: teardown hits `permission denied for table audit_log`;
  - `realtime-gateway`, `dashboard-search` and `containment-suspend-test-accounts`: hook timeouts;
  - `member-invitation`: 503.
- These nine were not re-baselined without my change, because stashing other sessions' work is not allowed.

**Full rab-worker suite** (`jest-full-worker-run2.log`, DB 2, run alone with a 3 GB heap; the first attempt hit a heap OOM while running beside the server suite)
- 28 of 29 suites ran: 25 passed, 3 failed. 419 tests passed.
- **All ordinary jobs PASS:**
  - email delivery and the mail pool;
  - push dispatch;
  - the shift monitor and its reminders;
  - offer lifecycle;
  - replacement staff and the standby timeout;
  - no-show handling, attendance lifecycle, confirmation timeout and late clock-in;
  - shift statement and PDF generation;
  - report concurrency;
  - the realtime outbox, publisher and claim;
  - due work and invite cleanup;
  - the runtime cutover and the verified-role database;
  - same-org isolation;
  - legacy workspace provisioning.
- **The three failures:**
  - `workspace-provisioner-entrypoint` only lacked its harness variable `TEST_DATABASE_CREWFLOW_URL`. With it set, it passes 5/5 (`jest-worker-provisioner-entrypoint.log`), so the rollback path works next to the server-path function.
  - `member-invitation-delivery` and `worker-operations-abuse-cases` are outside this change: `dto.objects is not iterable` in member-role code, and the refresh-token cleanup.

**Not run**
- The full rab-front suite. Only the onboarding specs and the route guard ran.
- rab-mobile. It is out of scope and does not provision.

---

## 9. Concurrency and failure evidence

**DB layer** (§6):
- 3-way race: READY once.
- Mid-template failure, stray object, killed backend, tampering: all roll back to 0 objects.
- Retry from FAILED and from stranded CREATING: both reach READY.

**API layer** (`server-path-provisioning-api.integration.spec.ts`, 11 of 11 on throwaway DB 1, two Nest application instances):
- **Duplicate click:** 2 concurrent POSTs give 201+201, the same id, `created`=1 and `provisioned`=1.
- **Two replicas:** 3 POSTs across 2 apps give 201×3, one schema, READY once.
- **Lost response:** the client aborts after 5 ms, the server completes, and the retry is a replay.
- **DB connection killed mid-template:** 201 with CREATING, nothing partial, and the retry reaches READY.
- **SQL failure:** 201 with FAILED and a safe audit entry; the retry reaches READY. Audit counts are created 1, failed 1,
  provisioned 1.
- **Server restart:** a CREATING workspace is completed by a freshly booted instance.
- **Cross-org and cross-owner:** 404, victim untouched.
- **Body carrying `organisationId`/`ownerUserId`/`schemaStatus`/`workspaceId`:** 400.
- **No token:** 401. **Staff:** 4xx and nothing created.
- **Different body:** still 409.

**No Redis** (`server-path-provisioning-no-redis.integration.spec.ts`, 1 of 1):
- API booted with `REDIS_URL=redis://127.0.0.1:1` (closed port) and `CORE_ENTITY_CACHE_ENABLED=true`.
- Result: READY in about 2.6 s, audit created 1 / provisioned 1, idempotent replay.

**Runtime** (`runtime-api-worker-evidence.log`, 10 of 10 on throwaway DB 2):
- The real API (`dist/main.js`) and Worker (`rab-worker/src/main.ts`) both log `role=crewflow_app` and the **same**
  `cluster=7699538516759855138`.
- No session as `crewflow`, `rab_secure_owner` or `rab_owner` while they run.
- **Worker SIGKILL:** the API's `/healthz` stays 200, and `core.provision_workspace` still provisions to READY with no Worker.
- **Worker restart:** it reaches ready.
- The Worker ran no provisioning work.

---

## 10. Deployment files

The defaults are unchanged (G2). The proposals are in `docs/evidence/server-path-provisioning-2026-10-22/proposed/`:
- `docker-compose.production.server-path.yml` and `.diff`: `rab-worker` goes back to the shared Dockerfile with
  `node packages/rab-worker/dist/main.js`, `crewflow_app` only, plus `DATABASE_DIRECT_URL`. No launcher, no provisioner
  child, no `CREWFLOW_PROVISIONER_DATABASE_URL`, no provisioner temp dirs or health checks. `rab-api` and `rab-migrate` are
  unchanged. `docker compose config -q` passes.
- `docker-compose.server-path.yml` and `.diff`: the same change for the dev stack. The Worker is restored to its pre-bundle
  shape, with `DATABASE_DIRECT_URL` kept.
- `security-posture.golden.diff`: the posture lines for G1.

**Phase 7 prestart.** It is **not** wired into any compose file. Adopting it means:
- set the `rab-api` command to `sh ./api-prestart.sh`;
- add `COPY packages/rab-docker/rab/api-prestart.sh ./api-prestart.sh` to the Dockerfile.

It needs separate approval.

**Rollback artifacts kept:**
- `Dockerfile.worker-bundle` and `worker-bundle/**`;
- the current bundle compose files;
- `docs/evidence/worker-bundle-2026-10-22/docker-compose.production.five-service.yml`;
- `rab-worker/src/workspace-provisioner.main.ts`, `workspace-provisioning.job.ts` and `provision-workspace-schema.ts`. These
  are still the reference implementation and the parity baseline.

**OpenShip and ARM64: UNVERIFIED.** There was no access to OpenShip, and no arm64 build or run was done.

---

## 11. Rollback procedure

- **Before G1 (now):** nothing to roll back. The default topology is unchanged. The server code degrades to `DEFERRED`, the
  API answers CREATING, and the Worker provisioner completes the workspace.
- **After G1, before G2:** run the migration's `down()`, which drops both functions. The API returns CREATING (42883/42501 is
  handled as `DEFERRED`) and the bundle provisioner completes it. This was tested: with EXECUTE revoked, the API answers 201
  CREATING and a later replay reaches READY.
- **After G2:** restore the current bundle compose (or the five-service file) and redeploy the Worker. No schema change is
  needed.
- **Phase 7:** remove `api-prestart.sh` from the `rab-api` command and go back to `node packages/rab-server/dist/main.js`.

---

## 12. Remaining risks and non-parity (each explained)

**Non-parity with Twenty, deliberate:**
- **Separate runtime and DDL authority.** Twenty uses one superuser URL. Crewflow uses `crewflow_app` plus a DEFINER function.
- **FORCE RLS.** Twenty has none.
- **Explicit migrations.** Twenty migrates on every start, swallows errors and takes no lock. Crewflow migrates only with
  approval, fails closed and takes an advisory lock; Phase 7 is opt-in.
- **Failure handling.** Twenty uses compare-and-set with a 5-minute stale reclaim and does not roll back schema or metadata on
  failure. Crewflow uses one atomic transaction, so there is no stale state to reclaim and nothing is left partial.
- **Schema name.** Twenty uses base36; Crewflow uses 32 hex characters.
- **No follow-up jobs.** Crewflow has no metadata sync, prefill or follow-up BullMQ jobs; there is no equivalent feature.

**Risks:**
1. **Lock footprint.** Provisioning takes ShareRowExclusive locks on referenced core tables (`core.user`, `organisation`,
   `manager_workspace`, ...) for about 1 s inside a user request. This is the same footprint as the Worker provisioner, but
   now on the request path.
2. **Template coupling.** Every future workspace-template migration must also re-create `core.provision_workspace`, or the
   two paths diverge. `server-path-template.spec.ts` fails on V1_EXPECTED or table drift. The DB parity test compares the two
   paths.
3. **Dependency on uncommitted work.** The staged migration imports frozen modules from other sessions' uncommitted work:
   `offer-kind.ts` (1786719400000) and `attendance-check-in.ts` (1786719450000). It must ship after them.
4. **Unverified platforms.** OpenShip and arm64 are unverified.
5. **Phase 7 credential exposure.** The prestart's one-time credential still sits in the orchestrator's service config for
   that deploy. That is inherent, and also true of `rab-migrate`.
7. **Pre-existing finding (MEDIUM, availability):**
   ~~~
   [MEDIUM]
   Failure:      any core."user" delete/key update → must lock every referencing table in every workspace_* schema (31 FKs per workspace) → 'out of shared memory' at a few hundred workspaces
   Actor:        ordinary admin flows (user deletion, invite cleanup), no attacker needed
   Location:     workspace-schema/v1/workspace-schema-v1.template.ts (REFERENCES core."user" x31 per workspace)
   Root cause:   per-workspace physical tables carry FKs into core; lock count scales with workspaces x FKs
   Fix:          owner decision: raise max_locks_per_transaction, or replace cross-schema FKs to core.user with app/trigger checks for HWS
   Regression:   reproduced: 183 workspaces / 5,606 FKs -> initial-manager-invitation delete fails (jest-rerun-cacheon-imi.log)
   ~~~
6. **Pre-existing finding (not caused by this change):**
   ```
   [LOW]
   Failure:      bootstrap identity runs post-split migration → table created owned by that identity → posture drift
   Actor:        operator running migrations as a superuser
   Location:     packages/rab-server/src/database/typeorm/core/migrations/1786718600000-NavigationLayout.ts
   Root cause:   new core table not ALTERed OWNER TO crewflow; runtime grant narrower than the golden
   Fix:          follow-up migration: ALTER TABLE core.navigation_layout OWNER TO crewflow + reference grants
   Regression:   db-security-posture.integration.spec.ts on a migrations-only build (fails today: 2 lines)
   ```

---

## 13. Verdict

**PARTIAL.** Server-path provisioning works through the restricted runtime connection, and the security tests prove crewflow_app gained no broad DDL authority (§6). The front stages, Phase 7, runtime, no-Redis and ordinary Worker jobs all pass.

The verdict is not PASS because:
- **(a)** both owner gates are deliberately unapplied;
- **(b)** some existing rab-server/rab-worker suites fail in this environment for reasons outside this change (§8), and they could not be re-baselined without disturbing other sessions' work.

---

## 14. Dev-cutover rehearsal (owner Steps 2–5): read-only target check, backup, rehearsal on a restored copy

**Nothing was applied to `rab-devdb`.**
- HWS was not enabled on it.
- No owner container was stopped, restarted, rebuilt or modified.
- Every write in this section went to `crewflow-devcopy` (127.0.0.1:15493), a new disposable container restored from the backup.

Evidence is in `docs/evidence/server-path-provisioning-2026-10-22/dev-cutover-rehearsal/`.

### 14.1 Target verification (read-only; `default_transaction_read_only=on`, via `docker exec` into the container)

**Identity**

| Item | Value |
|---|---|
| Container | `rab-devdb` (compose project `rab`, service `devdb`), `postgres:16-alpine`, published only on `127.0.0.1:15432` |
| Runtime clients | `rab-server-1` and `rab-worker-1` both use `postgres://crewflow_app:<redacted>@devdb:5432/rab` |
| `current_database()` | `rab` |
| System identifier | `7697007843365589026` |
| Neon check | Not Neon. The endpoint is loopback/container-local; `EXPECTED_PRODUCTION_IDENTITY` is `neon:ep-round-rain-aess0njf` / `neondb` |

**Roles**

| Role | Attributes |
|---|---|
| `crewflow`, `crewflow_app` | LOGIN; not superuser, not BYPASSRLS |
| `rab_secure_owner`, `rab_owner`, `rab_app` | NOLOGIN |
| `rab` | Bootstrap superuser |

**Migrations:** 186 applied, latest `1786719300000` (ManagerMarkPaidInitialManagerCalendar), as expected.

**Pending, in order:**
1. `1786719400000-OfferKind` (untracked, another session's work)
2. `1786719450000-AttendanceCheckIn` (untracked, another session's work)
3. `1786719500000-ServerPathWorkspaceProvisioning` (STAGED, G1)
4. `1786719510000-WorkspaceBoundChecksForLaterTables` (STAGED, new; see 14.3)

**Workspaces**
- 4 schemas: `issac` (CEO), `wstest1`, `wstest2`, `wstest3`. All are READY v1, owned by `rab_secure_owner`, 21 tables each.
- All workspace tables hold **0 rows**. All business data is still in `core`.

**Core row counts**
- **Platform tables:** organisation 1, user 23, manager_workspace 4, manager_profile 8, workspace_membership 23, audit_log 1,392.
- **Business tables, split by workspace** (rows with a NULL `workspace_id`: **none**):

| Table | Total | wstest1 | wstest2 | wstest3 |
|---|---|---|---|---|
| staff_profile | 15 | 5 | 5 | 5 |
| venue | 3 | 1 | 1 | 1 |
| venue_manager_staff | 15 | 5 | 5 | 5 |
| job_role | 3 | 1 | 1 | 1 |
| manager_venue | 4 | 1 | 1 | 2 |
| shift | 13 | 5 | 4 | 4 |
| shift_request_staff | 62 | 22 | 20 | 20 |
| shift_assignment | 62 | 22 | 20 | 20 |
| job_offer | 62 | 22 | 20 | 20 |
| attendance | 30 | 10 | 10 | 10 |
| attendance_correction | 1 | 1 | – | – |
| shift_report | 13 | 5 | 4 | 4 |
| shift_staff_review | 2 | 2 | – | – |
| payroll_record | 5 | 5 | – | – |
| payroll_run | 2 | – | – | 2 |
| user_note | 0 | | | |
| Others | 0 | | | |

Full outputs: `verify-1.txt`, `counts-before.txt`, `dist-before.txt`.

### 14.2 Backup

| File | Size | sha256 |
|---|---|---|
| `C:\Users\issac\crewflow-db-backups\rab-devdb-20261022-183727.dump` (`pg_dump -Fc`, via `docker exec`, read-only snapshot) | **1,726,818 bytes** | `e894aae75bcb362eebabe23fdabc1b1484e3ca98c833eb3e7cf66dcf6e2c6d5d` |
| `C:\Users\issac\crewflow-db-backups\rab-devdb-20261022-183727.globals-no-passwords.sql` (roles, `--no-role-passwords`) | 1,166 bytes | `fc610e60cd256581c803df4763cd4b45acc2f23f2023dc5b7e3a08c89ee43848` |

**Restore verification**
- Target: the new disposable project `crewflow-devcopy`. Globals were restored first, then `pg_restore -C`, with **0 errors**.
- The restored copy is a new cluster: system id `7699547781826109474`.
- **All 147 tables have identical exact row counts** to live `rab-devdb`: `alltables-live.txt` and `alltables-restored.txt` are diff-identical.
- The per-workspace distribution is identical.

### 14.3 Rehearsal on the restored copy

**Migrations** (`rehearsal-migrate*.log`)
- Applied with the repo's **guarded runner**: `coreMigrationDataSource` with the DB_TARGET guard and migration-identity guard, as the bootstrap identity. The two staged migrations were added in memory (`migrate-copy.ts`); the repo's `migrations/` folder was not touched.
- Applied in order: OfferKind → AttendanceCheckIn → ServerPathWorkspaceProvisioning → WorkspaceBoundChecksForLaterTables. Nothing is left pending.

**Finding: schema drift in the existing workspaces (LOW, fixed on the copy by a staged migration)**
- After the migrations, `core.verify_workspace_schema_v1` rejected all 4 existing dev workspaces with `workspace CHECK count` (15 of 21).
- The 6 tables added to the template by later migrations are missing the `<table>_workspace_bound` CHECK in schemas provisioned before those migrations: shift_staff_review, payroll_record, payroll_run, payroll_run_line, payslip, payslip_document.
- RLS still protects those tables; only the defence-in-depth CHECK is missing.
- A new **staged** migration, `proposed-migrations/1786719510000-WorkspaceBoundChecksForLaterTables.ts`, fixes it. It is idempotent: it takes the workspace id from the registry, adds the CHECK `NOT VALID`, then VALIDATEs it.
- After it ran, **all 4 workspaces verify OK**. Everything else already matched V1: 21/21 FORCE, 90 indexes, 39 policies, 128 FKs.

**Backfill (the existing `hws:backfill` command, compiled)**

| Run | Result |
|---|---|
| Dry-run | 4 workspaces, all `safeToApply=true`, 0 conflicts, 0 blocked |
| First `--apply` | **3 of 4 failed** on their first table, because of a pre-existing tool bug |

The tool bug, fixed minimally:
- `HwsBackfillService.writePhysical()` read `core.manager_workspace` before binding any GUC.
- Since the role split, `crewflow` is not that table's owner, so RLS hid the row.
- Fix in `hws-backfill.service.ts`: bind organisation + workspace first. The existing `id = current_workspace()` policy then shows exactly that row. No policy or grant change.

After the fix:

| Workspace | Result |
|---|---|
| `wstest2`, `wstest3`, `issac` | `completed`; `--verify` PASS |
| `wstest1` | **failed at `shift_staff_review`.** Apply stops at the first failed table, so `attendance_correction` and `payroll_record` were never attempted |

**Proof on the copy**

*Row-by-row* (`rowcompare*.txt`; key presence plus md5 of the full row as jsonb, per table and per workspace):
- **269 of 292** core business rows are present in their workspace schema and identical **at millisecond precision**.
- **Every copied `timestamptz` lost its microseconds** (for example `07:38:11.103037` → `.103`).
- **23 rows are missing:**
  - 15 `venue_manager_staff` (5 per workspace), silently skipped;
  - wstest1: 2 `shift_staff_review` and 5 `payroll_record`, refused by RLS, plus 1 `attendance_correction` never attempted.

*FK integrity* (`copy-security.txt`): 128/128 FKs VALIDATED in every workspace schema.

*FORCE RLS and policies:* 21/21 tables ENABLE+FORCE and 39 policies in each schema, with no table lacking a policy. `tools/check-rls-coverage.ts` reports OK (57 core tables). Workspace schemas are covered by `verify_workspace_schema_v1` and the checks above.

*`crewflow_app`:*
- No CREATE on the database, `core` or any workspace schema; owns 0 workspace tables; not a member of `crewflow` or `rab_secure_owner`.
- NOSUPERUSER, NOBYPASSRLS.
- EXECUTE only on `provision_workspace`; `provision_workspace_schema` and `mark_ready` are still denied.

*Cross-workspace denial* (`crewflow_app`, SQL level):

| Context | Result |
|---|---|
| Manager A with a forged workspace GUC = B, `staff_profile` (user-level policy) | 0 rows |
| A in A's own context, reading B's schema | 0 rows |
| No context | 0 rows |
| **A with the forged GUC = B, `shift` (org+workspace-only policy)** | **4 rows readable, and an INSERT into B's `venue` is accepted** |

The last row is the existing GUC-trust model: RLS enforces whatever context is bound, and the server binds it from the verified session. It is identical for the `core` tables today, so it is not new with HWS. It means RLS is not a boundary against SQL running as the runtime role (finding INFO-1).

*Through the API* (`HWS_RUNTIME_ENABLED=true`, `hws-api.log`, `hws-smoke.cjs`):
- The API boots with HWS on; runtime guard `role=crewflow_app`.
- Two Managers in different workspaces log in (200).
- `wstest2` and `wstest3` each see their own data, matching their workspace rows:

| Endpoint | Count |
|---|---|
| staff | 5 |
| venues | 1 |
| job-roles | 1 |
| shifts | 4 |
| offers | 20 |
| attendance | 10 |
| payroll/records | 0 |

- payroll/runs, payroll/calendar and manager-workspaces/me all return 200.
- **A → B** by id returns **404** for staff/:id, venues/:id, shifts/:id/pipeline and attendance/report/shift/:id (timesheet).
- A forged `x-workspace-id` header is ignored.
- **Workspace-schema proof:** a marker written only into B's *workspace* venue row was returned by the API, while `core` was unchanged (`hws-marker.*`).

*Worker with HWS on:* boots (`role=crewflow_app`), reaches `rab-worker ready`, and logged 0 errors in 60 s of job cycles (`hws-worker.log`).

*Shared platform records stay in `core`:*
- All core table counts are unchanged except the migrations ledger (+4), `hws_backfill_checkpoint` (80), and login/session/audit rows from 3 smoke-test logins.
- No core business row was modified or deleted; the backfill only copies.

**Structure, before and after (on the copy)**

| | Business data | Workspace schemas | Migrations | Runtime |
|---|---|---|---|---|
| Before | `core` only | 21 empty tables each, READY | 186 | HWS off |
| After | Unchanged in `core` | 269 copied rows, 6 new CHECKs | 190 | HWS on reads the workspace schemas |

### 14.4 Findings from the rehearsal (§5.8)

```
[HIGH]  (blocks the dev cutover)
Failure:      hws:backfill → copies 0 of core.venue_manager_staff for every workspace → verify PASSes → venue-manager
              staff assignments silently disappear under HWS
Actor:        operator running the approved backfill (no attacker)
Location:     packages/rab-server/src/database/typeorm/workspace-schema/backfill/hws-backfill.service.ts (readCore: crewflow_app
              / actor_type=worker cannot see venue_manager_staff under its RLS; dry-run reports sourceRowCount 0)
Root cause:   source reads go through RLS policies that have no worker/backfill read path for this table, and the
              tool trusts the count it can see
Fix:          give the backfill a source read that cannot under-count (e.g. compare against a bootstrap-identity
              count, or add a narrow worker-scan SELECT policy for venue_manager_staff) and FAIL when the visible count
              differs from the true count
Regression:   rowcompare.sql on a restored copy: venue_manager_staff missing 5/workspace (dev-cutover-rehearsal/)
```
```
[HIGH]  (blocks the dev cutover; owner decision: touches payroll + RLS)
Failure:      hws:backfill → INSERT historical shift_staff_review / approved payroll_record rows → rejected by the
              tables' actor-oriented WITH CHECK (reviewer_user_id = current_uid(); status = 'pending_approval') →
              workspace cannot be completed
Actor:        operator running the approved backfill
Location:     workspace template policies shift_staff_review_scope, payroll_record_insert (+ hws-backfill writePhysical)
Root cause:   the backfill writes as the workspace owner through runtime-actor policies; historical rows legitimately
              have other actors / later states
Fix:          OWNER DECISION, not invented here. Options: (a) a narrow, migration-defined backfill INSERT policy gated
              on a dedicated GUC (rab.actor_type='backfill') plus org/workspace match, only for the copy; (b) run the
              copy as the bootstrap superuser in a one-off migration (RLS bypass, audited); (c) leave those historical
              rows in core and route only new rows (no).
Regression:   backfill --apply on the restored copy: wstest1 shift_staff_review failed (backfill-apply*.json)
```
```
[MEDIUM]
Failure:      hws:backfill → copies timestamptz through JS Date → microseconds truncated on every copied timestamp
Location:     hws-backfill.service.ts insertRows/readCore (pg → Date → pg)
Root cause:   timestamps are materialised as JS Date (millisecond precision)
Fix:          read/write timestamp columns as text (pg type parser override for the backfill connections) or copy with
              INSERT ... SELECT inside one statement; extend --verify to compare full-precision values
Regression:   rowcompare.sql (full precision) vs rowcompare-ms.sql: 0 vs 269 identical rows
```
- **[FIXED in the working tree, LOW]** The `writePhysical()` GUC ordering bug described in 14.3.
- **[LOW]** The missing `_workspace_bound` CHECKs on 6 tables in pre-existing workspaces. Fixed by the staged migration 1786719510000.
- **[INFO-1]** GUC trust model. RLS isolates workspaces only as far as the bound context is honest; a SQL-level actor that can set GUCs (SQLi or RCE as `crewflow_app`) crosses workspaces on org+workspace-only policies. This is unchanged by HWS and recorded for awareness.
- **[MEDIUM, from §12]** Lock exhaustion as workspace count grows (5,606 FKs to `core.user` at 183 workspaces).

### 14.5 Proposed steps to apply to `rab-devdb` (NOT executed; needs owner approval)

**Prerequisites:**
- Fix the two HIGH backfill findings and the MEDIUM precision finding.
- Make the owner decision for the payroll/review copy authority.
- Approve G1 and the second staged migration.
- Re-run this whole rehearsal on a **fresh** restore until row-compare shows 292/292 identical at full precision.

**Steps:**
1. **Fresh read-only backup** of `rab-devdb` (`pg_dump -Fc` via `docker exec`). Verify it by restoring to a disposable container, as in 14.2. *No restart.*
2. **Move the staged migrations** into `core/migrations/` and apply `proposed/security-posture.golden.diff`. *Source change only.*
3. **Apply the migrations** through the dev `migrate` service: `docker compose --profile migrate run --rm migrate`, with the bootstrap identity and the explicit approval it requires. *Needs a rebuild of the migrate/app image so the new migrations are inside it. One-shot container; `server` and `worker` keep running.*
4. **Rebuild and restart `server`** to pick up server-path provisioning, the backfill fix and the front changes. *Container rebuild + restart.*
5. **Run the backfill** with the `cli` / command image as `hws:backfill --all --dry-run`, then `--apply` (with the `crewflow` owner connection, for this run only), then `--verify`. Then run `rowcompare.sql` / `rowcompare-ms.sql`, `copy-security.sql` and `check-rls-coverage`. *One-shot container, no restart.*
6. **Turn HWS on:** set `HWS_RUNTIME_ENABLED=true` for `server` and `worker`. *Env change → restart both containers.*
7. **Smoke-test** as in 14.3 (Managers in two workspaces, cross-workspace 404s, marker check, worker cycles).

**Rollback:**
- **Fast:** set `HWS_RUNTIME_ENABLED=false` and restart `server`/`worker`. `core` still holds every business row, so this is exact **for data written before the cutover**.
- **Data written after the cutover** lives only in the workspace schemas. A reverse copy (workspace → core) does not exist and would have to be built before turning HWS on for real use.
- **Full:** stop `server`/`worker`, then `pg_restore --clean` the step-1 backup into `rab-devdb`. This is destructive and needs explicit approval.
- G1 rollback is in §11.

---

## 15. Owner decision "Option 1" executed: backfill fixes, re-rehearsal, and the approved `rab-devdb` migration

The owner approved:
- **Option 1**, a one-off approved copy, for the rows the runtime-actor policies reject;
- **migrating `rab-devdb` only**, conditional on exact identity verification and a verified, restorable backup;
- applying **G1 to `rab-devdb`**.

Production was **not** approved. HWS is **not** enabled. **No container was rebuilt or restarted**: `rab-server-1`, `rab-worker-1`, `rab-front-1`, `rab-devdb` and `rab-redis-1` show the same uptimes, `rab-server-1` `/healthz` returns 200, and neither container logged an error. The compose topology (G2) is unchanged.

### 15.1 Fixes (A) — the existing `HwsBackfillService`; no new service

| Fix | What changed |
|---|---|
| **Under-count** | Source and target reads bind the workspace **owner** as `rab.user_id`, in addition to `actor_type='worker'`; this is the same identity `writePhysical` already asserts. All policies are PERMISSIVE (none RESTRICTIVE), so binding adds visibility and never hides a row. `venue_manager_staff` is now fully visible. |
| **Fail-closed `--verify`** | A workspace passes only if, for every table: a privileged **census** exists (an audit_log row written by the migration identity, carrying the authoritative per-table counts); the visible count equals the true count; the physical count equals the true count; and every row is identical in **every column at full precision**. A missing census means FAIL. |
| **Precision** | Rows are read as canonical `to_jsonb(row)::text` and inserted through `jsonb_populate_record(NULL::<target table>, …)`. Nothing passes through JS Date or number, so microseconds and exact bigint pence are preserved. |
| **Option 1 tables** | `PRIVILEGED_COPY_TABLES` = payroll_run, payslip, payslip_document, shift_staff_review, payroll_record, payroll_run_line. Their only FK children are inside the family. The tool never writes them, reports `deferred-to-privileged-copy`, keeps processing later tables, and still verifies them. |
| **One-off migration** | `core/migrations/1786719520000-HwsHistoricalRowsPrivilegedCopy.ts`, with its logic in the frozen `workspace-schema/backfill/privileged-copy.ts`. Details below. |
| **`writePhysical` GUC-order fix** | From §14. |

**What the one-off migration does:**
- Runs only through the guarded runner, as the migration identity; it **refuses** unless that identity is SUPERUSER or BYPASSRLS.
- Copies each row into the workspace named by `core.<table>.workspace_id`, which is resolved to its registry schema (canonical name checked).
- Is idempotent: `ON CONFLICT DO NOTHING`, then verifies **all 21 tables** of every processed workspace against core at full precision, in both directions. **Any difference raises and rolls back.**
- Writes one audit_log row per workspace (`workspace.hws_backfill_privileged_copy`, holding the copied rows and true counts).
- Skips, with an audit row, any workspace that was never backfilled.
- Adds **no** policy, grant, function, role or GUC bypass, and never modifies or deletes a core row.
- `down()` removes only the copied rows.

**Tests**
- `hws-backfill.integration.spec.ts` now passes **10/10**. Before, it never passed: its teardown deleted organisations, which cascades into the insert-only `audit_log`; that step is now best-effort.
- Two tests now assert that verify fails closed before the census and passes after it.
- New test, *no under-count / full precision / privileged copy / fail-closed census / idempotent / core intact / posture unchanged*. It covers:
  - a `venue_manager_staff` row that the old read missed;
  - microseconds preserved;
  - a review written by another user, deferred by the tool and then copied by the privileged step;
  - **posture byte-identical** before and after;
  - a second run copies nothing;
  - tampering makes verify fail and the migration raise, with no audit row written;
  - core drift after the census makes verify fail at full precision;
  - core row counts unchanged.

**Final regression** (throwaway DB migrated with the final chain; `jest-final-regression.log`): **17/18 suites, 200/201 tests**. The suites:
- hws-backfill;
- the server-path db, api and no-redis suites, now running without the opt-in gate;
- definer-function-authorisation, runtime-db-role, workspace-lifecycle-grant-tightening;
- all manager-workspace suites, initial-manager-invitation, organisation-isolation, workspace-execution-context;
- template, fk-graph, runtime-guard and create unit specs.

The single failure is `db-security-posture`, and only because of the **pre-existing** `navigation_layout` build-identity drift (§12). The 7 G1 golden lines now match.

### 15.2 Re-rehearsal (B) on fresh restores — all checks passed, twice

The run used the first backup, then again on the new backup in phase C1. The sequence:
1. Fresh disposable restore; row counts equal to the source.
2. Schema migrations through the guarded runner.
3. Workspace structure verify.
4. Backfill dry-run and apply.
5. Posture P2, the privileged copy, posture P3.
6. Backfill `--verify`.
7. Independent full-precision row compare and amounts.
8. FK / constraint / RLS / privilege checks.
9. Core-intact check.
10. HWS-on isolation smoke.

| Result | Evidence |
|---|---|
| **292/292** core business rows identical in their workspace schema at **full precision** | `rowcompare.txt` |
| **80/80** table×workspace pairs with equal row count, sorted-ID md5 and sums of every `*_pence` / `*_minutes` column | `amounts.txt` |
| Posture **P2 == P3**: the privileged copy changed nothing (608 lines). P0 → P1 = exactly the 7 approved G1 lines | |
| FKs 128/128 validated per workspace; FORCE RLS 21/21 with 39 policies; no table without a policy | |
| The 6 pre-existing `NOT VALID` CHECKs (identical set in the live source) have **0 violating rows**; 0 unvalidated FK/unique constraints | |
| `crewflow_app` unchanged and restricted | |
| HWS-on smoke **48/48** | `hws-smoke.log` |
| Worker with HWS on: ready, 0 errors in 60 s | |

The HWS-on smoke covered:
- 3 Managers in different workspaces, each seeing exactly their own counts (staff, venues, job roles, shifts, offers, attendance, and the 5 approved payroll records for wstest1);
- payroll runs, the calendar and `me` returning 200;
- 12 cross-workspace by-id requests (staff, venue, shift pipeline, timesheet report) all returning **404**;
- a forged `x-workspace-id` header ignored.

Evidence: `dev-cutover-rehearsal-b/` and `dev-cutover-apply/rehearsal-on-new-backup/`.

### 15.3 `rab-devdb` identity (re-verified, read-only)

| Check | Value |
|---|---|
| Container | `rab-devdb`, compose `rab/devdb`, published only on **127.0.0.1:15432** |
| Database | **rab** |
| System identifier | **7697007843365589026** |
| Roles | `crewflow` and `crewflow_app` present, neither superuser nor BYPASSRLS |
| Migrations before apply | **186, latest 1786719300000** |
| Neon check | Not the Neon production endpoint `ep-round-rain-aess0njf` |

Credentials came from container configuration (`rab-devdb` POSTGRES_PASSWORD, the `rab-server-1` runtime URL, the exited `rab-provisioner-1` owner URL). They were held only in shell variables and never printed or written; the evidence was scanned for them.

### 15.4 New backup (C2)

| File | Size | sha256 |
|---|---|---|
| `C:\Users\issac\crewflow-db-backups\rab-devdb-20261022-191834.dump` | **1,726,818 bytes** | `9a1be1efac584edc84d1213d7d7f1cdf8faf9d3b173c70530998096c3fd38d6c` |
| `…-191834.globals-no-passwords.sql` | | `8623d9f50bccd5458d2249701283d8bf1058864f2427afb270386483d7b9beb9` |

- Live row counts were identical immediately before and after the dump (147 tables).
- The backup was restored into a fresh disposable container with **all 147 table counts equal**, and the full rehearsal (15.2) passed on it.
- No row changed between the backup and the apply (checked).

### 15.5 Migrations applied to `rab-devdb` (guarded runner, one-shot from the host, bootstrap identity; no image built)

**Run 1:** OfferKind1786719400000, AttendanceCheckIn1786719450000, ServerPathWorkspaceProvisioning1786719500000 (**G1**), WorkspaceBoundChecksForLaterTables1786719510000.
- **Posture diff: exactly the 7 G1 lines.** `crewflow_app` gained EXECUTE on `core.provision_workspace` only.
- All 4 workspaces pass `verify_workspace_schema_v1`.

**Backfill:**
- dry-run: 4/4 safe.
- apply: 4/4 OK. wstest1 and wstest3 report `partial` only because they have deferred-table rows.

**Run 2:** HwsHistoricalRowsPrivilegedCopy1786719520000.
- wstest1: 2 shift_staff_review and 5 approved payroll_record rows copied.
- wstest3: 2 payroll_run rows copied.
- All four workspaces: `copied-and-verified`.
- **Posture P2 == P3, byte-identical.**

**`hws:backfill --verify`: 4/4 PASS** (census, true counts, full precision). It still passed when rerun later.

**Comparison against `rab-devdb` itself:**
- **292/292** identical at full precision; **80/80** counts, IDs and amounts equal.
- FKs 128/128 validated per workspace; FORCE RLS 21/21 with 39 policies.
- 0 rows violate the `NOT VALID` CHECKs; `crewflow_app` restricted; `check-rls-coverage` OK (57 tables).

**Core intact:** every core business and platform row is unchanged. Only `core.migrations` (186 → 191), `hws_backfill_checkpoint` (0 → 60) and `audit_log` (+4, the copy audit rows) grew.

**Repository state:** 1786719500000, 1786719510000 and 1786719520000 now live in `core/migrations/`. The golden file includes the 7 G1 lines. The server-path specs no longer need the opt-in variable. `core/proposed-migrations/` is empty.

### 15.6 Exact restart and HWS-enable steps (for owner approval — NOT executed)

New writes since the census go to `core` only, while HWS is off. So HWS must be enabled from a **frozen, re-reconciled** state:

1. **Freeze writes.** `docker compose stop server worker` in `packages/rab-docker`. *(Stops two owner containers; needs approval.)*
2. **Check for drift.** Run `hws:backfill --all --verify` (read-only, as above).
   - If it still PASSes: go to 4.
   - If it FAILs because data changed after the census, go to 3.
3. **Reconcile** (only if 2 failed). Run `hws:backfill --all --apply`, then a **new** one-off migration (new timestamp, same frozen helper `runHwsPrivilegedCopy`) through the guarded runner. This copies any new deferred-table rows and writes a fresh census. Then verify again. *This step needs approval: it is a new migration.*
4. **Rebuild** the server image so it contains server-path provisioning and the backfill fixes, and the worker image: `docker compose build server worker`. *(Image rebuild.)*
   - With G2 still unapproved, the worker stays on the bundle image, and its provisioner child keeps working alongside server-path provisioning.
   - If G2 is approved, use the proposed dev compose instead.
5. **Enable HWS** by setting `HWS_RUNTIME_ENABLED: 'true'` on both `server` and `worker`, either in compose `environment` or in the env file the owner uses.
6. **Recreate and smoke-test.** `docker compose up -d --no-deps server worker` *(container recreate)*, then run the 15.2 smoke with real dev Manager accounts. The smoke resets test passwords, so it must not run against dev; use real logins.
7. **Watch the logs.** If anything is wrong, set `HWS_RUNTIME_ENABLED=false` and recreate the two containers.

### 15.7 Rollback

- **Now:** nothing to roll back at runtime. HWS is off, every reader uses `core`, and `core` is intact.
- **Undo the copies:** the `down()` of 1786719520000 deletes only the copied deferred rows. The tool-copied rows are inert while HWS is off.
- **Undo the migrations:** the `down()` of 1786719500000 drops the provisioning functions. 1786719510000's `down()` is a documented no-op.
- **Full:** stop `server`/`worker`, then `pg_restore --clean --if-exists -d rab` from `rab-devdb-20261022-191834.dump` (sha256 above), then restart. This is destructive; ask first.
- **After HWS has been on:** data written then lives only in the workspace schemas. A reverse copy does not exist; build and rehearse one before any production use.

### 15.8 Outstanding issues

- **Neon:** the one-off migration requires an RLS-exempt migration identity. Neon's bootstrap role is unverified, and production is not approved.
- **The census is a snapshot.** Any core write after it makes verify fail until re-reconciled (15.6 step 3). This is intended.
- **Shared test DB `crewflow-test-db` (15436):** its harness applies the chain. 1786719520000 audits-and-skips never-backfilled workspaces, but **raises** if a backfilled workspace differs from core (for example leftover fixtures from an old backfill run). Clean such fixtures before migrating it.
- **Check-in default:** from AttendanceCheckIn, `check_in_required` defaults to `true` for bookings created from now on. The running old dev server ignores the column, but bookings created before the new code is deployed will require check-in once it is. (This is the other session's migration; flagged, not changed.)
- **Front already live:** the dev front (`rab-front-1`, bind-mounted) already serves the new preparation screen. Against the old server, its one resume POST receives the old 409 and simply re-reads.
- **Not caused by this work:** the `navigation_layout` posture drift (§12) and the lock-exhaustion finding (§12, finding 7).
