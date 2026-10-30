/**
 * Phase B (B4/P5): THE explicit opt-in register of reads that may run on the read replica. A read is replica-eligible
 * only if it is listed here; replica-read-register.spec.ts parses the source and fails when any `useReplica: true` call
 * site is not listed (or a listed one disappears). Everything else — every write, auth/session/MFA/permission
 * resolution, payroll, right-to-work and other sensitive staff fields, audit log, the admin panel, hidden writes and
 * read-your-writes paths — runs on the primary.
 *
 * Criteria for an entry (all of them):
 *   - ordinary list / count / dashboard / search read, called only from its own GET route (no internal caller that
 *     re-reads its own write);
 *   - no write or hidden write (audit.record, realtime/outbox, Redis/entity-cache fill, FOR UPDATE, advisory lock) — and
 *     the read runs READ ONLY on the primary too, so a hidden write fails in every environment;
 *   - no payroll table, no core.audit_log, no right-to-work / address / pay / DOB / emergency-contact fields in the result;
 *   - lag-tolerant: a list that is up to PG_DATABASE_REPLICA_MAX_LAG_MS behind is acceptable.
 *
 * Shared consistency/controls for every entry: bounded staleness ≤ PG_DATABASE_REPLICA_MAX_LAG_MS (5 s default),
 * measured by WAL position, else primary; tenant controls = the same transaction-local set_config GUCs + search_path,
 * FORCE RLS on the standby, READ ONLY transaction, guard (layer 1) evaluated on the primary snapshot; fallback = primary
 * when not configured / not validated / unavailable / stale / refused, and a one-time primary retry on a replica
 * connection or recovery-conflict error.
 */
export interface ReplicaReadEntry {
  /** Repo-relative file. */
  file: string;
  /** The service method whose transaction passes `{ useReplica: true }`. */
  method: string;
  route: string;
  why: string;
}

export const REPLICA_READ_REGISTER: readonly ReplicaReadEntry[] = Object.freeze([
  { file: 'packages/rab-server/src/modules/scheduling/services/scheduling.service.ts', method: 'listJobRoles', route: 'GET /rest/v1/job-roles', why: 'reference list, no writes' },
  { file: 'packages/rab-server/src/modules/scheduling/services/scheduling.service.ts', method: 'list', route: 'GET /rest/v1/shifts', why: 'shift list, no writes, no staff-sensitive fields' },
  {
    file: 'packages/rab-server/src/modules/scheduling/services/scheduling.service.ts',
    method: 'listSentShifts',
    route: 'GET /rest/v1/shifts/sent, GET /rest/v1/shifts/sent/:id',
    why: 'counts and names, no writes',
  },
  { file: 'packages/rab-server/src/modules/offer/services/offer.service.ts', method: 'list', route: 'GET /rest/v1/offers', why: 'offer list, no writes' },
  { file: 'packages/rab-server/src/modules/offer/services/replacement-request.service.ts', method: 'list', route: 'GET /rest/v1/replacement-requests', why: 'list, no writes' },
  {
    file: 'packages/rab-server/src/modules/staff/services/staff.service.ts',
    method: 'venueDirectory',
    route: 'GET /rest/v1/staff/venue-directory',
    why: 'names, role, availability only (no right-to-work, address, pay); permission check stays a primary transaction before it',
  },
  {
    file: 'packages/rab-server/src/modules/staff/services/staff.service.ts',
    method: 'venueTeamMember',
    route: 'GET /rest/v1/staff/venue-directory/:staffId',
    why: 'non-sensitive team profile; permission check stays a primary transaction before it',
  },
  { file: 'packages/rab-server/src/modules/venue/services/venue.service.ts', method: 'list', route: 'GET /rest/v1/venues', why: 'venue list, no writes' },
  { file: 'packages/rab-server/src/modules/dashboard/services/dashboard.service.ts', method: 'getSummary', route: 'GET /rest/v1/dashboard/summary', why: 'counts only' },
  { file: 'packages/rab-server/src/modules/search/services/search.service.ts', method: 'search', route: 'GET /rest/v1/search', why: 'returns id/name/type only' },
  {
    file: 'packages/rab-server/src/modules/attendance/services/shift-report.service.ts',
    method: 'listReports',
    route: 'GET /rest/v1/attendance/report/shifts',
    why: 'report list counts, no pay columns, no writes',
  },
]);
