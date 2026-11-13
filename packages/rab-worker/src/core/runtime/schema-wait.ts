import { checkSchemaCompatibility } from '@rab/server/database/boot-checks/database-boot-gates';
import type { SchemaCompatibilityAssessment } from '@rab/server/database/boot-checks/schema-compatibility';

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

/** A query on the Worker's own login (rows only). */
export type WorkerSchemaQuery = (sql: string, params?: unknown[]) => Promise<unknown[]>;

/**
 * ONE Worker schema check — the same call gate 7 makes for the Worker (database-boot-gates.ts). OWNER-DB-ULTIMATE Part B3:
 * any pending migration refuses (the C3 partly-upgraded relaxation described below is retired). Formerly: INCLUDING the C3 upgrade
 * evidence: `readUpgradeEvidence` (Agent 1's classifier CHAIN-PARTIAL + the physical fresh-install proof NOT fresh). Without it
 * `workerRelaxed` is always false and, after a failed upgrade, the wait refused the Worker that gate 7 would have started
 * (O3 T8a-WORKER, owner decision 2026-11-05 "the Worker starts too, like Twenty"). With it, an in-order pending tail on a
 * stopped UPGRADE passes (its warning is returned in the assessment; gate 7 logs the one partly-upgraded WARNING); an
 * out-of-order or interleaved ledger, a ledger ahead of a provisioner, and a first install (EMPTY, BOOTSTRAP-PARTIAL,
 * fresh CHAIN-PARTIAL, no evidence) still refuse exactly as before.
 */
export function checkWorkerSchema(query: WorkerSchemaQuery, options: { expected: readonly string[]; production: boolean }): Promise<SchemaCompatibilityAssessment> {
  return checkSchemaCompatibility(query, {
    process: 'worker',
    production: options.production,
    expected: options.expected,
    label: 'worker process',
  });
}

/** The Worker's bounded wait (waitForCompatibleSchema) over `checkWorkerSchema`. Main.ts runs it on its own boot connection. */
export async function waitForWorkerSchemaOn(
  query: WorkerSchemaQuery,
  options: { expected: readonly string[]; production: boolean } & Omit<SchemaWaitOptions, 'check'>,
): Promise<SchemaWaitResult & { assessment: SchemaCompatibilityAssessment | null }> {
  let assessment: SchemaCompatibilityAssessment | null = null;
  const { expected, production, ...wait } = options;
  const result = await waitForCompatibleSchema({
    ...wait,
    check: async () => {
      assessment = await checkWorkerSchema(query, { expected, production });
    },
  });
  return { ...result, assessment };
}
