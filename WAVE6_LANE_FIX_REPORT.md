# Wave 6 lane FIX: known failures cleared, security docs reconciled

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`. Everything is committed locally and nothing is pushed.

**Scope.** No product behaviour, grant, RLS policy, migration or retention value changed. Every failure was a stale or
wrong *test expectation*. Each one was decided on evidence, which is listed below. Code changed in two places only: a
comment in `session-policy.ts`, and one empty entry file for `rab-utils`.

**Not touched:** dev (rab-devdb and the `rab-*` stack), the owner account, CLAUDE.md, and `packages/rab-e2e-testing`.

**Evidence:** `docs/evidence/w6-fix/` (git-ignored, like all of `docs/`).

## 1. Failures: root cause, fix, proof

Every "before" and "after" below is a run against `crewflow-test-db` (127.0.0.1:15436). The logs are in
`docs/evidence/w6-fix/0Na/0Nb-*.log`.

### 1.1 `tenant-context.service.spec` ×3 (server unit)

- **Root cause:** stale expectation. Since `e31bf934`, `bindGucs` also resets the read-only shift-team capability on
  every transaction (`set_config('rab.team_shift_id', '', true)` and `set_config('rab.team_staff_id', '', true)`). The
  spec still expected the older five-GUC SQL. The reset is a deliberate security property: a capability that
  `ShiftTeamService` set for one query must never outlive that transaction.
- **Fix:** the expected SQL is now one constant matching the code. A new test asserts that both team GUCs are reset to a
  literal `''`, with exactly five client-derived parameters.
- **Proof:** 3 failed / 9 passed before (`01a`); 13/13 after (`01b`).

### 1.2 `identity-security-table-rls` ×2 (server integration)

- **Decision: the test was stale. No grant is missing, and none was added.**
- **Evidence** (`pg_catalog`, read as the superuser):
  - `core."user"` has 19 safe SELECT columns for **both** `crewflow` and `crewflow_app`. No login role holds
    `password_hash`, `temporary_password_hash`, `totp_secret_encrypted` or `totp_last_used_step`.
  - All 10 pre-auth DEFINER functions are owned by `rab_secure_owner`, with EXECUTE for `crewflow` and `crewflow_app`
    only and never PUBLIC.
- **Root cause:** the test still used the P1C.2 single-credential role name `crewflow`. Since
  `CrewflowAppRestrictedRuntimeRole1786687000000` the runtime connection is `crewflow_app`. The test read
  `information_schema` over that connection, and `information_schema` lists only grants to roles the current user
  belongs to. Every query for grantee `crewflow` therefore returned `[]`, whatever the real ACL. The test could not
  fail on a real leak either.
- **Fix:**
  - The test pins `current_user = crewflow_app` and checks its own 19 columns.
  - It checks `has_column_privilege` from `pg_catalog`, through the admin connection, for **every** non-superuser login
    role and the four secret columns.
  - It reads the function ACLs with `aclexplode`. A NULL ACL counts as a PUBLIC grant. No function may grant PUBLIC,
    and `crewflow_app` must hold EXECUTE on all 10.
- **Proof:**
  - 2 failed before (`02a`); 28/28 after (`02b`).
  - **Mutation check** (`02c`): a temporary `GRANT SELECT (password_hash) ON core."user" TO crewflow` made the new test
    fail. It was revoked at once, and `has_column_privilege` then returned false.

### 1.3 `shift-team` ×1 (server integration): `GET /attendance/me/shift/invalid/team` returns 404, the test expected 400

- **Decision: 404 is correct, and the test was wrong.**
  - `AppModule` registers a global `UuidPathParamsInterceptor`. It turns any non-UUID record path parameter (`:id`,
    `…Id`) into 404 "Not found.". It runs after the guards (so 401/403 still come first) and before the pipes, so the
    route's `ParseUUIDPipe` never sees the value.
  - This is the repository-wide convention. It is pinned by `path-param-uuid-validation.integration.spec.ts` and
    asserted for malformed ids in `admin-outbox-operations`, `member-invitation`, `replacement-standby-offers` and
    `venue-photo`.
  - It also matches CLAUDE.md's rule of 404 for anything that cannot name a record in scope, and the test's own title
    ("without enumeration").
- **Fix:** the test expects 404. A comment explains the interceptor order. Product code is unchanged.
- **Proof:** 1 failed before (`03a`); 13/13 after (`03b`).

### 1.4 Worker `member-invitation-delivery` W1–W9

- **Root cause:** the fixture called `RoleService.create(ctx, { name, permissionKeys: ['staff.view'] })`. Custom roles
  have been object rules since the member-roles redesign (`RoleDefinitionDto`:
  `objects / readAllObjects / assignableToMembers`). `validateDefinitionTx` iterated `dto.objects` (undefined) and threw
  `TypeError: dto.objects is not iterable`. Jest does not type-check the worker specs, so nothing flagged the stale
  shape.
- **Fix:** a typed helper `staffViewerRole(name)` returns
  `{ assignableToMembers: true, readAllObjects: false, objects: [{ object: 'staff', read: 'grant' }] }`. That is the
  same effective grant (`staff.view`) the old fixture asked for.
- **Proof:** 9 failed before (`04a`); 9/9 after (`04b`).

### 1.5 Worker 91-day refresh-token cleanup (data retention: no rule invented)

- **Decision: the job is correct, and the test asserted a deletion the documented policy forbids.**
- **Documented rule:** retention is **181 days** past expiry or revocation.
  - Source: `WebSessionRetention1786717100000` (owner decision 2026-10-14). The 180-day manager web session needs its
    reuse evidence to outlive it.
  - The live function `core.worker_cleanup_auth_tokens` on the test DB uses `interval '181 days'`.
  - The codebase records the value as `AUTH_TOKEN_CLEANUP_RETENTION_DAYS = 181`, and `retention-policy.spec.ts` checks
    that it exceeds the longest session.
- **Why the test failed:** it hard-coded 92 days, the earlier 91-day policy. A token expired 92 days ago is correctly
  **kept**.
- **Fix:**
  - The test straddles the documented constant: a token 182 days dead is deleted, and tokens 180 and 5 days dead are
    kept.
  - It drains the bounded batches the way production ticks do, so other suites' rows on a shared DB cannot use up the
    batch.
  - The job and the SQL are unchanged.
- **Proof:** 1 failed before (`05a`); 18/18 after (`05b`).

### 1.6 `rab-utils` TS18003

- **Root cause:** the package contains only `src/seed/README.md`. Its `lint` target runs
  `tsc --noEmit -p packages/rab-utils/tsconfig.json`, and tsc refuses a project with no inputs.
- **Fix:** an explicit empty entry `packages/rab-utils/src/index.ts` (`export {}`, with a comment saying to delete it
  once real sources exist). The owner's README is untouched, and the target stays meaningful.
- **Proof:**
  - Before: `exit=2`, TS18003 (`06a`).
  - After: `tsc` `exit=0` (`06b`), and `nx run rab-utils:lint --skip-nx-cache` succeeds (`06c`).

### 1.7 Added: regression tests for the 2026-08-20 audit findings

These tests let `SECURITY_AUDIT.md` mark findings fixed on test evidence, not code evidence alone:
- `account-lifecycle-abuse-cases` "SECURITY_AUDIT VULN-003 regression": the audit's exact sequence. T1 is refused once
  T2 is issued; T2 resets; T1 and T2 are then both refused.
- `resource-ownership-abuse-cases` "SECURITY_AUDIT VULN-004 regression": an array reason, a 1001-character reason, or an
  extra `status` field each get 400, and the shift stays live.

## 2. Full suites (once, sequential, `crewflow-test-db`)

| Suite | Waves 4+5 | Now | Failures | Evidence |
|---|---|---|---|---|
| rab-server unit (`--maxWorkers=2`) | 903/906 | **907/907** (70 suites) | none | `full/10-server-unit.log` |
| rab-server integration (`--runInBand --forceExit`, `HOST_LABEL_CONTRACT_DB=1`) | 1804 / 3 / 61 | **1809 passed / 0 failed / 61 skipped** (140 suites run, 5 skipped) | none | `final2/20-server-integration.{log,json}` |
| rab-worker (`TEST_DATABASE_CREWFLOW_URL`) | 449 / 10 / 13 | **459 passed / 0 failed / 13 skipped** (32 suites run) | none | `final/30-worker.{log,json}` |
| `rab-utils` lint (`tsc`) | TS18003 | exit 0 | none | `06b`, `06c` |

All the changed and new tests passed inside these full runs:
- identity-security-table-rls, shift-team, path-param-uuid-validation;
- account-lifecycle-abuse-cases (VULN-003), resource-ownership-abuse-cases (VULN-004);
- worker member-invitation-delivery and worker-operations-abuse-cases.

**How the runs went (disclosed in full).**

1. **First attempt (my error).** From Git Bash, `--testPathIgnorePatterns '/__tests__/integration/'` was MSYS-path-converted
   into a Windows path, so the "unit" run executed integration suites with 2 workers in parallel. Stopping its script then
   let its integration step start while my corrected run was also running, so two integration runs overlapped on 15436
   for about 8 minutes. I killed every one of my jest and bash processes, kept no results from them, and moved their logs
   to `full-discarded-overlapping-runs/`. The E2E lane's processes were not touched.
2. **Debris from those killed runs** (their `afterAll` never ran) broke later suites:
   - `secret-rotation`'s private-kid and corrupt SMTP envelopes (3 rows);
   - 11 half-provisioned or tampered workspace schemas from `workspace-schema-migrator` and
     `workspace-security-coverage`, which caused 984 posture-drift lines.

   I removed exactly those rows and schemas, as each suite's own `afterAll` would have. Log:
   `07-testdb-debris-cleanup.log`.
3. **The next full run (`full/`)** still failed in suites that depend on database size:
   - `containment-suspend-test-accounts`: its `beforeAll` runs `TRUNCATE core.organisation CASCADE`. I measured this at
     **147 s** in a rolled-back transaction, against a 30 s hook timeout.
   - `server-path-provisioning-db`: 5 s tests that run DDL.
   - `outbox-retention-replay` and `shift-cancellation-correctness` (worker): one timeout and one timing failure.

   The cause was a test DB grown to 3,568 organisations, 164 orphaned workspace schemas and 26k relations, where the waves
   4+5 baseline started fresh. Each of these suites except containment and outbox-retention passed on a single isolated
   re-run (`rerun-isolated/`).
4. **Test-DB reset (`08-testdb-reset.log`).** On `crewflow-test-db` only (disposable marker verified, no other active
   backend):
   - I ran the containment suite's own reset step (`TRUNCATE core.organisation CASCADE`).
   - I dropped the 164 `workspace_<hex>` schemas that had no `workspace_schema_registry` row, which the runtime cannot
     reach.

   Nothing else was changed. The container was not recreated, because I did not create it.
5. **Final runs.**
   - `final/`: the worker suite was green (459/0/13). Server integration still timed out the same two size-dependent
     suites, because the orphaned schemas had not been dropped yet.
   - After the schema drop, both suites passed in isolation (`final-isolated/`: provisioning 26/26, containment 5/5). The
     first containment attempt there refused with "1 other active backend", and the second passed.
   - **`final2/`: a complete, sequential server-integration run with 0 failures.**

**Recommendation (owner).** Recreate `crewflow-test-db` fresh before each validation wave, as earlier waves did. Two
suites have hard-coded timeouts that scale with the size of the shared test DB:
- containment: `TRUNCATE ... CASCADE` across every workspace table;
- provisioning-db: 5 s DDL tests.

I did not raise these timeouts: that would hide the growth instead of fixing it.

## 3. Security documentation (Part B §28)

| File | Change |
|---|---|
| `SECURITY_AUDIT.md` | New "Status reconciliation (2026-10-23)" section at the top. The original report is unchanged below it. Per finding: VULN-001–004 **Fixed**, each citing the commit, file:line and test. The localStorage note stays **Mitigated, not Fixed**: no front-end test exists. The dependency advisories are marked **not re-verified**. Stale statements (lockout, "payroll not implemented", "CSRF: never a cookie", "5 NOT FORCE tables") are listed with the replacing control. |
| `SECURITY.md` | The DB credential row now names `crewflow` / `crewflow_app` / `rab_secure_owner`. The stale "M0: no tenant tables" and "auth not built yet" sections are replaced. New section "Authentication and session policy (implemented)" gives exact values: idle and absolute timeouts per class, access-token and refresh-token TTLs, 181-day retention, revocation events, limiter thresholds and failure codes, route throttles, MFA behaviour and defaults, key separation, the cookie policy, CSRF and origin trust, and the host-routing and handoff trust model. A "Known gaps / off by default" list is added. |
| `THREAT-MODEL.md` | Structure only, with history kept: a "Reading this file" note (append-only log, plus a table of superseded statements); one `#` heading demoted to `##`; one mojibake `?` replaced with an em dash; a new "Wave 6 lane FIX" entry (W6F-1..3). A script verified that every original line is still present, in order. |
| `rab-docs/security/authentication-and-sessions.mdx` | Lockout → slow-down. Web session 24 h / 30 min → 180 d / 30 d, with the stricter platform-admin limits. MFA "not available" → a two-factor section. New revocation events. |
| `rab-docs/developers/authentication-flow.mdx` | Session table corrected. Limiter thresholds replace the lockout. New sections: revocation, second factor, cookies, hosts and handoff. |
| `rab-docs/developers/database-and-migrations.mdx` | NOT FORCE: 15 tables, the owner `rab_secure_owner`, and `crewflow_app` bound by RLS. |
| `rab-docs/developers/api-reference/overview.mdx` | The 429 row now describes the limiter (`LOGIN_RATE_LIMITED`, `retryAfter`, 503 fail-closed). |
| `rab-server/.../auth/session-policy.ts` | **Comments only.** They said manager_web was "24h / 30 minutes"; they now give the current values. |

`account/sessions-and-devices.mdx` and `account/signing-in.mdx` were already correct and are unchanged.

**Proposed CLAUDE.md change (not applied; needs owner approval):**
`docs/evidence/w6-fix/claude-md-proposed.diff`. It checks clean with `git apply --check`. The diff rewrites the
NOT-FORCE paragraph:
- the count goes from "Ten" to **fifteen**: the 13 in `NOT_FORCED_ALLOWLIST`, plus `organisation` and
  `platform_admin`;
- it adds `worker_due_work`, `user_auth_identity`, `user_session`, `member_invitation`, `email_change_request`,
  `released_host_label` and `login_handoff`;
- it removes `staff_profile` and `manager_profile`, which have been FORCE again since 1786675800000/…810000;
- it sets the owner to `rab_secure_owner` and the runtime role to `crewflow_app`;
- it notes the three no-RLS non-tenant tables: `migrations`, `permission` and `oauth_transaction_state`.

All of it was checked against the live test DB (15 NOT FORCE tables, matching the allow-list).

## 4. Commits

| Commit | Content |
|---|---|
| `23cd559a` test | The six known failures cleared (§1.1–1.6). |
| `2ccd563d` docs(security) | SECURITY_AUDIT / SECURITY / THREAT-MODEL / rab-docs reconciliation, `session-policy.ts` comments, VULN-003/004 regression tests. |
| (this report) docs | `WAVE6_LANE_FIX_REPORT.md` |

- **Secret scan:** each staged diff was checked against every value in the local env files (values never printed) and
  against generic credential patterns. **0 hits.**
- **Not staged, left as the owner asked:** `packages/rab-docs/tools/**`, `skills-lock.json`, the 3 deleted `CREWFLOW_*`
  reports, the `rab-iphone` docs and the E2E lane's `packages/rab-e2e-testing/system/`.
- Nothing was pushed.

## 5. Notes for the owner

- `oauth_transaction_state` has **no RLS at all**, and `crewflow_app` holds SELECT, INSERT and UPDATE on it. This is
  documented as intended in `OAuthTransactionState1786680300000`: the table holds pre-identity OIDC state and has no
  `organisation_id`. It is not a finding, but CLAUDE.md does not mention it. The proposed diff adds it.
- From Git Bash, jest's `--testPathIgnorePatterns '/…/'` is silently path-converted by MSYS (§2). Use
  `MSYS_NO_PATHCONV=1`, or separator-free patterns such as `__tests__.integration`. Stopping a background test script
  does not stop its children: kill the whole process tree.
- No mutation check was run for the two new VULN-003/004 tests (that would mean temporarily breaking product code). They
  exercise the audit's exact attack inputs against the real HTTP API.
