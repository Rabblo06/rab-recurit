import { MatrixCell, PROBE_EXECUTES_HANDLER, READ_PROBED_BY_QUERY } from './permission-matrix.data';
import { MatrixRoute } from './route-discovery';

/**
 * How the permission matrix requests a route, and what a response means (permission-matrix.integration.spec.ts).
 *
 *   record   a malformed record id: once the guards pass, UuidPathParamsInterceptor answers 404 before any pipe or handler
 *   body     one undeclared body property: once the guards pass, the global ValidationPipe answers 400 before the handler
 *   query    one undeclared query parameter: the same, for a read listed in READ_PROBED_BY_QUERY
 *   read     a GET without a record id, executed for real (reads only)
 *   handler  a mutation with neither a record id nor a validated body: its handler really runs (PROBE_EXECUTES_HANDLER)
 *
 * `guardsPassed` is observed, never inferred: the spec marks every response that reached UuidPathParamsInterceptor, a
 * global interceptor, and Nest runs interceptors only after every guard has let the request through.
 */
export type Probe = 'record' | 'body' | 'query' | 'read' | 'handler';

export interface Observation {
  status: number;
  code?: string;
  message?: string;
  /** The request got past every guard (it reached the global interceptors). */
  guardsPassed: boolean;
}

export function probeOf(route: MatrixRoute): Probe {
  if (route.recordParams.length > 0) return 'record';
  if (route.method === 'GET') return route.key in READ_PROBED_BY_QUERY ? 'query' : 'read';
  if (route.validatedBody) return 'body';
  return 'handler';
}

/**
 * The cell a response stands for; null = never acceptable for that probe (and the suite fails on it):
 *  - refused by a guard (never reached the interceptors): 403 → `403`, 404 → `404`, anything else (401, 429, 5xx) → null;
 *  - past the guards, a side-effect-free probe must get EXACTLY its boundary answer: record → the interceptor's plain 404
 *    (no `code`), body / query → the ValidationPipe's 400. Anything else means the request reached further than the
 *    probe allows (a pipe or handler ran), so it is null, never `ok`;
 *  - past the guards, a read answers for itself: 403 / 404 are the service's own refusal or empty scope for this role,
 *    other 2xx-4xx are `ok`; a handler probe is `ok` unless the service refused with 403 (its "nothing to act on" 404 is
 *    not a permission answer). 401, 429 and 5xx are always null.
 */
export function cellOf(probe: Probe, observed: Observation): MatrixCell | null {
  const { status } = observed;
  if (status === 0 || status === 401 || status === 429 || status >= 500) return null;
  if (!observed.guardsPassed) {
    if (status === 403) return '403';
    if (status === 404) return '404';
    return null;
  }
  switch (probe) {
    case 'record':
      return status === 404 && observed.code === undefined ? 'ok' : null;
    case 'body':
    case 'query':
      return status === 400 ? 'ok' : null;
    case 'read':
      if (status === 403) return '403';
      if (status === 404) return '404';
      return 'ok';
    case 'handler':
      return status === 403 ? '403' : 'ok';
  }
}

/**
 * The authenticated routes whose handler a probe cannot stop, against the decisions in PROBE_EXECUTES_HANDLER: a route
 * missing from the list (a new mutation without a record id or a validated body, e.g. an unvalidated `@Body()`) and a
 * listed route that is no longer such a route. Empty = consistent.
 */
export function handlerProbeProblems(authenticated: readonly MatrixRoute[]): { unlisted: string[]; stale: string[] } {
  const actual = new Set(authenticated.filter((r) => probeOf(r) === 'handler').map((r) => r.key));
  return {
    unlisted: [...actual].filter((key) => !(key in PROBE_EXECUTES_HANDLER)).sort(),
    stale: Object.keys(PROBE_EXECUTES_HANDLER).filter((key) => !actual.has(key)).sort(),
  };
}
