import { DataSource } from 'typeorm';

// `refresh_token` and `password_reset_token` are ENABLE-but-not-FORCE (the established pre-auth-lookup exemption). The deletion now
// runs inside core.worker_cleanup_auth_tokens(batch), a SECURITY DEFINER function owned by the narrow NOLOGIN `rab_secure_owner`
// and executable only by `crewflow` (migration WorkerRuntimeFunctions1786676500000; ownership moved to rab_secure_owner by
// CrewflowSingleCredentialRoleArchitecture1786682000000, P1C.2). The worker never needs a separate owner connection for this job.
//
// Retention, not immediate deletion: a token stays for 181 days (WebSessionRetention1786717100000; was 91) past whatever made it dead (expiry, revocation, use) — extended
// from the original 30 days by RefreshReuseRetentionExtension1786677900000, one day beyond the longest ABSOLUTE_SESSION_TTL_MS
// (90 days), so reuse-detection evidence always outlives the longest live session family. The window is fixed inside the
// function, not supplied by the caller. Each call deletes at most TOKEN_CLEANUP_BATCH rows and serialises itself with a
// transaction advisory lock, so two workers cannot race.
//
// XP-09 owner decisions Q2 + Q3 (2026-11-13):
// - Q2, isolation: the run has independent STEPS (the auth-token function, which deletes refresh tokens and password-reset
//   tokens in one call, and the Google/Microsoft sign-in state). A failing step is recorded with a fixed message and never
//   stops the steps after it; the OAuth sign-in state cleanup always runs (it carries a provider email until deleted). The
//   processor logs each failed step and then fails the cycle, so the existing `<name> cycle failed` / failure counter /
//   Sentry path reports it. Refresh and password-reset tokens share one SQL function, so they stay one step here.
// - Q3, capacity: each step calls its function again until a batch comes back short (fewer rows than the batch size).
//   Every call is a single autocommit statement on the runtime DataSource, so each batch is its own transaction (the
//   function's advisory lock is released between batches). The whole run is capped at TOKEN_CLEANUP_MAX_BATCHES calls or
//   TOKEN_CLEANUP_MAX_RUN_MS, whichever comes first; a step stopped by the cap leaves the rest for the next run. The cap
//   never starves a later step: each later step keeps one reserved call, and a step's FIRST call never waits on the cap
//   (so a run can start the OAuth step's first batch after the 60 s budget; that is the "always runs" guarantee).
//
// System scope, unchanged: no tenant context, no user id, no SQL from the caller; the only inputs are the batch size and caps.
export const TOKEN_CLEANUP_BATCH = 1000;
export const TOKEN_CLEANUP_MAX_BATCHES = 20;
export const TOKEN_CLEANUP_MAX_RUN_MS = 60_000;

export type TokenCleanupStepName = 'auth-tokens' | 'oauth-transaction-state';

export interface TokenCleanupStepReport {
  step: TokenCleanupStepName;
  /** Calls made (a call that threw counts; its transaction rolled back, so it deleted nothing). */
  batches: number;
  rowsDeleted: number;
  /** A batch came back short: nothing eligible was left when the step stopped. */
  drained: boolean;
  /** Why the step stopped before draining, if it did. */
  stoppedBy: 'batch-cap' | 'time-cap' | null;
  failed: boolean;
  /** Five-character SQLSTATE of the failure when the driver gave one (e.g. 23503); never the error message or detail. */
  sqlState: string | null;
}

export interface TokenCleanupResult {
  refreshTokensDeleted: number;
  passwordResetTokensDeleted: number;
  /** Google/Microsoft sign-in attempts (core.oauth_transaction_state) 1h past expiry/consumption — audit F8. */
  oauthTransactionsDeleted: number;
  /** Calls made across all steps in this run. */
  batches: number;
  /** True when a step stopped on the run cap with rows possibly left (the next run continues). */
  capHit: boolean;
  steps: TokenCleanupStepReport[];
}

export interface TokenCleanupOptions {
  batchSize?: number;
  maxBatches?: number;
  maxRunMs?: number;
  /** Clock (ms). Tests pass a fake one. */
  now?: () => number;
}

type CountKey = 'refreshTokensDeleted' | 'passwordResetTokensDeleted' | 'oauthTransactionsDeleted';

interface StepBatch {
  counts: Partial<Record<CountKey, number>>;
  /** At least one counter reached the batch size: there may be more eligible rows. */
  full: boolean;
}

interface Step {
  name: TokenCleanupStepName;
  run: (batchSize: number) => Promise<StepBatch>;
}

function cleanupSteps(runtimeDataSource: DataSource): Step[] {
  return [
    {
      name: 'auth-tokens',
      run: async (batchSize) => {
        const [row] = await runtimeDataSource.query<Array<{ refresh_tokens_deleted: number; password_reset_tokens_deleted: number }>>(
          `SELECT refresh_tokens_deleted, password_reset_tokens_deleted FROM core.worker_cleanup_auth_tokens($1::integer)`,
          [batchSize],
        );
        const refresh = Number(row?.refresh_tokens_deleted ?? 0);
        const reset = Number(row?.password_reset_tokens_deleted ?? 0);
        return { counts: { refreshTokensDeleted: refresh, passwordResetTokensDeleted: reset }, full: refresh >= batchSize || reset >= batchSize };
      },
    },
    {
      // Same SECURITY DEFINER / bounded-batch / advisory-lock pattern (OAuthTransactionState1786680300000); unredeemed
      // handoffs carry a provider email until deleted, so this was never optional.
      name: 'oauth-transaction-state',
      run: async (batchSize) => {
        const [row] = await runtimeDataSource.query<Array<{ rows_deleted: number }>>(
          `SELECT rows_deleted FROM core.worker_cleanup_oauth_transaction_state($1::integer)`,
          [batchSize],
        );
        const n = Number(row?.rows_deleted ?? 0);
        return { counts: { oauthTransactionsDeleted: n }, full: n >= batchSize };
      },
    },
  ];
}

/** The SQLSTATE only (TypeORM's QueryFailedError copies the pg error's `code`); anything else → null. */
function sqlStateOf(error: unknown): string | null {
  const e = error as { code?: unknown; driverError?: { code?: unknown } } | null | undefined;
  for (const code of [e?.code, e?.driverError?.code]) if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  return null;
}

/** Runs on the runtime (crewflow) DataSource. Accepts no SQL, no user id and no scope; only the batch size and run caps. */
export async function runTokenCleanupCycle(runtimeDataSource: DataSource, options: TokenCleanupOptions = {}): Promise<TokenCleanupResult> {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? TOKEN_CLEANUP_BATCH), 1), 10_000);
  const maxBatches = Math.max(Math.trunc(options.maxBatches ?? TOKEN_CLEANUP_MAX_BATCHES), 1);
  const maxRunMs = Math.max(options.maxRunMs ?? TOKEN_CLEANUP_MAX_RUN_MS, 0);
  const now = options.now ?? Date.now;
  const deadline = now() + maxRunMs;

  const result: TokenCleanupResult = {
    refreshTokensDeleted: 0,
    passwordResetTokensDeleted: 0,
    oauthTransactionsDeleted: 0,
    batches: 0,
    capHit: false,
    steps: [],
  };
  const steps = cleanupSteps(runtimeDataSource);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const reservedForLaterSteps = steps.length - 1 - i;
    const report: TokenCleanupStepReport = { step: step.name, batches: 0, rowsDeleted: 0, drained: false, stoppedBy: null, failed: false, sqlState: null };
    result.steps.push(report);
    for (;;) {
      if (report.batches > 0) {
        if (result.batches + reservedForLaterSteps >= maxBatches) {
          report.stoppedBy = 'batch-cap';
          break;
        }
        if (now() >= deadline) {
          report.stoppedBy = 'time-cap';
          break;
        }
      }
      report.batches += 1;
      result.batches += 1;
      let batch: StepBatch;
      try {
        batch = await step.run(batchSize);
      } catch (error) {
        // Isolation (Q2): record it and go on to the next step. The same batch would fail again (XP-09), so no retry here.
        report.failed = true;
        report.sqlState = sqlStateOf(error);
        break;
      }
      for (const [key, n] of Object.entries(batch.counts) as Array<[CountKey, number]>) {
        result[key] += n;
        report.rowsDeleted += n;
      }
      if (!batch.full) {
        report.drained = true;
        break;
      }
    }
    if (report.stoppedBy) result.capHit = true;
  }
  return result;
}

export interface TokenCleanupLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Logs the run (fixed messages: step names, counts and SQLSTATEs only; never an error message, row value, token or email)
 * and, when any step failed, throws a fixed-message error AFTER every step has run, so the scheduler's existing failure
 * path (`token cleanup cycle failed`, tokenCleanupFailures, Sentry) reports it.
 */
export function reportTokenCleanupResult(result: TokenCleanupResult, logger: TokenCleanupLogger): void {
  const failed = result.steps.filter((s) => s.failed);
  for (const s of failed) {
    logger.error(`token cleanup: step ${s.step} failed${s.sqlState ? ` (SQLSTATE ${s.sqlState})` : ''}; the other steps still ran`);
  }
  for (const s of result.steps) {
    if (s.stoppedBy) logger.warn(`token cleanup: step ${s.step} stopped at the run cap (${s.stoppedBy}) after ${s.batches} batch(es); the rest is deleted on the next run`);
  }
  if (result.refreshTokensDeleted || result.passwordResetTokensDeleted || result.oauthTransactionsDeleted || result.capHit || failed.length) {
    logger.log(
      `token cleanup: refreshTokens=${result.refreshTokensDeleted} passwordResetTokens=${result.passwordResetTokensDeleted} oauthTransactions=${result.oauthTransactionsDeleted} batches=${result.batches} capHit=${result.capHit}`,
    );
  }
  if (failed.length) {
    const error = new Error(`token cleanup: ${failed.length} step(s) failed: ${failed.map((s) => s.step).join(', ')} (details in the worker log)`);
    error.stack = error.message;
    throw error;
  }
}
