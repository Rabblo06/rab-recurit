import { PUSH_TOKEN_FINGERPRINT_LENGTH, pushTokenFingerprint, pushTokenFingerprintKey } from './push-token-fingerprint';

/** C1 review F2: the token fingerprint is keyed, deterministic, fixed-length and separated from every other server key. */
describe('push token fingerprint', () => {
  const key = pushTokenFingerprintKey('a'.repeat(32));

  it('is deterministic for one key and token, 32 bytes', () => {
    const a = pushTokenFingerprint(key, 'fcm-token-1');
    expect(a).toHaveLength(PUSH_TOKEN_FINGERPRINT_LENGTH);
    expect(pushTokenFingerprint(key, 'fcm-token-1').equals(a)).toBe(true);
  });

  it('differs per token and per server secret (a database reader cannot test a guessed token without APP_SECRET)', () => {
    expect(pushTokenFingerprint(key, 'fcm-token-1').equals(pushTokenFingerprint(key, 'fcm-token-2'))).toBe(false);
    expect(pushTokenFingerprint(pushTokenFingerprintKey('b'.repeat(32)), 'fcm-token-1').equals(pushTokenFingerprint(key, 'fcm-token-1'))).toBe(false);
  });

  it('is not the unkeyed SHA-256 of the token, and the key is not the encryption key derivation', () => {
    const { createHash, hkdfSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    expect(pushTokenFingerprint(key, 'fcm-token-1').equals(createHash('sha256').update('fcm-token-1').digest())).toBe(false);
    const encryptionKey = Buffer.from(hkdfSync('sha256', Buffer.from('a'.repeat(32)), Buffer.alloc(0), 'rab-secret-encryption', 32));
    expect(key.equals(encryptionKey)).toBe(false);
  });

  it('refuses an empty secret or token (fail closed, never a constant fingerprint)', () => {
    expect(() => pushTokenFingerprintKey('')).toThrow(/APP_SECRET/);
    expect(() => pushTokenFingerprint(key, '')).toThrow(/must not be empty/);
  });
});
