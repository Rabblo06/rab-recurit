# Crewflow environment reference (production)

Status: 2026-11-19. Applies to `docker-compose.production.yml` (OpenShip and plain Compose) and
`docker-compose.image.yml` (plain Compose with `compose.env`, `database.env` and `runtime.env`).

Like Twenty's `packages/twenty-docker/docker-compose.yml`, each service in the compose files lists only:

- the variables it requires;
- `CREWFLOW_IMAGE_TAG` and `CREWFLOW_IMAGE_REPOSITORY`;
- the database and Redis settings it needs;
- the values fixed by owner decisions ("pinned").

Every other setting is **optional**, and this page lists them. Unset means the code default. The former
`${KEY:-<value>}` lines in `docker-compose.production.yml` each repeated that default.
`packages/rab-server/src/engine/core-modules/environment/production-compose-defaults.spec.ts` proves, key by key,
that leaving each one unset gives the same value as before.

## How to set an optional setting

| Where | How |
|---|---|
| OpenShip | Add the variable **scoped to the service** (rab-api and/or rab-worker, as the Services column says). Do not make it project-scoped: OpenShip gives a project-scoped variable to **every** container of the stack (its env layering: project, then the compose file's own lines, then service-scoped values; read from the OpenShip source, not verified on a running instance). That includes db-setup and db-harden, which refuse `APP_SECRET`, `PG_DATABASE_PASSWORD` and `PG_DATABASE_APP_PASSWORD` in their environment (exit 64), and the db and Redis containers. |
| `docker-compose.production.yml` with plain Compose | Add a `KEY: ${KEY}` line under the service's `environment:`, and put the value in your `.env` or shell. A value only in `.env` no longer reaches the container by itself: the bare `KEY:` lines that passed it through are gone. |
| `docker-compose.image.yml` | `runtime.env` for rab-api and rab-worker. The database settings (`PG_SSL_CA_CERT*`, `PG_EXPECTED_DATABASE_NAME`, `CREWFLOW_DEPLOYMENT_*`) go in `database.env`. The lint is `node packages/rab-docker/scripts/compose-owner-login.cjs --lint-env-file runtime <file>`. |

**Services column.**

- **both**: set the same value on rab-api and rab-worker. Both processes validate every setting at boot, so a bad value on either one refuses to start. The old file gave every optional setting to both.
- **api** or **worker**: only that process acts on the setting. If you also set it on the other one, that one still checks the value.
- **db-setup**: the one-shot db-setup service, and db-harden where noted.

**Secret column.** "yes" means a credential or key. Do not put a secret in a project-scoped OpenShip variable, a
ticket or a log.

Strict switches (X3.1): every on/off setting takes exactly `true` or `false`. Anything else refuses to boot. Empty
means unset.

## Required (listed in the compose file; for reference)

These have no usable default in production. rab-api and rab-worker refuse to boot without each one.

| Name | What it does | Services | Secret |
|---|---|---|---|
| `APP_SECRET` | Root secret, 32+ random bytes. The encryption and JWT keys derive from it. Changing it breaks every session and every stored encrypted secret. | both | yes |
| `APP_URL`, `ACCOUNTS_URL` | Public https URLs of the app and of the accounts pages. Not localhost. | both | no |
| `CORS_ORIGINS` | Comma-separated https origins allowed to call the API. | both | no |
| `TRUSTED_PROXY_CIDRS` | The exact address(es) of the edge proxy that connects to rab-api (IPv4 /16 or narrower, IPv6 /48 or narrower). See [Finding TRUSTED_PROXY_CIDRS](#finding-trusted_proxy_cidrs). | both | no |
| `EMAIL_DRIVER` | `SMTP` or `RESEND` (`LOGGER` is refused in production). | both | no |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | Object storage. R2 uses `S3_REGION=auto`. | both | no |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | A key scoped to that bucket only. | both | yes |
| `CREWFLOW_AUDIT_SINK` | `stdout` only. It is compliant only with an off-host, append-only log shipper. | both | no |

Database: `PG_DATABASE_URL` (the crewflow_owner URL), or, for the bundled db, `PG_DATABASE_APP_PASSWORD`. The three
modes are at the top of `docker-compose.production.yml`.

## Optional settings

### Database connection

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `PG_SSL_CA_CERT` | Your own database's CA as PEM text (one line with `\n` escapes is fine). Listed in the compose file as `${PG_SSL_CA_CERT:-}`, because it is a database setting. | unset: the bundled db's own CA for host `db`, otherwise the system CA store | both + db-setup + db-harden | no (but shown as Set / Not set) |
| `PG_SSL_CA_CERT_PATH` | The same CA as a file inside the container. The production file mounts no external CA file, so use `PG_SSL_CA_CERT` there. Never both. | unset (the start scripts point it at the bundled CA for host `db`) | both + db-setup + db-harden (image.yml: `database.env` + `CREWFLOW_PG_CA_FILE`) | no |
| `PG_EXPECTED_DATABASE_NAME` | When set, must equal `current_database()`, otherwise the process refuses to start. | unset (no check) | both | no |
| `PG_POOL_MAX_CONNECTIONS` | Pool ceiling per process, 1-100. rab-worker's `12` is pinned in the compose files. | 10 | api | no |
| `PG_POOL_IDLE_TIMEOUT_MS` | Idle pooled connections close after this (0 = never). | 600000 | both | no |
| `PG_POOL_ALLOW_EXIT_ON_IDLE` | pg-pool `allowExitOnIdle`. | false | both | no |
| `PG_DATABASE_PRIMARY_TIMEOUT_MS` | Client-side query timeout (30000-3600000). | 30000 | both | no |
| `PG_DATABASE_URL_IS_DIRECT` | `true` declares the URL a direct (non-pooled) connection. Refused on a pooler-shaped URL. | false | both | no |
| `PG_EXPECTED_API_INSTANCES`, `PG_EXPECTED_WORKER_INSTANCES` | Declared instance counts. Once both are set, the connection budget is checked at boot against the server's limit. | unset (budget not checked; a warning) | both | no |
| `PG_EXPECTED_API_POOL_MAX` | Budget input: rab-api's pool. | 10 | both | no |
| `PG_EXPECTED_WORKER_POOL_MAX` | Budget input: rab-worker's pool. | 12 | both | no |
| `PG_EXPECTED_MIGRATE_CONNECTIONS` | Budget input: the migrate-on-start child. | 5 | both | no |
| `PG_PROVIDER_RESERVED_CONNECTIONS` | Budget input: slots a managed provider keeps for itself. | 0 | both | no |
| `CREWFLOW_DEPLOYMENT_ENVIRONMENT`, `CREWFLOW_DEPLOYMENT_ID` | Deployment identity (BC-11 opt-in): both or neither, for example `production` and the uuid the database was bound with. | unset | both (image.yml: `database.env`) | no |

### Database setup one-shots (db-setup, db-harden)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `CREWFLOW_BUNDLED_DB` | `1` runs the bundled db, `0` uses your own database. On OpenShip, also switch the `db` service off: OpenShip ignores `deploy.replicas`. | 1 | db-setup, db-harden (db: replicas) | no |
| `PG_ADMIN_URL` | Your own database's admin URL (mode b). Pinned `""` on rab-api and rab-worker. | unset | db-setup, db-harden | yes |
| `PG_ADMIN_DIRECT_URL` | The direct address of the same admin login, when `PG_ADMIN_URL` is pooled. | unset | db-setup, db-harden | yes |
| `PG_DATABASE_HOST`, `PG_DATABASE_PORT`, `PG_DATABASE_NAME` | The direct address that compose builds the crewflow_owner URL from (mode b). Interpolation only. | db, 5432, crewflow | compose (all four database services) | no |
| `PG_DATABASE_PASSWORD` | The bundled db's superuser password (mode a). Interpolation only: it must never reach db-setup by name. | unset (required while the bundled db runs) | compose (db, db-setup URL) | yes |
| `PG_DATABASE_APP_PASSWORD` | The crewflow_owner password (modes a and b). Interpolation only. | unset | compose (PG_DATABASE_URL) | yes |
| `CREWFLOW_DB_WAIT_SECONDS` | How long the one-shots wait for the database (0-900; 0 = do not wait). Listed in the compose files because the gates require the committed line. | 170 | db-setup, db-harden | no |
| `CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS` | How long db-harden waits for the migration ledger (60-7200). Listed because the gates require it. | 1200 | db-harden | no |

### Keys and sessions

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `APP_ENCRYPTION_KEYRING`, `APP_ENCRYPTION_ACTIVE_KID` | Versioned encryption keyring (JSON) and its active key id. Only if this deployment rotates keys. | unset (one implicit key from APP_SECRET) | both | keyring yes, kid no |
| `APP_JWT_SIGNING_KEYRING`, `APP_JWT_ACTIVE_KID` | JWT signing keyring and its active key id. | unset | both | keyring yes, kid no |
| `APP_AUTH_CACHE_HMAC_KEY` | HMAC key for the Redis auth caches. | unset (derived) | both | yes |
| `APP_JWT_LEGACY_VERIFY_ENABLED` | Accept the old legacy/kid-less access tokens. | true | both | no |
| `APP_KEY_SEPARATION_REQUIRED` | Refuse to boot unless separate keyrings are configured. | false | both | no |
| `AUTH_COOKIE_HOST_PREFIX_ENABLED` | `__Host-` auth cookie names. | false | api | no |
| `AUTH_COOKIE_LEGACY_MIGRATION_ENABLED` | With host-prefix cookies on, migrate legacy-named cookies instead of forcing a new sign-in. | true | api | no |
| `USER_SESSION_ENFORCEMENT_CUTOVER` | Enforce the first-class user session on every request. | false | api | no |

### Observability and labels

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `SENTRY_DSN` | Error reporting. Unset = no reporting. | unset | both | yes |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sample rate. | 0.01 in production | api | no |
| `APP_VERSION` | Release label (shown in health and the admin panel). | dev | both | no |
| `APP_GIT_COMMIT` | Commit label for the admin panel. | unset | both | no |

### Email (EMAIL_DRIVER is required)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `EMAIL_SMTP_HOST` | SMTP server. Needed with `EMAIL_DRIVER=SMTP`. | unset | both | no |
| `EMAIL_SMTP_PORT` | SMTP port. | 587 | both | no |
| `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD` | SMTP login. | unset | both | password yes |
| `EMAIL_SMTP_NO_TLS` | Turn off STARTTLS. Do not use in production. | false | both | no |
| `RESEND_API_KEY` | Needed with `EMAIL_DRIVER=RESEND`. | unset | both | yes |
| `EMAIL_FROM_ADDRESS` | Sender. **The default is a placeholder: set your verified sender.** | `rab <no-reply@example.com>` | both | no |
| `EMAIL_REPLY_TO` | Reply-to address. | unset | both | no |
| `EMAIL_DELIVERY_ENABLED` | Master switch for outgoing email. | true | both | no |

### Object storage (driver, prefix, path style and encryption are pinned)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `S3_SIGNED_URL_TTL_SECONDS` | Lifetime of signed download URLs. | 120 | api | no |
| `S3_MAX_UPLOAD_BYTES` | Largest accepted upload. | 20971520 (20 MiB) | api | no |
| `STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS` | Purge deleted images after this many days. | 30 | worker | no |
| `STORAGE_CLEANUP_MIN_SPACING_MINUTES` | Minimum gap between storage clean-up runs. | 720 | worker | no |
| `STORAGE_RECONCILE_METHOD` | How the storage reconcile command lists objects. | list | both (CLI on the rab-api image) | no |

### Sign-in providers (at least one must stay enabled)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `AUTH_PASSWORD_ENABLED` | Password sign-in. | true | api | no |
| `AUTH_GOOGLE_ENABLED` | Google sign-in. Needs the three below. | false | api | no |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GOOGLE_CALLBACK_URL` | Google OIDC client. | unset | api | secret yes |
| `AUTH_MICROSOFT_ENABLED` | Microsoft sign-in. Needs the three below. | false | api | no |
| `AUTH_MICROSOFT_CLIENT_ID`, `AUTH_MICROSOFT_CLIENT_SECRET`, `AUTH_MICROSOFT_CALLBACK_URL` | Microsoft OIDC client. | unset | api | secret yes |
| `AUTH_OAUTH_HANDOFF_ENABLED` | OAuth cross-host handoff. | false | api | no |

### Sign-in rate limits

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `AUTH_LOGIN_EMAIL_IP_BURST` / `_WINDOW_SECONDS` | Attempts per email and client IP per window. | 5 / 900 | api | no |
| `AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT` | 24 h ceiling per email and client IP. | 30 | api | no |
| `AUTH_LOGIN_ACCOUNT_BURST` / `_WINDOW_SECONDS` | Attempts per account per window. | 50 / 900 | api | no |
| `AUTH_LOGIN_KNOWN_IP_TTL_DAYS` | How long a client IP stays "known" for an account. | 30 | api | no |

### Two-factor authentication and step-up

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `AUTH_MFA_ENROLMENT_ENABLED` | Users may enrol TOTP. | true | api | no |
| `AUTH_MFA_ENFORCE_PLATFORM_ADMIN`, `_ORGANISATION_OWNER`, `_INITIAL_MANAGER`, `_OTHER_WEB_USERS` | Require a second factor for that group. | false | api | no |
| `AUTH_MFA_MOBILE_POLICY` | Second-factor policy for the phone apps. | exempt | api | no |
| `AUTH_MFA_CHALLENGE_TTL_SECONDS` / `_MAX_ATTEMPTS` | Challenge lifetime and tries. | 300 / 5 | api | no |
| `AUTH_MFA_USER_ATTEMPTS_BURST` / `_WINDOW_SECONDS` | Second-factor tries per user per window. | 10 / 900 | api | no |
| `AUTH_MFA_ISSUER` | Name shown in authenticator apps. | Crewflow | api | no |
| `AUTH_STEP_UP_WINDOW_SECONDS` | How long a re-authentication counts. | 300 | api | no |
| `AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS` | Step-up also needs the second factor for legacy actions. | false | api | no |

### Workspace domains (owner decision D6: leave unset unless approved)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `WORKSPACE_BASE_DOMAIN` | Base domain for workspace subdomains. | unset | api | no |
| `WORKSPACE_HOST_ROUTING_ENABLED` | Route by workspace host. Needs `WORKSPACE_BASE_DOMAIN`. | false | api | no |

### Caches (rollout switches)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `AUTH_CONTEXT_CACHE_ENABLED` | Redis auth-context cache. | false | api | no |
| `USER_SESSION_CACHE_ENABLED` | Redis user-session cache. | false | api | no |
| `CORE_ENTITY_CACHE_ENABLED` | Redis core-entity cache. | false | both | no |
| `WORKSPACE_METADATA_CACHE_ENABLED` | Redis workspace-metadata cache. | false | both | no |
| `METADATA_L1_CACHE_ENABLED` | In-process metadata cache. | false | both | no |
| `METADATA_L1_CACHE_TTL_MS` / `_MAX_ENTRIES` / `_MAX_BYTES` | Its limits. | 2000 / 5000 / 8388608 | both | no |

### Realtime and push (both OFF; turning either on is a separate owner decision)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `REALTIME_ENABLED` | Realtime events. The gates require the same value on both services. | false | both | no |
| `REALTIME_HEARTBEAT_INTERVAL_MS` | Realtime heartbeat. | 30000 | api | no |
| `REALTIME_MAX_CONNECTIONS_PER_USER` | Realtime connection cap. | 3 | api | no |
| `WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS` | Realtime outbox sweep. Must be the same on both. | 2 | both | no |
| `PUSH_ENABLED` | Push notifications. Turning it on also needs `WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: "30"`, which is already pinned on both services. | false | both | no |
| `PUSH_PROVIDER` | `FAKE` (refused with push on in production) or the real provider. | FAKE | both | no |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | FCM credentials. | unset | both | yes |
| `APNS_AUTH_KEY_P8` | APNs key. | unset | both | yes |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | APNs identifiers. | unset | both | no |
| `APNS_ENVIRONMENT` | `sandbox` or `production`. | sandbox | both | no |
| `PUSH_DELIVERY_MAX_ATTEMPTS` | Retries per push. | 5 | both | no |

### Background scans (seconds; rab-api registers each schedule with its value, so set the same on both)

| Name | Default | Services | Secret |
|---|---|---|---|
| `WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS` | 900 | both | no |
| `WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS` | 300 | both | no |
| `WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS` | 60 | both | no |
| `WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS` | 120 | both | no |
| `WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS` | 86400 | both | no |
| `WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS` | 86400 | both | no |
| `WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS` | 300 | both | no |
| `WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS` | 300 | both | no |
| `WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS` | 1800 | both | no |
| `WORKER_SCHEDULER_RECONCILE_SECONDS` | 60 | both | no |
| `BULLMQ_PREFIX` (queue key prefix; must be identical) | `crewflow:production:bull` | both | no |

Pinned in the compose files, not optional: `WORKER_FAST_PUBLISH_NOTIFY`, `WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS`,
`WORKER_PUSH_DISPATCH_INTERVAL_SECONDS`, `WORKER_TIMER_TRIGGERS`, `WORKER_TIMER_TRIGGER_KINDS`,
`WORKER_OFFER_EXPIRY_INTERVAL_SECONDS`, `WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS`,
`WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS` and `WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS`. Leave unset (owner
decision 2026-11-06): `WORKER_SHIFT_MONITOR_INTERVAL_SECONDS` and `WORKER_SHIFT_SCAN_MODE`.

### Retention and clean-up

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `OUTBOX_RETENTION_ENABLED` | Outbox retention job. | false | both | no |
| `OUTBOX_RETENTION_MODE` | `report` (count only) or delete. | report | worker | no |
| `OUTBOX_RETENTION_EMAIL_DAYS` / `_PUSH_DAYS` / `_REALTIME_DAYS` / `_WORKER_EVENT_DAYS` | Age per outbox. | 90 / 30 / 7 / 30 | worker | no |
| `OUTBOX_RETENTION_BATCH_SIZE` / `_MAX_BATCHES_PER_SCOPE` | Batch limits. | 1000 / 20 | worker | no |
| `OUTBOX_RETENTION_INTERVAL_MINUTES` | How often it runs. | 60 | both | no |
| `LOGIN_HANDOFF_CLEANUP_ENABLED` | Expired login-handoff clean-up. | true | both | no |
| `LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES` | How often it runs. | 15 | both | no |

### PDF rendering

The concurrency times 384 MB must fit the memory budget. Set them together.

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `PDF_NATIVE_CONCURRENCY` | Render threads, 1-4. | 2 | worker | no |
| `PDF_NATIVE_PREWARM` | Threads started at boot, 0-4. | min(2, concurrency) | worker | no |
| `PDF_NATIVE_MEMORY_BUDGET_MB` | Heap budget for the render threads. | 768 | worker | no |

### Attendance and invitation rules (business values; change only on an owner decision)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `CLOCK_IN_EARLY_MINUTES` | How early a clock-in is accepted. | 15 | both | no |
| `QR_POST_SHIFT_GRACE_MINUTES` | QR still valid after the shift ends. | 120 | both | no |
| `QR_MAX_AGE_DAYS` | Oldest QR accepted. | 14 | both | no |
| `REPORT_AVAILABLE_BEFORE_MINUTES` | Pre-shift report available this early. | 180 | both | no |
| `GEOFENCE_MAX_ACCURACY_M` | Worst GPS accuracy accepted. | 100 | api | no |
| `LOCATION_EVIDENCE_MAX_AGE_SECONDS` / `_MAX_FUTURE_SKEW_SECONDS` | Location freshness. | 120 / 30 | api | no |
| `LATE_CLOCK_IN_GRACE_MINUTES` | Late clock-in grace. | 10 | both | no |
| `MEMBER_INVITE_RATE_RECIPIENT_PER_DAY` / `_ACTOR_PER_HOUR` / `_ORGANISATION_PER_DAY` / `_REDEEM_PER_IP_PER_HOUR` | Invitation rate limits. | 6 / 60 / 500 / 30 | api | no |

### Per-service start-up tuning

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS` | Wait before exiting after a start-up failure (0-300). | 15 | api | no |
| `CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS` | Event loop silent this long = a stall (30-900). | 120 | worker | no |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | Drain time on shutdown (1000-34000). | 30000 | worker | no |
| `CREWFLOW_RUNTIME_ISOLATION` | `warn` logs each missing isolation control, `enforce` refuses to start. **Never `enforce` on OpenShip** (it drops the keys). Pinned `enforce` in `docker-compose.image.yml`. | warn | both | no |
| `CREWFLOW_MIGRATION_APPROVAL_MODE` | `token` makes the API's migration need `CREWFLOW_MIGRATION_APPROVED`. Listed (pinned interpolation) on rab-api. | none | api | no |
| `CREWFLOW_LOG_FIRST_PEER` | One-time diagnostic: log the first request's socket peer address. See below. | false | api | no |

### Bootstrap admin (pending)

| Name | What it does | Default | Services | Secret |
|---|---|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` | **Pending** branch `feat/bootstrap-admin-at-boot` (create the first platform admin at boot). Today the gates and the `runtime.env` lint refuse every `BOOTSTRAP_ADMIN_*` name on rab-api. That branch owns those rules and will add the compose line. Until then: the one-off `bootstrap-admin` command. | unset | api (pending) | no |

### AI (inert: `AI_ENABLED` is pinned `false`)

`ANTHROPIC_API_KEY` (secret), `AI_AGENTS_ENABLED` (false), `AI_MODELS_DEFAULT_DISABLED` / `_FAST` / `_SMART`
(unset), `AI_DAILY_BUDGET_USD` (2), `AI_USER_DAILY_BUDGET_USD` (1), `AI_ORG_DAILY_TOKEN_BUDGET` (200000),
`AI_MAX_OUTPUT_TOKENS` (1500), `AI_MAX_STEPS` (8), `AI_MAX_INPUT_CHARS` (4000), `AI_USER_RATE_PER_MIN` (10),
`AI_ORG_RATE_PER_MIN` (60), `AI_USER_TURNS_PER_DAY` (100), `AI_ORG_MAX_ACTIVE_TURNS` (2), `AI_TURN_TIMEOUT_SECONDS`
(90), `AI_TITLE_GENERATION` (true), `AI_RETENTION_DAYS` (90), `AI_RETENTION_MODE` (off),
`AI_RETENTION_INTERVAL_MINUTES` (60), `AI_STALE_TURN_SWEEP` (false), `AI_STALE_TURN_THRESHOLD_MINUTES` (15) and
`AI_STALE_TURN_SWEEP_INTERVAL_MINUTES` (5). Services: both. None does anything while AI is off.

### Compose interpolation only (never reach a container)

| Name | What it does | Default |
|---|---|---|
| `CREWFLOW_IMAGE_REPOSITORY` | Image repository. | `adhin007/adolphus` |
| `CREWFLOW_IMAGE_TAG` | Release index digest (`sha256:<64 hex>`, never a tag). | production.yml: the pinned release; image.yml: required |
| `CREWFLOW_POSTGRES_IMAGE` | Bundled db image by digest (postgres 16, 17 or 18). | postgres:16.16 index digest |
| `CREWFLOW_API_BIND`, `CREWFLOW_API_HOST_PORT` | Host address and port rab-api is published on. | 127.0.0.1, 3000 |
| `CREWFLOW_API_MEM_LIMIT` / `_CPUS`, `CREWFLOW_WORKER_MEM_LIMIT` / `_CPUS`, `CREWFLOW_POSTGRES_MEM_LIMIT` / `_CPUS` | Resource limits. | 1024m / 2, 1536m / 2, 1024m / 2 |

Never set anywhere: the "MUST NOT BE ENTERED" list at the top of `docker-compose.production.yml` and in
`env/runtime.env.example`.

## Finding TRUSTED_PROXY_CIDRS

Production refuses to boot without `TRUSTED_PROXY_CIDRS`. It must name exactly the address that connects to rab-api,
which is your platform's edge proxy. On hosted OpenShip there is no shell to look it up, so rab-api can log it once.

1. **Set the flag.** On rab-api only, as a service-scoped variable: `CREWFLOW_LOG_FIRST_PEER=true`. The value must be exactly `true`: like every switch, `1` refuses to boot. If you have no `TRUSTED_PROXY_CIDRS` value yet, set `TRUSTED_PROXY_CIDRS=127.0.0.1/32` for now. It trusts only the container's own loopback, so no forwarding header is trusted.
2. **Deploy.**
3. **Make one request** to the app's public URL from a browser or `curl`.
4. **Read the line** in rab-api's logs (logger `TrustedProxy`):
   `CREWFLOW_LOG_FIRST_PEER: first request peer address (req.socket.remoteAddress) = 10.0.3.4; as TRUSTED_PROXY_CIDRS: 10.0.3.4/32. Logged once.`
   - Only that peer address is logged: no header, no `X-Forwarded-For`, no path, no query, no body.
   - It is logged once per container start.
   - Requests from the container's own loopback (the health check) are skipped.
5. **Set `TRUSTED_PROXY_CIDRS`** on rab-api and rab-worker to that address as a /32 (an IPv6 peer as a /128), or to your provider's documented edge range (/16 or narrower).
   - If the address changes between deploys, the platform's proxy has no fixed address. Use the provider's documented range, not a guess.
   - Never use a whole private range such as `172.16.0.0/12` (refused).
6. **Remove the flag and redeploy.** The admin panel's environment view shows `CREWFLOW_LOG_FIRST_PEER` while it is on.

If the app is reached directly with no proxy in front, the logged address is a real visitor's IP. Do not put that in
`TRUSTED_PROXY_CIDRS`. With no proxy, no forwarding header should be trusted: keep the loopback value.
