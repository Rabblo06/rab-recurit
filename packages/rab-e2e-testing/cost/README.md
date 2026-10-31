# Crewflow cost / performance harness (Phase M)

A reproducible measurement harness for the Crewflow API, worker, PostgreSQL (FORCE RLS), Redis and S3, run on a
**disposable** stack. It produces comparable "before" and "after" numbers for one commit at a time.

It ports the 2026-10-26 cost-audit harness (`docs/audits/COST_COMPARISON_100K_CLAUDE.md` §3), which was never
committed, and fixes three gaps in it:

- **PDF CPU** uses the application's real renderer (`rab-worker` `render-pdf.util`). The old harness used a
  re-implementation.
- **Storage HEAD/LIST/GET/PUT** counts are measured by tracing MinIO. They used to be derived from reading code.
- **Seed** is deterministic: fixed PRNG, fixed logical clock and fixed ids.

## Safety

- **Separate stack.** Everything runs in the compose project `crewflow-cost`, with containers named `costaudit-*`,
  the network `crewflow-cost-net` and its own volumes. Ports are loopback only: Postgres 25470, Redis 26470,
  MinIO 29070, API 23070.
- **No shared database.** It never touches the dev stack (`rab-devdb` 15432, `rab-redis-1`), `crewflow-test-*`, the
  e2e stack or any remote database.
- **Database guard.** Every SQL step runs inside `costaudit-pg`. Before writing, every script checks the database
  comment `crewflow-cost disposable measurement database`.
- **Migrations** use the repo's guarded runner (`setup-db.js`, `DB_TARGET=local`):
  - phase A runs as `rab_owner` and stops at the role split, as expected;
  - phase B runs as the bootstrap superuser.

  This is the same sequence as `packages/rab-e2e-testing/system/docker-compose.e2e.yml`.
- **Runtime roles.** The API and the worker jobs child connect as `crewflow_app`. The provisioner child connects as
  `crewflow`.
- **Secrets** live in `$COST_SECRETS`, outside the repo. The default is `C:/rab-ai-wt/cost-secrets/cost.env`.
  `scripts/gen-secrets.sh` generates random values on first use. Scripts never print them.
- **Images** are `crewflow-cost/server:<tag>`, `crewflow-cost/worker:<tag>` and `crewflow-cost/loadgen:<hash>`.
  `rab-server:latest` and `rab-worker:latest` are never built or retagged.
- **Teardown.** `docker compose -p crewflow-cost down -v` runs at the end, unless you pass `--keep`. It runs only
  after the project-scope guard (below) has passed.

## Isolation from the development stack

Since 2026-10-27 the harness shares the Docker host with the owner's normal development stack and **never changes it**.
An earlier `--stop-dev` option stopped and restarted `rab-server-1`, `rab-worker-1` and `rab-front-1`. Restarting
`rab-front-1` re-ran its `yarn install --immutable` against the bind-mounted main checkout while the Docker VM was
short of memory (ENOMEM), and `C:/Rab-recruit/yarn.lock` was left at 0 bytes. That option is gone; `run.sh --stop-dev`
now refuses with an explanation.

Rules, each enforced in code (`lib/guard.sh`, `lib/check-compose.js`, `lib/lib.js`):

- **Only harness resources are acted on.** Every stop/start/rm/pause/unpause goes through the container guard
  (`hdocker` in shell, `harnessDocker` in Node). It refuses any container whose name is not `costaudit-*` **and** that
  does not carry `com.docker.compose.project=crewflow-cost` or `crewflow-cost.harness=true`. The containers the
  harness starts with `docker run` (tracer, PDF bench, load generator, version probes) carry `crewflow-cost.harness=true`.
  `stop -t`, `kill`, `restart` and other verbs are refused outright.
- **Teardown is project-scoped and checked.** Before `down -v --remove-orphans`, `assert_project_scope` lists
  everything labelled with the project and refuses if any container is not `costaudit-*`/`crewflow-cost-*`, any
  volume is not `crewflow-cost_*`, any network is not `crewflow-cost-net`, or a foreign container is attached to
  `crewflow-cost-net`. `dc` always passes `-p crewflow-cost -f docker-compose.cost.yml` and ignores
  `COMPOSE_PROJECT_NAME`/`COMPOSE_FILE`/`COMPOSE_PROFILES` from your shell.
- **No mount of the main checkout.** The images are built from `git archive` (read-only on the object store). The
  only bind mounts are the two `init/` files and the harness folder itself (for `tool`), all `:ro` and all inside this
  folder, which lives in a worktree. `lib/common.sh` refuses at start if the harness folder, the archive repo,
  `COST_WORK`, `COST_SECRETS` or the results directory lies inside the main checkout, so a copy of the harness inside
  `C:/Rab-recruit` cannot turn these into main-checkout mounts. `check_compose_isolation` re-verifies the rendered
  compose model before every run: binds read-only and inside this folder, project volumes and network only, nothing
  external, no host network/pid/privileged, ports bound to 127.0.0.1 and never a dev/test/e2e port.
- **Own ports and subnet.** `check_ports_subnet` refuses if 25470/26470/29070/23070 are published by another
  container or have a host listener while the harness stack is down, or if `172.31.70.0/24` overlaps another Docker
  network.
- **Main-checkout drift guard (aborts).** At run start the harness records, for `$COST_MAIN_CHECKOUT` (default
  `C:/Rab-recruit`): HEAD and branch, `git status --porcelain=v1 -uall`, and size + sha256 of `yarn.lock`,
  `.yarnrc.yml`, every `package.json` (tracked and untracked-not-ignored) and every path the status lists, so a further
  change to an already-dirty file is caught too. After **every phase** and at the end it re-checks. On any difference
  it aborts with exit code 3, prints exactly which paths changed and writes them to
  `<out>/main-checkout-drift-<phase>.txt` (plus `MAIN-CHECKOUT-DRIFT.txt` and `ABORTED.txt`). The stack is left
  running for inspection. All git calls are read-only and run with `GIT_OPTIONAL_LOCKS=0`, so they do not even refresh
  the main checkout's index. Ignored files (`node_modules`, `.yarn/install-state.gz`) are not watched. **Editing the
  main checkout during a run aborts it**, by design, so plan runs for when nobody is changing that tree.
- **Dev-container state guard (report only).** At run start the harness records name, status, `StartedAt` and restart
  count of every `rab-*` and `crewflow-test-*` container (`COST_DEV_WATCH_REGEX`). After every phase it compares; a
  difference is logged in `<out>/dev-containers-changes.log` and `versions.txt` (`devContainers.changedDuringRun=yes`).
  It only ever runs `docker inspect`/`docker ps` on them; it never acts on them.

Check all of this without measuring anything:

```bash
# starts nothing: paths, compose model, ports/subnet, guard self-tests, drift + dev-state baselines and re-checks
bash packages/rab-e2e-testing/cost/scripts/run.sh --check-isolation      # alias: --dry-run
# additionally starts ONLY costaudit-pg/redis/minio, re-checks, and removes them through the guarded teardown
bash packages/rab-e2e-testing/cost/scripts/run.sh --check-isolation --with-infra
# the drift guard on its own (any git work tree; default C:/Rab-recruit)
COST_MAIN_CHECKOUT=/c/Rab-recruit bash packages/rab-e2e-testing/cost/scripts/drift-guard.sh snapshot <dir>
COST_MAIN_CHECKOUT=/c/Rab-recruit bash packages/rab-e2e-testing/cost/scripts/drift-guard.sh check <dir> <label>
```

## Comparability on a shared host

The dev stack is no longer stopped, so every run measures next to it. Baseline and after numbers are comparable only
if both runs see the same host conditions:

1. **Run baseline and after back-to-back**, in this order, with the same options (`--idle-seconds`, limits), the same
   `COST_SEED_*` values, the same Docker Desktop resources and nothing else started or stopped between them. Do not
   reuse a baseline from an older session or from the retired `--stop-dev` mode: those numbers had the dev API and
   worker stopped, so they are **not** comparable with shared-host runs. Re-run the baseline instead.
2. **Run `--check-isolation` first**, and do not start or stop dev services, other agents' stacks or heavy test
   suites while the two runs are in progress. heavy-run keeps other heavy suites out of each measurement window, but
   not light activity.
3. **Compare the recorded host conditions before comparing metrics.** Each run records:
   - `versions.txt`: `hostMode=shared-host`, `devContainers.atStart` (name:status), `devContainers.runningAtStart`,
     `devContainers.changedDuringRun`, `otherContainers.runningAtStart`, VM CPUs and memory;
   - `host-state.txt`: the running non-harness containers with a `docker stats` snapshot at start and after each phase;
   - `idle-O*/dstats-host.txt` and `summary.json` → `hostContention`: every non-harness container's CPU every 15 s
     during each idle window, also reported as the `host` metric in `results.json`;
   - `results.json` → `hostState`: the dev containers at start, any changes, and the drift verdict.

   If the set of running dev containers differs, `devContainers.changedDuringRun=yes` in either run, or the idle-window
   host contention differs materially, treat the comparison as weakened and re-run both.
4. **Prefer metrics that do not depend on contention.** Statement counts (SQL per request, idle SQL/min), S3 operation
   counts, emails per shift and Redis bytes per job are exact counters and unaffected by other containers. cgroup CPU
   per container is only mildly affected. Latency percentiles and requests per second are the most sensitive, so read
   them together with `hostContention`.

## One command

Run it from a git **worktree** of this repo. `heavy-run.sh` refuses to run in the main tree, and the harness refuses
any path inside the main checkout. Results go to `C:/rab-ai-wt/cost-work/...`. Copy them into a worktree yourself if
they are to be committed; the harness never writes to `C:/Rab-recruit`.

```bash
# 0. isolation self-check (starts nothing)
bash packages/rab-e2e-testing/cost/scripts/run.sh --check-isolation

# 1. baseline (already built images), then immediately
bash packages/rab-e2e-testing/cost/scripts/run.sh --commit de921c56 --skip-build \
  --out /c/rab-ai-wt/cost-work/results/cost-baseline-de921c56

# 2. "after Phase 0": builds crewflow-cost/{server,worker}:<sha8> from a clean `git archive` of that commit, then measures
bash packages/rab-e2e-testing/cost/scripts/run.sh --commit <after-sha> \
  --out /c/rab-ai-wt/cost-work/results/cost-after-<after-sha8>
```

You don't need to check the commit out. The images are built from `git archive <commit>`, so uncommitted files and
this harness never enter the build context.

### Tree-snapshot mode (uncommitted work, no commit made)

`--tree <worktree>` measures a worktree's **current files** instead of a commit: tracked files as they are on disk
(uncommitted modifications included) plus untracked files that are not ignored, i.e. exactly what `git add -A && git
commit` would record, but nothing is committed (`scripts/tree-snapshot.sh`):

- **Read-only on every repository.** Only `rev-parse`, `ls-files`, `status`, `for-each-ref` and `symbolic-ref` run, all
  with `GIT_OPTIONAL_LOCKS=0` (no index refresh, no lock file). The worktree's index, HEAD, every ref (refs/stash
  included) and packed-refs are hashed before and after the copy; any difference aborts before anything is built. No
  commit, stash, tag, ref or index change is ever made.
- **Never the main checkout.** `C:/Rab-recruit` (and anything inside it) is refused by `tree-snapshot.sh`,
  `build-images.sh --tree` and `run.sh --tree` (`--check-isolation` proves all three). The main-checkout drift guard
  stays on for the whole run.
- **Content-addressed tag.** The image tag is `tree-<first 12 hex of the tree hash>`, where the tree hash is the sha256
  of the manifest `<sha256(content)>  <path>` of the COPIED files (the exact bytes `docker build` receives). Images
  whose `crewflow-cost.tree-hash` label matches are reused; `COST_REBUILD=1` forces a build. Labels:
  `crewflow-cost.source=tree`, `.tree-hash`, `.file-list-hash`, `.base-commit`, `.tree-path`.
- **Recorded.** `<out>/tree.meta` (and `$COST_WORK/build/meta/<tag>.meta` with `.manifest`, `.list`, `.deleted`): base
  commit (the tree's HEAD), branch, tree hash, file-list hash, file counts and the `git status --porcelain` of the
  tree. `versions.txt` carries the same as `source=tree` + `tree.*` lines. `--out` is required in tree mode.
- **Validated** (2026-10-27): a snapshot of the clean `C:/rab-ai-wt/integration` worktree at 6242eeec has the same
  content manifest as `git archive 6242eeec` (tree hash `c11a2fd1726a...` both ways), and `scripts/compare-images.sh`
  compares the built `/app/packages/*/dist*` files of two image pairs.

```bash
bash packages/rab-e2e-testing/cost/scripts/run.sh --tree /c/rab-ai-wt/integration --out /c/rab-ai-wt/cost-work/results/<name>
bash packages/rab-e2e-testing/cost/scripts/build-images.sh --tree /c/rab-ai-wt/integration   # build only; prints the tag
bash packages/rab-e2e-testing/cost/scripts/compare-images.sh <tagA> <tagB> <out dir>           # dist file-by-file
```

### Phase A measurement (2026-10-27)

Phases added for the worker quick wins (realtime/push gating, storage reconcile leader lock / no boot run, provisioner
opt-in, validated intervals). Each leaves `costaudit-worker` running on the base configuration. Pass **identical
options** to the before and the after run; a variable the old code does not know is simply not forwarded by the worker
launcher (allowlisted environment), so the same option string is valid for both builds.

| Phase | What happens | Output |
|---|---|---|
| idleflags | Recreates the worker with `REALTIME_ENABLED=true PUSH_ENABLED=true`, drains, idle window at O=20 (`--flags-idle-seconds`), restores the base configuration. The other configuration (both `false`) is `idle20`: false/false is the code default, the harness default and what the production compose runs (it sets neither key). | `idle-O20-flags-on/` |
| provisioner | One idle window per `--prov-configs` entry `name[:K=V,...]` (default `default`), `--prov-seconds` each, at O=20. Provisioner SQL = statements of the `crewflow` role (the provisioner child's only login). The idle windows also report it as configured. | `idle-prov-<name>/` |
| bootprobe | (1) cold: remove + create the worker; (2) restart: graceful `docker stop` (SIGTERM, 55 s grace) + `docker start` of the same container. Each with the S3 trace on and `pg_stat_statements` reset: stop duration, ms to `rab-worker ready`, to the first passing image health command (docker exec, ~2 s) and to Docker's HEALTHCHECK healthy; S3 HEAD/LIST/GET/PUT, storage reconciles (`storage cleanup: checked=` lines) and SQL by role/query in the first `--boot-seconds`; launcher/jobs/provisioner processes; BullMQ `*repeat*` keys in Redis before/after (duplicate schedulers would show). | `boot-cold/`, `boot-restart/`, `storage-boot-*.json` |
| replicas | A fresh `costaudit-worker` and a second replica `costaudit-worker2` (compose profile `replica`, same image/config/limits, plus `--replicas-env`) started concurrently: reconciles completed per replica, S3 calls per replica (trace by client container), SQL, health timings; then worker2 is removed. Without a boot-time reconcile (Phase A) a leader lock has nothing to arbitrate in the window unless `--replicas-env` shortens the storage-cleanup interval (if the build offers such a variable). | `replicas/`, `storage-replicas.json` |

Configuration items (`--prov-configs`, `--replicas-env`): `KEY=VALUE` sets/overrides an env-file key; `-KEY` removes it;
`-CREWFLOW_PROVISIONER_DATABASE_URL` starts the worker WITHOUT the provisioner URL (compose passes that variable through
from `lib/common.sh` `load_secrets`, so leaving it unset makes it absent in the container). A configuration whose worker
does not stay up is recorded in `<out>/worker-env/<name>.REFUSED` and its window is skipped; compare.js reports it as
`refused`. When both runs have the `idleflags` window, compare.js takes its idle-SQL noise band from the code-identical
rows (flags-on SQL, provisioner 5 s rate) instead of O=0, because Phase A changes the O=0 loops (`COST_COMPARE_IDLE_CONTROL=o0`
restores the old rule).

`--worker-env-file <f>` adds KEY=VALUE lines to the worker for every phase (`<out>/worker-env/base.env`); every
configuration used is in `<out>/worker-env/*.config` and `worker-configs.log`. Keys compose already sets for the
worker are refused. `storageboot` now waits at most `COST_STORAGE_BOOT_MAX_S` (300 s) for the boot reconcile (a build
without one is observed for the full 300 s). `--skip load` leaves out the load phase (at 6242eeec it OOM-kills the
harness API on `/offers/mine` c=25, a pre-existing problem unrelated to Phase A). Windows use the heavy-run label
`COST_HEAVY_LABEL` (default `p6`).

Useful options:

| Option | Effect |
|---|---|
| `--idle-seconds 600` | Length of each idle window. The default is 600. |
| `--tree <worktree>` | Tree-snapshot mode (above): measure uncommitted work without committing. Requires `--out`. |
| `--skip <phases>` | Leaves the listed phases out (e.g. `--skip load`). |
| `--worker-env-file`, `--flags-idle-seconds`, `--prov-configs`, `--prov-seconds`, `--boot-seconds`, `--replica-seconds`, `--replicas-env` | Phase A measurement options (above). |
| `--only <phases>` | Runs only the listed phases, in the fixed order below. Use it to resume an interrupted run on the same stack, for example `--only idle5,seed20,storageboot,idle20,storage,endpoints,load,pdf,emails,shiftcycle,assemble`. With `--only`, the stack is not torn down. |
| `--keep` | Leaves the stack running at the end. |
| `--no-heavy-run` | Runs without the heavy-run wrapper. |
| `--check-isolation` / `--dry-run` | Runs every isolation guard and exits; starts nothing. Add `--with-infra` to also start and tear down only the harness infra. |
| `COST_API_CPUS`, `COST_API_MEM`, `COST_WORKER_CPUS`, `COST_WORKER_MEM` | Override the resource limits. |
| `COST_MAIN_CHECKOUT` | The main checkout watched by the drift guard and kept out of every path and mount. Default `C:/Rab-recruit`. |
| `COST_DEV_WATCH_REGEX` | Containers whose state is recorded and re-checked (report only). Default `^(rab-\|crewflow-test-)`. |

To compare two runs, first check their host conditions (see "Comparability on a shared host"), then diff their
`results.json` → `metrics[]`. Every metric has the same `metric` key in both runs.

## Phases (`scripts/run.sh`)

| Phase | What happens | Script |
|---|---|---|
| build | Builds the server and worker images from `git archive <commit>`, or from a tree snapshot (`--tree`) | `scripts/build-images.sh` |
| stack | Fresh Postgres (`pg_stat_statements`, `track=all`, `track_io_timing`), Redis (password), MinIO (SSE-S3 bucket). Runs migration phases A and B, then starts the API and worker. | `scripts/stack.sh` |
| idle0 | Waits for drain, then an idle window with 0 organisations | `scripts/measure.sh drain`, `measure.sh idle` |
| seed5 | Stops the worker, seeds orgs 1–5, backfills processed history, restarts the worker | `seed/seed.js`, `seed/backfill-reports.js` |
| idle5 | Waits for drain (≤ 5 rows written by the runtime role in 60 s), then an idle window at O=5 | `measure.sh drain`, `measure.sh idle` |
| seed20 | Stops the worker, seeds orgs 6–20, backfills history, then runs API uploads (100 avatars, 20 venue photos) | `seed/*`, `lib/files.js` |
| storageboot | Recreates the worker **with the S3 trace on**: the boot-time storage reconcile and boot jobs | `measure.sh storage-boot` |
| idle20 | Waits for drain, then an idle window at O=20 | `measure.sh drain`, `measure.sh idle` |
| idleflags, provisioner, bootprobe, replicas | Phase A measurement (section above) | `measure.sh worker-up / idle / boot-probe / replicas`, `lib/analyze-boot.js` |
| storage | Pauses the worker and runs `storage:reconcile` (report-only CLI) with the S3 trace on | `measure.sh storage-cli`, `lib/storage-ops.js` |
| endpoints | SQL per request, latency and bytes for 29 endpoints. Also runs the web-dashboard load and a `pg_stat_statements` cross-check. | `lib/endpoints.js` |
| load | autocannon over 8 scenarios, with the worker paused | `lib/loadtest.js`, `tools/` |
| pdf | 10 renders each of the roster and the final timesheet, using the real renderer at `--cpus=1` | `lib/pdf-bench.js` |
| emails | 200 forgot-password emails through the API and worker, measuring Redis bytes per completed job | `lib/emails-bullmq.js` |
| shiftcycle | Moves 20 upcoming shifts into the roster window. The real worker then renders, stores and emails each roster. **Runs last**, because it changes 20 shifts. | `lib/shift-cycle.js` |
| assemble | Writes `results.json`, `results-table.md` and `versions.txt` | `lib/assemble.js` |

Each measurement window runs inside `C:/rab-ai-wt/setup/heavy-run.sh p6 …`. Nothing else is stopped or started
around a window. After every phase (and after the build and at the very end) a checkpoint runs the dev-container
state guard, appends a host snapshot to `host-state.txt`, and runs the main-checkout drift guard, which aborts the run
on any change.

## Deterministic seed

The seed has 20 organisations × 50 users = 1,000 users. Each organisation has:

- 1 CEO, 2 managers, 3 venue managers and 44 staff;
- 3–5 venues;
- 31 days × 10 shifts: 20 past days, today, and 10 future days;
- 8 notifications per user.

Determinism comes from three choices:

- **Ids** come from a fixed-seed PRNG (`COST_SEED_RANDOM`, default 20261027) with one stream per organisation. Staged
  seeding (1–5, then 6–20) therefore produces exactly the rows a single run would. Backfill ids and object keys are
  derived from the shift id.
- **Fixed logical clock.** `COST_SEED_NOW` defaults to `2026-10-27T23:00:00Z`: after the day's last shift ends
  (22:00) and 7 h before the next one starts. As a result:
  - no shift falls inside the worker's 180-minute roster window;
  - no shift is in progress during the idle windows.

  The worker reads the real clock, so every timestamp is shifted by one constant: (run hour, UTC) −
  `COST_SEED_NOW`. Every run therefore sees the same past / in-progress / future mix. The shift is printed as the
  first line of `seed-1-5.log`. `COST_SEED_TRANSLATE=0` keeps the absolute dates.
- **History is processed.** One FINAL_TIMESHEET_PDF is rendered with the real renderer and stored for every completed
  shift. The post-shift stamps are set. Without this, the worker would spend hours catching up on 20 days of history,
  which is a seeding artefact.

## Metrics and labels

| Label | Meaning |
|---|---|
| **MEASURED** | Read directly from this run: counters, timers, traces |
| **DERIVED** | Computed from measured values (fits, ratios, per-unit divisions) or read from code paths. The method column says how. |
| **ASSUMED** | An input the harness chose: seed shape, concurrency, window lengths |
| **QUOTED** | From an external source: the old audit's numbers, R2 operation classes |

A projection is never labelled MEASURED.

| Metric | How it is measured |
|---|---|
| Idle SQL/min | `pg_stat_statements` delta over the idle window, worker only, no HTTP. Reported in three forms. **(a)** The old audit's definition: every statement executed as `crewflow_app`/`crewflow`, nested or not. **(b)** `toplevel=true` only, meaning statements the worker actually sent. **(c)** Statements nested inside SECURITY DEFINER functions, which run as `rab_secure_owner`. |
| Fitted formula | Least squares over O = 0, 5, 20 (DERIVED). W = O in this seed. |
| DB / worker / Redis CPU | cgroup v2 `cpu.stat` `usage_usec` delta ÷ window, as % of one core. Also `docker stats` samples every 15 s. |
| Worker memory | cgroup `memory.current` plus per-process `VmRSS`. **Indicative only**, because the VM swaps. |
| SQL per request | The API's own `request_complete` log: `sqlCount` excludes BEGIN, and `transactionCount` counts BEGINs (`engine/observability/request-context.ts`). Median of N=10 sequential requests after 2 warm-ups. Cross-checked with `pg_stat_statements` for `/dashboard/summary`, with the worker paused. |
| Dashboard load | The distinct API calls `rab-front` `Dashboard.tsx` makes at this commit: 15, plus the pipeline call only for a venue-requested shift. Fired 6 at a time; SQL and bytes are summed. The old 16-request set is also reported for comparison. |
| Load | autocannon 8.0.0 in a container on the cost network: `--cpus=2`, a distinct `cf-connecting-ip` per request, 30 s per scenario, with the concurrency shown per scenario. The worker is paused during each scenario. Reported: exact p50/p95/p99, cgroup CPU per request for the API, DB and Redis, and peak DB connections. `/offers/mine` also gets `pg_stat_statements` execution ms per request. |
| PDF CPU | Real `renderHtmlToPdf` (one Chromium launch per render) with the real templates, in the worker image: `--cpus=1 --memory=1g`, uid 1000. Container cgroup CPU per render, median of 10 after 1 warm-up. |
| Redis per job | 200 forgot-password emails through the API; the worker dispatches them with `EMAIL_DRIVER=LOGGER`. Redis `used_memory` delta ÷ jobs sent, plus the job-hash `MEMORY USAGE`. |
| Storage ops | MinIO `mc admin trace --json` from a separate tracer container records **every** S3 call. Calls are counted by API (HEAD/LIST/GET/PUT/DELETE) and by client container, and divided by `stored_file` rows. Measured three ways: the isolated `storage:reconcile` CLI, the worker boot (scheduled cleanup plus boot jobs), and the shift cycle. R2 Class A/B is DERIVED from the API mix. |
| Emails per shift | The shift cycle **measures** the roster stage. Adding the final-timesheet stage is DERIVED from code: recipients = venue managers of the venue, for both jobs. |

## Files

- `docker-compose.cost.yml`: the disposable stack, plus the ops containers (`migrate`, `tool`).
- `init/`: the `pg_stat_statements` extension, and roles with random passwords plus the disposable marker. The two
  files are bind-mounted individually.
- `lib/common.sh`: paths, ports and helpers. `lib/lib.js`: host-side Node helpers, including the Node container guard.
- `lib/guard.sh`: the isolation guards (container, project scope, ports/subnet, main-checkout drift, dev-container
  state, host-state record). `lib/check-compose.js`: static check of the rendered compose model.
- `lib/compare.js`: compares two results directories (`node lib/compare.js <baseline> <after> <out>` →
  `comparison.md`/`comparison.json`): Δ% per metric, noise bands from code-identical control metrics, and the
  roster-stage SQL per email by query fingerprint (from `shift-cycle.pgss-raw.csv`, idle-O20 background subtracted).
- `scripts/tree-snapshot.sh` (read-only worktree snapshot for `--tree`), `scripts/compare-images.sh` (dist file-by-file
  comparison of two image pairs), `lib/worker-env.sh` (per-phase worker configuration), `lib/analyze-boot.js` (boot /
  restart / replicas summaries), `init/empty.env` (default, empty worker env file).
- `scripts/`: `run.sh` (one command), `build-images.sh`, `gen-secrets.sh`, `stack.sh`, `measure.sh`,
  `storage-trace.sh`, `check-isolation.sh` (the `--check-isolation` mode) and `drift-guard.sh` (the drift guard on
  its own).
- `seed/`: `seed.js` and `backfill-reports.js`. Both run inside a container from the server image under test.
- `lib/`: `analyze-idle.js`, `endpoints.js`, `loadtest.js`, `pdf-bench.js`, `emails-bullmq.js`, `files.js`,
  `storage-ops.js`, `shift-cycle.js`, `assemble.js`.
- `tools/`: the load-generator image (autocannon 8.0.0, pinned by `package-lock.json`).

The results directory receives:

- `results.json`, `results-table.md` and `versions.txt`;
- `idle-O*/` with raw `pgss-raw.csv` and `pgss.txt` dumps, CPU/Redis/memory snapshots, `dstats-host.txt` (host
  contention) and `summary.json`;
- `endpoints-*.json`, `load-*.json`, `pdfbench.json`, `emails-bullmq.json`;
- `storage-*.trace.jsonl` with every S3 call, and `storage-*.json`;
- `shift-cycle.json`, and the seed, migration and drain logs;
- `host-state.txt`, `guard/` (compose check output, main-checkout and dev-container baselines and every checkpoint
  snapshot), and, only when something changed, `dev-containers-changes.log`, `main-checkout-drift-<phase>.txt`,
  `MAIN-CHECKOUT-DRIFT.txt` and `ABORTED.txt`.

## Known limitations

- **Memory.** Docker Desktop's VM has about 1.9 GB of RAM and swaps, shared with the dev stack and other agents.
  Memory figures are indicative, and swapping can also inflate latency tails.
- **Network.** Traffic stays on loopback and the Docker network, with no TLS and no VPC round trips. CPU per request
  carries over to production; wall-clock latency does not.
- **Runtime mode.** `NODE_ENV=development`, because production mode refuses the LOGGER email driver and loopback
  URLs. The caches are off, at their defaults. `HWS_RUNTIME_ENABLED=false` and `WORKER_SCHEDULER=interval`, as in the
  old audit.
- **Postgres** has no CPU limit, so its CPU % is measured, not capped.
- **Shared host.** The dev stack and other agents' containers keep running, so CPU contention from them is possible.
  heavy-run keeps heavy test suites out of each window, but not light activity. The contention is recorded, not
  removed; see "Comparability on a shared host".
- **Live clock.** Time keeps moving during a run of about 2 h. The logical clock leaves about 4 h before the first
  next-day shift enters the roster window.
