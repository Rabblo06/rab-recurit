# Isolated staging environment runbook (owner decision R4)

> **Owner login, one image, migrate on start (rewritten 2026-11-24, X5.1 / decision 35 F2).** Staging runs exactly the
> production deployment: `docker-compose.image.yml` plus `staging/docker-compose.staging.yml` (project name and storage
> prefix only), ONE `crewflow_owner` login, the shared templates in `packages/rab-docker/env/` (`compose.env`,
> `database.env`, `runtime.env`, `redis-users.acl`) filled with staging-only values, one image variable
> `CREWFLOW_IMAGE_TAG` (a `sha256:` index digest) and one command (`docker compose pull && docker compose up -d`): the API
> migrates on start, the Worker starts when the API is healthy. The separated-mode release step (`rab-migrate`,
> `.env.migrate`, phases A/B, `crewflow_migrator`, per-service `api.env` / `worker.env`, `staging/env/*.example`) no
> longer exists and is no longer described here. Upgrades use the floor in `OWNER-LOGIN-DEPLOYMENT.md` §3.2a.

Status: **PLAN, 2026-11-03. Nothing is provisioned.** This runbook creates no host, database, bucket, DNS record or secret.
Every numbered phase below needs its own owner approval. The temporary OpenShip/Neon deployment is not touched by any
step (R4), and no production credential, host or bucket is used anywhere.

Provider-neutral, using the Infrastructure agent's reference architecture (topology A: one VM with Compose, self-hosted
PostgreSQL 16, Redis 7 and an edge proxy). DigitalOcean is the intended provider; provider-specific notes are marked
**[DO]**.

Companion documents:
- `MIGRATION-AND-ROLLBACK-PLAN.md`: pending lists, preflight, backup/restore, rollback;
- `OPENSHIP-COMPATIBILITY.md`: why this stack runs on plain `docker compose`, not through OpenShip;
- `../phase-d-deployment-runbook.md`: Phase D;
- `../hosting/` (Infrastructure agent): host, PostgreSQL, Redis, backup and edge templates. **Pending owner approval.**
  This runbook assumes they are merged.

Placeholders: `<like-this>`. Never paste a real value into this file, a ticket or a terminal history.

## 1. Topology and isolation

| Component | Staging | Never shared with |
|---|---|---|
| Compute | One VM, 4 vCPU / 8 GB / 80 GB SSD, Ubuntu LTS, Docker Engine + Compose v5 (the environment preflight needs a Compose that reports env_file under --no-env-resolution: verified 5.6.1; v2.38/v2.39 do not, and the preflight refuses them) **[DO]** a Basic or General Purpose Droplet in its own project | production, the temporary deployment |
| Network | Provider firewall: inbound 443 (and 80 for ACME) to the edge only, SSH from an allow-list or VPN. PostgreSQL and Redis publish no port. rab-api is bound to `127.0.0.1:3000` behind the edge | — |
| PostgreSQL 16 | Self-hosted on the same VM: the Infrastructure templates, TLS with a private staging CA, the dotted alias `postgres.crewflow-staging.internal`, scram-sha-256 | Its own cluster, roles and passwords |
| Redis 7 | The variant's `rab-redis`: AOF, noeviction, ACL users `crewflow` / `healthcheck` / `ops` (disabled), `default` disabled | Its own ACL file and password |
| Object storage | A staging-only bucket, with an access key scoped to that bucket only **[DO]** Spaces, or R2 in a separate bucket | Never the production bucket or its keys |
| Email | A sandbox or staging-only sender (never the production SMTP/Resend credential) | — |
| Registry pull | A Docker Hub **read-only** access token for `adhin007/adolphus`, used only on this VM | Never a token with write scope |
| DNS / TLS | `staging.<domain>` (frontend) and `api.staging.<domain>`; the edge gets its own certificate | — |
| Errors | A separate Sentry project (optional) | — |
| Backups | A bucket at a **different** provider, staging prefix, its own write-only key; encrypted to an offline key | — |
| Deployment identity | `CREWFLOW_DEPLOYMENT_ENVIRONMENT=production`, `CREWFLOW_DEPLOYMENT_ID=<fresh staging UUID>` (§2) | Production's id |

## 2. Why staging is "production-classified" (NEEDS OWNER APPROVAL)

The code has **no staging command path**:
- `DB_TARGET=staging` is refused (`core/database-target.ts`);
- a `NODE_ENV=production` process must declare `CREWFLOW_DEPLOYMENT_ENVIRONMENT=production`, and the database marker
  must agree.

A production-like staging is therefore a production-classified deployment with its **own** deployment id, database,
host names and credentials. Production processes refuse it, and it refuses production, because the marker binds the
id, the database and the host names.

Consequences:
- staging needs the N1 approval list in the image (MIGRATION-AND-ROLLBACK-PLAN.md §2.1);
- staging exercises every production gate (TLS verify-full, the configuration refusals, identity, N1, F5).

## 3. Host preparation (operator, on the staging VM)

```bash
# 3.1 Engine and Compose; the runtime keys need Compose v2.24+ (!override/!reset are not used here, but tmpfs options are).
docker version --format '{{.Server.Version}} {{.Server.Arch}}'
docker compose version                   # v5 (verified 5.6.1): the --environment preflight refuses v2.38/v2.39
node --version                            # 20 or later: runs staging/verify-image-compose.cjs (no npm install needed)
uname -m                                  # x86_64 or aarch64; record it (see §8 for the ARM64 gate)

# 3.2 Directories. The secret directory is root-only.
sudo install -d -m 0755 /opt/crewflow-staging/release
sudo install -d -m 0700 /etc/crewflow-staging /etc/crewflow-staging/secrets

# 3.3 Release bundle: the compose files and templates of the APPROVED commit, verified, never a branch tip.
git clone --filter=blob:none --no-checkout https://github.com/Rabblo06/rab-recurit.git /tmp/crewflow-release
git -C /tmp/crewflow-release checkout --detach <APPROVED_SHA>   # no pathspec: HEAD becomes exactly that commit
test "$(git -C /tmp/crewflow-release rev-parse HEAD)" = "<APPROVED_SHA, full 40 hex>" && echo commit-ok   # otherwise STOP
git -C /tmp/crewflow-release archive <APPROVED_SHA> packages/rab-docker | sudo tar -x -C /opt/crewflow-staging/release
rm -rf /tmp/crewflow-release
```

### 3.4 Pull the images by digest

- Log in with the read-only token. It is read from a prompt, never typed into the command line.
- Pull **only** the approved index digest (O2: ONE image for every application service).

```bash
read -rsp 'Docker Hub read-only token: ' T && printf '%s' "$T" | sudo docker login -u <dockerhub-user> --password-stdin; unset T
sudo docker pull adhin007/adolphus@sha256:<image-index-digest>
sudo docker pull redis@sha256:<redis-index-digest>
sudo docker buildx imagetools inspect adhin007/adolphus@sha256:<image-index-digest>   # lists linux/amd64 AND linux/arm64
sudo docker image inspect adhin007/adolphus@sha256:<image-index-digest> --format '{{.Os}}/{{.Architecture}}'  # = this host
sudo docker logout
```

The digest comes from the release record (commit, the index digest, scanner results, SBOM); it is `CREWFLOW_IMAGE_TAG` (named `CREWFLOW_IMAGE_DIGEST` until 2026-11-11). R1/R2: nothing is
published yet, so this step is BLOCKED until the owner approves a release.

## 4. Secrets (staging-only, generated fresh)

Generate each value on the operator's machine or on the VM. Never reuse a production or temporary-deployment value.

| Secret | Generate | Lives in |
|---|---|---|
| Bundled db superuser password `PG_DATABASE_PASSWORD` (bundled db only) and the `crewflow_owner` password `PG_DATABASE_APP_PASSWORD` | `openssl rand -hex 32` each | `compose.env` (0600); with your own database, `PG_ADMIN_URL` / `PG_DATABASE_URL` instead (`env/compose.env.example`, modes a-c) |
| `APP_SECRET` | `openssl rand -hex 48` | `runtime.env` |
| Redis `crewflow` password | `openssl rand -hex 32`; the ACL file stores only its SHA-256: `printf '%s' "$P" \| sha256sum` | `REDIS_URL` in `runtime.env`; the hash in `redis-users.acl` |
| S3 key pair | provider console, scoped to the staging bucket | `runtime.env` |
| Docker Hub token | Docker Hub, **read-only** scope | the operator's prompt only (§3.4) |
| PostgreSQL CA (own database only) | the provider's CA, or a private staging CA; server certificate SAN = the host Crewflow dials | `/etc/crewflow-staging/pg-ca.crt` (`CREWFLOW_PG_CA_FILE`); the bundled db makes its own CA |

```bash
T=/opt/crewflow-staging/release/packages/rab-docker/env
sudo cp $T/compose.env.example  /etc/crewflow-staging/compose.env
sudo cp $T/database.env.example /etc/crewflow-staging/secrets/database.env
sudo cp $T/runtime.env.example  /etc/crewflow-staging/secrets/runtime.env
sudo cp $T/redis-users.acl.example /etc/crewflow-staging/secrets/redis-users.acl
sudo chmod 0600 /etc/crewflow-staging/compose.env /etc/crewflow-staging/secrets/*.env
sudoedit /etc/crewflow-staging/compose.env              # image + Redis digests, CREWFLOW_SECRETS_DIR=/etc/crewflow-staging/secrets, db mode
sudoedit /etc/crewflow-staging/secrets/database.env     # PG_EXPECTED_DATABASE_NAME; CREWFLOW_DEPLOYMENT_ID=<fresh staging UUID> (§2)
sudoedit /etc/crewflow-staging/secrets/runtime.env      # fill every <placeholder>; never via echo/cat
sudoedit /etc/crewflow-staging/secrets/redis-users.acl  # the SHA-256 of the Redis password; ownership as OWNER-LOGIN-DEPLOYMENT.md §2
```

Lint all three before any start (names only, never values):

```bash
cd /opt/crewflow-staging/release/packages/rab-docker
node scripts/compose-owner-login.cjs --lint-env-file compose  /etc/crewflow-staging/compose.env
node scripts/compose-owner-login.cjs --lint-env-file database /etc/crewflow-staging/secrets/database.env
node scripts/compose-owner-login.cjs --lint-env-file runtime  /etc/crewflow-staging/secrets/runtime.env
```

Rotation:
- the `crewflow_owner` password: `OWNER-LOGIN-DEPLOYMENT.md` §7, "Rotate the crewflow_owner password";
- Redis: new hash in the ACL file, then `ACL LOAD` as the `ops` user, enabled for that session only;
- S3 / SMTP / Docker Hub: rotate at the provider.

Rotate everything after any suspected exposure and at teardown.

## 5. First install (each step is an owner-approved window)

Follow `OWNER-LOGIN-DEPLOYMENT.md` section 2 (fresh install) with the staging files. `C` is the compose command, run from
`/opt/crewflow-staging/release/packages/rab-docker`:

```bash
cd /opt/crewflow-staging/release/packages/rab-docker
C="sudo docker compose --env-file /etc/crewflow-staging/compose.env -f docker-compose.image.yml -f staging/docker-compose.staging.yml"
sudo node staging/verify-image-compose.cjs --environment --env-file /etc/crewflow-staging/compose.env \
  --compose staging/docker-compose.staging.yml        # images by digest + every runtime control + env-file names
$C config --quiet                                     # renders the stack
```

1. **Redis**: `$C up -d --wait rab-redis`, then check that:
   - `redis-cli ping` (no auth) returns `NOAUTH`;
   - `--user healthcheck` PING returns `PONG`;
   - `--user crewflow` `CONFIG GET` returns `NOPERM`;
   - `INFO` shows `maxmemory_policy:noeviction` and `aof_enabled:1`.
2. **Start**: `$C up -d --wait --wait-timeout 1200`. `db` (bundled mode) becomes healthy first, the one-shot `db-setup`
   creates staging's own `crewflow_owner`, rab-api migrates on start and becomes healthy, then rab-worker starts. No SQL
   or `psql` step is part of the install. Required log lines (`OWNER-LOGIN-DEPLOYMENT.md` §2 step 5 and §7):
   - `api-prestart: runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only ... mode=enforce`;
   - `[worker-isolation] runtime isolation as declared: ... mode=enforce`.

   **A missing `mode=enforce` means the image predates the enforce mode: STOP** (§9).
3. **Posture**: from a trusted operator checkout of `<APPROVED_SHA>`, through an SSH tunnel, the checks named in
   `OWNER-LOGIN-DEPLOYMENT.md` §2 (golden posture, RLS coverage, the migration ledger equals the release chain).
4. **First admin**: `BOOTSTRAP_ADMIN_EMAIL=<synthetic admin address>` for rab-api in `compose.env`, with
   `AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true` in `runtime.env` (the template's line; owner decision 2), then `$C up -d`. One
   activation email goes to that address; remove the variable once the admin has signed in and enrolled MFA
   (`OWNER-LOGIN-DEPLOYMENT.md` §2 step 6). Then run the smoke tests on synthetic accounts only:
   - sign-in (with MFA enrolment for the platform admin);
   - a shift publish and offer;
   - an email to the sandbox;
   - a pre-shift report PDF stored in the bucket and downloaded through its presigned URL;
   - a cross-tenant denial (404).
5. **Backups on** (MIGRATION-AND-ROLLBACK-PLAN.md §5). The first restore rehearsal must happen within 7 days.

Upgrades: `OWNER-LOGIN-DEPLOYMENT.md` section 3 (back up first, then the same one command with the new
`CREWFLOW_IMAGE_TAG`).

## 6. Phase D activation order (Phase D runbook §11, in this order, each step separately approved)

| # | Step | Staging specifics |
|---|---|---|
| 1 | A separate Worker login | **Not available under the owner login**: rab-api and rab-worker both run as `crewflow_owner` (owner decision 2026-11-04). A Worker login, and with it global claims, waits for the owner's J5/D5 decision (decision 34). |
| 2 | The five Phase D migrations (§4) | Part of the release chain the API applies on start (§5 step 2). |
| 3 | Readiness in per_scope (§5.1) | The default (`WORKER_CLAIM_MODE` unset). Check every §5.1 item, including at least one full 900 s reconcile interval. |
| 4 | Global + poll (§5.2) | **Not available**: `WORKER_CLAIM_MODE` / `WORKER_DISPATCH_MODE` are refused by the runtime.env lint and by env validation in production until the owner's J5 decision. |
| 5 | First sweep watch (§5.3) and monitoring (§7) | At least one full business day. |
| 6 | Staging measurements (closure criteria) | Idle and loaded PostgreSQL load against the per_scope baseline; sweep duration at staging volume; the F2 write-cost benchmark on this uncontended host; durations of the full migration chain and of the Phase D `down()`s on a production-sized copy. |
| 7 | Rollback drills (required before production, §1) | Global → per_scope (§8.1); credential rollback (§8.2); image rollback (§8.3, jobs-only, documented as the production owner exception); migration rollback (§8.4) on a **restored copy**, not on the live staging database. |
| — | Event mode (§5.4), 1786721330000 | Not part of this rollout. Separate approvals. |

## 7. Monitoring (staging)

| Signal | Source | Alert |
|---|---|---|
| Runtime isolation | rab-api / launcher start line | Any `WARNING runtime isolation` or `REFUSED` line; any start without `mode=enforce` |
| Container health and restarts | `docker compose ps`, `docker inspect -f '{{.RestartCount}}'` | Unhealthy for more than 2 minutes; any unexplained restart |
| Queues | `rab:worker:stats` (Worker), the age of the oldest pending email/push/realtime/statement row | Older than the reconcile interval outside a documented drain (Phase D §5.3) |
| Phase D claims | Worker log `dispatch claim-count alert`; `claimsOver20` | Above 0 |
| PostgreSQL | `pg_stat_activity` by role, long transactions, `pg_stat_database` (deadlocks, temp), disk | Connections above the declared budget; `idle in transaction` over 60 s; disk above 80 % |
| Redis | `INFO memory` (`used_memory` against `maxmemory`), `INFO persistence` (`aof_last_write_status`) | Above 70 % of maxmemory; any AOF write error |
| HTTP | edge 5xx rate, `/healthz` | 5xx above 1 % over 5 minutes |
| Backups | age of the newest encrypted dump in the off-provider bucket; the last restore rehearsal | Dump older than 26 h; rehearsal older than 30 days |

The Infrastructure templates add Prometheus alert rules (`hosting/monitoring/`) when adopted.

## 8. ARM64 (R6 / D6): a native render of the candidate digest

Production (Oracle) runs ARM64.
- **[DO] Droplets are x86-64 only (assumption, verify at provisioning).** An x86-64 staging VM therefore does **not**
  satisfy the gate.
- The ARM64 manifest of the **same** image index digest must render a real report PDF on **native** ARM64. Emulation
  never counts.

Two ways, either acceptable for the owner (the current owner question in the release-readiness record):
1. **CI**: the H5 security gate renders on GitHub's `ubuntu-24.04-arm` runners and refuses an emulated run. It PASSED
   on a CI build of the H5 tree (then still Chromium 156.0.8078.79, a 55,008-byte report, `uname -m` `aarch64`). Since P5
   (PDF renderer migration) the render is the Worker's native, browser-free renderer and the evidence records the Node
   version instead of a Chromium version. It re-runs on the release build, so the release digest gets its own native
   render. Record the job URL and the arm64 manifest digest.
2. **An isolated ARM64 host**: a throwaway ARM VM (for example Hetzner CAX, AWS Graviton, or an Oracle A1 instance in a
   separate tenancy, **never the production Oracle host**), using the native ARM64 procedure:

   ```bash
   uname -m && docker info --format '{{.Architecture}}'        # aarch64 / aarch64
   docker pull --platform linux/arm64 adhin007/adolphus@sha256:<image-index-digest>
   docker run --rm --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
     --entrypoint sh adhin007/adolphus@sha256:<image-index-digest> -c 'uname -m; node --version; test ! -e /usr/bin/chromium'
   # then the render smoke and the bundle integration harness from the procedure; record the digest, host arch,
   # Node version and the PDF's validity (size, page count, markers). P5: no Chromium exists in the image.
   ```

If the owner wants staging itself to match production's architecture, provision the staging VM on an ARM64 provider
instead. Nothing else in this runbook changes. **Status: BLOCKED until a release digest exists.**

## 9. Dependency on the enforce mode

`docker-compose.image.yml` sets `CREWFLOW_RUNTIME_ISOLATION=enforce` on rab-api and rab-worker. The mode is the H6 follow-up (commit
09286aef) in `rab/api-prestart.sh` and, for the Worker, `packages/rab-worker/src/core/runtime/runtime-isolation.ts` (O1: the
Worker bundle launcher that first carried it is retired):
- strict values `warn` | `enforce`;
- anything else refuses;
- in `enforce`, any missing control refuses to start, with exit 64 (API) or the Worker's start-up refusal (exit 1).

Release images built before that change ignore the variable and only warn. **Do not deploy this variant with such an
image.** The start line must contain `mode=enforce` (§5 step 2).

## 10. Teardown (owner-approved; staging data is synthetic)

```bash
cd /opt/crewflow-staging/release/packages/rab-docker
$C stop -t 60                      # API and Worker drain (35 s / 55 s grace)
$C down                            # containers + the project network; named volumes stay until the VM is destroyed
```

Then, in this order:
1. Export anything the owner wants to keep (measurements, logs).
2. Destroy the VM and its volumes **[DO]** (Droplet + attached volumes + snapshots).
3. Delete the staging bucket objects and the bucket, and the backup prefix (after the agreed retention, or at once
   when the data is synthetic).
4. Delete the DNS records and the edge certificate.
5. Revoke the Docker Hub read-only token, the S3 keys, the SMTP sender and the Sentry DSN.
6. Delete every staging secret from the secret store.
7. Record the teardown, with no values.

Nothing in this list touches production, the temporary deployment or the registry's images.
