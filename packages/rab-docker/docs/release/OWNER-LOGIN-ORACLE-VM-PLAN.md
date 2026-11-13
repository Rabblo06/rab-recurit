# Owner-login deployment on the Oracle VM with plain Docker Compose: PLAN ONLY

**Status (2026-11-04): a plan. Nothing in it has been run.** No connection was made to the Oracle VM or to OpenShip; the
OpenShip connector is not authorised in this session. Every fact about the VM below is either from the repository
(`docker-compose.production.yml`, `docs/release/OPENSHIP-COMPATIBILITY.md`) or **TO VERIFY** in Phase 0. Executing any
phase needs owner approval.

**Two statements that frame everything below:**
1. **Localhost tests do not prove Oracle compatibility.** The local checks ran on Docker Desktop (WSL2, amd64): the compose gate and a disposable PG16 container. None of these was tested locally:
   - the VM's CPU architecture (arm64);
   - its kernel and cgroup version;
   - its Docker Engine and Compose versions;
   - its iptables / Oracle security lists;
   - its memory headroom next to the OpenShip stack;
   - OpenShip's own behaviour towards containers it did not create.

   Each needs its own evidence on the VM.
2. **OpenShip remains UNSUPPORTED for the owner-login deployment (M0 D11).** OpenShip drops these keys: `user`, `read_only`, `tmpfs`, `cap_drop`, `cap_add`, `security_opt`, `pids_limit`, `env_file` and the `depends_on` conditions. It also refuses long-form tmpfs. Imported through OpenShip, the Worker (image USER root, no root launcher any more) would run **as root**. This plan therefore runs the stack **beside** OpenShip with the Docker Compose CLI, never **through** it. Supporting OpenShip would need either a USER-1000 Worker image (a release-workflow change) or an OpenShip change; both are deferred.

The temporary OpenShip deployment (rab-api / rab-worker / rab-redis, Neon database) is **not touched** by any step:
- no redeploy, no settings change, no restart, no prune;
- its Neon database is never used.

**One dependency to settle before Phase 2.** The in-place edit of `docker-compose.production.yml` changes the file OpenShip deploys from `main` (`OWNER-LOGIN-DEPLOYMENT.md` section 6). Before that PR merges, the owner must decide:
- **either** disable OpenShip's auto-deploy;
- **or** accept that the temporary deployment stops.

## Phase 0: read-only discovery (owner runs, or approves an SSH session)

| # | Command (read-only) | Decides |
|---|---|---|
| 0.1 | `uname -m; nproc; free -m; df -h / /var/lib/docker` | arm64 confirmed. CPU and memory headroom. Disk for ~2–3 GB of images plus volumes. |
| 0.2 | `docker version; docker compose version; docker info --format '{{.CgroupVersion}} {{.SecurityOptions}} {{.LoggingDriver}} {{.Driver}}'` | Compose ≥ **2.24** is needed: `env_file` `path`/`required`, long-form tmpfs. Check cgroup v2 (pids/memory limits) and seccomp/apparmor. If the compose plugin is missing or older, installing it is a **host change that NEEDS OWNER APPROVAL**. |
| 0.3 | `docker ps -a --format '{{.Names}} {{.Image}} {{.Ports}} {{.Label "com.docker.compose.project"}}'` | The existing containers and projects. Choose a project name that cannot collide; proposal: `crewflow` (`-p crewflow`). |
| 0.4 | `docker network ls; docker volume ls` | `<project>_default`, `<project>_crewflow-db`, `<project>_rab-redis-data` and `<project>_crewflow-pg-data` must be free. Note the subnets in use. |
| 0.5 | `sudo ss -ltnp` | Which host ports are taken. Expected: OpenShip's OpenResty on 80/443, and the old rab-api on **3000 on every interface** (the production compose has `"3000:3000"`). Pick a free loopback port; proposal: 3100. |
| 0.6 | `sudo iptables -S` or `sudo nft list ruleset`, plus the VCN security list | **No new inbound port** is needed. Confirm egress to the database host:5432, S3/R2 443, SMTP 587 and the registry 443. |
| 0.7 | OpenShip version, then its source at that tag (`prune`, `removeContainer`, reconcile loops over label-less resources) | **If OpenShip removes or restarts resources it does not own, this stack must not share its Docker daemon:** use a separate VM. |
| 0.8 | `cat /etc/docker/daemon.json` | `live-restore`, the default log driver and `userns-remap`. With userns-remap the bind-mount uid guidance (70 / 999:1000 / 1000) changes. |

## Phase 1: decisions (owner)

1. **Database.**
   - (a) A managed PostgreSQL 16, 17 or 18. Its admin URL (CREATEROLE, able to grant on the database) goes in `PG_DATABASE_ADMIN_URL` in `compose.env`; the one-shot `db-setup` service creates `crewflow_owner` (DB-SETUP; PR #125 option A: rab-api / rab-worker never receive the admin URL; `01-crewflow-owner.sql` is an optional fallback). The direct host must be reachable from the VCN. DigitalOcean is the final home. Never Neon / adolphus without approval.
   - (b) The bundled `db` service of `docker-compose.image.yml` (DB-SETUP; `docker-compose.local-db.yml` is retired): the Debian `postgres:16` index digest (multi-platform, arm64 included), only `PG_DATABASE_PASSWORD` to set, its own CA, internal network, no host port, backups as in the runbook 3.3.

   **Recommendation: (a) for anything that holds real data; (b) for a trial.**
2. **Edge.** OpenResty owns 80/443. Options:
   - (A) **Cloudflare Tunnel** (`cloudflared`, outbound only) to `127.0.0.1:3100`; `TRUSTED_PROXY_CIDRS=127.0.0.1/32`. It does not touch OpenShip and matches the final Cloudflare plan. **Recommended.**
   - (B) An OpenShip route to an external upstream. TO VERIFY that OpenShip supports one. It is a change **inside OpenShip** and NEEDS OWNER APPROVAL.
   - (C) A second proxy on other public ports. **Not recommended.**

   The API is never published on `0.0.0.0` (the gate refuses it).
3. **Resources.** The limits are ≈ 4.2 GB in total, **plus** the OpenShip stack (API 768 MB, Worker 1536 MB, Redis unbounded):
   - API 1 GB / 2 CPU;
   - Worker 1.5 GB / 2 CPU / 1024 pids;
   - Redis 640 MB / 1 CPU;
   - bundled PostgreSQL 1 GB / 2 CPU.

   `cpus` must be ≤ `nproc`. If free memory is under ~8 GB, lower a limit only after measuring. With #61's native renderer, keep `PDF_NATIVE_MEMORY_BUDGET_MB` consistent with the Worker limit.
4. **Images.** The index digests must include **linux/arm64**:
   ```bash
   docker buildx imagetools inspect <repo>@<digest>
   ```
   REPORT-G recorded native arm64 PDF renders for the Chromium-free Worker (#63).

## Phase 2: install (after Phases 0–1, the in-place PR, and owner approval)

1. **Host layout.** Root-owned, mode 0700:
   - `/etc/crewflow/compose.env`;
   - `/etc/crewflow/secrets/{database.env,runtime.env,redis-users.acl}`, plus `pg-tls/` and the two password files if bundled;
   - the release checkout at an exact commit, read-only, under `/opt/crewflow/release`.

   **Nothing goes in OpenShip's directories.**
2. `compose.env`:
   - `CREWFLOW_API_HOST_PORT=3100` (the port from 0.5);
   - `CREWFLOW_API_BIND=127.0.0.1`;
   - arm64-capable digests;
   - CPU limits ≤ nproc.
3. **Lint and render.** `--lint-env-file` for all three files, then:
   ```bash
   docker compose -p crewflow --env-file /etc/crewflow/compose.env -f docker-compose.image.yml config -q
   ```
4. **Pull, then follow the runbook:** section 2 (fresh) or section 5 (transition), then section 3 (O3: back up first, then stop-then-start; the API migrates on start). Always pass `-p crewflow`, `--env-file` and the explicit `-f` list. Never run `docker compose up` in a directory that OpenShip manages.
5. **Edge (decision 2), then the smoke checks:**
   - `/healthz` through the edge;
   - the Worker health;
   - `docker inspect`: `User=1000:1000`, `ReadonlyRootfs=true`, `CapDrop=[ALL]` and no-new-privileges on rab-api and rab-worker (O3: there is no rab-migrate);
   - `/proc/1/status`: `CapBnd: 0000000000000000` and `NoNewPrivs: 1`;
   - one PDF render on arm64.

## Phase 3: coexistence checks (read-only)

- The OpenShip stack still answers as before. Diff `docker ps -a`, `docker network ls` and `docker volume ls` against Phase 0: OpenShip's entries are unchanged.
- No new listening socket except `127.0.0.1:3100`.
- `docker stats --no-stream` for both stacks; no OOM kills (`dmesg | grep -i oom`).
- Observe one OpenShip redeploy, if one happens, and confirm the `crewflow` project is untouched.

## Phase 4: rollback (removes this stack only; OpenShip is never part of it)

1. Edge first: stop `cloudflared`, or remove the approved OpenShip route.
2. Stop the stack, keeping the data:
   ```bash
   docker compose -p crewflow --env-file … -f … down
   ```
   Never use `-v`.
3. **Data:**
   - managed database: nothing to do on the VM. A transitioned database follows runbook 5.9;
   - bundled: back up first, then remove volumes **by exact name** only on the owner's decision.
4. Remove images **by exact digest**. **Never** run `docker system prune`, `docker volume prune` or `docker image prune -a` on this host: they would also delete OpenShip's stopped containers, unused volumes and rollback images.
5. Revoke the secrets at their sources, then remove `/etc/crewflow` and `/opt/crewflow`.

## Risks specific to this host

| Risk | Mitigation |
|---|---|
| OpenShip prunes or reconciles unknown containers (0.7 unknown) | Verify from its source first. If it does, use a separate VM. |
| `main` merges redeploy OpenShip from `docker-compose.production.yml` | Owner decision before the in-place PR merges (above). |
| Port 3000 is taken by the old rab-api on every interface | Use a different loopback port. The old exposure is pre-existing (report only). |
| Memory contention | Sum the limits against `free -m`. Measure before changing a limit. |
| arm64 differences | arm64 digests, plus the arm64 PDF smoke in 2.5. |
| Old Docker or Compose | 0.2. An upgrade is a host change that needs approval. |
| Owner-login posture (PT-01) on a shared daemon | A container escape in either stack reaches both. Prefer a dedicated VM beyond a trial. |
