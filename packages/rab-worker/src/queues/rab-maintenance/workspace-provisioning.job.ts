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
 * Registered in `main.ts` ONLY when `HWS_RUNTIME_ENABLED=true` — see that file's own comment. With the flag off
 * (every deployment's default), this job is never scheduled at all, so a Workspace created today behaves exactly
 * as it does now: `CREATING`, non-routable, and `main.ts` never opens the dedicated connection this needs.
 *
 * `client` is a single, long-lived `crewflow` connection (`DATABASE_URL_UNPOOLED`) — never the pooled
 * `runtimeDataSource` every other job in this worker uses. `provisionWorkspaceSchema` manages its own `BEGIN`/
 * `COMMIT`/`ROLLBACK` pairs directly on it, so the advisory lock here is session-level (`pg_advisory_lock`,
 * explicitly released in `finally`), not the transaction-scoped `pg_advisory_xact_lock` idiom the other jobs use.
 */
export async function runWorkspaceProvisioningCycle(client: Client, testOptions?: ProvisionOptions): Promise<WorkspaceProvisioningResult> {
  await client.query(`SELECT pg_advisory_lock(hashtext('rab_workspace_provisioning'))`);
  try {
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM core.manager_workspace WHERE schema_status IN ('CREATING', 'FAILED') ORDER BY created_at ASC LIMIT $1`,
      [BATCH_SIZE],
    );

    let ready = 0;
    let failed = 0;
    for (const { id } of candidates.rows) {
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

    return { attempted: candidates.rows.length, ready, failed };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('rab_workspace_provisioning'))`);
  }
}
