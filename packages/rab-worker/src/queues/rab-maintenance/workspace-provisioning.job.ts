import { Client } from 'pg';

import { provisionWorkspaceSchema, ProvisionOptions, WorkspaceSchemaProvisioningError } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';

// Deliberately small: each candidate drives real DDL (apply the V1 template, 89 FKs, 71 indexes, 19 policies, a
// structural verification) inside its own pair of transactions — this is NOT a cheap row scan like the other
// maintenance jobs in this directory. A handful per tick is plenty for what is, in practice, a low-volume event
// (one per Manager who creates a Workspace), and keeps one tick from monopolising the owner connection.
const BATCH_SIZE = 10;

export interface WorkspaceProvisioningResult {
  attempted: number;
  ready: number;
  failed: number;
  /** Phase A: false when another provisioner held the lock for the whole bounded wait — the tick was skipped, no work done. */
  lockAcquired: boolean;
}

// Phase A (pa-provisioner): bounded, abortable acquisition of the provisioning session lock (replaces the unbounded
// `pg_advisory_lock` wait). Same lock key as before, so old and new provisioners still exclude each other.
const PROVISIONING_LOCK_SQL_KEY = `hashtext('rab_workspace_provisioning')`;
/** Default upper bound on waiting for another provisioner's tick to finish before skipping this one. */
export const PROVISIONING_LOCK_WAIT_MS = 10_000;
const PROVISIONING_LOCK_WAIT_MAX_MS = 60_000;
const PROVISIONING_LOCK_POLL_MS = 250;

export interface ProvisioningLockOptions {
  /** Total time to keep trying (0 = one attempt). Clamped to 0..60 000 ms. Default PROVISIONING_LOCK_WAIT_MS. */
  waitMs?: number;
  /** Delay between attempts. Clamped to 25..5 000 ms. */
  pollMs?: number;
  /** Stop trying as soon as this returns true (shutdown). */
  shouldAbort?: () => boolean;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam. */
  now?: () => number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/**
 * Tries `pg_try_advisory_lock` (never blocks) until it succeeds, `waitMs` elapses, or `shouldAbort()` turns true.
 * Returns whether the session lock is now held by `client`. Each attempt is a single non-blocking statement, so the total
 * time is bounded by `waitMs` plus one round trip.
 */
export async function tryAcquireProvisioningLock(client: Pick<Client, 'query'>, options: ProvisioningLockOptions = {}): Promise<boolean> {
  const waitMs = clamp(options.waitMs ?? PROVISIONING_LOCK_WAIT_MS, 0, PROVISIONING_LOCK_WAIT_MAX_MS);
  const pollMs = clamp(options.pollMs ?? PROVISIONING_LOCK_POLL_MS, 25, 5_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    if (options.shouldAbort?.()) return false;
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${PROVISIONING_LOCK_SQL_KEY}) AS locked`);
    if (rows[0]?.locked === true) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * HWS runtime cutover, Part 6 — finishes the integration `ManagerWorkspaceService.create()` only starts. `create()`
 * runs on the request path and can only ever write `schema_status = 'CREATING'` (see its own doc comment) — it
 * never calls `provisionWorkspaceSchema` itself; no controller or resolver route does. This job is that boundary:
 * a periodic, dedicated-connection sweep, the same shape as every other `rab-maintenance` job in this directory,
 * that finds workspaces left in `CREATING` (freshly created, never provisioned) or `FAILED` (a previous attempt
 * that can be retried from scratch — `provisionWorkspaceSchema`'s own doc comment guarantees a failed attempt
 * leaves no partial objects behind) and drives each one through to `READY` or a recorded `FAILED`.
 *
 * P1C.2 note: before the single-credential migration, this boundary was also a DIFFERENT LOGIN ROLE
 * (`rab_owner` here vs. `rab_app` on the request path) — a genuine Postgres-enforced separation, not just an
 * absent route. Both connections are `crewflow` now (see CrewflowSingleCredentialRoleArchitecture1786682000000's
 * own security trade-off note in docs/P1-MASTER-EXECUTION-STATUS.md): `crewflow` DOES hold EXECUTE on
 * `provision_workspace_schema`, so the isolation here is "no HTTP-reachable code path calls it," enforced by
 * application-code discipline and this being a separate, dedicated worker process, not by a database permission
 * a compromised request-path credential could never obtain. Record this honestly rather than imply it is still
 * the same strength of guarantee it used to be.
 *
 * Until this runs, a newly created Workspace stays `CREATING` — non-routable by design
 * (`core.workspace_schema_routable()`), so no business operation can silently use it half-built. Business
 * operations remain unavailable for that Workspace until this job (or a retried attempt) reaches `READY`.
 *
 * Scheduled only by `workspace-provisioner.main.ts`, and only when that process is enabled (Phase A:
 * `CREWFLOW_PROVISIONER_ENABLED=true` — the Worker bundle starts the provisioner child only then — or, standalone with the
 * switch unset, the legacy `HWS_RUNTIME_ENABLED=true`; see workspace-provisioner.config.ts). When it is not enabled the
 * process exits before opening the dedicated connection this needs, and new Workspaces stay `CREATING` unless the API's
 * server-path provisioning builds them.
 *
 * `client` is a single, long-lived `crewflow` connection (`DATABASE_URL_UNPOOLED`) — never the pooled
 * `runtimeDataSource` every other job in this worker uses. `provisionWorkspaceSchema` manages its own `BEGIN`/
 * `COMMIT`/`ROLLBACK` pairs directly on it, so the advisory lock here is session-level (`pg_advisory_lock`,
 * explicitly released in `finally`), not the transaction-scoped `pg_advisory_xact_lock` idiom the other jobs use.
 * Phase A (pa-provisioner): it is taken with a bounded, non-blocking `pg_try_advisory_lock` loop
 * (`tryAcquireProvisioningLock`, default 10 s, hard cap 60 s, abortable on shutdown) instead of the unbounded
 * `pg_advisory_lock` wait; when another provisioner keeps it for the whole wait this tick is SKIPPED
 * (`lockAcquired: false`, no discovery, no DDL) and the next tick tries again. Same lock key as before, so old and new
 * provisioner versions still exclude each other.
 *
 * Candidate discovery goes through `core.worker_list_pending_workspace_schemas()`
 * (`WorkerPendingWorkspaceSchemaDiscovery1786693000000`), not a raw `SELECT ... FROM
 * core.manager_workspace`. That table is one of the 11 pre-auth-sensitive, NOT-FORCEd tables owned
 * by `rab_secure_owner` — `crewflow` is not that owner, so it is bound by the table's own RLS policy
 * regardless of the NOT-FORCE exemption (which only ever bypasses RLS for the owner). A raw query
 * with no tenant context bound always returned zero rows against the real `crewflow` credential;
 * every existing test for this job happened to use the disposable database's superuser connection,
 * which bypasses RLS unconditionally and silently masked it. Confirmed live via the real standalone
 * `workspace-provisioner.main.ts` process before this fix.
 */
export async function runWorkspaceProvisioningCycle(
  client: Client,
  testOptions?: ProvisionOptions,
  lockOptions?: ProvisioningLockOptions,
): Promise<WorkspaceProvisioningResult> {
  if (!(await tryAcquireProvisioningLock(client, lockOptions))) return { attempted: 0, ready: 0, failed: 0, lockAcquired: false };
  try {
    const candidates = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM core.worker_list_pending_workspace_schemas($1)`,
      [BATCH_SIZE],
    );

    let ready = 0;
    let failed = 0;
    for (const { workspace_id: id } of candidates.rows) {
      try {
        // testOptions is the identical test seam provisionWorkspaceSchema's own doc comment describes ("Production
        // callers never pass it") — plumbed through here, unused, so integration tests can inject a deterministic
        // mid-provisioning failure through this REAL job function rather than bypassing it and calling the
        // provisioner directly. Every production call site (main.ts) calls this with one argument; testOptions is
        // always undefined there.
        await provisionWorkspaceSchema(client, id, testOptions);
        ready += 1;
      } catch (error) {
        // provisionWorkspaceSchema already records the failure (core.mark_workspace_schema_failed) and never leaks
        // the driver message — see its own doc comment. One workspace's failure must not abort the whole tick.
        failed += 1;
        if (!(error instanceof WorkspaceSchemaProvisioningError)) throw error;
      }
    }

    return { attempted: candidates.rows.length, ready, failed, lockAcquired: true };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${PROVISIONING_LOCK_SQL_KEY})`);
  }
}
