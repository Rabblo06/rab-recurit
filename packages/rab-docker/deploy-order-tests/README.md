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
| `docker-compose.deploy-order-owner.yml` | The pass-through scenarios: the db's first start runs the shipped `01-crewflow-owner.sql` (the hand-made crewflow_owner of an R254/R256 deployment), and compose.env holds that crewflow_owner URL as `PG_DATABASE_URL`. PR #125: only db-setup reads it, checks it read-only and copies its password into the setup volume's password file; the password is never changed. |
| `docker-compose.deploy-order-prev.yml` | Only while `CREWFLOW_IMAGE_TAG` is an image older than DB-SETUP: that release's own start-up (image ENTRYPOINT tini, rab-worker `node packages/rab-worker/dist/main.js` under `init: true`) and its `PG_DATABASE_URL: ${PG_DATABASE_URL:-}` on rab-api / rab-worker (PR #125 pins `""` there), because the old image has no `worker-start.sh` and reads its runtime login from that variable. PR #125 never changes an existing crewflow_owner's password, so a rollback uses the same crewflow_owner URL. |
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

## Database setup the Twenty Helm way (PR #125, owner's A6 tests)

`run-db-setup-tests.cjs` proves the owner's A6 test list (OWNER-DB-FINAL.md Part A; DB-SETUP-HELM-PLAN.md) on real
containers, one PostgreSQL major per run (16, 17, 18), with the production `docker-compose.image.yml` unchanged and the
documented command. `PG_DATABASE_URL` reaches `db-setup` only. crewflow_owner's password lives in a file on the setup volume
(0400, 1000:1000): random for the bundled db or an admin URL, the URL's own password for a crewflow_owner URL. The apps read it
read-only together with the credential-free `target.json`. The harness reads the file into memory only (`Project.readPasswordFile()`,
redacted, never printed); `DOT_OWNER_PASSWORD_FILE` overrides its path.

| Case | Block | What is proven |
|---|---|---|
| S1 | a | Bundled db, fresh, with ONLY `PG_DATABASE_PASSWORD` + `APP_SECRET`: crewflow_owner created (01 attributes and grant), migrations applied, API and Worker healthy. The password file is random (>= 32 characters), 0400 1000:1000, logs in, read-only in rab-api / rab-worker and read-write only in db-setup. It is absent from every env file, container definition and the rendered compose config, and from the image (`docker image inspect`, `docker history`, the image filesystem). It is not APP_SECRET. The target file is credential-free. |
| S6 | a | No admin credential in any rab-api / rab-worker process (PID 1 included), `docker exec` process, health-check process caught while running, or container definition; `PG_DATABASE_URL` present and empty there. Every session is crewflow_owner. The only admin connection is db-setup's. |
| S2 | a | `docker compose restart`, then `down` + up: the same password file (sha256 compared); ZERO database changes (role, verifier, memberships, ACL, role/database settings, owner, role count snapshots identical); db-setup "unchanged". |
| S5 | a | APP_SECRET change: the apps are recreated and connect; the database snapshot and the file are unchanged; db-setup's definition holds no APP_SECRET. |
| X1 | a | Red control (security review L5): the old option-2 expectation, crewflow_owner password = hex(HKDF(APP_SECRET)), FAILS for both APP_SECRETs used (does not log in, is not the stored password). The harness has no HKDF helper any more. |
| F3 | a | An EMPTY password file: db-setup 64, nothing changed, no `.next` file; the documented recovery (stop the apps, the env-free removal, `up -d`) resets and the apps start. |
| F1 | a | The file present but its password no longer logs in: 64 with "delete the password file…", nothing changed. Then the file deleted + the admin URL: reset (a Crewflow addition), a new random password, the old ones refused, the apps recover after a restart. |
| R1 | a | The documented "print the crewflow_owner URL" command (OWNER-LOGIN-DEPLOYMENT.md §3.6 / DB-SETUP-LEAD.md operator command 1: `docker volume inspect` first, then `docker run … --entrypoint sh <IMAGE> -c 'CREWFLOW_RUNTIME_URL_FD=4 node …/derive-runtime-url.js 4>&1 1>&2'`, no `-t`; plus `--name`): exit 0, one stdout line, a crewflow_owner URL for `db:5432/crewflow` whose password is the file's random one and logs in; stderr holds no URL; the container is gone (`--rm`, `--log-driver none`); no container log holds the password. T3 uses the same command's output for its rollback to R254. |
| C1 | a | The documented deliberate password change (`$P stop rab-worker rab-api`; `docker run --rm --network none --log-driver none --user 1000:1000 -v <project>_crewflow-db-target:/v <IMAGE> rm -f /v/owner-password`; `$P up -d`): reset (A4), a new password works, the old fails, the apps start healthy without a manual restart (timed). |
| C2 | a | The same without stopping the apps: `up -d` does not recreate them, so they keep the old password (28P01 on new connections, counted), until `$P up -d --force-recreate rab-api rab-worker` (timed). |
| S10A | a | The admin URL forced into the apps: the entrypoints (64) and every runtime process refuse before connecting. |
| S8 | a | No log holds a password (admin, crewflow_owner, the hand-changed one), an APP_SECRET, a credentialed URL or a verifier. |
| S11 | dep | `depends_on` ignored: rab-api / rab-worker started before db-setup on a fresh db wait without connecting, then become healthy once db-setup has run. |
| S9 | race | Two db-setup at once: exactly one creates crewflow_owner; the other succeeds or refuses with the password-file race message having changed nothing; afterwards the password file logs in (file and role agree) and a third db-setup is "unchanged". Then two API starts at once: one migrate child applies, the other finds CURRENT. |
| S4 | ext | An existing SUPERUSER / BYPASSRLS crewflow_owner on the admin path: 64, untouched, nothing created. |
| S3 | ext | An external non-superuser admin URL: no CREATEROLE / cannot grant -> 64. CREATEROLE + owns the database -> created; restart and APP_SECRET change unchanged; lost file -> reset. A second admin without ADMIN OPTION + lost file -> 64. The admin URL is absent from every app process, `docker exec` process and definition. |
| M1 | ext | An admin URL naming a missing database: 64 with a clear message, no database created. |
| S8X | ext | The log scan for the external admin (a verifier only as the documented non-superuser residual in the db log). |
| SP | ref | A database-wide search_path default: 64, nothing created. |
| H1a / H1b | ref | crewflow_owner owns the database (directly / through an inherited role) and plants an operator + a database search_path: 64, ZERO planted calls during the setup; a sanity call by an unpinned superuser session proves the plant is live. |
| N2 | ref | A SET-only membership of the owning role: 64, nothing written. |
| N1 | ref | A transition-shaped database: the admin URL -> 64; the crewflow_owner URL -> exit 0, nothing written, the file holds that URL's password (runbook §5.4). |
| P1 | pt | An existing crewflow_owner URL: used unchanged, with zero writes: every statement of the setup sessions is read-only in the db log (log_statement=all), and the role snapshot is identical. The OLD password still logs in and the file holds it. API and Worker are healthy. The same holds on the next start. |
| P5 | pt | A non-empty `PG_DATABASE_URL` forced into the apps (a working crewflow_owner URL, the admin URL, junk): 64, no connection. |
| S10B | pt | crewflow_owner made BYPASSRLS / SUPERUSER after db-setup: the runtime guards refuse it. |
| F2 | pt | File lost, no admin URL: a valid crewflow_owner URL rewrites the file with no write. A crewflow_owner URL whose password no longer logs in -> 64 and no file; an app start then waits and exits 75 without connecting. |
| P3 | ptx | The crewflow_owner URL of a SUPERUSER / BYPASSRLS crewflow_owner: 64, untouched, the hand-made password still logs in, no extension / object / core schema, the apps never start. |
| S7 | r256 | An R256 database (seeded): NEW with its crewflow_owner URL (role and verifier exactly as R256 left them, the file holds the hand-made password), then with the bundled admin URL (unchanged); data, money, FKs, tenant ownership and RLS identical. R256 under this release's compose files alone cannot start (observed). |
| S10C | pg15 | PostgreSQL 15: 64, nothing created. |

```bash
DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_NEW_DIGEST=sha256:<new> DOT_R256_DIGEST=sha256:<0e0a6edd re-pushed> \
DOT_PG_IMAGE=postgres@sha256:<Debian 16|17|18> DOT_PG15_IMAGE=postgres@sha256:<Debian 15> DOT_REDIS_IMAGE=redis@sha256:<7> \
[DOT_PROJECT_PREFIX=dbs] [DOT_OWNER_PASSWORD_FILE=/run/crewflow/db-target/owner-password] \
  node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,dep,race,ext,ref,pt,ptx,r256,pg15] [--only=S1,P1,...]
```

Projects are `<prefix>-pg<major>-a`, `-dep`, `-race`, `-ext`, `-ref`, `-pt`, `-ptx`, `-r256`, `-pg15`, each taken `down --volumes` after its block (S1 also runs one `<prefix>-pg<major>-a-imagecheck` container, no network, removed on exit).
