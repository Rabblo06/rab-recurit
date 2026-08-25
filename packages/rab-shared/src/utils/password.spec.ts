import { checkPasswordStrength, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password';

describe('checkPasswordStrength', () => {
  it('accepts a strong, random password', () => {
    expect(checkPasswordStrength('Tr7$kLmQ9wZp').valid).toBe(true);
  });

  it('rejects a password shorter than the minimum length', () => {
    const result = checkPasswordStrength('Ab1defg');
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes(`${MIN_PASSWORD_LENGTH}`))).toBe(true);
  });

  it('rejects a password missing case/number variety', () => {
    expect(checkPasswordStrength('alllowercase').valid).toBe(false);
    expect(checkPasswordStrength('ALLUPPERCASE').valid).toBe(false);
    expect(checkPasswordStrength('NoDigitsHere').valid).toBe(false);
  });

  it('rejects common passwords even if they pass the shape rules', () => {
    expect(checkPasswordStrength('Password123').valid).toBe(false);
    expect(checkPasswordStrength('Welcome123').valid).toBe(false);
  });

  it('rejects a password equal to the account email', () => {
    const result = checkPasswordStrength('Jane@Company.Com1', 'jane@company.com1');
    expect(result.valid).toBe(false);
  });

  it('rejects a password longer than the maximum length — caps argon2id verify cost on pathological input', () => {
    const result = checkPasswordStrength('Aa1' + 'x'.repeat(MAX_PASSWORD_LENGTH));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes(`${MAX_PASSWORD_LENGTH}`))).toBe(true);
  });
});
