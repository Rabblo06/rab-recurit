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
| `docker-compose.deploy-order.yml` | The infrastructure overlay. PostgreSQL and Redis data live on tmpfs, the TLS key gets 0600 inside the container, and the API publishes no host port. The app services are not changed. |
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
DOT_PG_IMAGE=postgres@sha256:<16 or 18> DOT_REDIS_IMAGE=redis@sha256:<7> \
  node packages/rab-docker/deploy-order-tests/run-deploy-order-tests.cjs <16|18> <out-dir>
```

On Git Bash for Windows, set `MSYS_NO_PATHCONV=1` for the `docker run` line.

- **Projects and containers.** T1–T3 use project `dot-pg<major>` and T4 uses `dot-pg<major>-t4`. At most five of the run's containers run at once: PostgreSQL, Redis, the API, the Worker and the registry. The driver samples and records the peak.
- **No sink container.** SMTP and S3 point at `.invalid` names, so nothing leaves the host.
- **Cleanup.** The driver runs `docker compose down` on its own two projects only. It has no volumes (every data directory is a tmpfs), never prunes, and never touches another project. Remove the registry yourself with `docker rm -f deploy-order-registry`.
- **Secrets.** They are generated per run under `<out-dir>/secrets`, outside the repository, and reach the containers only through env files. Every captured output is redacted.
- **Output.** `<out-dir>/RESULTS.json`, `SUMMARY.md`, `run.log` and `evidence/`, which holds the event timelines, deploy output and container logs.

## Upgrade with data (Phase X U-1b)

`run-upgrade-with-data-tests.cjs` proves the U-1 upgrade floor on real containers with a **seeded** database, one
PostgreSQL major per run (run it for 16 and 18). Same production files, same command, same limits as above.

| File | What it is |
|---|---|
| `run-upgrade-with-data-tests.cjs` | The driver (cases U1-U7 below). |
| `upgrade-lib.cjs` | Its helpers (projects, secrets, psql as the superuser and as `crewflow_owner`, a lock holder). |
| `seed-organisations.sql` | Two synthetic organisations: CEO, workspace, membership, roles, venues, a job role, three staff, shifts, assignments, offers, attendance, approved payroll records and a payroll run. `.invalid` addresses only. |
| `data-facts.sql` | Read-only facts compared before and after: seeded row sets (count + md5 of ids), payroll pence and worked minutes, every core foreign key checked row by row, and tenant ownership on every cross-table reference. |
| `probe/build-probe-images.cjs`, `probe/*.js` | Test-only images: the image under test (pinned by digest) plus one failing probe migration (transactional, or `transaction = false` with a committed first step). The build file is generated on stdin, so no unpinned Dockerfile is tracked (the image gate checks every tracked Dockerfile). Never pushed to Docker Hub. |

| Case | What is proven |
|---|---|
| U1 | Fresh R254 (`cd7c7e32`), seed, then the new image: the floor admits R254, 254 → 256, the entity-cache epoch bump runs, the API is healthy before the Worker starts, the seeded data, money, foreign keys and tenant ownership are unchanged, and RLS holds for `crewflow_owner` (no context = 0 rows; organisation A sees only A; A with B's workspace = 0). Optional red control (`DOT_CONTROL_DIGEST`, an image with N1): refused with 65, Worker never started. Rollback to R254: AHEAD, serves. |
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
DOT_PG_IMAGE=postgres@sha256:<16 or 18> DOT_REDIS_IMAGE=redis@sha256:<7> \
  node packages/rab-docker/deploy-order-tests/run-upgrade-with-data-tests.cjs <16|18> <out-dir> [--only=U1,U3]
```

Projects are `dou-pg<major>-u1` … `-u7`, run one after another and taken `down` after each case.
