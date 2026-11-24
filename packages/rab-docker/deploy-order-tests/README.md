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
| `docker-compose.deploy-order-owner.yml` | The pass-through scenarios: the db's first start runs the shipped `01-crewflow-owner.sql` (the hand-made crewflow_owner of an R254/R256 deployment), and compose.env carries the same password as `PG_DATABASE_APP_PASSWORD` (or the crewflow_owner URL as `PG_DATABASE_URL`). Owner decision 2026-11-18: db-setup, rab-api and rab-worker all receive that crewflow_owner URL; db-setup finds the password logs in and never changes it. |
| `docker-compose.deploy-order-prev.yml` | Only while `CREWFLOW_IMAGE_TAG` is an image older than DB-SETUP: that release's own start-up (image ENTRYPOINT tini, rab-worker `node packages/rab-worker/dist/main.js` under `init: true`) and the production files' own crewflow_owner `PG_DATABASE_URL` on rab-api / rab-worker, because the old image has no `worker-start.sh`. db-setup changes the password only when it does not log in, so a rollback uses the same compose.env. |
| `docker-compose.db-setup-logging.yml` | `run-db-setup-tests.cjs` only: the db's command plus worst-case server logging (`log_statement=all`, `log_connections=on`, user and application_name in every line). |
| `docker-compose.deploy-order-t4.yml` | For T4 only: a shorter API health-check window. The Worker's `depends_on` is unchanged. |

## The cases

| Case | What is proven |
|---|---|
| T1 | A fresh deploy of the previous digest. The `rab-api` `health_status: healthy` event comes before the `rab-worker` `start` event. `State.StartedAt` agrees. |
| T2 | A deploy of the new digest with the same command. Both containers are recreated on the same new digest. The old Worker's `die` event comes before the new API's `start` event. The new API applies the new migrations on start. The new Worker sees every scheduler. It runs the new code for a scheduled job: the email dispatch sweep prints `generationsExhausted=` (new in #89) when it claims a probe row. |
| T3 | A rollback with `CREWFLOW_IMAGE_TAG=<previous digest>` and the same command. Both containers go back together, in the same event order. The old API logs `database state AHEAD` and still serves `/healthz`. |
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

None of these cases (nor `upgrade-ledger-tests/`) starts a PATCH release (`M.m.p`, p > 0): the images under test are minor releases. A forced patch start whose `.0` command deferred is the one exit-0 start that reports `/healthz` `upgradeFailed: true` (a forced marker row, OWNER-LOGIN-DEPLOYMENT.md 3.6 (e)), so it cannot appear in these runs. A future patch-release case must expect `upgradeFailed: true` there, not treat it as a regression. That path is covered by `cross-upgrade-resume.integration.spec.ts` case 9 and `upgrade-runner-deferral.spec.ts`.

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

## Database setup the Twenty way (owner decision 2026-11-18)

`run-db-setup-tests.cjs` proves the database setup on real containers, one PostgreSQL major per run (16, 17, 18), with the
production `docker-compose.image.yml` unchanged and the documented command. db-setup, rab-api and rab-worker all receive
`PG_DATABASE_URL`, the crewflow_owner URL (for the bundled db compose builds it from `PG_DATABASE_APP_PASSWORD`); only db-setup
holds an admin login (the bundled superuser, or `PG_ADMIN_URL`). There is no setup volume, no target file and no password file.
Mode (c) (`PG_DATABASE_URL` only) runs the REAL bootstrap child in the db-setup image directly, because db-setup.sh refuses
`CREWFLOW_BUNDLED_DB=0` with a URL on the host `db`, the only name the bundled db's certificate carries; db-setup.sh's mode
switch itself is covered by `rab/api-prestart-test/run-prestart-shell-tests.cjs`.

| Case | Block | What is proven |
|---|---|---|
| A1 | a | Mode (a) fresh: crewflow_owner created with `PG_DATABASE_APP_PASSWORD` (01 attributes), CREATEROLE kept and marked (COMMENT ON ROLE); the first API start accepts the marked CREATEROLE with a WARNING; API and Worker healthy; no setup volume or mount; no admin credential in any app process, `docker exec` process or definition; db-setup, rab-api and rab-worker render the SAME crewflow_owner URL; the image holds no password file. |
| A2 | a | The next `up`: CREATEROLE removed and the mark cleared; after a restart the apps boot on the NOCREATEROLE role; the next `up`, and `down` + `up`, change nothing (snapshot identical). |
| A3 | a | CREATEROLE re-granted by an admin (unmarked): rab-api refuses to start ("has CREATEROLE after the schema bootstrap"); the next `up` removes it and the API recovers. |
| C1 | c | Mode (c), the real child with `PG_DATABASE_URL` only: exit 0, every statement read-only (db log), nothing changed. |
| C2 | c | Mode (c) with a password that does not log in: 64 ("Without PG_ADMIN_URL db-setup never changes the password"), nothing changed. |
| C3 | c | Mode (c) with an unmarked CREATEROLE on a complete schema: 64, untouched. |
| A4 | a | A new `PG_DATABASE_APP_PASSWORD`: the superuser sets it (same oid, new verifier), the old one refused, the apps recreated and healthy. |
| A5 | a | `PG_ADMIN_URL` forced into a rab-api one-off or rab-worker, an empty crewflow_owner password (apps and db-setup): 64 before any connection. |
| S8 | a | No log holds a password, APP_SECRET or a SCRAM verifier. |
| B1 | b | Mode (b), BOTH URLs set, a NON-superuser admin (CREATEROLE + the database grants WITH GRANT OPTION): created, apps healthy, the admin URL in no app container. |
| B2 | b | The next `up`: that admin removes CREATEROLE (CREATEROLE + ADMIN OPTION). |
| B3 | b | A new password inside `PG_DATABASE_URL`: set by the admin, the old one refused. |
| B4 | b | Refusals before any write: no ADMIN OPTION + a wrong password; two different databases; a non-crewflow_owner `PG_DATABASE_URL`; a crewflow_owner `PG_ADMIN_URL`; a BYPASSRLS / SUPERUSER crewflow_owner. |
| S8X | b | The log scan with a non-superuser admin (a verifier only as the db log's non-superuser residual). |
| S11 | dep | `depends_on` ignored: the apps started before db-setup cannot log in and restart; healthy once db-setup has run. |
| S9 | race | Two db-setup at once (advisory lock): both exit 0, exactly one creates; then two API starts at once: one migrate child applies, the other finds CURRENT. |
| SP, H1a, H1b, N2 | ref | The admin-path refusals (search_path default; crewflow_owner owns the database, directly / inherited, with a planted operator: zero planted calls; a SET-only owner membership). |
| N1 | ref | The transition from a separated deployment (runbook §5): the admin path refused; mode (c) with the crewflow_owner URL works and writes nothing. |
| S7 | r256 | An R256 database upgrades with the same compose.env: the hand-made password kept (same verifier), CREATEROLE marked then removed on the next `up`; data, money, FKs, tenant ownership and RLS identical. |
| S10C | pg15 | PostgreSQL 15: 64, nothing created. |
| M1L | lock | One server per data volume. |

```bash
DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_NEW_DIGEST=sha256:<new> DOT_R256_DIGEST=sha256:<0e0a6edd re-pushed> \
DOT_PG_IMAGE=postgres@sha256:<Debian 16|17|18> DOT_PG15_IMAGE=postgres@sha256:<Debian 15> DOT_REDIS_IMAGE=redis@sha256:<7> \
[DOT_PROJECT_PREFIX=dbs] \
  node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,b,dep,race,ref,r256,pg15,lock] [--only=A1,B1,...]
```

Projects are `<prefix>-pg<major>-a`, `-b`, `-dep`, `-race`, `-ref`, `-r256`, `-pg15`, `-lock`, each taken `down --volumes` after its block (A1 also runs one `<prefix>-pg<major>-a-imagecheck` container, no network, removed on exit).
