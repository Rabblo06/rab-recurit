import 'dotenv/config';
import '../instrument';
// Phase B (ops): declares `ops` (one-off operations container) or `cli` BEFORE the command module graph is imported, so the
// import-time environment validation resolves the database configuration as the right process. Keep it above command.module.
import './ops/declare-cli-process';

import { CommandFactory } from 'nest-commander';

import { resolvePgEnvironmentCached } from '../database/postgres/pg-config'; // Phase B (A1)
import { assertDbTarget } from '../database/typeorm/core/database-target';
import { cliCommandFromArgv, runDatabaseBootGates } from '../database/boot-checks/database-boot-gates'; // Phase B (A2)
import { assertOpsPlacement } from './ops/ops-run';
import { CommandModule } from './command.module';

async function bootstrap(): Promise<void> {
  const cliCommand = cliCommandFromArgv(process.argv);
  // ---- Phase B (ops): the three owner commands run ONLY in the one-off operations container (CREWFLOW_OPS_RUN=one-off),
  // and that container runs ONLY them. Declares the process role (`ops` or `cli`). ----
  const processRole = assertOpsPlacement(cliCommand, process.env);
  // ---- Phase B (A1): declare the process (application_name `crewflow-cli` / `crewflow-ops`, pooler policy) before any
  // DataSource exists, and refuse a bad database configuration (pg-config.ts: PG_DATABASE_URL, legacy names, URL policy, TLS,
  // the ops variables) before anything connects. ----
  resolvePgEnvironmentCached(process.env, { processRole });
  // ---- end Phase B (A1) ----
  // Every CLI command (seed, bootstrap-admin, grant-platform-admin, storage-reconcile, ...) runs against an explicitly
  // resolved and probed target, or not at all. Fails before Nest boots, before any command body runs. In the ops container
  // the primary is PG_OPS_APP_DATABASE_URL (crewflow_app) and the elevated endpoint PG_DATABASE_URL (migration identity):
  // both are probed and must name the same database and cluster.
  await assertDbTarget('command');
  // ---- Phase B (A2): database boot gates — login per command, version, extensions, deployment identity, FORCE RLS, TLS,
  // pending migrations. Before Nest boots and before any command body runs. In the ops container the gate connects to the
  // primary, i.e. the restricted crewflow_app login (the ops commands are not in CLI_COMMAND_ROLES). ----
  await runDatabaseBootGates('cli', { cliCommand });
  // ---- end Phase B (A2) ----
  await CommandFactory.run(CommandModule, {
    logger: ['error', 'warn'],
    // Fail closed (foundation fix P2, 2026-10-22): nest-commander's default handler only PRINTS an error thrown by a
    // command's run() and the process still exits 0 — a failed bootstrap-admin looked like a success to start.sh
    // (`set -e`) and to any operator script. Any command failure now exits non-zero. Only the message is printed.
    serviceErrorHandler: (error: Error) => {
      // eslint-disable-next-line no-console
      console.error(error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>'));
      process.exitCode = 1;
    },
  });
}

bootstrap().catch((error: unknown) => {
  // Guard refusals carry no URL or credential by construction, so their message is safe to print.
  const message = error instanceof Error ? error.message : 'unknown error';
  const isGuardRefusal = error instanceof Error && (error.name === 'DbTargetError' || error.name === 'DatabaseBootGateError'); // Phase B (A2)
  const isPgRefusal = error instanceof Error && error.name === 'PgConfigError'; // Phase B (A1)
  const isOpsRefusal = error instanceof Error && error.name === 'OpsRunError'; // Phase B (ops)
  // eslint-disable-next-line no-console
  console.error(
    isGuardRefusal ? `[db-target] refused: ${message}` : isPgRefusal ? `[pg-config] refused: ${message}` : isOpsRefusal ? `[ops] refused: ${message}` : message,
  );
  process.exit(1);
});
