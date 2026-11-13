/**
 * `node packages/rab-server/dist/command <command> ...`: the directory entry of the CLI. `upgrade [--force]`
 * (OWNER-DB-ULTIMATE Part B3) runs WITHOUT dotenv and without the Nest command graph, exactly like the migrate-on-start
 * child it reuses (its own gates run inside the locked run); every other command is the Nest CLI (./main).
 */
if (process.argv[2] === 'upgrade') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runUpgradeCommand } = require('./upgrade.command') as typeof import('./upgrade.command');
  runUpgradeCommand(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      console.error(`[upgrade] FAILED: ${message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`); // eslint-disable-line no-console
      process.exit(66);
    },
  );
} else {
  require('./main');
}
