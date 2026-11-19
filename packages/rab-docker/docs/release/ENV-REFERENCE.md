# Database settings: which service gets what

This page covers every database-related variable of the owner-login deployment (`docker-compose.image.yml`; the
production file sets the same values per service) and which service receives it. Procedures are in
[`OWNER-LOGIN-DEPLOYMENT.md`](OWNER-LOGIN-DEPLOYMENT.md), section 2. The other application settings are in
`packages/rab-docs/developers/environment-configuration.mdx`.

Legend: **yes** = the service receives it; **built** = Compose builds a value from it for that service; **refused** =
the service refuses to start if it is set (exit 64); **—** = not given.

## Where you set it, and who receives it

| Variable | Set in | db | db-setup | db-harden | rab-api | rab-worker | What it is |
|---|---|---|---|---|---|---|---|
| `PG_DATABASE_URL` | `compose.env` (modes b, c); built from `PG_DATABASE_APP_PASSWORD` in mode a | — | yes | yes | yes | yes | The app login, always `crewflow_owner`, at the direct host. On OpenShip, enter it explicitly. |
| `PG_DATABASE_APP_PASSWORD` | `compose.env` (mode a; planned for the own-database general flow too<!-- VERIFY -->) | — | built | built | built | built | The bundled db's `crewflow_owner` password (`openssl rand -hex 32`), inside `PG_DATABASE_URL` only. Refused as a variable of its own. |
| `PG_DATABASE_PASSWORD` | `compose.env` (mode a) | yes (superuser) | built | built | refused | refused | The bundled db's superuser password. Read on the volume's first start only. |
| `PG_ADMIN_URL` | `compose.env` (mode b) | — | yes | yes | refused | refused | Your database's admin connection string, as your provider shows it. |
| `PG_ADMIN_DIRECT_URL`<!-- VERIFY --> | `compose.env`, only when `PG_ADMIN_URL` is a pooler | — | yes | yes | refused | refused | The admin login's direct (session) endpoint. |
| `PG_DATABASE_DIRECT_URL`<!-- VERIFY --> | `compose.env`, only when `PG_DATABASE_URL` is a pooler | — | yes | yes | yes | yes | The `crewflow_owner` login's direct (session) endpoint, for migrations and advisory locks. Not the legacy `DATABASE_DIRECT_URL`, which stays refused. |
| `CREWFLOW_BUNDLED_DB` | `compose.env` | replicas | yes | yes | — | — | `1` (default) = the bundled db; `0` = your own database. OpenShip ignores the replica count: switch `db` off there. |
| `CREWFLOW_BUNDLED_DB_ADMIN_URL` | built by Compose; never set it | — | built | built | — | — | The bundled superuser URL, built from `PG_DATABASE_PASSWORD`. |
| `CREWFLOW_DB_WAIT_SECONDS` | `compose.env` | — | yes | yes | — | — | How long to wait for the database to accept connections: 0-900, default 170. |
| `CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS` | `compose.env` | — | — | yes | — | — | How long `db-harden` waits for the schema before removing CREATEROLE: 60-7200, default 1200. |
| `CREWFLOW_POSTGRES_IMAGE` | `compose.env` | image | — | — | — | — | A Debian postgres 16, 17 or 18 digest. |
| `CREWFLOW_PG_CA_FILE` | `compose.env` | — | mounted | mounted | mounted | mounted | A host CA file for your own database, mounted at `/run/crewflow/pg-ca.crt`. |
| `PG_SSL_CA_CERT_PATH` / `PG_SSL_CA_CERT` | `database.env` | — | yes | yes | yes | yes | The CA as a mounted path or as PEM text; never both. Not needed for the bundled db or a public CA. |
| `PG_EXPECTED_DATABASE_NAME` | `database.env` | — | — | — | yes | yes | Must equal the database's name (`crewflow` for the bundled db). |
| `CREWFLOW_DEPLOYMENT_ENVIRONMENT` / `CREWFLOW_DEPLOYMENT_ID` | `database.env` | — | — | — | yes | yes | Optional deployment identity, matched against the database's marker. |
| `CREWFLOW_MIGRATION_APPROVAL_MODE` | `compose.env` | — | — | — | yes | — | `none` (default) or `token`. |
| `CREWFLOW_MIGRATION_APPROVED` | `-e` on one start only | — | — | — | yes | — | The approval token for the exact pending set, with mode `token`. Never in a file. |
| `CREWFLOW_MIGRATE_ON_START`, `DISABLE_DB_MIGRATIONS` | committed in the compose file | — | — | — | yes | yes | The API migrates on start; the Worker never does. |
| `PG_POOL_MAX_CONNECTIONS`, `PG_EXPECTED_*_INSTANCES`, `PG_EXPECTED_*_POOL_MAX` | `runtime.env` (the Worker's pool is committed) | — | — | — | yes | yes | Pool sizes and the connection budget check. |

`database.env` also reaches `db-setup` and `db-harden`, which use only its TLS settings; neither ever reads `runtime.env`.

## Refused everywhere (production)

- `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_DIRECT_URL` and `DB_POOL_MAX` (legacy names).
- `PG_DATABASE_ADMIN_URL` (renamed to `PG_ADMIN_URL`).
- The libpq variables (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGOPTIONS`, ...).
- `PG_SSL_ALLOW_SELF_SIGNED` (production always verifies the certificate).
- `PG_DATABASE_REPLICA_URL`, `CREWFLOW_PROVISIONER_DATABASE_URL` and any other second database URL on rab-api or
  rab-worker.

## What the URLs must look like

- **`PG_DATABASE_URL`:** login `crewflow_owner`; the database's **direct** host, or a pooler together with
  `PG_DATABASE_DIRECT_URL`<!-- VERIFY -->; a password of at least 32 characters with at least 10 different characters.
- **`sslmode` (required in production):** `require`, `verify-ca` or `verify-full`, optionally with `channel_binding`.
  Crewflow's own verification is what counts: all three verify the full certificate chain and the host name, the way node-postgres treats `require`. `disable`,
  `prefer`, `allow`, `no-verify` and a missing `sslmode` are refused. `channel_binding=require` is accepted, but the
  driver cannot insist on it; it is refused without TLS.
- **Mode (b):** `PG_ADMIN_URL` and `PG_DATABASE_URL` (or their direct endpoints) name the same host, port and
  database.
- **Passwords:** `db-setup` sends a SCRAM verifier first, and plain text over verified TLS only if the server refuses
  it<!-- VERIFY -->. Provider notes: `OWNER-LOGIN-DEPLOYMENT.md` section 2, "Known provider quirks".
