import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { validateAndBuildEnvelope } from '@rab/server/engine/core-modules/realtime/realtime-envelope';
import { storageScopes, MaintenanceScope } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { ClaimedRealtimeEvent, claimRealtimeEvents, completeRealtimeEvent, markRealtimeEventRetry, cancelRealtimeEvent } from '../../core/database/realtime-event';

/**
 * Stage 2 — the Redis Pub/Sub publisher for `core.realtime_event`
 * (Stage 1's durable outbox). Reuses Stage 1's `claimRealtimeEvents` and
 * its `MATERIALIZED` claim query unchanged — this file adds nothing to the
 * claim SQL, only what happens to a claimed row afterward. Never duplicates
 * the outbox: no second table, no second claim query.
 *
 * DISCOVERY, not a single global claim: `core.realtime_event` has the same
 * RLS shape as `core.worker_event` (`organisation_id = current_org() AND
 * (workspace_id IS NULL OR workspace_id = current_workspace())`), and this
 * codebase's own worker jobs have no mechanism to bind "every org/workspace
 * at once" — confirmed against `late-clock-in.job.ts`/`workspace-
 * discovery.ts`: every existing cross-tenant job loops organisation-by-
 * organisation (and workspace-by-workspace) via the same SECURITY DEFINER
 * enumeration functions used here (`core.worker_list_organisations`,
 * `core.worker_list_workspaces`), binding a real `crewflow_app`-role
 * transaction to each scope in turn via `runScopedForOrg`. A single claim
 * ACROSS every tenant in one query would require bypassing RLS, which
 * nothing in this codebase does and this file does not either.
 *
 * Scope enumeration reuses `storageScopes()` (`engine/worker-shared/
 * maintenance-catalogue.ts`) verbatim — the SAME generator
 * `storage-reconcile.command.ts` and `secret-rotation.service.ts` already
 * use for this exact "every org, then every workspace" cross-tenant walk,
 * never reimplemented here. It yields `{organisationId, workspaceId: null}`
 * once per organisation (catches `workspace_id IS NULL` rows — binding a
 * NULL workspace makes `core.current_workspace()` resolve to NULL, under
 * which the policy's `workspace_id = current_workspace()` branch is never
 * true, so this scope sees EXACTLY the org-wide rows), then
 * `{organisationId, workspaceId}` once per workspace (catches workspace-
 * scoped rows; also re-matches org-wide rows, which is harmless —
 * `claimRealtimeEvents`'s own `FOR UPDATE SKIP LOCKED` means whichever
 * scope gets there first claims it, the other sees nothing left).
 *
 * Every claimed row is independently validated (`validateAndBuildEnvelope`)
 * before anything is published — an invalid/unknown-type row is a POISON
 * event (will never become valid by retrying) and goes straight to
 * `cancelRealtimeEvent`, never through the bounded-retry counter.
 *
 * Mark-completed happens ONLY after `publish` resolves without throwing —
 * never before, never speculatively. A worker crash between a successful
 * publish and this call leaves the row `processing` until its lease expires,
 * then another cycle reclaims and republishes it: a genuine duplicate
 * delivery, which this stage explicitly does not try to prevent (at-least-
 * once, not exactly-once — see this job's own test file for the proof).
 */

const DEFAULT_PER_SCOPE_LIMIT = 25;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_RETRY_BACKOFF_SECONDS = 15;

export interface RealtimeOutboxPublishResult {
  /** Rows this cycle successfully claimed (processing), across every scope. */
  claimed: number;
  /** Rows durably published to Redis and marked completed. */
  published: number;
  /** Rows rejected as poison (unknown type, unsupported schema version, missing required scope) — cancelled, never retried. */
  invalid: number;
  /** Claimed rows whose publish attempt threw and were scheduled for another attempt. */
  retried: number;
  /** Rows that exhausted max_attempts, or whose lease was lost between claim and the final write (logged, not retried further by this cycle). */
  failed: number;
}

/** A Redis `PUBLISH` call — the caller owns the connection and its lifecycle; this function only calls it. Returns the subscriber count ioredis itself returns (0 is a normal, expected outcome, never treated as failure here). */
export type RealtimePublishFn = (channel: string, message: string) => Promise<number>;

export async function runRealtimeOutboxPublishCycle(
  runtime: DataSource,
  tenantContext: TenantContextService,
  publish: RealtimePublishFn,
  env: string,
  opts: {
    perScopeLimit?: number;
    leaseSeconds?: number;
    /**
     * Restricts discovery to exactly these scopes instead of the full
     * `storageScopes()` cross-tenant walk. Production never sets this
     * (the whole point is to reach every tenant); it exists for tests
     * that would otherwise have to pay the full org+workspace scan cost
     * of whatever has accumulated in a long-lived shared database, and
     * for a future sharded-worker deployment that wants to own a fixed
     * partition of tenants. Same precedent as `discoverInWorkspaces`'s
     * own optional `organisationId` filter parameter.
     */
    scopes?: MaintenanceScope[];
  } = {},
): Promise<RealtimeOutboxPublishResult> {
  const perScopeLimit = opts.perScopeLimit ?? DEFAULT_PER_SCOPE_LIMIT;
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const result: RealtimeOutboxPublishResult = { claimed: 0, published: 0, invalid: 0, retried: 0, failed: 0 };

  async function claimAndProcess(organisationId: string, workspaceId: string | null): Promise<void> {
    const claimToken = randomUUID();
    const claimed = await runScopedForOrg(tenantContext, organisationId, workspaceId, (manager) =>
      claimRealtimeEvents(manager, { limit: perScopeLimit, claimToken, leaseSeconds }),
    );
    if (claimed.length === 0) return;
    result.claimed += claimed.length;
    for (const event of claimed) {
      // eslint-disable-next-line no-await-in-loop
      await processOne(organisationId, workspaceId, event);
    }
  }

  async function processOne(organisationId: string, workspaceId: string | null, event: ClaimedRealtimeEvent): Promise<void> {
    const validation = validateAndBuildEnvelope(event, env);
    if (!validation.ok) {
      await runScopedForOrg(tenantContext, organisationId, workspaceId, (manager) => cancelRealtimeEvent(manager, event.id, `invalid:${validation.reason}`));
      result.invalid++;
      return;
    }

    try {
      await publish(validation.channel, JSON.stringify(validation.envelope));
    } catch (error) {
      const outcome = await runScopedForOrg(tenantContext, organisationId, workspaceId, (manager) =>
        markRealtimeEventRetry(manager, event.id, event.claimToken, errorCode(error), DEFAULT_RETRY_BACKOFF_SECONDS),
      );
      if (outcome === 'retry') result.retried++;
      else result.failed++; // 'failed' = attempts exhausted; 'lost_lease' = reclaimed by someone else mid-flight, also logged here
      return;
    }

    const completed = await runScopedForOrg(tenantContext, organisationId, workspaceId, (manager) => completeRealtimeEvent(manager, event.id, event.claimToken));
    // A `false` here means the lease was reclaimed between the publish call above and this write — the OTHER
    // claimant will publish (or already has) and complete it; this attempt simply doesn't get credit for it.
    if (completed) result.published++;
    else result.failed++;
  }

  const scopeSource = opts.scopes ?? storageScopes(runtime);
  for await (const scope of scopeSource) {
    await claimAndProcess(scope.organisationId, scope.workspaceId);
  }

  return result;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return 'unknown_publish_error';
}
