/**
 * A container's main process is PID 1, and the kernel gives PID 1 NO default
 * action for SIGTERM: until the process installs a handler the signal is
 * silently ignored. Both entry points install their real graceful-shutdown
 * handlers only at the END of a multi-second bootstrap (Nest DI, migrations
 * check, DB/Redis connections), so a deploy that stops a container mid-boot
 * would otherwise hang until the orchestrator's SIGKILL deadline.
 *
 * This guard closes that window: from the first line of `bootstrap()` a
 * SIGTERM/SIGINT exits promptly. Nothing is in flight that early (no request
 * accepted, no job cycle started), so exiting straight away is safe — open
 * connections die with the process and session advisory locks release with them.
 *
 * Call the returned `release()` once the process's real shutdown handling is
 * in place.
 */
export function installBootSignalGuard(processName: string): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    // eslint-disable-next-line no-console
    console.log(`${processName} received ${signal} while starting up — exiting before it finished booting`);
    process.exit(0);
  };
  const onTerm = (): void => onSignal('SIGTERM');
  const onInt = (): void => onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}
