import { createHash, createHmac, hkdfSync } from 'node:crypto';

import { EnvironmentService } from '../environment/environment.service';
import { derivePurposeKey } from './keyring.util';
import { SecretEncryptionService } from './secret-encryption.service';

/**
 * C1 review F2 (review of #303): the push-token fingerprint key comes from keyring.util's `derivePurposeKey` (purpose
 * `push-token-fingerprint`), one per encryption kid, so a fingerprint lives as long as the key that can decrypt the token.
 * Regression: a row fingerprinted under the OLD kid is still matched after the active kid rotates.
 */
const OLD = { kid: 'k2026a', secret: 'o'.repeat(40) };
const NEW = { kid: 'k2026b', secret: 'n'.repeat(40) };

function service(entries: Array<{ kid: string; secret: string }> | null, activeKid?: string, appSecret = 'a'.repeat(32)): SecretEncryptionService {
  const values: Record<string, string | undefined> = {
    APP_SECRET: appSecret,
    APP_ENCRYPTION_KEYRING: entries ? JSON.stringify(entries) : undefined,
    APP_ENCRYPTION_ACTIVE_KID: activeKid,
  };
  return new SecretEncryptionService({ get: (key: string) => values[key] } as unknown as EnvironmentService);
}

describe('push token fingerprint (SecretEncryptionService)', () => {
  it('is HMAC-SHA256 under derivePurposeKey(secret, push-token-fingerprint, kid) of the ACTIVE kid: deterministic, 32 bytes', () => {
    const enc = service([OLD], OLD.kid);
    const fp = enc.pushTokenFingerprint('fcm-token-1');
    expect(fp).toHaveLength(32);
    expect(fp.equals(enc.pushTokenFingerprint('fcm-token-1'))).toBe(true);
    const expected = createHmac('sha256', derivePurposeKey(OLD.secret, 'push-token-fingerprint', OLD.kid)).update('fcm-token-1').digest();
    expect(fp.equals(expected)).toBe(true);
  });

  it('without a keyring: the implicit legacy kid from APP_SECRET; a different APP_SECRET gives a different fingerprint', () => {
    const a = service(null).pushTokenFingerprint('fcm-token-1');
    expect(a.equals(createHmac('sha256', derivePurposeKey('a'.repeat(32), 'push-token-fingerprint', 'legacy')).update('fcm-token-1').digest())).toBe(true);
    expect(a.equals(service(null, undefined, 'b'.repeat(32)).pushTokenFingerprint('fcm-token-1'))).toBe(false);
  });

  it('regression (review of #303): after rotating the active kid, the fingerprint a row got under the old kid is still a candidate', () => {
    const before = service([OLD], OLD.kid).pushTokenFingerprint('fcm-token-1'); // stored before the rotation
    const after = service([OLD, NEW], NEW.kid);
    const candidates = after.pushTokenFingerprintCandidates('fcm-token-1');
    expect(candidates[0]!.equals(after.pushTokenFingerprint('fcm-token-1'))).toBe(true); // active first
    expect(candidates.some((c) => c.equals(before))).toBe(true);
    expect(after.pushTokenFingerprint('fcm-token-1').equals(before)).toBe(false); // new rows are written under the new kid
  });

  it('a kid removed from the keyring is no longer a candidate (its rows cannot be decrypted either; rotation re-fingerprints first)', () => {
    const before = service([OLD], OLD.kid).pushTokenFingerprint('fcm-token-1');
    expect(service([NEW], NEW.kid).pushTokenFingerprintCandidates('fcm-token-1').some((c) => c.equals(before))).toBe(false);
  });

  it('key separation: not the plain SHA-256, not keyed with the encryption key of the same kid, different per token', () => {
    const enc = service([OLD], OLD.kid);
    const fp = enc.pushTokenFingerprint('fcm-token-1');
    expect(fp.equals(createHash('sha256').update('fcm-token-1').digest())).toBe(false);
    const encryptionKey = Buffer.from(hkdfSync('sha256', Buffer.from(OLD.secret), Buffer.alloc(0), `rab-secret-encryption:${OLD.kid}`, 32));
    expect(fp.equals(createHmac('sha256', encryptionKey).update('fcm-token-1').digest())).toBe(false);
    expect(fp.equals(enc.pushTokenFingerprint('fcm-token-2'))).toBe(false);
  });

  it('refuses an empty token (fail closed, never a constant fingerprint)', () => {
    expect(() => service(null).pushTokenFingerprint('')).toThrow(/must not be empty/);
  });

  it('review of #303: the lock key does not change when the active kid switches (instances on both sides take the same lock)', () => {
    const before = service([OLD], OLD.kid).pushTokenLockKey('fcm-token-1');
    expect(service([OLD, NEW], NEW.kid).pushTokenLockKey('fcm-token-1')).toBe(before);
    expect(service([OLD, NEW], OLD.kid).pushTokenLockKey('fcm-token-1')).toBe(before);
    expect(service(null).pushTokenLockKey('fcm-token-1')).toBe(before);
    expect(Number.isInteger(before) && before >= -2147483648 && before <= 2147483647).toBe(true);
  });

  it('the lock key is its own purpose key: HMAC under derivePurposeKey(APP_SECRET, push-token-lock, v1), first 4 bytes signed', () => {
    const expected = createHmac('sha256', derivePurposeKey('a'.repeat(32), 'push-token-lock', 'v1')).update('fcm-token-1').digest().readInt32BE(0);
    expect(service([OLD], OLD.kid).pushTokenLockKey('fcm-token-1')).toBe(expected);
    expect(service([OLD], OLD.kid).pushTokenFingerprint('fcm-token-1').readInt32BE(0)).not.toBe(expected);
    expect(service(null).pushTokenLockKey('fcm-token-2')).not.toBe(expected);
  });
});
