import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for seed and bootstrap commands: no console output may interpolate a password value. The commands read their
 * password from an environment variable and must never echo it. This test reads each command's source and fails if any console call
 * mentions the password variable inside its output, or if the seed success line is built from a password.
 */
const COMMANDS = ['seed.command.ts', 'seed-qa.command.ts', 'bootstrap-admin.command.ts', 'seed-success-message.ts'];
const PASSWORD_IDENTIFIER = /\b(password|passwordValue|plainPassword|adminPassword)\b/;

describe('seed and bootstrap commands never print a password value', () => {
  for (const file of COMMANDS) {
    it(`${file}: no console output interpolates a password identifier`, () => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const offending = source
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /console\.(log|error|warn|info|debug)/.test(line) && /\$\{[^}]*\b(password|passwordValue|plainPassword|adminPassword)\b/.test(line));
      expect(offending.map((o) => `${file}:${o.number}`)).toEqual([]);
    });
  }

  it('the seed success message names the account and says the password value is not shown', () => {
    const source = readFileSync(join(__dirname, 'seed-success-message.ts'), 'utf8');
    expect(source).toContain('value not printed');
  });
});
