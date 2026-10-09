import { randomBytes } from 'node:crypto';

/**
 * A fresh, cryptographically random password for each fixture run. Never stored in the repository.
 *
 * The retired design used one constant string, tracked in git, for every fixture account. Any account created from that
 * constant, if it survived into a real database, was open to anyone who read the repository. A static repository check
 * (no-static-fixture-password.spec.ts) stops the constant returning.
 *
 * The suffix guarantees upper case, lower case, a digit and a symbol, so generated values satisfy the application password policy.
 */
export function generateFixturePassword(): string {
  return `${randomBytes(24).toString('base64url')}Aa1!`;
}
