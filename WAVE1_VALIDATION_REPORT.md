# Wave 1: integration and validation

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`, HEAD `edac8210` (the 14 earlier local commits plus one
test fix). Nothing was pushed or deployed to production. Neon, OpenShip and every remote system were left alone. The
owner's account `issac@gmail.com` was not touched: no login attempt, password change or session change.
**Evidence:** `docs/evidence/wave1-validation/` (git-ignored, like all of `docs/`).

**Verdict: PASS.** Wave 1 introduced one test failure. It was a stale assertion, now fixed. No product-code regression was
found. Every remaining failure was already on the known list before wave 1.

## 1. The `application-access` regression

**Symptom.** In `application-access.integration.spec.ts`, the case "keeps the existing ten-failure account limiter and
reports Retry-After" expected attempt 11 to return 429 with Retry-After 900. It got 401. I reproduced this on the fresh
test DB (`regression/01-application-access-before.log`).

**Root cause.**
- The case encoded the old per-EMAIL hard lock: 10 failures, then 429 for every source, with a fixed Retry-After of 900. It
  came from `core.auth_count_recent_login_failures`, which ran even under Jest.
- Commit 8243bd4a removed that lock on purpose (D-A1, owner decision "per email + IP, slowing down") and replaced it with
  `LoginAttemptLimiterService`.
- Like the route throttler, the new limiter is skipped under Jest unless `RAB_DISABLE_RATE_LIMIT=false`. With the old lock
  gone and the new limiter off, attempt 11 simply reached the password check and got 401.

**Classification.** The behaviour the test encoded was superseded on purpose. The code did not regress, so no product code
changed.

**Fix (test only, commit `edac8210`).** Only that one case was rewritten. It keeps its security intent: repeated failed
sign-ins against one account are throttled, give a uniform message until then, and report Retry-After. The case now:
- turns on the real limiter for its own requests only, and restores the environment and limiter state afterwards;
- clears the route's separate 5/min/IP throttle before each request, so any 429 can only come from the sign-in limiter;
- asserts that `AUTH_LOGIN_EMAIL_IP_BURST` (5) failures each return 401 "Invalid email or password.";
- asserts that the next attempt returns 429 `LOGIN_RATE_LIMITED`, with a Retry-After between 1 s and the window.

**Checks.**
- application-access, login-attempt-limiter and rate-limiting together: 3 suites, 28/28 passed (`regression/02`).
- Mutation check: I made `admit()` a no-op and the case failed with 401 instead of 429 (`regression/03`). The file was then
  restored from git.

No other failure in the run below traces back to a wave-1 commit.

## 2. Fresh test DB (`crewflow-test-db`, 127.0.0.1:15436)

- **Recreated** with postgres:16-alpine, `--data-checksums`, `max_locks_per_transaction=256` (confirmed), the init scripts
  mounted read-only, and `unless-stopped`.
- **Phase A** ran as `rab_owner`. It stopped at the role split by design, with 128 migrations applied.
- **Phase B** ran as the superuser and exited 0, bringing the total to **196 migrations**.
- The marker `crewflow.disposable_test_database=true` is set.
- **Posture:** matches the golden (1068 lines, 0 workspaces). **RLS coverage:** OK (57 tables).
- Logs: `testdb/`. The logs contain no connection URLs.

## 3. Dev rebuild and redeploy (rab stack only)

**Images.** Server and worker were built one after the other, both exit 0:
- server `01b6b810`
- worker `f5e869b4`

**Restart.** `up -d --no-deps server worker`. Both containers reported healthy. Front, devdb and redis were not touched.

**Runtime database guard** (`redeploy/05`, `06`):
- api: `role=crewflow_app`.
- jobs: `role=crewflow_app`.
- provisioner: `role=crewflow`.
- The bundle logged "live identity probes agree … (jobs=crewflow_app, provisioner=crewflow)" for cluster
  7699569147858477090.

**HWS_RUNTIME_ENABLED=true** in:
- the server;
- the worker container and its jobs child (`07`);
- the provisioner, which logged it at start.

**Logs and health.** No error lines in either log, 40 minutes after the start and after the smoke tests (`10`, `11`).
`/healthz` returns 200.

**rab-devdb:**
- posture matches (1068 lines, 1 workspace matches the template);
- RLS coverage OK (57 tables plus 21 workspace tables);
- 196 migrations.

## 4. Smoke tests (`smoke/`)

The probes ran from a throwaway container on `rab_default`, so they had their own IP. Only synthetic, non-existent emails
were used.

| Check | Result |
|---|---|
| `/healthz` | 200, database up |
| Login with 2 non-existent emails | both 401 "Invalid email or password.", no cookie |
| Limiter | Attempts 1–5: 401. Attempt 6: 429 from the route throttle (Retry-After 60). After 62 s: **429 `LOGIN_RATE_LIMITED`, Retry-After 118**, which is one token every 180 s minus the 62 s waited. A different email from the same IP got 401, so the limiter is per email+IP, not per IP |
| CORS preflight from `https://evil.example` | no `Access-Control-Allow-Origin` (refused) |
| CORS preflight from `http://127.0.0.1:5173` | 204, ACAO echoed, credentials true |

In the first limiter run (`02`), the route throttle fired at attempt 4. Docker had reused an earlier probe container's IP,
so the earlier requests counted. The re-run (`03`) waited out the window first.

## 5. Test runs (sequential, fresh DB)

| Suite | Previous baseline | Now | Failures |
|---|---|---|---|
| rab-shared | 77/77 | **77/77** | none |
| rab-ui | 2/2 | **2/2** | none |
| rab-front | 678/678 | **678/678** | none |
| rab-server unit | 537/540 | **634/637** (49 suites) | `tenant-context.service.spec` ×3, pre-existing |
| rab-server integration | 1495 pass / 8 fail / 61 skip, 123 suites | **1569 / 3 / 61**, 129 suites | `identity-security-table-rls` ×2 and `shift-team` 404-vs-400 ×1, both pre-existing |
| rab-worker (`TEST_DATABASE_CREWFLOW_URL` set) | 424 pass / 10 fail; lane S 426 / 15 | **431 / 10 / 13** | `member-invitation-delivery` W1–W9 and the 91-day token cleanup, both pre-existing |
| rab-mobile `flutter test` | 652 (lane M) | **652/652** | none |
| worker-bundle launcher, inside the new `rab-worker:latest` | 30/30 | **30/30** | none |
| `tsc` typecheck, 7 projects | 6 exit 0, rab-utils TS18003 | the same | rab-utils TS18003, pre-existing |

The integration baseline's lock-exhaustion failures (`containment-suspend` and others) are gone, thanks to the fresh DB and
256 locks.

**`yarn lint`** failed with three entries; none is caused by wave 1:
- `rab-utils` TS18003 (pre-existing).
- `rab:lint`: the root package script is itself `nx run-many -t lint`, so nx runs it recursively and the inner run fails on
  rab-utils (pre-existing tooling).
- `rab-worker:lint` on its first pass. nx flagged it as flaky: it raced `rab-server:build` rewriting `dist`. It passed in
  the inner run, and a standalone `tsc` exits 0 (environment).

## 6. Remaining items (none blocks wave 1)

- **Pre-existing failures:** the ones listed above, already recorded in `CREWFLOW_FOUNDATION_FIXES_REPORT.md`.
- **`yarn lint` recursion:** the root `rab:lint` target re-runs `yarn lint` inside itself. This is worth fixing in tooling.
- **Jest JSON output:** `tests/21-rab-server-integration.json` contains test-fixture JWTs signed with the test `APP_SECRET`.
  They are ephemeral and git-ignored, but do not share that file.
- **Open owner decisions** carried over from the lanes: the limiter thresholds, CAPTCHA or step-up for never-seen addresses
  during a distributed attack, the mobile-workforce revocation exemption, `payroll_record → organisation` CASCADE, and D1–D10.
