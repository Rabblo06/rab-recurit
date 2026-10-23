# Crewflow — four core services: workspace provisioner inside the Worker service

Date: 2026-10-22. Branch: `feat/venue-manager-teams-ui` (dirty working tree shared with other sessions; nothing of theirs was
overwritten). **Nothing was committed, pushed, deployed or migrated on any shared/remote database. No Neon, OpenShip,
DigitalOcean or Cloudflare connection was made. The owner's running dev containers were not touched.**

Overall result: **PARTIAL** — source implemented and every local launcher, container-isolation and database/provisioning
integration test passed (30/30 + 26/26 + 32/32), but OpenShip compatibility could not be verified (no access) and the
arm64 build of the bundle was not run. Deployment is gated on §9.

Companion: `CREWFLOW_TWENTY_STYLE_ARCHITECTURE_REPORT.md` (architecture, Twenty comparison, environment matrix, verdict).

---

## 1. Separately stated results

| Category | Status | Evidence |
|---|---|---|
| **Source implemented** | YES | §4 file list |
| **Launcher tests passed** | YES — 30/30 on the real bundle image (node v24.20.0, Alpine 3.24.1, x86_64, as root); the supplied reference tests also re-run unchanged: 11/11 | `docs/evidence/worker-bundle-2026-10-22/03-launcher-tests.log`, `03a-reference-launcher-tests.log` |
| **Container isolation verified** | YES, locally, on Docker 29.8.1 Linux containers (cases 11b–15, 22, 23, 28, 31, 32) | `docs/evidence/worker-bundle-2026-10-22/integration/` |
| **Database/provisioning integration verified** | YES, locally, against a throwaway PostgreSQL 16 migrated by the guarded runner (cases 10, 15–21, 24–27, 29, 30) | same directory, `SUMMARY.md` |
| **OpenShip compatibility verified** | **NO — BLOCKED** (no access; nothing contacted). Specific open points in §9 | — |
| **Deployment performed** | **NO** | — |

Additional unit run: `runtime-database-guard.spec.ts` 32/32 (incl. new case 8d2), via the repo's own test-database guard
pointed at a throwaway container (`05-runtime-guard-unit.log`).

---

## 2. Current vs proposed architecture

**Before (production compose as rewritten earlier today):** 5 always-on services + 1 one-off —
`rab-api`, `rab-worker` (jobs, `crewflow_app`), `rab-provisioner` (`crewflow`), `rab-redis`, PostgreSQL (Neon, external),
`rab-migrate` (profile-gated, explicitly approved runs only).

**After:** 4 core services + the same one-off —
`rab-api` (unchanged), **`rab-worker` = one container, two supervised OS processes**, `rab-redis`, PostgreSQL (external);
`rab-migrate` unchanged. Frontend (Vercel) and R2 storage stay external and are not represented by fake services.

```
rab-worker container (read-only root, cap_drop ALL + SETUID/SETGID/KILL, no-new-privileges)
 PID 1  tini -s
  └─ node /opt/crewflow-bundle/start-worker-bundle.cjs        uid 0 (supervisor only; holds CREWFLOW_PROVISIONER_DATABASE_URL)
      ├─ node packages/rab-worker/dist/main.js                 uid/gid 1000,  no caps, no groups  → crewflow_app (pooled + direct)
      └─ node packages/rab-worker/dist/workspace-provisioner.main.js  uid/gid 10001, no caps, no groups → crewflow (direct)
```

Unlike Twenty, workspace DDL is **not** moved into the API/HTTP process and no startup migration was added.

---

## 3. Reconciling the supplied reference

Kept: separate Dockerfile FROM the shared image, root launcher + two UIDs, explicit env, fail-whole-service, process-group
kill, bounded shutdown, preflight dotenv refusal. Changed, with reasons:

| Reference | Integrated | Why |
|---|---|---|
| `WORKER_KEYS` (39 names; stale `SMTP_*`, wrong `S3_SSE_KMS_KEY_ID`, no push/keyring/realtime keys) | 88-key allowlist reconciled against `environment-variables.ts` + direct `process.env` reads; launcher test 14 fails if the validator gains a key the allowlist lacks | otherwise push/encryption/mail/storage would break silently |
| Required global `HWS_RUNTIME_ENABLED=true`, forwarded to jobs | Forced `true` for the provisioner child only; jobs keeps the service value (unset in prod) | on the API/jobs it switches runtime schema routing — a separate, unapproved cutover |
| SIGTERM to each child's process **group** | SIGTERM to the child **pid**; group + UID sweep SIGKILL only after exit / at the deadline | group SIGTERM would kill a Chromium render mid-drain |
| No descendant sweep beyond the group | Kill every process owned by a child UID at stop | Playwright starts Chromium detached (own group) |
| Health left as TODO | Per-instance heartbeat files + `worker-bundle-health.cjs` + watchdog | global Redis keys are masked by replicas (proven, case 22) |
| Only string checks on URLs | + Neon pooler refusal, migration/bootstrap variable refusal, and a **live** cross-check of both children's own `[runtime-db-guard] … cluster=` lines | proves the three routes reach the same physical cluster (case 15, 27) |
| graceMs 35 s / stop 45 s | 42 s / 55 s | the jobs process's own deadline is 30 s drain + 10 s hard exit |
| Launcher at `/app/start-worker-bundle.cjs` | `/opt/crewflow-bundle/` (0444 files, 0755 dir) | keep out of the app tree; COPY --chmod made the dir 0444, which root without CAP_DAC_* cannot traverse (found and fixed) |
| No init | tini in the image (`-s`) | zombie reaping without relying on platform `init:` support |
| Immediate exit on failure | 30 s delayed exit when failing within 60 s of start | bounds restart cadence on platforms without back-off |

---

## 4. Files

Added:
- `packages/rab-docker/rab/Dockerfile.worker-bundle`
- `packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs` (launcher)
- `packages/rab-docker/rab/worker-bundle/worker-bundle-health.cjs` (health check, both roles)
- `packages/rab-docker/rab/worker-bundle/test/launcher.test.cjs` (30 cases)
- `packages/rab-docker/rab/worker-bundle/test/integration/{run-integration.cjs, docker-compose.bundle-test.yml, smtp-sink.cjs}`
- `packages/rab-worker/src/core/runtime/instance-heartbeat.ts`
- `CREWFLOW_FOUR_SERVICE_WORKER_BUNDLE_REPORT.md`, `CREWFLOW_TWENTY_STYLE_ARCHITECTURE_REPORT.md`

Modified (every source change justified):
- `packages/rab-worker/src/core/runtime/worker-runtime.ts` — additive `progress()` (last settled/succeeded cycle, oldest
  in-flight cycle). Needed because the existing heartbeats are global keys; nothing written to Redis changed.
- `packages/rab-worker/src/main.ts`, `workspace-provisioner.main.ts` — one heartbeat hook each (no-op unless
  `CREWFLOW_INSTANCE_HEALTH_FILE` is set; the Redis write is unchanged). No provisioning/job logic touched.
- `packages/rab-server/src/database/typeorm/core/runtime-database-guard.ts` (+ spec 8d2) — **finding fixed** (below).
- `packages/rab-docker/docker-compose.yml` (dev worker → bundle; `provisioner` service removed),
  `packages/rab-docker/docker-compose.production.yml` (rab-worker → bundle; rab-provisioner removed; API comment).
- `THREAT-MODEL.md` (new entry), `packages/rab-docs/developers/{deployment,introduction,background-jobs}.mdx`.
- Local (git-ignored): `docs/PRODUCTION_RELEASE_RUNBOOK_2026-10-22.md` §12, `docs/HANDOFF.md`,
  `docs/architecture/WORKSPACE-PROVISIONER-OPERATIONS.md`, `docs/evidence/worker-bundle-2026-10-22/**` (incl. the
  five-service compose kept for rollback).

Not changed: `render.yaml` (stale: `start-worker.sh`, `DATABASE_URL_UNPOOLED` on the worker — would now be refused),
`docker-compose.qa.yml` (stale: worker logs in as `crewflow`), provisioning logic, migrations, roles, RLS.

```
[MEDIUM] (fixed)
Failure:    operator → puts CREWFLOW_PROVISIONER_DATABASE_URL on rab-api (or a shared env group) → the HTTP process
            holds the privileged crewflow credential without any refusal
Actor:      deployment operator / misconfigured platform env group
Location:   packages/rab-server/src/database/typeorm/core/runtime-database-guard.ts (resolveRuntimeDatabase)
Root cause: the guard only refused DATABASE_URL_UNPOOLED; the new launcher-only variable name was unknown to it
Fix:        same guard pattern — refuse a non-empty CREWFLOW_PROVISIONER_DATABASE_URL in api/worker/provisioner
Regression: runtime-database-guard.spec.ts 8d2; integration 11b (API) and 18 (jobs entrypoint)
```

---

## 5. Child environment manifests (reviewed allowlists; nothing else is ever forwarded)

- **Launcher (root) receives** the service environment. Refuses if non-empty: `DATABASE_URL_UNPOOLED`,
  `CREWFLOW_MIGRATION_APPROVED|_DATABASE_URL|_PHASE`, `CREWFLOW_BOOTSTRAP_PASSWORD`, `CREWFLOW_APP_BOOTSTRAP_PASSWORD`,
  `ALLOW_PRODUCTION_DB_COMMANDS`. Requires `DATABASE_URL` + `DATABASE_DIRECT_URL` (login `crewflow_app`, direct not
  `-pooler`), `CREWFLOW_PROVISIONER_DATABASE_URL` (login `crewflow`, direct), same database name, `REDIS_URL`;
  production also `RAB_RUNTIME_ENV=production` + `TRUSTED_PROXY_CIDRS`. Never logs values (cases 10, 25, 26, 32).
- **Jobs child (uid 1000):** `JOBS_ENV_KEYS` in the launcher (runtime identity, `DATABASE_URL`, `DATABASE_DIRECT_URL`,
  `DB_POOL_MAX`, `REDIS_URL`, `APP_SECRET` + keyrings, URLs/CORS/`TRUSTED_PROXY_CIDRS`, caches/cutover flags, sign-in
  provider config, email, storage/S3, push/APNs/FCM, realtime, business timings, Chromium) + `PATH`, `HOME`/`TMPDIR`
  (= `/tmp/crewflow-jobs`), `CREWFLOW_INSTANCE_HEALTH_FILE`. Absent by construction: `DATABASE_URL_UNPOOLED`,
  `CREWFLOW_*`, `DB_TARGET`, `ALLOW_*`, `BOOTSTRAP_ADMIN_*`, `TEST_*`, `AUTH_*_ISSUER_URL`, `NODE_OPTIONS`,
  `DOTENV_CONFIG_*`, unknown keys. Verified on the live `/proc/<pid>/environ` (case 13).
- **Provisioner child (uid 10001):** exactly `NODE_ENV`, `RAB_RUNTIME_ENV`, `TZ`, `REDIS_URL`, `SENTRY_DSN` (if set) +
  `DATABASE_URL` = `DATABASE_URL_UNPOOLED` = the provisioning URL, `HWS_RUNTIME_ENABLED=true`, `PATH`, `HOME`/`TMPDIR`
  (= `/tmp/crewflow-provisioner`), `CREWFLOW_INSTANCE_HEALTH_FILE`. No `APP_SECRET`, email, storage, push or sign-in
  secrets (case 13 asserts the exact key set).

---

## 6. Image and configuration

- Shared image unchanged except the guard fix (final stage still `rab`; no stage appended). Bundle image: `chown -R
  root:root /app` + `chmod -R go-w`, `start.sh`/`start-worker.sh` removed, `/app/storage` 1000:1000 0750, per-child
  0700 temp dirs and 0755 health dirs, tini ENTRYPOINT, HEALTHCHECK. Build asserts both entrypoints, rab-server/shared/
  ui/emails outputs, Chromium, and the absence of dotenv files. Verified in the image: 0 non-root-owned files and 0
  writable non-symlink files under `/app`; Chromium 152 + 61 fonts; module graphs load as each UID (`04-image-contents.log`).
- **Cost:** bundle image 4.32 GB vs 3.06 GB shared (the ownership layer duplicates `node_modules`, ≈1.1 GB).
- Production compose rab-worker: `user 0:0`, `read_only`, 4 tmpfs (uid/gid/mode), `cap_drop ALL`, `cap_add
  SETUID/SETGID/KILL`, `no-new-privileges`, `stop_grace_period 55s`, healthcheck = `worker-bundle-health.cjs`, build via
  `additional_contexts: crewflow-app: service:rab-api` (override `CREWFLOW_BASE_IMAGE` with a digest-pinned registry
  image if the platform cannot). Local proof of that build path: `06-production-compose-build.log`.
- No Docker socket, no host PID, no privileged mode, no exposed or inspector ports, no shared writable code mount, no
  dotenv mount, volumes unchanged, no second PostgreSQL in any default topology.

---

## 7. Tests run (all local, isolated; nothing else touched)

Launcher (30, in the image as root): env separation and forbidden keys (1, 2, 4–10, 12, 13), allowlist ⊇ validator (14),
distinct non-root identities (3), real child UID/GID/no groups/CapEff=CapPrm=CapAmb=0 (22), failed child stops survivor
(11), zero exit = failure (15), SIGTERM forwarded to pid with drains awaited (16), SIGINT + double-signal force (16b),
bounded SIGKILL (17), detached grandchild killed (18), watchdog kills a hung child without waiting for grace (19), live
cluster/role cross-check (20, 21), preflight refusals (23, 24), no secrets in refusals (10, 25), health evaluation incl.
each single-role failure (26–28), compiled heartbeat writer (29).

Integration (26 cases, compose project `crewflow-bundle-test`, throwaway PostgreSQL 16 + Redis 7 + SMTP sink; migrations
run only there, phase A as `rab_owner` then phase B as the container superuser; 188 migrations):

| # | What was proven |
|---|---|
| 10 | Isolated stack, guarded migrations, `crewflow`/`crewflow_app` NOSUPERUSER NOBYPASSRLS |
| 11, 11b | Both children start; API logs `role=crewflow_app`; API refuses `DATABASE_URL_UNPOOLED` **and** `CREWFLOW_PROVISIONER_DATABASE_URL` |
| 12 | Real `/proc`: jobs 1000/1000, provisioner 10001/10001, no groups, caps 0, NoNewPrivs 1; launcher CapEff=CapBnd=0xe0 |
| 13 | Live environ key sets match §5 |
| 14, 28 | As uid 1000: provisioner/launcher/PID 1 environ, mem, fds, temp dir → denied; kill/STOP → denied; heartbeat forge → denied; every code/launcher/dotenv write → EROFS/EACCES (read-only) and EACCES (writable root, ownership alone); 0 dotenv files; 0 readable files and 0 readable environs containing the provisioning password (whole-filesystem grep); same write denials as uid 10001 |
| 15 | `pg_stat_activity`: api `crewflow_app`=1, worker `crewflow`=1, worker `crewflow_app`=3; cluster id equals the live probes'; `crewflow_app` owns 0 objects, no memberships |
| 16 | Synthetic CREATING workspace → READY: 21 tables, all ENABLE+FORCE RLS, 39 policies, 73 grants to `crewflow_app`, owner `rab_secure_owner`, registry `READY v1` |
| 17 | `crewflow_app`: CREATE SCHEMA/TABLE, DROP, DISABLE RLS, `provision_workspace_schema`, SET ROLE crewflow → all refused; RLS rows: no context 0, own 1, other workspace's context 0 |
| 18 | Legacy workspace untouched; no startup migration (188→188); 14 job loops completed; jobs entrypoint refuses injected `DATABASE_URL_UNPOOLED` and `CREWFLOW_PROVISIONER_DATABASE_URL` |
| 19 | Real forgot-password email via the jobs process → SMTP sink; outbox `SENT` |
| 20, 20b | Chromium render as uid 1000 under read-only root; **real scheduled pre-shift report**: PDF generated, stored (LOCAL volume), emailed to the venue manager via the sink |
| 21 | Two bundles, 6 workspaces raced → 1 registry row + 1 schema each, no failures |
| 22 | Hung (SIGSTOP) provisioner in replica B: B health names it while the **global** provisioner key stays fresh (TTL 27 s, age 2.8 s, written by A); watchdog kills it at 93 s, service restarts, healthy again |
| 23 | SIGKILL jobs, clean exit-0 jobs, SIGKILL provisioner → each fails the service, survivor drains cleanly, exit 1, restart; exactly one of each child afterwards |
| 24 | Provisioner killed while blocked inside its apply transaction (`CREATE TABLE … payroll_run`): status CREATING/PROVISIONING, 0 tables (rolled back); after restart → READY, 1 registry row, 1 schema, full structure |
| 25 | Forced failure → FAILED (`SQLSTATE 42501` recorded) → cause removed → retried to READY |
| 26 | Missing secret, invalid URL, runtime role as provisioner, privileged role as jobs, `DATABASE_URL_UNPOOLED`, migration approval, wrong password (live probe 28P01) → all refused, raw output contains no value |
| 27 | Provisioner URL on a different cluster → `live identity probes disagree`; `crewflow_app` temporarily given BYPASSRLS on the throwaway DB → the jobs child's live role guard refuses (restored after) |
| 29 | Redis down ~2 min: both roles reported unhealthy, 0 restarts, recovered; PostgreSQL state identical before/after (migrations, lifecycle, outbox, reports, users; 0 inconsistencies) |
| 30 | PostgreSQL down 77 s: 4 restarts total (finding below), healthy again after it returned |
| 31 | `docker stop`: SIGTERM forwarded, both drains logged, exit 0 in 0.7 s; after restart exactly tini + launcher + one jobs + one provisioner; 0 zombies |
| 32 | 0 occurrences of any synthetic password/APP_SECRET in raw service logs, start-attempt outputs or evidence files |
| 33 | Compose files: every PostgreSQL/Redis service has `pg_isready` / `redis-cli ping`; production has no PostgreSQL service (managed) |

Not covered / limits: no in-flight long cycle was interrupted by `docker stop` in integration (drain waiting is proven by
launcher tests 16/16b); push and in-app notification delivery not exercised (push disabled); `docker exec` was used to
impersonate the child UIDs (same uid/gid; real children's attributes proven separately in 12); x86_64 only.

**Finding (pre-existing, made more visible by bundling):**
```
[LOW]
Failure:    PostgreSQL connection drop → provisioner's single pg Client emits an unhandled 'error' → provisioner exits →
            the bundle stops the jobs process too (shared fate) → restart loop until the DB is back (bounded: 30 s delay)
Actor:      infrastructure event (DB restart/failover), no attacker
Location:   packages/rab-worker/src/workspace-provisioner.main.ts (provisioningClient has no 'error' listener)
Root cause: no reconnect/error handling on the long-lived provisioning Client (same crash as the standalone service)
Fix:        provisioner-local: handle 'error' and reconnect on the next cycle (not done — provisioning code left unchanged)
Regression: integration case 30 should then show 0 restarts
```

---

## 8. Health and replica masking

Health (`worker-bundle-health.cjs`, bounded: two local files + `/proc`, no network) is unhealthy if either role has: no
heartbeat file; a dead pid or wrong uid; heartbeat older than 45 s; no successful Redis write for 90 s; no cycle finished
or succeeded for 5 min; a cycle in flight longer than 30 min (jobs) / 10 min (provisioner). The launcher ends the service
only for an exited child or a heartbeat stale for 90 s — dependency outages are reported, not restarted (case 29).
Global keys `rab:worker:heartbeat`, `rab:workspace-provisioner:heartbeat`, `rab:worker:stats` are written by every
replica (and the provisioner and jobs share the stats hash); they cannot show a failed child in one replica (case 22).
API `/healthz` is never used for the Worker.

---

## 9. OpenShip limitations (unverified — must be checked before cutover, runbook §12.3)

OpenShip must honour, for rab-worker: `user: "0:0"`, `read_only`, tmpfs with `uid/gid/mode`, `cap_drop`/`cap_add`,
`security_opt no-new-privileges`, `stop_grace_period 55s`, the healthcheck, and `additional_contexts: service:` (or a
registry base image). Earlier notes say it does not support `build.target`; whether it supports any of the above is
unknown. If any is dropped the launcher refuses or isolation is weaker — **stop and keep the five-service layout**; never
collapse to one UID or remove guards. Also unverified: arm64 build (tini/chromium/chown layer on the Ampere VPS) and the
extra ~1.1 GB disk.

---

## 10. Security trade-off

```
SECURITY TRADE-OFF
Decision:   Run the privileged workspace provisioner (crewflow) as a second process inside the Worker container, under a
            root supervisor, instead of as its own container/service.
Reason:     Owner goal of four core deployment services; the separate provisioner was a fifth always-on service.
Risk:       A kernel/container-runtime escape or Linux privilege escalation reachable from the jobs process (untrusted
            payloads, Chromium) lands in a namespace where root holds the provisioning credential; shared network
            namespace, /dev/shm, Redis and restart/OOM fate (a DB drop now restarts the jobs process too, §7 finding).
Mitigation: Distinct non-root UID/GID per child, no capabilities, no-new-privileges, read-only root-owned code, per-child
            0700 tmpfs, explicit env allowlists, no dotenv, no socket/host PID/privileged; launcher caps only
            SETUID/SETGID/KILL; all DB identity/role/RLS guards unchanged and re-proven; live cluster cross-check.
Reversal:   Restore the five-service compose (runbook §12.6) — packaging only, no schema/role/data change.
```
Same-container isolation is **not** equal to separate-container isolation. Additional accepted points: `docker exec`
into rab-worker inherits the container environment (incl. the provisioning URL) — operator access is privileged; image
+1.1 GB.

---

## 11. Owner decisions

1. Ship the bundle with the role-cutover release, or (recommended) cutover with five services first, bundle second.
2. Confirm OpenShip supports §9 (or move the Worker to a platform that does); provide a registry base image if
   `additional_contexts` is unsupported.
3. Accept the §10 trade-off, or keep the standalone provisioner.
4. Whether to fix the provisioner's DB-drop crash (§7 finding) before bundling.
5. Rework or retire `render.yaml` / `docker-compose.qa.yml` (both stale, untouched).

Rollback: runbook §12.6 — restore the five-service compose (`docs/evidence/worker-bundle-2026-10-22/
docker-compose.production.five-service.yml`), move the provisioning URL back to rab-provisioner. No database, role or
schema change is involved.
