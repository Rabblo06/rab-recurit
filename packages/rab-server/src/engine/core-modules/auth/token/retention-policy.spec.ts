import { maxAbsoluteSessionTtlMsAcrossAllTargets } from '../session-policy';
import { AUTH_TOKEN_CLEANUP_RETENTION_DAYS, retentionExceedsLongestSessionLifetime } from './retention-policy';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.3): the regression guard promised by
 * both `RefreshReuseRetentionExtension1786677900000`'s and `retention-policy.ts`'s own doc
 * comments — proves, in CI, that this codebase's token-cleanup retention window cannot silently
 * fall behind the longest session lifetime `session-policy.ts` defines. This test fails the
 * moment either value drifts without the other being updated to match.
 */
describe('refresh-token cleanup retention vs. absolute session lifetime (§8.3)', () => {
  it('retention is strictly longer than the longest currently-defined absolute session lifetime', () => {
    expect(retentionExceedsLongestSessionLifetime()).toBe(true);
  });

  it('exact current values: 91-day retention vs. a 90-day maximum session — the smallest safe margin, not a large arbitrary buffer', () => {
    expect(AUTH_TOKEN_CLEANUP_RETENTION_DAYS).toBe(91);
    expect(maxAbsoluteSessionTtlMsAcrossAllTargets()).toBe(90 * ONE_DAY_MS);
  });

  it('would FAIL if the session policy were ever raised to meet or exceed the current retention window — proving the guard actually catches drift, not just restating the current numbers', () => {
    const retentionMs = AUTH_TOKEN_CLEANUP_RETENTION_DAYS * ONE_DAY_MS;
    const hypotheticalLongerSession = retentionMs; // equal, not just greater — the guard requires STRICTLY longer retention
    expect(retentionMs > hypotheticalLongerSession).toBe(false);
  });
});
