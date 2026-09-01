import { UnauthorizedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { RefreshToken } from '../../../../../modules/identity/entities';
import { RefreshTokenReuseError } from './refresh-token-reuse.error';
import { RefreshTokenService } from './refresh-token.service';

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
