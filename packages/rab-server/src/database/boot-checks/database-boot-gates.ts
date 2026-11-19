/**
 * Phase B (P7 boot checks + B3 identity): ONE read-only database posture gate run by every long-running process and the CLI
 * before it serves a request, consumes a job or runs a command body.
 *
 *   API        packages/rab-server/src/main.ts           runDatabaseBootGates('api')
 *   Worker     packages/rab-worker/src/main.ts (jobs)    runDatabaseBootGates('worker')
 *   CLI        packages/rab-server/src/command/main.ts   runDatabaseBootGates('cli', { cliCommand: <argv command> })
 *   Provisioner runDatabaseBootGates('provisioner') — the role the separate provisioner process used (that process,
 *              workspace-provisioner.main.ts, was removed in X5.1; the role and its guards stay until the legacy names go)
 *
 * Gates, in order (each refusal names the gate and an action, never a URL, user name or password):
 *   1. role      (owner-login architecture, owner's final decision 2026-11-04) current_user AND session_user are the owner
 *                login `crewflow_owner` for EVERY process, CLI command and WORKER_CLAIM_MODE — a code constant, never env; a
 *                legacy schema-role login (crewflow_app, crewflow_worker, crewflow) is refused; the login is not SUPERUSER,
 *                BYPASSRLS, REPLICATION or CREATEDB and not a member of crewflow_worker. After gate 2: a MEMBER-semantics
 *                walk (INHERIT, SET and ADMIN-only edges, indirect, predefined and provider-admin roles) reaches nothing
 *                SUPERUSER / BYPASSRLS / CREATEDB / CREATEROLE / REPLICATION or dangerous, in production the login does not own
 *                the current database (directly, through a role, or as pg_database_owner), and the role layout is exactly the reviewed
 *                owner-login inventory (owner-login-posture.ts). Membership of the owner roles is expected (catalogue BC-01).
 *   2. version   the server major is one of database/postgres/supported-majors.ts (16, 17, 18): below 16 the PG16
 *                role-membership semantics are missing, above 18 no reviewed workspace fingerprints / goldens exist.
 *                After the gates pass, the workspace fingerprints of that major are selected for this process.
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
 *                Or, whatever pg_stat_ssl says (a TLS-terminating proxy): the gate session's own client socket is TLS
 *                that Node verified (chain + host name) under a verify-full config (database-boot-gate-rules.ts assertTlsGate).
 *   7. pending / schema-compatibility   no pending migrations, and the schema is compatible with this process
 *                (assert-no-pending-migrations.ts → schema-compatibility.ts, same rule as the API prestart): unknown ledger
 *                names interleaved with the code's refuse everywhere; a ledger AHEAD (image rollback) warns for
 *                API/Worker/CLI and refuses the provisioner; the core.provision_workspace body is checked against the code's
 *                workspace module (API/Worker: unknown refuses in production, behind refuses, ahead warns; provisioner:
 *                anything but equal refuses) and the provisioner also refuses a READY workspace above its module.
 *                OWNER-DB-ULTIMATE Part B3: no relaxation: any pending migration refuses every process (the C3
 *                CREWFLOW_UPGRADE_INCOMPLETE / partly-upgraded-Worker path is retired).
 *   1c. dispatch-notify  (Phase D wave 3) no PERSISTENT crewflow.dispatch_notify in pg_db_role_setting (this database or
 *                all; every role or a role the login is a member of), and the gate session's own value is 'on' for an
 *                event-mode API/Worker (its startup option) and absent for every other process/mode. Runs after gate 1.
 *   objects      (after gate 7) FORCE on every core tenant table, the 16 pre-auth tables (M-T1, each with its exact
 *                owner-only definer policy) and the deployment-identity tables; expected ownership; nothing unexpected owned
 *                by the login or the owner roles in core / public / other schemas (owner-login-posture.ts).
 *   8. grants    (Phase D) the Worker can EXECUTE the due-work functions and, in global mode, the dispatch-claim functions.
 *                A non-Worker process CAN execute the dispatch-claim functions with one login: recorded as a boot WARNING
 *                on every start (BC-08, DBA-01 lost — accepted by the owner 2026-11-05), not a refusal.
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
import { isVerifyFullSsl, type PgSsl } from '../postgres/pg-tls';
import { selectWorkspaceFingerprintMajor, UnsupportedPostgresVersionError } from '../typeorm/workspace-schema/v1/expected-fingerprints';
import { coreDataSourceOptions } from '../typeorm/core/core.datasource';
import {
  BootGateReport,
  BootProcess,
  ClientTlsState,
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
 * Gate 6's client-side evidence: what the gate session's own pg socket reports after the handshake (a TLSSocket that Node
 * verified: chain and host name), and whether the connection's `ssl` config demanded that verification (pg-tls.ts: verify-full
 * is `rejectUnauthorized: true` with Node's default host-name check, or the IP-bound one). `session` is TypeORM's query runner
 * (`databaseConnection` is the pg Client once connected), or a pg Client itself. Anything unexpected reads as null (unknown),
 * which gate 6 treats as "not verified".
 */
export function clientTlsOf(session: unknown, ssl: PgSsl): ClientTlsState | null {
  type Stream = { encrypted?: unknown; authorized?: unknown };
  const s = session as { databaseConnection?: { connection?: { stream?: Stream } }; connection?: { stream?: Stream } } | null;
  const stream = s?.databaseConnection?.connection?.stream ?? s?.connection?.stream;
  if (!stream) return null;
  return { encrypted: stream.encrypted === true, authorized: stream.authorized === true, verifyFullConfigured: isVerifyFullSsl(ssl) };
}

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
        { endpoint, purpose: 'boot-gates', max: 1, pinnedSearchPath: true },
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
          clientTls: clientTlsOf(session, endpointTarget.ssl),
          // Review L-1: the TLS gate is production when EITHER classifier says so (the process's, or the connection factory's).
          connectionProduction: pg.production,
          query,
          checkPendingMigrations: async ({ production }) => {
            return checkSchemaCompatibility(query, {
              process: processName,
              production,
              expected: expectedMigrations,
              label,
              workspaces: processName === 'provisioner',
            });
          },
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

  // PG17/18 fix: the workspace fingerprints of THIS server's major for the rest of the process (the Worker's in-process
  // provisioner and drift loop, the CLI, anything that reads EXPECTED_WORKSPACE_FINGERPRINTS / declaredFingerprint). Before
  // this, every API / Worker / CLI process kept the PostgreSQL 16 table on 17 and 18, so the Worker's provisioner refused
  // every workspace it built (fingerprint mismatch, workspace FAILED) and the drift job reported READY module 14-20 ones as
  // DRIFTED. Gate 2 already refused any other major; a process that selected another major before is refused here (never a
  // silent switch).
  try {
    selectWorkspaceFingerprintMajor(Math.floor(report.serverVersionNum / 10000));
  } catch (error) {
    if (error instanceof UnsupportedPostgresVersionError) throw new DatabaseBootGateError('version', `${label}: ${error.message}`);
    throw error;
  }

  for (const w of report.warnings) log(`[db-boot-gates] WARNING ${label}: ${w}`);
  log(
    `[db-boot-gates] process=${processName}${options.cliCommand ? ` command=${options.cliCommand}` : ''} source=${endpointTarget.source} role=${report.role} ` +
      `server=${report.serverVersionNum} database=${report.database} identity=${report.identity} tls=${report.tls === true ? 'on' : 'off'} ` +
      `force-rls=ok(${report.forceRlsTables}) extensions=ok pending=0 schema=compatible` +
      `${report.claimMode ? ` claim-mode=${report.claimMode}` : ''} due-work-exec=${report.grants.dueWork} dispatch-claim-exec=${report.grants.dispatchClaims} dispatch-notify=${report.dispatchNotify} gates=ok`,
  );
  return report;
}
