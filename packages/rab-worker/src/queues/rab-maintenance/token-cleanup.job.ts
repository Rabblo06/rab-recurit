import { DataSource } from 'typeorm';

// Both `refresh_token` and `password_reset_token` are ENABLE-but-not-FORCE
// (the established pre-auth-lookup exemption — see `ManagerWorkspaceRls
// 1786667900000`'s doc comment for the full list) — this owner connection
// already sees every organisation's rows in both with no DISABLE/ENABLE
// bracket needed, matching `account-invite-cleanup.job.ts`'s own treatment
// of `core.user`/`core.account_invite`.
//
// Retention, not immediate deletion: a token stays queryable for 30 days
// past whatever made it dead (expiry, revocation, use) — long enough for a
// support investigation ("why couldn't I reset my password last week?") to
// still find the row, short enough that these two tables don't grow
// forever. Pure housekeeping — nothing in the app's own auth logic depends
// on a dead token still existing (both are already checked for expiry/
// revocation/use at read-time), so deleting it early or late changes
// nothing behaviourally.
const RETENTION_DAYS = 30;

export interface TokenCleanupResult {
  refreshTokensDeleted: number;
  passwordResetTokensDeleted: number;
}

export async function runTokenCleanupCycle(ownerDataSource: DataSource): Promise<TokenCleanupResult> {
  return ownerDataSource.transaction(async (manager) => {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_token_cleanup'))`);

    const [, refreshDeletedCount] = await manager.query<[unknown[], number]>(
      `DELETE FROM core.refresh_token
        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '${RETENTION_DAYS} days')
           OR (expires_at < now() - interval '${RETENTION_DAYS} days')`,
    );

    const [, resetDeletedCount] = await manager.query<[unknown[], number]>(
      `DELETE FROM core.password_reset_token
        WHERE (used_at IS NOT NULL AND used_at < now() - interval '${RETENTION_DAYS} days')
           OR (expires_at < now() - interval '${RETENTION_DAYS} days')`,
    );

    return { refreshTokensDeleted: refreshDeletedCount ?? 0, passwordResetTokensDeleted: resetDeletedCount ?? 0 };
  });
}
