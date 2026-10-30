/**
 * Phase B (ops container): the FROZEN statement list of the elevated ops session, and the plan per command + mode.
 *
 * The elevated session (elevated-ops-session.ts) accepts statement NAMES from this registry only — never SQL text — and a
 * plan allows only the names it lists for a READ ONLY or a READ WRITE transaction. Adding a statement or widening a plan
 * is a reviewed code change to this file; nothing else can make the migration identity run SQL in the ops container.
 *
 * Minimum effective role per command (the runbook's ops section has the same table):
 *
 *   command / mode                       primary (crewflow_app)                 elevated (migration identity, SET LOCAL ROLE)
 *   containment (dry-run and --execute)  per-user suspension, audit (writes)    rab_secure_owner, READ ONLY: the five reads
 *   user-session:backfill --verify       count_user_session_backfill_status()   none (PG_DATABASE_URL refused)
 *   user-session:backfill --dry-run      —                                      rab_secure_owner, READ ONLY: candidate scan
 *   user-session:backfill --apply        per-organisation ops audit row         rab_secure_owner: scan READ ONLY; per family
 *                                                                               READ WRITE: bind its own identity + INSERT
 *   hws:backfill (every mode)            discovery, reads, checkpoint, writes   none (PG_DATABASE_URL refused) — the physical
 *                                        and the per-workspace ops audit row    copy runs as crewflow_app (proven, see runbook)
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
  /** application_name suffix (crewflow-ops-<purpose>) and the name in every log line. */
  purpose: string;
  /** The narrow role the migration identity SETs (LOCAL) for every elevated transaction. */
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
