# M9 load test: 5,000 staff, 50,000 shifts (InstaBox ibox2, 2026-11-21)

Lane F hardening evidence. Code under test: `main` at `85b070bb`. Scripts: `packages/rab-e2e-testing/system/perf/`
(`seed-volume.mjs`, `load-mix.mjs`, `sinks.mjs`, `check-thresholds.mjs`, `stack/*.sh`). Raw results (JSON, statement
statistics, plans) are kept on the test host under `/data/crewtest-lanef/results/` until the stack is removed; the
numbers below are copied from them.

<!-- RESULTS -->

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
| shifts | 52,762 (47,250 history and future + 2,756 per live batch x 2 batches) |
| shift assignments | 101,521 |
| job offers | 101,519 |
| attendance | 89,802 |
| payroll records | 89,776 (approved older than 14 days with their generated statements; the last 14 days pending approval) |
| shift reports (finalised, with final timesheets) | 45,276 |
| database size | 314 MiB |

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

<!-- DETAIL -->
