import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { EnvironmentService } from '../environment/environment.service';
import { SecretEncryptionService } from './secret-encryption.service';

/** Builds a raw pre-Checkpoint-3 ciphertext exactly as the original (pre-keyring) code did, to prove new decrypt() still reads it. */
function legacyEncrypt(appSecret: string, plaintext: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.alloc(0), 'rab-secret-encryption', 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function buildService(
  appSecret = 'a'.repeat(32),
  overrides: { APP_ENCRYPTION_KEYRING?: string; APP_ENCRYPTION_ACTIVE_KID?: string } = {},
): SecretEncryptionService {
  const values: Record<string, string | undefined> = {
    APP_SECRET: appSecret,
    APP_ENCRYPTION_KEYRING: overrides.APP_ENCRYPTION_KEYRING,
    APP_ENCRYPTION_ACTIVE_KID: overrides.APP_ENCRYPTION_ACTIVE_KID,
  };
  const env = { get: jest.fn((key: string) => values[key]) } as unknown as EnvironmentService;
  return new SecretEncryptionService(env);
}

describe('SecretEncryptionService', () => {
  it('round-trips a plaintext value', () => {
    const service = buildService();
    const encrypted = service.encrypt('12-34-56 12345678');
    expect(service.decrypt(encrypted)).toBe('12-34-56 12345678');
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const service = buildService();
    const a = service.encrypt('secret');
    const b = service.encrypt('secret');
    expect(a.equals(b)).toBe(false);
    expect(service.decrypt(a)).toBe('secret');
    expect(service.decrypt(b)).toBe('secret');
  });

  it('masks all but the last few characters', () => {
    const service = buildService();
    const encrypted = service.encrypt('12345678');
    expect(service.decryptAndMask(encrypted)).toBe('••••5678');
  });

  it('rejects tampered ciphertext (authenticated encryption)', () => {
    const service = buildService();
    const encrypted = service.encrypt('secret');
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => service.decrypt(encrypted)).toThrow();
  });

  it('cannot decrypt data encrypted under a different APP_SECRET', () => {
    const serviceA = buildService('a'.repeat(32));
    const serviceB = buildService('b'.repeat(32));
    const encrypted = serviceA.encrypt('secret');
    expect(() => serviceB.decrypt(encrypted)).toThrow();
  });

  describe('versioned keyring (Checkpoint 3)', () => {
    const appSecret = 'a'.repeat(32);
    const rotatedSecret = 'r'.repeat(32);
    const keyring = JSON.stringify([{ kid: '2026-11', secret: rotatedSecret }]);

    it('decrypts pre-keyring legacy ciphertext (no magic prefix) with no keyring configured', () => {
      const service = buildService(appSecret);
      const legacy = legacyEncrypt(appSecret, 'bank-detail-value');
      expect(service.decrypt(legacy)).toBe('bank-detail-value');
    });

    it('decrypts pre-keyring legacy ciphertext even after a keyring is configured and a new active key chosen', () => {
      const service = buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring, APP_ENCRYPTION_ACTIVE_KID: '2026-11' });
      const legacy = legacyEncrypt(appSecret, 'bank-detail-value');
      expect(service.decrypt(legacy)).toBe('bank-detail-value');
    });

    it('new encrypt() calls use the configured active kid, and are still readable by the same service', () => {
      const service = buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring, APP_ENCRYPTION_ACTIVE_KID: '2026-11' });
      const encrypted = service.encrypt('rotated-value');
      expect(service.decrypt(encrypted)).toBe('rotated-value');
    });

    it('old ciphertext encrypted under a previous active kid remains readable after the active kid rotates again', () => {
      const serviceV1 = buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring, APP_ENCRYPTION_ACTIVE_KID: '2026-11' });
      const oldEncrypted = serviceV1.encrypt('value-under-2026-11');

      const thirdSecret = 't'.repeat(32);
      const widerKeyring = JSON.stringify([
        { kid: '2026-11', secret: rotatedSecret },
        { kid: '2026-12', secret: thirdSecret },
      ]);
      const serviceV2 = buildService(appSecret, { APP_ENCRYPTION_KEYRING: widerKeyring, APP_ENCRYPTION_ACTIVE_KID: '2026-12' });

      expect(serviceV2.decrypt(oldEncrypted)).toBe('value-under-2026-11');
      const newEncrypted = serviceV2.encrypt('value-under-2026-12');
      expect(serviceV2.decrypt(newEncrypted)).toBe('value-under-2026-12');
    });

    it('rejects ciphertext tagged with an unknown kid', () => {
      const service = buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring, APP_ENCRYPTION_ACTIVE_KID: '2026-11' });
      const encrypted = service.encrypt('value');
      // Flip a byte inside the kid string itself (kid starts right after the 5-byte header: 4-byte magic + 1-byte length).
      encrypted[5] ^= 0xff;
      expect(() => service.decrypt(encrypted)).toThrow(/unknown encryption key id/);
    });

    it('fails closed at construction if APP_ENCRYPTION_KEYRING is set without APP_ENCRYPTION_ACTIVE_KID', () => {
      expect(() => buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring })).toThrow(/APP_ENCRYPTION_ACTIVE_KID is required/);
    });

    it('fails closed at construction if APP_ENCRYPTION_ACTIVE_KID does not exist in the keyring', () => {
      expect(() => buildService(appSecret, { APP_ENCRYPTION_KEYRING: keyring, APP_ENCRYPTION_ACTIVE_KID: 'nonexistent' })).toThrow(
        /not present in APP_ENCRYPTION_KEYRING/,
      );
    });

    it('fails closed at construction on malformed JSON', () => {
      expect(() => buildService(appSecret, { APP_ENCRYPTION_KEYRING: 'not-json', APP_ENCRYPTION_ACTIVE_KID: '2026-11' })).toThrow(
        /not valid JSON/,
      );
    });

    it('fails closed at construction if a keyring secret is too short', () => {
      const shortKeyring = JSON.stringify([{ kid: '2026-11', secret: 'short' }]);
      expect(() => buildService(appSecret, { APP_ENCRYPTION_KEYRING: shortKeyring, APP_ENCRYPTION_ACTIVE_KID: '2026-11' })).toThrow(
        /at least 32 characters/,
      );
    });

    it('rejects a keyring entry that reuses the reserved "legacy" kid', () => {
      const reservedKeyring = JSON.stringify([{ kid: 'legacy', secret: rotatedSecret }]);
      expect(() => buildService(appSecret, { APP_ENCRYPTION_KEYRING: reservedKeyring, APP_ENCRYPTION_ACTIVE_KID: 'legacy' })).toThrow(
        /reserved for the implicit/,
      );
    });
  });
});
