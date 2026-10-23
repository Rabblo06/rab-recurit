import { createHash, randomInt } from 'node:crypto';

/**
 * Wave 4 lane MFA — one-time recovery codes.
 *
 * Format: 16 symbols of Crockford base32 (`0-9`, `A-Z` without I, L, O, U), shown as `XXXX-XXXX-XXXX-XXXX` = 80 bits
 * of entropy per code. Generated with `crypto.randomInt` (rejection sampling, no modulo bias). On input, Crockford's
 * look-alike rule is applied (O→0, I/L→1), case and dashes/spaces are ignored. Shown to the user ONCE (enrolment or
 * regeneration) and never stored in clear.
 *
 * Hash: SHA-256 (domain-separated) of the normalised code — the repository's approved one-way hash for HIGH-ENTROPY
 * random secrets (refresh tokens, password-reset tokens, web-session tokens, OAuth handoff secrets). argon2id exists for
 * LOW-entropy human secrets (passwords) where an offline guesser must be slowed; at 80 bits a preimage search is
 * infeasible regardless of hash speed, and a deterministic hash is what lets the database consume a code atomically by
 * value (`… WHERE code_hash = $2 AND used_at IS NULL`) instead of argon2-verifying every stored code in a loop.
 * Deliberately NOT peppered with an APP_SECRET-derived key: an APP_SECRET rotation would silently invalidate every
 * user's recovery codes exactly when they might need them.
 */

export const RECOVERY_CODE_COUNT = 10;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;

if (new Set(CROCKFORD).size !== 32) throw new Error('recovery-codes: alphabet must have 32 distinct symbols');

/** `count` fresh, distinct codes in display form (`XXXX-XXXX-XXXX-XXXX`). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) raw += CROCKFORD[randomInt(CROCKFORD.length)];
    codes.add(raw.replace(/(.{4})(?=.)/g, '$1-'));
  }
  return [...codes];
}

/** Canonical 16-symbol form, or null when the input cannot be a recovery code. */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const compact = input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (compact.length !== CODE_LENGTH) return null;
  for (const ch of compact) if (!CROCKFORD.includes(ch)) return null;
  return compact;
}

/** Hex SHA-256 of the NORMALISED code (what is stored, and what consumption matches on). */
export function hashRecoveryCode(normalised: string): string {
  return createHash('sha256').update(`crewflow-recovery-code-v1:${normalised}`).digest('hex');
}
