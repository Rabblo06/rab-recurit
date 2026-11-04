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
| `docker-compose.image.yml` (in place) | The stack: `rab-api`, `rab-worker`, `rab-redis`, and the one-off `rab-migrate`. **Controlled release is the default:** the API does not migrate; `rab-migrate` (`deploy-prepare.js`, same image, same login, token) does. | after #61/#62 |
| `docker-compose.migrate-on-start.yml` | Quick-start override: the API migrates on start (approval `none`); `rab-migrate` is not part of the stack. | after #61/#62 |
| `docker-compose.local-db.yml` | Optional bundled PostgreSQL 16. Its one init file is Agent 1's `postgres-init/owner-login/01-crewflow-owner.sql`. | now |
| `staging/docker-compose.staging.yml` (in place) | Project name and storage prefix only. The env files now come from the base file. | after #61/#62 |
| `docker-compose.production.yml` (in place) | The build-based OpenShip file, reshaped to one URL. **OpenShip cannot run the owner-login Worker safely** (section 6). | after #61/#62 |
| `env/database.env.example` | **Shared** database file: `PG_DATABASE_URL` and the deployment identity. Read by rab-api, rab-worker and rab-migrate. | now |
| `env/runtime.env.example` | Runtime secrets for rab-api and rab-worker only. The release step never reads it. | now |
| `env/compose.env.example` | Interpolation values: digests, paths and limits. No secret. | now |
| `env/redis-users.acl.example` | Redis ACL: `default` off, app user stored by SHA-256, PING-only health user. | now |
| `local-db/pg_hba.conf` | Bundled database: superuser on the local socket only; `crewflow_owner` over TLS only. | now |
| `postgres-init/owner-login/01-crewflow-owner.sql`, `transition-from-separated.sql` | **Agent 1's** tested provider-admin SQL. Referenced here, never copied. | Agent 1 |

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
   - **Deployment id:** `uuidgen` goes in `CREWFLOW_DEPLOYMENT_ID`. It is optional on the very first boot of an empty database and mandatory ever after.
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
   - **Controlled (production):** use section 3 from step 3.2. On an EMPTY database `rab-migrate` exits 3 with the full chain as the pending set; approve it with the token.
6. **First platform admin.** Use the existing one-off `bootstrap-admin` command. Its owner-login invocation (which login, and which authority) is an Agent 1/2 interface and is **not defined yet**. `BOOTSTRAP_ADMIN_*` never goes in an env file.

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
(`CREWFLOW_MIGRATE_ON_START=false`, approval `token`). The one-off `rab-migrate` does: `deploy-prepare.js`, updated in
place by Agent 1, from the **same image digest** and the **same `database.env`**. The API and Worker depend on it.

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

**3.2 Preflight (read-only).**
1. Lint the env files and run `$P config -q`.
2. `$P pull`.
3. Run the schema-compatibility check:
   ```bash
   $P run --rm rab-migrate
   ```
   - **0:** CURRENT or AHEAD. Nothing to apply; go to 3.5.
   - **3:** pending. The log lists each migration and prints `pending-<count>-<sha256>`. Nothing was applied.
   - **Anything else: STOP.** The M0 §7 codes are 64 config, 65 behind, 66 migration failed, 67 identity, 68 post-check and 69 lock timeout; 1 is a refused or stale token. Nothing was applied, and the running release is untouched.

   With the bundled database, `run` starts `rab-postgres` first, because the local-db override declares rab-migrate's dependency.
4. **Expand-only review of the pending list.** An expand-only lint **NEEDS OWNER APPROVAL**; until then this is a manual review.

   The release is rollback-safe only if every pending migration only **adds** (tables, nullable or defaulted columns, indexes, functions, policies) and drops, renames, retypes or narrows nothing the previous image uses. Otherwise rollback is a restore (3.6b). Get the owner's go-ahead.

**3.3 Backup or PITR marker (when 3.2 exited 3).** The app login cannot take a logical backup (FORCE-RLS tables dump empty).
- **Managed provider:**
  - take a provider snapshot or branch, OR
  - record the PITR restore time (`SELECT now()`) and the provider's window.

  Record it in the release notes.
- **Bundled database:** as the superuser over the local socket:
  ```bash
  $P $L exec -T rab-postgres pg_dump -U postgres -d crewflow -Fc > /var/backups/crewflow-<release>.dump
  ```
  Use `0600` and keep a copy off the host, or snapshot the volume with the stack stopped. Test restores periodically.

**3.4 Apply exactly the reviewed set.** The token goes through the environment of one command only. `-e NAME` with no value forwards it from the shell, so it never sits in a file or on a command line:
```bash
read -r CREWFLOW_MIGRATION_APPROVED && export CREWFLOW_MIGRATION_APPROVED   # paste the token from 3.2
$P run --rm -e CREWFLOW_MIGRATION_APPROVED rab-migrate; rc=$?
unset CREWFLOW_MIGRATION_APPROVED; echo "rab-migrate exit $rc"
```
- **Exit 0:** applied, and the post-checks passed.
- **Anything else:** see 3.6.

The token is recomputed under the lock, so a changed pending set applies nothing.

**3.5 Promote.**
```bash
$P up -d --wait --wait-timeout 600
```
`rab-migrate` re-checks and must exit 0. Then the API starts: it runs a read-only compatibility check and refuses to serve otherwise. The Worker follows a healthy API. Verify `$P ps`, `/healthz` through the edge, and the Worker health line. Compose returns 1 when `rab-migrate` does not exit 0; nothing new is promoted in that case.

**3.6 Rollback.**
- **(a) Expand-only release:**
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

**5.2 Backup or PITR marker.** As 3.3. Confirm that a restore of it has been **tested**.

**5.3 Provider-admin SQL.** The admin runs `postgres-init/owner-login/transition-from-separated.sql` (Agent 1). Per M0 §3.1, it:
- creates `crewflow_owner`;
- grants its memberships of the existing **schema** roles;
- **never** makes it a member of `crewflow_app` or `crewflow_worker`.

The file's own verification queries must pass before anything else happens. The old logins are **not** changed; they are the rollback path.

**5.4 Host configuration (new files beside the old ones):**
- `database.env`: the `crewflow_owner` URL, the **same** `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID`, the same CA.
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

**5.9 Rollback to separated:**
- **(a) Nothing was applied in 5.6, or everything applied was expand-only:**
  1. `$P down`. Never `-v`.
  2. Restart the old stack from 5.5 with its old env files and digests.

  The old logins still work, because 5.3 did not change them.
- **(b) Otherwise:**
  1. Stop everything.
  2. Restore 5.2.
  3. Then do (a).
- **`crewflow_owner` after a rollback:** the admin may `ALTER ROLE crewflow_owner NOLOGIN` (reversible). **Do not `DROP ROLE`** without Agent 1's guidance: objects it created would need `REASSIGN OWNED`.

**5.10 After the rollback window.** Retiring the old logins (NOLOGIN, rotated or dropped passwords) and deleting `.env.migrate`, the per-service files and the separated compose paths all belong to the **final PR (#9)**. That needs:
- the replacement passing every mandatory test;
- this procedure independently reviewed;
- owner approval.

The golden security posture expects some of those roles to stay LOGIN, so retiring them is a posture change (security agent). Until then, keep the old credentials in the secret store, **out of every owner-login file**.

**Recovery quick reference:**

| Failure | Action |
|---|---|
| 5.3 fails | Nothing app-side changed. Follow the script's recovery notes, then restart the old stack. |
| 5.6 exits 3 with an unexpected pending set | Stop. Review it, or roll back (5.9a). |
| 5.6 fails part-way | 3.6c, or 5.9b. |
| 5.7/5.8 fail | 5.9a if expand-only, else 5.9b. |

---

## 6. Production risk of migrate-on-start (explicit statement)

**`docker-compose.migrate-on-start.yml` (API migrates at every start, approval `none`) is NOT acceptable for
production.** It stays supported for quick self-hosting only. In production it causes the following:

1. **Unreviewed production schema changes (G-07).** Any start of a new image applies whatever it ships: an auto-deploy, a mistaken `pull && up`, a platform redeploy. Nobody reviews the pending set and nobody takes a backup.
2. **Rollback becomes an outage or data loss (C-1).** A contracting migration applied by the new image cannot be undone by starting the old one. Even expand-only rollback relies on the classifier tolerating AHEAD (NOT TESTED).
3. **Two-version starts block and serve intermediate schemas.** The lock waiter blocks up to 600 s (840 s worst case); migrations commit one by one under live traffic.
4. **Crash-loop amplification.** A failing migration retries on every restart, against production.
5. **Authority in the long-running process (ST-3).** Under the owner login the API already holds schema authority (PT-01). Migrate-on-start adds the **act** of changing the schema to every API start.
6. **It does not reduce the owner-login blast radius.** Neither does the release step: both use the one login.

> **SECURITY TRADE-OFF (ST-3, restated for veto).** The quick-start override sets `CREWFLOW_MIGRATE_ON_START=true` with approval `none`, trading per-release review for a one-command self-hosted install. **Production uses the in-place default:** API `false`, a token-approved `rab-migrate`, a backup, and one API replica. The gate fails CI if the default ever renders the API with migrate-on-start on, without the token, or without waiting for `rab-migrate`.

**OpenShip is unsupported for the owner-login deployment (M0 D11).** OpenShip drops these keys: `user`, `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit`, `env_file` and the `depends_on` conditions. Without the root launcher, the Worker image's root default user runs **the Worker itself as root**.
- **`docker-compose.production.yml` is OpenShip's file, and a push to `main` may redeploy it.** Merging its in-place edit would redeploy the temporary deployment into a shape that cannot start there: no `crewflow_owner` exists on its database, and the Worker would run as root.
- **NEEDS OWNER APPROVAL:** disable OpenShip auto-deploy, or accept the outage, before that PR merges.

Use plain Docker Compose (`OWNER-LOGIN-ORACLE-VM-PLAN.md`).

## 7. Operations

- **Logs:** `json-file`, 10 MB × 5 per container. Ship them off the host, because forensics depend on them.
- **Redis:** AOF `everysec`, `noeviction`, an ACL; never published.
- **Owner password rotation:** done by the admin at the provider. Then update `database.env` and restart rab-api and rab-worker. After a suspected compromise, rotation is **not** remediation: inventory roles, memberships, ADMIN rows, definers, policies and triggers first (M0 §6.4 item 9).
- **Worker runtime-isolation self-check:** the separated root launcher's H6 report/enforce must be ported into `rab-worker` (Agent 2). Until then compose **applies** the Worker's isolation but nothing **self-verifies** it at start. `CREWFLOW_RUNTIME_ISOLATION=enforce` is already set, so the port takes effect without a compose change.
- **Resources:**
  - API: 1 GB (raised from 768 MB for the migration child under migrate-on-start; NOT MEASURED).
  - Worker: 1.5 GB, with the native PDF budget rule from #61 (`PDF_NATIVE_MEMORY_BUDGET_MB`).
  - Redis: 640 MB.

## 8. Interface assumptions and test status

| Assumption | Owner |
|---|---|
| `CREWFLOW_MIGRATE_ON_START`, `CREWFLOW_MIGRATION_APPROVAL_MODE=none\|token` and `CREWFLOW_UPGRADE_FAILURE_POLICY` are read with these names (`runtime-db-config.ts`). There is no `CREWFLOW_DB_MODE`. | Agents 1 and 2 |
| `./api-prestart.sh` runs the migration child when `CREWFLOW_MIGRATE_ON_START=true`, and a read-only compatibility check otherwise. | Agent 2 |
| `deploy-prepare.js` (in place) is the release step, with exit codes 0 / 3 / M0 §7 and token approval. It reads `PG_DATABASE_URL` only, with no `DB_TARGET` / `ALLOW_PRODUCTION_DB_COMMANDS`. | Agent 1 |
| `node packages/rab-worker/dist/main.js` runs standalone as uid 1000 with in-process provisioning and writes `CREWFLOW_INSTANCE_HEALTH_FILE`. | Agent 2 |
| `01-crewflow-owner.sql` reads the password from `/run/secrets/crewflow-owner-password` inside the SQL, and fails on a missing or short password. A tested reference implementation was handed to the lead. | Agent 1 |
| The `bootstrap-admin` owner-login invocation. | Agents 1 and 2 |

**Tested here:**
- the gate: 18 self-tests, plus `--static` on the committed files;
- `docker compose config` of image + local-db;
- earlier, a disposable PG16 run of the bundled database shape: TLS verify-full, the hba refusals, the read-only root, no capabilities, the internal network, no password in the logs, the half-initialised volume staying unhealthy (21 checks). That run used a reference init script, **not** Agent 1's file, so it must be re-run once that file lands.

**NOT TESTED:**
- any real owner-login image;
- the transition procedure;
- the rollback paths;
- managed providers;
- the Oracle VM plan.
