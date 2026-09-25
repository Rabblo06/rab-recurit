import { UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';
import { ABSOLUTE_SESSION_TTL_MS, REFRESH_TOKEN_TTL_MS, RefreshTokenService } from './refresh-token.service';

function buildManager(overrides: Partial<EntityManager> = {}): EntityManager {
  return {
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'new-token-id' }] }),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EntityManager;
}

describe('RefreshTokenService', () => {
  const service = new RefreshTokenService();

  describe('issue', () => {
    it('inserts a hashed token, never the raw one', async () => {
      const manager = buildManager();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1' });

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
      const fresh = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1' });
      const reused = await service.issue(manager, {
        organisationId: 'org-1',
        userId: 'user-1',
        familyId: fresh.familyId,
      });
      expect(reused.familyId).toBe(fresh.familyId);
    });

    it('starts a fresh 24h absolute-session clock when familyExpiresAt is omitted (a genuinely new login)', async () => {
      const manager = buildManager();
      const before = Date.now();
      const result = await service.issue(manager, { organisationId: 'org-1', userId: 'user-1' });
      const after = Date.now();

      expect(result.familyExpiresAt.getTime()).toBeGreaterThanOrEqual(before + ABSOLUTE_SESSION_TTL_MS);
      expect(result.familyExpiresAt.getTime()).toBeLessThanOrEqual(after + ABSOLUTE_SESSION_TTL_MS);
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
      // rotate() deliberately does NOT call update() here — it runs inside
      // AuthService.refresh()'s transaction, which rolls back entirely on
      // any thrown error, so a revocation attempted here would never
      // persist. The caller revokes the family afterward, in a fresh
      // transaction — see RefreshTokenReuseError's doc comment.
      const update = jest.fn().mockResolvedValue(undefined);
      const manager = buildManager({
        update,
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
      expect(update).not.toHaveBeenCalled();
    });

    it('throws RefreshTokenReuseError (carrying the familyId) when an explicitly-revoked token is replayed, without revoking anything itself', async () => {
      const update = jest.fn().mockResolvedValue(undefined);
      const manager = buildManager({
        update,
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
      expect(update).not.toHaveBeenCalled();
    });

    it('on a valid token, issues a replacement and marks the old one replaced', async () => {
      const update = jest.fn().mockResolvedValue(undefined);
      const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: 'rt-2' }] });
      const familyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12);
      const manager = buildManager({
        update,
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
      expect(update).toHaveBeenCalledWith(RefreshToken, 'rt-1', {
        revokedAt: expect.any(Date),
        replacedBy: 'rt-2',
      });
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
      // recomputed a fresh 24h deadline from now(), which would always be
      // LATER than the original (since it started partway through).
      expect(result.issued.familyExpiresAt.getTime()).not.toBe(Date.now() + ABSOLUTE_SESSION_TTL_MS);
    });

    it('rejects a rotation once the token has reached its (family-clamped) expiry, even though a 30-day-only TTL would still have allowed it — this is the actual absolute-session enforcement', async () => {
      // Simulates the state a session reaches exactly at its 24h absolute
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
