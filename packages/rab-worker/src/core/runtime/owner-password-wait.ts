/**
 * DB-SETUP, the Twenty Helm model (OWNER-DB-FINAL.md Part A): the crewflow_owner password is a random value stored by the
 * one-shot db-setup service in its password file (read-only for the Worker); APP_SECRET plays no part. The Worker may start
 * (OpenShip drops the depends_on conditions) while db-setup is still storing or (A4, a lost file) resetting that password:
 * its first login then fails with SQLSTATE 28P01. This wait retries exactly that failure, logging one fixed message, with a
 * bounded backoff, for at most OWNER_PASSWORD_WAIT_MAX_MS in total. A 28P01 that outlasts the bound exits the process
 * non-zero with OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE; every other error is rethrown unchanged at once (the caller refuses to
 * start, as before). It only wraps the first connection: every boot gate after it still runs. Prints no value: no URL,
 * password, host or database name.
 */
export const OWNER_PASSWORD_WAIT_MAX_MS = 120_000;
const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;

export const OWNER_PASSWORD_WAIT_MESSAGE =
  'crewflow_owner login refused (db-setup may still be storing the crewflow_owner password); retrying';

export const OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE =
  '[worker-db] refused: crewflow_owner login still refused (SQLSTATE 28P01) after 120 s; the stored crewflow_owner password does not log in. Run docker compose up again (db-setup checks it and names the fix), then restart the Worker.';

/** True for a failed login with a wrong password (28P01), as the pg driver or the runtime guard reports it. */
export function isOwnerPasswordMismatch(error: unknown): boolean {
  const e = error as { code?: unknown; driverCode?: unknown } | null;
  return e?.code === '28P01' || e?.driverCode === '28P01';
}

export interface OwnerPasswordWaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  exit?: (code: number) => never;
  maxMs?: number;
}

export async function retryWhileOwnerPasswordStale<T>(attempt: () => Promise<T>, deps: OwnerPasswordWaitDeps = {}): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((line: string) => console.warn(line));
  // eslint-disable-next-line no-console
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const maxMs = deps.maxMs ?? OWNER_PASSWORD_WAIT_MAX_MS;
  const started = now();
  let delay = FIRST_DELAY_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isOwnerPasswordMismatch(error)) throw error;
      const remaining = maxMs - (now() - started);
      if (remaining <= 0) {
        logError(OWNER_PASSWORD_WAIT_EXPIRED_MESSAGE);
        return exit(1);
      }
      log(OWNER_PASSWORD_WAIT_MESSAGE);
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
