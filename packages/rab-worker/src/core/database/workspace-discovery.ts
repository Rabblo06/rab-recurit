import { DataSource, EntityManager } from 'typeorm';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

import { isNotYetRoutableWorkspace } from './workspace-routing';

/** Keyset page size for the routing list. Matches the function's own ceiling (core.worker_list_workspaces caps at 100). */
const DISCOVERY_PAGE_SIZE = 100;

/** Four read-only scans at a time — bounds connection-pool use without serialising every empty workspace round trip. See P2.2 note below on why this number, not a higher one, is the safe lever to tune. */
const CONCURRENCY = 4;

/**
 * Workspace discovery for workspace-scoped worker scans (Twenty-style runtime cutover).
 *
 * The routing list comes from core.worker_list_workspaces(after, limit), a SECURITY DEFINER function owned by the narrow NOLOGIN rab_secure_owner, executable
 * only by crewflow. It returns workspace id, organisation id, status and schema version, nothing else: no staff, business or identity
 * columns. The runtime DataSource (crewflow) is the only connection used, so no separate connection is involved.
 *
 * Each scan runs in the trusted, server-derived context of its own workspace: organisation and workspace bound, and the worker actor
 * marker bound (rab.actor_type = 'worker'). The marker is what lets the staff_profile_worker_scan policy show that workspace's Staff
 * rows. It does not set a user id: the scan impersonates no Manager, and no human policy changes.
 *
 * The callback receives only the RLS-bound EntityManager, never a DataSource, and must stay read-only.
 *
 * P2.2 — this function's O(workspace count) cost (confirmed empirically: 9,673 workspaces in this
 * dev database, each needing its own transaction) is `docs/architecture/HYPER-WORKSPACE-SCHEMA-
 * AUDIT.md`'s own already-documented blocker B6 ("Worker discovery scans all workspaces... cost
 * and correctness of N-schema scans"), explicitly deferred to a not-yet-started future phase
 * (HWS-5) and separately flagged in that same doc's §10 as "NEEDS PROJECTION LATER (scan cost
 * grows with workspace count)". An earlier attempt in this session to add a cheap owner-connection
 * pre-filter (skip opening a transaction for workspaces that can't match) turned out to be
 * infeasible WITHOUT that projection: `shift`/`shift_assignment`/`attendance` are NOT one shared,
 * RLS-filtered table — each workspace has its OWN physical schema (`workspace_<uuid>`) with its
 * own copy of these tables (confirmed via `pg_class`/`information_schema.tables`), so there is no
 * single cross-workspace query to pre-filter with; building one would mean either iterating every
 * schema anyway (no saving) or a dedicated cross-schema projection table maintained by triggers —
 * exactly the HWS-5 scope, not a same-checkpoint fix. Not attempted here. Two genuinely safe,
 * bounded improvements WERE made instead (see `shift-monitor.job.ts`'s merged reminder/no-show
 * query and this file's own `CONCURRENCY` constant) — neither changes this function's fundamental
 * per-workspace shape, both reduce its constant-factor cost within it.
 */
export async function discoverInWorkspaces<T>(
  runtime: DataSource,
  tenant: TenantContextService,
  scan: (manager: EntityManager) => Promise<T[]>,
  organisationId?: string,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Array<{ workspace_id: string; organisation_id: string }> = await runtime.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return manager.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [
        after,
        DISCOVERY_PAGE_SIZE,
      ]);
    });
    if (!page.length) break;
    // Organisation filter is applied to the trusted page, after the function returns. No caller uses it today.
    const scopes = organisationId ? page.filter((row) => row.organisation_id === organisationId) : page;
    for (let offset = 0; offset < scopes.length; offset += CONCURRENCY) {
      const batches = await Promise.allSettled(
        scopes.slice(offset, offset + CONCURRENCY).map((scope) =>
          tenant.runInTenantContext(
            { organisationId: scope.organisation_id, workspaceId: scope.workspace_id, userId: '', role: '', actorType: 'worker' },
            async (manager) => {
              await manager.query('SET TRANSACTION READ ONLY');
              return scan(manager);
            },
          ),
        ),
      );
      for (const batch of batches) {
        if (batch.status === 'rejected') {
          // W6-E2E-07: a workspace still being provisioned (no registry row yet / not READY) has nothing to scan — skip it
          // instead of failing every tenant's cycle. Integrity refusals still throw (see workspace-routing.ts).
          if (isNotYetRoutableWorkspace(batch.reason)) continue;
          throw batch.reason;
        }
        result.push(...batch.value);
      }
    }
    after = page[page.length - 1].workspace_id;
  }
  return result;
}

/** Phase D-Q4a: one member of a shared walk — its key and its own per-workspace discovery (the separate scan's callback). */
export interface WalkMember {
  key: string;
  discover: (manager: EntityManager) => Promise<unknown[]>;
}

export type WalkMemberResult = { ok: true; rows: unknown[] } | { ok: false; error: unknown };

export interface WalkResult {
  /** One entry per member: every row it discovered (in the order `discoverInWorkspaces` would return them), or its error. */
  members: Map<string, WalkMemberResult>;
  /** A catalogue-page or workspace-transaction failure (not a member's own query): every member then failed with it. */
  walkError: unknown | null;
}

/** Savepoint name used around each member's discovery (a constant identifier, never built from data). */
const MEMBER_SAVEPOINT = 'crewflow_combined_member';

/**
 * Phase D-Q4a (WORKER_SHIFT_SCAN_MODE=combined): `discoverInWorkspaces` for SEVERAL scans in ONE walk. The same
 * primitives, unchanged: the same `core.worker_list_workspaces` pages (READ ONLY, 100 at a time), then per workspace ONE
 * READ ONLY `runInTenantContext` transaction (organisation + workspace + worker actor bound with SET LOCAL, FORCE RLS), 4
 * workspaces at a time. Inside that transaction every member's own discovery runs in turn, each inside its own SAVEPOINT,
 * so one member's failing query rolls back to its savepoint and the other members still run in the same transaction.
 *
 * Equivalence with separate mode, per member: rows are collected in the same page/batch order; a member whose query fails
 * in ANY workspace is reported failed and its rows are discarded (separate mode would have thrown and processed nothing),
 * and it is not run in later workspaces. A not-yet-routable workspace is skipped for every member, exactly as today. Any
 * other workspace-level or catalogue failure is the walk's own error: the walk stops and every member not already failed
 * is reported failed with it (separate mode: every scan's walk would have thrown on the same workspace). Never throws.
 */
export async function discoverMembersInWorkspaces(runtime: DataSource, tenant: TenantContextService, members: readonly WalkMember[]): Promise<WalkResult> {
  const rows = new Map<string, unknown[]>(members.map((m) => [m.key, []]));
  const failed = new Map<string, unknown>();
  let walkError: unknown | null = null;
  let after: string | null = null;
  walk: for (;;) {
    let page: Array<{ workspace_id: string; organisation_id: string }>;
    try {
      page = await runtime.transaction(async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        return manager.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [after, DISCOVERY_PAGE_SIZE]);
      });
    } catch (error) {
      walkError = error;
      break;
    }
    if (!page.length) break;
    for (let offset = 0; offset < page.length; offset += CONCURRENCY) {
      const active = members.filter((m) => !failed.has(m.key));
      if (!active.length) break walk;
      const batches = await Promise.allSettled(
        page.slice(offset, offset + CONCURRENCY).map((scope) =>
          tenant.runInTenantContext(
            { organisationId: scope.organisation_id, workspaceId: scope.workspace_id, userId: '', role: '', actorType: 'worker' },
            async (manager) => {
              await manager.query('SET TRANSACTION READ ONLY');
              const results: Array<{ key: string } & WalkMemberResult> = [];
              for (const member of active) {
                await manager.query(`SAVEPOINT ${MEMBER_SAVEPOINT}`);
                try {
                  const found = await member.discover(manager);
                  await manager.query(`RELEASE SAVEPOINT ${MEMBER_SAVEPOINT}`);
                  results.push({ key: member.key, ok: true, rows: found });
                } catch (error) {
                  // A failed ROLLBACK TO (connection lost) rejects the whole workspace below: the walk's own error.
                  await manager.query(`ROLLBACK TO SAVEPOINT ${MEMBER_SAVEPOINT}`);
                  results.push({ key: member.key, ok: false, error });
                }
              }
              return results;
            },
          ),
        ),
      );
      for (const batch of batches) {
        if (batch.status === 'rejected') {
          // W6-E2E-07, as in discoverInWorkspaces: a workspace still being provisioned has nothing to scan.
          if (isNotYetRoutableWorkspace(batch.reason)) continue;
          walkError = batch.reason;
          break walk;
        }
        for (const result of batch.value) {
          if (failed.has(result.key)) continue;
          if (result.ok) rows.get(result.key)!.push(...result.rows);
          else failed.set(result.key, result.error);
        }
      }
    }
    after = page[page.length - 1].workspace_id;
  }
  const out = new Map<string, WalkMemberResult>();
  for (const member of members) {
    if (failed.has(member.key)) out.set(member.key, { ok: false, error: failed.get(member.key) });
    else if (walkError !== null) out.set(member.key, { ok: false, error: walkError });
    else out.set(member.key, { ok: true, rows: rows.get(member.key)! });
  }
  return { members: out, walkError };
}
