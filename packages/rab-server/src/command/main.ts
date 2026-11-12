import 'dotenv/config';
import '../instrument';
// Declares the `cli` process role BEFORE the command module graph is imported, so the import-time environment validation
// resolves the database configuration as the CLI (not the default `api`). Keep it above command.module.
import './ops/declare-cli-process';

import { CommandFactory } from 'nest-commander';

import { resolvePgEnvironmentCached } from '../database/postgres/pg-config'; // Phase B (A1)
import { assertDbTarget } from '../database/typeorm/core/database-target';
import { cliCommandFromArgv, runDatabaseBootGates } from '../database/boot-checks/database-boot-gates'; // Phase B (A2)
import { assertOpsPlacement } from './ops/ops-run';
import { CommandModule } from './command.module';

async function bootstrap(): Promise<void> {
  const cliCommand = cliCommandFromArgv(process.argv);
  // ---- Phase X2.2: the three owner ops commands run only when PG_DATABASE_URL names the owner login crewflow_owner (no
  // legacy, libpq or replica variable); every other login is refused here, before any connection. Every command refuses the
  // retired rab-ops variables (CREWFLOW_OPS_*, PG_OPS_*). Declares the process role (`cli`). ----
  const processRole = assertOpsPlacement(cliCommand, process.env);
  // ---- Phase B (A1): declare the process (application_name `crewflow-cli`, pooler policy) before any DataSource exists,
  // and refuse a bad database configuration (pg-config.ts: PG_DATABASE_URL, legacy names, URL policy, TLS, the retired ops
  // variables) before anything connects. ----
  resolvePgEnvironmentCached(process.env, { processRole });
  // ---- end Phase B (A1) ----
  // Every CLI command (seed, bootstrap-admin, grant-platform-admin, storage-reconcile, ...) runs against an explicitly
  // resolved and probed target, or not at all. Fails before Nest boots, before any command body runs.
  await assertDbTarget('command');
  // ---- Phase B (A2): database boot gates — login per command, version, extensions, deployment identity, FORCE RLS, TLS,
  // pending migrations. Before Nest boots and before any command body runs. Gate 1 expects the owner login crewflow_owner
  // for every CLI command, the three ops commands on the owner-login path included (X2.2). ----
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
  const isOpsRefusal = error instanceof Error && error.name === 'OpsRunError'; // Phase X2.2 (ops commands)
  // eslint-disable-next-line no-console
  console.error(
    isGuardRefusal ? `[db-target] refused: ${message}` : isPgRefusal ? `[pg-config] refused: ${message}` : isOpsRefusal ? `[ops] refused: ${message}` : message,
  );
  process.exit(1);
});
