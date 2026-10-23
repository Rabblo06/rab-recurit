# Waves 4+5, lane DB5 (schema owner): MFA + login-handoff schema, archive, search, outbox retention, timeline, envelope CHECKs, field-permission keys

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed (coordinator commits).
Production, Neon and remote DBs untouched. **N1:** none of the 8 migrations is in `production-migration-approval.ts`.
Applied to: disposable `crewflow-lane-db5` (127.0.0.1:15461) and two other throwaway builds, a restored copy of the dev
backup, then the dev TEST database `rab-devdb` after a verified backup. No `rab-*` container restarted or rebuilt.
Evidence: `docs/evidence/w45-db5/` — `CONTRACT.md` (v2, written first), `golden.diff`, `fresh-install/`, `tests/`, `dev-apply/`.

## 1. What was built

| Migration | Content |
|---|---|
| `1786719900000-MfaTotpRecoveryCodes` | `user.totp_last_used_step`, `user.mfa_enabled_at` (+ column SELECT), state CHECK, guard trigger `user_mfa_columns_guard`; `core.user_mfa_recovery_code` (FORCE RLS, no runtime privilege); 9 `core.mfa_*` DEFINER functions (owner `rab_secure_owner`, EXECUTE `crewflow_app`), incl. `mfa_rotate_totp_secret` requested by OPS. `user.totp_secret_encrypted` verified as the existing, never-written `bytea` column. |
| `1786719910000-LoginHandoff` | `core.login_handoff` (≤60 s CHECK, hashed token, audience label, security_version snapshot, source session FK) + `login_handoff_create/_consume/_cleanup`. |
| `1786719920000-ArchiveAndSearchSchema` (`transaction=false`) | `unaccent` + `pg_trgm`, `core.immutable_unaccent`; workspace modules **v1.016-archive-columns** and **v1.017-search-vectors** applied to core and, through `WorkspaceSchemaMigrator`, to every READY workspace (ledger rows, fingerprint); `manager_profile` archive + `user.search_vector` (core only); `verify_workspace_schema_v1` made version-aware; `provision_workspace` re-created with the v17 composition. |
| `1786719940000-OutboxRetentionReplay` | 4 `purge_terminal_*` DEFINER functions + partial purge indexes, `REVOKE DELETE` from `crewflow_app`, `replay_failed_email` (INVOKER, audited). |
| `1786719950000-AuditLogTimelineIndex` (`transaction=false`) | `CREATE INDEX CONCURRENTLY audit_log_timeline_idx`, then `DROP INDEX CONCURRENTLY audit_log_entity_idx` (strict prefix). |
| `1786719960000-EncryptedColumnEnvelopeChecks` | RAB2 envelope CHECK on the 3 encrypted columns (pre-check, NOT VALID + VALIDATE). RAB3/AAD not implemented. |
| `1786719970000-FieldPermissionObjects` | `object_key` CHECKs widened to + `attendance`, `offer`, `shift_report` (DATA lane). |
| `1786719980000-MfaHandoffFollowups` (additive, MFA-lane requests) | `core.login_handoff_peek` (pre-auth, `STABLE` = cannot write, masked email + workspace name only, never consumes/extends); `GRANT INSERT (mfa_verified_at) ON core.user_session TO crewflow_app` (no UPDATE) + guard trigger (not future; user must hold an enabled factor). |

**New production modules:** `core/{mfa-schema-sql,login-handoff-sql,outbox-retention-sql,encrypted-column-envelope,mfa-handoff-followups-sql}.ts`,
`workspace-schema/v1/{archive-columns,search-vectors,server-path-template-archive-search,verify-workspace-schema-v1-versioned}.ts`.
**Modified:** `workspace-schema-modules.ts` (modules 16, 17), `v1/expected-fingerprints.ts` (16, 17),
`provision-workspace-schema.ts` (version-aware index count), `backfill/hws-backfill.service.ts` (DB5-3),
`tools/check-rls-coverage.ts` (DB5-1, `login_handoff` allowlisted), specs: `workspace-schema-modules.spec.ts`,
`workspace-schema-migrator`, `constraint-regression` (ARCHIVE_TRANSITIONS not persisted), `identity-security-table-rls` (19 columns).
**New test:** `__tests__/integration/w45-db5-schema.integration.spec.ts` (36 tests).

Design decisions: archive/search are workspace **modules** (single source of truth, both provisioning paths + migrator);
every unique constraint stays total (analysis in CONTRACT §3 — restore can never conflict; names/refs on payslips never
reused); no RLS change for archive; `job_offer` not indexed (no text); no email trigram (DATA may request one); MFA
functions are FORCE-compatible (context is server-derived at the challenge) and five of them are self-scoped.

## 2. Findings (CLAUDE §5.8)

```
DB5-1 [LOW→MEDIUM, latent] RLS coverage gate skipped every tenant table the runtime role cannot see
Actor→action→consequence: a migration creates a tenant table with no crewflow_app grant and forgets FORCE/policy → CI's
  check-rls-coverage reports "all protected" without ever looking at it (later granting it exposes it unguarded).
Location: tools/check-rls-coverage.ts:278-282 (information_schema.columns shows only columns the connected role may use).
Root cause: privilege-filtered catalog view. released_host_label, host_label_claim (S2) were never checked.
Fix: pg_catalog.pg_attribute/pg_class scan (58 → 62 tables). Regression: run against any DB — new tables are now listed;
  login_handoff fails the gate unless allowlisted.

DB5-2 [MEDIUM, would-be defect, design] replaying a FAILED email as PENDING never sends
Actor→action: an operator replays a FAILED email → dispatcher publishes PENDING rows under jobId …attempt.0, which BullMQ
  dedupes against the old failed job it retains 30 days → silently dropped, reported as "replayed".
Location: rab-worker email-dispatch.job.ts (PENDING → publish attempt.0), email-queue.service.ts:63.
Fix: replay_failed_email moves FAILED → RETRY (+ generation bump): the dispatcher's safe-recovery path republishes under a
  new generation jobId. Regression: w45-db5 §5 replay test (status RETRY, generation+1, audit row).

DB5-3 [MEDIUM, availability] HWS backfill command would fail on every table with a generated column
Actor→action: owner runs hws:backfill (HWS cutover) after v17 → INSERT … SELECT r.* includes search_vector → error, cutover blocked.
Location: workspace-schema/backfill/hws-backfill.service.ts insertJsonRows.
Fix: insert names only non-generated target columns (pg_attribute.attgenerated = ''). Regression: hws-backfill integration suite passes.

DB5-4 [LOW, rollback safety] MFA down() could drop the replay counter under live factors; re-up then failed half way
Fix: down() refuses while any TOTP factor/recovery code exists; up() refuses rows already totp_enabled. Found by the
  down→up rehearsal (tests/iteration-1-superseded). TypeORM `migration:revert` always opens a transaction: the two
  `transaction=false` migrations now join it (timeline index falls back to non-concurrent; documented).
```

Also fixed during testing (own code, pre-merge): `pg_catalog.least/greatest` (not functions) in the handoff SQL; a
plpgsql `CASE … THEN` inside `ELSIF` parsing as the condition end.

## 3. Security trade-offs

```
SECURITY TRADE-OFF — core.login_handoff is ENABLE but NOT FORCE (NOT_FORCED_ALLOWLIST)
Why: login_handoff_consume is a pre-auth lookup by token hash on the target host (it establishes the tenant context).
Bound: crewflow_app and crewflow hold NO table privilege; only create/consume/cleanup functions; rows hold ids, a label, a
  hash and timestamps. Veto option: FORCE + definer-set GUC policy.

SECURITY TRADE-OFF — mfa_disable / mfa_totp_state / mfa_rotate_totp_secret are org-scoped, not self-scoped
Why: admin reset (another user) and the secret:rotate job. Any org-bound runtime path can call them for a peer; the
  permission check is the service's. Veto option: separate admin-only functions keyed on a platform-admin check.

SECURITY TRADE-OFF — archived_by has no FK; uniques stay total
Why: history must survive user hard-delete (audit_log precedent); total uniques make restore conflict-free but a name/ref
  held by an archived row cannot be reused (409 "restore it").

SECURITY TRADE-OFF — verify_workspace_schema_v1 accepts any known index count (90/94/100) when the registry version is 0
Why: pre-ledger baseline and the provisioning transaction run before module_version is set; the exact per-version
  fingerprint check that every caller also runs is the precise control.

SECURITY TRADE-OFF — retention floors (email 30 d, push 30 d, realtime 7 d, worker_event 30 d) chosen by this lane
Why: safety minimums only; the values are owner decisions (G6), off by default in OPS.
```

## 4. Tests (see `tests/` and the summary in the hand-back)

- `w45-db5-schema` 36/36 on the final 208-migration build (incl. peek: display-only, repeatable, wrong host empty, still consumable once; session `mfa_verified_at` guard; every handoff test calls `login_handoff_create`, so the former `pg_catalog.greatest` bug is covered) (MFA guard/replay race/recovery codes/rotation/self-scope; handoff single use + race + audience +
  invalidation + limits + cleanup + zero rows with no context; archive CHECKs core+workspace; search accents/tenancy/GIN
  plans/no email; purge terminal-only/per tenant/floors/SKIP LOCKED; replay; timeline plan; envelope; object keys;
  v15-schema compatibility).
- Schema suites on the final DB: migrator 11/11, host-label 9 + contract 5, server-path ×3, hws-backfill (after
  DB5-3), constraint-regression (after ARCHIVE_TRANSITIONS), payroll-evidence, audit-log ×3, email-outbox, realtime,
  secret-rotation, workspace-execution-context, cross-tenant RLS attack: pass. `db-security-posture` and
  `workspace-security-coverage` fail exactly by `golden.diff` (expected until the golden is regenerated).
- rab-server unit 886/889 (tenant-context ×3, known). `tsc` app + spec 0 errors.
- Full rab-server integration (`--runInBand`, `HOST_LABEL_CONTRACT_DB=1`, 207-migration DB, `tests/24-…log`): **1796 passed /
  8 failed / 61 skipped** (145 suites). Failures: posture ×2 (= golden.diff, expected), identity-security-table-rls ×2 and
  shift-team ×1 (known pre-existing), `access-control-hardening` venue-archive HTTP status (DATA lane's in-progress code, not
  schema), `secret-rotation-wave5` (unreadable fake RAB2 rows — partly MY suite's fake envelopes, now cleaned up in the spec;
  the remaining ones belong to the older `secret-rotation` suite's `rotation-*` orgs: OPS test isolation), and one timeline
  plan assertion in my spec (planner-dependent; made planner-independent). Re-run after the fixes and the follow-up
  migration (`tests/27`): `w45-db5-schema` 36/36 PASS; the two foreign failures remain as described.
- Fresh install (built by the real runner, phase A rab_owner → phase B superuser, 207 migrations; re-verified at 208 with the follow-up — `fresh-install/final-v3-0ws`): posture = golden +
  golden.diff with 0, 1 (server path) and 2 (+TS path) workspaces; RLS OK; drift 2/2 OK; migrator CLI UP_TO_DATE.
  Pre-existing v15 workspace migrated by the migration itself: ledger 16/17 APPLIED, fingerprint OK.
- down→up of all 8 on the final code (`tests/26-final-down-up`): MFA down() refused while test factors existed (DB5-4 guard working); after clearing them, down to 200 and up to 208 → posture byte-identical. DB5-4 itself was found in the iteration-1 rehearsal.
- Rewrite impact (200k-row synthetic venue): generated column 1.24 s, GIN 1.26 s, trigram 1.15 s, archive cols 0.06 s;
  size 61 → 93 MB. Dev tables are < 120 kB each (apply took 4.1 s in total).

## 5. Dev apply (rab-devdb, TEST) — `dev-apply/`

Identity (system id `7699569147858477090`, 200 migrations) checked read-only twice. Backups (restore-tested, identical
counts): `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-063134-pre-w45-db5.dump` (958,097 B, sha256 `5c3d4c0d…5286`)
and, right before the apply, `rab-devdb-20261023-063702-pre-w45-db5-final.dump` (958,097 B, sha256
`27c1dd7a01286cb0f468e1569e1bd668b883d5374dd5994aefa0fcfe622ff79f`). Rehearsal on the restored copy: 7 applied, posture =
golden+diff, RLS OK, drift OK, `issac` → module 17. Apply: guarded runner, `DB_TARGET=local`, superuser from
`packages/rab-docker/.env` (never printed) → 207 migrations, then the additive follow-up (own backup `rab-devdb-20261023-065414-pre-w45-db5-followups.dump`, 1,022,916 B, sha256 `796fef29…c4c3fb`, restore-tested, rehearsed) → **208 migrations**, `issac` READY module 17, drift OK, migrator CLI
UP_TO_DATE 17→17, RLS OK, posture = golden + golden.diff (vs repo golden: exactly that drift). `/healthz` 200, containers
not restarted, 0 error lines. Compatible with the running wave-2+3 images (no runtime DELETE on outboxes; MFA columns never
written; old TS provisioner builds v15 and still verifies — tested).

## 6. Owner decisions

1. Production approval of `1786719900000`–`1786719980000` (none approved).
2. G6 retention values (and the floors chosen here); purged event keys lose dedupe.
3. Whether archived rows ever purge; whether an Initial Manager may be archived.
4. Org-scoped vs admin-only MFA disable (trade-off above); rate-limit the new pre-auth peek endpoint like consume (MFA lane).
5. Regenerate `security-posture.golden.txt` (= golden.diff, +109/−5); CLAUDE.md NOT-FORCE list now 13 + organisation/platform_admin.
6. Production rewrite window for the generated columns (ACCESS EXCLUSIVE per table per workspace).
