import type { Client } from 'pg';

import { checkSchemaCompatibility } from '@rab/server/database/boot-checks/database-boot-gates';
import { pgClientConfig, probePgSessionAffinity, ResolvedPgEnvironment } from '@rab/server/database/postgres/index';

import { ReconnectingPgClient } from '../../core/database/reconnecting-pg-client';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { runWorkspaceProvisioningCycle } from './workspace-provisioning.job';
import { runWorkspaceSchemaDriftCycle } from './workspace-schema-drift.job';

/**
 * The workspace provisioning and schema-drift loops, ONE implementation shared by:
 *   - the Worker jobs process (owner-login architecture, T4): provisioning runs IN-PROCESS on the one PG_DATABASE_URL
 *     owner login (crewflow_owner), with `actAsCrewflow` — every provisioning and drift session runs `SET ROLE crewflow`, so
 *     the workspace DDL, the registry/ledger writes and the provision guard see exactly the identity the separate
 *     provisioner always had (and M-T2's registry allow-list admits it);
 *   - the superseded separate provisioner process (workspace-provisioner.main.ts; unused, removed in the final clean-up PR),
 *     whose login already IS crewflow.
 *
 * Moved here UNCHANGED from workspace-provisioner.main.ts:
 *   - its own session-affine ReconnectingPgClient (never a pool connection: provisionWorkspaceSchema runs BEGIN/COMMIT
 *     pairs and holds a SESSION advisory lock), probed for session affinity first, reconnecting with bounded backoff;
 *   - the per-cycle provisioner-strict schema check (`checkSchemaCompatibility` with process 'provisioner': ledger ahead,
 *     a provision function that is not this code's module, a READY workspace above this code — all skip the cycle);
 *   - the bounded provisioning advisory lock with `shouldAbort` (abandoned at once when shutdown begins; a busy lock skips
 *     the tick, recorded as idle, never stamped);
 *   - the daily alert-only drift loop on its own short-lived connection;
 *   - the durable CREATING / FAILED / READY ledger and readiness states and `createFor` semantics, which live in
 *     runWorkspaceProvisioningCycle / provisionWorkspaceSchema and are not touched.
 */
export const WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROVISIONING_ROLE = 'crewflow';

export class ProvisioningIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningIdentityError';
  }
}

/**
 * Owner-login architecture: the provisioning session acts as `crewflow` (the schema-template owner), via `SET ROLE` on its
 * own dedicated, non-pooled connection. Already crewflow, or the bootstrap superuser (tests, local setup): unchanged. A
 * login that cannot SET crewflow is refused — provisioning would otherwise fail later, half-way through a workspace.
 *
 * SECURITY TRADE-OFF (owner-login, recorded for review): a session-level `SET ROLE` can be undone by `RESET ROLE` on the
 * same session. This connection executes only this module's fixed statements (no request input ever reaches it), it is
 * never returned to a pool, and the role is re-asserted on every reconnect. The owner login could act as crewflow anyway
 * (it holds SET on it, M0 §3.1); this narrows what the provisioning session can do, it is not a privilege boundary.
 */
export async function actAsProvisioningRole(client: Pick<Client, 'query'>): Promise<'unchanged' | 'set-role'> {
  const { rows } = await client.query<{ who: string; superuser: boolean; can_set: boolean }>(
    // sql-injection-reviewed: PROVISIONING_ROLE is the module constant 'crewflow'; no request or row data reaches this statement.
    `SELECT current_user::text AS who,
            coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) AS superuser,
            EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${PROVISIONING_ROLE}')
              AND pg_catalog.pg_has_role(current_user, '${PROVISIONING_ROLE}', 'SET') AS can_set`,
  );
  const me = rows[0];
  if (!me) throw new ProvisioningIdentityError('workspace provisioning: the session identity could not be read.');
  if (me.who === PROVISIONING_ROLE || me.superuser) return 'unchanged';
  if (!me.can_set) {
    throw new ProvisioningIdentityError(
      `workspace provisioning refuses the login "${me.who}": it cannot act as ${PROVISIONING_ROLE} (the schema-template owner). The owner login needs SET on ${PROVISIONING_ROLE} (M0 §3.1).`,
    );
  }
  // sql-injection-reviewed: PROVISIONING_ROLE is the module constant 'crewflow', never input (SET ROLE takes no $n parameter).
  await client.query(`SET ROLE ${PROVISIONING_ROLE}`);
  const { rows: after } = await client.query<{ who: string }>('SELECT current_user::text AS who');
  if (after[0]?.who !== PROVISIONING_ROLE) throw new ProvisioningIdentityError(`workspace provisioning: SET ROLE ${PROVISIONING_ROLE} did not take effect.`);
  return 'set-role';
}

export interface ProvisioningLoopsLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ProvisioningLoopsOptions {
  pg: ResolvedPgEnvironment;
  endpoint: 'primary' | 'elevated';
  runtime: WorkerRuntime;
  logger: ProvisioningLoopsLogger;
  intervalMs: number;
  /** The migration list the per-cycle schema check compares with the ledger (the boot gates' list). */
  expectedMigrations: readonly string[];
  production: boolean;
  /** Owner login: SET ROLE crewflow on every provisioning and drift session. */
  actAsCrewflow: boolean;
  driftIntervalMs?: number;
}

export interface WorkspaceProvisioningLoopsHandle {
  close(): Promise<void>;
}

export async function startWorkspaceProvisioningLoops(options: ProvisioningLoopsOptions): Promise<WorkspaceProvisioningLoopsHandle> {
  const { pg, endpoint, runtime, logger } = options;
  const onConnect = options.actAsCrewflow ? async (client: Client) => void (await actAsProvisioningRole(client)) : undefined;
  // No statement or query timeout on the provisioning client (workspace DDL can run long); the drift check keeps its own 60 s.
  const provisioningConfig = pgClientConfig(pg, { endpoint, purpose: 'provisioning', sessionAffinity: true, statementTimeoutMs: 0, queryTimeoutMs: 0 });
  const driftConfig = pgClientConfig(pg, { endpoint, purpose: 'drift', sessionAffinity: true, statementTimeoutMs: 60_000 });
  // Security review L-3: the provisioning lock is a SESSION advisory lock held across BEGIN/COMMIT pairs, so the connection
  // must be session-stable: the live two-connection probe, before the first connection and cycle.
  await probePgSessionAffinity(pgClientConfig(pg, { endpoint, purpose: 'probe', sessionAffinity: true, statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }), {
    label: 'the provisioner session-lock connection',
  });
  // W6-E2E-05: survives a database restart / failover / idle kill (bounded exponential backoff); the first connection
  // (and, under the owner login, its SET ROLE) must succeed at start-up.
  const provisioning = new ReconnectingPgClient(provisioningConfig, { label: 'provisioning', logger, initialBackoffMs: 1_000, maxBackoffMs: 30_000, onConnect });
  await provisioning.acquire();

  // Phase B: a release can migrate the database while this (older) code keeps running. Before every cycle the ledger and the
  // provision function are re-assessed; an incompatible database skips the cycle and is logged once per change.
  let lastCompatibilityRefusal: string | null = null;
  const compatibleForThisCycle = async (): Promise<boolean> => {
    const client = await provisioning.acquire();
    try {
      await checkSchemaCompatibility(async (sql, params) => (await client.query(sql, params as unknown[])).rows, {
        process: 'provisioner',
        production: options.production,
        expected: [...options.expectedMigrations],
        label: 'provisioner process',
      });
      if (lastCompatibilityRefusal !== null) logger.log('workspace provisioning: the database is compatible with this image again; provisioning resumes');
      lastCompatibilityRefusal = null;
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'SchemaCompatibilityError') {
        if (error.message !== lastCompatibilityRefusal) logger.error(`workspace provisioning: skipped, ${error.message}`);
        lastCompatibilityRefusal = error.message;
        return false;
      }
      throw error;
    }
  };

  runtime.every({
    name: 'workspace provisioning',
    intervalMs: options.intervalMs,
    statKeys: { lastRunAt: 'lastWorkspaceProvisioningAt', failures: 'workspaceProvisioningFailures' },
    run: async () => {
      if (!(await compatibleForThisCycle())) return false;
      const result = await runWorkspaceProvisioningCycle(await provisioning.acquire(), undefined, { shouldAbort: () => runtime.isShuttingDown });
      if (!result.lockAcquired) {
        logger.log('workspace provisioning: skipped — another provisioner held the provisioning lock for the whole bounded wait');
        return false;
      }
      if (result.attempted) logger.log(`workspace provisioning: attempted=${result.attempted} ready=${result.ready} failed=${result.failed}`);
      return true;
    },
  });

  runtime.every({
    name: 'workspace schema drift',
    intervalMs: options.driftIntervalMs ?? WORKSPACE_SCHEMA_DRIFT_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastWorkspaceSchemaDriftAt', failures: 'workspaceSchemaDriftFailures' },
    run: async () => {
      const drift = await runWorkspaceSchemaDriftCycle(driftConfig, onConnect);
      for (const f of drift.findings) {
        logger.warn(`workspace schema drift: workspace=${f.workspaceId} status=${f.status} module=${f.moduleVersion ?? '?'} ${f.detail}`);
      }
      logger.log(`workspace schema drift: checked=${drift.checked} ok=${drift.ok} notReady=${drift.notReady} findings=${drift.findings.length}`);
    },
  });

  return { close: () => provisioning.close() };
}
