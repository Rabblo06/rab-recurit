/**
 * Phase B (B4/P5): validation of the optional read replica against the primary. SELECT-only on both sides.
 *
 * Outcome classes:
 *   ReplicaConfigurationError  the URL is WRONG, not just behind — refuse. At boot this refuses startup (owner rule: "if
 *                              the replica URL points at a writable primary, fail the configuration validation"); found
 *                              later (e.g. the standby was promoted), the replica is refused for the life of the process
 *                              and every read stays on the primary.
 *   { ok: false, reason }      transient: the replica is reachable and correctly configured but not yet consistent with
 *                              the primary (migration ledger behind, deployment marker not replayed yet). Reads stay on
 *                              the primary; the probe re-validates.
 *   { ok: true }               validated. Freshness is decided separately, per probe (replica-freshness.ts).
 *
 * Checks (owner list, plus the cluster identity):
 *   1. pg_is_in_recovery() = true on the replica                         else configuration error (writable primary)
 *   2. runtime role gates on the replica: current_user = session_user = crewflow_app, no SUPERUSER/BYPASSRLS, no
 *      owner-role membership (the same assertRoleGate the API boot uses); TLS in use in production (assertTlsGate)
 *   3. same database name, and the same cluster: pg_control_system().system_identifier equal on both (a physical
 *      standby reports its primary's identifier). Skipped with a warning only when the runtime role may not call the
 *      function on either side.
 *   4. FORCE ROW LEVEL SECURITY spot check on the replica (the same tables and rule as the boot gate)
 *   5. deployment identity marker (core.deployment_identity_check(), when the migration exists) equal on both. Both
 *      bound and different, or the replica bound while the primary is not → configuration error. Primary bound and the
 *      replica not yet → transient. Both absent/unbound (development) → accepted.
 *   6. migration ledger head equal on both                                else transient
 */
import {
  assertForceRlsGate,
  assertRoleGate,
  assertTlsGate,
  BOOT_FACTS_SQL,
  DatabaseBootGateError,
  FORCE_RLS_SPOT_CHECK_TABLES,
  FORCE_RLS_SQL,
  parseBootFacts,
  RLS_DISABLED_TENANT_TABLES_SQL,
  RUNTIME_ROLE,
} from '../../boot-checks/database-boot-gate-rules';
import { DeploymentIdentityError, DeploymentMarker, readDeploymentMarker } from '../../deployment-identity/deployment-identity';

export type ReplicaQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export class ReplicaConfigurationError extends Error {
  constructor(
    readonly check: 'recovery' | 'role' | 'tls' | 'cluster' | 'force-rls' | 'identity' | 'budget',
    message: string,
  ) {
    super(`PG_DATABASE_REPLICA_URL refused (${check}): ${message}`);
    this.name = 'ReplicaConfigurationError';
  }
}

export type ReplicaValidationResult = { ok: true; warnings: string[] } | { ok: false; reason: 'ledger-behind' | 'identity-not-replayed'; warnings: string[] };

export const IN_RECOVERY_SQL = 'SELECT pg_catalog.pg_is_in_recovery() AS in_recovery';
export const SYSTEM_IDENTIFIER_SQL = 'SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()';
export const LEDGER_HEAD_SQL = 'SELECT name FROM core.migrations ORDER BY "timestamp" DESC, id DESC LIMIT 1';

async function systemIdentifier(query: ReplicaQuery): Promise<string | null> {
  try {
    const [row] = await query(SYSTEM_IDENTIFIER_SQL);
    return row?.id ? String(row.id) : null;
  } catch (error) {
    if ((error as { code?: string })?.code === '42501') return null; // not permitted for this role: skipped, with a warning
    throw error;
  }
}

/**
 * A physical standby replays the primary's marker row, so every recorded field must be equal: environment, id AND the
 * bound location (database + host set). The location is compared as DATA only — the replica is reached through its own
 * host, which is deliberately never checked against bound_hosts (it is not a primary connection).
 */
function sameMarker(a: DeploymentMarker, b: DeploymentMarker): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'bound' && b.state === 'bound') {
    return (
      a.environment === b.environment &&
      a.deploymentId === b.deploymentId &&
      (a.boundDatabase ?? null) === (b.boundDatabase ?? null) &&
      JSON.stringify(a.boundHosts ?? null) === JSON.stringify(b.boundHosts ?? null)
    );
  }
  return true;
}

async function marker(query: ReplicaQuery, side: string): Promise<{ marker: DeploymentMarker; database: string }> {
  try {
    return await readDeploymentMarker(query);
  } catch (error) {
    if (error instanceof DeploymentIdentityError) throw new ReplicaConfigurationError('identity', `${side}: ${error.message}`);
    throw error;
  }
}

export interface ValidateReplicaInput {
  primary: ReplicaQuery;
  replica: ReplicaQuery;
  production: boolean;
}

export async function validateReplica(input: ValidateReplicaInput): Promise<ReplicaValidationResult> {
  const { primary, replica, production } = input;
  const warnings: string[] = [];

  // 1. A replica that accepts writes is not a replica.
  const [recovery] = await replica(IN_RECOVERY_SQL);
  if (recovery?.in_recovery !== true) {
    throw new ReplicaConfigurationError(
      'recovery',
      'the server is not in recovery (pg_is_in_recovery() = false): it is a writable primary, not a standby. Point PG_DATABASE_REPLICA_URL at a hot standby, or unset it.',
    );
  }

  // 2. Same runtime role rules as the primary.
  const [factsRow] = await replica(BOOT_FACTS_SQL);
  const facts = parseBootFacts(factsRow);
  try {
    assertRoleGate(facts, [RUNTIME_ROLE], 'replica connection');
    assertTlsGate(facts, production);
  } catch (error) {
    if (error instanceof DatabaseBootGateError) throw new ReplicaConfigurationError(error.message.includes('TLS') ? 'tls' : 'role', error.message);
    throw error;
  }

  // 3. Same database, same cluster.
  const [primaryDb] = await primary('SELECT pg_catalog.current_database()::text AS database');
  if (String(primaryDb?.database ?? '') !== facts.database) {
    throw new ReplicaConfigurationError('cluster', 'the replica serves a different database name than the primary.');
  }
  const [primaryId, replicaId] = [await systemIdentifier(primary), await systemIdentifier(replica)];
  if (primaryId === null || replicaId === null) {
    warnings.push('cluster identity not compared: pg_control_system() is not permitted for the runtime role.');
  } else if (primaryId !== replicaId) {
    throw new ReplicaConfigurationError('cluster', 'the replica belongs to a different PostgreSQL cluster than the primary (system_identifier differs).');
  }

  // 4. FORCE RLS posture on the replica itself.
  const forceRows = await replica(FORCE_RLS_SQL, [FORCE_RLS_SPOT_CHECK_TABLES]);
  const disabled = (await replica(RLS_DISABLED_TENANT_TABLES_SQL)).map((r) => String(r.relname));
  try {
    assertForceRlsGate(forceRows, disabled);
  } catch (error) {
    if (error instanceof DatabaseBootGateError) throw new ReplicaConfigurationError('force-rls', error.message);
    throw error;
  }

  // 5. Deployment identity.
  const p = (await marker(primary, 'primary')).marker;
  const r = (await marker(replica, 'replica')).marker;
  if (!sameMarker(p, r)) {
    if (p.state === 'bound' && r.state === 'bound') {
      throw new ReplicaConfigurationError('identity', 'the replica is bound to a different deployment identity than the primary.');
    }
    if (r.state === 'bound') {
      throw new ReplicaConfigurationError('identity', 'the replica carries a deployment identity the primary does not.');
    }
    return { ok: false, reason: 'identity-not-replayed', warnings };
  }

  // 6. Migration ledger head.
  const [primaryHead] = await primary(LEDGER_HEAD_SQL);
  const [replicaHead] = await replica(LEDGER_HEAD_SQL);
  if (String(primaryHead?.name ?? '') !== String(replicaHead?.name ?? '')) return { ok: false, reason: 'ledger-behind', warnings };

  return { ok: true, warnings };
}

/** Ledger heads only (the probe repeats this cheaply between full validations). */
export async function sameLedgerHead(primary: ReplicaQuery, replica: ReplicaQuery): Promise<boolean> {
  const [p] = await primary(LEDGER_HEAD_SQL);
  const [r] = await replica(LEDGER_HEAD_SQL);
  return String(p?.name ?? '') === String(r?.name ?? '');
}
