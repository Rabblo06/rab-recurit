# Isolated staging environment runbook (owner decision R4)

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
- Pull **only** the approved index digests.

```bash
read -rsp 'Docker Hub read-only token: ' T && printf '%s' "$T" | sudo docker login -u <dockerhub-user> --password-stdin; unset T
sudo docker pull adhin007/adolphus@sha256:<api-index-digest>
sudo docker pull adhin007/adolphus@sha256:<worker-index-digest>
sudo docker pull redis@sha256:<redis-index-digest>
sudo docker buildx imagetools inspect adhin007/adolphus@sha256:<worker-index-digest>   # lists linux/amd64 AND linux/arm64
sudo docker image inspect adhin007/adolphus@sha256:<worker-index-digest> --format '{{.Os}}/{{.Architecture}}'  # = this host
sudo docker logout
```

The digests come from the release record (commit, both index digests, scanner results, SBOM). R1/R2: nothing is
published yet, so this step is BLOCKED until the owner approves a release.

## 4. Secrets (staging-only, generated fresh)

Generate each value on the operator's machine or on the VM. Never reuse a production or temporary-deployment value.

| Secret | Generate | Lives in |
|---|---|---|
| `crewflow_app`, `crewflow`, `crewflow_worker`, `crewflow_migrator`, `rab_owner` and bootstrap passwords | `openssl rand -hex 32` (URL-safe: the passwords go straight into `postgresql://` URLs; any other generator's output must be percent-encoded there) | the secret store; the env files (0600) |
| `APP_SECRET` | `openssl rand -hex 48` | `api.env`, `worker.env` |
| Redis `crewflow` password | `openssl rand -hex 32`; the ACL file stores only its SHA-256: `printf '%s' "$P" \| sha256sum` | `REDIS_URL` in `api.env`/`worker.env`; the hash in `redis-users.acl` |
| S3 key pair | provider console, scoped to the staging bucket | `api.env`, `worker.env` |
| Docker Hub token | Docker Hub, **read-only** scope | the operator's prompt only (§3.4) |
| PostgreSQL CA + server key | private staging CA (offline CA key); server certificate SAN `postgres.crewflow-staging.internal` | CA certificate at `/etc/crewflow-staging/pg-ca.crt`; the server key only in the PostgreSQL TLS directory |

```bash
sudo cp release/packages/rab-docker/staging/env/compose.env.example /etc/crewflow-staging/compose.env
sudo cp release/packages/rab-docker/staging/env/api.env.example     /etc/crewflow-staging/secrets/api.env
sudo cp release/packages/rab-docker/staging/env/worker.env.example  /etc/crewflow-staging/secrets/worker.env
sudo cp release/packages/rab-docker/hosting/redis/users.acl.example /etc/crewflow-staging/secrets/redis-users.acl
sudo chmod 0600 /etc/crewflow-staging/compose.env /etc/crewflow-staging/secrets/*
sudo chmod 0644 /etc/crewflow-staging/secrets/redis-users.acl   # read by the redis user (uid 999); holds hashes only
sudoedit /etc/crewflow-staging/compose.env                       # the two release digests + the Redis digest (release record)
sudoedit /etc/crewflow-staging/secrets/api.env                   # fill every <placeholder>; never via echo/cat
sudoedit /etc/crewflow-staging/secrets/worker.env                # fill every <placeholder> (same shared staging values)
sudoedit /etc/crewflow-staging/secrets/redis-users.acl           # replace both #<sha256-...> placeholders with real hashes
```

The preflight in §5 refuses any `<placeholder>` left in `api.env` or `worker.env`, a missing required name, a
migration/ops credential and a database login other than the allowed one per service.

Rotation:
- database logins: `ALTER ROLE ... PASSWORD` from a `\password` prompt, update the env file, rolling restart;
- Redis: new hash in the ACL file, then `ACL LOAD` as the `ops` user, enabled for that session only;
- S3 / SMTP / Docker Hub: rotate at the provider.

Rotate everything after any suspected exposure and at teardown.

## 5. First install (each step is an owner-approved window)

Shortcut: `C` is the compose command, run from `/opt/crewflow-staging/release/packages/rab-docker`.

```bash
cd /opt/crewflow-staging/release/packages/rab-docker
C="sudo docker compose --env-file /etc/crewflow-staging/compose.env -f docker-compose.image.yml -f staging/docker-compose.staging.yml"
sudo node staging/verify-image-compose.cjs --environment --env-file /etc/crewflow-staging/compose.env \
  --compose staging/docker-compose.staging.yml        # images by digest + every runtime control + env-file names
$C config --quiet --no-env-resolution                 # renders without reading env files (.env.migrate may not exist yet)
```

1. **PostgreSQL**: the Infrastructure agent's self-hosted template, with `CREWFLOW_BOOTSTRAP_PHASE_D=true`. It creates
   `rab_owner` (LOGIN, owns the database and `core`), `rab_app` (NOLOGIN), `crewflow_bootstrap` (SUPERUSER, NOLOGIN until
   phase B), `crewflow_app`, and `crewflow_worker` with the reviewed shape. Then:
   - verify its summary line;
   - run the role checks (MIGRATION-AND-ROLLBACK-PLAN.md §4.2; generated inventory L4/L5);
   - verify TLS: `psql "sslmode=verify-full sslrootcert=/etc/crewflow-staging/pg-ca.crt host=postgres.crewflow-staging.internal ..." -c 'SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()'`.
2. **Redis**: `$C up -d --wait rab-redis`, then check that:
   - `redis-cli ping` (no auth) returns `NOAUTH`;
   - `--user healthcheck` PING returns `PONG`;
   - `--user crewflow` `CONFIG GET` returns `NOPERM`;
   - `INFO` shows `maxmemory_policy:noeviction` and `aof_enabled:1`.
> **UNREHEARSED (steps 3–5 and the identity, TLS and production-refusal parts of 7).** The local rehearsal
> (MIGRATION-AND-ROLLBACK-PLAN.md §8) proved the exit codes, the token flow and the phase split only with
> `DB_TARGET=local`, no TLS and no identity bind. Under `DB_TARGET=production` the following are untested until the
> first approved staging window, which is their rehearsal:
> - N1 (it also needs the N1 code change);
> - `verify-full`;
> - the bootstrap flag and `db:bind-identity`;
> - the production configuration refusals.

3. **Phase A**: create `.env.migrate` with `rab_owner` and `CREWFLOW_MIGRATION_PHASE=A` (template
   `staging/env/migrate.env.example`, 0600).
   - `$C run --rm rab-migrate` returns exit 3, the list of **all 250**, and a token.
   - Owner approval, then `$C run --rm -e CREWFLOW_MIGRATION_APPROVED=<token> rab-migrate`. Expected: the run stops at
     the role split, which refuses `rab_owner` (exit 1 after the 128 phase A migrations).
4. **Phase B + bind**, in one supervised step:
   - Enable the bootstrap login for this run: `ALTER ROLE crewflow_bootstrap LOGIN PASSWORD` from `\password`.
   - Switch `.env.migrate` to it, with `CREWFLOW_MIGRATION_PHASE=B`, the two bootstrap passwords,
     `CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=unbound-production-database` and `PG_EXPECTED_DATABASE_NAME`.
   - Check run (exit 3, 122 pending), owner review, then the apply run with the new token (exit 0, "post-checks passed").
   - Immediately run `db:bind-identity --environment production --deployment-id <staging UUID> ...`
     (MIGRATION-AND-ROLLBACK-PLAN.md §4.1).
   - Remove the bootstrap flag.
   - `ALTER ROLE crewflow_bootstrap NOLOGIN`.
5. **Hardening**: `crewflow_migrator` from the reviewed production script (Infrastructure templates, `sql/20-...`), and
   the post-bootstrap hardening (`sql/30-...`: NOLOGIN for the bootstrap identities, rotation of the passwords the
   role-split migrations set). Point `.env.migrate` at `crewflow_migrator`; `$C run --rm rab-migrate` must exit 0.
6. **Posture**: from a trusted operator checkout of `<APPROVED_SHA>`, through an SSH tunnel:
   - the golden posture check (`check-db-security-posture.ts`);
   - `tools/check-rls-coverage.ts` as `crewflow_app` (exit 0, `rolbypassrls = false`);
   - the generated inventory (`applied 250`, nothing else).
7. **Services**: `$C up -d --wait rab-api`. Compose first runs the `rab-migrate` dependency (one check run; exit 0),
   then the API. Then the Worker: `$C up -d --wait rab-worker`. After the window, delete `.env.migrate`. From then on,
   restart or replace the services with `$C up -d --no-deps rab-api` / `rab-worker`: the API and Worker refuse pending
   migrations on their own, so the dependency run is not needed between releases. A plain `up` without `--no-deps`
   needs `.env.migrate` again. **OWNER DECISION:** keep `.env.migrate` (0600, root) on the host permanently, as
   docker-compose.production.yml assumes, or only during windows (recommended; `crewflow_migrator` can then be NOLOGIN
   between releases). Required log lines:
   - `api-prestart: runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only ... mode=enforce`;
   - `[worker-bundle] runtime isolation as declared: CapBnd=00000000000000e0 NoNewPrivs=1 root=read-only tmpfs=4/4 ... mode=enforce`;
   - `[worker-bundle] live identity probes agree ... (jobs=crewflow_app, provisioner=crewflow)`.

   **A missing `mode=enforce` means the image predates the enforce mode: STOP** (§9).
8. **First admin**: the existing one-off `bootstrap-admin` operator command (the API image's
   `packages/rab-server/dist/command/main.js bootstrap-admin`, run once as the `crewflow` login with production command
   authority and the staging identity; database runbook "bootstrap-admin"). It is not run through `rab-ops`, which
   accepts only its three operations. Then run the smoke tests on synthetic accounts only:
   - sign-in;
   - a shift publish and offer;
   - an email to the sandbox;
   - a pre-shift report PDF stored in the bucket and downloaded through its presigned URL;
   - a cross-tenant denial (404).
9. **Backups on** (MIGRATION-AND-ROLLBACK-PLAN.md §5). The first restore rehearsal must happen within 7 days.

## 6. Phase D activation order (Phase D runbook §11, in this order, each step separately approved)

| # | Step | Staging specifics |
|---|---|---|
| 1 | `crewflow_worker` created (§3) | Done at step 5.1 on a fresh install (pre-created, reviewed shape). Verify with the §3.3 query. |
| 2 | The five Phase D migrations (§4) | Part of the fresh chain (step 5.4). **The 14-day clock starts here.** Therefore install staging only once #26 (#24 fix) is merged and in the release image, or record an owner exception for staging. |
| 3 | Readiness in per_scope (§5.1) | Switch the Worker's `PG_DATABASE_URL` in `worker.env` to the `crewflow_worker` URL, keeping `WORKER_CLAIM_MODE` unset (per_scope). Restart the Worker. Check every §5.1 item, including at least one full 900 s reconcile interval. **HARD BLOCKER: #24 merged and verified.** |
| 4 | Global + poll (§5.2) | Add `WORKER_CLAIM_MODE=global` to `worker.env`; rolling restart. Within 14 days of step 2. |
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
- The ARM64 manifest of the **same** Worker index digest must render a real report PDF on **native** ARM64. Emulation
  never counts.

Two ways, either acceptable for the owner (the current owner question in the release-readiness record):
1. **CI**: the H5 security gate renders on GitHub's `ubuntu-24.04-arm` runners and refuses an emulated run. It PASSED
   on a CI build of the H5 tree (Chromium 156.0.8078.79, a 55,008-byte report, `uname -m` `aarch64`). It re-runs on the
   release build, so the release digest gets its own native render. Record the job URL and the arm64 manifest digest.
2. **An isolated ARM64 host**: a throwaway ARM VM (for example Hetzner CAX, AWS Graviton, or an Oracle A1 instance in a
   separate tenancy, **never the production Oracle host**), using the native ARM64 procedure:

   ```bash
   uname -m && docker info --format '{{.Architecture}}'        # aarch64 / aarch64
   docker pull --platform linux/arm64 adhin007/adolphus@sha256:<worker-index-digest>
   docker run --rm --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
     --entrypoint sh adhin007/adolphus@sha256:<worker-index-digest> -c 'uname -m; /usr/bin/chromium --version'
   # then the render smoke and the bundle integration harness from the procedure; record the digest, host arch,
   # Chromium version and the PDF's validity (size, page count, markers).
   ```

If the owner wants staging itself to match production's architecture, provision the staging VM on an ARM64 provider
instead. Nothing else in this runbook changes. **Status: BLOCKED until a release digest exists.**

## 9. Dependency on the enforce mode

`docker-compose.image.yml` sets `CREWFLOW_RUNTIME_ISOLATION=enforce` on rab-api and rab-worker. The mode is the H6 follow-up (commit
09286aef) in `rab/api-prestart.sh` and `rab/worker-bundle/start-worker-bundle.cjs`:
- strict values `warn` | `enforce`;
- anything else refuses;
- in `enforce`, any missing control refuses to start, with exit 64 (API) or a `BundleConfigError` (Worker).

Release images built before that change ignore the variable and only warn. **Do not deploy this variant with such an
image.** The start line must contain `mode=enforce` (§5 step 7).

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
