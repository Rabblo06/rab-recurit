import { firstPendingMigration, readLedgerNames } from '@rab/server/database/boot-checks/schema-compatibility';

/**
 * Owner-login architecture (M0 §7, M0-D: "a bounded wait on schema current"): the Worker NEVER migrates; the API's start
 * (or the release step) does. A Worker that starts while the migration is still running would see pending migrations, and
 * the boot gate refuses that, so before the boot gates the Worker WAITS — bounded — while the ONLY finding is "pending":
 * migrations this code expects that are not applied yet. Anything else (an unreadable ledger, an unknown or interleaved
 * migration, a workspace above this code, a timeout) is not a wait: it is refused exactly as before.
 *
 *   CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS  whole seconds 0..3600, default 900 (a fresh install's full chain plus margin).
 *                                        0 = no wait (refuse at once on pending, the previous behaviour).
 */
export const SCHEMA_WAIT_SECONDS_ENV = 'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS';
export const SCHEMA_WAIT_SECONDS_DEFAULT = 900;
export const SCHEMA_WAIT_SECONDS_MAX = 3600;
export const SCHEMA_WAIT_POLL_MS = 10_000;

export class SchemaWaitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaWaitConfigError';
  }
}

export function resolveSchemaWaitMs(env: Record<string, string | undefined>): number {
  const raw = env[SCHEMA_WAIT_SECONDS_ENV];
  if (raw === undefined || raw === '') return SCHEMA_WAIT_SECONDS_DEFAULT * 1000;
  if (!/^\d+$/.test(raw) || Number(raw) > SCHEMA_WAIT_SECONDS_MAX) {
    throw new SchemaWaitConfigError(
      `${SCHEMA_WAIT_SECONDS_ENV} must be a whole number of seconds from 0 to ${SCHEMA_WAIT_SECONDS_MAX} (unset = ${SCHEMA_WAIT_SECONDS_DEFAULT}). Refusing to start.`,
    );
  }
  return Number(raw) * 1000;
}

/** True only for a schema-compatibility refusal whose every finding is "pending" (the migration is still running). */
export function isPendingOnly(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'SchemaCompatibilityError') return false;
  const findings = (error as Error & { findings?: unknown }).findings;
  return Array.isArray(findings) && findings.length > 0 && findings.every((f) => f === 'pending');
}

export interface SchemaWaitOptions {
  /** Resolves when the schema is compatible; rejects with SchemaCompatibilityError (or anything else) otherwise. */
  check: () => Promise<void>;
  maxWaitMs: number;
  pollMs?: number;
  log: (line: string) => void;
  /** Shutdown began: stop waiting (the caller exits). */
  shouldAbort?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SchemaWaitResult {
  waitedMs: number;
  checks: number;
}

export async function waitForCompatibleSchema(options: SchemaWaitOptions): Promise<SchemaWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? SCHEMA_WAIT_POLL_MS;
  const started = now();
  let checks = 0;
  let lastMessage: string | null = null;
  for (;;) {
    checks += 1;
    try {
      await options.check();
      if (lastMessage !== null) options.log(`[worker-schema-wait] the schema is now compatible with this code after ${Math.round((now() - started) / 1000)} s; starting`);
      return { waitedMs: now() - started, checks };
    } catch (error) {
      const waited = now() - started;
      if (!isPendingOnly(error)) throw error;
      if (waited + pollMs > options.maxWaitMs) {
        throw new Error(
          `[worker-schema-wait] refused: migrations are still pending after ${Math.round(waited / 1000)} s (${SCHEMA_WAIT_SECONDS_ENV} limit ${Math.round(options.maxWaitMs / 1000)} s). The Worker never migrates: check the API start / release migration step. ${(error as Error).message}`,
        );
      }
      if (options.shouldAbort?.()) throw new Error('[worker-schema-wait] shutdown requested while waiting for the schema');
      const message = (error as Error).message;
      if (message !== lastMessage) options.log(`[worker-schema-wait] waiting (bounded, ${Math.round(options.maxWaitMs / 1000)} s): ${message}`);
      lastMessage = message;
      await sleep(pollMs);
    }
  }
}

/**
 * Owner decision 2026-11-05 (changed, "the Worker starts too, like Twenty"): after a FAILED upgrade the API serves on the
 * previous schema (CREWFLOW_UPGRADE_FAILURE=continue) and the Worker starts ALL its consumers and scans as well — the boot
 * gate (Agent 3's gate 7) accepts an in-order pending tail for the Worker as a warning; a foreign, unknown or interleaved
 * ledger still refuses. Jobs that touch the missing schema fail and retry under their own existing rules (outbox
 * attempts/backoff, the next scan tick, the dispatcher's lease); a failure is always a failed job, never a crash.
 *
 * This is the ONE loud start-up line for that state: the first pending migration (chain order) and how many are pending,
 * or null when the ledger holds every migration this code expects. Names only.
 */
export function partlyUpgradedSchemaWarning(expected: readonly string[], applied: readonly string[]): string | null {
  const have = new Set(applied);
  const pending = expected.filter((name) => !have.has(name));
  if (pending.length === 0) return null;
  const first = firstPendingMigration(pending) ?? pending[0]!;
  return (
    `[worker-schema] WARNING running on a partly-upgraded schema: ${pending.length} migration(s) this code expects are not applied, ` +
    `first pending ${first}. Starting every consumer and scan anyway (owner decision 2026-11-05, like Twenty): jobs that need ` +
    'the missing schema fail and retry under their normal rules until the fix is deployed (the API applies it on its next start).'
  );
}

/**
 * Reads the migration ledger once (the caller's query function, on its own login) and logs `partlyUpgradedSchemaWarning`
 * EXACTLY ONCE when something is pending. Returns the warning (or null). A ledger that cannot be read is not this
 * function's concern — the boot gates have already decided on it — so it reports nothing rather than guessing.
 */
export async function warnIfPartlyUpgraded(options: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  expected: readonly string[];
  log: (line: string) => void;
}): Promise<string | null> {
  let applied: string[];
  try {
    applied = await readLedgerNames(options.query as (sql: string, params?: unknown[]) => Promise<unknown[]>, 'worker process');
  } catch {
    return null;
  }
  const warning = partlyUpgradedSchemaWarning(options.expected, applied);
  if (warning) options.log(warning);
  return warning;
}
