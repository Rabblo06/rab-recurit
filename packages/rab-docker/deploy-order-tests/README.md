# Deploy-order real-container tests (test-only)

These tests prove the owner's "deploy exactly like Twenty" decision (2026-11-11) on real containers. They run the
production compose files unchanged, deployed with the documented command:

```bash
docker compose pull && docker compose up -d
```

They check three things:

1. One command updates `rab-api` and `rab-worker` together, from one variable (`CREWFLOW_IMAGE_TAG`, a `sha256:` digest).
2. The API starts first, migrates, registers the job schedulers and becomes healthy. The Worker starts only after that.
3. An old Worker never runs beside a new API. The Worker's `depends_on: rab-api: {condition: service_healthy, restart: true}`
   makes Compose stop it before it replaces the API.

Nothing here is a deployment file.

## Files

| File | What it is |
|---|---|
| `run-deploy-order-tests.cjs` | The driver. One PostgreSQL major per run. |
| `docker-compose.deploy-order.yml` | The infrastructure overlay. Redis data lives on a tmpfs and the API publishes no host port. The app services and the bundled `db` (DB-SETUP) are not changed; the db's data and CA are the project's own named volumes. |
| `docker-compose.deploy-order-owner.yml` | The pass-through scenarios: the db's first start runs the shipped `01-crewflow-owner.sql` (the hand-made crewflow_owner of an R254/R256 deployment), and compose.env holds that crewflow_owner URL as `PG_DATABASE_URL`. PR #125 option 2: only db-setup reads it; the first NEW db-setup gives crewflow_owner the password derived from `APP_SECRET` (after that the hand-made password no longer logs in). |
| `docker-compose.deploy-order-prev.yml` | Only while `CREWFLOW_IMAGE_TAG` is an image older than DB-SETUP: that release's own start-up (image ENTRYPOINT tini, rab-worker `node packages/rab-worker/dist/main.js` under `init: true`) and its `PG_DATABASE_URL: ${PG_DATABASE_URL:-}` on rab-api / rab-worker (option 2 pins `""` there), because the old image has no `worker-start.sh` and reads its runtime login from that variable. A rollback after a NEW start is given the crewflow_owner URL with the derived password (T3 takes it from the documented derive command). |
| `docker-compose.db-setup-logging.yml` | `run-db-setup-tests.cjs` only: the db's command plus worst-case server logging (`log_statement=all`, `log_connections=on`, user and application_name in every line). |
| `docker-compose.deploy-order-t4.yml` | For T4 only: a shorter API health-check window. The Worker's `depends_on` is unchanged. |

## The cases

| Case | What is proven |
|---|---|
| T1 | A fresh deploy of the previous digest. The `rab-api` `health_status: healthy` event comes before the `rab-worker` `start` event. `State.StartedAt` agrees. |
| T2 | A deploy of the new digest with the same command. Both containers are recreated on the same new digest. The old Worker's `die` event comes before the new API's `start` event. The new API applies the new migrations on start. The new Worker sees every scheduler. It runs the new code for a scheduled job: the email dispatch sweep prints `generationsExhausted=` (new in #89) when it claims a probe row. |
| T3 | The documented rollback derive command (`run --rm --no-deps -T -e CREWFLOW_DB_TARGET_FILE=... --entrypoint /sbin/tini rab-api -s -- sh -c 'node .../derive-runtime-url.js 4>&1 1>/dev/null'`) prints one crewflow_owner URL with the derived password (kept in memory only); that URL is the rollback's compose.env value. A rollback with `CREWFLOW_IMAGE_TAG=<previous digest>` and the same command. Both containers go back together, in the same event order. The old API logs `database state AHEAD` and still serves `/healthz`. |
| T4 | The API fails its health check (a wrong `PG_EXPECTED_DATABASE_NAME`, set only in T4's own env file). The command exits non-zero with `dependency failed to start: ... is unhealthy`. `rab-worker` is created but never started (`State.StartedAt` = zero, no `start` event). |

## Running it

The images come from a **local** registry, so each has a real registry digest. Nothing is pushed to Docker Hub.

```bash
docker run -d --name deploy-order-registry -p 127.0.0.1:5055:5000 --tmpfs /var/lib/registry registry@sha256:<digest>
docker tag <previous image> 127.0.0.1:5055/adolphus:prev && docker push 127.0.0.1:5055/adolphus:prev
docker tag <new image>      127.0.0.1:5055/adolphus:new  && docker push 127.0.0.1:5055/adolphus:new

DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_PREV_DIGEST=sha256:<prev> DOT_NEW_DIGEST=sha256:<new> \
DOT_PG_IMAGE=postgres@sha256:<Debian postgres 16, 17 or 18> DOT_REDIS_IMAGE=redis@sha256:<7> [DOT_PREV_PRE_DB_SETUP=1] \
  node packages/rab-docker/deploy-order-tests/run-deploy-order-tests.cjs <16|17|18> <out-dir>
```

On Git Bash for Windows, set `MSYS_NO_PATHCONV=1` for the `docker run` line.

- **Projects and containers.** T1–T3 use project `dot-pg<major>` and T4 uses `dot-pg<major>-t4`. At most five of the run's containers run at once: PostgreSQL, Redis, the API, the Worker and the registry. The driver samples and records the peak.
- **No sink container.** SMTP and S3 point at `.invalid` names, so nothing leaves the host.
- **The database.** Since DB-SETUP (`docker-compose.local-db.yml` retired, D3) it is the production file's bundled `db`. `DOT_PG_IMAGE` is its image (`CREWFLOW_POSTGRES_IMAGE`) and must be a **Debian** postgres image: the db runs as 999:999 with the Debian volume layout, which an alpine image (uid 70) does not fit. Every render needs `PG_DATABASE_PASSWORD`; the drivers generate it.
- **Cleanup.** The driver runs `docker compose down --volumes` on its own two projects only (their own db volumes), never prunes, and never touches another project. Remove the registry yourself with `docker rm -f deploy-order-registry`.
- **Secrets.** They are generated per run under `<out-dir>/secrets`, outside the repository, and reach the containers only through env files. Every captured output is redacted.
- **Output.** `<out-dir>/RESULTS.json`, `SUMMARY.md`, `run.log` and `evidence/`, which holds the event timelines, deploy output and container logs.

## Upgrade with data (Phase X U-1b)

`run-upgrade-with-data-tests.cjs` proves the U-1 upgrade floor on real containers with a **seeded** database, one
PostgreSQL major per run (run it for 16, 17 and 18; Debian postgres images, see above). Same production files, same command, same limits as above.

| File | What it is |
|---|---|
| `run-upgrade-with-data-tests.cjs` | The driver (cases U1-U7 below). |
| `upgrade-lib.cjs` | Its helpers (projects, secrets, psql as the superuser and as `crewflow_owner`, a lock holder). |
| `seed-organisations.sql` | Two synthetic organisations: CEO, workspace, membership, roles, venues, a job role, three staff, shifts, assignments, offers, attendance, approved payroll records and a payroll run. `.invalid` addresses only. |
| `data-facts.sql` | Read-only facts compared before and after: seeded row sets (count + md5 of ids), seeded row CONTENT (md5 of a fixed, reviewed column list per table: tenant keys, references, status, money, minutes, key timestamps), payroll pence and worked minutes, every core foreign key checked row by row, and tenant ownership on every cross-table reference. |
| `probe/build-probe-images.cjs`, `probe/*.js` | Test-only images: the image under test (pinned by digest) plus one failing probe migration (transactional, or `transaction = false` with a committed first step). The build file is generated on stdin, so no unpinned Dockerfile is tracked (the image gate checks every tracked Dockerfile). Never pushed to Docker Hub. |

| Case | What is proven |
|---|---|
| U1 | Fresh R254 (`cd7c7e32`), seed, then the new image: the floor admits R254, 254 → 256, the entity-cache epoch bump runs, the API is healthy before the Worker starts, the seeded data, money, foreign keys and tenant ownership are unchanged, and RLS holds for `crewflow_owner` (no context = 0 rows; organisation A sees only A; A with B's workspace = 0). Optional red control (`DOT_CONTROL_DIGEST`, an image with N1): refused with 65, Worker never started. Rollback to R254: AHEAD, serves. Then a self-check proves the comparators can fail (a rewritten value, a row moved to the other organisation, a wrong RLS expectation), and the reverted data compares equal again. |
| U2 | An older history (last 4 ledger rows removed) and a holed one: refused with `UnsupportedUpgradeStartError` (65) in a restart loop, nothing applied, Worker never started. Repairing the ledger lets the same container upgrade; the Worker starts on the next `docker compose up -d` (SU-02). |
| U3 | The API is SIGKILLed inside `OutboxClaimIndexes1786721440000` (its second index blocked by a lock holder): the Worker was not started, the first index stays without a ledger row; the documented command resumes to 256 with both indexes valid. |
| U4 / U5 | A failed transactional / non-transactional upgrade migration (probe images): exit 70, the API serves with `upgradeFailed: true`, the Worker starts (C3), data unchanged; the new image afterwards is CURRENT. |
| U6 | A foreign database (a table in `public`): FOREIGN, `DatabaseStateError` (67), nothing created, Worker never started. |
| U7 | Two migrate children of the new image race for the advisory lock on a seeded R254 database: one applies 2, the other waits and finds CURRENT; no duplicate ledger rows. |

```bash
# local registry (127.0.0.1 only), the images by digest
docker run -d --name deploy-order-registry -p 127.0.0.1:5055:5000 --tmpfs /var/lib/registry registry@sha256:<digest>
# tag + push prev (adhin007/adolphus:cd7c7e32…) and new to 127.0.0.1:5055/adolphus, then the probes FROM new's digest:
node packages/rab-docker/deploy-order-tests/probe/build-probe-images.cjs 127.0.0.1:5055/adolphus@sha256:<new> dou:probe
# -> dou:probe-DotProbeFail and dou:probe-DotProbePartial: tag + push both [and the optional control] to the same repository

DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_PREV_DIGEST=sha256:<cd7c7e32> DOT_NEW_DIGEST=sha256:<new> \
DOT_PROBE_FAIL_DIGEST=sha256:<…> DOT_PROBE_PARTIAL_DIGEST=sha256:<…> [DOT_CONTROL_DIGEST=sha256:<0e0a6edd>] \
DOT_PG_IMAGE=postgres@sha256:<Debian postgres 16, 17 or 18> DOT_REDIS_IMAGE=redis@sha256:<7> \
  node packages/rab-docker/deploy-order-tests/run-upgrade-with-data-tests.cjs <16|17|18> <out-dir> [--only=U1,U3]
```

Projects are `<prefix>-pg<major>-u1` … `-u7` (`DOT_PROJECT_PREFIX`, default `dou`; give each agent or parallel run its own), run one after another and taken `down` after each case (U4 stays up for U5 when both run). The output directory must be outside the repository.

## Database setup like Twenty (DB-SETUP, owner's tests)

`run-db-setup-tests.cjs` proves the owner's DB-SETUP test list (2026-11-12; DB-SETUP-PLAN.md §10) on real containers, one
PostgreSQL major per run (16, 17, 18), with the production `docker-compose.image.yml` unchanged and the documented command.

| Case | Owner's test | What is proven |
|---|---|---|
| S1 | 1 | Bundled db, fresh, with ONLY `PG_DATABASE_PASSWORD` (compose.env) + `APP_SECRET` (runtime.env) + dummy non-database settings: the one-shot db-setup's bootstrap child creates crewflow_owner (db-setup exits 0; rab-api runs no bootstrap child; the target file rab-api reads holds no login, password or APP_SECRET) with exactly the 01 attributes and grant, 256 migrations as crewflow_owner, API and Worker healthy, every session crewflow_owner over verify-full TLS. |
| S6 | 6 | `/proc/<pid>/environ` of EVERY process of rab-api and rab-worker (PID 1 included): no admin password, no `PG_DATABASE_PASSWORD`, `PG_DATABASE_URL` = crewflow_owner. PR #125 options A and 2: the same for a `docker exec` process (the environment a health check gets), for the health-check processes caught while they run (a 40 s in-container scan), and for both container definitions (`docker inspect`, no credential); option 2: `PG_DATABASE_URL` present and EMPTY in both definitions, in the rendered `docker compose config`, in the `docker exec` process and in every health-check process caught. `pg_stat_activity`: every session crewflow_owner. The db log (`log_connections`): no admin connection but db-setup's bootstrap child (and the db's own `pg_isready`). |
| S2 | 2 | `docker compose restart` (db-setup runs again), then `down` + the documented command: same role oid, byte-identical verifier (sha256 compared), same ACL, db-setup "ready (unchanged)", no new certificate. |
| D1 | docs | The two documented derive commands (OWNER-LOGIN-DEPLOYMENT.md): (a) `run --rm --no-deps -T -e CREWFLOW_DB_TARGET_FILE=... --entrypoint /sbin/tini rab-api -s -- sh -c '... derive-runtime-url.js 4>&1 1>&2'` after a normal db-setup; (b) the same from `db-setup` (it holds the admin URL; no target file needed). Each: exit 0, exactly one stdout line = a crewflow_owner URL for `db:5432/crewflow` with the derived password, which logs in; no URL on stderr; no database connection. The value is compared in memory, never written. |
| S5 | 5 | APP_SECRET rotation: db-setup "ready (password set)" once, the new derived password logs in and the old does not, the recreated Worker connects; an API restart changes nothing and the next `up` is "unchanged". |
| S10A | 10 | The admin URL handed to rab-api / rab-worker anyway (`run -e PG_DATABASE_URL`): the production entrypoints refuse (option 2: any non-empty `PG_DATABASE_URL`, 64), and a runtime process started without them (Worker main, API main, migrate child) refuses before connecting; none opens an admin connection. |
| S8 | 8 | No log (db with `log_statement=all`, API, Worker, Redis, compose output) holds the admin password, an APP_SECRET, a derived password, a credentialed URL or a SCRAM verifier. |
| S9 | 9 | Two db-setup runs at once on a fresh db: one bootstrap creates the role, the other reports it ready. Then two API starts at once (the migration lock held until both wait): one migrate child applies 256, the other finds CURRENT, no duplicate ledger rows. |
| S4 | 4 | An existing crewflow_owner with SUPERUSER, then BYPASSRLS: db-setup exits 64 with the fixed message, the role untouched, nothing created. |
| S3 | 3 | An external non-superuser admin: no CREATEROLE -> refused; CREATEROLE but cannot grant on the database -> refused; CREATEROLE + owns the database -> works (fresh, restart, rotation); a second admin without ADMIN OPTION -> refused when a reset is needed. |
| S8X | 8 | The same log scan for the external admin; a verifier may appear only in the db log (a non-superuser cannot turn statement logging off: the documented residual). |
| P1 | option 2 | Block `pt`. `PG_DATABASE_URL` = a hand-made crewflow_owner URL (password NOT the derived one): the first db-setup takes step b (one `DO $owner_self$` in the db log, "pass-through, its own password set to the derived one"), attributes unchanged, API and Worker healthy; a second db-setup takes step a (no new `DO $owner_self$`, "pass-through, unchanged", same verifier). Both app definitions keep `PG_DATABASE_URL=""` although compose.env holds the URL. Log scan: no password, APP_SECRET or URL; a verifier only in the db log (non-superuser residual). |
| P5 | option 2 | Block `pt`. A non-empty `PG_DATABASE_URL` forced into rab-api / rab-worker (`run -e`: the WORKING derived crewflow_owner URL, the admin URL, a non-URL value): exit 64 with the fixed message, no database connection opened (db log `log_connections`). |
| S10B | 10 | Block `pt`. A crewflow_owner made BYPASSRLS, then SUPERUSER AFTER db-setup: an API start is refused by the runtime guards. (Option 2: the same roles through their own URL are refused earlier, by db-setup: P3.) |
| P3 | option 2 | Block `ptx`. The crewflow_owner URL of a SUPERUSER, then a BYPASSRLS crewflow_owner: the documented command fails, db-setup exits 64 with the fixed message, the role is untouched (verifier included), no `DO $owner_self$`, no extension, object or core schema created, rab-api / rab-worker never started. |
| P4 | option 2 | Block `ptx`. The test seam `CREWFLOW_TEST_OWNER_SETUP_ABORT` (refused with exit 64 and no connection when `NODE_ENV` is not `test`): killed before the COMMIT -> role unchanged, the re-run takes step b and succeeds; killed after the COMMIT -> the derived password is committed, the documented command recovers through step a, API and Worker healthy. |
| P2 | option 2 | Block `ptx`. The URL already carries the derived password: db-setup takes step a, no `DO $owner_self$`, role unchanged; the app definitions stay `PG_DATABASE_URL=""`. |
| S7 | 7 | An R256 database (R256's API + Worker, seeded): NEW with the unchanged crewflow_owner URL (option 2: db-setup gives crewflow_owner the derived password once, attributes and ACL unchanged), then with the admin URL (nothing left to reset: unchanged); data, money, FKs, tenant ownership and RLS identical. Also records that R256 under THIS release's compose files alone cannot start (no `db-setup.sh` in its image: db-setup fails and rab-api never starts). |
| S10C | 10 | PostgreSQL 15 as the db: "PostgreSQL 16 or later is required.", exit 64, nothing created. |

```bash
DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_NEW_DIGEST=sha256:<new> DOT_R256_DIGEST=sha256:<0e0a6edd re-pushed> \
DOT_PG_IMAGE=postgres@sha256:<Debian 16|17|18> DOT_PG15_IMAGE=postgres@sha256:<Debian 15> DOT_REDIS_IMAGE=redis@sha256:<7> \
[DOT_PROJECT_PREFIX=dbs] \
  node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,race,ext,pt,ptx,r256,pg15] [--only=S1,P1,...]
```

Projects are `<prefix>-pg<major>-a`, `-race`, `-ext`, `-pt`, `-ptx`, `-r256`, `-pg15`, each taken `down --volumes` after its block.
