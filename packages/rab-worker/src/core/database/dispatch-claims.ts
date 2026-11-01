import { isNotYetRoutableWorkspace } from './workspace-routing';

/**
 * Phase D (D1) — the Worker half of the global dispatch claim (`WORKER_CLAIM_MODE=global`).
 *
 * The pointer table `core.worker_dispatch_pointer` holds ROUTING IDS ONLY (queue, subject id, organisation, workspace,
 * due time, claim token). The Worker reaches it only through the contract's SECURITY DEFINER functions (EXECUTE granted
 * to `crewflow_worker` only):
 *   core.worker_claim_{email_dispatch|push_dispatch|realtime_publish|statement_dispatch}(p_limit integer)
 *     → TABLE(subject_id, organisation_id, workspace_id, claim_token, claim_count)   (batch clamped 1..200, lease and
 *       per-organisation cap fixed server-side)
 *   core.worker_release_dispatch_claim(p_queue, p_subject_id, p_claim_token, p_retry_after_seconds) → boolean
 *     (token must match; re-times 1..300 s; never deletes)
 * There is deliberately NO complete/delete function: the subject's own trigger re-times or deletes its pointer when the
 * subject changes state, in the producer's/processor's own transaction.
 *
 * A claimed pointer is a HINT, never authority. Every claimed id is processed by the queue's EXISTING per-scope
 * transaction (`TenantContextService`, the pointer's own organisation/workspace bound, RLS applies) with the EXISTING
 * per-scope claim SQL restricted by `AND id = ANY($ids)`: row locks, SKIP LOCKED, status transitions, generation bumps,
 * worker_event idempotency and jobIds are unchanged. A stale or forged pointer therefore finds nothing in its scope and
 * has no effect; it is re-timed by its lease or its trigger.
 *
 * The claim and release calls run AUTOCOMMIT on the claimer connection with NO tenant context bound (nothing here sets a
 * GUC). Each call is its own statement; the claim commits before any scope is processed, so a crash after it leaves the
 * pointers leased until the lease expires and another Worker reclaims them.
 */

export type DispatchQueue = 'email' | 'push' | 'realtime' | 'statement';
export const DISPATCH_QUEUES: readonly DispatchQueue[] = Object.freeze(['email', 'push', 'realtime', 'statement'] as const);

/** Fixed SQL per queue (the queue label never reaches SQL text from anywhere else). */
const CLAIM_SQL: Readonly<Record<DispatchQueue, string>> = Object.freeze({
  email: 'SELECT subject_id, organisation_id, workspace_id, claim_token, claim_count FROM core.worker_claim_email_dispatch($1::integer)',
  push: 'SELECT subject_id, organisation_id, workspace_id, claim_token, claim_count FROM core.worker_claim_push_dispatch($1::integer)',
  realtime: 'SELECT subject_id, organisation_id, workspace_id, claim_token, claim_count FROM core.worker_claim_realtime_publish($1::integer)',
  statement: 'SELECT subject_id, organisation_id, workspace_id, claim_token, claim_count FROM core.worker_claim_statement_dispatch($1::integer)',
});
const RELEASE_SQL = 'SELECT core.worker_release_dispatch_claim($1::text, $2::uuid, $3::uuid, $4::integer) AS released';

/** The contract's server-side clamp, mirrored client-side (defence in depth). */
export const DISPATCH_CLAIM_BATCH_MIN = 1;
export const DISPATCH_CLAIM_BATCH_MAX = 200;
export const DISPATCH_RELEASE_RETRY_MIN_SECONDS = 1;
export const DISPATCH_RELEASE_RETRY_MAX_SECONDS = 300;
/** Re-time for a scope whose workspace is not routable yet (still provisioning) — the per-scope walk's "next cycle". */
export const RELEASE_RETRY_NOT_ROUTABLE_SECONDS = 30;
/** Re-time for a scope that failed unexpectedly (or was never reached because an earlier scope failed). */
export const RELEASE_RETRY_AFTER_ERROR_SECONDS = 15;
/**
 * OD-1 (owner decision 2026-11-01, accepted temporarily): a pointer claimed MORE than this many times without its subject
 * reaching a state its trigger handles is alerted on (routing ids + count only). Visibility only — nothing is purged.
 */
export const DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD = 20;

/** Anything with `query(sql, params)` — a TypeORM DataSource (autocommit) or a pg shim. */
export interface DispatchQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface DispatchClaim {
  subjectId: string;
  organisationId: string;
  workspaceId: string | null;
  claimToken: string;
  claimCount: number;
}

export interface DispatchScopeWork {
  organisationId: string;
  workspaceId: string | null;
  subjectIds: string[];
  claims: DispatchClaim[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function isDispatchQueue(value: unknown): value is DispatchQueue {
  return typeof value === 'string' && (DISPATCH_QUEUES as readonly string[]).includes(value);
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}

/** Claims up to `limit` due pointers of `queue` (autocommit, no tenant context). Malformed rows are dropped, never acted on. */
export async function claimDispatchPointers(claimer: DispatchQueryable, queue: DispatchQueue, limit: number): Promise<DispatchClaim[]> {
  if (!isDispatchQueue(queue)) throw new Error('unknown dispatch queue');
  const rows = (await claimer.query(CLAIM_SQL[queue], [clampInt(limit, DISPATCH_CLAIM_BATCH_MIN, DISPATCH_CLAIM_BATCH_MAX)])) as Array<Record<string, unknown>>;
  const claims: DispatchClaim[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const workspaceId = row.workspace_id ?? null;
    if (!isUuid(row.subject_id) || !isUuid(row.organisation_id) || !isUuid(row.claim_token) || (workspaceId !== null && !isUuid(workspaceId))) continue;
    claims.push({
      subjectId: row.subject_id,
      organisationId: row.organisation_id,
      workspaceId,
      claimToken: row.claim_token,
      claimCount: Number(row.claim_count ?? 0),
    });
  }
  return claims;
}

/** Re-times OUR claimed pointer. `false` = the token no longer matches (another Worker re-claimed it, or its trigger moved it). */
export async function releaseDispatchClaim(
  claimer: DispatchQueryable,
  queue: DispatchQueue,
  subjectId: string,
  claimToken: string,
  retryAfterSeconds: number,
): Promise<boolean> {
  if (!isDispatchQueue(queue)) throw new Error('unknown dispatch queue');
  const rows = (await claimer.query(RELEASE_SQL, [
    queue,
    subjectId,
    claimToken,
    clampInt(retryAfterSeconds, DISPATCH_RELEASE_RETRY_MIN_SECONDS, DISPATCH_RELEASE_RETRY_MAX_SECONDS),
  ])) as Array<{ released?: unknown }>;
  return Array.isArray(rows) && rows[0]?.released === true;
}

/**
 * Groups claims by the scope their existing per-scope transaction binds. Email and push are organisation-scoped outboxes
 * (today's per-organisation walk binds `workspaceId: null`), so their workspace is never bound; realtime and statements
 * keep the pointer's (organisation, workspace) exactly as the per-scope walks do. First-seen order.
 */
export function groupClaimsByScope(queue: DispatchQueue, claims: readonly DispatchClaim[]): DispatchScopeWork[] {
  const orgOnly = queue === 'email' || queue === 'push';
  const groups = new Map<string, DispatchScopeWork>();
  for (const claim of claims) {
    const workspaceId = orgOnly ? null : claim.workspaceId;
    const key = `${claim.organisationId}|${workspaceId ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { organisationId: claim.organisationId, workspaceId, subjectIds: [], claims: [] };
      groups.set(key, group);
    }
    group.subjectIds.push(claim.subjectId);
    group.claims.push(claim);
  }
  return [...groups.values()];
}

export interface GlobalDispatchLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface GlobalDispatchOptions {
  claimer: DispatchQueryable;
  queue: DispatchQueue;
  /** Ids requested per claim call (WORKER_DISPATCH_CLAIM_BATCH). */
  batch: number;
  /**
   * At most this many claim calls per run. Wave 5 (F-W4-1): the run continues while a claim returned ANY rows — the
   * server's per-organisation cap makes a single-tenant backlog come back short every time — and ends at the first EMPTY
   * claim or at this bound (`boundReached`).
   */
  maxBatches: number;
  /** Runs one scope through the queue's existing per-scope transaction restricted to `scope.subjectIds`. */
  processScope: (scope: DispatchScopeWork) => Promise<unknown>;
  logger: GlobalDispatchLogger;
  /** OD-1: called for every claim whose claim_count exceeds DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD (never throws into the run). */
  onHighClaimCount?: (claim: DispatchClaim) => void;
  /** OD-1: every claim call's (well-formed) claims, right after the claim commits — so a run that later fails is still counted. */
  onClaimed?: (claims: readonly DispatchClaim[]) => void;
}

export interface GlobalDispatchReport {
  batches: number;
  claimed: number;
  scopes: number;
  /** Scopes whose workspace was not routable yet: their claims were released for a later retry. */
  skippedNotReady: number;
  /** Statement pointers with no workspace (statements are per workspace): never processed. */
  invalidScope: number;
  released: number;
  /** Release refused: the token no longer matched (another Worker re-claimed after our lease, or the trigger moved it). */
  releaseRefused: number;
  releaseFailed: number;
  /** OD-1: claims with claim_count > 1 (the pointer was claimed before and its subject has not moved on yet). */
  repeatedClaims: number;
  /** OD-1: claims with claim_count > DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD (20). */
  highClaimCount: number;
  /**
   * Wave 5 (F-W4-1): the run stopped at `maxBatches` while its last claim still returned rows — more is probably due, so
   * the coordinator schedules a prompt follow-up run (coalesced; never a second concurrent loop).
   */
  boundReached: boolean;
}

/**
 * One global dispatch run for one queue: claim → group by scope → process each scope → claim again while a claim returned
 * any rows (wave 5, F-W4-1), ending at the first empty claim or at `maxBatches` (`boundReached`). A not-yet-routable workspace releases its scope's claims and the run continues (as
 * the per-scope walk skips it). Any other error releases the failed scope and every scope not yet processed, then
 * rethrows (the runtime counts the failure, exactly like a failed per-scope cycle).
 */
export async function runGlobalDispatch(options: GlobalDispatchOptions): Promise<GlobalDispatchReport> {
  const { claimer, queue, logger } = options;
  const batch = clampInt(options.batch, DISPATCH_CLAIM_BATCH_MIN, DISPATCH_CLAIM_BATCH_MAX);
  const maxBatches = Math.max(1, Math.trunc(options.maxBatches));
  const report: GlobalDispatchReport = {
    batches: 0, claimed: 0, scopes: 0, skippedNotReady: 0, invalidScope: 0, released: 0, releaseRefused: 0, releaseFailed: 0, repeatedClaims: 0, highClaimCount: 0,
    boundReached: false,
  };

  const release = async (scopes: readonly DispatchScopeWork[], retryAfterSeconds: number): Promise<void> => {
    for (const scope of scopes) {
      for (const claim of scope.claims) {
        try {
          if (await releaseDispatchClaim(claimer, queue, claim.subjectId, claim.claimToken, retryAfterSeconds)) report.released += 1;
          else report.releaseRefused += 1;
        } catch (error) {
          // Best effort: the server-fixed lease re-times the pointer anyway.
          report.releaseFailed += 1;
          logger.warn(`${queue} dispatch: releasing a claim failed (${(error as Error).name}); the lease will expire instead`);
        }
      }
    }
  };

  while (report.batches < maxBatches) {
    const claims = await claimDispatchPointers(claimer, queue, batch);
    report.batches += 1;
    report.claimed += claims.length;
    // Wave 5 (F-W4-1): only an EMPTY claim means "nothing due now". A short batch does not — the server caps each claim per
    // organisation (10; realtime 25). Termination: every pointer a claim returns is leased (server-side) for longer than
    // a run, so it cannot be returned again within this run even when its subject turns out not to be due (processScope
    // finds nothing); each claim therefore returns new pointers or none, and `maxBatches` bounds the run regardless.
    if (claims.length === 0) break;
    try {
      options.onClaimed?.(claims);
    } catch {
      // Visibility only.
    }
    for (const claim of claims) {
      if (claim.claimCount > 1) report.repeatedClaims += 1;
      if (claim.claimCount > DISPATCH_CLAIM_COUNT_ALERT_THRESHOLD) {
        report.highClaimCount += 1;
        try {
          options.onHighClaimCount?.(claim);
        } catch {
          // Visibility only: an alert hook must never change what the run does.
        }
      }
    }
    const scopes = groupClaimsByScope(queue, claims);
    for (let i = 0; i < scopes.length; i += 1) {
      const scope = scopes[i]!;
      if (queue === 'statement' && scope.workspaceId === null) {
        report.invalidScope += 1;
        logger.warn('statement dispatch: a claimed pointer has no workspace; ignored (statements are dispatched per workspace)');
        continue;
      }
      try {
        await options.processScope(scope);
        report.scopes += 1;
      } catch (error) {
        if (scope.workspaceId !== null && isNotYetRoutableWorkspace(error)) {
          report.skippedNotReady += 1;
          await release([scope], RELEASE_RETRY_NOT_ROUTABLE_SECONDS);
          continue;
        }
        await release(scopes.slice(i), RELEASE_RETRY_AFTER_ERROR_SECONDS);
        throw error;
      }
    }
    if (report.batches >= maxBatches) report.boundReached = true;
  }
  return report;
}
