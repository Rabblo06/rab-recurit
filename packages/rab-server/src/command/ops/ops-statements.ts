/**
 * The FROZEN statement list of the narrowed ops session, and the plan per command + mode.
 *
 * The narrowed session (elevated-ops-session.ts) accepts statement NAMES from this registry only — never SQL text — and a
 * plan allows only the names it lists for a READ ONLY or a READ WRITE transaction. Adding a statement or widening a plan
 * is a reviewed code change to this file; nothing else can make the narrowed session run SQL.
 *
 * Minimum effective role per command (the runbook's ops section has the same table). Every run is a one-off of the API
 * service under the owner login crewflow_owner (ops-run.ts; the separated-mode rab-ops container is removed):
 *
 *   command / mode                       primary (crewflow_owner, RLS-bound)    narrowed (crewflow_owner → SET LOCAL ROLE)
 *   containment (dry-run and --execute)  per-user suspension, audit (writes)    rab_secure_owner, READ ONLY: the five reads
 *   user-session:backfill --verify       count_user_session_backfill_status()   none
 *   user-session:backfill --dry-run      —                                      rab_secure_owner, READ ONLY: candidate scan
 *   user-session:backfill --apply        per-organisation ops audit row         rab_secure_owner: scan READ ONLY; per family
 *                                                                               READ WRITE: bind its own identity + INSERT
 *   hws:backfill (every mode)            discovery, reads, checkpoint, writes   none — the physical copy runs on the primary
 *                                        and the per-workspace ops audit row    (FORCE RLS-bound; proven, see runbook)
 *
 * "primary" is the owner login crewflow_owner (FORCE RLS and tenant context bind it as they bound crewflow_app), and the
 * narrowed session is the SAME login on its own one-connection pool, narrowed by `SET LOCAL ROLE` with these plans and
 * these frozen names. X2.2 added no statement and no plan: the NARROWED session gained nothing.
 * What does change (security review L2): the NON-narrowed command code (RefreshTokenService, SecurityVersionService,
 * AuditService, the HWS physical copy, the tenant-context writes) now runs as crewflow_owner instead of crewflow_app. That is
 * the privilege the API already runs with (PT-01), but a bug in these commands has the owner login's larger blast radius,
 * not the restricted login's. And these lists limit the COMMAND CODE, not the operator: whoever runs the one-off holds a
 * login that can `SET ROLE rab_secure_owner` directly (G-02).
 */
import { CONTAINMENT_READ_STATEMENTS } from '../containment/suspend-test-accounts';
import {
  USER_SESSION_BACKFILL_BIND_SQL,
  USER_SESSION_BACKFILL_CANDIDATES_SQL,
  USER_SESSION_BACKFILL_INSERT_SQL,
} from '../../engine/core-modules/auth/token/backfill/user-session-backfill.service';

export const OPS_STATEMENTS = Object.freeze({
  ...CONTAINMENT_READ_STATEMENTS,
  'user-session-backfill.candidates': USER_SESSION_BACKFILL_CANDIDATES_SQL,
  'user-session-backfill.bind-family': USER_SESSION_BACKFILL_BIND_SQL,
  'user-session-backfill.insert-family': USER_SESSION_BACKFILL_INSERT_SQL,
} as const);
export type OpsStatementName = keyof typeof OPS_STATEMENTS;

export interface OpsElevatedPlan {
  /** application_name suffix (crewflow-cli-<purpose>) and the name in every log line. */
  purpose: string;
  /** The narrow role the owner login SETs (LOCAL) for every narrowed transaction. */
  role: 'rab_secure_owner' | 'crewflow';
  /** Names allowed in a READ ONLY transaction. */
  readStatements: readonly OpsStatementName[];
  /** Names allowed in a READ WRITE transaction (empty: this plan never opens one). */
  writeStatements: readonly OpsStatementName[];
  /** Server statement_timeout and client query_timeout (ms; 0 = none). Default: the runtime timeouts. */
  statementTimeoutMs?: number;
}

const CONTAINMENT_READS = Object.keys(CONTAINMENT_READ_STATEMENTS) as Array<keyof typeof CONTAINMENT_READ_STATEMENTS>;

export const OPS_ELEVATED_PLANS = Object.freeze({
  containment: Object.freeze<OpsElevatedPlan>({
    purpose: 'containment-read',
    role: 'rab_secure_owner',
    readStatements: Object.freeze([...CONTAINMENT_READS]),
    writeStatements: Object.freeze([]),
  }),
  'user-session-scan': Object.freeze<OpsElevatedPlan>({
    purpose: 'session-backfill-scan',
    role: 'rab_secure_owner',
    readStatements: Object.freeze<OpsStatementName[]>(['user-session-backfill.candidates']),
    writeStatements: Object.freeze([]),
    statementTimeoutMs: 0,
  }),
  'user-session-apply': Object.freeze<OpsElevatedPlan>({
    purpose: 'session-backfill-apply',
    role: 'rab_secure_owner',
    readStatements: Object.freeze<OpsStatementName[]>(['user-session-backfill.candidates']),
    writeStatements: Object.freeze<OpsStatementName[]>(['user-session-backfill.bind-family', 'user-session-backfill.insert-family']),
    statementTimeoutMs: 0,
  }),
});
