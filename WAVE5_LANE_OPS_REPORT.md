# Wave 5, Lane OPS: outbox retention + replay (G6), two-layer metadata cache, secret-rotation coverage (G7 step 1)

**Date:** 2026-10-23. **Branch:** `feat/twenty-parity-foundation`. Nothing committed, pushed or deployed. **No migration
written** (lane DB5 owns them; built against `docs/evidence/w45-db5/CONTRACT.md` v1 and DB5's files `1786719900000`–
`1786719970000`). Tests ran ONLY on the private disposable `crewflow-lane-ops-db` (127.0.0.1:15464, tmpfs,
`max_locks_per_transaction=256`, disposable marker) and `crewflow-lane-ops-redis` (127.0.0.1:16394), both removed at the end.
rab-devdb, crewflow-test-db and every `rab-*` container were not touched. No real key was rotated.

Evidence: `docs/evidence/w5-ops/` (migrate logs, test logs, load JSON). THREAT-MODEL: "Wave 5 Lane OPS" (O1–O5).
HANDOFF: the 2026-10-23 lane-OPS entry.

## 1. Outbox retention + replay (G6)

### 1.1 Retention job — `packages/rab-worker/src/queues/rab-maintenance/outbox-retention.job.ts`
- Scheduled on the existing `WorkerRuntime.every` (loop "outbox retention", stat keys `lastOutboxRetentionAt` /
  `outboxRetentionFailures`, plus `lastOutboxRetentionMode` / `lastOutboxRetentionRows`).
- **Off by default.** `OUTBOX_RETENTION_ENABLED=false` → the cycle returns before any query. Enabled, it starts in
  `OUTBOX_RETENTION_MODE=report`: counts what a purge would delete (same predicate as DB5's function), deletes nothing.
  `purge` must be set explicitly.
- Deletes only via DB5's `core.purge_terminal_{email_outbox,push_delivery,realtime_event,worker_event}(interval, int)`,
  inside `TenantContextService` per organisation (+ per (organisation, workspace) for the two workspace-tagged event tables,
  via the existing `storageScopes` enumeration). `crewflow_app` has no DELETE on these tables (DB5 REVOKE; test asserts
  42501).
- Multi-replica safe: the whole cycle holds a session advisory lock (`crewflow:outbox-retention:v1`) on the existing direct
  crewflow_app connection; a second replica skips (`skipped: 'locked'`). Bounded: `BATCH_SIZE × MAX_BATCHES_PER_SCOPE` per
  (table, scope) per cycle; a backlog drains over cycles (`truncated` counter).
- `worker_due_work` has no terminal state (rows are deleted on completion) and `notification` is an inbox, not an outbox
  (DB5 §5) — neither is purged.

### 1.2 Suggested retention periods — FOR OWNER APPROVAL (G6; not decisions)

| Table | Env var | Suggested default | Floor (validator + DB, 22023) | Why the suggestion |
|---|---|---|---|---|
| `email_outbox` | `OUTBOX_RETENTION_EMAIL_DAYS` | **90 d** | 30 d | support "did my invite go out?" questions within a quarter; token bodies are already nulled at terminal state (F1) |
| `push_delivery` | `OUTBOX_RETENTION_PUSH_DAYS` | **30 d** | 30 d | delivery receipts only; no body |
| `realtime_event` | `OUTBOX_RETENTION_REALTIME_DAYS` | **7 d** | 7 d | foreground SSE fan-out; replayed by clients' refetch, payload is minimal |
| `worker_event` | `OUTBOX_RETENTION_WORKER_EVENT_DAYS` | **30 d** | 30 d | idempotency keys; the floor exceeds every known re-emit window (DB5 caution) |

Age is measured from the terminal time (`sent_at`/`accepted_at`/`processed_at`/`failed_at`/…), never `created_at`.
Rollout suggestion: enable in `report` on dev for a week, read the counts in the worker log / `lastOutboxRetentionRows`,
then switch to `purge`.

### 1.3 Replay — exactly once, audited
- **Endpoint** (existing platform-admin area, new `admin-outbox.controller.ts`; no `auth/**` file edited):
  `POST /rest/v1/admin/outbox/organisations/:organisationId/emails/:emailId/replay` (body `{ allowUncertain?: boolean }`,
  forbidNonWhitelisted → a body `organisationId` is 400), throttled 30/min.
  Results: 200 `REPLAYED`; 404 absent / other tenant / not FAILED (indistinguishable); 409 `NO_BODY` (token-bearing body
  scrubbed by F1 — the user must request a new link); 409 `DELIVERY_UNCERTAIN` unless `allowUncertain=true`.
- **CLI:** `outbox:replay <emailOutboxId> --actor-email <active platform admin> [--organisation <id>] [--allow-uncertain]`
  (same service; exit 0 only on REPLAYED; without `--organisation` it tries organisations in id order — non-matching ones
  are no-ops).
- **Flow:** platform admin re-checked in `OutboxOperationsService` (layer 2; fail closed) → DB5 `core.replay_failed_email`
  under the target org's RLS context with the admin as `current_uid()` (FAILED → RETRY once, `dispatch_generation + 1`,
  audit `email.replay_requested`) → after commit, an immediate `EmailQueueService.republish(id, org, newGeneration)` (job id
  `email-outbox.<id>.attempt.<gen>`, never used before, so BullMQ cannot dedupe it against the retained failed job). If that
  publish fails, the dispatcher's stale-RETRY recovery republishes after 5 min under gen+1. Whatever runs, the processor's
  PROCESSING compare-and-set lets exactly one job send.
- DB5 chose RETRY (contract text said PENDING). As a defensive extra, the dispatcher now publishes a PENDING row with
  `dispatch_generation > 0` under its generation instead of `attempt.0`.

### 1.4 Failed-job inspection + queue observability
- `GET /rest/v1/admin/outbox/failed?kind=email|push|realtime|worker_event&organisationId=&limit=` — ids, type, attempts,
  error CODE, timestamps, `replayable`, `dispatchGeneration`. Never body/subject/recipient/payload/error text/provider id.
- `GET /rest/v1/admin/outbox/queues` — BullMQ `getJobCounts` for `rab-email` and `rab-push`, worker heartbeat age +
  staleness, and the existing `rab:worker:stats` hash (every loop's lastRunAt/failure counters, incl. the new ones). No new
  service. (`rab-shift-statements` lives in the payroll module — engine must not import it; its loop stats are in the hash.)
### 1.5 Login-handoff cleanup (MFA-lane request) — `rab-maintenance/login-handoff-cleanup.job.ts`
- Scheduled on `WorkerRuntime.every` (loop "login handoff cleanup", stat keys `lastLoginHandoffCleanupAt` /
  `loginHandoffCleanupFailures`), every `LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES` (default 15, 1–1440).
- **ON by default** (`LOGIN_HANDOFF_CLEANUP_ENABLED=true`): the rows are ≤60 s single-use security tokens (hash only),
  not business records; keeping them only adds exposure.
- Deletes only through DB5's `core.login_handoff_cleanup(p_batch)` (definer, rows expired OR consumed more than 1 h ago,
  window fixed in the function); `crewflow_app` has no privilege on the table (42501 asserted). Session advisory lock
  `crewflow:login-handoff-cleanup:v1` on the direct connection (a second replica skips) on top of the function's own xact
  lock; ≤20 batches of 1000 per cycle. A database without the migration → no-op. Own loop, so it can never stop
  refresh/reset-token cleanup.

## 2. Two-layer metadata cache (non-authorisation only)

- `MetadataL1CacheService` (`engine/core-modules/entity-cache/`): bounded LRU (`bounded-lru-cache.ts`), TTL 1–5 s,
  entry cap + approximate byte cap, 64 KiB per-entry cap, frozen values, hit/miss/eviction/expiry/fence counters
  (`stats()`). Plugged into the EXISTING `CoreEntityCacheService.getOrFetch/currentEpoch/invalidate` as an optional
  dependency: absent or disabled = byte-for-byte the old path.
- **Kinds (closed allowlist):** `workspace_schema_resolution`, `workspace_host_label`, `workspace_host_map`,
  `permission_catalogue` (new `PermissionCatalogueCacheService`, keyed by a hash of the code flag list; used by
  `RoleService.listPermissionCatalog` — ROLE_VIEW stays live). Never sessions, auth contexts, security versions,
  permissions-per-user, membership, suspension state.
- **Invalidation:** local drop + PUBLISH on `crewflow:<env>:cache-invalidation:v1` after the Redis epoch INCR (existing
  rename / READY / FAILED / suspension call sites already call `invalidate` → they now reach the L1 too; host-map bump drops
  every label). The L1 serves only while its SUBSCRIBE is confirmed; on every (re)subscribe it clears (lost messages). Ticket
  fence = no fill-after-invalidate. Redis down = never live = previous behaviour (PostgreSQL).
- **Gate:** only active for a kind whose Redis flag is on (`CORE_ENTITY_CACHE_ENABLED` / `WORKSPACE_METADATA_CACHE_ENABLED`).

### Load test (Node keep-alive HTTP generator; autocannon/k6 not installed) — same-machine, relative numbers
3000 requests per endpoint, concurrency 20, keep-alive, after 50 warm-up requests; one run per profile; API, PostgreSQL,
Redis and the generator on one Windows laptop (`docs/evidence/w5-ops/load/{off,l2,l1}.json`). Latency in ms.

| Profile | `GET /roles/permissions` p50 / p95 / p99 | rps | `GET /auth/me` p50 / p95 / p99 | rps | metadata lookup primitive p50 / p99 / mean |
|---|---|---|---|---|---|
| off (PostgreSQL only) | 97.6 / 138.0 / 184.9 | 193 | 100.6 / 140.9 / 176.7 | 190 | 0.86 / 2.24 / 0.915 |
| l2 (Redis caches, no L1) | 106.8 / 146.6 / 170.2 | 180 | 87.3 / 114.5 / 138.1 | 222 | 1.27 / 2.97 / 1.39 |
| l1 (Redis + L1, 2 s TTL) | 98.6 / 131.4 / 157.4 | 194 | 97.4 / 132.3 / 151.6 | 198 | 0.00 / 0.01 / 0.002 |

All 18 000 requests returned 200. L1: 8 027 hits / 23 misses (99.7 %), 2 entries, about 12 KB. **Reading:** on this
machine the HTTP numbers are dominated by the authentication path and Nest/Express overhead; the differences between
profiles are within run-to-run noise, so the L1 gives **no measurable end-to-end win at this load**. What it measurably
removes is per-lookup round trips: a metadata lookup drops from about 1-1.4 ms (two Redis GETs, or one PostgreSQL query)
to about 2 microseconds. The value grows with remote (Neon / managed Redis) latency, which this rig does not have.
Recommendation: enable per environment only where those round trips are remote, after the owner accepts the <=5 s
routing-staleness trade-off; a k6 run on the deployed topology (W6) is the real gate.

**Bug caught by this load test (fixed):** the first run showed the L1 live in the "off"/"l2" profiles. Root cause: my new
strict-boolean env flags lacked `@Type(() => String)`, so `enableImplicitConversion` turned the string `'false'` into
`true` - `OUTBOX_RETENTION_ENABLED=false` would have switched retention on (report mode). Fixed for both flags;
`env.validation.wave5-ops.spec.ts` covers it and was mutation-checked (fails with the decorator removed).

## 3. Secret rotation coverage (G7 step 1)

`secret:rotate` now covers every encrypted column (`--target smtp_password,push_token,totp_secret`, default all):
batched (`--batch-size`, ≤1000), per-row compare-and-set, checkpoint file (`--checkpoint-file`, ids only, atomic write,
ignored if the active kid changed), SIGINT/SIGTERM finish the batch and save, `--max-rotations` for staged runs,
`--verify` (per target/per kid, unreadable row ids), `--verify --retire-kid <kid>` (the only retirement gate). Tamper /
unknown-kid / truncated values are `unreadable`: never rewritten, block retirement. Works with wave 2's shared keyring parser
(`APP_ENCRYPTION_KEYRING`/`APP_ENCRYPTION_ACTIVE_KID`). Legacy pre-RAB2 bytes are classified needs-rotation (DB5's CHECK now
forbids them anyway).

**TOTP:** read via DB5's `core.mfa_totp_state`, rewritten via DB5's `core.mfa_rotate_totp_secret` (contract v2, requested
by this lane). On a database without that function apply reports `skipped-unsupported` and `--verify --retire-kid` stays
NOT SAFE (fail closed). Deleted users' secrets are not visible to `mfa_totp_state` and are not rotated (unreadable after
retirement, harmless).

### Rotation runbook (per environment; never on production without G7 approval; dev only with explicit approval)
1. Generate a new kid secret (≥32 chars, `openssl rand -base64 48`), add it to `APP_ENCRYPTION_KEYRING` keeping the old kid,
   `APP_ENCRYPTION_ACTIVE_KID` unchanged. Deploy API + Worker. `secret:rotate --check-keyring` on EVERY instance must list
   the new kid.
2. Set `APP_ENCRYPTION_ACTIVE_KID=<new>`, deploy (new writes use it).
3. `secret:rotate --dry-run` → review counts. `secret:rotate --apply` (resume = run it again; checkpoint in
   `./.crewflow/secret-rotation.checkpoint.json` or `--checkpoint-file`).
4. `secret:rotate --verify` must exit 0; investigate every UNREADABLE row id first (restore from backup or clear the value —
   an SMTP password can be re-entered, a push token re-registers, a TOTP user re-enrols).
5. `secret:rotate --verify --retire-kid <old>` must print SAFE (exit 0). Only then remove the old kid from the keyring,
   deploy, and run `--verify` again. Keep the removed secret in the secret store for one backup-retention period (restored
   backups still carry old-kid ciphertext).

## 4. Environment variables (all strict-validated; in `.env.example` and worker-bundle `JOBS_ENV_KEYS`)

| Var | Default | Range |
|---|---|---|
| `METADATA_L1_CACHE_ENABLED` | false | strict boolean |
| `METADATA_L1_CACHE_TTL_MS` | 2000 | 1000–5000 |
| `METADATA_L1_CACHE_MAX_ENTRIES` | 5000 | 100–50000 |
| `METADATA_L1_CACHE_MAX_BYTES` | 8388608 | 1 MiB–64 MiB |
| `OUTBOX_RETENTION_ENABLED` | false | strict boolean |
| `OUTBOX_RETENTION_MODE` | report | report / purge |
| `OUTBOX_RETENTION_EMAIL_DAYS` | 90 (suggested) | 30–3650 |
| `OUTBOX_RETENTION_PUSH_DAYS` | 30 (suggested) | 30–3650 |
| `OUTBOX_RETENTION_REALTIME_DAYS` | 7 (suggested) | 7–3650 |
| `OUTBOX_RETENTION_WORKER_EVENT_DAYS` | 30 (suggested) | 30–3650 |
| `OUTBOX_RETENTION_BATCH_SIZE` | 1000 | 1–10000 |
| `OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE` | 20 | 1–1000 |
| `OUTBOX_RETENTION_INTERVAL_MINUTES` | 60 | 15–1440 |
| `LOGIN_HANDOFF_CLEANUP_ENABLED` | **true** | strict boolean |
| `LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES` | 15 | 1–1440 |

## 5. Tests (all observed on the private DB; logs in `docs/evidence/w5-ops/tests/`)

Fresh private DB built from migrations (phase A as `rab_owner` stops at the role split by design; phase B as the bootstrap
superuser: **207 migrations**, DB5's final files incl. contract v2 — `fresh-install/11-*.log`, `12-*.log`).

| Run | Result |
|---|---|
| rab-server, 29 suites: new (`secret-rotation-wave5` 11, `metadata-l1-revocation` 5, `admin-outbox-operations` 8, `metadata-l1-cache.service` 12, `bounded-lru-cache` 7, `env.validation.wave5-ops` 17) + adapted `secret-rotation` + regression (core-entity-cache, workspace-metadata-cache, p1e, p1f, organisation-suspension, member-role-redis-cache, workspace-host-routing, workspace-execution-context, manager-workspace-fresh-poll, settings-abuse-cases, environment / secret-encryption / workspace-host / command unit specs) | **438 / 438 passed** (`final-server.log`) |
| rab-worker, 9 suites: new `outbox-retention-replay` (12), `login-handoff-cleanup` (5) + email-delivery-reliability, email-secret-body-retention, email-pool-lifecycle, push-delivery-dispatch, realtime-event-outbox-claim, worker-operations-abuse-cases, email-send.processor.spec | **102 passed, 1 failed**: the known pre-existing "refresh token expired more than 91 days ago" case (retention is 181 d since WebSessionRetention1786717100000), already on the documented list (`final-worker.log`) |
| worker-bundle launcher `node --test` | 18 passed, 0 failed, 12 skipped (Linux-only) (`launcher.log`); test 14 confirms every new env var is in `JOBS_ENV_KEYS` |
| CLI smoke (`cli-smoke.log`) | `secret:rotate --check-keyring/--dry-run/--verify --retire-kid`, flag guards and `outbox:replay` refusals behave as specified |
| `tsc --noEmit -p rab-server/tsconfig.app.json` | clean outside the MFA lane's in-flight `auth/**` files |
| `tsc -p rab-worker` | **not run**: it type-checks against `rab-server/dist`, which I did not rebuild (shared with other lanes) — rebuild dist, then run it |

Brief coverage: retention never touches non-terminal rows (PENDING/QUEUED/PROCESSING/RETRY of any age kept, recent
terminal kept); disabled = no deletes; report mode = counts only (checked against a superuser oracle); crewflow_app DELETE
→ 42501 on all four tables; floors refused by job and DB (22023); no tenant context → 0; advisory-lock skip; replay
exactly once (two concurrent → one REPLAYED + one NOT_FOUND, one audit row; three deliveries of the same job → one send;
dispatcher backstop uses a fresh generation; HTTP 200 then 404, job id `attempt.1` only); L1 invalidation across two
instances AND a forked process; subscription loss disables and clears the L1; revocation immediacy (403 / 401 on the very
next request with every cache on at the 5 s maximum TTL); Redis down → PostgreSQL; rotation dry-run / apply / verify /
interrupted (max-rotations and abort) / resume / foreign-kid checkpoint / old-kid retention (a new-only keyring decrypts
everything) / tamper detection / TOTP without the write path fails closed / envelope CHECK 23514; login-handoff cleanup
(only expired/consumed > 1 h, bounded, disabled, lock skip, no direct privilege).

Process note: one accidental full-suite run hit the private DB (a Jest array flag swallowed the path argument); the DB was
rebuilt from scratch before the final runs above. Containers `crewflow-lane-ops-db` / `crewflow-lane-ops-redis` removed. DB5 added `MfaHandoffFollowups1786719980000` after my final rebuild (208th migration: `login_handoff_peek`, a `user_session.mfa_verified_at` guard); it changes no function this lane calls, but my runs did not include it - the integration run should.

## 6. Requests for / coordination with lane DB5
1. **Done by DB5 (contract v2):** `core.mfa_rotate_totp_secret(uuid, bytea, bytea)`, org-scoped CAS on the ciphertext only.
   `secret:rotate` uses it; the spec proves it rotates an ENABLED secret without touching enabled/step/enabled_at, and that
   a database without it keeps the retire gate closed.
2. Optional, not blocking: `core.mfa_list_totp_users(p_after uuid, p_limit int)` so rotation need not call
   `mfa_totp_state` once per user of an organisation.
3. Observed while DB5's files were in flight: an early `LoginHandoff` body used `pg_catalog.greatest(...)` (not a function,
   42883); DB5's current source uses `GREATEST`. The final fresh DB has the fixed body.
4. DB5 implemented replay as FAILED -> **RETRY** (contract v2); this lane publishes immediately after the commit so the
   5-minute RETRY staleness window does not delay a replay.

## 7. Owner decisions
1. **G6 retention periods** (§1.2) and when to switch `report` → `purge` per environment.
2. Enable `METADATA_L1_CACHE_ENABLED` per environment (after this load test; Redis caches must be on for it to matter).
3. Replay without step-up re-authentication (trade-off below) — accept or require `AUTH_STEP_UP` once MFA ships.
4. G7: rotation apply on production; when to retire `legacy` (APP_SECRET-derived) after a keyring exists everywhere.
5. Whether `DELIVERY_UNCERTAIN` replays should need a second admin.

**SECURITY TRADE-OFF (replay without step-up).** Replay is a platform-admin, audited, throttled, exactly-once action that can
only resend a non-secret body to its original recipient (token-bearing bodies are refused). I did not add password step-up
(suspension/grant have it). Stricter: require `StepUpReauthService` (lives in `auth/**`, MFA lane's area). Veto if wanted.

**SECURITY TRADE-OFF (L1 staleness for un-invalidated changes).** A registry/host change made out of band (SQL, a process
without Redis) converges within the L1 TTL (≤5 s) on top of the existing Redis epoch TTL. Authorisation is unaffected (never
cached in L1). Stricter: keep `METADATA_L1_CACHE_ENABLED=false`.

## 8. Files
New: `rab-worker/src/queues/rab-maintenance/{outbox-retention,login-handoff-cleanup}.job.ts`;
`rab-server/src/engine/core-modules/entity-cache/{bounded-lru-cache,metadata-l1-cache.service,permission-catalogue-cache.service}.ts`;
`.../platform-admin/{outbox-operations.service,admin-outbox.controller}.ts`, `.../platform-admin/dto/outbox-operations.dto.ts`;
`rab-server/src/command/outbox-replay.command.ts`. Tests: `entity-cache/{bounded-lru-cache,metadata-l1-cache.service}.spec.ts`,
`__tests__/integration/{secret-rotation-wave5,metadata-l1-revocation,admin-outbox-operations}.integration.spec.ts`,
`__tests__/load/metadata-l1-cache.load.spec.ts`, `environment/env.validation.wave5-ops.spec.ts`,
`rab-worker/src/__tests__/integration/{outbox-retention-replay,login-handoff-cleanup}.integration.spec.ts`.
Changed: `core-entity-cache.service.ts`, `entity-cache.module.ts`, `secret-rotation.service.ts`, `command/secret-rotation.command.ts`,
`command/command.module.ts`, `platform-admin/admin-panel.module.ts`, `environment-variables.ts`, `.env.example`,
`modules/identity/services/role.service.ts` (optional catalogue dependency, 6 lines), `rab-worker/src/main.ts`,
`rab-email/email-dispatch.job.ts`, `rab-maintenance/token-cleanup.job.ts`, `rab-docker/rab/worker-bundle/start-worker-bundle.cjs`,
`__tests__/integration/secret-rotation.integration.spec.ts` (RAB2 fixtures), `THREAT-MODEL.md`, `docs/HANDOFF.md` (appended).
