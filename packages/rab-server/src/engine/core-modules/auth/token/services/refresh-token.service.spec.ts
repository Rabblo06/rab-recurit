import { UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { absoluteSessionTtlMsFor } from '../../session-policy';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';
import { REFRESH_TOKEN_TTL_MS, RefreshTokenService } from './refresh-token.service';

const MANAGER_WEB_TTL_MS = absoluteSessionTtlMsFor(['manager'], 'manager_web');

/** Chainable `createQueryBuilder().update().set().where().execute()` mock — the shape `rotate()`'s CAS claim now uses instead of a plain `manager.update()`. */
function buildQueryBuilder(executeResult: { affected: number } = { affected: 1 }) {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(executeResult),
  };
  return qb;
}

function buildManager(overrides: Partial<EntityManager> = {}, qbExecuteResult?: { affected: number }): EntityManager {
  const qb = buildQueryBuilder(qbExecuteResult);
  return {
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'new-token-id' }] }),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    ...overrides,
  } as unknown as EntityManager & { createQueryBuilder: () => typeof qb };
}

describe('RefreshTokenService', () => {
  const service = new RefreshTokenService();

  describe('issue', () => {
    it('inserts a hashed token, never the raw one', async () => {
      const manager = buildManager();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'manager_web', roles: ['manager'] });

      expect(manager.insert).toHaveBeenCalledWith(
        RefreshToken,
        expect.objectContaining({ organisationId: 'org-1', userId: 'user-1' }),
      );
      const insertedArg = (manager.insert as jest.Mock).mock.calls[0][1];
      expect(insertedArg.tokenHash).not.toBe(result.token);
      expect(insertedArg.tokenHash).toHaveLength(64); // sha256 hex
      expect(result.token).toHaveLength(64); // 32 random bytes, hex
    });

    it('generates a new familyId when none is given, reuses one when given', async () => {
      const manager = buildManager();
      const fresh = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'manager_web', roles: ['manager'] });
      const reused = await service.issue(manager, {
        organisationId: 'org-1',
        userId: 'user-1',
        familyId: fresh.familyId,
        familyExpiresAt: fresh.familyExpiresAt,
      });
      expect(reused.familyId).toBe(fresh.familyId);
    });

    it('PHASE 10 §2: fails closed — a genuinely new family with no known application target has no defined session policy', async () => {
      const manager = buildManager();
      await expect(service.issue(manager, { organisationId: 'org-1', userId: 'user-1' })).rejects.toThrow(UnauthorizedException);
    });

    it('PHASE 10: fails closed — a genuinely new family with an application target but no known roles has no defined session policy either', async () => {
      const manager = buildManager();
      await expect(
        service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'manager_web' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('PHASE 10: starts the manager_web (24h) absolute-session clock for that target', async () => {
      const manager = buildManager();
      const before = Date.now();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'manager_web', roles: ['manager'] });
      const after = Date.now();

      expect(result.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(before + MANAGER_WEB_TTL_MS);
      expect(result.familyExpiresAt.getTime()).toBeLessThanOrEqual(after + MANAGER_WEB_TTL_MS);
    });

    it('PHASE 10: starts the staff_app (90d) absolute-session clock for a genuine staff role — a DIFFERENT duration from manager_web', async () => {
      const manager = buildManager();
      const before = Date.now();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'staff_app', roles: ['staff'] });
      const after = Date.now();
      const staffTtl = absoluteSessionTtlMsFor(['staff'], 'staff_app');

      expect(staffTtl).toBeGreaterThan(MANAGER_WEB_TTL_MS); // sanity: 90d is genuinely longer than 24h
      expect(result.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(before + staffTtl);
      expect(result.familyExpiresAt.getTime()).toBeLessThanOrEqual(after + staffTtl);
    });

    it('PHASE 10: venue_manager_app also gets the 90d policy for a genuine venue_manager role', async () => {
      const manager = buildManager();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'venue_manager_app', roles: ['venue_manager'] });
      expect(result.familyExpiresAt.getTime() - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    });

    it('PHASE 10: a manager using an ALLOWED mobile target still only gets the 24h policy, never the 90d one — application ACCESS and SESSION SECURITY CLASS are separate axes (see application-access.ts)', async () => {
      const manager = buildManager();
      let before = Date.now();
      const viaStaffApp = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'staff_app', roles: ['manager'] });
      let after = Date.now();
      expect(viaStaffApp.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(before + MANAGER_WEB_TTL_MS);
      expect(viaStaffApp.familyExpiresAt.getTime()).toBeLessThanOrEqual(after + MANAGER_WEB_TTL_MS);

      before = Date.now();
      const viaVenueManagerApp = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1', applicationTarget: 'venue_manager_app', roles: ['manager'] });
      after = Date.now();
      expect(viaVenueManagerApp.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(before + MANAGER_WEB_TTL_MS);
      expect(viaVenueManagerApp.familyExpiresAt.getTime()).toBeLessThanOrEqual(after + MANAGER_WEB_TTL_MS);
    });

    it('reuses the SAME familyExpiresAt when one is passed, never recomputing it — the fix for the unbounded-session bug', async () => {
      const manager = buildManager();
      const originalFamilyExpiresAt = new Date(Date.now() + 60_000); // an old family, 1 minute from its absolute deadline
      const result = await service.issue(manager, {
        organisationId: 'org-1',
        userId: 'user-1',
        familyExpiresAt: originalFamilyExpiresAt,
      });

      expect(result.familyExpiresAt.getTime()).toBe(originalFamilyExpiresAt.getTime());
    });

    it('clamps the individual token expiresAt to familyExpiresAt when the family deadline is sooner than the 30-day per-token TTL', async () => {
      const manager = buildManager();
      const nearFamilyDeadline = new Date(Date.now() + 60_000); // 1 minute away — far short of REFRESH_TOKEN_TTL_MS
      const result = await service.issue(manager, {
        organisationId: 'org-1',
        userId: 'user-1',
        familyExpiresAt: nearFamilyDeadline,
      });

      expect(result.expiresAt.getTime()).toBe(nearFamilyDeadline.getTime());
      expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + REFRESH_TOKEN_TTL_MS);
    });
  });

  describe('rotate', () => {
    it('throws Unauthorized for an unknown token', async () => {
      const manager = buildManager({ findOne: jest.fn().mockResolvedValue(null) });
      await expect(service.rotate(manager, 'nonexistent', {})).rejects.toThrow(UnauthorizedException);
    });

    it('locks the row with pessimistic_write — the actual AUTH-01 fix — rather than a plain unlocked read', async () => {
      const findOne = jest.fn().mockResolvedValue({
        id: 'rt-1', familyId: 'fam-1', userId: 'user-1', organisationId: 'org-1',
        revokedAt: null, replacedBy: null, expiresAt: new Date(Date.now() + 3_600_000), familyExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const manager = buildManager({ findOne });
      await service.rotate(manager, 'valid-token', {});
      expect(findOne).toHaveBeenCalledWith(RefreshToken, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    });

    it('throws Unauthorized for an expired token', async () => {
      const manager = buildManager({
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: null,
          replacedBy: null,
          expiresAt: new Date(Date.now() - 1000),
        }),
      });
      await expect(service.rotate(manager, 'expired-token', {})).rejects.toThrow(UnauthorizedException);
    });

    it('throws RefreshTokenReuseError (carrying the familyId) when a replaced token is replayed, without revoking anything itself', async () => {
      // rotate() deliberately does NOT revoke here — it runs inside
      // AuthService.refresh()'s transaction, which rolls back entirely on
      // any thrown error, so a revocation attempted here would never
      // persist. The caller revokes the family afterward, in a fresh
      // transaction — see RefreshTokenReuseError's doc comment.
      const manager = buildManager({
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: null,
          replacedBy: 'rt-2', // already rotated away
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        }),
      });

      await expect(service.rotate(manager, 'stolen-token', {})).rejects.toMatchObject({
        name: 'RefreshTokenReuseError',
        familyId: 'fam-1',
      });
      expect((manager as unknown as { createQueryBuilder: () => { execute: jest.Mock } }).createQueryBuilder().execute).not.toHaveBeenCalled();
    });

    it('throws RefreshTokenReuseError (carrying the familyId) when an explicitly-revoked token is replayed, without revoking anything itself', async () => {
      const manager = buildManager({
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: new Date(),
          replacedBy: null,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        }),
      });

      await expect(service.rotate(manager, 'revoked-token', {})).rejects.toMatchObject({
        name: 'RefreshTokenReuseError',
        familyId: 'fam-1',
      });
    });

    it('on a valid token, issues a replacement and CAS-claims the old one as revoked/replaced', async () => {
      const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'rt-2' }] });
      const familyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);
      const manager = buildManager({
        insert,
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: null,
          replacedBy: null,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
          familyExpiresAt,
        }),
      });

      const result = await service.rotate(manager, 'valid-token', {});

      expect(result.userId).toBe('user-1');
      expect(result.organisationId).toBe('org-1');
      expect(result.issued.familyId).toBe('fam-1'); // rotation stays within the same family
      const qb = (manager as unknown as { createQueryBuilder: () => { update: jest.Mock; set: jest.Mock; where: jest.Mock; execute: jest.Mock } }).createQueryBuilder();
      expect(qb.update).toHaveBeenCalledWith(RefreshToken);
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ replacedBy: 'rt-2' }));
      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('revoked_at IS NULL'), { id: 'rt-1' });
    });

    it('PHASE 10 / AUTH-01 safety net: if the CAS claim somehow affects zero rows (should be unreachable under the row lock), fails safe as reuse-detected rather than returning a silently-unclaimed successor', async () => {
      const familyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);
      const manager = buildManager(
        {
          findOne: jest.fn().mockResolvedValue({
            id: 'rt-1', familyId: 'fam-1', userId: 'user-1', organisationId: 'org-1',
            revokedAt: null, replacedBy: null, expiresAt: new Date(Date.now() + 1000 * 60 * 60), familyExpiresAt,
          }),
        },
        { affected: 0 }, // simulates the CAS losing — should never happen given the row lock, but must fail safe
      );

      await expect(service.rotate(manager, 'valid-token', {})).rejects.toMatchObject({ name: 'RefreshTokenReuseError', familyId: 'fam-1' });
    });

    it('inherits the existing row\'s familyExpiresAt unchanged on rotation — the absolute ceiling never slides back out', async () => {
      const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'rt-2' }] });
      const originalFamilyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12); // 12h into a 24h family
      const manager = buildManager({
        insert,
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: null,
          replacedBy: null,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60), // this row's own TTL still has an hour left
          familyExpiresAt: originalFamilyExpiresAt,
        }),
      });

      const result = await service.rotate(manager, 'valid-token', {});

      expect(result.issued.familyExpiresAt.getTime()).toBe(originalFamilyExpiresAt.getTime());
      // Regression guard for the actual bug: a naive re-issue would have
      // recomputed a fresh absolute deadline from now(), which would always
      // be LATER than the original (since it started partway through).
      expect(result.issued.familyExpiresAt.getTime()).not.toBe(Date.now() + MANAGER_WEB_TTL_MS);
    });

    it('rejects a rotation once the token has reached its (family-clamped) expiry, even though a 30-day-only TTL would still have allowed it — this is the actual absolute-session enforcement', async () => {
      // Simulates the state a session reaches exactly at its absolute
      // deadline: expiresAt was clamped to familyExpiresAt at issue time
      // (see the "clamps" test above), so both are identical and both are
      // already in the past.
      const pastDeadline = new Date(Date.now() - 1000);
      const manager = buildManager({
        findOne: jest.fn().mockResolvedValue({
          id: 'rt-1',
          familyId: 'fam-1',
          userId: 'user-1',
          organisationId: 'org-1',
          revokedAt: null,
          replacedBy: null,
          expiresAt: pastDeadline,
          familyExpiresAt: pastDeadline,
        }),
      });

      await expect(service.rotate(manager, 'session-too-old', {})).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('revokeFamily', () => {
    it('revokes every token in the family', async () => {
      const update = jest.fn().mockResolvedValue(undefined);
      const manager = buildManager({ update });
      await service.revokeFamily(manager, 'fam-1');
      expect(update).toHaveBeenCalledWith(RefreshToken, { familyId: 'fam-1' }, { revokedAt: expect.any(Date) });
    });
  });
});
