# Migration, preflight, backup/restore and rollback plan (owner decision R7)

Status: **PLAN ONLY, 2026-11-03.** No database was changed for this plan, and nothing here authorises a migration. Each
environment and each step needs its own owner approval: staging, the temporary OpenShip/Neon database (R4: never
migrated or redeployed without separate approval) and production.

Evidence: everything marked MEASURED comes from throwaway local databases only. Nothing here was measured on a real or
production-sized database.

Code reference: the migration chain on `build/docker-hardening-h6`, which matches `main` at `1efaea43` for everything
under `packages/rab-server/src/database`.

## 1. Facts this plan depends on (from the code)

| Fact | Value | Where |
|---|---|---|
| Migrations shipped | **250** (`core/migrations/*`), the newest 1786721350000 | `packages/rab-server/src/database/typeorm/core/migrations/` |
| Gated (outside the migration glob, never run) | **1786721330000** `WorkerDueWorkClaimsToWorkerRole` | `core/gated-migrations/` |
| Production approval marker | `PRODUCTION_APPROVED_THROUGH = 1786719300000`: **186** migrations at or before it, **64** after it | `core/production-migration-approval.ts` |
| Approved after the marker (N1 list) | **none**: `PRODUCTION_APPROVED_MIGRATIONS` is empty, so a `DB_TARGET=production` run refuses the WHOLE run while any of the 64 is pending | same file |
| Retired migrations | **none**: `RETIRED_MIGRATIONS = []`, so 1786719520000 is still loaded | `core/retired-migrations.ts` |
| Fresh-install phases | **Phase A**: 128 migrations before the role split, run as `rab_owner`. **Phase B**: 122 migrations from `CrewflowSingleCredentialRoleArchitecture1786682000000`, run as the bootstrap identity (a superuser, or a role that can act as both `rab_secure_owner` and `crewflow`) | `core/migration-identity.ts` (CF-41) |
| Later releases | `crewflow_migrator` (restricted: NOSUPERUSER NOBYPASSRLS NOCREATEROLE, member of `rab_secure_owner` + `crewflow`) | M2 harness, `scripts/migration-security-check.ts` |
| `DB_TARGET=staging` | **refused**: there is no staging command path | `core/database-target.ts` |
| Runtime classification | a `NODE_ENV=production` process must declare `CREWFLOW_DEPLOYMENT_ENVIRONMENT=production`, and the database marker must agree | `deployment-identity/deployment-identity.ts` |
| Release step | `deploy-prepare.js` (rab-migrate). Exit **0** = nothing pending, or applied with the token and post-checks passed. Exit **3** = pending and not approved (prints the list and the token). Exits **64–69** = refused or failed, by kind (64 config, 65 behind, 66 migration failed, 67 identity, 68 post-check, 69 lock timeout), including a stale, foreign or malformed token and the retired constant `apply-pending-migrations`. Always in token mode: without a token it is a check run that applies nothing | `scripts/deploy-prepare.ts` |
| Approval token (F5) | `pending-<count>-<sha256 over "crewflow-migration-approval-v1" + the pending names in run order>`, recomputed after the migration lock | `scripts/migrate/migration-approval.ts` |
| Migration lock | Session advisory lock `0x637265776d696772`, waited for up to `CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS` (default 600 s, range 1–840). After it is acquired, the session's own `lock_timeout` is restored | `scripts/migrate/migration-lock.ts` |
| Statement timeout | migration sessions 900 s | `core/core.datasource.ts` |
| Non-transactional migrations | 1786676100000, 1786719810000, 1786719920000, 1786719950000, 1786720110000, 1786721090000, 1786721320000: partial DDL is possible on failure; each is written to be re-run | the files (`transaction = false`) |
| Post-checks (apply runs) | nothing pending; secure-owner invariants; RLS enabled on every `core` tenant table; the migration identity owns nothing; schema compatibility (every READY workspace at the latest module) | `scripts/migrate/deploy-post-checks.ts` |

## 2. Exact pending lists

### 2.1 Target (i): a fresh, isolated staging install

All **250** shipped migrations are pending on an empty database. 1786721330000 is **excluded**: it lives in
`core/gated-migrations/`, which the runner cannot see.

| Step | Identity | Migrations | Applied when |
|---|---|---|---|
| Phase A | `rab_owner` (created by the init script, owns the database and `core`), `CREWFLOW_MIGRATION_PHASE=A` | the 128 migrations from `InitSchema1786665600000` up to (not including) the role split. The run stops at the role split, which refuses `rab_owner` | bootstrap |
| Phase B | the bootstrap identity (self-hosted: a SUPERUSER login enabled only for this run), `CREWFLOW_MIGRATION_PHASE=B`, `CREWFLOW_BOOTSTRAP_PASSWORD` / `CREWFLOW_APP_BOOTSTRAP_PASSWORD`, `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=unbound-production-database` + `PG_EXPECTED_DATABASE_NAME` | the remaining **122**: the role split and the 15 historical privileged migrations (ROLES 1786682000000, 1786687000000, 1786688000000, 1786691000000; HAND_OVER 1786693000000, 1786695000000, 1786703000000–1786707000000, 1786715000000, 1786717400000, 1786717700000, 1786717800000), the rest of the pre-marker chain up to 1786719300000, and **all 64 post-marker migrations** in §3 | bootstrap |
| Gated | — | 1786721330000 | never (separate approval: new id, moved into `core/migrations/`) |

**Gates in front of this install** (each one blocks it until resolved):

1. **N1 code change (NEEDS OWNER APPROVAL).** Staging must run with `DB_TARGET=production` (§4.1). The approval check covers
   *every* pending migration, so even phase A is refused while the 64 post-marker names are not in
   `PRODUCTION_APPROVED_MIGRATIONS`. The release images must be built from a commit that approves them by name. The
   same image would then carry the same approvals for production. A production run still needs its own token and
   window, but this is a decision for both environments at once.
2. **1786719520000** (dev-only privileged HWS copy): approve it explicitly (on an empty database it copies nothing), or
   retire it first through `RETIRED_MIGRATIONS` and a loader change (owner decision; Phase B procedure §c).
3. **1786719500000 / 1786719510000 (G1-prod)**: server-path provisioning (the `crewflow_app` EXECUTE grant). Phase B code
   refuses a production-classified start without `core.provision_workspace`, so these cannot be skipped.
4. **Phase D (1786721300000–1786721350000):** the operator creates `crewflow_app` **and** `crewflow_worker` before phase B.
   1786721300000 refuses without the reviewed `crewflow_worker` shape, and `crewflow_worker` must be a member of
   `crewflow_app`, which phase B would otherwise create later. The **14-day maximum** between applying Phase D and
   global activation starts at this install, and global activation is blocked until #24 (PR #26) is merged and
   deployed. Phase D runbook §11 therefore says not to apply Phase D before #26. Either install staging only after #26,
   or record an owner exception to the 14-day rule for staging.

### 2.2 Target (ii): the temporary OpenShip/Neon database (DO NOT MIGRATE; R4)

The ledger is **unknown**. The last known production marker is **1786719300000**: the reviewed baseline of the
2026-10-22 release, which was never confirmed as applied. The endpoint has been idle and quota-suspended. Relative to
the marker:

| Inventory result | Case | Pending set |
|---|---|---|
| every one of the 186 migrations up to the marker applied, nothing unknown | **L1** | exactly the **64** migrations in §3 (59 from before Phase D + the 5 Phase D ones) |
| some migrations up to the marker missing | **L2** | those missing names (from 1786682000000, the role split, onwards in the worst case) **plus** the 64. ESTIMATE from the 2026-10-23 release kit's assumption of 107 applied: about 143 pending. After the role split, an image-only rollback is impossible (old images use `rab_app` / `rab_owner`, which become NOLOGIN) |
| any applied name not in this code | **unknown** | **STOP.** Every process refuses an interleaved ledger |

**Read-only inventory that answers this question** (generated from the shipped code, so it cannot drift):

```bash
node packages/rab-docker/staging/print-ledger-inventory-sql.cjs > ledger-inventory.sql
# ONLY after a separate owner approval, on a BRANCH of the Neon project first, never on the pooler host:
# The connection comes from a pg_service.conf entry plus a 0600 PGPASSFILE: never a URL with a password in argv or history.
PGOPTIONS='-c default_transaction_read_only=on' PGSERVICE=<inventory-service> psql \
  -X -v ON_ERROR_STOP=1 -P pager=off -f ledger-inventory.sql > ledger-inventory-<utc>.txt
```

- **What it prints:**
  - L0: the session is read-only, plus the login's attributes;
  - L1: counts by kind (`applied`, `pending_le_marker`, `pending_after_marker`, `unknown`, `gated_applied`);
  - L2: every non-applied name in run order;
  - L3: the names applied after the marker;
  - L4: the attributes of the roles the release depends on;
  - L5: the `crewflow_worker` shape.
- **What it does not do:** it writes nothing (three read-only guards, and `BEGIN READ ONLY` around every query) and
  prints no password, URL or row data.
- **Validated** read-only on the throwaway rehearsal database (§8).

**Running it against Neon is NOT RUN and needs its own approval.** The Neon-specific facts of the earlier Phase B
production procedure still apply:
- a provider admin login (`neondb_owner`, BYPASSRLS + CREATEROLE) as a one-time release identity, which is a SECURITY
  TRADE-OFF still awaiting owner acceptance;
- 1786719510000 fails under a NOBYPASSRLS login when workspace schemas exist;
- the free-plan restore window is 6 h;
- the project's egress quota.

### 2.3 Target (iii): future production (final hosting on DigitalOcean)

Which list applies depends on an owner decision about the data:

| Path | Pending set | Notes |
|---|---|---|
| **P-fresh**: new cluster, empty | exactly §2.1 (all 250, phases A and B; 1786721330000 excluded) | Same gates as staging. Production gets its **own** deployment id, its own credentials and a separate release window. |
| **P-carry**: new cluster restored from the temporary database | §2.2 on the restored copy (the L1 / L2 inventory runs on the copy, not on Neon) | The restore carries the old marker (if any) and roles. Rebind the identity to the new host (`db:bind-identity`, audited), rehearse on a second copy first, then apply the pending set as in §2.2. |

## 3. The 64 migrations after the production marker

Run order is the timestamp order. "Privilege":
- **M**: the restricted migrator is enough (proved by the M2 harness on empty databases);
- **B**: needs the bootstrap identity (SUPERUSER, or BYPASSRLS on the connecting role, and/or the new owner's CREATE on
  `core`).

On a fresh install, every one of them runs in phase B as the bootstrap identity anyway.

"`down()`" summarises a pattern scan plus the reviewed classification. **A line-by-line review is required before any
production `down()`**, which also needs owner approval and the migration identity, and is never automatic. Every one of
the 64 is **N1-gated**: it needs its exact name in `PRODUCTION_APPROVED_MIGRATIONS` before a production-classified run
can apply it.

| # | Id | Migration | Class | Privilege | `down()` | Risk and gate notes |
|---|---|---|---|---|---|---|
| 1 | 1786719400000 | OfferKind | schema | M | destructive (drops a column) | additive column |
| 2 | 1786719450000 | AttendanceCheckIn | schema | M | destructive (13 check-in columns) | additive columns |
| 3 | 1786719500000 | ServerPathWorkspaceProvisioning | security: definer + EXECUTE to crewflow_app | M | security-regressing (Phase B code then refuses to boot) | **G1-prod decision**; `lock_timeout 30s`; later migrations re-create and re-verify the function, so it cannot be skipped |
| 4 | 1786719510000 | WorkspaceBoundChecksForLaterTables | constraint (NOT VALID, then VALIDATE) per workspace schema | M; **B when workspace schemas exist** | no-op (CHECKs kept) | fails under a NOBYPASSRLS login on any existing `workspace_*` schema (registry not visible); VALIDATE scans six tables per workspace |
| 5 | 1786719520000 | HwsHistoricalRowsPrivilegedCopy | ROW_COPY (privileged HWS copy) | **B** | no-op | **dev-only**: retire through `RETIRED_MIGRATIONS` or approve explicitly (owner decision); copies nothing on an empty database |
| 6 | 1786719600000 | ReconcileSuperuserOwnedCoreObjects | ownership reconcile | M | no-op (re-owned objects stay) | — |
| 7 | 1786719610000 | AuditLogRecordedIdentityOrganisationCheck | HAND_OVER (audit identity trigger) | **B** | security-regressing | — |
| 8 | 1786719620000 | BootstrapFirstPlatformAdminFunction | HAND_OVER (bootstrap-admin definer) | **B** | drops the function | — |
| 9 | 1786719700000 | PayrollEvidenceRestrict | FK RESTRICT on payroll evidence | M | security-regressing (RESTRICT to CASCADE) | ACCESS EXCLUSIVE on the payroll tables while the FKs are swapped |
| 10 | 1786719710000 | EmailOutboxSecretBodyScrub | data scrub + trigger | M | partial (drops the trigger only) | **irreversible**: token-bearing email bodies are nulled |
| 11 | 1786719800000 | WorkspaceSchemaMigrationLedger | schema (workspace module ledger) | M | drops | — |
| 12 | 1786719810000 | AttendanceMoneyChecks | CHECK constraints (money) | M | may refuse (pre-checks) | `transaction = false`: partial DDL possible on failure; written to be re-run |
| 13 | 1786719820000 | HostLabelNamespace | HAND_OVER (host-label namespace) | **B** | drops | — |
| 14 | 1786719830000 | HostLabelResolverDisplayName | HAND_OVER (host-label resolver) | **B** | may refuse | — |
| 15 | 1786719900000 | MfaTotpRecoveryCodes | HAND_OVER (MFA recovery codes) | **B** | refuses while MFA data exists | — |
| 16 | 1786719910000 | LoginHandoff | HAND_OVER (login handoff) | **B** | drops | — |
| 17 | 1786719920000 | ArchiveAndSearchSchema | schema + `CREATE EXTENSION unaccent, pg_trgm` | M + CREATE on the database | destructive (archive/search columns) | `transaction = false`; extension owner = whoever runs it (known posture residue F3) |
| 18 | 1786719940000 | OutboxRetentionReplay | outbox retention/replay | M | needs the bootstrap identity | — |
| 19 | 1786719950000 | AuditLogTimelineIndex | index `CONCURRENTLY` | M | may refuse | `transaction = false`; own `lock_timeout`; duration grows with the size of `audit_log` |
| 20 | 1786719960000 | EncryptedColumnEnvelopeChecks | CHECK (VALIDATE) on encrypted envelopes | M | needs the bootstrap identity | VALIDATE scans the encrypted columns |
| 21 | 1786719970000 | FieldPermissionObjects | field-permission objects | M | refuses while data exists | — |
| 22 | 1786719980000 | MfaHandoffFollowups | HAND_OVER (MFA handoff follow-ups) | **B** | needs the bootstrap identity | — |
| 23 | 1786719990000 | FieldPermissionPayrollRecordKey | field-permission payroll key | M | refuses while data exists | — |
| 24 | 1786720000000 | SettingsViewLeadershipDefault | data (permission defaults) | M | reverts the defaults | changes default permissions of leadership roles |
| 25 | 1786720010000 | OrganisationCeoInvitation | HAND_OVER (CEO invitation) | **B** | destructive | — |
| 26 | 1786720020000 | CrewflowAppCopiedWriteGrantRevoke | grant revoke (copied writes) | M | security-regressing (re-grants) | — |
| 27 | 1786720030000 | OAuthReauthenticateIntent | schema (OAuth re-authentication intent) | M | destructive | — |
| 28 | 1786720100000 | AdminPanelReadFunctions | HAND_OVER (admin read definers) | **B** | may refuse | — |
| 29 | 1786720110000 | AuditLogOrganisationActionIndex | index `CONCURRENTLY` | M | needs the bootstrap identity | `transaction = false`; own `lock_timeout` |
| 30 | 1786720210000 | AiUsePermissionDefault | data (AI permission default) | M | reverts | AI stays off in production (`AI_ENABLED=false`) |
| 31 | 1786720220000 | AiPhase1Schema | HAND_OVER (AI phase 1 schema) | **B** | destructive | — |
| 32 | 1786720230000 | AiDevRealProvider | HAND_OVER (AI provider definers) | **B** | destructive | — |
| 33 | 1786720240000 | AiSettingsPermission | data (AI settings permission) | M | reverts | — |
| 34 | 1786720250000 | AiModelPreference | schema + RLS (AI model preference) | M | destructive | — |
| 35 | 1786720900000 | AiAssistantProfile | schema + RLS (AI assistant profile) | M | destructive | — |
| 36 | 1786720910000 | AiWorkspaceInstructions | schema + RLS (AI workspace instructions) | M | destructive | — |
| 37 | 1786720920000 | AiModelLevelPolicy | schema + RLS (AI model level policy) | M | refuses while data exists; destructive | — |
| 38 | 1786720930000 | AiTurnLevelReasoning | schema (AI turn reasoning) | M | destructive | — |
| 39 | 1786720940000 | AiUsageCacheAccounting | HAND_OVER (AI usage summary) | **B** | refuses while data exists; destructive | — |
| 40 | 1786720950000 | AiUsageLedger | schema + RLS + definer (AI usage ledger) | M | destructive | — |
| 41 | 1786720960000 | AiActionProposalActivate | ROW_COPY backfill (`row_security = off`) | **B** | destructive (`row_security = off`) | backfill; the original values are not restored |
| 42 | 1786720970000 | AiQueuedTurnCheckpoint | schema (AI queued-turn checkpoint) | M | destructive | — |
| 43 | 1786720980000 | AiUsageTitleCalls | schema (AI usage title calls) | M | destructive | — |
| 44 | 1786720990000 | AiAssistantRoundOnly | ROW_COPY (`row_security = off`) | **B** | statements only | **irreversible**: avatar shapes mapped to `circle`; the originals are not recorded |
| 45 | 1786721000000 | AiSkillSchema | schema + RLS (AI skills) | M | destructive | — |
| 46 | 1786721010000 | AiMessageSkillTags | schema (AI message skill tags) | M | destructive | — |
| 47 | 1786721020000 | AiTurnContinuation | schema (AI turn continuation) | M | refuses while data exists; needs `row_security = off` (bootstrap) | — |
| 48 | 1786721030000 | AiAgentsPermission | data (AI agents permission) | M | reverts | — |
| 49 | 1786721040000 | RoleAssignableToAgents | schema + trigger (role assignable to agents) | M | destructive | — |
| 50 | 1786721050000 | AiAgentSchema | schema + RLS (AI agents) | M | destructive | — |
| 51 | 1786721060000 | AiAgentDueWork | schema (AI agent due work) | M | drops | — |
| 52 | 1786721070000 | AiInputRequest | schema + RLS (AI input request) | M | refuses while data exists; bootstrap | — |
| 53 | 1786721080000 | AiUsageWaitingOutcome | schema (AI usage waiting outcome) | M | refuses while data exists; bootstrap | — |
| 54 | 1786721090000 | VenueTeamOrgAdmin | security (venue team org admin) | M (held to the post-0b rules) | may refuse | `transaction = false` |
| 55 | 1786721100000 | SecureOwnerCoreSchemaAndHelpers | **Phase 0b**: core ownership to `rab_secure_owner`, helpers | M + CREATE on the database | security-regressing (re-opens E1 channels 1–2) | the ownership boundary every later migration relies on |
| 56 | 1786721110000 | NavigationLayoutCrewflowOwner | ownership (`navigation_layout` to crewflow) | identity-dependent | no-op | refuses unless run by the login that owns `core.navigation_layout` (no-op when already crewflow-owned) |
| 57 | 1786721210000 | ProvisionWorkspaceGuards | **Phase B**: provisioning guards | M | clean (rehearsed) | between 1786719500000 and this one the unguarded body exists: keep the API stopped during the run |
| 58 | 1786721220000 | ProvisioningHealth | **Phase B**: provisioning health (counts-only definer) | M | clean (rehearsed) | — |
| 59 | 1786721230000 | DeploymentIdentity | **Phase B**: deployment identity marker | M | clean, but **re-opens F1** (the marker is gone) | first bind needs `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP` + `PG_EXPECTED_DATABASE_NAME` |
| 60 | 1786721300000 | WorkerDispatchPointer | **Phase D**: pointer table + claim definers | M; **`crewflow_worker` must pre-exist** (operator, superuser) | clean (round trip 19/19, disposable); refuses while the triggers exist | owner gate (Phase D runbook §11 item 2); with 310000/320000 starts the 14-day clock |
| 61 | 1786721310000 | WorkerDispatchPointerOutboxTriggers | **Phase D**: outbox triggers | M | clean (disposable) | trigger write cost in every Worker mode (MEASURED +5 to +13 %) |
| 62 | 1786721320000 | StatementDispatchPointer | **Phase D**: statement trigger, workspace module v19 | M | leaves an inert trigger body; workspaces stay at module 19 | `transaction = false` (one transaction per workspace schema); `lock_timeout 5s`; the previous Worker image can no longer run its provisioner (forward-only) |
| 63 | 1786721340000 | AccountInviteCleanupDefiner | **Phase D**: invite-cleanup definers | M | clean (disposable) | never called while `WORKER_INVITE_AUTO_DELETE_ENABLED=false` |
| 64 | 1786721350000 | StatementPointerPhysicalIdentity | **Phase D** F2: pointer physical identity | M | clean (about 1 s on a disposable DB; rebuilds the pointer primary key) | `lock_timeout 5s`; ACCESS EXCLUSIVE on the pointer table only; first `down()` in the Phase D order |

Before the marker (186 migrations): on an existing production database these are covered by the baseline. On a fresh
install they run in phases A/B as in §2.1. Their privileged members are the 15 listed in §2.1. Their `down()` methods
are not part of any rollback plan: roll back by restoring the database.

## 4. Preflight (every target; staging values shown)

### 4.1 Environment classification and identity binding

- **Staging is production-classified (NEEDS OWNER APPROVAL).** `DB_TARGET=staging` is refused, and a
  `NODE_ENV=production` process must declare `production`. Staging therefore runs exactly like production:
  - `CREWFLOW_DEPLOYMENT_ENVIRONMENT=production`;
  - `CREWFLOW_DEPLOYMENT_ID=<a fresh staging-only UUID>`;
  - its own database, bound to that id and to its own dotted host names.

  Production processes refuse it (different id and host), and staging processes refuse production. This is the only
  mode that exercises N1, TLS verify-full and the production configuration refusals.

  Rejected alternative: a non-production runtime (`NODE_ENV=development`, marker `staging`, migrations as
  `DB_TARGET=test` with `ALLOW_REMOTE_TEST_DATABASE`). It skips N1, TLS and the production refusals, so it would not
  rehearse production.
- **First bind**, as one supervised step with the phase B apply (finding F2 of the Phase B review). The rab-migrate
  environment carries the bootstrap flag and `PG_EXPECTED_DATABASE_NAME`:

  ```bash
  docker compose --env-file /etc/crewflow-staging/compose.env -f docker-compose.image.yml \
    -f staging/docker-compose.staging.yml run --rm --entrypoint node rab-migrate \
    packages/rab-server/dist/database/deployment-identity/bind-deployment-identity.js \
    --environment production --deployment-id <staging-deployment-uuid> \
    --reason "<ticket>: first bind of the isolated staging database" --actor "<operator>" \
    --confirm-database <staging-db-name> --confirm-host <staging-db-direct-host (dotted)>
  ```

  Then remove `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP` from `.env.migrate`: a bound database refuses it.
- **Every later run:** the `deploy-prepare` check run prints the read-only probe (database, cluster id, marker
  `production/<id>`) before anything else. A mismatch in database, host or id means **STOP**.

### 4.2 Role checks (read-only SQL, as the operator)

Run the generated inventory (L4/L5) and confirm:

| Role | Required |
|---|---|
| `crewflow_app` | LOGIN, NOSUPERUSER, **NOBYPASSRLS**, owns nothing |
| `crewflow_worker` | `t f f f f f t \| crewflow_app:inherit=true:set=false:admin=false \| 0 \| 0` (Phase D runbook §3.3) |
| `crewflow_migrator` (later releases) | LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, member of `rab_secure_owner` and `crewflow` only, owns nothing |
| `rab_secure_owner` | NOLOGIN |
| bootstrap superuser (first install only) | NOLOGIN again after phase B |

Also check that no role has a persistent `crewflow.dispatch_notify` setting:
`SELECT * FROM pg_db_role_setting WHERE array_to_string(setconfig, ',') LIKE '%crewflow.dispatch_notify%';`
must return no rows.

### 4.3 Disk and backup

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
SELECT count(*) AS workspace_schemas FROM pg_namespace WHERE nspname LIKE 'workspace\_%';
```

- Free space on the data volume must be at least **2 × the database size** plus 10 GB of WAL headroom. VALIDATE,
  CONCURRENTLY and per-workspace migrations write WAL.
- A verified backup taken **after** the services are stopped (§5) must exist.
- A restore of the previous backup must have been rehearsed in the last 30 days.

### 4.4 Locks and timeouts

- Stop rab-api and rab-worker before the apply run, keeping rab-redis up. No application session then competes for the
  locks that DDL, VALIDATE and the trigger creation need. Confirm that no other session is open:

  ```sql
  SELECT pid, usename, application_name, state, xact_start FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY xact_start NULLS LAST;
  ```

  Only the operator's own session may remain. An `idle in transaction` session must be resolved first.
- Set `CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS=60` for the window. If another runner holds the migration lock, the run
  fails with nothing applied instead of waiting 10 minutes.
- The migrations keep their own timeouts:
  - `lock_timeout` 30 s in 1786719500000;
  - `lock_timeout` 5 s in 1786721320000 and 1786721350000;
  - the CONCURRENTLY builds;
  - a 900 s statement timeout.

  With the application stopped they should not wait. A lock timeout means a session was left open. The migration's
  transaction rolls back (or, for the `transaction = false` ones, the migration is re-runnable): fix the cause and re-run
  the check.
- Durations are MEASURED only on empty throwaway databases (§8). Time the full chain on a production-sized copy in the
  staging rehearsal before scheduling production.

### 4.5 The release step: exit codes and the F5 token

```bash
cd /opt/crewflow-staging/release/packages/rab-docker
C="docker compose --env-file /etc/crewflow-staging/compose.env -f docker-compose.image.yml -f staging/docker-compose.staging.yml"
$C run --rm rab-migrate                     # CHECK run: exit 3, prints every pending name + the token; nothing applied
#   exit 0  = nothing pending -> go to the service start
#   exit 64-69 = refused or failed, by kind (64 config, 65 behind, 66 migration failed, 67 identity, 68 post-check,
#                69 lock timeout): fix, re-run the check
# The owner compares the printed list with the approved list (§2/§3) and approves exactly that token:
$C run --rm -e CREWFLOW_MIGRATION_APPROVED=pending-<n>-<sha256> rab-migrate   # APPLY: exit 0 after post-checks
$C run --rm rab-migrate                     # CHECK again: exit 0 ("schema is current")
```

The token approves one pending set only:
- left in a file, it approves nothing later;
- a token for another set, a malformed value or `apply-pending-migrations` is refused (an exit in 64–69), with nothing applied.

Pass it on the command line only, never in `.env.migrate`.

### 4.6 Connection budget

The declared total must fit the server: API instances × pool + Worker pool + the 6-connection lock pool + scans +
provisioner + rab-migrate's 3 + boot probes. Every process refuses to start otherwise. Staging defaults:
API 1 × 9, Worker 12, so 37 connections in the worst case. Check it against
`max_connections - superuser_reserved_connections - reserved_connections`.

## 5. Backup and restore

### 5.1 Backups

| Kind | How | Encryption | Retention (proposal, owner decision) |
|---|---|---|---|
| Pre-release logical dump | `pg_dump -Fc` as the superuser over the local socket (self-hosted) or the provider admin. A role without BYPASSRLS gets an error on FORCE RLS tables rather than a partial dump. Take it with the API and Worker stopped, immediately before the apply run | encrypted on the VM to an **offline** public key (`age -r <recipient>`), so the VM cannot decrypt its own backups; SHA-256 recorded; uploaded to a bucket at **another provider** with object lock | 90 days |
| Daily logical dump | same command, from a timer | same | 35 days daily, 12 months monthly |
| Physical base backup + WAL archive (self-hosted) | the Infrastructure agent's `hosting/backup/pg-backup.sh` (`pg_basebackup`, `archive_command`) | same | WAL 14 days, base backups 4 weeks |
| Provider snapshot (managed or VM disk) | provider console or API | provider-managed | convenience only: never the only copy |
| Roles (no passwords) | `pg_dumpall --roles-only --no-role-passwords` | same | with each dump |

```bash
set -euo pipefail          # a failed pg_dump / pg_dumpall must fail the whole step, not leave an encrypted empty stream
ts=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 0700 /var/backups/crewflow
# No clear-text copy is ever written: pg_dump streams straight into age (the OFFLINE key's public half).
sudo -u postgres pg_dump -Fc --no-password -d <db> | age -r "<offline-recipient-public-key>" \
  | sudo tee /var/backups/crewflow/<db>-$ts.dump.age > /dev/null
sudo -u postgres pg_dumpall --roles-only --no-role-passwords | age -r "<offline-recipient-public-key>" \
  | sudo tee /var/backups/crewflow/roles-$ts.sql.age > /dev/null
# Both archives must exist and be larger than an encrypted empty stream (age adds about 200 bytes of header; a real roles dump is already larger than 400 bytes).
for f in /var/backups/crewflow/<db>-$ts.dump.age /var/backups/crewflow/roles-$ts.sql.age; do
  test "$(sudo stat -c %s "$f")" -gt 400 || { echo "backup $f is empty: STOP, do not approve the apply run"; exit 1; }
done
sudo sh -c "cd /var/backups/crewflow && sha256sum *-$ts.*.age > SHA256SUMS-$ts"
# Upload the .age files and SHA256SUMS. Full readability (`age -d | pg_restore -l`) is proved where the offline key is, on
# the disposable restore host (5.2); for the pre-release dump do that BEFORE approving the apply run.
```

### 5.2 Restore rehearsal (disposable copy, never the source host)

1. Create a disposable PostgreSQL 16 of the same minor version. Load the roles file, then set new random passwords.
   The restored copy must never reuse the source's credentials.
2. Verify the checksum, then restore: `age -d -i <offline-key-file> <dump>.age | pg_restore --exit-on-error -d <copy-db>`
   as the superuser (`pg_restore -l` on the decrypted stream first proves the archive is readable). Keep the owners and ACLs: the security
   model depends on `rab_secure_owner` ownership, so never use `--no-owner`.
3. Verify (read-only):

   ```sql
   SELECT count(*), max(timestamp) FROM core.migrations;                           -- equals the source at dump time
   SELECT count(*) FROM core.migrations WHERE timestamp = 1786721330000;            -- 0
   SELECT environment, deployment_id FROM core.deployment_identity_check();         -- the SOURCE's binding (expected)
   ```

   - Run the generated ledger inventory (L1 must show the same counts as on the source).
   - Run `check-db-security-posture.ts` against the committed golden file.
   - Run `tools/check-rls-coverage.ts` as `crewflow_app`: exit 0, with `rolbypassrls = false`.
   - Compare row counts per business table with the counts recorded at dump time.
4. **The copy refuses every process (expected):** the marker names the source host. Rebind it as a throwaway
   (`db:bind-identity --environment staging --deployment-id <new uuid> --confirm-current-deployment-id <source id> ...`)
   before starting anything against it. Never start production-classified processes with the production id against a
   copy.
5. Record the duration (RTO) and the dump's age at restore time (RPO). Destroy the copy and its credentials.

## 6. Rollback

Use the least invasive rollback that fixes the problem. The order of preference follows the Phase D runbook §8:

| # | Situation | Action | Notes |
|---|---|---|---|
| R-0 | `deploy-prepare` exit 3, or a failure exit (64–69) | Nothing was applied, and the old release keeps running (compose never starts the API and Worker: `service_completed_successfully`) | Fix the cause and re-run the check |
| R-1 | Phase D global mode misbehaves | `WORKER_CLAIM_MODE=per_scope` on every Worker, then a rolling restart (§8.1). Event mode: first set `WORKER_DISPATCH_MODE=poll` on the API **and** the Worker | No data change; fast |
| R-2 | Worker credential | Point the Worker's `PG_DATABASE_URL` back at `crewflow_app` (§8.2), per_scope only | 1786721330000 must not be applied |
| R-3 | Application bug, schema unchanged by the release | Redeploy the previous **digests** (`CREWFLOW_*_IMAGE_DIGEST` back to the recorded values) with the previous env files | A staging first install has no previous release: roll forward or rebuild staging |
| R-4 | Application bug after additive migrations | Previous API digest: boots with a "ledger ahead" warning. **Previous Worker digest: forward-only** (its provisioner refuses a newer ledger, and module-19 workspaces after 1786721320000). It can run only jobs-only (`CREWFLOW_PROVISIONER_ENABLED=false` and `CREWFLOW_PROVISIONER_DATABASE_URL` removed), which is an **owner exception** in production that suspends workspace provisioning | Phase D runbook §8.3 |
| R-5 | A migration failed mid-run | Earlier migrations of the run stay applied (one transaction per migration). Fix and re-run, or roll forward | A `transaction = false` migration is re-runnable |
| R-6 | Schema rollback | `down()` through the approved migration path only, with the migration identity (or one that can `SET ROLE rab_secure_owner`), after a fresh backup, in a window. **Phase D order: 1786721350000 → 1786721340000 → 1786721320000 → 1786721310000 → 1786721300000** (§8.4). Phase B: 1786721230000 → 1786721220000 → 1786721210000 (rehearsed) | DROP TRIGGER / DROP TABLE take ACCESS EXCLUSIVE on the outbox tables. After the Phase D `down()`s **only the previous API + the previous Worker jobs-only can run**: the Phase D images refuse the then-pending migrations, and workspaces stay at module 19. Every other post-marker `down()` is listed in §3. No production `down()` chain beyond these is recommended |
| R-7 | Bad data migration, corruption, or the release must be undone entirely | Restore into a **new** database from the pre-release dump or PITR, rebind the identity (new deployment id, audited), and switch `PG_DATABASE_URL` everywhere in one change | Lost writes, security reversals and side effects outside the database are as listed in the Phase B procedure (§e.4): revoke all sessions and flush the entity cache and Redis namespaces after any restore |

**Rollback target rule (R-3 / R-4).** A previous digest is an acceptable rollback target ONLY if:
- it was itself deployed with this variant; and
- its start lines showed `mode=enforce`:
  - `api-prestart: runtime isolation as declared: ... mode=enforce`;
  - `[worker-bundle] runtime isolation as declared: ... mode=enforce`.

Otherwise **STOP**. An image built before the enforce mode (H6 commit 09286aef) ignores
`CREWFLOW_RUNTIME_ISOLATION=enforce` and would start in "warn", so a dropped control would no longer be refused. The
first release on this variant has no such predecessor: roll forward instead.

Record the result next to every digest in `compose.env`'s history comments (`# <date> api=<digest> worker=<digest>
enforce=yes`).

**Image rollback commands** (staging):

```bash
# compose.env keeps the previous digests in comments with the date and enforce=yes|no; swap back only an enforce=yes pair:
$C config --quiet --no-env-resolution && sudo node staging/verify-image-compose.cjs --environment \
  --env-file /etc/crewflow-staging/compose.env --compose staging/docker-compose.staging.yml
$C up -d --no-deps rab-api && $C up -d --no-deps rab-worker    # never run rab-migrate against an older image
$C logs rab-api rab-worker | grep -E 'runtime isolation as declared.*mode=enforce'   # both lines, or roll forward
```

## 7. Approvals this plan needs, in order

1. Staging as a **production-classified** deployment with its own id (§4.1).
2. The **N1 change**: the post-marker names approved by name, including the 1786719520000 decision and G1-prod
   (1786719500000/510000). This is a reviewed code change, and it applies to every production-classified database.
3. The **Phase D timing**: install staging after #26 is merged, or a written exception to the 14-day rule for staging.
4. The staging bootstrap itself (self-hosted superuser phase B, `crewflow_app` / `crewflow_worker` pre-created,
   `crewflow_migrator` afterwards).
5. Backup design: the off-provider bucket, the offline key custody and the retention periods.
6. **Separately, and not part of the staging work:** running the read-only inventory against the temporary database;
   any change to it; production.

## 8. Evidence (local, throwaway)

The local isolated rehearsal of `docker-compose.image.yml` (`staging/rehearsal/run-image-rehearsal.cjs`) ran the guarded
path on a throwaway PostgreSQL 16, with the variant's own `rab-migrate` and the API image referenced by digest.
Run of 2026-11-03 on amd64 (Docker 29.8.1, Compose 5.6.1). Images: the H2 API and Worker images with the H6 enforce
scripts (`09286aef`) overlaid, by local digest. Test-only; never published. All values MEASURED on empty throwaway
databases. **10 passed, 0 failed, 0 blocked.**

| Case | Result |
|---|---|
| Phase A check (`rab_owner`) | exit **3**, 250 pending, token printed, ledger 0 |
| Phase A apply with the token | stops at the role split: ledger **128**, role split not applied (exit 1, as designed) |
| Phase B check (bootstrap superuser) | exit **3**, **122** pending |
| Phase B apply with the phase A token (stale) | exit **1**, nothing applied |
| Phase B apply with `apply-pending-migrations` (retired) | exit **1**, nothing applied |
| Phase B apply with the right token | exit **0**, "post-checks passed", **12.6 s** on an empty database |
| Final check | exit **0** ("schema is current"); ledger **250**, max 1786721350000, **1786721330000 absent**, 64 after the marker |
| rab-migrate container | the API image by digest, `user 1000:1000`, read-only root, `CapDrop [ALL]`, no-new-privileges, tmpfs `/tmp` |
| A dependency run before phase A (earlier run 2, harness defect; not counted as a pass) | `rab-api` did **not** start: the dependency check refused (superuser in phase A), and `service_completed_successfully` held |
| Generated inventory, read-only session | `applied 250`, nothing pending, unknown or gated; `crewflow_worker` shape as reviewed |
| Roles after phase B | `crewflow`, `crewflow_app`, `crewflow_worker`: LOGIN, NOSUPERUSER, NOBYPASSRLS; `rab_secure_owner`: NOLOGIN |

The same run also showed the following, under `CREWFLOW_RUNTIME_ISOLATION=enforce`:
- the API was healthy in 13.2 s and the Worker in 8.9 s, both logging `mode=enforce`;
- capabilities: API `CapBnd 0`, launcher `e0`, children `CapEff 0`, and `NoNewPrivs=1` everywhere;
- read-only root (EROFS), with `pids.max` 256/1024 and `memory.max` 768/1536 MiB;
- a 71,930-byte report PDF in MinIO, with only the reference in PostgreSQL;
- the hardened Redis (NOAUTH unauthenticated, PING-only health user, NOPERM `CONFIG`, noeviction, AOF);
- enforce refused a writable API root (exit 64) and a Worker without no-new-privileges (exit 1).

Not measured: any production-sized duration (§4.4).

**What this rehearsal did NOT exercise (scope).** It ran rab-migrate with `DB_TARGET=local` and the API and Worker with
`NODE_ENV` / `RAB_RUNTIME_ENV=development`, against a database with **no TLS** and **no deployment-identity bind**.
These parts of the production-classified staging procedure (§4.1) were therefore **not rehearsed**:
- the N1 approval refusal and approval (they also need the not-yet-written N1 code change);
- `sslmode=verify-full` with the staging CA;
- `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP` and `db:bind-identity`, and the bound-marker checks of every process;
- the production configuration refusals (https URLs, email driver, S3, `TRUSTED_PROXY_CIDRS`);
- the exit codes the staging runbook §5 steps 3–4 predict under `DB_TARGET=production`.

Those runbook steps are marked **unrehearsed** there. The first real staging window is their rehearsal, and it needs
its own approval.
