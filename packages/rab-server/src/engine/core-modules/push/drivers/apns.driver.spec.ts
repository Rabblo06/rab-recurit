import { generateKeyPairSync, verify } from 'node:crypto';

import { ApnsDriver, ApnsDriverConfig } from './apns.driver';
import { PushSendError } from './interfaces/push-driver.interface';

function buildDriver(overrides: Partial<ApnsDriverConfig> = {}) {
  return new ApnsDriver({
    authKeyP8: undefined,
    keyId: 'KEY123',
    teamId: 'TEAM123',
    bundleId: 'com.rab.rab_staff',
    environment: 'sandbox',
    ...overrides,
  });
}

describe('ApnsDriver', () => {
  describe('signProviderToken — ES256 JWT shape, never Node default DER encoding', () => {
    it('produces a JWT whose signature verifies against the matching EC public key', () => {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const driver = buildDriver({ authKeyP8: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string });

      const jwt = (driver as unknown as { signProviderToken(): string }).signProviderToken();
      const [headerB64, payloadB64, signatureB64] = jwt.split('.');
      const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));

      expect(header).toEqual({ alg: 'ES256', kid: 'KEY123' });
      expect(payload.iss).toBe('TEAM123');
      expect(typeof payload.iat).toBe('number');

      const signingInput = `${headerB64}.${payloadB64}`;
      const verified = verify(
        'sha256',
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signatureB64!, 'base64url'),
      );
      expect(verified).toBe(true);
    });

    it('caches the provider token across calls within the TTL window, never re-signing needlessly', () => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const driver = buildDriver({ authKeyP8: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string });
      const sign = (driver as unknown as { signProviderToken(): string }).signProviderToken.bind(driver);
      expect(sign()).toBe(sign());
    });

    it('throws a clear error rather than signing with an empty key when APNS_* config is missing', () => {
      const driver = buildDriver();
      expect(() => (driver as unknown as { signProviderToken(): string }).signProviderToken()).toThrow(/APNS_AUTH_KEY_P8/);
    });
  });

  describe('classify — status/reason -> retryable/invalidToken mapping', () => {
    const classify = (driver: ApnsDriver, status: number, reason?: string) =>
      (driver as unknown as { classify(s: number, r: string | undefined): PushSendError }).classify(status, reason);

    it('410 Unregistered is a permanent, invalid-token failure (triggers device deactivation)', () => {
      const error = classify(buildDriver(), 410, 'Unregistered');
      expect(error.retryable).toBe(false);
      expect(error.invalidToken).toBe(true);
    });

    it('400 BadDeviceToken is also treated as invalid-token', () => {
      const error = classify(buildDriver(), 400, 'BadDeviceToken');
      expect(error.retryable).toBe(false);
      expect(error.invalidToken).toBe(true);
    });

    it('403 ExpiredProviderToken is retryable and never deactivates the device — it is our JWT, not the user’s token', () => {
      const error = classify(buildDriver(), 403, 'ExpiredProviderToken');
      expect(error.retryable).toBe(true);
      expect(error.invalidToken).toBe(false);
    });

    it('400 BadTopic is a permanent, non-invalid-token configuration failure', () => {
      const error = classify(buildDriver(), 400, 'BadTopic');
      expect(error.retryable).toBe(false);
      expect(error.invalidToken).toBe(false);
    });

    it('429 and unrecognised statuses default to retryable, same fail-safe direction as FcmDriver', () => {
      expect(classify(buildDriver(), 429, 'TooManyRequests').retryable).toBe(true);
      expect(classify(buildDriver(), 500, undefined).retryable).toBe(true);
      expect(classify(buildDriver(), 599, 'SomethingNewApple Invented').retryable).toBe(true);
    });
  });
});
