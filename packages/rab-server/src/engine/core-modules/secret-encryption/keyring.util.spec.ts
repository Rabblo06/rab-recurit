import { createHmac, hkdfSync } from 'node:crypto';

import {
  derivePurposeKey,
  keyMaterialProblems,
  parseKeyringEnvVar,
  productionKeyMaterialProblems,
  resolveAuthCacheMacKey,
  weakKeyMaterialReason,
} from './keyring.util';

const STRONG = 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA';
const STRONG_2 = 'p9Qw2Er7Ty1Ui8Op3As6Df0Gh5Jk4LzX';
const STRONG_3 = 'M1n2B3v4C5x6Z7l8K9j0H1g2F3d4S5aQ';

describe('keyring.util — wave 2 lane A2 key separation', () => {
  describe('derivePurposeKey', () => {
    it('is deterministic HKDF-SHA256 with a purpose+kid label (matches node:crypto directly)', () => {
      const expected = Buffer.from(hkdfSync('sha256', Buffer.from(STRONG, 'utf8'), Buffer.alloc(0), 'crewflow:key-purpose:v1:jwt-access:derived-v1', 32));
      expect(derivePurposeKey(STRONG, 'jwt-access', 'derived-v1').equals(expected)).toBe(true);
    });

    it('different purposes, kids or inputs never derive the same key, and no derived key equals the input secret', () => {
      const keys = [
        derivePurposeKey(STRONG, 'jwt-access', 'derived-v1'),
        derivePurposeKey(STRONG, 'auth-cache-hmac', 'derived-v1'),
        derivePurposeKey(STRONG, 'jwt-access', 'derived-v2'),
        derivePurposeKey(STRONG_2, 'jwt-access', 'derived-v1'),
      ].map((k) => k.toString('hex'));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).not.toContain(Buffer.from(STRONG, 'utf8').toString('hex'));
    });

    it('the legacy encryption derivation (rab-secret-encryption) and the old cache MAC key are different from every purpose key', () => {
      const legacyEnc = Buffer.from(hkdfSync('sha256', Buffer.from(STRONG, 'utf8'), Buffer.alloc(0), 'rab-secret-encryption', 32)).toString('hex');
      const oldCacheMac = createHmac('sha256', STRONG).update('crewflow:authctx-cache:v1').digest('hex');
      const purpose = [derivePurposeKey(STRONG, 'jwt-access', 'derived-v1'), resolveAuthCacheMacKey(STRONG, undefined).key].map((k) => k.toString('hex'));
      expect(purpose).not.toContain(legacyEnc);
      expect(purpose).not.toContain(oldCacheMac);
    });
  });

  describe('resolveAuthCacheMacKey', () => {
    it('without a dedicated key: derived from APP_SECRET, key id "derived-v1"', () => {
      const { key, keyId } = resolveAuthCacheMacKey(STRONG, undefined);
      expect(keyId).toBe('derived-v1');
      expect(key.equals(derivePurposeKey(STRONG, 'auth-cache-hmac', 'derived-v1'))).toBe(true);
    });

    it('with a dedicated key: independent of APP_SECRET, with a non-secret fingerprint id that changes on rotation', () => {
      const a = resolveAuthCacheMacKey(STRONG, STRONG_2);
      const b = resolveAuthCacheMacKey('another-app-secret-another-app-secret', STRONG_2);
      const rotated = resolveAuthCacheMacKey(STRONG, STRONG_3);
      expect(a.key.equals(b.key)).toBe(true);
      expect(a.keyId).toMatch(/^d-[0-9a-f]{12}$/);
      expect(rotated.keyId).not.toBe(a.keyId);
      expect(a.keyId).not.toContain(STRONG_2);
    });
  });

  describe('parseKeyringEnvVar', () => {
    it('parses a valid keyring', () => {
      expect(parseKeyringEnvVar(JSON.stringify([{ kid: 'a', secret: STRONG }]), 'X')).toEqual([{ kid: 'a', secret: STRONG }]);
    });

    it.each([
      ['not JSON', '{', /not valid JSON/],
      ['not an array', '{}', /must be a JSON array/],
      ['missing secret', JSON.stringify([{ kid: 'a' }]), /string "kid" and "secret"/],
      ['empty kid', JSON.stringify([{ kid: '', secret: STRONG }]), /kid must not be empty/],
      ['short secret', JSON.stringify([{ kid: 'a', secret: 'short' }]), /at least 32 characters/],
      ['duplicate kid', JSON.stringify([{ kid: 'a', secret: STRONG }, { kid: 'a', secret: STRONG_2 }]), /more than once/],
    ])('refuses %s (fail closed)', (_name, raw, pattern) => {
      expect(() => parseKeyringEnvVar(raw, 'X')).toThrow(pattern);
    });
  });

  describe('weakKeyMaterialReason', () => {
    it.each([STRONG, STRONG_2, 'a3f9c1e07b2d4865a3f9c1e07b2d4865a3f9c1e07b2d4865a3f9c1e07b2d4865'])('accepts a random-looking secret', (value) => {
      expect(weakKeyMaterialReason(value)).toBeNull();
    });

    it.each([
      ['short', 'Ab1!', /shorter than 32/],
      ['one repeated character', 'x'.repeat(40), /distinct characters/],
      ['few distinct characters', 'abababababababababababababababababab', /distinct characters/],
      ['placeholder wording', 'please-change-me-before-production-0123456789', /placeholder/],
      ['example wording', 'Example_Secret_Value_For_Docs_1234567', /placeholder/],
    ])('refuses %s', (_name, value, pattern) => {
      expect(weakKeyMaterialReason(value)).toMatch(pattern);
    });
  });

  describe('keyMaterialProblems (every environment)', () => {
    it('no problems for distinct secrets', () => {
      expect(
        keyMaterialProblems({
          APP_SECRET: STRONG,
          APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: STRONG_2 }]),
          APP_JWT_ACTIVE_KID: 'j1',
          APP_AUTH_CACHE_HMAC_KEY: STRONG_3,
        }),
      ).toEqual([]);
    });

    it.each([
      ['JWT kid = APP_SECRET', { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: STRONG }]) }, /APP_SECRET and APP_JWT_SIGNING_KEYRING kid "j1"/],
      ['JWT kid = encryption kid', { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: STRONG_2 }]), APP_ENCRYPTION_KEYRING: JSON.stringify([{ kid: 'e1', secret: STRONG_2 }]) }, /kid "j1" and APP_ENCRYPTION_KEYRING kid "e1"/],
      ['cache key = APP_SECRET', { APP_AUTH_CACHE_HMAC_KEY: STRONG }, /APP_SECRET and APP_AUTH_CACHE_HMAC_KEY/],
      ['two JWT kids sharing a secret', { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: STRONG_2 }, { kid: 'j2', secret: STRONG_2 }]) }, /kid "j1" and APP_JWT_SIGNING_KEYRING kid "j2"/],
      ['short cache key', { APP_AUTH_CACHE_HMAC_KEY: 'short' }, /APP_AUTH_CACHE_HMAC_KEY must be at least 32/],
      ['malformed keyring', { APP_JWT_SIGNING_KEYRING: '[' }, /not valid JSON/],
    ])('refuses %s', (_name, over, pattern) => {
      const problems = keyMaterialProblems({ APP_SECRET: STRONG, ...over });
      expect(problems.join('\n')).toMatch(pattern);
      // Names only: no secret value ever appears in a message.
      for (const secret of [STRONG, STRONG_2]) expect(problems.join('\n')).not.toContain(secret);
    });

    it('APP_KEY_SEPARATION_REQUIRED=true demands a dedicated JWT keyring, legacy verification off and a dedicated cache key', () => {
      const problems = keyMaterialProblems({ APP_SECRET: STRONG, APP_KEY_SEPARATION_REQUIRED: true }).join('\n');
      expect(problems).toMatch(/requires APP_JWT_SIGNING_KEYRING and APP_JWT_ACTIVE_KID/);
      expect(problems).toMatch(/requires APP_JWT_LEGACY_VERIFY_ENABLED=false/);
      expect(problems).toMatch(/requires APP_AUTH_CACHE_HMAC_KEY/);
      expect(
        keyMaterialProblems({
          APP_SECRET: STRONG,
          APP_KEY_SEPARATION_REQUIRED: true,
          APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: STRONG_2 }]),
          APP_JWT_ACTIVE_KID: 'j1',
          APP_JWT_LEGACY_VERIFY_ENABLED: false,
          APP_AUTH_CACHE_HMAC_KEY: STRONG_3,
        }),
      ).toEqual([]);
    });
  });

  describe('productionKeyMaterialProblems', () => {
    it('refuses a weak APP_SECRET, keyring secret or cache key by name only', () => {
      const problems = productionKeyMaterialProblems({
        APP_SECRET: 'x'.repeat(40),
        APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'j1', secret: 'y'.repeat(40) }]),
        APP_AUTH_CACHE_HMAC_KEY: 'z'.repeat(40),
      }).join('\n');
      expect(problems).toMatch(/APP_SECRET has fewer than 8 distinct characters/);
      expect(problems).toMatch(/APP_JWT_SIGNING_KEYRING kid "j1"/);
      expect(problems).toMatch(/APP_AUTH_CACHE_HMAC_KEY/);
      expect(problems).not.toContain('x'.repeat(40));
    });

    it('accepts strong keys', () => {
      expect(productionKeyMaterialProblems({ APP_SECRET: STRONG, APP_AUTH_CACHE_HMAC_KEY: STRONG_2 })).toEqual([]);
    });
  });
});
