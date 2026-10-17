import { maxAbsoluteSessionTtlMsAcrossAllTargets } from '../session-policy';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.3). The real retention window lives
 * inside a Postgres function body (`core.worker_cleanup_auth_tokens`, see migration
 * `RefreshReuseRetentionExtension1786677900000`) — TypeScript cannot read or enforce a SQL
 * literal at runtime. This constant is this codebase's OWN record of what that SQL currently
 * says, kept here specifically so `retention-policy.spec.ts` can assert, in CI, that it still
 * exceeds the longest live session family `session-policy.ts` defines. If the two ever drift
 * (someone raises `ABSOLUTE_SESSION_TTL_MS` without revisiting the retention migration, or edits
 * this constant without actually changing the SQL to match), this is the one place that catches
 * it — update BOTH this constant and the migration's SQL together, never just one.
 */
export const AUTH_TOKEN_CLEANUP_RETENTION_DAYS = 181; // WebSessionRetention1786717100000 (was 91)

/**
 * True only if the cleanup retention window is strictly longer than the longest absolute session
 * lifetime any application target currently allows — i.e. a revoked/expired token can never be
 * deleted while the family it belonged to could still legitimately be live. Used by
 * `retention-policy.spec.ts` as the regression guard the migration's own doc comment promises.
 */
export function retentionExceedsLongestSessionLifetime(): boolean {
  const retentionMs = AUTH_TOKEN_CLEANUP_RETENTION_DAYS * ONE_DAY_MS;
  return retentionMs > maxAbsoluteSessionTtlMsAcrossAllTargets();
}
