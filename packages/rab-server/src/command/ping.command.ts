import { Command, CommandRunner } from 'nest-commander';

/** Proves the nest-commander CLI wiring works. Real seed/backfill commands land alongside their modules. */
@Command({ name: 'ping', description: 'Verify the command CLI boots' })
export class PingCommand extends CommandRunner {
  async run(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('pong');
  }
}
