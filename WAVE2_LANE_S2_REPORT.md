# Waves 2+3, lane S2 (schema owner): B3 migrator + ledger, B4 versions + drift, C1/C2 constraints + money, wave-3 namespace schema

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed (coordinator commits).
Neon / production untouched. Migrations applied to the disposable `crewflow-lane-s2-db` (127.0.0.1:15451), to a throwaway
restore of the dev backup, and then to the dev TEST database `rab-devdb` after a verified backup. No `rab-*` container was
restarted or rebuilt. **Not** added to `production-migration-approval.ts` (N1).

Evidence: `docs/evidence/wave2-lane-s2/` — `CONTRACT.md` (lane H contract, written first), `golden.diff` (the ONLY posture
change: +80 core lines, 0 removed, workspace template unchanged — the coordinator regenerates the golden at integration;
the repo golden was not edited), `fresh-install/`, `tests/`, `dev-apply/`.

## 1. What was built

**Migrations** (block 17867198xxxxx):

| Migration | What |
|---|---|
| `1786719800000-WorkspaceSchemaMigrationLedger` | `core.workspace_schema_migration` (append-only ledger: workspace_id, organisation_id, schema_name, module_id, version, checksum, previous/target version, attempt, status APPLIED/BASELINED/FAILED/REFUSED, started/completed_at, error_class, app_version; ENABLE+FORCE RLS; `crewflow_app` SELECT only; a trigger refuses UPDATE/DELETE/TRUNCATE for every role, superuser included). Registry columns `module_version`, `expected_/observed_fingerprint`, `fingerprint_checked_at`, `drift_status`, `drift_detail` + a guard trigger so `crewflow_app` cannot write them. `core.workspace_schema_fingerprint[_lines](uuid)`, `core.record_workspace_schema_drift(uuid)` (EXECUTE `crewflow` only). `verify_workspace_schema_v1` re-created (finding S2-2). Backfill: every READY workspace BASELINED at v14 iff its fingerprint equals the frozen v14 value. |
| `1786719810000-AttendanceMoneyChecks` | `attendance_earned_pence_non_negative`, `attendance_worked_minutes_non_negative` in core (pre-check → NOT VALID → VALIDATE) and, as workspace **module 15**, in every workspace through the migrator (`transaction=false`, one transaction per schema). `core.provision_workspace` re-created (same owner/DEFINER/search_path/ACL, re-verified) with the v15 composition and a ledger-aware body that refuses READY on a fingerprint mismatch. |
| `1786719820000-HostLabelNamespace` | Wave-3 schema for lane H (C1/C2/C4/C5): reserved labels, claim registry, quarantine, resolvers. See §3 and `CONTRACT.md`. |

**Production modules (new):** `workspace-schema/workspace-schema-modules.ts` (THE ordered module list, ids/versions/checksums;
the TS provisioner's `WORKSPACE_TEMPLATE_STEPS` now derives from it), `workspace-schema-migrator.ts` (`WorkspaceSchemaMigrator`),
`workspace-schema-drift.ts`, `workspace-schema-fingerprint.ts`, `workspace-schema-ledger-sql.ts`, `v1/attendance-money-checks.ts`,
`v1/provision-workspace-function-v2.ts`, `v1/server-path-template-attendance-money.ts`, `v1/expected-fingerprints.ts`,
`core/host-label-namespace-sql.ts`, `core/host-label-reserved-list.ts`; scripts `migrate-workspace-schemas.ts` (resume CLI,
guarded DataSource) and `check-workspace-schema-drift.ts`; worker job `rab-worker/.../rab-maintenance/workspace-schema-drift.job.ts`
registered daily in `workspace-provisioner.main.ts` (own connection; alert-only).

**Modified:** `provision-workspace-schema.ts` (module list + ledger/fingerprint in the same READY transaction),
`tools/check-rls-coverage.ts` (`released_host_label` allowlisted, see trade-off), `rab-shared/src/utils/money.ts`
(`assertSafePence`, rounding comment fixed: ties go to +∞, not "away from zero"), `engine/utils/bigint-transformer.ts`,
`v1/server-path-template-payroll-restrict.spec.ts` (first 14 steps), `workspace-provisioner.main.ts`.

**Design decisions to note:** `schema_version` stays the template major (1) — `SchemaResolverService` only routes
`SUPPORTED_WORKSPACE_SCHEMA_VERSIONS={1}`, so bumping it per step would 404 every workspace on running images; the per-step
counter is `module_version`. Migration is atomic per schema (all pending modules or none), so a partially upgraded schema
can never exist or be marked current. Drift is alert-only (owner default); routing never reads the drift columns (G3).

## 2. Findings (CLAUDE §5.8)

```
S2-1 [LOW→MEDIUM once routing ships, D-C2/C2/C4] cross-tenant host-label ambiguity and takeover
Actor→action→consequence: tenant B sets its org slug (or a later workspace subdomain) to tenant A's label, or claims A's
  label the instant A renames/deletes → links/emails to <label>.<base> land on B (phishing, credential capture once host
  routing + origin trust ship). Reserved names (api, admin, mail, autodiscover…) were enforced only in TS.
Location: M/1786665800000 (organisation.slug UNIQUE), M/1786667100000 (manager_workspace.subdomain UNIQUE) — separate
  namespaces; rab-shared reserved-subdomains.ts used only in SubdomainService.checkAvailability.
Root cause: two independent UNIQUE constraints, no reservation registry, no quarantine, no DB reserved list.
Fix: HostLabelNamespace1786719820000 — EXCLUDE(label =, organisation_id <>) claim registry fed by triggers, DB reserved
  list (210 labels + ..--/api-/www-/crewflow- prefixes) enforced on every subdomain write (23514), 90-day quarantine
  on rename/delete (23505 for anyone but the releaser), narrow DEFINER resolvers for lane H.
Regression: host-label-namespace.integration.spec.ts (9) — reserved/IDN/shape refusals at the DB, cross-namespace refusal
  both ways, concurrent race (one winner), quarantine/reclaim/expiry/delete, resolver indistinguishable empties,
  no runtime privilege on the tables, quarantine rows undeletable.

S2-2 [LOW, availability] one workspace's lock blocks verification of every other workspace
Actor→action: any long transaction (or a hostile session) holding a lock on ANY workspace table → core.verify_workspace_
  schema_v1 for every OTHER workspace waits (pg_get_constraintdef locks tables the planner evaluates before the schema
  filter) → provisioning (provision_workspace) and migration of unrelated tenants stall.
Location: M/1786719500000:105-110 (binding-CHECK EXISTS).
Root cause: function-call qual evaluated over all schemas' constraints.
Fix: CREATE OR REPLACE with a MATERIALIZED CTE restricting to the schema's own constraints first (same checks/labels/ACL).
Regression: migrator spec "busy table fails fast with LOCK_TIMEOUT and does not block or change any other schema".

S2-3 [LOW, integrity — money] attendance.earned_pence / worked_minutes had no CHECK; bigint > 2^53 silently rounded
Location: M/1786667000000 (attendance), engine/utils/bigint-transformer.ts:8-11.
Fix: AttendanceMoneyChecks1786719810000 (core + every workspace, pre-check, NOT VALID+VALIDATE); transformer refuses
  unsafe/fractional values both ways (RangeError) via @rab/shared assertSafePence.
Regression: constraint-regression spec (23514 ×3 targets, convalidated), bigint-transformer.spec, money.spec (BigInt sweep).
```

Observations, not fixed (owner/other lane): (a) `crewflow_app` holds table-level INSERT/UPDATE/DELETE on
`workspace_schema_registry` (pre-existing; no runtime code uses it) — new columns are guarded, but `status`/`schema_version`
are writable within the caller's org: recommend revoking (lane decision). (b) `bigintAsNumber.from(null)` returns 0 (pre-
existing), so a NULL `earned_pence` reads as 0 in the API — kept, a domain decision. (c) `PAYROLL_PERIOD_TRANSITIONS` has
no persisted column (C2 test lists it explicitly). (d) The pre-existing `workspace_subdomain_taken` compares citext under a
search_path without `public`, i.e. effectively case-sensitive text; the new code uses `OPERATOR(public.=)`.

## 3. Namespace / reservation design and lane H contract

Full contract: `docs/evidence/wave2-lane-s2/CONTRACT.md`. `manager_workspace.subdomain` is the only routable label;
`organisation.slug` stays (login-provider lookup) and is not routable. Lane H calls (all `SECURITY DEFINER`, owner
`rab_secure_owner`, `search_path=pg_catalog,pg_temp`, PUBLIC revoked, EXECUTE `crewflow_app` only):
`core.resolve_workspace_by_host_label(text) → (workspace_id, organisation_id, status, canonical_label)` (READY + active +
routable + org not suspended, else 0 rows), `core.resolve_released_host_label(text) → (workspace_id, organisation_id,
canonical_label, reserved_until)`, `core.host_label_status(text, uuid) → AVAILABLE|INVALID|RESERVED|TAKEN`,
`core.host_label_is_reserved(text)`, `core.host_label_quarantine_interval()` (90 days, owner-tunable by migration).
Existing `workspace_subdomain_taken` / `organisation_slug_taken` keep their signatures and became namespace-aware.
Write errors: `23514 host_label_shape|host_label_reserved`, `23505 host_label_unavailable` (`23P01` backstop).
Existing data on dev: clean except org slug `platform` = reserved label (reported, allowed: slugs are not routable).

```
SECURITY TRADE-OFF — core.released_host_label is ENABLE but NOT FORCE (12th entry in NOT_FORCED_ALLOWLIST)
Why: resolve_released_host_label is a pre-auth lookup (old label → current label) and the subdomain triggers must see other
  organisations' live quarantines; both run as the owner rab_secure_owner (NOLOGIN). FORCE would bind the owner too.
Bound: crewflow_app AND crewflow hold no privilege on the table; rows contain a label + uuids only; no FK on purpose so a
  quarantine outlives a deleted tenant. Retention: kept forever as history (owner decision G6 if that is unwanted).
Veto option: FORCE + a policy keyed on a definer-set GUC (more moving parts, same effective trust).

SECURITY TRADE-OFF — resolvers return workspace_id/organisation_id for any label, pre-auth
They are server-side only (crewflow_app); lane H must not echo ids to anonymous clients — a public endpoint should
return only what the front end needs, and identical 404s for every empty result.

SECURITY TRADE-OFF — CHECK bodies are fingerprinted without parentheses
A pg_dump/restore re-associates BETWEEN-derived AND trees (seen on the dev backup), which would raise false drift after
every restore. A regrouping-only CHECK change is therefore not detected by the fingerprint; policies, FKs, indexes,
grants, owners and RLS flags are hashed exactly, and the posture snapshot is unchanged.

SECURITY TRADE-OFF — expected fingerprints are PostgreSQL-16 constants
Another major version may deparse differently; the migrator then REFUSES (fail closed) until regenerated.
```

## 4. Tests (disposable `crewflow-lane-s2-db`, built from migrations alone: phase A stops at the role split as designed, phase B exit 0, 199 migrations)

All logs in `docs/evidence/wave2-lane-s2/tests/` and `fresh-install/`.

- **Lane S2 + touched specs** (`lane-s2-specs.log`): **155/155 pass** — `workspace-schema-migrator.integration` 11 (both
  provisioning paths at v15 with the expected fingerprint and 15 ledger rows; a pre-ledger v14 schema BASELINED then
  migrated ends identical to a fresh build; failure in schema 2 of 3 rolled back, others migrated, resume at attempt 2;
  PRECHECK_VIOLATION, CHECKSUM_MISMATCH, BASELINE_MISMATCH, LOCK_TIMEOUT isolation; runtime role denied migrator / ledger
  writes / recorder / fingerprint / drift columns, zero rows with no context; ledger append-only even for the superuser;
  drift DRIFTED (still routable) / MISSING / UNVERIFIED), `host-label-namespace.integration` 9, `constraint-regression.
  integration` 20 (23P01/23505/23514 in core + server-path + TS-provisioned schemas; C2 state tables == DB CHECK lists),
  `workspace-schema-modules` 10, `host-label-reserved-list` 3, `bigint-transformer` 4, plus hws-backfill, payroll-evidence-
  restrict, server-path-provisioning (db/api/no-redis), workspace-security-coverage. `money.spec` (shared) 10/10.
- **Lane H's contract spec against the real S2 functions** (`HOST_LABEL_CONTRACT_DB=1`, `lane-h-contract.log`): 4/4 pass.
- **Full rab-server** (`full-server.log`): 2469 passed / 19 failed / 65 skipped. Failures: pre-existing tenant-context ×3,
  identity-security-table-rls ×2, shift-team ×1; lane A2's in-progress `cookie-csrf.util` ×1; `db-security-posture` ×1 =
  exactly the 80 golden.diff lines (expected until the golden is regenerated); hws-backfill ×10 and F3 round-trip ×1 were
  caused by this lane and are fixed (tests now provision as `crewflow`, the real identity; F3 compares against its own
  composition) — re-run 33/33 (`rerun-hws-f3.log`).
- **Full rab-worker** (`full-worker.log`): 427 passed / 14 failed. Remaining failures are pre-existing (member-invitation-
  delivery ×9 `dto.objects`, 91-day token cleanup ×1); workspace-provisioning ×4 were caused by this lane (test provisioned
  as the superuser) and are fixed — re-run with provisioner-entrypoint 11/11 (`rerun-worker-provisioning.log`).
- **Fresh install:** posture +80/−0 with 0 and with 1 workspace (workspace template unchanged); RLS coverage OK both times.
- `tsc` server app 0 errors (dist rebuilt), worker `--noEmit` 0 errors.

Behaviour changes other code must know: the TypeScript provisioner now refuses (FAILED, `verification failed: …`) when
run as an identity that would not build `crewflow`-owned tables (e.g. a raw superuser connection); subdomain labels are
validated case-insensitively in the DB (a case-only change is not a rename).

## 5. Dev apply (rab-devdb, TEST database) — `docs/evidence/wave2-lane-s2/dev-apply/`

- Identity (read-only, twice): `rab-devdb`, 127.0.0.1:15432, system id `7699569147858477090`, 196 migrations.
- Backups (both restore-tested into a throwaway container: `pg_restore` exit 0, identical counts):
  `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-031129-pre-wave2-lane-s2.dump` (899,533 B, sha256 `410c45bf…3cd0d`)
  and, immediately before the apply, `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-040355-pre-wave2-lane-s2-final.dump`
  (899,533 B, sha256 `368aa66afdbbc73fe0ef20a8200cba8c574321abfc3c5dec0f4403f989de80db`).
- Rehearsal on the restored copy first: it exposed that pg_dump/restore re-associates a BETWEEN CHECK and broke the
  baseline (fingerprint normalisation added, see trade-off); dev's live fingerprint was then computed read-only and equals
  the expected v14 value; the final rehearsal applied cleanly (posture drift == golden.diff, RLS OK, drift OK).
- Apply: guarded runner, `DB_TARGET=local`, bootstrap superuser (from `packages/rab-docker/.env`, never printed) →
  3 migrations applied, 199 total. Ledger backfill: dev's workspace BASELINED v1–14 and APPLIED v15; the resume CLI as
  `crewflow` reports `UP_TO_DATE 15->15`; drift check `ok=1`. Registry READY, schema_version 1, module_version 15, drift OK.
  Claims: `platform` (org slug), `issac` (workspace). Report: `platform` = reserved label (org slug; allowed, not routable).
- Posture after: exactly the 80 golden.diff lines, 0 missing, workspace matches the template. RLS coverage OK.
  (Before the apply the NEW `check-rls-coverage.ts` crashes on dev because `core.released_host_label` does not exist yet —
  fail closed; it needs the migration.)
- Runtime: `/healthz` 200, all rab-* containers healthy (uptimes unchanged — nothing restarted), 0 error lines in server /
  worker logs. The running images predate this lane: no drift job yet; an old-image TS provisioner (createFor path) would
  build v14 without ledger rows — the next migrator run (or CLI) baselines + migrates it; the drift job flags it as
  UNVERIFIED meanwhile. API-path workspaces use the new DB function (v15 + ledger) immediately.
- Cleanup: `crewflow-lane-s2-db`, `crewflow-lane-s2-redis`, `crewflow-lane-s2-restore` removed. 15436 untouched.

## 6. For the coordinator / owner

1. Regenerate `security-posture.golden.txt` at integration (expected +80 lines = `golden.diff`).
2. Rebuild server + worker images so the drift job runs and the TS provisioner records ledger rows.
3. Decide: revoke `crewflow_app` INSERT/UPDATE/DELETE on `workspace_schema_registry` (observation a); retention of
   quarantine / ledger history (kept forever today); quarantine length (90 days); fail-closed routing on drift (G3).
4. CLAUDE.md's NOT-FORCE list is stale (now 12 + organisation + platform_admin); editing it needs owner approval.
