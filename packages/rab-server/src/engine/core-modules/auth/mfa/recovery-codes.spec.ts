import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes';

describe('recovery codes', () => {
  it('generates ten distinct 80-bit codes in XXXX-XXXX-XXXX-XXXX form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('normalises case, separators and Crockford look-alikes, and rejects anything else', () => {
    expect(normaliseRecoveryCode('abcd-efgh-jkmn-pqrs')).toBe('ABCDEFGHJKMNPQRS');
    expect(normaliseRecoveryCode(' ABCD EFGH JKMN PQRS ')).toBe('ABCDEFGHJKMNPQRS');
    expect(normaliseRecoveryCode('OOOO-IIII-LLLL-0000')).toBe('0000111111110000');
    expect(normaliseRecoveryCode('ABCD-EFGH-JKMN-PQR')).toBeNull();
    expect(normaliseRecoveryCode('ABCD-EFGH-JKMN-PQRU')).toBeNull();
    expect(normaliseRecoveryCode('123456')).toBeNull();
    expect(normaliseRecoveryCode(42)).toBeNull();
    expect(normaliseRecoveryCode('A'.repeat(65))).toBeNull();
  });

  it('hashes the normalised form deterministically (64 hex chars, never the clear code)', () => {
    const a = hashRecoveryCode(normaliseRecoveryCode('abcd-efgh-jkmn-pqrs')!);
    const b = hashRecoveryCode(normaliseRecoveryCode('ABCDEFGHJKMNPQRS')!);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('ABCD');
  });
});
