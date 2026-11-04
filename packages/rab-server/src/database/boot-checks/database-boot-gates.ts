/**
 * Phase B (P7 boot checks + B3 identity): ONE read-only database posture gate run by every long-running process and the CLI
 * before it serves a request, consumes a job or runs a command body.
 *
 *   API        packages/rab-server/src/main.ts           runDatabaseBootGates('api')
 *   Worker     packages/rab-worker/src/main.ts (jobs)    runDatabaseBootGates('worker')
 *   CLI        packages/rab-server/src/command/main.ts   runDatabaseBootGates('cli', { cliCommand: <argv command> })
 *   Provisioner packages/rab-worker/src/workspace-provisioner.main.ts  runDatabaseBootGates('provisioner') — on its
 *              privileged provisioning connection (the elevated endpoint when one is configured), expecting `crewflow`
 *
 * Gates, in order (each refusal names the gate and an action, never a URL, user name or password):
 *   1. role      (owner-login architecture, owner's final decision 2026-11-04) current_user AND session_user are the owner
 *                login `crewflow_owner` for EVERY process, CLI command and WORKER_CLAIM_MODE — a code constant, never env; a
 *                legacy schema-role login (crewflow_app, crewflow_worker, crewflow) is refused; the login is not SUPERUSER,
 *                BYPASSRLS, REPLICATION or CREATEDB and not a member of crewflow_worker. After gate 2: a MEMBER-semantics
 *                walk (INHERIT, SET and ADMIN-only edges, indirect, predefined and provider-admin roles) reaches nothing
 *                SUPERUSER / BYPASSRLS / CREATEDB / REPLICATION or dangerous, and the role layout is exactly the reviewed
 *                owner-login inventory (owner-login-posture.ts). Membership of the owner roles is expected (catalogue BC-01).
 *   2. version   server_version_num >= 160000 (PostgreSQL 16; PG16 role-membership semantics are relied on).
 *   3. extensions  the extensions the migrations create are installed: btree_gist, citext, pg_trgm, pgcrypto, unaccent.
 *                (uuid-ossp is NOT required: no column default uses it — verified on a migrations-only database.)
 *   4. identity  the deployment identity marker (deployment-identity.ts): declared env vs the protected marker, and
 *                PG_EXPECTED_DATABASE_NAME when set. A bound marker must also have been bound in THIS database, and THIS
 *                connection host must be one of its bound hosts (owner decision A + host-binding review: 1 to 5 host
 *                names), else it is a restore / clone / fork that needs the audited rebind. Production: marker bound, environment=production, ids equal.
 *                Outside production: marker absent/unbound and nothing declared -> allowed with a warning; declared -> must
 *                match; a production-bound database is always refused.
 *   5. force-rls FORCE ROW LEVEL SECURITY spot check on a fixed set of tenant tables, and every core table with an
 *                organisation_id has RLS enabled. (The exhaustive model stays in CI: check-rls-coverage + the posture golden.)
 *   6. tls       in production the gate's own backend must be on TLS (pg_stat_ssl.ssl for pg_backend_pid()).
 *   7. pending / schema-compatibility   no pending migrations, and the schema is compatible with this process
 *                (assert-no-pending-migrations.ts → schema-compatibility.ts, same rule as the API prestart): unknown ledger
 *                names interleaved with the code's refuse everywhere; a ledger AHEAD (image rollback) warns for
 *                API/Worker/CLI and refuses the provisioner; the core.provision_workspace body is checked against the code's
 *                workspace module (API/Worker: unknown refuses in production, behind refuses, ahead warns; provisioner:
 *                anything but equal refuses) and the provisioner also refuses a READY workspace above its module.
 *   1c. dispatch-notify  (Phase D wave 3) no PERSISTENT crewflow.dispatch_notify in pg_db_role_setting (this database or
 *                all; every role or a role the login is a member of), and the gate session's own value is 'on' for an
 *                event-mode API/Worker (its startup option) and absent for every other process/mode. Runs after gate 1.
 *   objects      (after gate 7) FORCE on every core tenant table, the 16 pre-auth tables (M-T1, each with its exact
 *                owner-only definer policy) and the deployment-identity tables; expected ownership; nothing unexpected owned
 *                by the login or the owner roles in core / public / other schemas (owner-login-posture.ts).
 *   8. grants    (Phase D) the Worker can EXECUTE the due-work functions and, in global mode, the dispatch-claim functions.
 *                A non-Worker process CAN execute the dispatch-claim functions with one login: recorded as a boot WARNING
 *                on every start (BC-08, DBA-01 lost — PENDING OWNER APPROVAL), not a refusal.
 *
 * Connection: a short-lived DataSource from the connection factory (src/database/postgres: createPgDataSource for the
 * process's primary endpoint (the provisioner: its privileged endpoint), one session, the process's own role, pool max 1, application_name `crewflow-<process>-boot-gates`), so
 * the URL policy, TLS and timeouts are the runtime's own; the migrations list and ledger name are coreDataSourceOptions'.
 * Nothing here reads a URL variable. When the database is unreachable the whole
 * gate run is retried with bounded exponential backoff (default 10 attempts, 1 s doubling to 15 s, ~1.5 min) and then
 * fails; a gate DECISION is never retried. Everything here is SELECT-only.
 */
import { DataSourceOptions } from 'typeorm';

import { createPgDataSource, PgConfigError, resolvePgEnvironmentCached } from '../postgres';
import { coreDataSourceOptions } from '../typeorm/core/core.datasource';
import {
  BootGateReport,
  BootProcess,
  DatabaseBootGateError,
  evaluateBootGates,
  isProductionProcess,
  RetryOptions,
  withDatabaseRetry,
} from './database-boot-gate-rules';
import { checkSchemaCompatibility } from './schema-compatibility';
import { assertSemanticPostureAtBoot, SemanticPostureError } from '../posture-drift/semantic-posture-monitor';
import type { SemanticPosture } from '../posture-drift/semantic-posture';

export * from './database-boot-gate-rules';
export * from './schema-compatibility';

// ------------------------------------------------------------------------------------------------ real entrypoint

export interface RunBootGatesOptions {
  env?: Record<string, string | undefined>;
  /**
   * The environment the factory resolves the gate's connection from (default: `env`, i.e. the process environment).
   * A test seam: it lets a spec point the gate at a test database while the gate DECISIONS read `env`.
   */
  connectionEnv?: Record<string, string | undefined>;
  /** Migrations the pending-migration gate compares with the ledger (default: coreDataSourceOptions.migrations). */
  migrations?: DataSourceOptions['migrations'];
  cliCommand?: string;
  /**
   * Which of the process's endpoints the gate connects to (default: 'primary'; the provisioner: its privileged
   * provisioning endpoint — 'elevated' when one is configured, else 'primary').
   */
  endpoint?: 'primary' | 'elevated';
  retry?: RetryOptions;
  log?: (line: string) => void;
}

let gateDataSourceSeq = 0;

/**
 * The single call each entrypoint makes. Throws DatabaseBootGateError (the caller prints the message and exits non-zero).
 * On success logs one sanitised line plus any warnings.
 */
export async function runDatabaseBootGates(processName: BootProcess, options: RunBootGatesOptions = {}): Promise<BootGateReport> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line)); // eslint-disable-line no-console
  const label = processName === 'cli' ? `CLI command "${options.cliCommand ?? '(none)'}"` : `${processName} process`;
  // The process's own connection, exactly as its pools resolve it. A refused configuration is a decision, not a retry.
  let pg: ReturnType<typeof resolvePgEnvironmentCached>;
  try {
    pg = resolvePgEnvironmentCached(options.connectionEnv ?? env, { processRole: processName });
  } catch (error) {
    if (error instanceof PgConfigError) throw new DatabaseBootGateError('connect', `${label}: ${error.message}`);
    throw error;
  }
  const endpoint = options.endpoint ?? (processName === 'provisioner' && pg.elevated ? 'elevated' : 'primary');
  const endpointTarget = endpoint === 'elevated' ? pg.elevated : pg.primary;
  if (!endpointTarget) throw new DatabaseBootGateError('connect', `${label}: the ${endpoint} database endpoint is not configured.`);

  const report = await withDatabaseRetry(
    label,
    async () => {
      gateDataSourceSeq += 1;
      const dataSource = createPgDataSource(
        pg,
        { endpoint, purpose: 'boot-gates', max: 1 },
        {
          name: `db-boot-gates-${processName}-${gateDataSourceSeq}`,
          entities: [],
          subscribers: [],
          logging: false,
          migrations: options.migrations ?? coreDataSourceOptions.migrations,
          migrationsTableName: coreDataSourceOptions.migrationsTableName,
          migrationsTransactionMode: coreDataSourceOptions.migrationsTransactionMode,
        },
      );
      await dataSource.initialize();
      // ONE session for every gate query: the provisioner's workspace scan binds its organisation per short transaction.
      const session = dataSource.createQueryRunner();
      try {
        await session.connect();
        const query = (sql: string, params?: unknown[]) => session.query(sql, params) as Promise<Array<Record<string, unknown>>>;
        const expectedMigrations = dataSource.migrations.map((m) => m.name ?? m.constructor.name);
        const gateReport = await evaluateBootGates({
          processName,
          env,
          cliCommand: options.cliCommand,
          connectionHost: endpointTarget.target.host,
          query,
          checkPendingMigrations: ({ production }) =>
            checkSchemaCompatibility(query, {
              process: processName,
              production,
              expected: expectedMigrations,
              label,
              workspaces: processName === 'provisioner',
            }),
        });
        // Semantic posture (M0 §6.4 control 4): the database's security objects equal the reviewed golden for this major.
        // Production refuses when no golden exists for the major; elsewhere that is a warning. The snapshot is the
        // baseline for the posture monitor (SemanticPostureMonitor, started by the API / Worker after boot).
        let semantic: { posture: SemanticPosture; warnings: string[] };
        try {
          semantic = await assertSemanticPostureAtBoot(query, { production: isProductionProcess(processName, env), label });
        } catch (error) {
          if (error instanceof SemanticPostureError) throw new DatabaseBootGateError('semantic-posture', error.message);
          throw error;
        }
        return { ...gateReport, warnings: [...gateReport.warnings, ...semantic.warnings], expectedMigrations, semanticBaseline: semantic.posture };
      } finally {
        await session.release().catch(() => undefined);
        await dataSource.destroy().catch(() => undefined);
      }
    },
    { log, ...options.retry },
  );

  for (const w of report.warnings) log(`[db-boot-gates] WARNING ${label}: ${w}`);
  log(
    `[db-boot-gates] process=${processName}${options.cliCommand ? ` command=${options.cliCommand}` : ''} role=${report.role} ` +
      `server=${report.serverVersionNum} database=${report.database} identity=${report.identity} tls=${report.tls === true ? 'on' : 'off'} ` +
      `force-rls=ok(${report.forceRlsTables}) extensions=ok pending=0 schema=compatible` +
      `${report.claimMode ? ` claim-mode=${report.claimMode}` : ''} due-work-exec=${report.grants.dueWork} dispatch-claim-exec=${report.grants.dispatchClaims} dispatch-notify=${report.dispatchNotify} gates=ok`,
  );
  return report;
}
