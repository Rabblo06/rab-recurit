import { createHmac, hkdfSync } from 'node:crypto';

/**
 * C1 review F2: a keyed, deterministic fingerprint of a push provider token, so one registration can find another row
 * that carries the SAME token without decrypting every row (`push_token_encrypted` is AES-GCM with a random IV, so equal
 * tokens never compare equal as ciphertext).
 *
 * - HMAC-SHA256 under a key derived from APP_SECRET with its own HKDF label (`crewflow:push-token-fingerprint:v1`), so it
 *   shares no key with encryption, JWT signing or the auth cache, and a database reader cannot test a guessed token
 *   without the server secret.
 * - 32 bytes, stored in `core.push_device.token_fingerprint` (bytea, CHECK octet_length = 32, never selected by default,
 *   never logged or returned).
 * - Rotating APP_SECRET changes every fingerprint: older rows then simply stop matching until their device registers
 *   again (a missed supersede, never a wrong one).
 */
export const PUSH_TOKEN_FINGERPRINT_LABEL = 'crewflow:push-token-fingerprint:v1';
export const PUSH_TOKEN_FINGERPRINT_LENGTH = 32;

export function pushTokenFingerprintKey(appSecret: string): Buffer {
  if (!appSecret) throw new Error('push token fingerprint: APP_SECRET is required.');
  return Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.alloc(0), PUSH_TOKEN_FINGERPRINT_LABEL, PUSH_TOKEN_FINGERPRINT_LENGTH));
}

export function pushTokenFingerprint(key: Buffer, pushToken: string): Buffer {
  if (!pushToken) throw new Error('push token fingerprint: the token must not be empty.');
  return createHmac('sha256', key).update(pushToken, 'utf8').digest();
}
