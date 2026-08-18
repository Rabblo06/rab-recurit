import 'dotenv/config';
import '../instrument';

import { CommandFactory } from 'nest-commander';

import { CommandModule } from './command.module';

async function bootstrap(): Promise<void> {
  await CommandFactory.run(CommandModule, { logger: ['error', 'warn'] });
}

bootstrap();
