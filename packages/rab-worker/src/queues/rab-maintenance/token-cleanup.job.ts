import { DataSource } from 'typeorm';

// `refresh_token` and `password_reset_token` are ENABLE-but-not-FORCE (the established pre-auth-lookup exemption). The deletion now
// runs inside core.worker_cleanup_auth_tokens(batch), a SECURITY DEFINER function owned by the narrow NOLOGIN `rab_secure_owner`
// and executable only by `crewflow` (migration WorkerRuntimeFunctions1786676500000; ownership moved to rab_secure_owner by
// CrewflowSingleCredentialRoleArchitecture1786682000000, P1C.2). The worker never needs a separate owner connection for this job.
//
// Retention, not immediate deletion: a token stays for 181 days (WebSessionRetention1786717100000; was 91) past whatever made it dead (expiry, revocation, use) — extended
// from the original 30 days by RefreshReuseRetentionExtension1786677900000, one day beyond the longest ABSOLUTE_SESSION_TTL_MS
// (90 days), so reuse-detection evidence always outlives the longest live session family. The window is fixed inside the
// function, not supplied by the caller. The function deletes at most TOKEN_CLEANUP_BATCH rows per run and
// serialises itself with a transaction advisory lock, so two workers cannot race.
//
// Backlog: a bounded batch drains over successive ticks instead of one unbounded DELETE per tick. Same end state, bounded lock time.
const TOKEN_CLEANUP_BATCH = 1000;

export interface TokenCleanupResult {
  refreshTokensDeleted: number;
  passwordResetTokensDeleted: number;
  /** Google/Microsoft sign-in attempts (core.oauth_transaction_state) 1h past expiry/consumption — audit F8. */
  oauthTransactionsDeleted: number;
}

/** Runs on the runtime (crewflow) DataSource. Accepts no SQL, no user id and no scope; the only input is the batch size. */
export async function runTokenCleanupCycle(runtimeDataSource: DataSource): Promise<TokenCleanupResult> {
  const [row] = await runtimeDataSource.query<
    Array<{ refresh_tokens_deleted: number; password_reset_tokens_deleted: number }>
  >(`SELECT refresh_tokens_deleted, password_reset_tokens_deleted FROM core.worker_cleanup_auth_tokens($1::integer)`, [
    TOKEN_CLEANUP_BATCH,
  ]);
  // Same SECURITY DEFINER / bounded-batch / advisory-lock pattern (OAuthTransactionState1786680300000); unredeemed
  // handoffs carry a provider email until deleted, so this was never optional.
  const [oauth] = await runtimeDataSource.query<Array<{ rows_deleted: number }>>(
    `SELECT rows_deleted FROM core.worker_cleanup_oauth_transaction_state($1::integer)`,
    [TOKEN_CLEANUP_BATCH],
  );
  return {
    refreshTokensDeleted: Number(row?.refresh_tokens_deleted ?? 0),
    passwordResetTokensDeleted: Number(row?.password_reset_tokens_deleted ?? 0),
    oauthTransactionsDeleted: Number(oauth?.rows_deleted ?? 0),
  };
}
