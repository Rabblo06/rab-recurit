import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Wave 4 lane MFA — RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second step), the profile every authenticator app
 * implements (Google Authenticator, Microsoft Authenticator, 1Password, Authy).
 *
 * WHY NOT A LIBRARY: the repository has no OTP dependency (otplib exists only in the machine's global Yarn cache, from
 * another project), and installing one mid-wave would rewrite node_modules under other lanes' running test suites. The
 * protocol itself is a single HMAC from Node's own `crypto` (the reviewed primitive) plus RFC 4226's 4-line dynamic
 * truncation; this file is verified against the RFC 4226 Appendix D and RFC 6238 Appendix B test vectors
 * (`totp.spec.ts`). It is deliberately smaller than otplib: no configurable digits/algorithm/step (fixed to the
 * interoperable profile), and it returns the MATCHED STEP so the caller can enforce single use (otplib's `check()` and
 * Twenty's use of it return a boolean only, which is why Twenty has no replay protection). Swapping in a library later
 * only has to preserve `verifyTotp`'s contract.
 *
 * No secret, code or step is ever logged by this module.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step (RFC 6238 §5.2's recommended network-delay allowance): a code is accepted 30 s early or late, never more. */
export const TOTP_WINDOW = 1;
/** 160-bit secret, RFC 4226 §4 R6 recommended length for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding (the form authenticator apps accept in `otpauth://` URIs and manual entry). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh random TOTP secret (raw bytes). Generated server-side only; the client never chooses it. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 HOTP value for one counter, as a zero-padded decimal string. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('HOTP counter must be a non-negative safe integer.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The RFC 6238 time step (T) for a wall-clock instant. */
export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** Accepts only exactly six ASCII digits (spaces are stripped by the caller's normaliser, never here). */
export function isWellFormedTotpCode(code: unknown): code is string {
  return typeof code === 'string' && /^[0-9]{6}$/.test(code);
}

/** Strips the spaces/dashes people type ("123 456") — nothing else is tolerated. */
export function normaliseTotpInput(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const stripped = code.replace(/[\s-]/g, '');
  return isWellFormedTotpCode(stripped) ? stripped : null;
}

/**
 * Verifies a code against the current step ±`window`. Returns the MATCHED step (so the caller can record it and
 * reject the same or any older step next time — replay protection), or null.
 *
 * Every candidate step in the window is computed and compared in constant time, with no early exit, so the response
 * time does not reveal which step (if any) matched.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, window = TOTP_WINDOW): number | null {
  if (!isWellFormedTotpCode(code)) return null;
  const current = totpStepAt(nowMs);
  const presented = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    // Prefer the highest matching step: two adjacent steps producing the same six digits (probability 1e-6) must
    // record the newer one, so the replay floor never moves backwards.
    if (timingSafeEqual(expected, presented)) matched = step;
  }
  return matched;
}

/**
 * `otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30` (Google Authenticator Key
 * Uri Format). Shown ONCE during enrolment (as a QR code and as the manual key); never stored, never logged.
 */
export function totpProvisioningUri(params: { issuer: string; accountName: string; secretBase32: string }): string {
  const issuer = params.issuer.replace(/:/g, '').trim() || 'Crewflow';
  const account = params.accountName.replace(/:/g, '').trim();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Groups a base32 key in fours for manual entry ("ABCD EFGH …"). Display only. */
export function formatManualKey(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}
