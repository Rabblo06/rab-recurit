# Owner-login deployment: install, release, transition and rollback runbook

**Status (verified state as of 2026-11-05).** Integration branch `deploy/twenty-mode-a`, draft PR #72. Evidence logs are
in the session scratchpad (not committed); each line names its source.

| Area | Result | Evidence |
|---|---|---|
| Fresh install, lifecycle, transition from separated, Test C/D | **PASS on PostgreSQL 16, 17 and 18**; the v20 workspace fingerprints for all three majors are committed. The negative cases refuse as designed: a non-owner identity; PG15 (below 16) | Agent 1: `a1/batch-pg16*.log`, `a1/batch-pg18*.log`, `a1/batch-v20-*.log` ("all checks passed") |
| End to end: empty database → API migrate-on-start → healthy → Worker → workspace READY | **PASS on PG16** (postgres:16-alpine; the API and Worker ran as host processes, not in the containers) | Agent 2: `twa-app/e2e.sh`, `twa-app/batch-e2e.log` ("E2E PASSED": state EMPTY → 254 ledger rows, `/healthz` 200, workspace provisioned in-process: attempted=1 ready=1), `twa-app/e2e-api.log`, `e2e-worker.log`, `e2e-healthz.json` |
| Rollback | **PROVEN**: restore the pre-upgrade backup, then the previous image. R2: checksum equal on 112 facts, ledger 250, old api, Worker and provisioner healthy. R1: an old image on the upgraded database fails closed in production | Agent 1: `a1/rollback/r1b.log`, `r2.log`; [`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md) |
| Database setup like Twenty (DB-SETUP, 2026-11-12): the bundled `db` service, one database setting, crewflow_owner created by the one-shot `db-setup` with a random password kept in a file (PR #125, the Twenty Helm model, owner-approved 2026-11-13; re-measurement pending, section 8) | **PASS** (before option A) on disposable Debian postgres 16.15, 17.11 and 18.6: fresh install with only `PG_DATABASE_PASSWORD` + `APP_SECRET`, restart unchanged, external non-superuser admin, refusals (admin without rights, privileged crewflow_owner, PG15), no admin credential in any process environment of rab-api / rab-worker (PID 1 included), R256 upgrade, logs, two simultaneous starts (section 8) | DB-SETUP areas 5 and 6 (`deploy-order-tests/run-db-setup-tests.cjs`) |
| Retired: `docker-compose.local-db.yml` (DB-SETUP D3) | Replaced by the bundled `db` service of the image compose | — |
| Compose and env gate (`scripts/compose-owner-login.cjs`) | **PASS**: every combination (bundled db; `PG_ADMIN_URL`; a `crewflow_owner` `PG_DATABASE_URL`; both of those with `CREWFLOW_BUNDLED_DB=0` and **no** `PG_DATABASE_PASSWORD`; staging); `PG_ADMIN_URL` never on rab-api / rab-worker in any compose file; the gate's own tests pass | `ci-deployment-owner-login.yaml` |
| Full CI on #72 | **Green at `79a083e1`** (12/12 workflow runs). At head `91a5e699` (2026-11-05) the run was still in progress, and its e2e `web-isolated` job had failed; it needs a re-check before review | GitHub Actions, `deploy/twenty-mode-a` |

**NOT TESTED:**
- a real production boot (TLS verify-full, S3, a production deployment identity);
- managed-provider PITR or snapshot restore, and any managed-provider fresh install;
- OpenShip (unsupported, section 6);
- the Oracle VM plan.

Production use still needs the owner's approval of each release and of the open owner-approval items.

**O3 (owner decisions C1-C5, 2026-11-05, "EXACTLY LIKE TWENTY"; G-07 accepted).** The API migrates on start in
production; there is no release step and no `rab-migrate`. `docker-compose.migrate-on-start.yml` is folded into
`docker-compose.image.yml` and deleted. The Worker never migrates and only consumes the BullMQ job schedulers the API
registers. Run ONE API and deploy stop-then-start (C5). The pre-upgrade backup is the recovery path, so it is MANDATORY
(section 3.3).

**Architecture (owner's final decision, 2026-11-04).** There is ONE permanent architecture, with no mode switch:
- one schema-owning login, `crewflow_owner`, for the API, the Worker and the release step;
- one runtime URL, `PG_DATABASE_URL`, which ALWAYS means that app login. The database ADMIN login, when there is one, is
  `PG_ADMIN_URL` and reaches the one-shot `db-setup` service only (owner decision 2026-11-17, like Twenty's Helm chart:
  the admin login lives only in the setup step).

The former separated logins (`crewflow_app`, `crewflow`, `crewflow_worker`, `crewflow_migrator`) remain **schema roles**
that historical migrations and definers need. They are no longer runtime logins. O1/O2: ONE hardened image runs the
API and the Worker (different commands), published under one tag and deployed by one digest (`CREWFLOW_IMAGE_TAG`, named like Twenty's `TAG` but accepting only a
`sha256:` digest; `CREWFLOW_IMAGE_DIGEST` was its name until 2026-11-11 and is now refused).
Design source: the M0 decision document
`TWENTY_MODE_M0_DECISION_2026-11-04.md` ("M0") and the owner-login addendum. The repository's root `docs/` is
git-ignored, so neither is committed.

| File | Purpose | Lands |
|---|---|---|
| `docker-compose.image.yml` (in place) | The stack: `db` (the bundled PostgreSQL, DB-SETUP), the one-shot `db-setup` (PR #125: the only service that receives `PG_ADMIN_URL` or an operator's `PG_DATABASE_URL`; it creates `crewflow_owner`, stores its random password in the `crewflow-db-target` volume and exits), `rab-api`, `rab-worker`, `rab-redis` (O3: no `rab-migrate`). The API migrates on start (approval mode `none` by default, `token` an opt-in of `compose.env`), registers the job schedulers, then serves; the Worker never migrates and only consumes the schedulers. | O3, DB-SETUP |
| `staging/docker-compose.staging.yml` (in place) | Project name and storage prefix only. The env files now come from the base file. | after #61/#62 |
| `docker-compose.production.yml` (in place) | Image-based like Twenty (2026-11-11): the same `CREWFLOW_IMAGE_TAG` digest for rab-api and rab-worker, per-service environment instead of env files. Never builds. **OpenShip cannot run the owner-login Worker safely** (section 6). | 2026-11-11 |
| `docker-compose.local-build.yml` | **LOCAL/DEV ONLY.** The former build-based production file; never run it on a server (a server only runs the gated image). | 2026-11-11 |
| `env/database.env.example` | **Shared** database file: the optional `PG_SSL_CA_CERT_PATH` or `PG_SSL_CA_CERT` (external database; never both), `PG_EXPECTED_DATABASE_NAME` and deployment identity. Read by rab-api and rab-worker. Never `PG_DATABASE_URL` or `PG_ADMIN_URL` (DB-SETUP: compose.env). | now |
| `env/runtime.env.example` | Runtime secrets for rab-api and rab-worker. (The former `CREWFLOW_UPGRADE_FAILURE=refuse` opt-in, C3, was removed in OWNER-DB-ULTIMATE Part B3 and is refused.) | now |
| `env/compose.env.example` | Interpolation values: digests, paths and limits, and the database values (DB-SETUP, three modes, section 2): `PG_DATABASE_PASSWORD` (the bundled db only), or with `CREWFLOW_BUNDLED_DB=0` exactly one of `PG_ADMIN_URL` (your own database's admin URL) and `PG_DATABASE_URL` (a `crewflow_owner` URL you created); db-setup only. No other secret. | now |
| `env/redis-users.acl.example` | Redis ACL: `default` off, app user stored by SHA-256, PING-only health user. | now |
| `local-db/pg_hba.conf` | Test harnesses only (deploy-order, system e2e); no deploy file mounts it since DB-SETUP. | now |
| `postgres-init/owner-login/01-crewflow-owner.sql`, `transition-from-separated.sql` | **Agent 1's** tested provider-admin SQL, referenced here, never copied. Since DB-SETUP `01-crewflow-owner.sql` is an OPTIONAL fallback (section 4), not an install step: `db-setup` creates `crewflow_owner` itself. | Agent 1 |
| `docs/release/OWNER-LOGIN-RECOVERY.md` | Recovery and rollback: the mandatory pre-upgrade backup, restore-then-previous-image (proven), and why an old image on an upgraded database fails closed. | now |

Shorthand, used from `packages/rab-docker/` on the host:

```bash
I="-f docker-compose.image.yml"                # includes the bundled `db` (DB-SETUP; docker-compose.local-db.yml is retired)
P="docker compose --env-file /etc/crewflow/compose.env $I"        # production (the API migrates on start, O3)
```

**The deploy command is the same as Twenty's** (owner decision 2026-11-11). Set the compose files and the env file once
for the operator's shell (for example in `/etc/profile.d/crewflow.sh`, root-only), so the bare command uses them:

```bash
export COMPOSE_FILE=docker-compose.image.yml            # the bundled db is part of this file
export COMPOSE_ENV_FILES=/etc/crewflow/compose.env
cd /opt/crewflow/packages/rab-docker && docker compose pull && docker compose up -d
```

`$P pull && $P up -d` is the same command with the flags spelled out. It updates rab-api and rab-worker together
from the one `CREWFLOW_IMAGE_TAG`; there is no API-only or Worker-only deploy.

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
- The approved index digests: the release image (API and Worker) and Redis 7. The bundled `db` image is pinned in the compose file (postgres:16 Debian by digest; `CREWFLOW_POSTGRES_IMAGE` may name a Debian postgres:16, :17 or :18 digest, never alpine).
- A database, **three modes, no manual SQL step (DB-SETUP, like Twenty's Helm chart; `PG_ADMIN_URL`, owner decision 2026-11-17):** the admin login lives ONLY in the one-shot `db-setup` step; `PG_DATABASE_URL` ALWAYS means the app login, `crewflow_owner`. All of these are `compose.env` values that reach `db-setup` only; rab-api and rab-worker never receive a `PG_ADMIN_URL` value (both compose files pin it to `""` there, `scripts/compose-owner-login.cjs` fails any other value or placement, and their entrypoints and the in-process guard refuse a non-empty one, exit 64).
  - **(a) Bundled (default; `CREWFLOW_BUNDLED_DB` unset or `1`):** set only `PG_DATABASE_PASSWORD` (`openssl rand -hex 32`) in `compose.env`. `db-setup` then uses the `db` service's superuser, `sslmode=verify-full`; `db` makes its own CA and server certificate on its first start and rab-api / rab-worker mount the CA read-only. `PG_DATABASE_PASSWORD` is required in this mode only. It is no longer a compose `${...:?}` (that would demand it with your own database too), so a missing value is refused at start instead, with a clear message: by the `db` service's entrypoint (exit 64, before it touches the volume), by `db-setup` (exit 64), and before deploying by the `compose.env` lint and the `--environment` preflight.
  - **(b) Your own database with an admin login:** `CREWFLOW_BUNDLED_DB=0` and `PG_ADMIN_URL` = its **admin** URL at the **direct** host (never a transaction pooler), `sslmode=verify-full`, in `compose.env`. The login must be able to create roles (CREATEROLE or superuser) and to grant CONNECT, CREATE and TEMPORARY on the database; a missing right is refused with a fixed message (exit 64). `db-setup` creates `crewflow_owner` (pinning `createrole_self_grant` to empty first, so a non-superuser admin never gets SET or INHERIT on it). **No `PG_DATABASE_PASSWORD`** (the lint refuses one with `CREWFLOW_BUNDLED_DB=0`: no dummy value). `PG_ADMIN_URL` must not be the `crewflow_owner` login (refused: use mode c).
  - **(c) Your own database where you created `crewflow_owner` yourself:** `CREWFLOW_BUNDLED_DB=0` and `PG_DATABASE_URL` = the `crewflow_owner` URL (direct host, `sslmode=verify-full`), **no** `PG_ADMIN_URL`, no `PG_DATABASE_PASSWORD`. `db-setup` does no provisioning: it only runs the read-only checks below and exits (details in the next item but one).
  - With `CREWFLOW_BUNDLED_DB=0`, `db` has 0 replicas and never starts (Twenty's Helm `db.enabled: false`). Nothing depends on `db` (owner instruction 2026-11-18, Twenty's Helm wait-for-db init container): `db-setup` first waits, bounded, until the database it uses (the bundled `db`, or the host of `PG_ADMIN_URL` / `PG_DATABASE_URL`) accepts connections (`CREWFLOW_DB_WAIT_SECONDS` in `compose.env`, default 170 so it ends inside OpenShip's 180 s dependency window, 0-900, 0 = do not wait; on timeout one fixed line and exit 70, nothing changed), then continues. OpenShip ignores `deploy.replicas`: there, switch the `db` service off in OpenShip itself. `db-setup` still runs (mode b creates `crewflow_owner`, mode c checks it, and both write the files the apps read). The lint and the `--environment` preflight (`staging/verify-image-compose.cjs`) refuse `CREWFLOW_BUNDLED_DB=0` unless exactly one of `PG_ADMIN_URL` / `PG_DATABASE_URL` names a host other than `db`, both URLs at once, a `PG_DATABASE_URL` whose login is not `crewflow_owner`, and any `CREWFLOW_BUNDLED_DB` but `0` or `1`. A CA outside the system store: `CREWFLOW_PG_CA_FILE` in `compose.env` and `PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt` in `database.env`, **or**, where no file can be mounted (a PaaS), the CA's PEM text itself as `PG_SSL_CA_CERT` (see "Database TLS: which CA, and when verify-full cannot work" below).
   - **Database TLS: which CA, and when verify-full cannot work.** Production always verifies the server certificate's chain AND host name (verify-full); nothing turns that off (`PG_SSL_ALLOW_SELF_SIGNED` is refused in production). Give the CA one of two ways, never both (both set refuses to start): `PG_SSL_CA_CERT_PATH` (a mounted file) or `PG_SSL_CA_CERT` (the PEM text; in an env file or a platform UI that keeps one line, write the newlines as `\n`). Either is validated at boot (certificates only, each parsed; a pasted private key is refused) and never logged; the admin environment viewer shows it as Set / Not set. Download the CA from the provider over HTTPS, never from the server you are about to trust. By provider: **Neon, Azure Database for PostgreSQL, RDS Proxy**: public CAs, nothing to set. **AWS RDS / Aurora**: the RDS CA is private: use your region's bundle (`https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`, about 4.5 KB); the 170 KB global bundle exceeds Linux's 128 KiB limit for one environment value, so it only works as a file. **DigitalOcean, Aiven, Supabase, Scaleway**: the cluster/project CA from the provider's console. **A self-hosted server**: its CA, or its self-signed certificate itself (it must name the host you connect to: a DNS name in its SAN, or the IP as an IP SAN). **Cannot work today (fails closed):** a server whose certificate does not name the host Crewflow dials, e.g. Railway's public TCP proxy (per-instance self-signed CA, SAN `localhost` only) or Cloud SQL dialled by IP (use the instance's DNS name, or the Cloud SQL Auth Proxy); and Heroku Postgres without Enhanced Certificates. There is no option for these: no `verify-ca`, no "accept any certificate", and no expected-server-name setting (not implemented; owner-gated, and it would need an SPKI pin if it is ever approved).
   - **Upgrade notes for the stricter CA checks.** (1) A `PG_SSL_CA_CERT_PATH` file is now validated at boot exactly like `PG_SSL_CA_CERT`: a file holding anything but CERTIFICATE blocks (an `X509 CRL`, a `TRUSTED CERTIFICATE`, a bundled key, or a long base64 run outside the blocks), larger than 256 KiB, or not a regular file now **refuses to boot**; before, a loose pattern check let it through. Check it before deploying: the `--environment` preflight (`node packages/rab-docker/staging/verify-image-compose.cjs --environment ...`) runs the same rules on `CREWFLOW_PG_CA_FILE`, and the env-file lint runs them on `PG_SSL_CA_CERT` in `database.env` (and refuses either CA key in `runtime.env`). (2) A database dialled by **IP address** (`…@10.0.0.7:5432/…`) now needs that IP as an **IP SAN** in its certificate. Before, a node-postgres quirk made Node check an IP host against the name `localhost`, so a `localhost` certificate from the trusted CA was accepted. A DNS host name is unaffected.
  - **Renamed (2026-11-17):** before this release `PG_DATABASE_URL` also carried the admin URL. That meaning is gone and is never reinterpreted: a `PG_DATABASE_URL` whose login is not `crewflow_owner` is REFUSED (`PG_DATABASE_URL is the app login and must log in as crewflow_owner ... the admin URL was renamed to PG_ADMIN_URL`) by the lint, the preflight and `db-setup` itself (exit 64), and so is the retired name `PG_DATABASE_ADMIN_URL`. Move an admin URL to `PG_ADMIN_URL` (section 3.2, step 0b).
   - On every `up`, the one-shot `db-setup` service (the same image, entrypoint `./db-setup.sh`) runs the bootstrap child, the only process that connects with `PG_ADMIN_URL` (or an operator's `PG_DATABASE_URL`). First start: it generates a random 32-byte password and stores it as the pending file `/run/crewflow/db-target/owner-password.next` on the `crewflow-db-target` volume (0400, owner 1000:1000) BEFORE it touches the database, then creates `crewflow_owner` if it is missing (`LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT`) and grants it CONNECT, CREATE, TEMPORARY on the database; only after the COMMIT and a login with the new password is the pending file renamed to the password file `/run/crewflow/db-target/owner-password` (a run that fails in between leaves the password file as it was; the next start promotes the pending file if it logs in, deletes it only when it does not (28P01) or is not a usable file, and keeps it on any other error). Only one db-setup runs per volume at a time (a kernel lock on `.db-setup.flock` in the volume, plus a lock directory `.db-setup.lock`). Later starts: the file logs in, nothing changes. **One Crewflow deployment per PostgreSQL cluster when using an admin URL**: roles are cluster-wide, so a second deployment on the same cluster would share `crewflow_owner` and its password. It refuses an existing privileged `crewflow_owner`. It then writes a credential-free target file (`{"v":1,"host","port","database","params"}`: no login, no password) and exits 0. `db-setup` does not receive `APP_SECRET`: changing `APP_SECRET` never touches the database. rab-api starts only after that (`depends_on: condition: service_completed_successfully`). rab-api and rab-worker never receive `PG_ADMIN_URL` nor an operator's `PG_DATABASE_URL`: the compose files pin both `PG_DATABASE_URL` and `PG_ADMIN_URL` to `""` on both services (so an env-file value can never reach them; owner decision L-2), their entrypoints refuse any non-empty value of either, the other names of the admin URL, and any variable holding a `postgres://` URL (exit 64), and `api-prestart.sh` / `worker-start.sh` build the `crewflow_owner` URL from the target file and the password file (both mounted read-only), waiting (bounded, 120 s) for them and refusing with a fixed message (exit 75) after that.
  - **An existing `crewflow_owner` URL** (mode c; for example one made by hand with `own-database-app-login.sql`, section 4a) goes in `PG_DATABASE_URL`, with no `PG_ADMIN_URL`. `db-setup` logs in with it (a read-only session), runs the read-only refusals (SUPERUSER, BYPASSRLS, REPLICATION, CREATEDB, privileged memberships, missing grants, PostgreSQL below 16) and copies the URL's password into the password file. It never writes to the database and never changes the password: the URL keeps working for anything else that uses it. Keep `PG_DATABASE_URL` set afterwards (with `CREWFLOW_BUNDLED_DB=0`, unset is refused; with the bundled db on, unset means the bundled `db`). An existing deployment whose `crewflow_owner` lives on the bundled `db` (an upgrade from R254/R256) keeps the bundled db on, `PG_DATABASE_PASSWORD` set and its `crewflow_owner` URL in `PG_DATABASE_URL`.
  - **Crewflow additions (not in Twenty's Helm chart).** (1) With your admin URL, `db-setup` creates `crewflow_owner`: Twenty would run the app as that admin login, but Crewflow's tenant isolation needs RLS, which a superuser or BYPASSRLS login skips. (2) If the password file is lost and `db-setup` has an admin URL (`PG_ADMIN_URL`, or the bundled `db`), `db-setup` sets a new random password (`ALTER ROLE crewflow_owner PASSWORD`); with Twenty a lost secret leaves the app unable to log in.
  - **Protect the setup volume and its backups:** the password file is the `crewflow_owner` password. Volume backups and snapshots contain it; encrypt them and restrict who can read them.
- PostgreSQL 16, 17 and 18 are supported (v20 workspace fingerprints and a semantic posture golden for each). Below 16 is refused; a major above 18 is refused until its fingerprints and golden are generated and reviewed.
- **Production config refusals apply to every install, a trial included.** The API and Worker refuse to boot without:
  - `EMAIL_DRIVER` SMTP or RESEND;
  - S3 storage;
  - `https://` non-localhost URLs;
  - a narrow `TRUSTED_PROXY_CIDRS`.

**Compose shape, compared with Twenty (2026-11-17).** The same order as Twenty's `twenty-docker/docker-compose.yml` and
Helm chart, with the Crewflow controls kept where Twenty has none:

| Service | Like Twenty | Kept on purpose (why) |
|---|---|---|
| `db` | `postgres:16` by digest (16.16, the official index; checked against Docker Hub, comment next to the digest), `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD`, a `pg_isready` health check, no port. `CREWFLOW_BUNDLED_DB=0` = Helm `db.enabled: false`. | `POSTGRES_INITDB_ARGS` (SCRAM in the cluster's own pg_hba.conf, data checksums), `PGDATA` (the existing volume layout), `HOME=/tmp` (psql history, which can hold an `ALTER ROLE ... PASSWORD`, never lands in the data volume). A second volume, `crewflow-db-ca`, holds only the CA certificate the db makes for `sslmode=verify-full`: it is shared read-only with db-setup, rab-api and rab-worker, which must never see the data volume (cluster + server key). |
| `db-setup` | Helm's `ensure-database-exists`: one-shot (`restart: "no"`), after a healthy `db`, create-if-missing, safe to run again, exits 0. | It also runs with your own database (Twenty skips its init containers): it is the only service that ever holds a database URL. Its env is that one URL (superuser password, host and name) plus `NODE_ENV` / `RAB_RUNTIME_ENV` (production rules: verify-full, no libpq variables), plus the TLS trust setting of an external database: `env_file` `database.env` in `docker-compose.image.yml` (its `PG_SSL_CA_CERT_PATH`; never `runtime.env`), `PG_SSL_CA_CERT_PATH` in `docker-compose.production.yml`. The app role password is NOT an env var: db-setup generates it and stores it on `crewflow-db-target`, with the credential-free target file, which rab-api and rab-worker mount read-only instead of receiving a URL. `crewflow-db-ca` (read-only) is the bundled db's CA. |
| `rab-api` | Waits for `db` healthy and `db-setup` completed; migrates and runs the upgrade commands at start (`CREWFLOW_MIGRATE_ON_START=true`, in `api-prestart.sh`), like Twenty's server entrypoint. | Also waits for a healthy Redis. |
| `rab-worker` | `DISABLE_DB_MIGRATIONS=true` (the same name as Twenty's); starts after a healthy API. | `DISABLE_CRON_JOBS_REGISTRATION=true` (the API registers the schedulers). |

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
3. **Database.** Bundled: `PG_DATABASE_PASSWORD=<openssl rand -hex 32>` in `compose.env`, `PG_EXPECTED_DATABASE_NAME=crewflow` in `database.env`. Nothing else: no certificate, no SQL; `db-setup` makes the `crewflow_owner` password itself. Your own database: `CREWFLOW_BUNDLED_DB=0` and `PG_ADMIN_URL=<admin URL>` (mode b) or `PG_DATABASE_URL=<crewflow_owner URL>` (mode c) in `compose.env`, and NO `PG_DATABASE_PASSWORD`; only `db-setup` receives the URL. The bundled db reads `PG_DATABASE_PASSWORD` only on its volume's first start; to change it later, run `ALTER ROLE postgres PASSWORD ...` in the db container first (`docker compose exec -e PGPASSWORD db psql -U postgres -d crewflow`, `PGPASSWORD` = the current value: every login to the bundled db, socket included, needs the password, and every TCP login must use TLS: the db's entrypoint writes a `pg_hba.conf` with `hostssl ... scram-sha-256` lines only).
4. **Lint, then render.** Both print names only, never values.
   ```bash
   node scripts/compose-owner-login.cjs --lint-env-file compose  /etc/crewflow/compose.env
   node scripts/compose-owner-login.cjs --lint-env-file database /etc/crewflow/secrets/database.env
   node scripts/compose-owner-login.cjs --lint-env-file runtime  /etc/crewflow/secrets/runtime.env
   ```
   Then render the files you will start, e.g. `$P config -q`.
5. **Start:** `$P up -d --wait --wait-timeout 1200`. `db` becomes healthy first (its first start creates the CA and the server certificate). `db-setup` runs the bootstrap child (`[owner-bootstrap] crewflow_owner is ready (created).`, then `db-setup: done`) and exits 0; `$P logs db-setup` shows it. The API then builds the `crewflow_owner` URL, runs the check-first migration child under the lock (bootstrap, the whole chain, then the post-checks), registers the job schedulers, and serves only after it succeeds; a first-install failure never serves. The fresh chain took ~40 s on local PG16, NOT TESTED on any managed provider. The API has a 900 s `start_period`. The Worker follows a healthy API and Redis.
6. **First platform admin (email only, activation link).** Once the API is healthy, run the existing `bootstrap-admin` command **once**, as a one-off container of the API service: the same image, the same owner login (rab-api's entrypoint builds the `crewflow_owner` URL from db-setup's files; it never sees `PG_ADMIN_URL`; `database.env` still supplies the optional `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID`) and the same runtime config (`runtime.env`). The command creates the admin from an email address and sends an **activation link**; it takes no password (`BOOTSTRAP_ADMIN_PASSWORD` is ignored with a warning, so never set it).
   - Inputs: `BOOTSTRAP_ADMIN_EMAIL` (required); optional `BOOTSTRAP_ADMIN_FIRST_NAME`, `BOOTSTRAP_ADMIN_LAST_NAME`, `BOOTSTRAP_ADMIN_ORG_SLUG`, `BOOTSTRAP_ADMIN_ORG_NAME`.
   - The CLI requires **per-invocation command authority**: `DB_TARGET=production` and `ALLOW_PRODUCTION_DB_COMMANDS=true`, given on this one-off run ONLY, never in any service environment or env file.
   ```bash
   export BOOTSTRAP_ADMIN_EMAIL=admin@example.com     # optional: BOOTSTRAP_ADMIN_FIRST_NAME / _LAST_NAME / _ORG_SLUG / _ORG_NAME
   $P run --rm --no-deps -e DB_TARGET=production -e ALLOW_PRODUCTION_DB_COMMANDS=true -e BOOTSTRAP_ADMIN_EMAIL \
     rab-api node packages/rab-server/dist/command/main.js bootstrap-admin
   unset BOOTSTRAP_ADMIN_EMAIL
   ```
   (Add `-e BOOTSTRAP_ADMIN_FIRST_NAME` and the others the same way when you set them.) `run` publishes no port and `--no-deps` leaves the running stack alone. The command is handed to `api-prestart.sh`, rab-api's entrypoint, which in this one-off form runs its refusals, replaces the admin URL with the derived `crewflow_owner` URL, hands `DB_TARGET` / `ALLOW_PRODUCTION_DB_COMMANDS` to this one command only, and runs nothing else (no bootstrap child, no migration, no scheduler registration, no API); a normal API start still refuses both variables, so the authority never reaches a long-running process. The env-file lint refuses `DB_TARGET`, `ALLOW_PRODUCTION_DB_COMMANDS` and every `BOOTSTRAP_ADMIN_*` in every file.

**Optional startup and watchdog knobs** (code defaults; set in `runtime.env` only to change them):

| Variable | Service | Range | Default | Effect |
|---|---|---|---|---|
| `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS` | rab-api | 0–300 | 15 | Delay before a failed start exits, so a restart loop does not hammer the database. |
| `CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS` | rab-worker | 30–900 | 120 | An event loop silent this long is a stall; the watchdog kills the process and Docker restarts it. |
| `CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS` | rab-worker | 0–3600 | **0, committed** (O3) | The Worker starts after a healthy API, so it does not wait for the schema itself. Not settable in `runtime.env`. |

**Notification delivery (owner decision 2026-11-06): committed configuration.** These values are part of the compose files
(`docker-compose.image.yml` and `docker-compose.production.yml`), on rab-api AND rab-worker, with the same value on both.
Never set them in `runtime.env` or `database.env`: the gate refuses them there, and a compose `environment:` value would
win anyway. The code defaults (`false`, 2 s) are unchanged, so development and tests behave as before.

| Variable | Production value | Code default | Why on both services |
|---|---|---|---|
| `WORKER_FAST_PUBLISH_NOTIFY` | `true` | `false` | The email (and, with push on, push) rows that `NotificationService.notify()` writes are published right after the transaction commits, never before. The dispatcher stays the safety net: a failed or skipped fast publish leaves the row PENDING for the next sweep. `notify()` runs in the API and in Worker jobs, and each process reads its own value. |
| `WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS` | `30` | `2` (bounds 1–60) | O3 C2: the API's start-up registration (`register-schedulers.js`) sets the BullMQ scheduler's `every` from the **API's** value. The Worker only consumes it (`DISABLE_CRON_JOBS_REGISTRATION=true`), and its read-only verify checks that the scheduler exists, **not its interval**. A different Worker value would therefore go unnoticed, so both carry the same value. The first API start with the new value updates the same scheduler id in place. |
| `WORKER_PUSH_DISPATCH_INTERVAL_SECONDS` | not set (2 s) | `2` | Push is off (`PUSH_ENABLED` unset = false), so the push sweep is not scheduled. |
| `WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS` | not set (2 s) | `2` | Realtime is off (`REALTIME_ENABLED` unset = false). It has no immediate path, so its sweep interval is the live-update latency. |

What changes: a notification email (offer sent, accepted and so on) no longer waits for the sweep. Rows with no fast path
(the Worker's report emails, rows written by SQL, and rows whose fast publish failed) wait up to 30 s instead of up to 2 s.
The auth and account emails (password reset, invite, welcome and so on) already publish after commit (PR #80), so the
interval does not affect them while that publish works. If it fails, they also wait up to 30 s.

**Owner rule for later (2026-11-06; NOT applied now).** When `PUSH_ENABLED` is turned on in production, push's immediate
send is this same `WORKER_FAST_PUBLISH_NOTIFY` flag, which is already `true`. Its sweep then goes to 30 s: commit
`WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: "30"` on rab-api and rab-worker in both compose files, and extend the gate
(`NOTIFICATION_DELIVERY` in `scripts/compose-owner-login.cjs` and `staging/verify-image-compose.cjs`) in the same change.
`PUSH_ENABLED=true` and a real `PUSH_PROVIDER` go in `runtime.env` (production refuses `PUSH_PROVIDER=FAKE` with push on).
**Enforced since Phase X J2:** with `PUSH_ENABLED=true` (in `runtime.env` or a compose value) both gates refuse the
deployment until `WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: "30"` is committed on rab-api AND rab-worker:
`scripts/compose-owner-login.cjs` (CI, and `--lint-env-file runtime <file>`, which renders the committed compose with that
file's switches) and `staging/verify-image-compose.cjs --environment` (the operator preflight, which reads the switch from
the env files). With `REALTIME_ENABLED=true` they require the realtime sweep interval to be identical on both services; its
value is a separate owner decision, not pinned. Neither interval may be set in an env file, and a switch that differs
between the two services is refused.

**Phase D switches (owner decision 2026-11-06): committed configuration.** Like notification delivery: in both compose
files, on rab-api AND rab-worker, with the same value on both. The gate (`PHASE_D_SWITCHES` in
`scripts/compose-owner-login.cjs`) and the verifier (`staging/verify-image-compose.cjs`) enforce every value, and
`runtime.env` / `database.env` may not re-enter them. The code defaults are unchanged (triggers off, the historical scan
intervals), so development and tests behave as before.

| Variable | Production value | Code default | Why |
|---|---|---|---|
| `WORKER_TIMER_TRIGGERS` | `on` | `off` | Delayed-job triggers make each of the four transitions happen at its due time instead of up to one scan interval later. The Worker runs the scan's own per-candidate compare-and-set (same `worker_event` key, notifications and audit). The API arms the offer triggers; the Worker consumes them and arms no-show / late clock-in, so both carry it. Evidence: the shadow run on main 85332cc6, 336 decisions, 0 wrong / early / missed. |
| `WORKER_TIMER_TRIGGER_KINDS` | `offer-expiry,manager-confirmation,no-show,late-clock-in` | unset (= every kind) | All four, decided by the owner; **no-show and late clock-in touch attendance and payroll** (THREAT-MODEL). Listed explicitly so a kind added to the code later is not switched on silently (a gate test compares the list with the code's kinds). |
| `WORKER_OFFER_EXPIRY_INTERVAL_SECONDS` | `300` | `60` (bounds 10–300) | The scan stays as a safety sweep behind the trigger. As for the email sweep, the API registers the BullMQ scheduler with ITS value and the Worker never compares intervals, so both carry the same value. |
| `WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS` | `120` | `60` (bounds 10–300) | Safety sweep for the start − 30 min withdrawal; a lost trigger costs at most 2 min of the staff member's notice. |
| `WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS` | `300` | `120` (bounds 30–600) | Safety sweep; even a lost trigger lands the late flag before the 30-minute no-show. |
| `WORKER_SHIFT_MONITOR_INTERVAL_SECONDS` | not set (300 s, unchanged) | `300` | It also sends the clock-in reminders and arms the no-show / late clock-in triggers (horizon two intervals). The gate refuses any other value in the compose files and env files. |
| `WORKER_SHIFT_SCAN_MODE` | not set (`separate`) | `separate` | The D-Q4a combined scan stays off until it is measured. The gate refuses `combined`. |

What changes: an unanswered offer expires, an unconfirmed acceptance is withdrawn at start − 30 min, and a late clock-in
or provisional no-show is flagged at its due time (shadow run: p95 lateness ≤ 0.56 s; a stalled host delays it, the
earlier soak saw up to 105 s) instead of up to one scan interval later. If a
trigger is lost (a Redis loss, a failed publish), the safety sweep catches it within the new interval: up to 5 min for
offer expiry and late clock-in, 2 min for the manager-confirmation withdrawal, 5 min for no-show (shift monitor). Rollback:
`WORKER_TIMER_TRIGGERS: "off"` on both services in both compose files (and the gate), then redeploy. With `off` the Worker
creates no trigger consumer, so leftover trigger jobs stay unconsumed in Redis; the scans never stopped and do the work. The scans then keep the committed (slower) intervals: whether to
restore the code defaults with the rollback is an owner decision.

**Pay-statement sweep (owner decision 2026-11-11, Phase X J1a): committed configuration.** Like notification delivery:
in all three compose files (`docker-compose.image.yml`, `docker-compose.production.yml`, `docker-compose.local-build.yml`),
on rab-api AND rab-worker, with the same value on both. The gate (`STATEMENT_DISPATCH` in
`scripts/compose-owner-login.cjs`) and the verifier (`staging/verify-image-compose.cjs`) enforce it, and `runtime.env` /
`database.env` may not re-enter it. The code default (5 s) is unchanged for development and tests.

| Variable | Production value | Code default | Why |
|---|---|---|---|
| `WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS` | `30` | `5` (bounds 1–300) | The statement sweep was about 57 % of idle SQL at 20 organisations (Phase X S0-J SJ-01, derived from measured counts). The API registers the BullMQ scheduler with ITS value and the Worker never compares intervals, so both carry the same value. The first API start with the new value updates the same scheduler id in place. |

What changes: a pay statement is generated 0–30 s after its pay record is approved (was 0–5 s). A statement whose claim
was lost (dead Worker, Redis outage) is re-queued by the 10-minute lease up to 25 s later than before, and a failed
statement is retried up to 25 s later. Nothing else: approval, the payroll guard, the generation fence and the consumer
are untouched. Rollback: remove the line from both services in all three compose files and from the gate, then redeploy
(the API re-registers the scheduler at 5 s).

**Migration 1786721330000 (`WorkerDueWorkClaimsToWorkerRole`) is OBSOLETE under this design** (owner decision
2026-11-06: keep it excluded). It stays in `core/gated-migrations/`, outside the migration glob, and must never be
applied: its cutover gate needs every Worker to authenticate as `crewflow_worker`, which has no members and no password
under the owner login (see `docs/phase-d-deployment-runbook.md` §4.1).

**PID 1 (DB-SETUP).** `api-prestart.sh` and `worker-start.sh` are the ENTRYPOINT of rab-api and rab-worker (no command, no compose `init`). Each runs as PID 1, builds the `crewflow_owner` URL from db-setup's target file and password file, then execs `/sbin/tini -s -- node .../main.js`: tini stays PID 1 and the Worker runs as its child, so the Worker's watchdog SIGKILL (ignored by the kernel for PID 1) still works. Compose's `init: true` is refused by the gates. PR #125: neither container's definition holds a database URL or password (`PG_DATABASE_URL: ""` and `PG_ADMIN_URL: ""`; only `db-setup` gets the real one), so neither PID 1, a `docker exec` process nor a health check can hold it.

**Failure semantics:**
- **First install:** non-zero exit; the API never becomes healthy. Docker restarts it with capped backoff. Each start re-classifies: EMPTY or BOOTSTRAP-PARTIAL bootstraps, CHAIN-PARTIAL resumes, FOREIGN refuses.
- **Upgrade (OWNER-DB-ULTIMATE Part B, like Twenty):** a failed migration never serves: the migration child exits 66 and the next start retries it. Only a failed upgrade COMMAND, with every migration applied, serves (exit 70): the API logs a loud WARNING, `/healthz` reports `upgradeFailed: true` and nothing else (the step, versions and attempt are on the platform-admin health report), and the Worker starts. Fix forward with a corrected image, or restore (3.6). `CREWFLOW_UPGRADE_FAILURE` and `CREWFLOW_UPGRADE_FAILURE_POLICY` were removed and are refused.
- **Database setup refused (bootstrap child exit 64):** `db-setup` exits 64 and logs one fixed `[owner-bootstrap]` line naming the missing right or the privileged `crewflow_owner` attribute (never a value); `up` reports that db-setup did not complete and the API is not started. Fix the role or the admin login, then `$P up -d` again. Exit 70 is unexpected (details not printed). A server that refuses pre-hashed passwords (owner decision 2026-11-19, replacing D6): db-setup always sends the SCRAM verifier first; when the server refuses it (the SQLSTATE of the role statement or of the COMMIT), db-setup logs `The server refused a pre-hashed password (SQLSTATE … at COMMIT); retrying once with a plain-text password over verified TLS.` and sends the plain-text password ONCE, only over TLS that verifies the certificate and the host name, and only when no server log would record it; otherwise it refuses (64) with the reason. A pooled `PG_ADMIN_URL` is refused by what it does (session settings refused at connect, or not session-stable); keep it and set `PG_ADMIN_DIRECT_URL` (the direct address of the same login and database), or put the direct address in `PG_ADMIN_URL`.
- **`The crewflow_owner password file is missing, so its password must be reset, but the PG_ADMIN_URL login has no ADMIN OPTION on crewflow_owner ...`** (or `... cannot change another role's password ...`; exit 64): the file was lost and the admin login cannot reset the role. Run the `GRANT ... WITH ADMIN OPTION` the message names, or put the `crewflow_owner` URL in `PG_DATABASE_URL` and remove `PG_ADMIN_URL`.
- **`PG_DATABASE_URL is the app login and must log in as crewflow_owner. It is never an admin URL: the admin URL was renamed to PG_ADMIN_URL ...`** (exit 64, db-setup; the lint and the preflight say the same before deploying): `compose.env` still has an admin URL under the old name. Rename the line to `PG_ADMIN_URL` (section 3.2, step 0b). `PG_DATABASE_ADMIN_URL ... was renamed to PG_ADMIN_URL`: the same, for the even older name.
- **`PG_ADMIN_URL and PG_DATABASE_URL are both set`** / **`PG_ADMIN_URL logs in as crewflow_owner`** (exit 64): keep exactly one: the admin URL in `PG_ADMIN_URL` (mode b) or the `crewflow_owner` URL in `PG_DATABASE_URL` (mode c).
- **`crewflow-db: REFUSED - PG_DATABASE_PASSWORD is required for the bundled database`** (the `db` container, exit 64) or **`db-setup: REFUSED - PG_DATABASE_PASSWORD is required for the bundled database`**: the bundled db runs (`CREWFLOW_BUNDLED_DB` unset or `1`) without its password. Set it in `compose.env`, or switch to your own database (`CREWFLOW_BUNDLED_DB=0` with `PG_ADMIN_URL` or `PG_DATABASE_URL`).
- **`db-setup: REFUSED - CREWFLOW_BUNDLED_DB=0 (your own database) needs PG_ADMIN_URL ... or PG_DATABASE_URL ...`** (exit 64): set one of them.
- **`The crewflow_owner password file is missing, so its password would be reset, but crewflow_owner owns objects in, or holds a grant on, another database of this PostgreSQL cluster ...`** (exit 64, admin URL or bundled `db`): another Crewflow deployment on the same PostgreSQL cluster uses `crewflow_owner`; resetting its password would break it. One Crewflow deployment per PostgreSQL cluster when using an admin URL: restore this deployment's password file, or put the `crewflow_owner` URL in `PG_DATABASE_URL` (and remove `PG_ADMIN_URL`), or use a separate cluster.
- **`db-setup: REFUSED - another db-setup is running on this setup volume; nothing was changed. ...`** (exit 70): two `db-setup` runs on one volume; the second stops on the kernel lock (`flock` on `.db-setup.flock` in the volume) before touching any file. `$P up -d` again once the first has finished. The kernel releases the lock however a run ends (even killed), so there is nothing to clean up. (A run started by hand without `db-setup.sh` that was killed can leave a `.db-setup.lock` directory; the next normal `db-setup` takes it over.)
- **`A pending crewflow_owner password file appeared while this run was starting (another db-setup at the same moment?); nothing was changed in the database. Start again.`** (exit 70): a pending file appeared between the start and the store; `$P up -d` again.
- **`crewflow_owner now uses this run's new password, but the pending password file no longer holds it ...`** (exit 70): the pending file changed during the run (it should not, with the lock); nothing was renamed. `$P up -d` again: the next start settles the pending file.
- **`A pending new crewflow_owner password from an earlier run logs in; it is now the stored password.`** / **`... does not log in; it was deleted.`** (informational, exit 0 unless something else fails): an earlier run stopped between storing a new password and finishing; this run settled it.
- **`The crewflow_owner password file exists but cannot be read.`**, **`... is not a regular file ...`**, **`... is not owned by this process or is readable by group/other ...`** or **`... does not hold a valid password ...`** (exit 64; an EMPTY file is in this group): the file was edited, replaced or its permissions changed. Delete it and start again with the admin URL (or the bundled `db`).
- **`The stored crewflow_owner password does not log in. Delete the password file and start again with the admin address in PG_ADMIN_URL. Refusing.`** (exit 64): the password file exists but does not log in (for example someone changed `crewflow_owner`'s password in the database). `db-setup` never resets it on its own. Fix: delete the password file and start again with the admin URL in `PG_ADMIN_URL` (or the bundled `db`): `db-setup` then sets a new random password (a Crewflow addition, section 2). With a `crewflow_owner` URL instead, put that role's current password in the URL.
- **`The database named in the database URL (PG_ADMIN_URL or PG_DATABASE_URL) does not exist (SQLSTATE 3D000). db-setup never creates a database: create it at your provider (the bundled db creates its own), then start again. Refusing.`** (exit 64, admin URL): the admin URL names a database that does not exist. `db-setup` never creates a database. Create it at your provider (or fix the name in the URL), then `$P up -d` again.
- **`crewflow_owner owns this database`** (exit 64, admin URL): `db-setup` never works as the admin in a database the app login owns, directly or through any role it is a member of (security review H1). This is always the case for a database that went through `transition-from-separated.sql` (owner `rab_owner`, which `crewflow_owner` is a member of). **Put the `crewflow_owner` URL in `PG_DATABASE_URL` instead of the admin URL in `PG_ADMIN_URL`** (section 5.4); `db-setup` then runs as `crewflow_owner` itself. Do **not** change the database owner to make the admin URL work: that is untested and removes the ownership-derived rights the schema roles rely on.
- **`A database-wide or crewflow_owner search_path default is set`** (exit 64, admin URL): remove the default (`ALTER DATABASE <db> RESET search_path`; `ALTER ROLE crewflow_owner RESET search_path`), then `$P up -d` again.
- **rab-api or rab-worker exits 64 at once with `PG_DATABASE_URL must never be set on the api service` (or `worker service`), or `PG_ADMIN_URL must never be set on ...`:** something (an overlay, an env file, a platform's environment UI) gave it a database URL. Remove it there: `PG_ADMIN_URL` and `PG_DATABASE_URL` belong in `compose.env`, for `db-setup` only.
- **db-setup never completed (a platform that ignores `service_completed_successfully`, or db-setup failed):** the API waits up to 120 s for the target file and the password file (`api-prestart: waiting for db-setup: the database target file is not there yet (attempt <n> of 60, 2 s apart)`; the derive step logs `the crewflow_owner password file is not there yet` when only that one is missing; the Worker logs the same with `worker-start:`), then exits 75 with a fixed message; it never falls back to an admin connection. The Worker does the same. The derive step itself is not cut off by a timer (a cold `node` start can take more than 10 s on a loaded host); a FIFO, a symlink or a directory in place of either file is refused at once (exit 64), so it cannot hang.
- **Bundled db that never became healthy on its first start** (for example a `PG_DATABASE_PASSWORD` that is missing): the data volume may hold a half-initialised cluster. If it NEVER served traffic, remove it and start again:
  ```bash
  $P down
  docker volume rm <project>_crewflow-db-data <project>_crewflow-db-ca
  ```
  Confirm the names with `docker volume ls` first. **Never** do this to a volume that has served traffic.

---

## 3. Production release (upgrade: back up, then one command)

> **Deploy the API and Worker together, from the same image tag, with `docker compose pull && docker compose up -d`.
> The API starts first and migrates; the Worker starts when the API is healthy. Never update the API alone while an
> older Worker keeps running. Take a provider snapshot/restore point before each production deploy.**

Production runs `docker-compose.image.yml` (its bundled `db`, or your own database through `PG_ADMIN_URL` or a `crewflow_owner` `PG_DATABASE_URL`). **O3 (owner decisions C1-C5, 2026-11-05,
"EXACTLY LIKE TWENTY"; G-07 accepted):** there is no release step and no `rab-migrate`. On start, the API
(`api-prestart.sh`):
1. applies every pending migration under the migration lock. Approval mode is `none` by default (C4: no token). `token`
   is an opt-in safety net (BC-11): set `CREWFLOW_MIGRATION_APPROVAL_MODE=token` in **`compose.env`**, the only place
   the gate accepts it. Then an API start that would apply to a non-fresh database needs `CREWFLOW_MIGRATION_APPROVED=<token>`
   for exactly the pending set, passed to that one start (`-e`), never written to a file;
2. registers the BullMQ job schedulers (`register-schedulers.js`);
3. then serves.

The Worker never migrates (`DISABLE_DB_MIGRATIONS=true`) and only consumes the schedulers
(`DISABLE_CRON_JOBS_REGISTRATION=true`). It starts after a healthy API and a healthy Redis, so it does not wait for the
schema itself (`CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS=0`). The compose gate (`compose-owner-login.cjs`) fails CI if any of
this drifts.

> **ACCEPTED RISK (G-07 and BC-11, owner decisions 2026-11-05).** Every start of a new image applies whatever it ships,
> without a token and without a separate review step. A wrong image digest, or a `database.env` that names the wrong
> database, migrates whatever database the URL reaches, production included, on the next `up`, and a platform redeploy
> or a mistaken `pull && up` does the same. **Recovery is a restore from the pre-upgrade backup only**
> ([`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md)). That is why the backup (3.3) is **MANDATORY, before every
> upgrade**. The declared deployment id (optional, BC-11) still refuses a database bound to another deployment.

**Security audit sink (BC-07): REQUIRED configuration.** In production, rab-api and rab-worker refuse to start without an
external security audit sink (`security-audit-sink.ts`): `core.audit_log` alone is not tamper-evident under the owner
login. Set it explicitly in `runtime.env`; it is never committed in a compose file, and the gate refuses it there.
- `CREWFLOW_AUDIT_SINK=stdout` is the only value production accepts (`none` and `file` are refused). The gate requires it.
- **`stdout` is compliant ONLY with an off-host, append-only log shipper** that collects rab-api's and rab-worker's
  stdout (for example the Docker log driver or a host agent shipping to a write-once store), or with a reviewed adapter.
  **The shipper is the operator's responsibility; the application cannot verify that it exists or that it is
  append-only.** Without it, the security events land only in the local container log (`json-file`, rotated).
- `CREWFLOW_AUDIT_SINK_FAILURE` stays unset (= `refuse`: an event that cannot be written fails closed; `log` is refused in
  production). `CREWFLOW_AUDIT_SINK_FILE` is development-only.

**3.1 Inputs.**
- The release's ONE **index digest**, set as `CREWFLOW_IMAGE_TAG=sha256:<64 hex>` in `compose.env`, from the gated release (`publish-image.yaml` → `publish-gated.sh`, tag `<full commit>`; the `release` environment needs reviewer approval). Never a tag.
- Check that the revision label equals the release SHA:
  ```bash
  docker buildx imagetools inspect <repo>@sha256:<digest>
  ```
- Keep the previous `compose.env` for rollback:
  ```bash
  cp compose.env compose.env.<old-sha>
  ```

**3.2 Preflight (read-only).**
0. **First upgrade to the DB-SETUP release (once): move `PG_DATABASE_URL` from `database.env` to `compose.env` BEFORE `pull`.** From this release on, `docker-compose.image.yml` commits `PG_DATABASE_URL: ""` on rab-api and rab-worker and `${PG_DATABASE_URL:-<bundled db>}` on `db-setup` (PR #125), and a compose `environment:` value wins over `env_file`. A `PG_DATABASE_URL` left in `database.env` is therefore IGNORED, and the stack connects to the new, EMPTY bundled `db` and fresh-installs there: your data is untouched, but the service runs on an empty database. (Since 2026-11-17 an admin URL goes to `compose.env` as `PG_ADMIN_URL`, step 0b.) Move the line to `compose.env` unchanged (an admin URL or a `crewflow_owner` URL; a `crewflow_owner` URL is used as it is, its password is never changed, section 2), add `PG_DATABASE_PASSWORD=<openssl rand -hex 32>` for the idle `db`, and remove it from `database.env`. The lint of step 1 and the `verify-image-compose.cjs --environment` preflight both REFUSE a `database.env` that still holds `PG_DATABASE_URL`; run them. If `database.env` sets `PG_EXPECTED_DATABASE_NAME` to your database's real name (anything but `crewflow`), the API and Worker already refuse the bundled db's `crewflow` database instead of running on it.
0b. **First upgrade to the PG_ADMIN_URL release (once; owner decision 2026-11-17), BEFORE `pull`.** `PG_DATABASE_URL` now ALWAYS means the app login (`crewflow_owner`); the admin URL is `PG_ADMIN_URL`. In `compose.env`:
   - `PG_DATABASE_URL` holds an **admin** URL (any login but `crewflow_owner`): rename the line to `PG_ADMIN_URL` (value unchanged). Left as it is, `db-setup` refuses it (exit 64, "renamed to PG_ADMIN_URL"; it is never run as the admin under the old name) and removes the old target file. Containers that are already running keep working (they built their URL at start), but the next start or restart of rab-api / rab-worker waits for the target file and exits 75 (`the database target file did not appear`) until the line is renamed and `$P up -d` lets `db-setup` complete. A `PG_DATABASE_ADMIN_URL` line: rename it to `PG_ADMIN_URL` as well.
   - `PG_DATABASE_URL` holds a `crewflow_owner` URL: nothing to change.
   - Your own database (`CREWFLOW_BUNDLED_DB=0`): **remove `PG_DATABASE_PASSWORD`** (it is no longer required there, and the lint refuses the leftover). The bundled db (`CREWFLOW_BUNDLED_DB` unset or `1`): keep it.
   The lint of step 1 and the `--environment` preflight name every one of these.
1. Put the new digest in `compose.env`. Lint the env files, then run `$P config -q`.
2. `$P pull`.
3. **See the pending set without applying it.** Run the API's own read-only check from the NEW image, as a one-off. It replaces `api-prestart.sh`, so nothing migrates and nothing serves:
   ```bash
   $P run --rm --no-deps rab-api node packages/rab-server/dist/database/typeorm/scripts/check-pending-migrations.js
   ```
   - Exit 0: nothing pending.
   - Exit 1: the log lists each pending migration.
   - A refusal means STOP.
4. **Expand-only review of the pending list.** An expand-only lint **NEEDS OWNER APPROVAL**; until then this is a manual review.

   The release is rollback-safe only if every pending migration only **adds** (tables, nullable or defaulted columns, indexes, functions, policies) and drops, renames, retypes or narrows nothing the previous image uses. Otherwise rollback is a restore (3.6b). Get the owner's go-ahead.

**3.2a Supported upgrade window (Phase X U-1).** The API's migrate step upgrades an existing database only when its ledger
is at or past a supported release: R254 (rab/v0.4.0, cd7c7e32, 4c38aa1a) or R256 (0e0a6edd, main). A partial upgrade (a
failed or interrupted earlier start) resumes. Anything older or unrecognised is refused with exit 65
(`UnsupportedUpgradeStartError`, "Upgrades are supported only from R254, R256 or later"), nothing is applied, and the API
stays down (restart loop) until you roll back the image: upgrade such a database with a release of the floor first, or,
for a separated-layout database, follow OWNER-LOGIN-RECOVERY.md (transition-from-separated.sql). There is no override.
The old manual pre-step "update the N1 list before upgrading an existing database" is GONE for owner-login deployments.
After an upgrade that applied migrations the API bumps the entity-cache epochs once (log: "entity-cache epoch bumped"); a
Redis problem there is only a WARNING.

**3.3 BACK UP FIRST: MANDATORY before every upgrade, before 3.4.** The API applies on start, so the backup must exist **before** the new image starts. The app login cannot take a logical backup (FORCE-RLS tables dump empty), so the cluster superuser or the provider takes it.
- **Managed provider:**
  - take a provider snapshot or branch, OR
  - record the PITR restore time (`SELECT now()`) and the provider's window.

  Record it in the release notes.
- **Bundled database:** as the superuser over the db container's socket (SCRAM: `PGPASSWORD` = `PG_DATABASE_PASSWORD`, from the operator's shell, never on the command line):
  ```bash
  $P exec -T -e PGPASSWORD db pg_dump -U postgres -d crewflow -Fc > /var/backups/crewflow-<release>.dump
  ```
  Use `0600` and keep a copy off the host, or snapshot the volume with the stack stopped. Test restores periodically.
- Check that the backup is non-empty and record where it is. **No backup, no upgrade.**
- **Upgrading to 0.6.0 (OWNER-DB-ULTIMATE Part B, owner decision 2026-11-14): back up the database before deploying
  0.6.0. Going back to an image older than 0.6.0 (e.g. R256) is only possible by restoring that backup.** Why: 0.6.0
  adds the upgrade logbook `core.upgrade_migration` (owner `rab_secure_owner`, five policies, ENABLE + FORCE RLS). An older
  image's semantic-posture boot gate compares the database with ITS golden and reads those objects as drift: measured with
  R256 (0e0a6edd, `database-boot-gates.ts:202` `assertSemanticPostureAtBoot`) on a 0.6.0 database, the API refuses with
  `Database boot gate "semantic-posture" refused ... Do not serve` and never becomes healthy (B2 suite, finding L7). R256
  is frozen, so no 0.6.0 change can make it serve. Path 3.6(a) does not apply across 0.6.0; use 3.6(b), restore.

**3.4 Deploy: one command, like Twenty (C5: one API, never rolling or blue-green).**

> **Deploy the API and Worker together, from the same image tag, with `docker compose pull && docker compose up -d`.
> The API starts first and migrates; the Worker starts when the API is healthy. Never update the API alone while an
> older Worker keeps running. Take a provider snapshot/restore point before each production deploy.**

```bash
docker compose pull && docker compose up -d          # = $P pull && $P up -d
```
What Compose does, in this order (proved in real containers on PostgreSQL 16 and 18, `deploy-order-tests/`):
- it stops the old Worker first (`depends_on: rab-api: restart: true`; the Worker drains its jobs within its 45 s stop
  window), then stops the old API (40 s stop window), so no old process runs against a schema that is being migrated;
- the new API starts, migrates under the lock, registers the job schedulers and becomes healthy;
- only then does the new Worker start, on the same digest.

Add `--wait --wait-timeout 1200` to the `up` to make the command itself return non-zero when a service does not become
healthy; otherwise check with 3.5. Never `up -d rab-api` (or `--no-deps rab-api`) on its own: that would update the API
alone while an older Worker keeps running.
- Failure semantics (OWNER-DB-ULTIMATE Part B): a failed migration never serves (exit 66, the restart retries it). Only a
  failed upgrade COMMAND, with every migration applied, serves (exit 70), and public `/healthz` then says
  `upgradeFailed: true` and nothing else; the step, versions and attempt are on the platform-admin health report only.
  `CREWFLOW_UPGRADE_FAILURE` / `_POLICY` were removed and are refused.
- **Never** `up --scale rab-api=2`. **Never** start a second stack against the same database. Two versions race for the migration lock, a waiter can block for up to 600 s, and old processes would see intermediate schemas (M0-F S2).

**3.5 Verify.**
- `$P ps`: rab-api and rab-worker are healthy.
- **Audit sink (BC-07):** the off-host shipper receives the new containers' stdout. Check that the release's first security events (for example a sign-in) arrive in the append-only store, and that the store refuses edits and deletes. The application cannot verify this for you: an API that starts with `CREWFLOW_AUDIT_SINK=stdout` and no shipper looks healthy.
- `/healthz` through the edge returns 200 with `upgradeFailed: false`.
- The API log shows the job schedulers registered.
- The Worker log shows `bullmq scheduler (consume only, DISABLE_CRON_JOBS_REGISTRATION=true): all <n> enabled Crewflow schedulers present`. A MISSING scheduler is an ERROR: restart the API, which registers them again.

**3.5a Uptime monitor on `/healthz` (X2.4).** Crewflow sends no alerts of its own (as in Twenty). Point the
provider's uptime monitor (or any external HTTP checker) at the API through the edge:

- URL: `https://<api host>/healthz`, method `GET`, no credentials, no token, no cookie. Never put a secret in the
  monitor's URL or headers.
- Interval 1 to 5 minutes; timeout 10 s; alert after 2 consecutive failures.
- Alert on anything but HTTP 200 (a 503, a timeout or a connection error).
  - 200 means the API answered, PostgreSQL answered a ping within 5 s, and the database's security objects have not
    changed since boot.
  - 503 means the database is unreachable, or the security posture drifted. Posture drift stays 503 until a restart
    passes the boot check again.
- Optional second rule: alert when the 200 body contains `"upgradeFailed":true`. That is a failed upgrade served
  degraded (C3, section 2). The body never names the migration; the name is in the API's start-up ERROR log.
- `/healthz` does NOT cover the Worker, Redis memory or the BullMQ schedulers. Check those in the Admin Panel → Health
  tab (API, Database, Redis, Worker and BullMQ schedulers indicators, platform admins only). A Worker that is down, or
  schedulers lost from Redis, shows there and in the Worker's own container health, not in `/healthz`.
- Do not point a monitor at `/rest/v1/admin/health/report`: it needs a platform-admin session, and every manual
  refresh writes an audit row.

**3.6 Rollback.** Restore-based rollback, the evidence, and why an old image on an upgraded database fails closed: [`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md).
- **(a) Expand-only release, back to an O3 release** (only between owner-login releases reviewed as expand-only; never back across the transition): set `CREWFLOW_IMAGE_TAG=<previous digest>` in `compose.env` (it is in `compose.env.<old-sha>`; an old copy that still says `CREWFLOW_IMAGE_DIGEST=` needs the name changed), then the same one command, `docker compose pull && docker compose up -d`. The API and the Worker go back together. The old API's migration child classifies the ledger as AHEAD, warns and starts (the C-1 fix). **This is safe ONLY for expand-only releases.**
  - **Never back across 0.6.0 this way** (to R256, R254 or any image older than 0.6.0): the older image's semantic-posture boot gate refuses the 0.6.0 upgrade logbook objects and does not serve (3.3, finding L7). Restore the pre-0.6.0 backup instead (3.6(b)). Within 0.6.0 and later the logbook tolerates a rollback (a newer version recorded: WARNING, nothing written).
  - Back to a release from before O3 (e.g. the two-image v0.4.0): use that release's own compose files ([`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md) §4.4).
  - **Back across DB-SETUP (to R256 or any release before it):** use THAT release's compose files, not this release's: its image has no `worker-start.sh` and no bootstrap child, so it cannot start under these files (measured: the Worker fails with `exec: "./worker-start.sh": no such file`). An earlier release reads `PG_DATABASE_URL` as the runtime login, so put back a `crewflow_owner` URL (and, going back across the PG_ADMIN_URL release, move a `PG_ADMIN_URL` back to that release's `PG_DATABASE_URL` and restore a `PG_DATABASE_PASSWORD`: its compose files require it). With a `crewflow_owner` URL in `compose.env`, that is the same URL (`db-setup` never changed its password). With an admin URL or the bundled `db`, print that URL with the command below (it reads the password file), or set a new password with `01-crewflow-owner.sql`. On the bundled db, keep the `db` service and its volumes (an earlier release's files do not define them): run the earlier files with your own database URL pointing at it, or export the data first.
  - **Print the `crewflow_owner` URL (SENSITIVE output: the full URL with its password).** Run it on the host with the CURRENT release image (`<IMAGE>` = `adhin007/adolphus@sha256:<the digest in CREWFLOW_IMAGE_TAG>`, already pulled; only the current image ships this step), before you switch the compose files. The volume is `rab-production_crewflow-db-target` by default (both compose files set `name: rab-production`), or `<name>_crewflow-db-target` if you start compose with `-p <name>`. **Check that it exists first**: a typo in `-v` silently creates a new, EMPTY volume (the command then exits 75). Not yet run live.
    ```sh
    docker volume inspect rab-production_crewflow-db-target > /dev/null   # must succeed
    docker run --rm --pull never --log-driver none --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
      -v rab-production_crewflow-db-target:/run/crewflow/db-target:ro \
      -e CREWFLOW_DB_TARGET_FILE=/run/crewflow/db-target/target.json \
      --entrypoint sh <IMAGE> \
      -c 'CREWFLOW_RUNTIME_URL_FD=4 node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2' 2>/dev/null
    ```
    `--pull never` uses only the image already on the host (never a registry lookup by surprise); `--cap-drop ALL` and `--security-opt no-new-privileges` give it no capability. Do not add `-t`: the step writes the URL only to a pipe its caller opened (`CREWFLOW_RUNTIME_URL_FD=4`; `docker run` without `-t` gives it one), never to a terminal.
    It prints one line on stdout, the URL, built the same way the API and the Worker build it (target.json plus the password file, both read-only). It never connects and needs no `APP_SECRET`, no `PG_ADMIN_URL` / `PG_DATABASE_URL` and no network. `--log-driver none` keeps it out of Docker's container logs (your terminal still shows it); `2>/dev/null` drops the fixed status line. Exit 75: db-setup has not written the files yet, run `$P up -d db-setup` first. For the bundled db the host is `db`, reachable only on the compose network, where the old image runs. Never in CI, a recorded terminal, or on a host whose shell history or terminal is logged.
- **(b) Contracting release, or a failed apply you will not fix forward:**
  1. `$P stop rab-worker rab-api` (both together; the restore needs no application session).
  2. Restore the 3.3 backup or PITR point. Every write since that point is lost.
  3. Run the old digest as in (a).

  Never run an old image's migrations against a newer schema. Never `down -v` production.
- **(c) A partial apply.** Migrations commit one by one. A failed migration never serves (OWNER-DB-ULTIMATE Part B: exit 66, the API restarts and retries it; the logbook records `<version>_TypeOrmMigrations` failed with its attempt). A failed upgrade COMMAND, with every migration applied, serves with `upgradeFailed: true` and is retried on the next start. Either fix forward with a corrected image (its migration child resumes CHAIN-PARTIAL), after review, or do (b).

**3.7 One API (C5).** Rolling and blue-green deploys are not supported, and the gate refuses more than one rab-api replica or a start-first update:
- two versions race for the migration lock, and a waiter can block for up to 600 s;
- old replicas see intermediate schemas;
- DDL lock queues become user-visible stalls (M0-F S2).

---

## 4. Provider-admin SQL (OPTIONAL fallback since DB-SETUP)

**Not part of a normal install:** with `PG_ADMIN_URL` (or the bundled `db`), `db-setup` creates `crewflow_owner`
on every `up` (section 2). Use `01-crewflow-owner.sql` only when you choose to create the login by hand, then put the
resulting `crewflow_owner` URL in `PG_DATABASE_URL` and leave `PG_ADMIN_URL` unset (mode c): `db-setup` checks it and uses it unchanged (it never writes to the
database or changes the password; section 2). `transition-from-separated.sql` is still the transition path
(section 5).

Two scripts, both **owned and tested by Agent 1**. Run them **as the provider admin**, **in SQL**, over the **direct**
(non-pooler) host. **Never** create the login through a console, CLI or API user-creation feature: those logins carry
provider-superuser memberships (F-E3). Follow each file's header for how it receives the password, and for its own
verification queries.

| Situation | Script |
|---|---|
| Fresh, empty database, and you do not give Crewflow an admin URL | `packages/rab-docker/postgres-init/owner-login/own-database-app-login.sql`: section 4a. |
| Fresh, empty database (older fallback: the password comes from a file and is sent in the statement) | `packages/rab-docker/postgres-init/owner-login/01-crewflow-owner.sql`: creates `crewflow_owner` with the M0 §5.1 shape (`LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT`) and grants `CONNECT, CREATE, TEMPORARY … WITH GRANT OPTION` on the database. Optional fallback (the bootstrap child does the same). |
| Existing separated database | `packages/rab-docker/postgres-init/owner-login/transition-from-separated.sql`: section 5. |

**Provider extras** (M0 §5.1 and §8; EXPECTED unless marked):

| Provider | Extra admin steps | Status |
|---|---|---|
| Self-hosted 16 | None. Never make `crewflow_owner` (or a role it inherits) the database owner: `db-setup` refuses that database with the admin URL (security review H1). | VERIFIED (M0; H1 refusal tested live on 16 and 18) |
| Self-hosted 17 | None beyond 16's. | VERIFIED (DB-SETUP area 3: fresh install, lifecycle, transition, ci-db, twenty catalogue) |
| Self-hosted 18 | None beyond 16's. | VERIFIED (Agent 1, PG18 fresh install, lifecycle and transition) |
| Neon | The console-created `crewflow_app` (BYPASSRLS, REPLICATION, `neon_superuser`) must first be deleted in the Neon console, which **NEEDS OWNER APPROVAL**. Use PG16 for new projects until D4. Direct host, never `-pooler`. **Never touch the temporary deployment's Neon project without approval.** | EXPECTED |
| DigitalOcean | The admin may pre-create the extensions. Never the pool port 25061. Never `doadmin` as the app login. | EXPECTED |
| AWS RDS | Keep `rds.restrict_password_commands=0`. Never RDS Proxy, never the master user. | EXPECTED |
| Supabase | The extensions must not already exist outside `public`. Never expose `core` / `workspace_*` through the Data API. Never `:6543`. | EXPECTED |
| Cloud SQL | The admin must pre-create `btree_gist`, `citext`, `pg_trgm`, `pgcrypto` and `unaccent` `WITH SCHEMA public`. SQL, not `gcloud`. | EXPECTED |
| Azure Flexible | `azure.extensions=BTREE_GIST,CITEXT,PG_TRGM,PGCRYPTO,UNACCENT`; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. Never `:6432`. | EXPECTED |
| PostgreSQL ≤ 15 | Refused (CREATEROLE could grant `pg_execute_server_program`). | UNSUPPORTED |

**Hardening after the install:** `ALTER ROLE crewflow_owner NOCREATEROLE;` (M0). Optional with an admin URL; REQUIRED for section 4a (step 6).
- **Flagged assumption:** a later release whose migrations create roles would need CREATEROLE again. Check pending lists for `CREATE ROLE` before each release.

**Fresh install from an empty database is VERIFIED on self-hosted PostgreSQL 16, 17 and 18** (Agent 1; end to end on PG16 by Agent 2). It is EXPECTED on the managed providers above, and NOT TESTED on any of them.

---

## 4a. Your own database, app login created by you

Use this when you run Crewflow on your own PostgreSQL and do **not** want to give Crewflow an admin URL. A database admin
creates the app login `crewflow_owner` by hand, once. Crewflow then only ever receives the `crewflow_owner` URL. Twenty
has the same option: an external database, no admin login, no setup step.

**SQL file:** [`packages/rab-docker/postgres-init/owner-login/own-database-app-login.sql`](../../postgres-init/owner-login/own-database-app-login.sql).
Every statement in it is annotated with the privilege it needs, why Crewflow needs it, and whether it works without
CREATEROLE. Read it before you run it.

### What the script creates, and what it does not

It creates exactly what `db-setup` creates when you give it an admin URL
(`OWNER_BOOTSTRAP_Q4C_DO` in `scripts/owner-login/owner-bootstrap-sql.ts`):

- `CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT` and a SCRAM
  password;
- `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE <this database> TO crewflow_owner WITH GRANT OPTION`.

Nothing else. `db-setup` does not create the rest, and neither does this script. These are created by `crewflow_owner`
itself on the first API start (migrate-on-start, `scripts/migrate/owner-login/bootstrap.ts`):

- the schema roles `rab_owner`, `rab_app`, `rab_secure_owner`, `crewflow`, `crewflow_app` and `crewflow_worker`, with
  their memberships;
- the `core` schema;
- the five extensions;
- the default privileges.

**Do not create the schema roles yourself.** On PostgreSQL 16+ the role that creates a role becomes its ADMIN member.
The posture check allows no member of an owner role except `crewflow_owner`, and a non-superuser admin cannot remove
that row. The first start then refuses with `rab_owner: unexpected member <admin>` (exit 67; proven below).

### Prerequisites

- **PostgreSQL:** one of the supported versions in section 2 (Prerequisites). The script itself refuses anything below
  16, like the app.
- **An empty database**, and no Crewflow roles anywhere on the cluster. Roles are cluster-wide: one Crewflow deployment
  per PostgreSQL cluster. The script refuses if any Crewflow role already exists.
- **An admin login that can create roles.** It must be a superuser, or a NOSUPERUSER role with **CREATEROLE** that holds
  CONNECT, CREATE and TEMPORARY on the database WITH GRANT OPTION. That is normally the database owner: `neondb_owner`,
  the RDS master user, `doadmin`, `avnadmin`, or `postgres` on Supabase / Cloud SQL / Azure.
  - Use SQL in psql. Never use a console, CLI or API "create user" feature: those can add provider-superuser memberships
    (F-E3).
  - Never make `crewflow_owner` the database owner.
  - The provider extras in the section 4 table still apply (extensions, ports, `rds.restrict_password_commands`).
- **A direct (non-pooler) host.** Never a transaction pooler: Neon `-pooler`, Supabase `:6543`, DigitalOcean `:25061`,
  RDS Proxy, PgBouncer `:6432`.
- **TLS:** `sslmode=verify-full` on both the admin connection and `PG_DATABASE_URL`.
  - For the admin's psql, add `sslrootcert=system` (libpq 16+) when the provider's certificate chains to a public CA:
    libpq then verifies against the operating system's trust store instead of `~/.postgresql/root.crt`. Otherwise
    point `sslrootcert=` at the provider's CA file.
  - `PG_DATABASE_URL` takes `sslmode` only: the app's URL policy refuses every other `ssl*` parameter. If the
    provider's CA is not in the system store, set `CREWFLOW_PG_CA_FILE` in `compose.env` and
    `PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt` in `database.env` (section 2).
- **`password_encryption = scram-sha-256`.** This is the default on 14+. The script refuses otherwise; then run psql
  with `PGOPTIONS='-c password_encryption=scram-sha-256'`.

### Steps

Follow them in this order. Steps 3 and 6 are **required**, not optional: do not set the variables or deploy before step 3
passes, and do not leave `crewflow_owner` with CREATEROLE after step 6 (owner decision 2026-11-17, like Twenty, whose app
user never has CREATEROLE).

1. Generate the password and keep it in your secret store:

   ```bash
   openssl rand -hex 32
   ```

   Any 1-1024 characters without control characters works. 64 hex characters need no URL encoding.

2. As the admin, connected to the empty target database, run the file:

   ```bash
   psql "postgresql://<admin>@<direct-host>:5432/<database>?sslmode=verify-full&sslrootcert=system" \
     -X -v ON_ERROR_STOP=1 -f packages/rab-docker/postgres-init/owner-login/own-database-app-login.sql
   ```

   **Never paste it into an interactive session.** Run it as a file, as above.

   The script works in this order:
   - It sets its own psql safety settings (`ON_ERROR_STOP` on, `ON_ERROR_ROLLBACK` off, `AUTOCOMMIT` on), so a
     `~/.psqlrc` cannot weaken them.
   - Everything that changes the database runs in ONE transaction: the read-only checks, `CREATE ROLE`, the GRANT, the
     password and a final re-check. A refused check or a missing privilege rolls everything back, and nothing is left.
     Mismatched passwords also roll everything back when the script is run as a file, as above.
   - psql's `\password` asks for the password twice. psql turns it into a SCRAM-SHA-256 verifier on your machine and
     sends only the verifier, never the password.
   - Without a terminal, psql reads the two password lines from standard input.

   **The verifier and the logs.** The verifier (not the password) can appear in server logs (`log_statement` ddl/all,
   or any failed ALTER), `pg_stat_statements` and audit logs. With verify-full TLS it is only an offline-guessing
   target, which a 32-byte random password defeats. A superuser admin's session turns its own statement logging off
   first (db-setup's Q1); a non-superuser admin cannot, so check your provider's log and audit retention.

3. **REQUIRED: the login test.** It must pass before you go on. Run it from where Crewflow will run:

   ```bash
   psql "postgresql://crewflow_owner@<direct-host>:5432/<database>?sslmode=verify-full&sslrootcert=system" \
     -X -c 'SELECT session_user'
   ```

   It must print `crewflow_owner`. **This step is what catches an empty password from a non-superuser admin.** psql
   accepts an empty entry at `\password`, and the server then clears the password. A superuser admin is refused by the
   script's own re-check, but a non-superuser admin cannot see whether a password is set, so the script commits a
   `crewflow_owner` without one. Such a role cannot log in with a password, so this test fails.

   **If the login test fails, drop the role and run the file again.** The same admin drops it with:

   ```sql
   REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE <database> FROM crewflow_owner CASCADE;
   DROP ROLE crewflow_owner;
   ```

   db-setup refuses a passwordless role too (exit 64). Such a role is only reachable through a `trust`, `peer` or
   `cert` rule in the provider's `pg_hba.conf`.

4. Only after step 3 passes, set these in `compose.env`:

   | Setting | Value |
   |---|---|
   | `CREWFLOW_BUNDLED_DB` | `0`. The bundled `db` never starts. |
   | `PG_DATABASE_URL` | `postgresql://crewflow_owner:<password>@<direct-host>:5432/<database>?sslmode=verify-full`, the **crewflow_owner** URL, never the admin URL. |
   | `PG_ADMIN_URL` | **Not set.** Crewflow never sees an admin credential. |
   | `PG_DATABASE_PASSWORD` | **Not set** (mode c of section 2: with `CREWFLOW_BUNDLED_DB=0` the lint refuses a leftover one). |

   This is mode (c) of section 2. `PG_DATABASE_URL` is always the app login: db-setup refuses any other login there
   ("renamed to PG_ADMIN_URL"), and refuses `PG_ADMIN_URL` and `PG_DATABASE_URL` set together.

5. Deploy: `docker compose up -d`. What happens:
   - `db-setup` sees a `crewflow_owner` URL and runs only read-only checks (D5, DB-SETUP-PLAN §7.1). It refuses
     SUPERUSER, BYPASSRLS, REPLICATION, CREATEDB, NOLOGIN, NOINHERIT, an expired login, a privileged membership, a
     missing database grant, and a PostgreSQL major outside 16-18.
   - `db-setup` copies the URL's password into its password file: `/run/crewflow/db-target/owner-password`, mode 0400,
     on the `crewflow-db-target` volume. Protect that volume and its backups.
   - `db-setup` never writes to the database and never changes the password.
   - rab-api then migrates as `crewflow_owner`. On this first start it creates the schema roles and the whole schema,
     which is the only time it needs CREATEROLE.

6. **REQUIRED: remove CREATEROLE after the first start has completed.** "Completed" means one of these:
   - the rab-api log shows the migrate result (`TWENTY_MIGRATE_RESULT`) with `"serve":true`;
   - a restart reports state `CURRENT`.

   `/healthz` 200 alone is a loose signal: do not rely on it. Then, as the same admin:

   ```sql
   ALTER ROLE crewflow_owner NOCREATEROLE;
   ```

   - The creating admin has the ADMIN option this needs.
   - No restart is needed. On its next start `db-setup` logs `crewflow_owner is NOCREATEROLE (hardened)`.
   - Afterwards a leaked `crewflow_owner` URL can no longer create roles or reset the schema roles' passwords. It still
     holds the ADMIN option on the schema roles it created, so it can still GRANT those roles to roles that already
     exist. The posture check refuses any such extra member at the next boot, but it does not prevent the grant.
   - Restarts, new workspaces and upgrades (new migrations and workspace upgrade commands) run without CREATEROLE.
     This was proven on PG16; see Status.
   - **Flagged assumption:** a later release whose migrations create or alter roles would need CREATEROLE again. Its
     release notes must say so. The migration child then refuses with exit 67 and names it. The admin grants it for
     that one upgrade and removes it again afterwards.

**Password rotation.** rab-api and rab-worker read the password file only when they start, and `up -d` alone does not
restart them. `$P` is the production compose shorthand defined at the top of this runbook.

1. As the admin, in psql: `\password crewflow_owner`.
2. Put the new password in `PG_DATABASE_URL` in `compose.env`.
3. `$P stop rab-worker rab-api` (both together, the same stop as rollback (b) in section 3).
4. `$P up -d`. `db-setup` runs again, copies the new password into the password file, and rab-api and rab-worker start
   with it.

Rotation is not remediation (G-04, section 1): a new password removes no role, membership or definer that someone with
the old one may have added. After a suspected leak, follow the incident runbook, not only these steps.

### CREATEROLE: who needs it, and when

| Who | Needs CREATEROLE? | What uses it |
|---|---|---|
| The admin running the script | **Yes**, always. | `CREATE ROLE crewflow_owner ... CREATEROLE` (giving CREATEROLE needs CREATEROLE), `\password`, and step 6's `ALTER ROLE ... NOCREATEROLE`. Only the database GRANT works without it. |
| `crewflow_owner`, first start (fresh install) | **Yes**, until step 6. | migrate-on-start's bootstrap creates the six schema roles (`crewflow_worker` through a throwaway `crewflow_rolemaker`, so that it has zero members). The four role migrations (up to 1786691000000) set their passwords. BC-17 then makes `crewflow` / `crewflow_app` NOLOGIN without a password (`legacy-logins.ts`). Without CREATEROLE the child refuses with exit 67 and creates nothing (`owner-login-identity.ts`). |
| `crewflow_owner` after step 6: restarts, upgrades (new migrations, workspace upgrade commands), workspace provisioning, API, Worker, CLI | **No**, and it must not have it. | No migration after 1786691000000 and no runtime path creates, alters or grants a role. The upgrade runner refuses a workspace step that writes the role catalogs (`workspace-step-checks-sql.ts`, layer 4b). The API provisions a new workspace through `core.provision_workspace`, a SECURITY DEFINER function owned by `crewflow`. The Worker provisions with `SET ROLE crewflow`. The posture check, the boot gates and `db-setup` all accept NOCREATEROLE. |
| `crewflow_owner` after step 6, residual | No. | It keeps the ADMIN option on the schema roles it created, so it can still GRANT them to existing roles. The posture check refuses that at the next boot. |
| `crewflow_owner`, a future release with role migrations | Only for that upgrade (flagged assumption, step 6). | `needCreateRole` in `locked-migration-runner.ts` (any pending migration up to `LAST_ROLE_MIGRATION_TIMESTAMP` = 1786691000000). None exists in the current chain after the first install. |

**A provider that does not allow CREATEROLE at all** (no role there can create roles) **is not supported.** The script
refuses at its first check, and nothing is changed. There is no supported fallback:

- CREATEROLE is needed only for the first start, and step 6 then removes it.
- Creating the schema roles by hand fails the posture check, as shown above.

Use the bundled `db`, or a provider that allows CREATEROLE.

### Status

**VERIFIED (2026-11-17)** on a disposable PostgreSQL 16.16 (InstaBox, `postgres:16-alpine`, `log_statement=all`), code at
`origin/main` 9618afc0. The admin was a NOSUPERUSER CREATEROLE CREATEDB login that owned the database (the managed-provider
shape). Results:

- The script ran to the end. The result was `crewflow_owner` LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB
  CREATEROLE INHERIT, with no expiry, a SCRAM password, and CONNECT/CREATE/TEMPORARY WITH GRANT OPTION. Its only member
  was the admin, as an ADMIN-only creator row, which is the row the `db-setup` admin path leaves too.
- The `db-setup` child in owner-URL mode passed: exit 0, `pass-through`. It stored the password file, wrote a
  credential-free `target.json`, and wrote nothing to the database.
- The migrate child as `crewflow_owner` passed: exit 0, state EMPTY, 264 migrations applied, `serve=true`.
- The posture checks passed:
  - `owner-login-posture.ts` rules 1-4 found no problems;
  - `runDatabaseBootGates('api')` and `('worker')` reported `gates=ok`;
  - the security posture equals the committed PG16 golden (0 missing, 0 unexpected).
- The second start passed: `db-setup` exit 0, migrate state CURRENT.
- **Required step 6 (NOCREATEROLE), proven on 2026-11-17** (InstaBox ibox2, code at 1bcab071; same image and PG16.16).
  The first start ran with CREATEROLE: the bootstrap and every R256 migration (256). Then the admin ran
  `ALTER ROLE crewflow_owner NOCREATEROLE`, and everything below ran without CREATEROLE:
  - (a) Restart: `db-setup` owner-URL mode exit 0, with its `NOCREATEROLE (hardened)` line. Migrate exit 0. The boot
    gates for the API and the Worker reported `gates=ok`. `owner-login-posture.ts` found no problems, and the PG16
    golden matched (0 missing, 0 unexpected).
  - (c) An upgrade that applies new TypeORM migrations: the restart applied the 8 migrations after R256, exit 0,
    `serve=true`. They include `UpgradeMigrationLedger`, `WorkspaceStaffMemberSelect` (re-creates
    `core.provision_workspace`), `WorkspaceCoreForeignKeyRemoval`, `HwsCutoverCopyFunctions` (the C3 cutover functions)
    and the metadata tables. A second restart was CURRENT.
  - (b) New workspaces and (c) the workspace upgrade runner: the app's own integration specs ran against that database
    as `crewflow_owner` without CREATEROLE. **112 tests passed, 0 failed.** The 4 skipped are the crewflow_app-only
    negative controls, skipped on the owner login by design, as in CI.
    - `server-path-provisioning-api`: 12. This is the real `POST /rest/v1/manager-workspaces` on two Nest replicas;
      `core.provision_workspace`, a SECURITY DEFINER owned by `crewflow`, builds the schema; READY once.
    - `server-path-provisioning-db`: 23. The server-path workspace is compared object by object with the TypeScript
      provisioner's: tables, policies and grants.
    - `workspace-provisioning-owner-flow`: 7.
    - The Worker's `workspace-provisioning` (6) and `workspace-provisioning-owner-login` (12): `SET ROLE crewflow`
      provisioning, as the Worker runs it.
    - `workspace-command-runner`: 36. The 0.6.0 workspace commands and structural probes over workspaces left at an
      earlier level.
    - `workspace-command-runner-start`: 4. The workspace pass through the real locked start.
    - `upgrade-migration-ledger`: 12.
  - Afterwards `crewflow_owner` was still NOCREATEROLE. The specs had added 38 workspace schemas, and the cluster still
    had 9 roles. The specs' own fixture roles are created and dropped by the cluster superuser, never by
    `crewflow_owner`.
  - The first run of the R256 install exits 68 by design of the test seam, not by CREATEROLE: the head code's post-check
    calls R256's `core.provision_workspace` behind. The upgrade run then brings it to head.
- The server log never contained the password.
- The verifier and the logs:
  - with a non-superuser admin, the `log_statement=all` log held 1 verifier line;
  - with a superuser admin, Q1 left 0 verifier lines;
  - `pg_stat_statements` stores the full `ALTER USER crewflow_owner PASSWORD 'SCRAM-SHA-256$...'` text (not
    normalised). This was tested with the non-superuser admin; Q1 does not change what pg_stat_statements records.
- The refusals behaved as designed:
  - an admin without CREATEROLE was refused by the script, and nothing was created;
  - a NOCREATEROLE `crewflow_owner` on a fresh install made migrate exit 67, with nothing created;
  - a schema role created by the admin made migrate exit 67 with `rab_owner: unexpected member`, and the admin's
    `REVOKE` of its own creator row was a no-op.
- A refused check never commits. With `rab_owner` already present, none of these left a `crewflow_owner`:
  - the file fed on stdin instead of `-f`;
  - a psqlrc with `ON_ERROR_ROLLBACK on` and `ON_ERROR_STOP off`;
  - the script with its `\set` lines removed (a partial paste).
- The password step:
  - mismatched passwords stopped psql and rolled everything back;
  - two empty lines from a superuser admin were refused at the re-check and rolled back;
  - two empty lines from a non-superuser admin committed a passwordless role. Its login failed (28P01), db-setup
    refused it (exit 64), and the remedy above (`REVOKE ... CASCADE; DROP ROLE`) removed it.

The harness was a scratch script, not committed; the latest run had 34 checks and 0 failures, plus the 112 spec tests above. **NOT TESTED:**
PostgreSQL 17 and 18, and every managed provider.

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

> **MANDATORY PRECONDITION (MIX-1): one separated Crewflow deployment per cluster.** Run the transition only on a cluster that hosts no other separated Crewflow deployment. The legacy logins are cluster-wide roles, and disabling them breaks every database on that cluster that still uses them (staging, QA or another stack on the same server).
>
> **Check first**, as the provider admin, read-only. `<db>` is the database you are about to transition:
> ```sql
> -- 1. Every database on the cluster.
> SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;
> -- 2. Live sessions of the legacy logins on ANY other database (must return no rows).
> SELECT datname, usename, count(*) FROM pg_stat_activity
>  WHERE usename IN ('crewflow','crewflow_app','crewflow_worker','crewflow_migrator') AND datname <> '<db>'
>  GROUP BY 1, 2;
> ```
> Then, for **every other** database from query 1, confirm that it is not a Crewflow database (each check must print `f`):
> ```bash
> for d in <other databases from query 1>; do
>   printf '%s: ' "$d"; psql "<admin URL of database $d>" -X -At -c "SELECT to_regclass('core.migrations') IS NOT NULL"
> done
> ```
> **If any other database is a Crewflow database, or any legacy-login session appears: STOP.** Move that deployment to its own cluster, or transition it too, before you run the transition here. Query 2 only sees processes connected at this moment, which is why the per-database check is required as well.

**5.3 Provider-admin SQL.** The admin runs `postgres-init/owner-login/transition-from-separated.sql` (Agent 1). Per M0 §3.1, it:
- creates `crewflow_owner`;
- grants its memberships of the existing **schema** roles;
- **never** makes it a member of `crewflow_app` or `crewflow_worker`.

The file's own verification queries must pass before anything else happens. **After the transition the legacy logins are disabled (BC-17, Agent 1):** `crewflow` and `crewflow_app` become **NOLOGIN with PASSWORD NULL**; `crewflow_worker` stays LOGIN (two existing migrations assert it) but gets **PASSWORD NULL**, so it has no password to authenticate with; `crewflow_migrator` (if your deployment has it) becomes NOLOGIN with PASSWORD NULL at the transition (Agent 1, f91f1038): it keeps its role memberships but cannot log in, and a fresh owner-login install never creates it. A fresh owner-login install ends in the same state. The old stack can no longer connect. Only a restore of the pre-upgrade backup into a **fresh** cluster, with the `pg_dumpall --roles-only` file, brings back LOGIN and the old password verifiers ([`OWNER-LOGIN-RECOVERY.md`](OWNER-LOGIN-RECOVERY.md) §4.1).

**5.4 Host configuration (new files beside the old ones):**
- `compose.env`: `PG_DATABASE_URL` = the **`crewflow_owner` URL** — **not** an admin URL, and no `PG_ADMIN_URL`. The transitioned database is owned by `rab_owner`, which `crewflow_owner` is a member of, so `db-setup` refuses the admin URL there (exit 64, `crewflow_owner owns this database`; security review H1). With the `crewflow_owner` URL, `db-setup` checks it (read-only) and stores its password for the API and the Worker; the database and the password are not changed. Plus `PG_DATABASE_PASSWORD` for the idle bundled `db`. **Never in `database.env`:** the image compose's committed `${PG_DATABASE_URL:-}` on db-setup would silently override it.
- `database.env`: `PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt` (with `CREWFLOW_PG_CA_FILE` in `compose.env`) when the CA is not in the system store, and `PG_EXPECTED_DATABASE_NAME`. If the separated deployment declared `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID`, keep the **same** values (they are optional, BC-11). For the token safety net during the transition, set `CREWFLOW_MIGRATION_APPROVAL_MODE=token` in `compose.env` (3, step 1).
- `runtime.env`: the **current** `APP_SECRET`, keyrings, S3, email and OAuth values, **unchanged**. Changing APP_SECRET breaks every session and every stored encrypted secret.
- `compose.env`: the owner-login release digest (`CREWFLOW_IMAGE_TAG=sha256:<64 hex>`).
- **Keep** the old separated files (`.env.migrate`, the per-service env files or platform entries) untouched, `0600`, until the rollback window closes.
- Lint all three new files.

**5.5 Stop the old stack, Worker first.** The Worker drains its 30 s jobs; then the API. Keep its containers and images (`stop`, not `down`).

**5.6 Preflight:** 3.2 (the read-only pending check from the new image) → 3.3 (already done in 5.2). The classifier must report the separated ledger as an upgrade (CURRENT or behind), **never FOREIGN**. A FOREIGN or identity refusal means stop and roll back (5.9a).

**5.7 Start (the API migrates on start, O3):** `$P up -d --wait --wait-timeout 1200`. A failed transition migration leaves the API serving with `upgradeFailed: true` (C3): treat it as 5.9b unless the owner approves a fix-forward.

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
- **(b) 5.3 ran (the legacy logins are NOLOGIN, BC-17), or anything was applied in 5.7 (the supported rollback, PROVEN):**
  1. Stop everything.
  2. Restore 5.2 (`OWNER-LOGIN-RECOVERY.md` §4).
  3. Then do (a).

  An old image on the upgraded database is **not** supported in production and fails closed. The old api and worker refuse at their boot gate (unknown `provision_workspace` version), and the old provisioner refuses because the ledger is AHEAD (`OWNER-LOGIN-RECOVERY.md` §3). The transition's migrations are not "expand-only" for the old code.
- **`crewflow_owner` after a rollback:** the admin may `ALTER ROLE crewflow_owner NOLOGIN` (reversible). **Do not `DROP ROLE`** without Agent 1's guidance: objects it created would need `REASSIGN OWNED`.

**5.10 After the rollback window.** The transition already makes the old logins NOLOGIN (BC-17). Dropping their passwords and deleting `.env.migrate`, the per-service files and the separated compose paths belong to the **separated-mode retirement** (X5.1 removed the committed templates; the operator deletes their own files after the rollback window). That needs:
- the replacement passing every mandatory test;
- this procedure independently reviewed;
- owner approval.

The golden security posture expects some of those roles to stay LOGIN, so retiring them is a posture change (security agent). Until then, keep the old credentials in the secret store, **out of every owner-login file**.

**Recovery quick reference:**

| Failure | Action |
|---|---|
| 5.3 fails | Nothing app-side changed. Follow the script's recovery notes, then restart the old stack. |
| 5.6 shows an unexpected pending set | Stop. Review it, or roll back (5.9a). |
| 5.7 fails part-way (`upgradeFailed: true`) | Fix forward on a NEW image after review (3.6c), or restore: 5.9b. |
| 5.7/5.8 fail | 5.9b (restore, then the previous image). The old image on the upgraded database fails closed in production. |

---

## 6. Production risk of migrate-on-start (explicit statement)

**O3 (owner decisions C1-C5, 2026-11-05, "EXACTLY LIKE TWENTY"): the API migrates on start in production. G-07 is
ACCEPTED by the owner.** The risks below are what the owner accepted; the controls that remain are listed after them.

1. **Unreviewed production schema changes (G-07, accepted).** Any start of a new image applies whatever it ships: an auto-deploy, a mistaken `pull && up`, a platform redeploy. Mitigations: deploy by digest only (3.1), the read-only pending check (3.2), the expand-only review, and the MANDATORY backup before every upgrade (3.3).
2. **Rollback becomes an outage or data loss (C-1).** A contracting migration applied by the new image cannot be undone by starting the old one. Even expand-only rollback relies on the classifier tolerating AHEAD (NOT TESTED). Recovery is restore only.
3. **Two-version starts block and serve intermediate schemas.** Hence C5: one API, stop-then-start (3.4, 3.7), enforced by the gate.
4. **Crash-loop amplification.** A failing first install retries on every restart, against production (bounded by `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS`). A failing upgrade does not loop under C3: the API serves degraded and reports `upgradeFailed: true`.
5. **Authority in the long-running process (ST-3).** Under the owner login the API already holds schema authority (PT-01); migrate-on-start adds the **act** of changing the schema to every API start.

> **SECURITY TRADE-OFF (ST-3 as amended by BC-11 and O3 C1-C5, owner decisions 2026-11-05).** Approval mode is `none` by default (C4), so a start needs no token; `token` stays an opt-in of `compose.env` (BC-11). The deployment id stays optional. The API migrates on every start. What protects an upgrade:
> - the migration lock;
> - the identity and refusal gates;
> - the posture and semantic goldens;
> - RLS;
> - one API deployed stop-then-start;
> - the MANDATORY pre-upgrade backup.
>
> A mistaken upgrade is recovered by restore only. A failed migration never serves (exit 66; the next start retries it). Only a failed upgrade command, with every migration applied, serves degraded (exit 70), and the Worker then runs on that schema. `/healthz` shows only `upgradeFailed: true|false`, never the migration's name. The gate fails CI if the production compose stops migrating on start, pins the approval mode to a literal instead of `${CREWFLOW_MIGRATION_APPROVAL_MODE:-none}`, renders anything but `none` or `token`, brings back a `rab-migrate`, or allows more than one API.

**OpenShip is unsupported for the owner-login deployment (M0 D11).** OpenShip drops these keys: `user`, `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit`, `env_file` and the `depends_on` conditions. Since O1 the image's default user is the non-root `node`, but the other dropped keys still make it unsupported, and without `depends_on` conditions the Worker could start before the API has migrated.
- **`docker-compose.production.yml` is OpenShip's file, and a push to `main` may redeploy it.** Since DB-SETUP it adds the bundled `db`, which needs `PG_DATABASE_PASSWORD` while it runs (since 2026-11-17 checked at start, not by the render: an OpenShip deploy without it renders, and then `db` and `db-setup` refuse); its pinned release digest must be a DB-SETUP image (with `worker-start.sh`) before anything deploys from it.
- **NEEDS OWNER APPROVAL:** disable OpenShip auto-deploy, or accept the outage, before that PR merges.

Use plain Docker Compose (`OWNER-LOGIN-ORACLE-VM-PLAN.md`).

## 7. Operations

- **Logs:** `json-file`, 10 MB × 5 per container. Ship them off the host, because forensics depend on them.
- **Redis:** AOF `everysec`, `noeviction`, an ACL; never published.
- **Owner password (DB-SETUP, the Twenty Helm model):** the `crewflow_owner` password is a random value that `db-setup` stores in `/run/crewflow/db-target/owner-password` (the `crewflow-db-target` volume) and reuses on every start. `APP_SECRET` is not part of it: changing `APP_SECRET` never touches the database. **To change the password on purpose** (admin URL or bundled `db` only; the Crewflow addition A4; not yet run live):
  ```sh
  $P stop rab-worker rab-api
  docker volume inspect rab-production_crewflow-db-target > /dev/null   # must succeed (a typo creates an empty volume)
  docker run --rm --pull never --network none --log-driver none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 1000:1000 \
    -v rab-production_crewflow-db-target:/v <IMAGE> rm -f /v/owner-password /v/owner-password.next
  $P up -d
  ```
  **Restoring a password file from a backup** (instead of a reset): it must be `owner-password` in the volume's root, owned by `1000:1000`, mode `0400`, a regular file (no symlink), the password alone with no trailing newline; anything else is refused (exit 64). Write it with the same env-free `docker run ... --user 1000:1000 -v rab-production_crewflow-db-target:/v <IMAGE> ...` form, never from the host as root.
  The `docker run` line receives no environment at all (no `PG_DATABASE_URL`, no env file): it runs `rm` (under the image's tini) as 1000:1000, the owner of the volume's directory, so it can remove the 0400 files; `<IMAGE>` is the current release image (as above), `--pull never` uses the copy already on the host. It also removes a pending `owner-password.next` left by a failed run (if that pending password logs in, the next start would otherwise keep it instead of setting a new one). `up -d` runs db-setup first: it finds no password file, stores a new random one and resets `crewflow_owner`'s password; rab-api and rab-worker then start and read it. **Stop the apps first:** a running rab-api / rab-worker builds its URL once, at start. After the reset its open sessions keep working, but every NEW connection fails with 28P01, and they do NOT recover on their own (the Worker's 28P01 wait covers only its first login). If you did not stop them: `$P up -d --force-recreate rab-api rab-worker` after `up -d`. **With a `crewflow_owner` URL this does not apply** (db-setup never changes that password and rewrites the file from the URL on every start): change the password at your provider, put the new `crewflow_owner` URL in `PG_DATABASE_URL`, then `$P stop rab-worker rab-api` and `$P up -d`. A Worker that starts before `db-setup` has stored the password gets SQLSTATE 28P01 on its first login: it logs `crewflow_owner login refused (db-setup may still be storing the crewflow_owner password); retrying` (fixed text, no URL or password) and retries with backoff for up to 120 s in total; after that it exits non-zero with `[worker-db] refused: crewflow_owner login still refused (SQLSTATE 28P01) after 120 s; the stored crewflow_owner password does not log in. Run docker compose up again (db-setup checks it and names the fix), then restart the Worker.` and the restart policy starts it again. Any other first-login error refuses at once, and every boot gate still runs after a successful login. After a suspected compromise, changing the password is **not** remediation: inventory roles, memberships, ADMIN rows, definers, policies and triggers first (M0 §6.4 item 9).
- **Worker runtime-isolation self-check:** the separated root launcher's H6 report/enforce is ported into `rab-worker` itself (Agent 2). At start it logs `[worker-isolation] runtime isolation as declared: uid=1000 CapBnd=0000000000000000 NoNewPrivs=1 root=read-only pids.max=… memory.max=… mode=enforce`, and with `CREWFLOW_RUNTIME_ISOLATION=enforce` (committed in `docker-compose.image.yml`) it **refuses to start** when any of these is missing: uid 1000, an empty capability bounding set, no-new-privileges, a read-only root, a PID limit, a memory limit.
- **Resources:**
  - API: 1 GB (raised from 768 MB for the migration child; the API migrates on start, O3; NOT MEASURED).
  - Worker: 1.5 GB, with the native PDF budget rule from #61 (`PDF_NATIVE_MEMORY_BUDGET_MB`).
  - Redis: 640 MB.


### Operations commands (containment, session backfill, HWS backfill) under the owner login

The three operations commands run like `bootstrap-admin`: as a **one-off container of the API service**, from the same
image, under the same owner login (`database.env`) and the same runtime configuration. This is the Twenty way: one image,
one login. Nothing new is deployed. There is no separate operations container any more (PR 2 #124 removed it from
every compose file). Of its old variables, the five retired names are refused in every process, and the compose lint
refuses the whole `CREWFLOW_OPS_*` / `PG_OPS_*` prefix.

| Command | What it does | Modes |
|---|---|---|
| `containment:suspend-test-accounts` | Incident containment: deactivates the frozen set of fixture accounts. | dry-run (default), `--execute` |
| `user-session:backfill` | Creates `core.user_session` rows for refresh-token families created before sessions existed. Run it before `USER_SESSION_ENFORCEMENT_CUTOVER`. | `--verify`, `--dry-run` (default), `--apply` |
| `hws:backfill` | Copies legacy workspace rows into each workspace's own schema. Run it only as an approved step of the HWS cutover (gate G4). | `--dry-run` (default), `--verify`, `--apply` / `--resume` (with `--hws-cutover` while HWS is off) |

**Required on every run.**
- **The operator label** (every run is refused without `--operator` and `--change-ref`):
  - `--operator "<name>"` (required): the person's or job's name. Spaces are allowed. 1-200 characters: a letter or
    digit first, then only letters, digits, spaces and `. _ : @ / + = ' , ( ) -` (no control or format character);
  - `--change-ref` (required): the approved ticket, PR or change reference. A letter or digit first, then letters,
    digits and `. _ : # / + -`, at most 120 characters;
  - `--operator-source` (optional): one of `github-actions`, `gitlab-ci` or `manual-console`. Default `manual-console`.

  The label is an **operational claim, not a verified identity**. It is printed on the run's first console line and
  stored verbatim in every audit row the run writes (`metadata.operationalLabel`, with `path: owner-login` and a random
  `runId`). Accountability for who ran the command comes from the platform's own controls: protected environments,
  required reviewers and manual approval jobs.
- **Per-invocation command authority**, on this one-off run only: `DB_TARGET=production` and
  `ALLOW_PRODUCTION_DB_COMMANDS=true`. Never put them in a service environment or an env file; the env-file lint refuses
  them.
- **The owner login only.** The command refuses any other database login, before it connects and again on the database.
  It reads the login with the same parser as the connection, so `?user=…` and `options=-c role=…` are refused. In every
  environment it also refuses:
  - `DATABASE_URL*` and `DB_POOL_MAX`;
  - the libpq `PG*` variables (`PGOPTIONS`, `PGUSER`, …);
  - `PG_DATABASE_REPLICA_URL`;
  - the old `CREWFLOW_OPS_*` and `PG_OPS_*` variables.

  `run` uses the service's own `database.env`. If that file sets `PG_DATABASE_REPLICA_URL`, blank it on the one-off with
  `-e PG_DATABASE_REPLICA_URL=` (an empty value counts as unset).
- **A host directory, REQUIRED** for `--target`, `--log` and `--report-file`. rab-api runs with `read_only: true` and has
  no tmpfs writable by its uid 1000 (`docker-compose.image.yml` mounts a 0555, root-owned `/tmp`, not writable by the
  API's uid 1000, only as the OpenShip import guard), so a path inside the container cannot be written.
  - Mount one host directory read-write, for example `-v "$PWD/ops-run:/ops"`, and give every path under `/ops`.
  - Without the mount, containment's JSON-lines log fails AFTER the suspensions have committed. The suspensions stay
    done, but the run's outcome log (the evidence) is lost.
  - Check the directory is writable by uid 1000 before you start.
  - Containment logs hold IDs and outcomes only.
- **A kept copy of stdout, REQUIRED.** `--rm` removes the container, and with the json-file logging driver its log goes
  with it, including the `[ops] command=… path=owner-login run=… actor_source=… operator="…" change_ref=…` line that is the
  only record of a read-only run.
  - Pipe every run through `tee` into a file in the same kept directory, e.g. `2>&1 | tee -a ops-run/<change-ref>.log`.
  - Keep that file with the change record.

**Examples** (`$P` is the compose command from step 5; the `-e` flags are the only extra environment; `api-prestart.sh`, the entrypoint, runs the command as `crewflow_owner` and hands the two authority variables to it only):

```bash
mkdir -p ops-run && chown 1000:1000 ops-run    # the API image runs as uid 1000
# Session backfill: verify first. When missing = 0, nothing else is needed.
$P run --rm --no-deps -e DB_TARGET=production -e ALLOW_PRODUCTION_DB_COMMANDS=true -v "$PWD/ops-run:/ops" \
  rab-api node packages/rab-server/dist/command/main.js user-session:backfill --verify \
  --operator "deploy@ops-host" --change-ref OPS-123 \
  2>&1 | tee -a ops-run/OPS-123.log
# ...then a dry run, then --apply (each run takes the same label flags, the mount and the tee).

# Containment: a dry run first. Add --execute only after the dry run matches the frozen totals.
$P run --rm --no-deps -e DB_TARGET=production -e ALLOW_PRODUCTION_DB_COMMANDS=true -v "$PWD/ops-run:/ops" \
  rab-api node packages/rab-server/dist/command/main.js containment:suspend-test-accounts \
  --target /ops/targets.tsv --expect-orgs 389 --expect-users 698 --expect-active 645 \
  --actor-user-id <active platform admin uuid> --log /ops/containment.jsonl \
  --operator "deploy@ops-host" --change-ref INC-2026-10-05 \
  2>&1 | tee -a ops-run/INC-2026-10-05.log
```

With `tee`, the shell's exit status is tee's. Use `set -o pipefail`, or check `${PIPESTATUS[0]}`, to see the command's
own exit code.

**What runs where (minimum role per step).** One login, `crewflow_owner`. Cross-tenant reads and the session-row inserts
use the same login, narrowed by `SET LOCAL ROLE rab_secure_owner` inside a verified transaction on its own connection:
- the login and its facts are checked before and after narrowing;
- the deployment identity must equal the main session's;
- the transaction is READ ONLY for every read step;
- only the statements on the frozen list in `command/ops/ops-statements.ts` can run.

Writes that belong to a tenant use the normal tenant-context path, where FORCE RLS binds them:
- suspensions, audit rows and HWS copies;
- `user-session:backfill --verify` and every `hws:backfill` mode, which never narrow.

**What gets audited.** Writing modes only, as before:
- `user.suspended`, one per suspension, also carrying `actorClaim`;
- `ops.user_session_backfill_applied`, one per organisation;
- `ops.hws_backfill_applied`, one per workspace.

Each of these rows carries the label and `databaseVerified.appLogin = crewflow_owner`, plus `elevatedLogin` and
`elevatedRole` where the run narrowed. Read-only modes write no audit row; their record is the console line and the
deployment platform's job log.

**Exit codes.** Every refusal prints `[ops] refused: …`, `[pg-config] refused: …` or `[db-target] refused: …` (names
only, never a value) and exits 1. A failed command body also exits 1.

## 8. Interface assumptions and test status

| Assumption | Owner |
|---|---|
| `CREWFLOW_MIGRATE_ON_START`, `CREWFLOW_MIGRATION_APPROVAL_MODE`, `DISABLE_DB_MIGRATIONS` (C1) are read with these names (`runtime-db-config.ts`); `CREWFLOW_UPGRADE_FAILURE` and `CREWFLOW_UPGRADE_FAILURE_POLICY` (C3) were removed and are refused. There is no `CREWFLOW_DB_MODE`. The production compose commits `CREWFLOW_MIGRATE_ON_START=true` and `CREWFLOW_MIGRATION_APPROVAL_MODE=${CREWFLOW_MIGRATION_APPROVAL_MODE:-none}` on rab-api (compose.env opt-in: `token`). `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID` are optional: matched when declared, a warning when absent. | Agents 1 and 2 |
| `./api-prestart.sh` (rab-api's entrypoint, PID 1 until it execs tini) refuses a non-empty `PG_DATABASE_URL` or `PG_ADMIN_URL` (exit 64), builds the `crewflow_owner` URL from db-setup's target file and password file, waiting (bounded) for both (PR #125; it never runs the bootstrap child), then the migration child when `CREWFLOW_MIGRATE_ON_START=true` (and `DISABLE_DB_MIGRATIONS` is not true), then registers the job schedulers unless `DISABLE_CRON_JOBS_REGISTRATION=true` (C2), then `/sbin/tini -s -- node .../main.js`; with arguments it runs a one-off command as `crewflow_owner` instead (no bootstrap, migration or registration); the retired `CREWFLOW_UPGRADE_INCOMPLETE` is refused (exit 64), and a failed upgrade command (exit 70) is relayed only after it is verified. | Agent 2 |
| `check-pending-migrations.js` is the read-only pending check (exit 1 when pending), usable as a one-off `run --rm --no-deps rab-api` (3.2). `deploy-prepare.js` still exists but no committed compose file runs it (O3). | Agent 1 |
| The Worker with `DISABLE_CRON_JOBS_REGISTRATION=true` consumes the schedulers only and reports a missing one as an ERROR; with `WORKER_SCHEDULER` unset, production runs `bullmq` (`interval` is refused in production). | Agent 2 |
| `node packages/rab-worker/dist/main.js` runs standalone as uid 1000 with in-process provisioning and writes `CREWFLOW_INSTANCE_HEALTH_FILE`; in the deploy files it is started by `worker-start.sh` (derive + swap) under tini. | Agent 2 |
| `01-crewflow-owner.sql` reads the password file named by `-v owner_password_file=…` (default `/run/secrets/crewflow-owner-password`, at least 24 characters) inside psql, suppresses statement logging only for a superuser session, and grants on `:"DBNAME"`. (Agent 1, `twa/db-lifecycle`.) | Agent 1 |
| `bootstrap-admin` is email-only with an activation link, runs as a one-off `run --rm` of `rab-api` on the owner login after the API is healthy, with per-invocation `DB_TARGET=production` + `ALLOW_PRODUCTION_DB_COMMANDS=true` on that run only (section 2, step 6). (Agent 1, confirmed.) | Agent 1 |
| The Worker refuses to run as PID 1 (watchdog SIGKILL); `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS`, `CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS`, `CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS` with the ranges above. | Agent 2 |

**Tested (Docker side, Agent 4):**
- the gate: full mode on all 3 combinations (O3), and its self-tests;
- `docker compose config` of every supported combination;
- (historical, before DB-SETUP) a disposable PG16.15 run of the now retired `docker-compose.local-db.yml` with **Agent 1's `01-crewflow-owner.sql` (`twa/db-lifecycle` b5a03348)** as its one init file, 21/21 checks:
  - the exact `crewflow_owner` attributes and the database grant `WITH GRANT OPTION`; no other role or membership created;
  - SCRAM storage; TLS on; verify-full accepted;
  - refused: a non-TLS login, the superuser over the network, another database, a wrong host name, a wrong password;
  - no route out of the internal network; no password in the server log;
  - read-only root, `CapBnd` 0, `NoNewPrivs` 1;
  - a second start does not re-run the init; a short password refuses the init and the container never becomes healthy.

**Tested elsewhere:** see the status table at the top: fresh install, lifecycle and transition on PG16/PG17/PG18 (Agent 1, DB-SETUP area 3); end to end on PG16 (Agent 2); rollback R1/R2 (Agent 1).

**Tested (DB-SETUP, 2026-11-12, disposable Debian postgres 16.15 / 17.11 / 18.6):** the bundled stack from both compose
files with only `PG_DATABASE_PASSWORD` + `APP_SECRET` for the database (crewflow_owner created with the exact attributes
and the grant, 256 migrations, every app session `crewflow_owner` over verify-full TLS, rab-api and rab-worker healthy);
restart and recreate unchanged (same role, same stored verifier, no new certificate); every RUNNING process of rab-api and
rab-worker, PID 1 included, held no admin URL, admin password or `PG_DATABASE_PASSWORD` (before PR #125 option A a
`docker exec` process or a health check still got the admin URL from the container definition: that is what option A
removes, see below); the bundled db refuses a
password-less login over its socket and loopback; container logs hold no admin password, `APP_SECRET` or derived password;
and area 6's owner tests S1-S10C (`deploy-order-tests/run-db-setup-tests.cjs`). With a non-superuser external admin and
`log_statement=all`, the server log holds the SCRAM verifier of the bootstrap's role statement (never a password; THREAT-MODEL
TM-DB-3).

**PR #125 option A (2026-11-13), measured so far:** the compose shape (the one-shot `db-setup`, the read-only target
volume, rab-api waiting for it) on disposable Debian postgres 16.15 with a PROTOTYPE of the server side: S1 (fresh install,
db-setup exits 0, rab-api runs no bootstrap child, the target file holds no login, password or `APP_SECRET`) and S6 (every
process of rab-api and rab-worker, a `docker exec` process, the health-check processes caught while running, and both
container definitions: no admin credential). The shell entrypoints against the agreed interface: the prestart shell tests
(stubbed derive and bootstrap). **NOT yet measured:** the full owner test list (S1-S10C) on PostgreSQL 16 and S1/S6/S5 on
18 with the final server side (area 2: the bootstrap child writing the target file, `derive-runtime-url.js` reading
`CREWFLOW_DB_TARGET_FILE`); OpenShip's handling of `service_completed_successfully` (the API waits, fail closed).

**PR #125, the Twenty Helm model (owner-approved 2026-11-13; code d43696f8): NOT yet measured on a full live stack.** The
code change (a random `crewflow_owner` password in `/run/crewflow/db-target/owner-password`, no `APP_SECRET` in any
database credential, a `crewflow_owner` URL used unchanged) came with updated gates, the image gate, prestart shell tests,
unit specs and the live harness scenarios of OWNER-DB-FINAL A6. Still to run: S1-S10C on PostgreSQL 16, 17 and 18. The
option-A and option-2 measurements above used the earlier, APP_SECRET-derived password.

**NOT TESTED:**
- a real production boot;
- managed-provider PITR, snapshot restore and fresh install;
- OpenShip;
- the Oracle VM plan.
