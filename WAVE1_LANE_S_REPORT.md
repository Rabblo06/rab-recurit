# Wave 1 lane S (schema/database): F3, F1, F4

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`. Nothing was committed, pushed or deployed. Neon and
production were not touched. Migrations were applied only to the disposable lane-S database and to the dev TEST database
`rab-devdb`, after a verified backup. No `rab-*` container was restarted or rebuilt.

**Evidence:** `docs/evidence/wave1-lane-s/` (test logs, the golden diff, and before/after posture and RLS-coverage runs on dev).
**THREAT-MODEL:** the new "Wave 1 Lane S" entry. **HANDOFF:** the 2026-10-23 lane-S entry.

## 1. Findings (CLAUDE §5.8 format)

```
F3 [MEDIUM, integrity — money]
Failure:     any code path, CLI or ad-hoc SQL deletes a staff_profile (directly, or via core."user" CASCADE), shift,
             shift_assignment or attendance row → approved payroll_record rows pointing at it were silently deleted.
Actor:       any writer with DELETE on those parents (crewflow_app has DELETE on staff_profile/shift/attendance; owner; superuser).
Location:    workspace-schema/v1/payroll-record.ts:93-95 (frozen template, also in core via 1786718800000) and the
             composition frozen into core.provision_workspace (server-path-template.ts / 1786719500000).
Root cause:  payroll_record_{attendance_id,shift_workspace,staff_workspace}_fkey were ON DELETE CASCADE; only
             UserDeletionService.assertCanDelete (layer 2) protected financial evidence.
Fix:         Migration PayrollEvidenceRestrict1786719700000 changes the three FKs to ON DELETE RESTRICT in core and in every
             workspace_* schema. Both provisioners build new workspaces the same way:
               - WORKSPACE_TEMPLATE_STEPS gains the frozen step payrollEvidenceRestrictSql;
               - core.provision_workspace is re-created with CREATE OR REPLACE (same owner, DEFINER, search_path and ACL)
                 using composeServerPathTemplateV1PayrollRestrict().
             Before changing anything, the old FKs are checked as validated, with the expected columns and parents.
             Re-adding each FK re-validates every row; a violation aborts the migration.
             Checked and left unchanged: payroll_run_line, payslip and payslip_document are already NO ACTION.
Regression:  payroll-evidence-restrict.integration.spec.ts (23 tests) covers core, a server-path workspace and a
             TypeScript-provisioned workspace:
               - deleting staff_profile / user / shift / booking / attendance fails with 23503 and nothing is deleted;
               - crewflow_app DELETE on payroll_record fails with 42501;
               - unpaid chains still delete as before;
               - down()/up() restores CASCADE and the original function body (same md5), inside a rolled-back transaction.
             server-path-template-payroll-restrict.spec.ts (6 tests): the two provisioning paths compose the same template, and
             the function body is byte-identical to the SQL that migration 1786719500000 itself emits.
```

```
F1 [MEDIUM — account takeover via stored bearer links]
Failure:     reader of core.email_outbox (backup, replica, future SQL-read bug) → reads rendered_html of a SENT reset /
             activation / invitation / email-change email → still-valid token → account takeover. Live on dev (1 SENT
             ACCOUNT_INVITATION body with an activation link).
Location:    engine/core-modules/email/email-outbox.service.ts:58-59 (stores bodies); rab-worker email-send.processor.ts
             (terminal writes kept them); producers auth.service.ts:830, account-lifecycle.service.ts:129/185,
             email-change.service.ts:91, member-invitation.service.ts:260.
Root cause:  the outbox stores fully rendered bodies and nothing cleared them after delivery.
Fix:         Rule: job_type ∈ {ACCOUNT_INVITATION, PASSWORD_RESET, MEMBER_INVITATION}, or a body containing a `token=` query
             parameter (this catches the email-change verification, which is a NOTIFICATION).
             Service layer: the processor nulls the body in the SAME write that sets SENT / terminal FAILED / CANCELLED
             (emailBodyCarriesSecret).
             Database layer: migration EmailOutboxSecretBodyScrub1786719710000 adds a BEFORE INSERT OR UPDATE trigger, active
             only on terminal statuses, that covers every other writer: dispatcher recovery, cancellations, older images,
             SQL. It also reconciles existing terminal rows per organisation under RLS (core.worker_list_organisations).
             What is kept: PENDING, QUEUED, PROCESSING and RETRY rows keep their body; subject, delivery metadata and audit
             rows are untouched.
             Fail-closed addition: the processor never sends an email with no body (EMPTY_BODY → FAILED).
Regression:  email-secret-body-retention.integration.spec.ts (rab-worker, 7 tests):
               - SENT: the link is delivered and the body is then NULL, with metadata and the email.sent audit row kept;
               - RETRY keeps the body and the retry delivers it;
               - FAILED: body NULL;
               - the email-change verification body is scrubbed and an ordinary notification keeps its body;
               - direct crewflow_app SQL to CANCELLED scrubs, and the body cannot be written back;
               - dispatcher stuck-lease → FAILED scrubs;
               - an empty body is never sent;
               - afterAll: no terminal row in the whole table contains any token the suite generated.
             email-outbox-secret-body.spec.ts (14 tests) renders every template.
```

```
F4 [MEDIUM, latent — dev is HWS-on]
Failure:     a workspace-schema migration or hand change drops FORCE, a policy or ownership, or adds a grant, in a
             workspace_<32 hex> schema → CI and the posture snapshot stayed green → exploitable with HWS_RUNTIME_ENABLED.
Location:    tools/check-rls-coverage.ts (core only); core/security-posture.ts POSTURE_QUERY (core only); golden had 0 ws lines.
Root cause:  both tools predated physical workspace schemas.
Fix:         check-rls-coverage.ts checks every schema matching ^workspace_[0-9a-f]{32}$, with no allowlist:
               - the schema is owned by rab_secure_owner;
               - the schema ACL lists only rab_secure_owner, crewflow and crewflow_app, and crewflow_app has USAGE only;
               - the schema holds only tables and indexes (no view, sequence or function);
               - every table has ENABLE + FORCE, is owned by crewflow, and has ≥1 policy with USING / WITH CHECK per command;
               - table and column ACLs equal those of the core counterpart;
               - every table returns 0 rows with no tenant context.
             security-posture.ts / check-db-security-posture.ts:
               - each schema gets a canonical fingerprint (schema name → workspace_*, uuid → <workspace_id>) covering owner,
                 ACLs, RLS flags, effective privileges, column ACLs, policies, FKs including the delete action, binding
                 CHECKs, triggers and functions;
               - every schema is compared ON ITS OWN with the single `ws|` template section in the golden (441 lines), so
                 the golden stays the same for 0..N workspaces;
               - `--write` refuses if workspaces disagree.
Regression:  workspace-security-coverage.integration.spec.ts (10 tests) uses disposable workspaces provisioned through
             core.provision_workspace:
               - a healthy workspace passes both tools;
               - each of these breaks makes both tools fail and name the schema: NO FORCE, wrong owner, extra DELETE grant,
                 PUBLIC grant, the only policy dropped, injected view, CREATE for crewflow_app;
               - two breaks are caught by the posture snapshot only: a dropped secondary policy and the F3 FK reverted to
                 CASCADE.
             db-security-posture.integration.spec.ts now requires zero workspace drift.
```

## 2. Files

**New (all untracked):**
- Migrations, under `packages/rab-server/src/database/typeorm/core/migrations/`:
  - `1786719700000-PayrollEvidenceRestrict.ts`
  - `1786719710000-EmailOutboxSecretBodyScrub.ts`
- Frozen workspace-schema modules, under `.../workspace-schema/v1/`:
  - `payroll-evidence-restrict.ts`
  - `provision-workspace-function.ts`
  - `server-path-template-payroll-restrict.ts`
- Tests:
  - `server-path-template-payroll-restrict.spec.ts`
  - `engine/core-modules/email/email-outbox-secret-body.spec.ts`
  - `__tests__/integration/payroll-evidence-restrict.integration.spec.ts`
  - `__tests__/integration/workspace-security-coverage.integration.spec.ts`
  - `packages/rab-worker/src/__tests__/integration/email-secret-body-retention.integration.spec.ts`
- Report: `WAVE1_LANE_S_REPORT.md`

**Modified:**
- `workspace-schema/provision-workspace-schema.ts`: `WORKSPACE_TEMPLATE_STEPS` plus the F3 step.
- `engine/core-modules/email/email-outbox.service.ts`: rule export.
- `rab-worker/src/queues/rab-email/email-send.processor.ts`: scrub at terminal writes, plus the empty-body guard.
- `core/security-posture.ts`, `core/security-posture.golden.txt` (+444 lines: 3 core lines, 441 `ws|` lines; nothing removed).
- `scripts/check-db-security-posture.ts`, `tools/check-rls-coverage.ts`.
- Tests:
  - `db-security-posture.integration.spec.ts`;
  - hygiene drops of the deliberately broken schemas in `server-path-provisioning-db` and `workspace-execution-context`;
  - `initial-manager-replacement`: the fixture now captures the activation link while the email is PENDING, and asserts that
    the body is NULL once the email is SENT.
- `THREAT-MODEL.md` and `docs/HANDOFF.md`: appended only; prior bytes verified identical.

Not touched: lane A, M and D files, and `production-migration-approval.ts` (my migrations are deliberately absent).

## 3. Tests (disposable `crewflow-lane-s-db`, 127.0.0.1:15441, built fresh from migrations, phase A + B)

All logs are in `docs/evidence/wave1-lane-s/tests/`.

**New specs (all pass)**

| Spec | Result |
|---|---|
| `server-path-template-payroll-restrict.spec.ts` | 6/6 |
| `email-outbox-secret-body.spec.ts` | 14/14 |
| `payroll-evidence-restrict.integration.spec.ts` | 23/23 |
| `workspace-security-coverage.integration.spec.ts` | 10/10 |
| `db-security-posture.integration.spec.ts` (updated) | 2/2 |
| `email-secret-body-retention.integration.spec.ts` (worker) | 7/7 |

**Targeted baseline before any change:** 13 suites, 161/161.

**Full rab-server run:** 2200 passed / 9 failed / 61 skipped, 178 suites.
- 7 of the 9 failures are not mine:
  - pre-existing: `tenant-context.service.spec` ×3, `identity-security-table-rls` ×2, `shift-team` ×1;
  - `application-access` ×1 ("ten-failure account limiter" now returns 401) comes from lane A's limiter change, committed
    as 8243bd4a during my run.
- The other 2 were `initial-manager-replacement` fixtures reading an activation token back from a SENT outbox body, which is
  exactly F1. I fixed the fixture to read the link while the email is still pending; the suite now passes 23/23.

**Full rab-worker run:** 426 passed / 15 failed / 13 skipped. All 15 failures are known or environmental:
- `member-invitation-delivery` ×9: stale `dto.objects`, pre-existing.
- 91-day token cleanup ×1: pre-existing.
- `workspace-provisioner-entrypoint` ×5: these need `TEST_DATABASE_CREWFLOW_URL`. Re-run with it, they pass 5/5 and exercise
  the TypeScript provisioner with the RESTRICT step.

**Fresh install with all 196 migrations** (`docs/evidence/wave1-lane-s/fresh-install/`):
- phase A stops at the role split, as designed; phase B exits 0;
- with 0 workspace schemas: posture matches 1068 lines and RLS coverage is OK;
- after one server-path workspace: posture matches the template and RLS coverage is OK (21 workspace tables).

**Type check:** `tsc -p rab-server/tsconfig.app.json` exits 0, and so does `tsc --noEmit -p rab-worker/tsconfig.app.json`.

## 4. Dev apply (rab-devdb, TEST database)

All evidence is in `docs/evidence/wave1-lane-s/dev-apply/`.

**Identity, checked read-only first:**
- container `rab-devdb` (postgres:16-alpine, volume `rab_devdb_data`), 127.0.0.1:15432, database `rab`;
- system_identifier `7699569147858477090`;
- 194 migrations, latest BootstrapFirstPlatformAdminFunction1786719620000.

**Backup:** `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-000341-pre-wave1-lane-s.dump`
- size 897,041 bytes;
- sha256 `9a0a9f4ceaa581e4e1a0bdd95d418bddaac22e56526f1695d242f5a81f5ec58e`;
- verified by `pg_restore` (exit 0) into a throwaway container, since removed: migrations, users, audit_log, email_outbox,
  workspace schemas and table counts are identical.

**Before the apply, the new tools were run read-only against dev:**
- Posture drift was exactly what these two migrations change: 3 core lines (the new function) and the 3 payroll FK lines of
  `workspace_3035bcde…`.
- RLS coverage was OK (1 workspace, 21 tables).

**Apply:** a one-shot guarded runner, `DB_TARGET=local`, as the bootstrap superuser. It applied
PayrollEvidenceRestrict1786719700000 and EmailOutboxSecretBodyScrub1786719710000, bringing dev to 196 migrations.

**After the apply:**
- All 6 payroll FKs are RESTRICT (core and the workspace).
- The trigger is enabled.
- **F1 reconciliation:**
  - The SENT `ACCOUNT_INVITATION` row now has NULL html and NULL text; its subject, provider and sent_at are kept.
  - The `WELCOME` row has no token, so it keeps its body.
  - Audit rows are unchanged (11).
- Posture matches the golden (1068 lines; 1 workspace matches the template).
- RLS coverage is OK.
- `rab-server` `/healthz` returns 200, every rab-* container is healthy, and there are 0 error lines in the last 10 minutes of
  server and worker logs.
- No container was restarted.

**Running older images:** this is safe. No code deletes those parents, and old terminal writes are scrubbed by the trigger.
See §5.3 for the provisioning window that lasts until the rebuild.

**Cleanup:** `crewflow-lane-s` (db and redis) and `crewflow-lane-s-restore` are removed, along with their volumes.
crewflow-test-db (15436) was not touched.

## 5. Owner decisions / notes

1. `payroll_record → organisation` (and the payroll_run/payslip family) is still `ON DELETE CASCADE`.
   - This is a tenant-offboarding retention question, so I did not invent a rule.
   - Deleting an organisation is already refused while it has any user (`user_organisation_id_fkey`; verified).
2. Unapproved attendance (no payroll record yet) still cascades with its staff profile and booking. This is the existing
   behaviour and outside "approved payroll evidence".
3. Transitional until the coordinator rebuilds images: the running OLD worker image's TypeScript provisioner (reconciler,
   `createFor` workspaces) still builds CASCADE FKs, while API-created workspaces use the updated DB function. The new posture
   check would flag such a workspace. Old images' terminal email writes are scrubbed by the trigger.
4. Long-lived test databases that still hold deliberately broken workspace schemas from older runs will now fail
   `db-security-posture` / `check-rls` until those schemas are dropped or the database is rebuilt. This is expected, not a
   regression. I did not touch crewflow-test-db (15436).
5. `.github/workflows/ci-security.yaml` still runs `check-rls` as the retired `rab_app`. This is pre-existing and lane D's or
   CI's concern; the script expects `crewflow_app`.
