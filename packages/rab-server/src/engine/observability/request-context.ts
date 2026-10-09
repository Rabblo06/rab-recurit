import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * P1A (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program, checkpoint A): the one request-scoped
 * correlation/metrics store for this process. Deliberately minimal and dependency-free (no
 * tracing SDK, no metrics library) — this is the smallest permanent instrumentation needed to
 * make P1's later before/after measurements trustworthy, not a general observability platform.
 *
 * SAFETY: every field recorded here is low-cardinality and non-secret by construction —
 * `requestId` (a fresh UUID per request), `method`, a route TEMPLATE (never the resolved
 * path-with-ids), a status code, counts, and stage-name -> millisecond maps keyed by the fixed
 * stage names this file's own callers use. Nothing here EVER stores: an access/refresh token,
 * a cookie value, a password, an email address, a userId/workspaceId/organisationId, or a raw
 * SQL literal/parameter. Callers must not start doing so either — see `recordSqlQuery`'s own
 * doc comment for why `slow-query-logger.ts` only ever passes a boolean classification, never
 * the query text, into this module.
 */

export interface RequestMetrics {
  sqlCount: number;
  transactionCount: number;
  /** Stage name -> cumulative milliseconds. Fixed, known stage names only (see call sites) — never a dynamic/user-influenced key. */
  stages: Record<string, number>;
}

export interface RequestContextValue {
  requestId: string;
  method: string;
  /** A route TEMPLATE (e.g. "/rest/v1/staff/:id"), never the resolved path with a real id in it. */
  routeTemplate: string;
  startedAt: number;
  metrics: RequestMetrics;
}

export interface RequestCompletePayload {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  sqlCount: number;
  transactionCount: number;
  stages: Record<string, number>;
}

const als = new AsyncLocalStorage<RequestContextValue>();

export function runWithRequestContext<T>(value: RequestContextValue, fn: () => T): T {
  return als.run(value, fn);
}

export function getRequestContext(): RequestContextValue | undefined {
  return als.getStore();
}

/**
 * Called only from `slow-query-logger.ts`'s `logQuery` — the one place that observes every SQL
 * statement this process issues. `isTransactionBoundary` is a boolean CLASSIFICATION the caller
 * derives from the query text (is this a `BEGIN`/`START TRANSACTION`?), never the text itself —
 * this function has no parameter through which a query string or bound value could ever flow in.
 */
export function recordSqlQuery(isTransactionBoundary: boolean): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  if (isTransactionBoundary) ctx.metrics.transactionCount += 1;
  else ctx.metrics.sqlCount += 1;
}

function recordStage(stageName: string, durationMs: number): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  ctx.metrics.stages[stageName] = (ctx.metrics.stages[stageName] ?? 0) + durationMs;
}

/** Wraps one auth/guard/tenant-context stage with a fixed, low-cardinality stage name. Adds negligible overhead (one `performance.now()` pair) and never alters the wrapped call's behavior or thrown error. */
export async function timeStage<T>(stageName: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordStage(stageName, performance.now() - start);
  }
}

type RequestCompleteListener = (payload: RequestCompletePayload) => void;
const listeners = new Set<RequestCompleteListener>();

/** Used only by `request-context.middleware.ts` on response `finish`. */
export function publishRequestComplete(payload: RequestCompletePayload): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // A listener's own failure (e.g. a benchmark script's assertion) must never affect the
      // live request/response it's observing — this already completed by the time this runs.
    }
  }
}

/**
 * Subscribes to every completed request's safe metrics payload, in-process. Used by the P1A
 * baseline script (`scripts/perf-baseline.ts`) to collect real per-route timing/query-count
 * samples without scraping log output. Returns an unsubscribe function.
 */
export function subscribeToRequestMetrics(listener: RequestCompleteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
