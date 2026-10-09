import 'dotenv/config';
import '../instrument';

import { CommandFactory } from 'nest-commander';

import { assertDbTarget } from '../database/typeorm/core/database-target';
import { CommandModule } from './command.module';

async function bootstrap(): Promise<void> {
  // Every CLI command (seed, bootstrap-admin, grant-platform-admin, storage-reconcile, ...) runs against an explicitly
  // resolved and probed target, or not at all. Fails before Nest boots, before any command body runs.
  await assertDbTarget('command');
  await CommandFactory.run(CommandModule, { logger: ['error', 'warn'] });
}

bootstrap().catch((error: unknown) => {
  // Guard refusals carry no URL or credential by construction, so their message is safe to print.
  const message = error instanceof Error ? error.message : 'unknown error';
  const isGuardRefusal = error instanceof Error && error.name === 'DbTargetError';
  // eslint-disable-next-line no-console
  console.error(isGuardRefusal ? `[db-target] refused: ${message}` : message);
  process.exit(1);
});
