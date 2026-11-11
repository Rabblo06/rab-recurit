# Phase D deployment runbook — Worker identity and global dispatch claims

> **OUTDATED for deploying (2026-11-11).** This runbook predates the owner login and the one-image release. Production now
> deploys exactly like Twenty: **Deploy the API and Worker together, from the same image tag, with `docker compose pull &&
> docker compose up -d`. The API starts first and migrates; the Worker starts when the API is healthy. Never update the
> API alone while an older Worker keeps running. Take a provider snapshot/restore point before each production deploy.**
> Rollback: `CREWFLOW_IMAGE_TAG=<previous digest>`, then the same command. Any step below that deploys or restarts the
> API or the Worker on its own is superseded; follow `release/OWNER-LOGIN-DEPLOYMENT.md` section 3.

Status: prepared 2026-11-01. Nothing in this document has been run against staging or production. All evidence quoted
below comes from disposable rehearsal databases and stacks (2026-11-01); the detailed evidence lives in internal reports
that are not in the repository.

## 1. Scope, audience and approvals

**What Phase D changes.** The Worker gets its own restricted database login, `crewflow_worker`, which alone may execute
the global claim / release functions. Four migrations add a dispatch-pointer table (`core.worker_dispatch_pointer`) and
triggers on the email, push, realtime and payroll-statement outboxes. A Worker in **global** claim mode reads those
pointers instead of scanning every organisation and workspace on every tick. The default **per_scope** mode keeps
scanning, exactly as before.

**Audience.** The database operator (holds the cluster's administrative login) and the release owner (approves and
supervises each step). Neither the API nor the Worker ever receives a privileged, owner, superuser or BYPASSRLS
credential at any point in this procedure.

**Approval rule.** Nothing here runs automatically.

- Every step, in every environment, needs its own owner approval. Approving one step, or one environment, never
  extends to the next.
- Order of environments: disposable rehearsal (done, 2026-11-01) → **staging** → **production**, with the same steps in
  each.
- Staging must repeat the migration rollback, image rollback and global-mode rollback (§8) before production is
  scheduled.

**Terms used.**

| Term | Meaning |
|---|---|
| per_scope | `WORKER_CLAIM_MODE=per_scope`. The Worker scans every outbox and workspace directly; it never reads pointers. Today's behaviour. |
| global | `WORKER_CLAIM_MODE=global`. The Worker claims work through the pointer table using functions only `crewflow_worker` may execute. |
| poll / event | `WORKER_DISPATCH_MODE`. What wakes a global claim: the loop's own interval (poll), or a LISTEN/NOTIFY hint plus a backstop (event). |
| reconcile interval | `WORKER_DISPATCH_RECONCILE_SECONDS`, 60–900 s, default 900. In global mode the legacy per-scope sweep still runs this often. |
| jobs-only | The Worker bundle started with `CREWFLOW_PROVISIONER_ENABLED=false`: only the jobs child runs, no workspace provisioner. |

## 2. Safe defaults (must stay unless separately approved)

| Variable | Default | Notes |
|---|---|---|
| `WORKER_CLAIM_MODE` | `per_scope` | `global` is the controlled activation in §5. **Production refuses `global` at env validation** (Phase X SJ-05, owner decision 2026-11-11) until the J3 benchmark and the owner's J5 decision; that decision is recorded by flipping `WORKER_GLOBAL_CLAIMS_PRODUCTION_APPROVED` in `env.validation.ts` in a reviewed change (never an environment variable). Staging also runs `NODE_ENV=production`, so the §5.2 staging rehearsal needs that change first; it then applies to staging and production together. The compose gate refuses the name as before. |
| `WORKER_DISPATCH_MODE` | `poll` | `event` requires `global` (boot refuses otherwise) and is a separate approval (§5.4). Production refuses `event` at env validation too (SJ-05). |
| `REALTIME_ENABLED` | `false` | Enabling it in production is a separate decision. |
| `PUSH_ENABLED` | `false` | Enabling it in production is a separate decision. Owner rule (2026-11-06) for that day: push's immediate send is `WORKER_FAST_PUBLISH_NOTIFY` (already `true`), and `WORKER_PUSH_DISPATCH_INTERVAL_SECONDS` goes to 30 s on the API and the Worker (`docs/release/OWNER-LOGIN-DEPLOYMENT.md`, "Notification delivery"). |
| `WORKER_FAST_PUBLISH_NOTIFY` | `false` | **Production: `true`** on rab-api and rab-worker (owner decision 2026-11-06), committed in the compose files. |
| `WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS` | `2` | **Production: `30`** on rab-api and rab-worker (owner decision 2026-11-06), committed in the compose files. The API registers the scheduler with its own value. |
| `WORKER_TIMER_TRIGGERS` | `off` | **Production: `on`** on rab-api and rab-worker (owner decision 2026-11-06), committed in the compose files. Evidence: the D-Q4b shadow run on main 85332cc6 (336 decisions, 0 wrong / early / missed for all four kinds). No-show and late clock-in touch attendance and payroll: decided explicitly by the owner (THREAT-MODEL). |
| `WORKER_TIMER_TRIGGER_KINDS` | unset (= all four) | **Production: `offer-expiry,manager-confirmation,no-show,late-clock-in`**, listed explicitly on both services, so a kind added to the code later is never switched on by an unset list (the gate test fails until the list is decided again). |
| `WORKER_OFFER_EXPIRY_INTERVAL_SECONDS` | `60` | **Production: `300`** (bounds 10–300) on both services: the scan is the safety sweep behind the trigger. A lost trigger is caught within 5 min; staff also get a lazy expiry when they touch the offer. |
| `WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS` | `60` | **Production: `120`** (bounds 10–300) on both services. A standard withdrawal is due at start − 30 min, so a lost trigger costs at most 2 min of that notice. |
| `WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS` | `120` | **Production: `300`** (bounds 30–600) on both services. Even a lost trigger lands the late flag before the 30-minute no-show. |
| `WORKER_SHIFT_MONITOR_INTERVAL_SECONDS` | `300` | **Unchanged** (owner decision 2026-11-06): it also sends the clock-in reminders and arms the no-show / late clock-in triggers (horizon two intervals). Not committed; the gate refuses any other value in the compose files and env files. |
| `WORKER_SHIFT_SCAN_MODE` | `separate` | **Production: `separate`** (unset). The D-Q4a combined scan stays off (owner decision 2026-11-06) until it is measured; the gate refuses `combined` in the compose files and env files. |
| `WORKER_INVITE_AUTO_DELETE_ENABLED` | `false` | **Production refuses to boot with `true`** until the owner approves a retention policy (enforced in `packages/rab-server/src/engine/core-modules/environment/env.validation.ts`). |
| `WORKER_DISPATCH_RECONCILE_SECONDS` | `900` | Boot refuses values outside 60–900. A longer interval needs evidence and a separate approval. |

Defaults are defined in `packages/rab-server/src/engine/core-modules/environment/environment-variables.ts`. The
production compose files (`packages/rab-docker/docker-compose.image.yml` and `docker-compose.production.yml`) set none of
the claim and wake-up variables above, so the code defaults apply. They commit the two notification-delivery values
(fast publish on, the email sweep at 30 s) and the Phase D switches (timer triggers on for all four kinds; the offer-expiry,
manager-confirmation and late-clock-in sweeps at 300 / 120 / 300 s), each with the same value on rab-api and rab-worker:
the API registers every BullMQ scheduler with its own value and the consume-only Worker checks only that each scheduler
exists, never its interval. `scripts/compose-owner-login.cjs` and `staging/verify-image-compose.cjs` enforce all of them,
and `runtime.env` / `database.env` may not re-enter them. They do not set `WORKER_SCHEDULER`: production runs `bullmq` by
default (O3).

O1 (one image): the Worker bundle launcher that used to pre-check these is retired; the Worker runs
`node packages/rab-worker/dist/main.js` directly. The Worker's own start-up refuses `WORKER_DISPATCH_MODE=event` without
`WORKER_CLAIM_MODE=global` (`packages/rab-worker/src/core/wake/dispatch-wiring.ts`), and its environment validation and
live boot gate (database login included) remain the authority.

## 3. Creating the `crewflow_worker` login (operator step, not a migration)

### 3.1 Who and what

- **Who:** the database operator, as a **superuser** (for example the bootstrap identity). Never one of the
  application's own logins.
  - **A non-superuser `CREATEROLE` login cannot create a passing role on its own.** PostgreSQL 16 automatically makes
    the creating login a member of the new role (`admin=true, inherit=false, set=false`, granted by the bootstrap
    superuser), and that login cannot revoke the membership itself (verified on 16.15). The shape check below then finds
    one member, and migration 1786721300000 refuses to run (fail-closed).
  - If the role is created by a `CREATEROLE` login (it also needs ADMIN OPTION on `crewflow_app` to grant it), a
    **superuser must then run** `REVOKE crewflow_worker FROM <that login>;` before the shape check.
  - On a managed platform without any superuser, neither path is available. Accepting exactly that creator membership
    in the shape check is a separate, security-reviewed owner decision (§11); never loosen the check ad hoc.
- **Approval:** separate owner approval per environment.
- **Required shape:**

| Property | Required value |
|---|---|
| LOGIN | yes |
| SUPERUSER / BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION | none |
| INHERIT | yes |
| Membership | member of `crewflow_app` only, `WITH INHERIT TRUE, SET FALSE`, no ADMIN OPTION |
| Members of `crewflow_worker` | none |
| Objects owned | none |

`crewflow_worker` inherits `crewflow_app`'s CONNECT/USAGE, so no database-level grant is needed unless the environment
has revoked CONNECT from `crewflow_app` itself. Migration 1786721300000 (`WorkerDispatchPointer`) refuses to run until
this role exists with exactly this shape. It never creates or alters the role.

### 3.2 Password

- Generate at least 32 random bytes on the operator's machine.
- Store the password **only in the secret store**, as the Worker's `PG_DATABASE_URL`: the same host, database and TLS
  parameters as the API's URL, with user `crewflow_worker`, at the direct (non-pooler) host.
- Never paste it into a ticket, chat, log, terminal history or repository.

### 3.3 Creation and shape check

```sql
-- psql as the operator; the password is read from a prompt (\prompt pw), never typed into history.
CREATE ROLE crewflow_worker LOGIN PASSWORD :'pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
GRANT crewflow_app TO crewflow_worker WITH INHERIT TRUE, SET FALSE;   -- no ADMIN OPTION

-- Verify the reviewed shape.
-- Expected: t f f f f f t | crewflow_app:inherit=true:set=false:admin=false | 0 | 0
SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
       (SELECT string_agg(g.rolname || ':inherit=' || m.inherit_option || ':set=' || m.set_option || ':admin=' || m.admin_option, ',')
          FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
       (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid) AS members,
       (SELECT count(*) FROM pg_shdepend d WHERE d.refobjid = r.oid AND d.deptype = 'o') AS owns
  FROM pg_roles r WHERE r.rolname = 'crewflow_worker';
```

Also run the worker-role checks of `tools/check-rls-coverage.ts`, and confirm that no other new privilege appeared.

### 3.4 Connection and TLS verification

This is done later, when the Worker first starts with the new secret (§5.1). The Worker's boot log prints the live role
(the `assert-runtime-db-role` line) and the deployment-identity line. In addition, from a session using the new
credential:

```sql
SELECT current_user, ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid();
```

It must show `crewflow_worker`, `ssl = t`, and the TLS version the environment requires (`sslmode=verify-full`).

### 3.5 Rotation

`ALTER ROLE crewflow_worker PASSWORD :'new'` (from a prompt), then update the secret, then a rolling restart of the
Worker replicas. Established connections stay authenticated; new ones need the new password. Rotate after any
suspected exposure.

### 3.6 Rollback of the role itself

- **Before the migrations are applied:** `DROP ROLE crewflow_worker`, provided no process uses it (it owns nothing).
- **After the migrations are applied:** migration 1786721300000 grants the role EXECUTE, so the role can be retired only
  after that migration's `down()` (§8.4): `REVOKE crewflow_app FROM crewflow_worker; DROP ROLE crewflow_worker;`.
- Moving the Worker back to `crewflow_app` without dropping the role is the credential rollback in §8.2.

## 4. Applying the Phase D migrations

### 4.1 What is applied

| Order | Migration | Purpose |
|---|---|---|
| 1 | 1786721300000 `WorkerDispatchPointer` | Pointer table (ENABLE + FORCE RLS, owner-only policy plus a restrictive deny for every login) and the claim / release definers, executable only by `crewflow_worker`. |
| 2 | 1786721310000 `WorkerDispatchPointerOutboxTriggers` | Triggers on the email, push and realtime outboxes. |
| 3 | 1786721320000 `StatementDispatchPointer` | Workspace module v1.019: payroll-statement pointer trigger (core and workspace schemas). |
| 4 | 1786721340000 `AccountInviteCleanupDefiner` | Invite expiry / deletion definers. They are never called while `WORKER_INVITE_AUTO_DELETE_ENABLED=false`. |
| 5 | 1786721350000 `StatementPointerPhysicalIdentity` | Finding F2 fix (§6): pointer identity = (queue, subject id, source schema), copy-scoped trigger writes and deletes, per-row claim token. Core only; v19 fingerprint and posture unchanged. |

All five ship in one release and are applied in this order through the **normal approved migration path**: the
one-off migration service with the migration-only login, and the per-migration production approval. Never with an
application login and never by hand.

**Not part of this rollout: 1786721330000 (`WorkerDueWorkClaimsToWorkerRole`).**

- It is gated. It lives in `packages/rab-server/src/database/typeorm/core/gated-migrations/`, outside the migration
  glob, so the migration runner cannot see it.
- It has never been executed anywhere.
- Its cutover is a separate approval (§11). At that time it gets a new id greater than every applied migration and is
  moved into `core/migrations/`.
- **OBSOLETE under the one-owner-login design (recorded 2026-11-06, owner decision: keep it EXCLUDED).** Its cutover gate
  requires every Worker to authenticate as `crewflow_worker`. Under owner-login the Worker connects as `crewflow_owner`,
  and `crewflow_worker` has zero members and no password
  (`packages/rab-server/src/database/typeorm/scripts/migrate/owner-login/bootstrap.ts`, `legacy-logins.ts`; BC-17), so the gate can
  never hold. The file itself is not edited or moved. Whether to retire it or keep it for a possible return to separated
  logins is a later owner decision; until then it must not be applied anywhere.

### 4.2 Verification after applying

| Check | Expected |
|---|---|
| Migration ledger | Exactly the five migrations above were added; 1786721330000 absent. |
| Workspace fingerprint | Every READY workspace at module 19 matches the v19 value in `packages/rab-server/src/database/typeorm/workspace-schema/v1/expected-fingerprints.ts`: `b2afa389eec7c5fb0a304ace57cb39d813bb5b6ac044be2387d4e67f804655c3`. |
| Security posture | Clean against `packages/rab-server/src/database/typeorm/core/security-posture.golden.txt`. |
| Migration-security harness | The restricted-migrator / migration-security harness re-run on a **production-like rehearsal copy** (not on the live database). Rehearsal result, 2026-11-01: 117 pass, 0 fail, including the RLS coverage gate run as both `crewflow_app` and `crewflow_worker`. |
| No persistent notify setting | `SELECT * FROM pg_db_role_setting WHERE array_to_string(setconfig, ',') LIKE '%crewflow.dispatch_notify%';` returns no rows. |

Every process refuses to boot when `pg_db_role_setting` stores any value of `crewflow.dispatch_notify` (for this or all
databases, for all roles or any role the login belongs to). The security posture check and the CI RLS gate also fail on
such a setting. Remove one with `ALTER ROLE <role> [IN DATABASE <db>] RESET crewflow.dispatch_notify` or
`ALTER DATABASE <db> RESET crewflow.dispatch_notify`.

### 4.3 Deploy compatible API and Worker images straight after the migrations

Deploy the matching API and Worker images **immediately** after the migrations, with **unchanged defaults** (per_scope +
poll). At this point the Worker may still log in as `crewflow_app`; both logins work in per_scope.

Why immediately: the previous release's Worker bundle starts a workspace-provisioner child. That child applies the
provisioner compatibility policy: a migration ledger ahead of the image means refuse (fail-closed by design). It exits,
and the bundle then stops the jobs child too. So an old Worker that restarts between the migrations and the new image
**stops every background queue**: no email, push, realtime or statements. Measured on a disposable rehearsal,
2026-11-01. This is the existing provisioner policy and applies to every release that adds a migration, not only to
Phase D. If an old Worker must run in that window, it can only run jobs-only (§8.3), because its provisioner refuses
the ledger ahead of it. In production, jobs-only needs an explicit owner exception: the committed
`CREWFLOW_PROVISIONER_ENABLED "true"` must not otherwise be overridden, and while the provisioner is off no new
workspace is built.

Verify after the deploy:

- `/health` on the API and the Worker;
- the Worker boot log shows the login, `claimMode=per_scope` and `dispatchMode=poll`;
- email, push (if enabled), realtime (if enabled) and statements still flow;
- a business regression smoke test.

Mixed versions are safe:

- The triggers write pointers whether or not any Worker reads them. A per_scope Worker (old or new) ignores the pointer
  table, and pointers for terminal rows are deleted by the triggers, so the table stays bounded by live outbox work.
- Workspaces still at module 18 stay routable (`MIN_COMPATIBLE_WORKSPACE_MODULE_VERSION = 18`). Their statements are
  found by the per-workspace reconciliation until they reach module 19.

**First cutover.** The pointer table starts empty. Work that was already pending when the triggers were created has no
pointer until its next state change. **No bulk backfill is needed, and none may be applied to production.** Per_scope
never reads pointers, and global mode's first sweep dispatches that work directly (§5.2).

## 5. Global-mode activation

### 5.1 Readiness (Worker still in per_scope)

Switch the Worker's `PG_DATABASE_URL` secret to the `crewflow_worker` URL, keep `WORKER_CLAIM_MODE=per_scope`, restart
the Worker, then check every item:

- [ ] Worker boot log and `pg_stat_activity.usename` show `crewflow_worker`; the TLS check in §3.4 passes.
- [ ] The API still logs in as `crewflow_app`, and refuses `crewflow_worker` (its boot gate).
- [ ] No persistent `crewflow.dispatch_notify` setting (§4.2; the security posture is clean).
- [ ] The connection budget fits. Global poll needs no extra connections. Event mode later adds one listener connection
  per Worker replica.
- [ ] Pointer row counts roughly match live outbox work, with no runaway growth.
- [ ] per_scope still delivers email, push, realtime and statements on the new login.
- [ ] At least one full reconcile interval (≤ 900 s) has passed since the migrations were applied. Recommended: run
  per_scope for at least one full reconcile interval before switching.
- [ ] **HARD BLOCKER (owner decision 2026-11-02):** the bounded, fair follow-up reconciliation for legacy sweeps that
  reach their batch limit ([#24](https://github.com/Rabblo06/rab-recurit/issues/24)) is merged, deployed in this
  environment's Worker image, and verified there (§5.3: a backlog above one batch drains through follow-up sweeps; idle
  SQL unchanged). Until it is, `WORKER_CLAIM_MODE=global` must not be enabled in staging or production, whatever the
  other items show.

Rollback for this step: §8.2.

### 5.2 Activation (global + poll)

With approval, set `WORKER_CLAIM_MODE=global` (leave `WORKER_DISPATCH_MODE=poll`) on the Worker replicas, using a rolling
restart. The API is unchanged in poll mode.

Switching to global is itself the supervised initial reconciliation. On each Worker process's **first** scan tick for
each queue (immediately at start with `WORKER_SCHEDULER=interval`), the legacy per-scope sweep runs. It is the same
bounded, idempotent, tenant-scoped code as per_scope mode, dispatches pre-cutover work directly, and creates no
pointers. It then repeats every reconcile interval. Each pass handles at most one batch per queue and scope:

| Queue | Legacy sweep | Batch per pass |
|---|---|---|
| Email | each organisation | 50 rows |
| Push | each organisation | 50 rows |
| Realtime | each scope: the organisation's core scope and each of its workspaces | 25 rows |
| Statement | each workspace | 200 rows |

**Follow-up sweeps ([#24](https://github.com/Rabblo06/rab-recurit/issues/24)).** When any queue-and-scope batch of a
sweep comes back FULL, more pointerless work may remain, so the Worker runs a follow-up sweep about 5 s later instead of
waiting for the next interval. Follow-ups use the same per-queue loop (never two loops for one queue in a process) and the
same scan slot, metrics and shutdown drain as a wake-up. They are:

- **Bounded:** at most 30 follow-ups per reconcile window, per queue and Worker process, so at most 31 sweeps per window
  and process. Follow-ups do not take the scan's cross-replica lock, so N replicas can run up to N × 31 sweeps per window;
  that is safe (row locks with SKIP LOCKED and the state-machine claims, as in per_scope mode) and only costs load. When
  the budget runs out, the Worker logs `follow-up budget exhausted` and the backlog continues in the next window. Only a
  regular sweep opens a window: if sweeps are so slow that the 31 outlast the 900 s window, the follow-ups still spend the
  old window's budget, and the next regular tick opens the next window (no self-renewing chain). A failed
  sweep, or a failed global claim after it, never stalls the chain: the follow-up is armed after the run's global claim
  either way, and a failed sweep keeps the existing 60 s retry.
- **Push is consumer-paced:** a published push row stays PENDING until the push consumer takes it, so a push sweep asks
  for a follow-up only when its full batch actually moved rows (first publish, stale re-publish or a terminal state). While
  the consumer is behind, push drains at the consumer's pace, never through repeated re-walks.
- **Fair:** every sweep still takes at most one batch from every organisation and scope, so a large backlog in one
  organisation never delays a small one elsewhere.
- **Idle-neutral:** with no full batch nothing extra runs. Measured A/B on the disposable test stack (four queues, 2 s
  poll ticks, 60 s idle, global mode): 244 transactions before and after #24 at 20 organisations; 797 after and 897
  before at 200 organisations (within run-to-run noise; the idle path is unchanged). Global idle SQL stays 97 % below
  per_scope at 200 organisations in both builds (per_scope about 29,700 transactions per minute).

Recovery bound: a queue-and-scope pointerless backlog of up to 31 batches (email 1,550 rows per organisation, realtime
775 per scope, statements 6,200 per workspace; push at the consumer's pace) is reached within one reconcile window,
provided each sweep takes well under about 24 s (31 sweeps plus 30 × 5 s within 900 s). Measured on the disposable test
stack with the production defaults (5 s follow-up spacing, 900 s window, 2 s poll ticks; measurement harness, not a CI
test): 500 pointerless email rows in one organisation drained in 46 s at 20 organisations and in 53 s at 200
organisations (every sweep still walks all 200; about 2,400 transactions and 1.6 s of Worker CPU for the whole drain,
peak RSS 552 MB in the Jest harness). Before #24 the same 200-organisation run moved 50 rows in 61 s and left 450 for
later windows, one sweep of 50 per window (about 2.5 hours for 500). The CI integration test uses 20 ms spacing to prove
the same sweep sequence quickly. The 31-batch bound is the configured limit, not a measurement at production data
volume: re-measure sweep duration on the staging rehearsal (§5.3). A larger backlog drains 31 batches per window. That is a delay, not a loss.

### 5.3 What to watch in the first sweep

- The first legacy sweep completes on each replica (Worker stats in `rab:worker:stats`).
- No pending email / push / realtime / statement row is older than the reconcile interval. Exception: a queue-and-scope
  backlog larger than 31 batches (§5.2), which the Worker reports with `follow-up budget exhausted`. Its rows can be
  older, up to about ceil(backlog / (31 × batch)) intervals. Investigate any older row outside such a drain.
- A backlog above one batch drains through follow-up sweeps about 5 s apart (cycle metrics under
  `<scan>:reconcile`, e.g. `email-dispatch:reconcile`), and sweep duration stays well under 24 s.
- No `dispatch claim-count alert` log lines (any claim with `claim_count > 20`), and `claimsOver20` stays 0.
- Delivery latency stays at about the poll interval (measured p50 / p95 about 1.1 s / 2.0 s).
- Idle SQL and PostgreSQL CPU fall in line with the measured figures.

Then monitor for at least one full business day (§7). Rollback for this step: §8.1.

### 5.4 Event mode (separate, later approval)

Event mode (`WORKER_DISPATCH_MODE=event`) is **not** part of the global activation. It needs its own approval in each
environment, and its prerequisites (OD-2) must be in place first.

- **Where it is set:** on the Worker **and** on the API (with `WORKER_CLAIM_MODE=global` on both, the same pair). The
  API's sessions then carry `crewflow.dispatch_notify=on`, so its outbox writes NOTIFY the Worker. Poll mode emits no
  NOTIFY at all.
- **Durability:** LISTEN/NOTIFY is only a wake-up hint. The outbox rows and pointers stay the truth, and a backstop
  claim runs regardless (`WORKER_DISPATCH_BACKSTOP_SECONDS`, default 30 s).
- **Prerequisite 1, role-level idle-in-transaction timeout.** Operator steps, not a migration; they apply to new
  sessions, so restart the services afterwards:

  ```sql
  ALTER ROLE crewflow        SET idle_in_transaction_session_timeout = '60s';
  ALTER ROLE crewflow_app    SET idle_in_transaction_session_timeout = '60s';
  ALTER ROLE crewflow_worker SET idle_in_transaction_session_timeout = '60s';
  SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('crewflow', 'crewflow_app', 'crewflow_worker');
  ```

  Why: PostgreSQL cannot advance the notification queue past the oldest transaction still open in a listening
  database. An idle-in-transaction session therefore lets the queue fill, and once it is full a NOTIFY makes the
  **producer's COMMIT fail**: a business-write failure. Rollback: `ALTER ROLE … RESET idle_in_transaction_session_timeout`.
- **Prerequisite 2, notification-queue monitoring.** The Worker samples `pg_notification_queue_usage()` in event mode
  (health and metrics). **Alert above 0.1, escalate above 0.5** (0.5 is half of the default 8 GB queue). On escalation:
  find the oldest open transaction with
  `SELECT pid, usename, state, xact_start FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5`,
  terminate it if it is idle in transaction, and if usage keeps rising switch the API and the Worker back to poll.
- **Measured benefit:** realtime delivery about 0.2 s p50 (push and email about 0.25 s), against about 1.1 s in poll
  mode.

## 6. HWS data operations: restriction while any Worker is in global mode

**Rule.** Run an HWS backfill, any privileged core-to-workspace copy, their rollback, and any `TRUNCATE` of
`core.payroll_record` **only while every Worker is in per_scope mode** (§8.1 first, if needed).

**Why (finding F2).**

- The HWS backfill copies `core` rows into the workspace schemas **with the same id**, and `payroll_record` is in the
  copy set (`hws-backfill.service.ts`).
- The statement pointer is keyed on (queue, subject id), and it is deleted by subject id, whichever copy fired.
- So a terminal update or delete of one copy can delete the pointer that the other copy still needs. This happens with a
  stale `core` copy updated by a mixed-version runtime, and in the backfill's own rollback path, which deletes the
  workspace copies by id.
- A `TRUNCATE` of `core.payroll_record` clears every statement pointer, workspace ones included.
- The affected statement then waits for the reconcile sweep, for up to one reconcile interval (≤ 900 s). This is an
  availability effect only, and per_scope mode is unaffected.

**Fix: migration 1786721350000 (`StatementPointerPhysicalIdentity`), owner-approved 2026-11-01.** It ships in the same
release as the other Phase D migrations. The pointer identity becomes the physical source row (queue, subject id,
source schema); every trigger write and delete is scoped to its own copy, and a generated statement retires the same
record's other copies' pointers in the same workspace. Until 1350000 is applied in an environment, the rule above is
mandatory there. Applying it removes existing statement pointers once (their source is unknown); per_scope never reads
them, so apply it before global activation, as the release order already does.

**After 1350000: HWS cutover sweep.** A copy that is due but never routed (for example a frozen `core` copy after a
workspace moved to its schema) keeps its own pointer and is re-claimed every lease. It shows up as OD-1 `claim_count`
alerts (§7), not silently. After switching a workspace to its schema, and after dropping a workspace schema, run as
`rab_secure_owner` (W = the workspace id):

```sql
DELETE FROM core.worker_dispatch_pointer
 WHERE queue = 'statement' AND workspace_id = $1::uuid
   AND source_schema IS DISTINCT FROM 'workspace_' || replace($1::text, '-', '');
```

Do not generate statements for both copies of one record by hand at the same time: the two transactions can deadlock
(PostgreSQL aborts one). The Worker never does this.

## 7. Monitoring

Monitor for **at least one full business day after each change** (global activation, event mode, any rollback), then
move to steady state.

| Signal | Source | Threshold / expectation | On breach |
|---|---|---|---|
| Repeated claims | Worker log `dispatch claim-count alert`; `claimsOver20` in `rab:worker:stats` | Alert on any claim with `claim_count > 20` (`claimsOver20 > 0`). Starvation, excessive SQL or material delivery delay from repeated claims is a release blocker. | Global-mode rollback (§8.1), then investigate. |
| Oldest pending work | Oldest pending email / push / realtime / statement age | Never older than the reconcile interval (≤ 900 s). A queue-and-scope backlog above 31 batches (§5.2, logged as `follow-up budget exhausted`) may take about ceil(backlog / (31 × batch)) intervals; that alone is not a breach. | Outside such a drain: global-mode rollback, then investigate. |
| Delivery failures | `DELIVERY_UNCERTAIN` and failed counts (email, push) | No rise against the pre-change baseline. | Investigate; roll back if caused by the change. |
| Worker restarts | Platform restart count, bundle exit lines | No unexplained restarts. | Investigate; check the boot gate messages. |
| PostgreSQL load | CPU, statements per minute | Should fall after global activation (measured −86 to −95 % idle SQL at 200 organisations). | A rise is a breach: roll back, investigate. |
| Connections per role | `pg_stat_activity` by user | Within the declared connection budget; +1 per Worker replica only in event mode. | Investigate. |
| Notification queue (event mode only) | `pg_notification_queue_usage()` sampled by the Worker | Alert > 0.1, escalate > 0.5. | §5.4 escalation; then `WORKER_DISPATCH_MODE=poll` on the API and the Worker. |

Read-only diagnostic for the pointer table (operator only). It runs as the migration identity, the only member of
`rab_secure_owner`. The API and Worker logins cannot read the table: they are denied by the restrictive policy and hold
no grant.

```sql
BEGIN READ ONLY;
SET LOCAL ROLE rab_secure_owner;
SET LOCAL statement_timeout = '30s';
-- Per-queue health; alert when max_claim_count > 20.
SELECT queue, count(*) AS pointers,
       count(*) FILTER (WHERE due_at <= clock_timestamp()) AS due_now,
       count(*) FILTER (WHERE claim_token IS NOT NULL AND due_at > clock_timestamp()) AS leased_now,
       max(claim_count) AS max_claim_count,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY claim_count) AS p99_claim_count,
       count(*) FILTER (WHERE claim_count > 20) AS over_alert,
       min(due_at) FILTER (WHERE due_at <= clock_timestamp()) AS oldest_due
  FROM core.worker_dispatch_pointer GROUP BY queue ORDER BY queue;
ROLLBACK;
```

Orphan pointers (OD-1, accepted temporarily) can appear only when a pointer outlives its subject without a trigger
firing, for example after a restore with `session_replication_role = replica`, or with a disabled trigger. There is no
API route and no automatic purge for pointers. Further diagnostics and the supervised, two-person, ticket-referenced
cleanup procedure are in the internal operator runbook (not in the repository). Deleting a pointer never changes
business rows; the worst case of a wrong delete is a lost hint, recovered by the reconcile sweep.

## 8. Rollback

There are four distinct rollback types. They are different operations: use the least invasive one that fixes the
problem.

**Order of preference:** §8.1 global-mode rollback → §8.2 Worker credential rollback → §8.3 application-image rollback →
§8.4 database migration rollback.

Each one keeps email, push, realtime and statement processing running where those features are enabled, **provided its
preconditions are met**. A per_scope Worker scans every outbox and workspace directly, so nothing depends on the
pointers while it runs.

### 8.1 Global-mode rollback (`global` → `per_scope`)

| | |
|---|---|
| Preconditions | None beyond approval. If event mode is on, first set `WORKER_DISPATCH_MODE=poll` on the API **and** the Worker. |
| Steps | Set `WORKER_CLAIM_MODE=per_scope` on every Worker replica; rolling restart. |
| What keeps processing | Everything. per_scope scans outboxes and workspaces directly. In-flight global claims expire with their leases (15 s realtime, 30 s email/push), and the rows are claimed by their own state machines, so nothing is lost or double-completed. The triggers keep pointers current for a later re-activation. |
| Data change | None. |
| Risk | Low and fast: about the time of a rolling deploy. Verified on the disposable performance stack (global → per_scope and event → poll). |
| D-Q5a | per_scope includes the D-Q5a realtime reclaim cap (a reclaim after claimant death counts toward `max_attempts`), so switching to per_scope does **not** restore the pre-Phase-D realtime claim; undoing D-Q5a is an image rollback (§8.3). Re-take any per_scope realtime baseline recorded before D-Q5a. |

### 8.2 Worker credential rollback (`crewflow_worker` → `crewflow_app`)

| | |
|---|---|
| Preconditions | **Allowed only in per_scope mode.** Global mode refuses any login but `crewflow_worker`, so do §8.1 first if global is on. 1786721330000 must not have been applied (it is not part of this rollout; if it ever is, it must be reverted first). |
| Steps | Point the Worker's `PG_DATABASE_URL` secret back at the `crewflow_app` URL; restart the Worker. The API is unaffected. Drop the role only later, as in §3.6. |
| What keeps processing | Everything. per_scope behaves identically on either login; storage cleanup runs on both. |
| Risk | Low: a secret change and a restart. |

### 8.3 Application-image rollback (previous API / Worker images; schema stays migrated)

**The Worker image is effectively forward-only after this release.** Owner decision (2026-11-01): this is the accepted
production release posture. In production, roll back by switching global mode off (§8.1), by switching the Worker
credential back (§8.2), or by a forward fix. Running a previous Worker image jobs-only is a separate, explicit owner
exception.

- The previous Worker's provisioner refuses two things: a migration ledger ahead of its code, and any READY workspace
  above its module version (fleet check: "READY workspace(s) are above this code's module").
- Once 1786721320000 is applied to an environment with READY workspaces, those workspaces are at module 19. In the
  disposable rehearsal (2026-11-01), 4 of 4 READY workspaces were at module 19 after the migration, and the previous
  Worker with its provisioner on exited ("provisioner exited unexpectedly … failing the whole service").
- A database migration rollback (§8.4) does **not** change this. 1786721320000's `down()` deliberately leaves workspaces
  at module 19.
- So the previous Worker image can run **only jobs-only**, before or after any migration rollback.

**In production, jobs-only is an owner exception.**

- The committed `CREWFLOW_PROVISIONER_ENABLED "true"` must not be overridden without an explicit owner exception.
- Server-path provisioning (1786719500000) is not approved for production, so the provisioner child is the only path
  that builds workspaces there.
- For as long as jobs-only lasts, **workspace provisioning is suspended**: new workspaces stay CREATING.

**Preferred production responses:** global-mode rollback (§8.1), Worker credential rollback (§8.2), or a forward fix.
Use this image rollback only with the owner exception, and keep it as short as possible.

| | |
|---|---|
| Preconditions | In production, the explicit owner exception described above. The previous Worker bundle must run **jobs-only**: `CREWFLOW_PROVISIONER_ENABLED=false` **and** `CREWFLOW_PROVISIONER_DATABASE_URL` removed (the launcher refuses to start while the URL is present with the provisioner disabled). Run as configured, the previous provisioner refuses, and the bundle stops the jobs child with it, which stops every background queue. The previous Worker is per_scope and does not know `crewflow_worker`, so revert the Worker secret (§8.2) together with the image. If global mode is on, do §8.1 first. |
| Steps | Deploy the previous API and Worker images, with the Worker in jobs-only mode and the `crewflow_app` secret. Jobs-only lasts for the whole time the previous Worker image runs. It ends only by redeploying the Phase D Worker image (or a later compatible one) on the still-migrated schema. A migration rollback does not end it: after the `down()`s the Phase D images refuse to start (pending migrations) and the previous provisioner still refuses module-19 workspaces. |
| What keeps processing | Measured on a disposable rehearsal (2026-11-01, previous release's images over the Phase D database): the previous API boots with a "ledger ahead" warning and works. The jobs-only Worker is healthy. Email, statements and the realtime outbox were verified by the system specs: 23 passed, 1 skipped, 1 failed. The one failure is the "a provisioning cycle resumes" check, which cannot hold without a provisioner. Push uses the same per_scope path and was verified with push enabled on the performance stack, but was not separately exercised in the image-rollback run. |
| Provisioning | Background provisioning cycles pause while jobs-only. In the rehearsal, new workspaces were still created through the API's server path, but that path does not exist in production (server-path provisioning is not approved there). **In production, new workspaces stay CREATING for the whole duration of the rollback**, until the Phase D Worker image, with its provisioner, runs again. |
| Risk | The redeploy itself is low risk. In production it suspends workspace provisioning for its duration, and it cannot be ended by rolling the schema back. The triggers keep writing pointers, so the write cost continues while nothing reads them (§9 still applies). |

### 8.4 Database migration rollback (`down()` of 1786721350000 → 1786721340000 → 1786721320000 → 1786721310000 → 1786721300000)

**Not instantaneous and not risk-free.** Use it only if the release is abandoned or the trigger cost must be removed.

A migration rollback removes the trigger write cost. It does **not** make the previous Worker image deployable again:
workspaces stay at module 19, and the previous provisioner refuses any READY workspace above its module (§8.3). The
Phase D images cannot run either: the API and Worker refuse to start while migrations they know are pending, and after
the `down()`s the five Phase D migrations are pending to them. So after a migration rollback the only runnable
combination is **the previous API image plus the previous Worker image in jobs-only mode** (the §8.3 owner exception; in
production, workspace provisioning stays suspended) until the migrations are re-applied in an approved release. Treat a
migration rollback as a last resort.

| | |
|---|---|
| Preconditions | Its own approval and a planned maintenance window. Every Worker in per_scope (§8.1), because the claim functions disappear. No global-mode or event-mode process running. An operator identity that can `SET ROLE rab_secure_owner` (or the bootstrap superuser). A verified backup. A staging rehearsal on a **production-sized** copy. The previous API image and the previous Worker image in jobs-only mode ready, with the §8.3 owner exception approved (the Phase D images refuse pending migrations after the `down()`s). |
| Steps | Run the five `down()`s in reverse order (1350000 first: it restores the approved statement body before 1320000 makes it inert) through the approved migration path. Then verify the ledger, the security posture against the previous release's golden file, and that pending outbox rows and payroll records are intact. |
| What it does | Drops the pointer table, the outbox triggers and the Phase D definers; pointer data is discarded (acceptable, because the rows are the truth). 1786721320000's `down()` restores the previous `provision_workspace` body and **leaves the statement trigger function in place with an inert body (`RETURN NULL`)**. Its triggers stay attached in `core` and in every workspace that reached module 19, because workspaces keep module 19 (append-only ledger). This residue is by approved design. |
| Locking | DROP TRIGGER and DROP TABLE take **ACCESS EXCLUSIVE** locks on the outbox tables, so writes to them wait while each statement runs. On a disposable database the four original `down()`s took 32–60 ms and 1350000's took about 1 s (it rebuilds the pointer primary key, ACCESS EXCLUSIVE on the pointer table only); the duration on production-sized data has not been measured and must be measured on the staging rehearsal. |
| Partial failure | Stops inside the failed migration's transaction; the earlier `down()`s stay applied. Re-run, or re-apply forward. |
| What keeps processing | Pending outbox rows and payroll records are untouched (tested), and per_scope Workers keep processing throughout. The account-invite cleanup returns to its pre-Phase-D no-op; deletion was never enabled. |
| Evidence | **Tested only on disposable databases.** A live round trip of all five migrations on a disposable database passed 19/19 checks (2026-11-01, with 1350000). The posture returned to the previous golden file except the documented inert-trigger residue. A pending email and a module-19 workspace survived. Re-applying returned the exact golden posture and fingerprint, and a second module-19 workspace built. Not yet rehearsed on a production-sized copy. |
| Risk | Not instantaneous and not risk-free: writes to the outbox tables wait during the drops, the previous Worker image stays undeployable with its provisioner on, and re-applying later is another approved migration release. |

## 9. The 14-day maximum

**14 days is the absolute maximum** between applying the Phase D migrations to an environment and activating global
claiming there, unless a separately approved exception is documented (owner decision, 2026-11-01).

- It is a **ceiling, not a waiting period.**
- Why it exists: the triggers fire, and cost write time, in every Worker mode from the moment 1786721310000 and
  1786721320000 are applied. The benefit only appears in global mode. Measured on bare inserts at saturation: −9 to −13 %
  throughput on email / notification / realtime inserts, about 0 % on payroll approval, about +0.3 to +0.65 ms commit
  latency per transaction, no lock waits, no deadlocks. Measured benefit at 200 organisations in global mode: 86 to 95 %
  less idle SQL, and PostgreSQL CPU down from 71.6 % to 4.7 % of a core (realtime and push on). The owner accepted the
  write cost unchanged (Option A) on the condition that no environment stays indefinitely on the migrated schema in
  per_scope mode.
- **F2 (1786721350000) re-measurement: provisional.** Re-measured on the shared development host: email −5.2 %, payroll
  about 0 %, notification −3.6 % / −15.9 % across two runs (paired median −11.5 % / −12.2 %), with run-to-run noise
  (TPS cv up to 28 %) larger than the effect. The deterministic counters match the accepted gate (pointer writes per
  transaction unchanged; pointer index blocks per transaction about +3 %, from the wider key). Accepted provisionally for
  PR review only. **Before any deployment, repeat the write-cost benchmark on an uncontended staging rehearsal host**
  and compare it with the accepted envelope.
- **Preferred path:** prepare and test the whole coordinated rollout in staging; deploy compatible API and Worker images;
  verify the restricted Worker credential; activate global polling as soon as the readiness checks pass; monitor; only
  then consider event mode, separately.
- **If global activation cannot proceed safely,** use the approved rollback (§8) or a fix-forward plan. Never continue
  indefinitely with the pointer-write cost and no global-claim benefit.
- Global mode is equally **never forced** before its readiness checks pass.

## 10. Delivery semantics and known limitations

Phase D does not change the delivery guarantees. Claims are exclusive and fenced, but delivery is **never
exactly-once**.

| Path | Guarantee | Why |
|---|---|---|
| Email (SMTP) | At-least-once | A timeout or a dropped connection after the SMTP DATA phase is retried and can resend. Confirmed by the 2026-11-06 fault-injection run (config/phase-d-switches PR): a connection dropped after the complete message, and a server that never answers after it, each produced a second, identical email. The D-Q5b paths (a failed SENT write after a confirmed send, a Worker killed mid-send) end `DELIVERY_UNCERTAIN` with one email. |
| Push, provider timeout | At-least-once | Timeouts are retried. |
| Realtime publish | At-least-once | A publish can be repeated; the gateway deduplicates. |
| Push, interrupted call | At-most-once | Recorded as `DELIVERY_UNCERTAIN` and not retried. |

Further limits:

- **Crashed Worker:** its claimed work waits for its lease to expire (15 s realtime, 30 s email/push), then another
  claim picks it up.
- **Missing pointer:** found by the reconcile sweep and its follow-up sweeps within one interval (≤ 900 s) for a
  queue-and-scope pointerless backlog of up to 31 batches (email and push 50 per organisation, realtime 25 per scope,
  statements 200 per workspace; §5.2, [#24](https://github.com/Rabblo06/rab-recurit/issues/24)). A larger backlog drains
  31 batches per interval.
- **Event mode:** a full notification queue fails the producer's COMMIT (§5.4).

**Known limitation: send-time realtime authorisation.** A realtime event is not re-authorised against its recipient at
the moment it is published. The realtime gateway re-checks an open connection's authorisation within 30 s. The owner
chose to document this rather than change it. Re-authorisation at send time is a separate decision (§11).

## 11. Outstanding production approvals

Each item is a separate owner decision. Nothing on this list is approved by this document.

| # | Approval | Staging | Production |
|---|---|---|---|
| 1 | `crewflow_worker` creation (§3) | [ ] | [ ] |
| 2 | Migration release: 1786721300000, 1786721310000, 1786721320000, 1786721340000, 1786721350000 (§4) | [ ] | [ ] |
| 3 | Global-mode activation, `WORKER_CLAIM_MODE=global` with poll (§5.2), within the 14-day maximum (§9). **Blocked until #24 is merged and verified in that environment (§5.1).** | [ ] | [ ] |

**HARD BLOCKER before item 3 in any environment:** [#24](https://github.com/Rabblo06/rab-recurit/issues/24), bounded and
fair follow-up reconciliation when a legacy sweep reaches its batch limit (§5.2). The fix must preserve Phase D's
measured idle-load improvements. Owner decision 2026-11-02: a tracked follow-up, not a blocker for merging #23. The
implementation PR needs its own owner approval to merge; then the §5.1 verification in each environment. Because of §9,
apply the item 2 migrations to an environment only once #24 is merged, so the 14-day clock does not start while
activation is blocked.

Environment-independent decisions:

- [ ] [#24](https://github.com/Rabblo06/rab-recurit/issues/24): legacy-sweep batch-limit follow-up reconciliation,
  merged (owner approval) and verified per environment (§5.1; hard blocker for item 3).
- [ ] #24 sweep duration and drain re-measured at production scale (about 200 organisations) on the staging rehearsal
  (§5.2).

- [ ] Event mode (`WORKER_DISPATCH_MODE=event`), with its OD-2 prerequisites (§5.4).
- [x] 1786721330000 (`WorkerDueWorkClaimsToWorkerRole`) due-work cutover: **decided 2026-11-06: keep EXCLUDED, OBSOLETE under
  owner-login** (§4.1). Its gate (every Worker authenticates as `crewflow_worker`) cannot hold with one owner login.
- [ ] `REALTIME_ENABLED` / `PUSH_ENABLED` in production.
- [ ] Invite auto-delete retention policy (`WORKER_INVITE_AUTO_DELETE_ENABLED`): grace period, eligibility, audit
  wording, rollback and monitoring. Production refuses `true` until then.
- [ ] SMTP post-DATA duplicate policy (§10). Reproduced on 2026-11-06 (fault injection, config/phase-d-switches PR): still open.
- [x] F2 SQL fix: physical pointer identity, migration 1786721350000 (§6), owner-approved 2026-11-01 (option C).
- [ ] Managed PostgreSQL without a superuser: whether the `crewflow_worker` shape check may accept exactly the creating login's automatic membership (`admin=true, inherit=false, set=false`) (§3.1). Security review first.
- [ ] F3: a database-side switch (and in-definer audit) for the invite-cleanup definers. Today the flag and the audit
  live only in the Worker.
- [ ] Send-time realtime recipient re-authorisation (§10).
- [ ] F2 write-cost benchmark repeated on an uncontended staging rehearsal host and within the accepted envelope (§9).
- [ ] Any exception to the 14-day maximum, documented before it is relied on (§9).
- [ ] Any production jobs-only Worker image rollback: an owner exception that suspends workspace provisioning for its
  duration (§8.3).
