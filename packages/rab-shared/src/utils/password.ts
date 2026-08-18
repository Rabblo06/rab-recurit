/**
 * Shared password rules — both the create-user drawer (live UI feedback)
 * and the server (the only check that actually matters; client-side
 * validation is never trusted alone) run the identical rule set from here.
 * Deliberately not onerous: length + basic charset variety + a small
 * common-password blocklist, not an arbitrary-symbol-count gauntlet.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty123', 'qwertyuiop', 'admin123', 'welcome123',
  'letmein123', 'iloveyou1', 'changeme1', 'changeme123', 'abc12345',
]);

export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordCheckResult {
  valid: boolean;
  reasons: string[];
}

export function checkPasswordStrength(password: string, email?: string): PasswordCheckResult {
  const reasons: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    reasons.push(`Must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    reasons.push('Must include upper- and lower-case letters and a number.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    reasons.push('This password is too common.');
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    reasons.push('Password cannot be the same as the email address.');
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Generates a strong temporary password using a CSPRNG (`crypto.getRandomValues`
 * — the Web Crypto API, available as a global in both browsers and Node 19+;
 * never `Math.random`). The character set excludes visually ambiguous
 * characters (0/O, 1/l/I) since this is meant to be read aloud or typed by a
 * human on first login. Always satisfies `checkPasswordStrength` above by
 * construction — it draws from all four required character classes and pads
 * with a longer mixed run to comfortably clear the minimum length.
 */
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function randomChar(pool: string): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return pool[bytes[0]! % pool.length]!;
}

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const j = bytes[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars;
}

export function generateSecurePassword(length = 16): string {
  const required = [randomChar(LOWER), randomChar(UPPER), randomChar(DIGITS), randomChar(SYMBOLS)];
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => randomChar(ALL));
  return shuffle([...required, ...rest]).join('');
}
