import { createHash } from 'node:crypto';

import { hotp, totpStepAt, TOTP_STEP_SECONDS } from '../../../engine/core-modules/auth/mfa/totp';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 decode (test side only — the server never decodes a client-supplied secret). */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The secret an authenticator app would read from the enrolment response's otpauth:// URI. */
export function secretFromOtpauth(uri: string): Buffer {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('no secret in otpauth URI');
  return base32Decode(secret);
}

/** The six-digit code for the step `offset` steps away from the step current at `nowMs`. */
export function codeAt(secret: Buffer, offset = 0, nowMs = Date.now()): string {
  return hotp(secret, totpStepAt(nowMs) + offset);
}

/**
 * Waits (≤ one step) until the wall clock is at most `maxSecondsIntoStep` into a 30-second TOTP step, so a test that
 * needs steps s-1, s and s+1 to all stay inside the ±1 window has (30 - maxSecondsIntoStep) seconds to finish.
 * Returns the step that is current when it resolves.
 */
export async function earlyInStep(maxSecondsIntoStep = 6): Promise<number> {
  for (;;) {
    const into = (Date.now() / 1000) % TOTP_STEP_SECONDS;
    if (into <= maxSecondsIntoStep) return totpStepAt(Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, (TOTP_STEP_SECONDS - into) * 1000 + 50)));
  }
}

/** The Redis key `MfaChallengeService` stores a challenge under (only the token's SHA-256 is ever a key). */
export function challengeRedisKey(token: string, nodeEnv = 'test'): string {
  return `crewflow:${nodeEnv}:mfa-challenge:${createHash('sha256').update(token).digest('hex')}`;
}
