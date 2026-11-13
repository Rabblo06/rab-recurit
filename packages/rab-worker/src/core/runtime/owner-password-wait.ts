/**
 * DB-SETUP (DB-SETUP-PLAN §4, rotation): the crewflow_owner password is derived from APP_SECRET, and only the API's
 * bootstrap child resets it. After an APP_SECRET rotation the Worker may start (OpenShip drops the depends_on conditions)
 * before the API has reset the password: its first login then fails with SQLSTATE 28P01. This wait retries exactly that
 * failure, with a fixed message and a bounded backoff, for at most OWNER_PASSWORD_WAIT_MAX_MS; every other error, and a
 * 28P01 that outlasts the bound, is rethrown unchanged (the caller refuses to start; the restart policy brings it back).
 * Prints no value: no URL, password, host or database name.
 */
export const OWNER_PASSWORD_WAIT_MAX_MS = 120_000;
const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;

export const OWNER_PASSWORD_WAIT_MESSAGE =
  "[worker-db] crewflow_owner's password does not match this APP_SECRET yet (SQLSTATE 28P01): the API resets it on its next start";

/** True for a failed login with a wrong password (28P01), as the pg driver or the runtime guard reports it. */
export function isOwnerPasswordMismatch(error: unknown): boolean {
  const e = error as { code?: unknown; driverCode?: unknown } | null;
  return e?.code === '28P01' || e?.driverCode === '28P01';
}

export interface OwnerPasswordWaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  maxMs?: number;
}

export async function retryWhileOwnerPasswordStale<T>(attempt: () => Promise<T>, deps: OwnerPasswordWaitDeps = {}): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((line: string) => console.warn(line));
  const maxMs = deps.maxMs ?? OWNER_PASSWORD_WAIT_MAX_MS;
  const started = now();
  let delay = FIRST_DELAY_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const waited = now() - started;
      if (!isOwnerPasswordMismatch(error) || waited + delay > maxMs) throw error;
      log(`${OWNER_PASSWORD_WAIT_MESSAGE}; retrying in ${Math.round(delay / 1000)} s (waited ${Math.round(waited / 1000)} s of at most ${Math.round(maxMs / 1000)} s)`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
