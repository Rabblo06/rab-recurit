# M9 load test: 5,000 staff, 50,000 shifts (InstaBox ibox2, 2026-11-21)

Lane F hardening evidence. Code under test: `main` at `85b070bb`. Scripts: `packages/rab-e2e-testing/system/perf/`
(`seed-volume.mjs`, `load-mix.mjs`, `sinks.mjs`, `check-thresholds.mjs`, `explain-replay.mjs`, `stack/*.sh`). The numbers
below are copied from the run results (load JSON, `pg_stat_statements`, `auto_explain`); the test stack and its raw files
were removed from the host afterwards. The restore drill on the same database is in [RESTORE-DRILL.md](RESTORE-DRILL.md).

## Results at a glance

- **Baseline (`main` as is): fails.** The stack collapsed in the first minute of the expected peak (1.0x, about 21
  requests/s): p50 13-20 s in every group, 20-98 % errors, every request queued behind a 10-connection pool held by
  JIT-compiling list queries. The 2x spike could not be measured meaningfully.
- **With three fixes** (two indexes, draft PR #312; JIT off for tenant transactions, proposed diff below; the refresh
  pool-deadlock fix, pending in its own PR; the last two applied on the test host only): the 15-minute peak holds. Staff app reads, clock-in/out, offers, manager writes, the Venue
  Manager app and token refresh meet the targets; clock-in/out p99 is 633 ms (target 800). Still over target at peak:
  manager reads p95 974 ms / p99 2,562 ms and 0.15 % errors (the shift-report list, a search term that matches every
  record, the offer count), payroll reads p95 812 ms / p99 1,454 ms, staff login p99 1,402 ms.
- **2x spike (about 42 requests/s): fails even with the fixes.** The database container hit its 2-CPU limit (the
  production default, `CREWFLOW_POSTGRES_CPUS=2`) after about 30 s and queues grew to the 30 s client timeout. 80 % of
  the database time in that run was four statement families in the attendance, offer and search modules: the
  shift-report list (41 %), the offer list count (18 %), the broad search (12 %) and the attendance list count (9 %)
  (§4.4). Those fixes, or more database CPU, are needed before a 2x day.
- **One security finding** came out of it: concurrent token refreshes can deadlock the API's connection pool (HIGH,
  availability; §4.3; fix pending in its own PR).

### Per endpoint group, peak phase (15 min at 1.0x)

Latency in ms from the scheduled send time; errors = 5xx, network errors and timeouts (target < 0.1 %).

| Endpoint group | Before p50 | p95 | p99 | max | errors | After p50 | p95 | p99 | max | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| staff-read | 14,979 | 29,831 | 41,410 | 50,039 | 1,782 (25.1 %) | 18 | 111 | 527 | 2,249 | 0 |
| clock (check-in / clock-in / clock-out) | 15,094 | 29,908 | 41,407 | 50,978 | 465 (26.7 %) | 22 | 138 | **633** | 2,118 | 0 |
| offer (accept / decline) | 15,328 | 29,987 | 43,320 | 50,039 | 232 (26.2 %) | 35 | 165 | 585 | 2,133 | 0 |
| manager-read | 18,060 | 30,001 | 38,737 | 49,003 | 3,425 (48.1 %) | 52 | **974** | **2,562** | 6,607 | **11 (0.15 %)** |
| manager-write | 18,414 | 29,839 | 41,987 | 46,188 | 227 (46.6 %) | 46 | 196 | 780 | 2,134 | 0 |
| vm-read (Venue Manager app) | 12,963 | 20,731 | 29,722 | 32,854 | 175 (19.7 %) | 44 | 342 | 925 | 2,284 | 0 |
| payroll (reads) | 20,512 | 30,002 | 34,009 | 36,095 | 91 (51.4 %) | 167 | **812** | **1,454** | 3,557 | 0 |
| payroll-run (one run, 7 calls) | 23,151 | 30,000 | 30,000 | 30,000 | 2 of 4 | 879 | 3,083 | 3,083 | 3,083 | 0 |
| login (staff app) | 18,752 | 30,001 | 30,001 | 30,003 | 172 (98.3 %) | 67 | 281 | **1,402** | 4,514 | 0 |
| auth-refresh | 16,412 | 26,664 | 30,001 | 32,119 | 2,973 (92.0 %) | 15 | 74 | 258 | 557 | 0 |

Bold = over target after the fixes. The payroll run (prepare 3.1 s, the pending list 1.1-2.4 s, export 0.7 s) is one
user action once per period, reported for information.

### Per endpoint group, spike phase (3 min at 2.0x)

| Endpoint group | Before p50 | p95 | p99 | errors | After p50 | p95 | p99 | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| staff-read | 10,002 | 19,486 | 30,869 | 243 (8.4 %) | 11,768 | 30,000 | 30,000 | 165 (6.3 %) |
| clock | 13,408 | 30,784 | 36,040 | 54 (8.2 %) | 18,853 | 49,039 | 55,952 | 73 (14.8 %) |
| offer | 15,150 | 29,329 | 32,722 | 17 (4.8 %) | 19,158 | 30,000 | 54,424 | 49 (17.0 %) |
| manager-read | 7,758 | 17,881 | 24,556 | 277 (9.4 %) | 17,577 | 30,000 | 30,000 | 353 (13.6 %) |
| manager-write | 8,046 | 19,107 | 26,035 | 20 (12.0 %) | 16,830 | 30,000 | 30,000 | 12 (6.9 %) |
| vm-read | 5 | 9,020 | 10,359 | 0 | 11,553 | 30,000 | 30,000 | 18 (5.5 %) |
| payroll | 8,722 | 17,134 | 32,209 | 7 (9.3 %) | 17,465 | 30,000 | 30,000 | 5 (7.6 %) |
| login | 15,939 | 25,429 | 30,001 | 69 (94.5 %) | 30,000 | 38,566 | 40,219 | 46 (73.0 %) |
| auth-refresh | 13,143 | 20,633 | 26,362 | 1,979 (74.0 %) | 30,000 | 35,910 | 36,413 | 133 (30.5 %) |

Both runs fail the spike; the baseline's spike numbers are not better, they are the tail of a system that had already
failed (its sessions were mostly dead by then, see the error columns of the peak).

### Resources

| | Baseline, peak | After the fixes, peak | After the fixes, spike |
| --- | --- | --- | --- |
| Database CPU (container, limit 200 %) | 150-200 %, then idle while requests waited for connections | 50-195 % (median about 120 %) | 190-209 % (saturated) |
| Database client connections | 27 (API pool 10, Worker 12, lock / probe clients) | 27 | 27 |
| API process CPU (2 cores) | 10-75 % | 8-20 % | 10-36 % |
| API resident memory | 2.8 GB at the end (requests queued for minutes; production's 1 GiB limit would have killed it) | 0.8 GB | 0.8 GB |
| Requests in flight (client) | up to 800 | 0-9 | up to 785 (744 dropped at the client cap) |

Data during the measured runs: 5,006 staff, 52,762 shifts (baseline) and 70,099 shifts (after: three more live batches
were added by the capture runs), 89,776 payroll records, 90,180 attendance rows. The "after" run therefore had more data,
not less.

## 1. What ran, and how close it is to production

| Piece | Production (`docker-compose.production.yml`) | This test | Difference that matters |
| --- | --- | --- | --- |
| API | `dist/main.js` in the image, `NODE_ENV=production`, 2 CPUs, 1 GiB, pool 10 | the same `dist/main.js` built from `85b070bb` on the host, `NODE_ENV=production`, pinned to 2 cores (`taskset 0,1`), `--max-old-space-size=768`, pool 10 | Not the Alpine image (the host's root disk was full, see §6), Node 24.22.2 instead of 24.22.3 |
| Worker | same image, `worker-start.sh`, 2 CPUs, 1.5 GiB, pool 12, BullMQ schedulers from the API | `dist/main.js` of rab-worker, `NODE_ENV=production`, the production worker environment, pool 12, schedulers registered by `register-schedulers.js` | Shares cores 2-3 with the database and the load generator |
| PostgreSQL | `postgres:16` (16.16), 2 CPUs, 1 GiB, TLS, scram, default config | `postgres:16` (16.16) container, `--cpus 2`, `--memory 1024m`, TLS with `sslmode=verify-full`, scram, default config + `pg_stat_statements` | `pg_stat_statements` loaded for the measurement (`track=top`) |
| Database roles | db-setup creates `crewflow_owner`, the migrate child bootstraps every role, db-harden removes CREATEROLE | exactly that: `bootstrap-owner-login.js`, `twenty-migrate.js` (265 migrations), `bootstrap-owner-login.js --harden` | none: the API and Worker connect as `crewflow_owner` (NOSUPERUSER NOBYPASSRLS, FORCE RLS everywhere it applies) |
| Redis | `redis:7-alpine`, appendonly, noeviction | the same image and flags | none |
| Object store, SMTP | S3 / R2, SMTP or Resend | `sinks.mjs`: a loopback S3-compatible store and an SMTP sink | No network latency to the providers |
| HWS | `HWS_RUNTIME_ENABLED=false` | `false` (business rows in `core`) | none |

The production runtime guards ran and passed (TLS verify-full, owner-login identity, connection budget). They also
refused correctly once: the Worker would not start while the database still carried the `crewflow.disposable_test_database`
marker that the fixture seed needs, so the marker exists only while a seed runs.

## 2. Data and the expected peak

### 2.1 Volume

One organisation, one workspace (the shape of a single large agency), seeded by `seed-volume.mjs` from rows the product
itself wrote (`live/seed-live-e2e.ts`), so every row has the real columns, CHECKs and constraints:

| Table | Rows |
| --- | --- |
| staff profiles (with users, roles, memberships) | 5,006 |
| venues | 21 |
| shifts | 47,256 history and future, plus a live batch per run (bookings and pending offers): 52,762 during the baseline, 70,099 during the final run |
| shift assignments | 101,521 (baseline) |
| job offers | 101,519 (baseline) |
| attendance | 89,802 (baseline), 90,180 (final run) |
| payroll records | 89,776 (approved older than 14 days with their generated statements; the last 14 days pending approval) |
| shift reports (finalised, with final timesheets) | 45,276 (baseline) |
| database size | 314 MiB (baseline), 437 MiB (final run) |

### 2.2 Peak definition

There is no production traffic yet to measure, so the peak is derived from the volume above and stated so it can be
challenged:

- 50,000 shifts a year at about 2 seats each is roughly 270 bookings a day. Hospitality work bunches into an evening
  change-over: assume a busy Friday puts 40 % of a day's bookings into one two-hour window.
- **Staff app reads, 8 requests/s.** A quarter of 5,000 staff open the app in the peak hour (1,250 people), about 1.5
  sessions each, 8 reads per session (home, active attendance, offers, history, statements, notifications): 15,000
  requests in the hour, 4.2/s. Doubled for headroom and polling: 8/s.
- **Attendance, 0.6 flows/s (1.8 writes/s).** Each flow is check-in, clock-in and, two to five minutes later in the
  test, clock-out. The real change-over needs about 0.1 flows/s; 0.6 is six times that, because these are the
  latency-critical writes.
- **Offers, 1/s** staff responses (80 % accept, 20 % decline); **manager scheduling 8 reads/s** (40 managers active at
  once, one request every 5 s: shift lists and the week view, offers, staff, attendance, the dashboard, search, a shift,
  the shift reports) **plus 0.55 writes/s** (create a shift and send offers 0.15/s, confirm accepted offers 0.4/s);
  **Venue Manager app 1 read/s; payroll reads 0.2/s; staff logins 0.2/s;** token refreshes as sessions age.
- **One payroll run** during the peak: prepare the run for the last closed period, read it, export it, then twice list
  50 pending records and bulk-approve them.

That is about 21 requests/s in total at 1.0x. The phases: warm-up 2 min at 0.5x, **peak 15 min at 1.0x**, **spike
3 min at 2.0x** (about 42 requests/s), recovery 2 min at 1.0x. Requests are sent on an open-model schedule (fixed
arrival rate; latency measured from the scheduled send time), so a slow server cannot slow the test down.

## 3. Targets

Per endpoint group, over the peak and spike phases together: p95 < 500 ms, p99 < 1,000 ms, error rate < 0.1 %
(5xx, network errors and timeouts), clock-in/out p99 < 800 ms. A 409 is a business refusal and is reported separately.

## 4. Why the baseline collapsed, and the fixes

Three independent causes, found in this order (statement statistics from `pg_stat_statements`, plans from `auto_explain`
during an unmeasured 0.3x capture run, then each statement replayed idle with its logged parameters as `crewflow_owner`
under the same tenant GUCs: `explain-replay.mjs`; the ten slowest are in §5 and in
[LOAD-TEST-PLANS.md](LOAD-TEST-PLANS.md)).

### 4.1 PostgreSQL JIT compiles the RLS-heavy list queries on every execution (the main cause)

The RLS policies add sub-plans to every table a list query joins, so the planner's cost estimate passes
`jit_above_cost` (100,000), `jit_optimize_above_cost` and `jit_inline_above_cost` (500,000), and PostgreSQL JIT-compiles,
optimises and inlines the expressions of the query each time it runs (compiled code is not cached between executions).
In the capture run JIT was most of the time of the slowest statements:

| Statement | Slowest captured | JIT part of it |
| --- | --- | --- |
| `GET /attendance` page | 11,028 ms | 7,313 ms |
| `GET /payroll/period` | 5,205 ms | 4,991 ms |
| `GET /payroll/runs` summary | 2,582 ms | 2,591 ms |
| payroll record counts per status | 1,989 ms | 1,921 ms |
| selectable staff for a shift | 1,731 ms | 1,431 ms |

With only 2 database CPUs, every compile also slows every other statement, the 10-connection API pool fills with
compiling queries, and from the first minute of the peak every request waited for a connection (`timeout exceeded when
trying to connect`, 8,924 times in the baseline API log). The code base already knows this: search, the staff
attendance history and the staff offer list turn JIT off for their own statement
(`search.service.ts:110`, `attendance.service.ts:1021`, `offer.service.ts:520`). It applies to every RLS list query.

**Applied on the test host only (proposed, not committed: the file is in another lane's open PR #241):** `jit = off` in
the transaction-local GUC binding every tenant transaction already runs, `TenantContextService.bindGucsSql`
(`packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts:105`):

```diff
-    `SELECT set_config('rab.organisation_id', $1, true), ..., set_config('rab.upgrade_scope', '', true), ` +
+    `SELECT set_config('rab.organisation_id', $1, true), ..., set_config('rab.upgrade_scope', '', true), set_config('jit', 'off', true), ` +
```

plus the four expected strings in `tenant-context.service.spec.ts:37-45` (`bindGucsSql` exact-text test). Transaction-local,
so it never leaks to another pooled session; the API and the Worker both bind through it. Alternatives, both owner
decisions: `ALTER ROLE crewflow_owner SET jit = off` (database level, every path; **verified that the semantic-posture
boot gate refuses it** until `security-posture` goldens record `setting|crewflow_owner|*|jit=off`, as it should), or
`-c jit=off` on the bundled `db` service (only the bundled database; the compose parity gate keeps the four db blocks
identical).

### 4.2 Two missing indexes (draft PR #312, owner SQL review)

| Index | Statement | Before (JIT off) | After |
| --- | --- | --- | --- |
| `attendance_workspace_clock_in_idx (workspace_id, clock_in_at DESC, id DESC)` | `GET /attendance` page: every attendance row of the workspace was joined, RLS-checked and sorted to keep 50 | 598 ms | 1.5 ms |
| `email_outbox_attachment_file_idx (attachment_file_id) WHERE attachment_file_id IS NOT NULL` | shift-report list: one outbox probe per finalised report, each a sequential scan (quadratic as the outbox grows; outbox retention is off in production) | 1,085 ms | 462 ms |

Applied on the test host through the migration itself (`twenty-migrate.js` as `crewflow_owner`; both indexes VALID).

### 4.3 The refresh path can deadlock the connection pool (security finding, fix pending in its own PR)

After the first two fixes the peak ran within target for 11 minutes, then collapsed again with the API and the database
both idle while requests waited for database connections. The load generator's staff sessions reach their refresh age
together, and concurrent token refreshes exhausted the API's connection pool. This repository is public, so the exact
reproduction is kept out of this document; the lead has it.

```
[HIGH] (availability; §5.8 has no availability row: ranked by blast radius, every tenant, any staff account)
Failure:      concurrent refresh requests → every API pool connection is held by a refresh transaction that waits for a
              second connection → the whole API (all tenants) returns 500 / times out until the pool's connection
              timeout, repeatedly while the requests keep coming
Actor:        any authenticated staff-app session (no special role). Likely a single refresh token presented about
              pool-size times concurrently is enough: each waiter holds a connection while it waits on the token row's
              FOR UPDATE lock. Throttled to about 5 refreshes per minute per client IP, so one source cannot sustain it
              alone; normal traffic (many phones resuming at a shift change) can also trigger it.
Location:     packages/rab-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts (rotate())
Root cause:   RefreshTokenService.rotate() runs inside the refresh transaction and calls PlatformAdminService
              .isPlatformAdmin(), which opens a NEW transaction on a second pool connection. Same pattern, rarer path:
              AuthService.resetPassword calls isPlatformAdmin() inside runInTenantContext.
Fix:          pending in its own PR (service layer: use the transaction's own manager, isPlatformAdminTx(manager, ...);
              generally, no service called with a `manager` may open its own transaction).
Regression:   an integration test that saturates a small pool with concurrent refreshes and expects every one to
              succeed, plus a unit test that rotate() never opens a second transaction.
```

The "after" numbers in this document were measured with that fix applied on the test host only.

### 4.4 Proposed for the busy modules (written diffs, not applied)

- **Shift-report list (attendance module), 462 ms per page after the index.** `REPORT_ROWS_SQL`
  (`shift-report.service.ts:615`) aggregates every shift of the caller's scope (67,596 shifts, 119,346 joined rows, a
  22 MB on-disk sort at the default `work_mem`) before the bucket filter and the page. The bucket depends on e-mail
  delivery, so it cannot be pushed into an index today. Proposal: persist the delivery outcome on the report
  (`shift_report.delivered_at`, written where the final timesheet e-mail is marked SENT; a migration, owner review), then
  filter `bucket=history` by `ends_at` / `delivered_at` and page the shift ids first, aggregating only the page:

  ```diff
   WITH base AS (
     SELECT s.id AS shift_id, ...
     FROM shift s
  +  JOIN (SELECT s2.id FROM shift s2 LEFT JOIN shift_report r2 ON r2.shift_id = s2.id
  +        WHERE s2.organisation_id = $1 AND <scope> AND <bucket predicate on s2.ends_at / r2.delivered_at>
  +        ORDER BY <bucket order> LIMIT $take OFFSET $skip) page ON page.id = s.id
     ...
  ```

  The window `count(*) OVER ()` total then needs its own `count(*)` over the same predicate.
- **Global search with a term that matches everything (search module), 1.1-1.2 s.** In the synthetic data every user is
  "Perf Staff n", so `perf` matches all 5,000 staff and all 119,581 offers, and `WITH cand` ranks them all to return 20.
  A real name is selective (the default mix now searches `PF-<n>` and `Perf Venue <n>`; the measured runs kept the broad
  terms of the baseline so they compare); the broad case is bounded by the service's own 5 s statement timeout, which
  then surfaces as a 500 (`Unhandled exception`, the 11 manager-read errors of the final peak). Proposals: cap the
  candidate set per entity before ranking, and answer a search statement timeout with a 4xx "narrow your search"
  instead of a 500.
- **Offer list count (offer module), 250 ms; attendance list count (attendance module), 120 ms.** Each page of
  `GET /offers` and `GET /attendance` also counts every visible row through a 6-7 table join (119,581 offers, 90,180
  attendance rows); with the page itself now fast, the count is most of the request and, run on every page, 27 % of
  the database time in the final run. Not changed: the joins carry the joined tables' RLS, so a cheaper count is not
  provably the same set. Proposal: return the total only on the first page (or `hasMore` from `LIMIT n + 1`), which
  the console's table footer can show as "50 of many" (a product decision).

The metadata engine (`engine/metadata/**`, `core.metadata_*`) did not appear among the slow statements; nothing there was
touched.

## 5. The ten slowest statements

Captured during the 0.3x capture run, then replayed idle (median of 3) as `crewflow_owner` with the logged parameters.
Plans (EXPLAIN (ANALYZE, BUFFERS), node lines) are in [LOAD-TEST-PLANS.md](LOAD-TEST-PLANS.md).

| # | Statement (service) | Calls | Slowest captured (ms) | of which JIT | Replay JIT on | Replay JIT off | JIT off + indexes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | attendance list page (`AttendanceService.list`) | 54 | 11,028 | 7,313 | 1,982 | 598 | 1.7 |
| Q2 | shift-report list, current (`ShiftReportService.listReports`) | 28 | 7,352 | 3,014 | 1,310 | 1,085 | 462 |
| Q3 | shift-report list, history | 18 | 5,811 | 3,562 | 1,310 | 1,121 | 486 |
| Q4 | payroll month (`PayrollService.period`) | 5 | 5,205 | 4,991 | 1,694 | 139 | 225 |
| Q5 | offer search candidates, broad term (`SearchService`) | 15 | 4,712 | 0 | 1,208 | 1,139 | 1,236 |
| Q6 | payroll runs summary (`PayrollRunService`) | 6 | 2,582 | 2,591 | 1,315 | 4.3 | 4.5 |
| Q7 | offer list count (`OfferService.list`) | 46 | 2,379 | 327 | 272 | 256 | 249 |
| Q8 | payroll record counts per status (`PayrollService.list`) | 3 | 1,989 | 1,921 | 846 | 27 | 32 |
| Q9 | selectable staff for a shift (`SchedulingService`) | 12 | 1,731 | 1,431 | 793 | 192 | 176 |
| Q10 | shift-report list, Venue Manager scope | 9 | 1,172 | 136 | 175 | 155 | 128 |

The replay "JIT off + indexes" column for Q4 and Q5 is within run-to-run noise of the JIT-off column (neither uses the new
indexes).

## 6. Limits of this evidence

- **One 4-vCPU, 8 GiB host for everything.** The API had 2 cores of its own; the database container (2 CPUs), the Worker
  and the load generator shared the other two. The absolute numbers are therefore pessimistic for the database and the
  Worker and say nothing about horizontal scaling. The host's root disk was 100 % full (117 leaked anonymous Docker
  volumes from earlier runs, not created by this lane and not removed by it), which is why the images were not built
  there: BuildKit keeps its metadata on the root disk. The same `dist/` was run directly instead.
- **The synthetic data is uniform:** one organisation, one workspace, one job role, names that all share "Perf Staff".
  Real selectivity (search, venue scopes) is better than here; organisation-level fan-out is not exercised.
- **Sessions refresh together:** all staff sessions were created during the 40 s preparation, so their first refreshes
  arrive together about 11 minutes in. That is harsher than steady state, and it is what exposed §4.3; it was kept
  identical in every run so the runs compare.
- **Not covered:** the web console's own rendering, WebSockets / realtime (off in production), push (off), mobile network
  latency, a second API instance, PgBouncer (not part of the deployment).
- **The test host's API ran fixes that are not on `main`:** the index migration (#312), the proposed diff in §4.1 and the
  pending fix of §4.3. The "after" numbers hold only once all three land.

## 7. Reproduce

On a disposable host (never production, never a shared database), with the checkout at `/data/crewtest-lanef/rab`:

```bash
bash stack/setup.sh                      # yarn install, build shared/emails/ui, rab-server, rab-worker
bash stack/db-up.sh && bash stack/tls.sh # crewtest-lanef-pg (postgres:16, TLS) + crewtest-lanef-redis
bash stack/rebuild.sh                    # owner-login install, fixture seed, 5,000 staff / 47,250 shifts
bash stack/run-load.sh before            # live batch, API + Worker + sinks, pg_stat_statements, load-mix
bash stack/explain-capture.sh explain    # auto_explain for one 0.3x run, settings reset afterwards
node explain-replay.mjs <auto-explain.log> <out.json> --top 10 --jit both
node check-thresholds.mjs results/<label>/load.json
```

CI runs a two-minute smoke of the same mix on every server change (`.github/workflows/ci-perf-smoke.yaml`, not a required
gate): 300 staff, 3,000 shifts, development mode, failing only on 5xx / refused flows or a p95 above 1.5 s.
