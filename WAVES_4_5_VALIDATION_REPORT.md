# Waves 4+5: integration, validation and dev rollout

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation` (local only, nothing pushed). **Lanes integrated:**
DB5 (schema), MFA (auth), DATA (archive/search/field policy/timeline) and OPS (retention/replay/cache/rotation).

Nothing touched production, Neon, Cloudflare or DNS. The owner's account `issac@gmail.com` was not used: no login,
password, MFA or session change. **Evidence:** `docs/evidence/waves-4-5-validation/` (git-ignored, like all of `docs/`).

**Verdict: PASS.** The combined tree typechecks. Every test failure is on the known pre-existing list. The rollout
found one new defect (the worker refused to boot) and it is fixed, with a regression test. Dev runs the new images with
the login handoff on. A synthetic MFA enrol → challenge → handoff passed end to end over real HTTP, on a disposable
stack built from the new server image.

## 1. Commits (local, on top of `ee5ba050`)

| Commit | Content |
|---|---|
| `d5a372ab` feat(db) | DB5: migrations `1786719900000`–`…980000`, core SQL modules, workspace modules 16/17, version-aware verification, DB5-1/3/4 fixes, report |
| `868d690a` feat(auth) | MFA: `auth/**`, the web challenge, two-factor settings, admin reset and handoff landing, MFA specs, SECURITY.md, report |
| `941e63fa` feat(data) | DATA: archive/restore, search, FieldPolicyService, the timeline module, `@rab/shared` archive transitions, web, specs, report |
| `0f1f953f` feat(ops) | OPS: the retention and handoff-cleanup jobs, outbox admin/replay, the L1 cache, `secret:rotate` targets, specs, report |
| `510f5c8c` fix(integration) | Files several lanes edited (env ×3, `JOBS_ENV_KEYS`, audit actions, `app.module.ts`, THREAT-MODEL), migration `1786719990000`, the regenerated golden, test isolation, the VM archived-venue fix |
| `1220ecc2` fix(worker) | WorkerModule imports `MemberAccessModule`, plus the boot regression test (§2.5) |
| `f8fab64b` chore(docker) | Dev compose: `AUTH_LOGIN_HANDOFF_ENABLED: 'true'` on server and worker |

- **Left uncommitted, as the owner asked:** `packages/rab-docs/tools/**`, `skills-lock.json`, the 3 deleted
  `CREWFLOW_*` reports and the `rab-iphone` docs.
- **Secret scan:** every staged diff was checked against every value in the local env files (values never printed) and
  against generic credential patterns. **0 hits.** The only flagged values were `localhost` URLs and were excluded.
- **Split commits:** the lane commits leave out the files that several lanes edited, as in waves 2+3. The intermediate
  commits therefore do not build on their own; `510f5c8c` does.

## 2. Integration fixes

1. **(a) New migration `FieldPermissionPayrollRecordKey1786719990000`** (dev/test only, not in
   `production-migration-approval.ts`).
   - It widens only `role_field_permission_object_key_check` by `payroll_record`. `role_object_permission` still
     refuses that key, so the Roles editor can never create a payroll "See" grant.
   - `down()` restores the previous key list. It refuses while any `payroll_record` rule exists.
   - **Down→up rehearsal** in a rolled-back transaction: identical CHECK (`testdb/15`).
   - **New test** in `w45-db5-schema`: field key → 23503 (the CHECK passed, only the FK refused); object key → 23514.
   - It adds no line to the posture golden: CHECK constraints are not part of the posture.
2. **(b) Rotation test isolation** (fixtures only; product unchanged).
   - `secret-rotation` clears the values it stored under its private kid.
   - `secret-rotation-wave5` rotates the whole database back to `legacy`, then deletes its own push devices, SMTP
     values and TOTP factor.
   - The worker `outbox-retention-replay` suite deletes its fake-envelope (kid `x`) push devices.
   - **A latent flake was found while proving this.** The wave-5 interrupted-apply case (`maxRotations: 3`,
     database-wide, in id order) could spend its whole budget on other suites' rows. Whether it did depended on random
     organisation ids. The suite now settles other rows onto the active kid before it creates its fixtures.
   - **Proof:** the suites were run in alternating orders, five runs in total, and all passed (`tests/22b`). The run
     before the fix failed 2/10 on a re-run (`tests/22a`).
3. **(c) Mobile.** `venue_manager_provider.dart` requests `/venues?includeArchived=true`.
   - Archived rows are used only for venue names; pickers and the "assigned venues" list keep live venues only.
   - There is a new `isArchivedVenue` helper. It treats `status == 'archived'` or a set `archivedAt` as archived, so
     venues archived before wave 5 are covered.
   - **New test:** `venue_manager_archived_venue_test.dart` (2 tests).
4. **(d) RAB2 envelope CHECKs vs fixtures.** Every test writer of the three encrypted columns was checked.
   - All of them write valid RAB2 envelopes: real ones from `SecretEncryptionService`, or ≥34-byte fakes with a
     `RAB2` header.
   - Undecryptable fakes are now cleaned up (item 2). No CHECK conflict exists.
5. **(e) Other wave 4–5 failures.**
   - **Worker `workspace-provisioning`** asserted 90 indexes. The schema is now provisioned at module 17, which has
     100. The spec now checks `expectedWorkspaceIndexCount(LATEST)` and the recorded `module_version`.
   - **Worker refused to boot on dev** (found at rollout, the only real defect):
     `UnknownDependenciesException: PayrollService.fieldPolicy`.
     - Cause: wave 5 injects `FieldPolicyService` into the attendance, report and payroll services. Only the API's
       global `MemberAccessModule` provides it.
     - Why tests missed it: the worker's own `WorkerModule` graph is never booted by any test, because every worker
       suite boots `AppModule`.
     - Fix: `WorkerModule` imports `MemberAccessModule`.
     - Regression test `worker-module-boot.integration.spec.ts` compiles the real `WorkerModule`. It fails without the
       fix (`tests/33a`) and passes with it (`33b`).
     - The CLI `CommandModule` boots (`ping` → `pong`, `integration/04`).
   - **SECURITY.md:** the TOTP rotation row was out of date and now describes the coverage that exists.

## 3. Fresh test DB and golden

- **`crewflow-test-db` recreated.** Only that container and its own volume (`f65b7119…`) were removed. The new
  container uses the same settings: postgres:16-alpine, checksums on, `max_locks_per_transaction=256`,
  `unless-stopped`, init scripts mounted read-only, cluster `7699746752059502632`.
- **Migrations:** phase A as `rab_owner` stopped at the role split, as designed (128). Phase B as the superuser exited
  0, for a total of **209**. The disposable marker is set. Test Redis db 0 was flushed.
- **Golden** (`check-db-security-posture.ts --write`, run with one READY workspace provisioned so that the workspace
  template is regenerated, not just kept):
  - The diff against HEAD is **byte-identical to DB5's `golden.diff` (+109/−5)**. The new migration adds 0 lines.
  - Result: 1252 lines; posture check OK.
  - A first write with 0 workspaces kept the old template section and was missing DB5's 10 `ws|` index lines. It was
    discarded.
- **RLS coverage:** OK, 62 tenant tables plus 21 workspace tables.

## 4. Tests (sequential, fresh DB)

| Suite | Waves 2+3 | Now | Failures |
|---|---|---|---|
| rab-shared | 113 | **117/117** | none |
| rab-ui | 2 | **2/2** | none |
| rab-front (`--maxWorkers=2`) | 683 | **715/715** (74 suites) | none |
| rab-server unit (`--maxWorkers=2`) | 816/819 | **903/906** (70 suites) | tenant-context ×3 (known) |
| rab-server integration (`--runInBand --forceExit`, `HOST_LABEL_CONTRACT_DB=1`) | 1672/3/61 (135) | **1804 / 3 / 61** (145 suites) | identity-security-table-rls ×2, shift-team ×1 (known) |
| rab-worker (`TEST_DATABASE_CREWFLOW_URL`), first run | 431/10/13 | 447 / 11 / 13 (32 suites) | known: W1–W9 + 91-day cleanup. New: `workspace-provisioning` (fixed, 6/6 on re-run) |
| rab-worker, final run after both worker fixes | 431/10/13 | **449 / 10 / 13** (33 suites) | member-invitation-delivery W1–W9, 91-day token cleanup (known) |
| rab-mobile `flutter test` | 652 | **654/654** | none |
| worker-bundle launcher, Windows | 18/0/12 | 18/0/12 | none |
| worker-bundle launcher, in the image via tini | 30/30 | **30/30**, both builds | none |
| `tsc`, 7 projects + server spec | 6 exit 0 | 6 exit 0, server spec exit 0 | rab-utils TS18003 (known) |
| `yarn lint` (run alone) | rab-utils, `rab:lint` | same | known. Its recursion also flagged `rab-server:build` as flaky (TS5033, concurrent dist writes); dists were rebuilt afterwards |

- **New suites, all passing:**
  - w45-db5-schema **37/37** (includes the new key test)
  - mfa-totp-wave4 12/12
  - login-handoff-wave4 10/10
  - mfa-attempt-limiter-wave4 1/1
  - login-second-factor-gate 6/6
  - google-oauth-handoff 23/23
  - w5-archive-restore 28/28
  - w5-search 7/7
  - w5-timeline-field-permissions 14/14
  - admin-outbox-operations 8/8
  - metadata-l1-revocation 5/5
  - secret-rotation 6/6
  - secret-rotation-wave5 10/10
  - db-security-posture 2/2
  - workspace-security-coverage 10/10
  - worker: outbox-retention-replay 12/12, login-handoff-cleanup 5/5, worker-module-boot 1/1
- **Spec-config `tsc` errors** in `rab-front/tsconfig.spec.json` (`import.meta`) and `rab-worker/tsconfig.spec.json`
  (older suites) are pre-existing: none of those files changed in this wave, and Jest does not type-check them.
- `tests/21-rab-server-integration.json` contains test-fixture JWTs. Do not share it.

## 5. Dev rollout (rab-devdb, TEST database)

- **Identity, read-only:** system id `7699569147858477090`, 208 migrations.
- **Backups**, each restore-tested in a throwaway container (`pg_restore` exit 0, identical counts):
  - `C:\Users\issac\crewflow-db-backups\rab-devdb-20261023-073421-pre-waves-4-5-integration.dump`: 1,027,374 B,
    sha256 `fc850ff8…a929b`.
  - Taken right before the apply: `…\rab-devdb-20261023-083238-pre-waves-4-5-migration-1786719990000.dump`:
    1,027,374 B, sha256 `4d634d7db7dc8a4a1915211e582cfcd034049de7379e13b904122688ffeb1106`.
  - The throwaway containers and their anonymous volumes were removed. Both volumes were mine, identified by creation
    time.
- **Before the apply:** posture already matched the new golden (DB5 had applied its migrations).
- **Apply:** the guarded runner, `DB_TARGET=local`, superuser from `packages/rab-docker/.env` (never printed).
  It applied `FieldPermissionPayrollRecordKey1786719990000`, for a total of **209**.
- **After the apply:**
  - migrator CLI: `issac` UP_TO_DATE 17→17;
  - posture: matches, 1252 lines, 1 workspace;
  - RLS: OK (62 + 21);
  - drift: `checked=1 ok=1 findings=0`.
- **Images:** built one at a time. Final server `9c01761e`, worker `7a71bdf1`; they were `5c243bff` / `cf625877`.
  The first worker build crash-looped the jobs child (§2.5). It was fixed, rebuilt and recreated.
- **Restart:** `up -d --no-deps server worker front`, and all three are healthy.
- **Guards:**
  - api `crewflow_app`;
  - jobs `crewflow_app`;
  - provisioner `crewflow`;
  - "live identity probes agree".
- **Drift job** ran at start-up: `checked=1 ok=1 findings=0`.
- **Jobs, from the `rab:worker:stats` hash:**
  - `lastLoginHandoffCleanupAt` is set: the cleanup job is ON and running.
  - The outbox-retention loop is registered but disabled: `OUTBOX_RETENTION_ENABLED` is unset (default false), so it
    returns before any query and writes no `lastOutboxRetentionAt`.
- **Flags:**
  - On, in server and worker: `AUTH_LOGIN_HANDOFF_ENABLED=true`, host routing and origin trust.
  - At their defaults: every MFA, step-up, outbox and L1 flag. None of them is set in the compose file or `.env`.
- **Logs after the smoke tests:**
  - server: 0 errors, plus 2 expected WARNs `login_handoff_exchange_refused` (my bogus tokens);
  - worker and front: 0.

## 6. Smoke tests

### 6.1 Dev (`smoke/01`, curl, no credentials)

| Check | Result |
|---|---|
| `/healthz` | 200 |
| Resolver, Host `issac.localhost:5173` | `workspace`, displayName `issac` |
| Resolver, `127.0.0.1:5173` | `default` |
| `GET /auth/mfa`; `POST` enrolment, disable, step-up, `admin/users/:id/mfa/reset` | 401 "Missing credentials" |
| `challenge/verify` with a bogus token | 401 `MFA_CHALLENGE_EXPIRED` |
| Handoff create with no session | 401 |
| Exchange of 3 different bogus tokens, on the workspace host and on the default host | identical 401 `LOGIN_HANDOFF_INVALID` |
| Exchange with an `evil.localhost` Origin | 403 |
| search, timeline (shifts/staff), venue archive, staff restore, `venues?includeArchived`, admin outbox failed/replay | all 401 |
| **Login-handoff peek endpoint** | **none exists** (404). DB5 ships `core.login_handoff_peek`, but the MFA lane built auto-exchange with no confirmation screen. That is owner decision MFA-4 |

### 6.2 Synthetic end to end on a disposable stack (`smoke/16`)

**Setup:**
- the new `rab-server` image as the throwaway container `crewflow-w45-e2e-api`;
- the disposable `crewflow-test-db` (cluster `7699746752059502632`, not dev) and test Redis db 9;
- routing, trust and handoff on;
- one synthetic organisation and manager per run, made by the suites' `TestIdentityFactory`.

**Result: E2E PASS.** Steps:
1. Password sign-in → 200.
2. Create a workspace → 201, READY.
3. Enrolment with a wrong password → 403. With the right one → otpauth URI and a PNG QR.
4. A wrong confirm code → 401. The current code → 10 recovery codes. The confirming code replayed → 401.
5. Sign-in again → **409 `SECOND_FACTOR_REQUIRED`**, with no session.
6. The used code → 401 (replay). The next-step code → 200 and a session. The challenge reused → 401.
7. Handoff → `http://<label>.w45e2e.test/auth/handoff`, token in the fragment only.
8. Exchange attempts:
   - on the default host → 401;
   - with a foreign Origin → 403;
   - with the audience in the body → 400;
   - **on the canonical host → 200**, new HttpOnly host-only cookie, body only `{mustResetPassword, sessionExpiresAt}`;
   - replayed → 401.
9. The new session's `/auth/me` → 200. The source session → 401 (revoked). `/auth/mfa` shows the factor enabled.

**Teardown:** the container is removed, Redis db 9 flushed, and the synthetic credential files deleted. The synthetic
rows remain only on the disposable test DB.

**Observation (not a defect).** A token presented on the default host or an unknown host is refused before the
database lookup, so it is not consumed. It stays valid for its own audience for at most 30 s. "Burned" in
`login-handoff-wave4`'s test title applies only to presentation on a wrong *workspace* host. Run 2 (`smoke/14`)
asserted the stricter reading and failed on exactly this point.

### 6.3 Steps for the owner (dev, own account)

1. Open http://127.0.0.1:5173 and sign in as usual.
2. You should land on **http://issac.localhost:5173** through the handoff. You are signed in there, and the
   127.0.0.1 session ends.
3. Go to **Settings → Account → Two-factor authentication** and press **Turn on** (or **Set up**).
4. Enter your password, scan the QR code (or type the manual key), then enter the 6-digit code.
5. Save the 10 recovery codes (Download or Copy), then tick the acknowledgement and press Continue. Your other sessions
   end.
6. Sign out, then sign in at http://127.0.0.1:5173. After the password, the code step appears: enter the current
   code, or a recovery code.
7. You arrive on `issac.localhost`.
8. To turn it off: **Settings → Account → Two-factor → Turn off** (needs your password and a current code). Nothing
   enforces MFA on dev, so turning it off is always allowed.

## 7. Owner decisions (consolidated)

**DB5**
1. Production approval of `1786719900000`–`…990000`. None is approved, including the new `…990000`.
2. G6 retention values and floors. Purged event keys lose their dedupe.
3. Should archived rows ever purge? May an Initial Manager be archived?
4. MFA disable scoped to the organisation vs admin-only.
5. Rate-limit the pre-auth peek (only if a peek endpoint is built).
6. A production rewrite window for the generated columns (ACCESS EXCLUSIVE per table, per workspace).
7. The CLAUDE.md NOT-FORCE list is stale: it should read 13 + `organisation` / `platform_admin`. The golden
   regeneration is done.

**MFA**
1. Enforcement order and dates; is `OTHER_WEB_USERS` ever enforced?
2. Mobile: `exempt` vs `require`.
3. The in-repo RFC 6238 vs otplib.
4. A handoff confirmation screen using peek, vs auto-exchange as built.
5. The recovery-code hash: SHA-256 vs a peppered HMAC.
6. Who may reset a CEO's MFA.
7. Should the source session survive the handoff?

**DATA**
1. The archive preconditions, and "no new work at archived venues or roles".
2. Archive retention, and Initial-Manager archiving.
3. Decision #12 remainder: offer and shift pay rates are still visible to Venue Managers.
4. W5D-1: LEAKPROOF vs scan-based search for large tenants.
5. Should `includeArchived` also apply to dashboard counts and the VM directory?

Done here: the VM app follow-up, and the `payroll_record` key.

**OPS**
1. G6 retention periods, and when to move from report to purge.
2. The L1 cache per environment.
3. Replay without step-up.
4. G7: rotation apply in production, and retirement of `legacy`.
5. A second admin for `DELIVERY_UNCERTAIN` replays.

**Integration**
1. No UI writes `payroll_record` field rules yet. Decide whether the Roles editor should gain them.
2. Accept the handoff semantics in §6.2 (default or unknown host = refused, not consumed). Otherwise, rename the test.

## 8. Final worker run

The full rab-worker suite was re-run on the fresh DB after both worker fixes (`tests/34-rab-worker-final.{log,json}`):
**449 passed, 10 failed, 13 skipped** across 33 suites. All 10 failures are on the known list: member-invitation-delivery W1–W9
(`dto.objects is not iterable`) and the 91-day refresh-token cleanup case. These suites now pass: workspace-provisioning 6/6,
worker-module-boot 1/1, outbox-retention-replay 12/12 and login-handoff-cleanup 5/5.
