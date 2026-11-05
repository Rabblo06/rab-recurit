# Owner-login deployment: install, release, transition and rollback runbook

**Status (2026-11-04): procedure and templates. NOT TESTED end to end.** What exists and is checked on this branch:
- the bundled-database override (`docker-compose.local-db.yml`);
- the env templates (`packages/rab-docker/env/`);
- the compose gate (`scripts/compose-owner-login.cjs`) and its CI (`ci-deployment-owner-login.yaml`).

The in-place edits of the existing deployment files cannot land before #61/#62 merge (they touch the same files). They
are prepared on branch `twa/docker-owner-login-post61`:
- `docker-compose.image.yml` and `docker-compose.production.yml`;
- the staging override and the new `docker-compose.migrate-on-start.yml`.

The application side (Agents 1–3) is not yet on `deploy/twenty-mode-a`. Nothing below has been run against real
owner-login images. Production use waits for:
- Agent 5's integrated verification;
- the owner's approval of each release.

**Architecture (owner's final decision, 2026-11-04).** There is ONE permanent architecture, with no mode switch:
- one schema-owning login, `crewflow_owner`, for the API, the Worker and the release step;
- one `PG_DATABASE_URL`.

The former separated logins (`crewflow_app`, `crewflow`, `crewflow_worker`, `crewflow_migrator`) remain **schema roles**
that historical migrations and definers need. They are no longer runtime logins. Two hardened images stay (API and
Worker); a shared image is a later, separate PR (`SHARED-IMAGE-PLAN.md`). Design source: the M0 decision document
`TWENTY_MODE_M0_DECISION_2026-11-04.md` ("M0") and the owner-login addendum. The repository's root `docs/` is
git-ignored, so neither is committed.

| File | Purpose | Lands |
|---|---|---|
| `docker-compose.image.yml` (in place) | The stack: `rab-api`, `rab-worker`, `rab-redis`, and the one-off `rab-migrate`. **Controlled release is the default:** the API does not migrate; `rab-migrate` (`deploy-prepare.js`, same image, same login) does. Approval mode `none` by default; token mode is an opt-in (BC-11). | after #61/#62 |
| `docker-compose.migrate-on-start.yml` | Quick-start override: the API migrates on start; `rab-migrate` is not part of the stack. | after #61/#62 |
| `docker-compose.local-db.yml` | Optional bundled PostgreSQL 16. Its one init file is Agent 1's `postgres-init/owner-login/01-crewflow-owner.sql`. | now |
| `staging/docker-compose.staging.yml` (in place) | Project name and storage prefix only. The env files now come from the base file. | after #61/#62 |
| `docker-compose.production.yml` (in place) | The build-based OpenShip file, reshaped to one URL. **OpenShip cannot run the owner-login Worker safely** (section 6). | after #61/#62 |
| `env/database.env.example` | **Shared** database file: `PG_DATABASE_URL` and the deployment identity. Read by rab-api, rab-worker and rab-migrate. | now |
| `env/runtime.env.example` | Runtime secrets for rab-api and rab-worker only. The release step never reads it. | now |
| `env/compose.env.example` | Interpolation values: digests, paths and limits. No secret. | now |
| `env/redis-users.acl.example` | Redis ACL: `default` off, app user stored by SHA-256, PING-only health user. | now |
| `local-db/pg_hba.conf` | Bundled database: superuser on the local socket only; `crewflow_owner` over TLS only. | now |
| `postgres-init/owner-login/01-crewflow-owner.sql`, `transition-from-separated.sql` | **Agent 1's** tested provider-admin SQL. Referenced here, never copied. | Agent 1 |
| `docs/release/OWNER-LOGIN-RECOVERY.md` | Recovery and rollback: the mandatory pre-upgrade backup, restore-then-previous-image (proven), and why an old image on an upgraded database fails closed. | now |

Shorthand, used from `packages/rab-docker/` on the host:

```bash
I="-f docker-compose.image.yml"
M="-f docker-compose.migrate-on-start.yml"     # quick start only
L="-f docker-compose.local-db.yml"             # bundled database only
P="docker compose --env-file /etc/crewflow/compose.env $I"        # production: controlled release
```

---

## 1. What running on the owner login means (PT-01): read first

The long-running API and Worker hold a login that **owns the schema**. Container isolation limits what a compromised
*process* can do to the *host*. It does **nothing** to limit what the *database login* can do.

**Accepted by the owner (final prompt §2).** These are recorded in `THREAT-MODEL.md` by the security agent:
- cross-organisation authentication data (G-01);
- SQL injection with owner privileges (G-02);
- account takeover and MFA bypass (G-03);
- policy modification and object deletion;
- audit tampering (G-05);
- persistence through roles or definers (G-04: **rotation is not remediation**);
- credential-exposure impact.

**NOT in §2, so these NEED OWNER APPROVAL before production.** Each has a test and a severity in the behaviour-change
catalogue:
- the loss of the DBA-01 API/Worker separation (the API can run worker-only claims);
- the deployment identity can be rebound by the runtime (G-06);
- no logical backup by the app login, so recovery is PITR only (G-11; this runbook's backups assume it);
- the loss of column-level secret grants;
- `worker_due_work` and pointer direct access.

M0 §6.4 makes several controls mandatory that **no compose file provides**:
- an external append-only audit sink;
- pgaudit (or equivalent) shipped off the database;
- a private network or allow-list plus `verify-full`;
- PITR retention of at least your detection time, with a tested restore;
- the incident runbook.

PT-01 pointers:
- M0 §6.1, §6.2 and §6.4;
- `THREAT-MODEL.md`: the PT-01 entry and the owner-login entries;
- `CLAUDE.md`: the amended rules ("crewflow_app owns nothing", the five layers, the NOT FORCE rationale).

---

## 2. Fresh install

**Prerequisites:**
- Linux, Docker Engine, Compose ≥ 2.24.
- The approved index digests: API, Worker, Redis 7, and PostgreSQL 16 alpine if bundled.
- A database:
  - **EITHER** a managed PostgreSQL 16 where the provider admin has run **`postgres-init/owner-login/01-crewflow-owner.sql`** (section 4), and you hold the `crewflow_owner` URL at the **direct** host;
  - **OR** the bundled database (`$L`), whose init runs that same file.
- PostgreSQL 18 waits for the PG18 workspace fingerprints. Below 16 is refused.
- **"A URL alone" never works:** a provider-admin step always comes first.
- **Production config refusals apply to every install, a trial included.** The API and Worker refuse to boot without:
  - `EMAIL_DRIVER` SMTP or RESEND;
  - S3 storage;
  - `https://` non-localhost URLs;
  - a narrow `TRUSTED_PROXY_CIDRS`.

**Steps (as root on the host; nothing is written inside the repository):**

1. **Layout.**
   ```bash
   install -d -m 0700 /etc/crewflow /etc/crewflow/secrets
   install -m 0600 env/compose.env.example  /etc/crewflow/compose.env
   install -m 0600 env/database.env.example /etc/crewflow/secrets/database.env
   install -m 0600 env/runtime.env.example  /etc/crewflow/secrets/runtime.env
   ```
2. **Secrets.** Generate each with `openssl rand -hex 32` (APP_SECRET: `-hex 48`).
   - **Redis:** set `REDIS_URL=redis://crewflow:<pw>@rab-redis:6379` in `runtime.env`. Put the password's SHA-256 in the ACL:
     ```bash
     cp env/redis-users.acl.example /etc/crewflow/secrets/redis-users.acl
     printf '%s' "$REDIS_PW" | sha256sum   # replace <sha256-hex-of-the-redis-app-password>
     chown 999:1000 /etc/crewflow/secrets/redis-users.acl && chmod 0640 /etc/crewflow/secrets/redis-users.acl
     ```
   - **Deployment id (optional, BC-11):** `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID` are commented out in the template. When you declare an id (`uuidgen`), every process and the release step match it against the database's identity marker and refuse a mismatch. When it is absent, startup warns and continues.
3. **Bundled database only:** TLS and the two password files.
   ```bash
   cd /etc/crewflow/secrets && install -d -m 0755 pg-tls && cd pg-tls
   openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 825 -subj "/CN=crewflow bundled-db CA"
   openssl req -newkey rsa:3072 -nodes -keyout server.key -out server.csr -subj "/CN=rab-postgres"
   printf 'subjectAltName=DNS:rab-postgres\n' > san.ext
   openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 825 -extfile san.ext
   mv ca.key /root/crewflow-bundled-db-ca.key && chmod 0400 /root/crewflow-bundled-db-ca.key   # the CA key is never mounted
   chown 70:70 server.key && chmod 0600 server.key && chmod 0644 ca.crt server.crt
   openssl rand -hex 32 > ../crewflow-owner-password && openssl rand -hex 32 > ../postgres-superuser-password
   chown 70:70 ../crewflow-owner-password ../postgres-superuser-password && chmod 0600 ../crewflow-owner-password ../postgres-superuser-password
   ```
   Set the following:
   - in `compose.env`: `CREWFLOW_PG_CA_FILE=/etc/crewflow/secrets/pg-tls/ca.crt`;
   - in `database.env`: `PG_DATABASE_URL=postgresql://crewflow_owner:<the owner password>@rab-postgres:5432/crewflow?sslmode=verify-full` and `PG_EXPECTED_DATABASE_NAME=crewflow`.
4. **Lint, then render.** Both print names only, never values.
   ```bash
   node scripts/compose-owner-login.cjs --lint-env-file compose  /etc/crewflow/compose.env
   node scripts/compose-owner-login.cjs --lint-env-file database /etc/crewflow/secrets/database.env
   node scripts/compose-owner-login.cjs --lint-env-file runtime  /etc/crewflow/secrets/runtime.env
   ```
   Then render the files you will start, e.g. `$P $M [$L] config -q`.
5. **Start.** Choose one:
   - **Quick start (migrate-on-start):** `$P $M [$L] up -d --wait --wait-timeout 1200`. The API runs the check-first migration child under the lock (bootstrap, the whole chain, then the post-checks) and serves only after it succeeds. The fresh chain took ~40 s on local PG16, NOT TESTED on any managed provider. The override gives the API a 900 s `start_period`. The Worker follows a healthy API.
   - **Controlled (production):** use section 3 from step 3.2. On an EMPTY database, `rab-migrate` applies the whole chain (approval mode `none`, the default). With token mode on, it exits 3 with the full chain as the pending set; approve it with the token.
6. **First platform admin (email only, activation link).** Once the API is healthy, run the existing `bootstrap-admin` command **once**, as a one-off container of the API service: the same image, the same owner login (`database.env`, which also supplies `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID`) and the same runtime config (`runtime.env`). The command creates the admin from an email address and sends an **activation link**; it takes no password (`BOOTSTRAP_ADMIN_PASSWORD` is ignored with a warning, so never set it).
   - Inputs: `BOOTSTRAP_ADMIN_EMAIL` (required); optional `BOOTSTRAP_ADMIN_FIRST_NAME`, `BOOTSTRAP_ADMIN_LAST_NAME`, `BOOTSTRAP_ADMIN_ORG_SLUG`, `BOOTSTRAP_ADMIN_ORG_NAME`.
   - The CLI requires **per-invocation command authority**: `DB_TARGET=production` and `ALLOW_PRODUCTION_DB_COMMANDS=true`, given on this one-off run ONLY, never in any service environment or env file.
   ```bash
   export BOOTSTRAP_ADMIN_EMAIL=admin@example.com     # optional: BOOTSTRAP_ADMIN_FIRST_NAME / _LAST_NAME / _ORG_SLUG / _ORG_NAME
   $P run --rm --no-deps -e DB_TARGET=production -e ALLOW_PRODUCTION_DB_COMMANDS=true -e BOOTSTRAP_ADMIN_EMAIL \
     rab-api node packages/rab-server/dist/command/main.js bootstrap-admin
   unset BOOTSTRAP_ADMIN_EMAIL
   ```
   (Add `-e BOOTSTRAP_ADMIN_FIRST_NAME` and the others the same way when you set them.) `run` publishes no port, `--no-deps` leaves the running stack alone, and the command replaces `api-prestart.sh`, so the authority never reaches a long-running process. The env-file lint refuses `DB_TARGET`, `ALLOW_PRODUCTION_DB_COMMANDS` and every `BOOTSTRAP_ADMIN_*` in every file.

**Optional startup and watchdog knobs** (code defaults; set in `runtime.env` only to change them):

| Variable | Service | Range | Default | Effect |
|---|---|---|---|---|
| `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS` | rab-api | 0–300 | 15 | Delay before a failed start exits, so a restart loop does not hammer the database. |
| `CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS` | rab-worker | 30–900 | 120 | An event loop silent this long is a stall; the watchdog kills the process and Docker restarts it. |
| `CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS` | rab-worker | 0–3600 | 900 | How long the Worker waits for the schema to be current before refusing to start (it never migrates). |

**The Worker runs with `init: true`.** Its watchdog SIGKILLs a stalled process, and the kernel ignores that signal for PID 1, so the Worker refuses to start as PID 1. Docker's init must be PID 1; every compose file that runs the Worker sets it, and the gate fails CI otherwise.

**Failure semantics:**
- **First install:** non-zero exit; the API never becomes healthy. Docker restarts it with capped backoff. Each start re-classifies: EMPTY or BOOTSTRAP-PARTIAL bootstraps, CHAIN-PARTIAL resumes, FOREIGN refuses.
- **Upgrade:** governed by `CREWFLOW_UPGRADE_FAILURE_POLICY`, committed as `refuse`. Exit 70 = upgrade failed but `continue-if-compatible` passed every check; it is never set by these files.
- **Half-initialised bundled database** (the init failed, e.g. a missing password file): `rab-postgres` stays **unhealthy**, because its check also requires `crewflow_owner`. The volume holds no data. Recover with:
  ```bash
  $P $L down
  docker volume rm <project>_crewflow-pg-data
  ```
  Confirm the name with `docker volume ls` first. **Never** do this to a volume that has served traffic.

---

## 3. Production release (controlled upgrade, the default)

Production runs `docker-compose.image.yml` **without** `$M`. The API never changes the schema
(`CREWFLOW_MIGRATE_ON_START=false`). The one-off `rab-migrate` does: `deploy-prepare.js`, updated in place by Agent 1,
from the **same image digest** and the **same `database.env`**. The API and Worker depend on it.

**Approval mode (BC-11, owner decision 2026-11-05).** The release step and migrate-on-start apply **without a token by
default** (`CREWFLOW_MIGRATION_APPROVAL_MODE` unset = `none`): a `rab-migrate` run, or the `rab-migrate` that `up` runs
first, applies every pending migration. **Token mode is an opt-in safety net:** set `CREWFLOW_MIGRATION_APPROVAL_MODE=token`
in `database.env` (it reaches rab-api, rab-worker and rab-migrate alike). Its rule is unchanged when on: a run without a
token is a check run, and every non-fresh apply needs the token, on any target (3.2).

**3.1 Inputs.**
- The API and Worker **index digests** from the gated release (`publish-image.yaml` → `publish-gated.sh`; the `release` environment needs reviewer approval). Never a tag.
- Check the revision label equals the release SHA:
  ```bash
  docker buildx imagetools inspect <repo>@sha256:<digest>
  ```
- Keep the previous `compose.env` for rollback:
  ```bash
  cp compose.env compose.env.<old-sha>
  ```

**The release step's authority (Agent 1, a4ef9bf8; BC-11).** In production, `rab-migrate` carries **no `DB_TARGET` and no `ALLOW_PRODUCTION_DB_COMMANDS`**; the compose files and the gate refuse both on it.
- **Target:** `deploy-prepare.js` derives it from `CREWFLOW_DEPLOYMENT_ENVIRONMENT` when declared (in `database.env`), in memory, and re-derives it after the migration lock, the same way the migrate child does.
- **Deployment id (optional):** when `CREWFLOW_DEPLOYMENT_ID` is declared, the database's identity marker must match it, or the run refuses. When it is absent, the run warns and continues.
- **Token (optional):** with token mode on, every non-fresh apply needs `CREWFLOW_MIGRATION_APPROVED=<token>` for exactly the pending set (3.4). With the default mode `none`, a run applies.

An explicit `DB_TARGET`, or any login other than `crewflow_owner`, keeps the legacy (separated) behaviour.

> **ACCEPTED RISK (BC-11, owner decision 2026-11-05).** With the defaults (approval mode `none`, no deployment id), nothing in the release path tells the right image or database from the wrong one. A wrong image digest, or a `database.env` that names the wrong database, applies that image's migrations to whatever database the URL reaches, production included, on the next `up`, `run` or migrating API start. **Recovery is a restore from the pre-upgrade backup only** ([`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md)). That is why the backup (3.3) stays **MANDATORY**. Opt-ins that narrow this risk: token mode, and a declared deployment id.

**3.2 Preflight (read-only).**
1. Lint the env files and run `$P config -q`.
2. `$P pull`.
3. **What a `rab-migrate` run does depends on the approval mode:**
   - **Mode `none` (default):** `$P run --rm rab-migrate` **applies** every pending migration. There is no separate check run, so take the backup (3.3) **before** any `run` or `up`. Review the pending set from the release notes (step 4).
   - **Token mode (opt-in):** `$P run --rm rab-migrate` without a token is a **check run** that applies nothing:
     - **0:** CURRENT or AHEAD. Nothing to apply; go to 3.5.
     - **3:** pending. The log lists each migration and prints `pending-<count>-<sha256>`. Nothing was applied.

   In both modes, **64–69 means STOP.** Failures exit by kind: 64 config, 65 behind, 66 migration failed, 67 identity, 68 post-check, 69 lock timeout (M0 §7).

   **Token-mode rule (owner decision 2026-11-04, unchanged when token mode is on):** every apply to a non-fresh database needs the `CREWFLOW_MIGRATION_APPROVED` token, on any target (production, staging and test alike). Without it the run exits **65**. A proven fresh install, mode `none` and check runs are unchanged.

   With the bundled database, `run` starts `rab-postgres` first, because the local-db override declares rab-migrate's dependency.
4. **Expand-only review of the pending list.** An expand-only lint **NEEDS OWNER APPROVAL**; until then this is a manual review.

   The release is rollback-safe only if every pending migration only **adds** (tables, nullable or defaulted columns, indexes, functions, policies) and drops, renames, retypes or narrows nothing the previous image uses. Otherwise rollback is a restore (3.6b). Get the owner's go-ahead.

**3.3 Backup or PITR marker: MANDATORY before anything can apply.** In mode `none`, take it before the first `run` or `up` of the new image. In token mode, take it after a check run that exited 3. The app login cannot take a logical backup (FORCE-RLS tables dump empty).
- **Managed provider:**
  - take a provider snapshot or branch, OR
  - record the PITR restore time (`SELECT now()`) and the provider's window.

  Record it in the release notes.
- **Bundled database:** as the superuser over the local socket:
  ```bash
  $P $L exec -T rab-postgres pg_dump -U postgres -d crewflow -Fc > /var/backups/crewflow-<release>.dump
  ```
  Use `0600` and keep a copy off the host, or snapshot the volume with the stack stopped. Test restores periodically.

**3.4 Apply.** **Mode `none` (default):** `$P run --rm rab-migrate` (or `up`, which runs it first) applies; exit 0 = applied and post-checks passed, 64–69 = failed by kind. **Token mode:** apply exactly the reviewed set. The token goes through the environment of one command only. `-e NAME` with no value forwards it from the shell, so it never sits in a file or on a command line:
```bash
read -r CREWFLOW_MIGRATION_APPROVED && export CREWFLOW_MIGRATION_APPROVED   # paste the token from 3.2
$P run --rm -e CREWFLOW_MIGRATION_APPROVED rab-migrate; rc=$?
unset CREWFLOW_MIGRATION_APPROVED; echo "rab-migrate exit $rc"
```
- **Exit 0:** applied, and the post-checks passed.
- **64–69:** failed by kind (as in 3.2); see 3.6.

In token mode, an apply run needs `CREWFLOW_MIGRATION_APPROVED=<token>`; without it the run is only a check. The token is recomputed under the lock, so a changed pending set applies nothing.

**3.5 Promote.**
```bash
$P up -d --wait --wait-timeout 600
```
`rab-migrate` re-checks and must exit 0. Then the API starts: it runs a read-only compatibility check and refuses to serve otherwise. The Worker follows a healthy API. Verify `$P ps`, `/healthz` through the edge, and the Worker health line. Compose returns 1 when `rab-migrate` does not exit 0; nothing new is promoted in that case.

**3.6 Rollback.** Restore-based rollback, the evidence, and why an old image on an upgraded database fails closed: [`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md).
- **(a) Expand-only release (only between owner-login releases reviewed as expand-only; never back across the transition):**
  ```bash
  docker compose --env-file /etc/crewflow/compose.env.<old-sha> $I up -d --wait
  ```
  The old image's `rab-migrate` classifies the ledger as AHEAD, warns and exits 0 (the C-1 fix). The old API then serves. **This is safe ONLY for expand-only releases.**
- **(b) Contracting release, or a failed apply:**
  1. `$P stop rab-api rab-worker`.
  2. Restore the 3.3 backup or PITR point. Every write since that point is lost.
  3. Run the old digests as in (a).

  Never run an old image's migrations against a newer schema. Never `down -v` production.
- **(c) A partial apply.** Migrations commit one by one. Re-run 3.2: CHAIN-PARTIAL resumes on the **new** image, after review. Otherwise do (b).

**3.7 One API replica.** Rolling and blue-green deploys are not supported:
- two versions race for the migration lock, and a waiter can block for up to 600 s;
- old replicas see intermediate schemas;
- DDL lock queues become user-visible stalls (M0-F S2).

---

## 4. Provider-admin SQL (one time, per database)

Two scripts, both **owned and tested by Agent 1**. Run them **as the provider admin**, **in SQL**, over the **direct**
(non-pooler) host. **Never** create the login through a console, CLI or API user-creation feature: those logins carry
provider-superuser memberships (F-E3). Follow each file's header for how it receives the password, and for its own
verification queries.

| Situation | Script |
|---|---|
| Fresh, empty database | `packages/rab-docker/postgres-init/owner-login/01-crewflow-owner.sql`: creates `crewflow_owner` with the M0 §5.1 shape (`LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT`) and grants `CONNECT, CREATE, TEMPORARY … WITH GRANT OPTION` on the database. The bundled database runs it as its only init script. |
| Existing separated database | `packages/rab-docker/postgres-init/owner-login/transition-from-separated.sql`: section 5. |

**Provider extras** (M0 §5.1 and §8; EXPECTED unless marked):

| Provider | Extra admin steps | Status |
|---|---|---|
| Self-hosted 16 | Alternatively `CREATE DATABASE crewflow OWNER crewflow_owner;` | VERIFIED (M0) |
| Self-hosted 18 | Wait for the PG18 fingerprints. | BLOCKED until D4 |
| Neon | The console-created `crewflow_app` (BYPASSRLS, REPLICATION, `neon_superuser`) must first be deleted in the Neon console, which **NEEDS OWNER APPROVAL**. Use PG16 for new projects until D4. Direct host, never `-pooler`. **Never touch the temporary deployment's Neon project without approval.** | EXPECTED |
| DigitalOcean | The admin may pre-create the extensions. Never the pool port 25061. Never `doadmin` as the app login. | EXPECTED |
| AWS RDS | Keep `rds.restrict_password_commands=0`. Never RDS Proxy, never the master user. | EXPECTED |
| Supabase | The extensions must not already exist outside `public`. Never expose `core` / `workspace_*` through the Data API. Never `:6543`. | EXPECTED |
| Cloud SQL | The admin must pre-create `btree_gist`, `citext`, `pg_trgm`, `pgcrypto` and `unaccent` `WITH SCHEMA public`. SQL, not `gcloud`. | EXPECTED |
| Azure Flexible | `azure.extensions=BTREE_GIST,CITEXT,PG_TRGM,PGCRYPTO,UNACCENT`; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Never `:6432`. | EXPECTED |
| PostgreSQL ≤ 15 | Refused (CREATEROLE could grant `pg_execute_server_program`). | UNSUPPORTED |

**Optional hardening after the install:** `ALTER ROLE crewflow_owner NOCREATEROLE;` (M0).
- **Flagged assumption:** a later release whose migrations create roles would need CREATEROLE again. Check pending lists for `CREATE ROLE` before each release.

**Fresh install is BLOCKED on every provider** until Agent 1's ROW_COPY shim, the PG18 fingerprints and the rolemaker land (M0 §8). After that it is EXPECTED to work, NOT TESTED on any managed provider.

---

## 5. Transition: today's separated deployment → the owner login

**Applies to:** a database that today runs separated mode, with these logins:
- `crewflow_app` for the API and Worker jobs;
- `crewflow` for the provisioner;
- `crewflow_migrator` for `rab-migrate`;
- optionally `crewflow_worker`.

**Do not run it on the temporary Neon/OpenShip deployment without explicit owner approval.** That database is kept
unchanged.

**5.0 Preconditions (all of these, in writing):**
- the owner-login release (PRs 2–7 of the owner's order) has merged, with Agent 5's integrated verification passing;
- the owner has approved the protections in section 1 that are not in §2;
- `THREAT-MODEL.md` and `CLAUDE.md` are amended;
- an external audit sink is configured;
- a maintenance window is agreed. The transition stops the old stack, because two versions must never overlap (3.7).

**5.1 Inventory (read-only, as the provider admin).** Record each of these in the change record:
- the migration ledger head;
- `pg_roles` and `pg_auth_members` for the Crewflow roles;
- the deployment identity marker;
- the current image digests.

These are what rollback compares against.

**5.2 Backup or PITR marker: MANDATORY, before 5.3.** Take it before `transition-from-separated.sql` runs. Self-hosted: as the cluster superuser, `pg_dumpall --roles-only` plus `pg_dump -Fc --create`. Managed: record the PITR timestamp or snapshot. Exact commands and the restore: [`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md) §2 and §4. The owner login cannot take this backup (BC-12). Confirm that a restore of it has been **tested**.

**5.3 Provider-admin SQL.** The admin runs `postgres-init/owner-login/transition-from-separated.sql` (Agent 1). Per M0 §3.1, it:
- creates `crewflow_owner`;
- grants its memberships of the existing **schema** roles;
- **never** makes it a member of `crewflow_app` or `crewflow_worker`.

The file's own verification queries must pass before anything else happens. **After the transition the legacy logins (`crewflow_app`, `crewflow`, `crewflow_worker`, `crewflow_migrator`) are NOLOGIN (BC-17, Agent 1).** The old stack can no longer connect. Restoring the pre-upgrade backup (5.2) brings them back as they were.

**5.4 Host configuration (new files beside the old ones):**
- `database.env`: the `crewflow_owner` URL and the same CA. If the separated deployment declared `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID`, keep the **same** values (they are optional, BC-11). Set `CREWFLOW_MIGRATION_APPROVAL_MODE=token` here if you want the token safety net for the transition.
- `runtime.env`: the **current** `APP_SECRET`, keyrings, S3, email and OAuth values, **unchanged**. Changing APP_SECRET breaks every session and every stored encrypted secret.
- `compose.env`: the owner-login digests.
- **Keep** the old separated files (`.env.migrate`, the per-service env files or platform entries) untouched, `0600`, until the rollback window closes.
- Lint all three new files.

**5.5 Stop the old stack, Worker first.** The Worker drains its 30 s jobs; then the API. Keep its containers and images (`stop`, not `down`).

**5.6 Release step:** 3.2 → 3.3 (already done in 5.2) → 3.4, as in a normal release. The classifier must report the separated ledger as an upgrade (CURRENT or behind), **never FOREIGN**. A FOREIGN or identity refusal (67) means stop and roll back (5.9a).

**5.7 Promote:** `$P up -d --wait`.

**5.8 Verify (owner-login stack):**
- `/healthz`;
- the boot gates and posture check (in the API and Worker logs);
- the Worker heartbeat;
- a functional smoke: sign-in with MFA, one shift read, one payroll read, a workspace provision;
- the audit sink receiving events;
- no service holds any old credential (`docker compose config` plus the gate).

**5.9 Rollback to separated.** Full procedure and evidence: [`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md).
- **(a) 5.3 has not run yet:**
  1. `$P down`. Never `-v`.
  2. Restart the old stack from 5.5 with its old env files and digests.

  Nothing in the database changed, so the old logins still work.
- **(b) 5.3 ran (the legacy logins are NOLOGIN, BC-17), or anything was applied in 5.6 (the supported rollback, PROVEN):**
  1. Stop everything.
  2. Restore 5.2 (`OWNER-LOGIN-RECOVERY.md` §4).
  3. Then do (a).

  An old image on the upgraded database is **not** supported in production and fails closed. The old api and worker refuse at their boot gate (unknown `provision_workspace` version), and the old provisioner refuses because the ledger is AHEAD (`OWNER-LOGIN-RECOVERY.md` §3). The transition's migrations are not "expand-only" for the old code.
- **`crewflow_owner` after a rollback:** the admin may `ALTER ROLE crewflow_owner NOLOGIN` (reversible). **Do not `DROP ROLE`** without Agent 1's guidance: objects it created would need `REASSIGN OWNED`.

**5.10 After the rollback window.** The transition already makes the old logins NOLOGIN (BC-17). Dropping their passwords and deleting `.env.migrate`, the per-service files and the separated compose paths belong to the **final PR (#9)**. That needs:
- the replacement passing every mandatory test;
- this procedure independently reviewed;
- owner approval.

The golden security posture expects some of those roles to stay LOGIN, so retiring them is a posture change (security agent). Until then, keep the old credentials in the secret store, **out of every owner-login file**.

**Recovery quick reference:**

| Failure | Action |
|---|---|
| 5.3 fails | Nothing app-side changed. Follow the script's recovery notes, then restart the old stack. |
| 5.6 exits 3 with an unexpected pending set | Stop. Review it, or roll back (5.9a). |
| 5.6 fails part-way | Resume on the NEW image after review (3.6c), or restore: 5.9b. |
| 5.7/5.8 fail | 5.9b (restore, then the previous image). The old image on the upgraded database fails closed in production. |

---

## 6. Production risk of migrate-on-start (explicit statement)

**`docker-compose.migrate-on-start.yml` (API migrates at every start, approval `none`) is NOT acceptable for
production.** It stays supported for quick self-hosting only. In production it causes the following:

1. **Unreviewed production schema changes (G-07).** Any start of a new image applies whatever it ships: an auto-deploy, a mistaken `pull && up`, a platform redeploy. Nobody reviews the pending set, and nobody takes a backup at the moment it applies. With BC-11 the release step also applies without a token by default; what it adds over migrate-on-start is **one** sequential run before the API, with the backup taken first (3.3), rather than a migration on every API start.
2. **Rollback becomes an outage or data loss (C-1).** A contracting migration applied by the new image cannot be undone by starting the old one. Even expand-only rollback relies on the classifier tolerating AHEAD (NOT TESTED).
3. **Two-version starts block and serve intermediate schemas.** The lock waiter blocks up to 600 s (840 s worst case); migrations commit one by one under live traffic.
4. **Crash-loop amplification.** A failing migration retries on every restart, against production.
5. **Authority in the long-running process (ST-3).** Under the owner login the API already holds schema authority (PT-01). Migrate-on-start adds the **act** of changing the schema to every API start.
6. **It does not reduce the owner-login blast radius.** Neither does the release step: both use the one login.

> **SECURITY TRADE-OFF (ST-3, as amended by BC-11, owner decision 2026-11-05).** Both lifecycle paths apply **without a token by default** (approval mode `none`), and the deployment id is optional, like Twenty. Token mode and a declared deployment id are opt-in safety nets; token mode's rule is unchanged when on. **Production uses the in-place default:** API `CREWFLOW_MIGRATE_ON_START=false`, the one-off `rab-migrate` run first, a **mandatory** pre-upgrade backup, and one API replica. The quick-start override migrates on every API start and stays for self-hosting only. The gate fails CI if the production default ever renders the API with migrate-on-start on, or not waiting for `rab-migrate`. It no longer requires token mode.
>
> **The release step's authority.** `rab-migrate` holds no separately held command authority (`DB_TARGET=production` + `ALLOW_PRODUCTION_DB_COMMANDS=true`); the gate refuses both on every service. With the defaults, anyone who can run it with the shared `database.env` **applies** the pending set. Accepted risk: a wrong image or URL migrates production, and recovery is restore only (section 3, "ACCEPTED RISK"). Mitigation: `database.env` is root-only 0600, the backup is mandatory, and token mode plus a deployment id are available opt-ins.

**OpenShip is unsupported for the owner-login deployment (M0 D11).** OpenShip drops these keys: `user`, `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit`, `env_file` and the `depends_on` conditions. Without the root launcher, the Worker image's root default user runs **the Worker itself as root**.
- **`docker-compose.production.yml` is OpenShip's file, and a push to `main` may redeploy it.** Merging its in-place edit would redeploy the temporary deployment into a shape that cannot start there: no `crewflow_owner` exists on its database, and the Worker would run as root.
- **NEEDS OWNER APPROVAL:** disable OpenShip auto-deploy, or accept the outage, before that PR merges.

Use plain Docker Compose (`OWNER-LOGIN-ORACLE-VM-PLAN.md`).

## 7. Operations

- **Logs:** `json-file`, 10 MB × 5 per container. Ship them off the host, because forensics depend on them.
- **Redis:** AOF `everysec`, `noeviction`, an ACL; never published.
- **Owner password rotation:** done by the admin at the provider. Then update `database.env` and restart rab-api and rab-worker. After a suspected compromise, rotation is **not** remediation: inventory roles, memberships, ADMIN rows, definers, policies and triggers first (M0 §6.4 item 9).
- **Worker runtime-isolation self-check:** the separated root launcher's H6 report/enforce is ported into `rab-worker` itself (Agent 2). At start it logs `[worker-isolation] runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids.max=… memory.max=… mode=enforce`, and with `CREWFLOW_RUNTIME_ISOLATION=enforce` (committed in `docker-compose.image.yml`) it **refuses to start** when any of these is missing: uid 1000, an empty capability bounding set, no-new-privileges, a read-only root, a PID limit, a memory limit.
- **Resources:**
  - API: 1 GB (raised from 768 MB for the migration child under migrate-on-start; NOT MEASURED).
  - Worker: 1.5 GB, with the native PDF budget rule from #61 (`PDF_NATIVE_MEMORY_BUDGET_MB`).
  - Redis: 640 MB.

## 8. Interface assumptions and test status

| Assumption | Owner |
|---|---|
| `CREWFLOW_MIGRATE_ON_START`, `CREWFLOW_MIGRATION_APPROVAL_MODE=none\|token` and `CREWFLOW_UPGRADE_FAILURE_POLICY` are read with these names (`runtime-db-config.ts`). There is no `CREWFLOW_DB_MODE`. **Approval mode defaults to `none`** (BC-11): the release step and migrate-on-start apply without a token. Token mode is opt-in (`database.env`); when on, every non-fresh apply needs `CREWFLOW_MIGRATION_APPROVED`, on any target (exit 65 without it), and a proven fresh install and check runs are unchanged (Agent 1, `approvalDecision`, f77fc9e5). `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID` are optional: matched when declared, a warning when absent. | Agents 1 and 2 |
| `./api-prestart.sh` runs the migration child when `CREWFLOW_MIGRATE_ON_START=true`, and a read-only compatibility check otherwise. | Agent 2 |
| `deploy-prepare.js` (in place) is the release step. In mode `none` (default) a run applies; with token mode on, no token = check run (0 current, 3 pending) and `CREWFLOW_MIGRATION_APPROVED=<token>` = apply run. Failures exit 64–69 by kind. It reads `PG_DATABASE_URL`, with no `DB_TARGET` / `ALLOW_PRODUCTION_DB_COMMANDS`. (Agent 1; BC-11.) | Agent 1 |
| `node packages/rab-worker/dist/main.js` runs standalone as uid 1000 with in-process provisioning and writes `CREWFLOW_INSTANCE_HEALTH_FILE`. | Agent 2 |
| `01-crewflow-owner.sql` reads the password file named by `-v owner_password_file=…` (default `/run/secrets/crewflow-owner-password`, at least 24 characters) inside psql, suppresses statement logging only for a superuser session, and grants on `:"DBNAME"`. (Agent 1, `twa/db-lifecycle`.) | Agent 1 |
| `bootstrap-admin` is email-only with an activation link, runs as a one-off `run --rm` of `rab-api` on the owner login after the API is healthy, with per-invocation `DB_TARGET=production` + `ALLOW_PRODUCTION_DB_COMMANDS=true` on that run only (section 2, step 6). (Agent 1, confirmed.) | Agent 1 |
| The Worker refuses to run as PID 1 (watchdog SIGKILL); `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS`, `CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS`, `CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS` with the ranges above. | Agent 2 |

**Tested here:**
- the gate: 18 self-tests, plus `--static` on the committed files;
- `docker compose config` of image + local-db;
- a disposable PG16.15 run of `docker-compose.local-db.yml` with **Agent 1's `01-crewflow-owner.sql` (`twa/db-lifecycle` b5a03348)** as its one init file, 21/21 checks:
  - the exact `crewflow_owner` attributes and the database grant `WITH GRANT OPTION`; no other role or membership created;
  - SCRAM storage; TLS on; verify-full accepted;
  - refused: a non-TLS login, the superuser over the network, another database, a wrong host name, a wrong password;
  - no route out of the internal network; no password in the server log;
  - read-only root, `CapBnd` 0, `NoNewPrivs` 1;
  - a second start does not re-run the init; a short password refuses the init and the container never becomes healthy.

**NOT TESTED:**
- any real owner-login image;
- the transition procedure;
- the rollback paths;
- managed providers;
- the Oracle VM plan.
