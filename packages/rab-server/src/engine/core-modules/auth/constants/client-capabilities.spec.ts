import { CAPABILITY_MFA_VERIFY, hasClientCapability, parseClientCapabilities } from './client-capabilities';

describe('X-Client-Capabilities parsing (account security step 1, P3)', () => {
  it.each([
    ['mfa-verify', true],
    ['MFA-VERIFY', true],
    [' mfa-verify , mfa-enrol ', true],
    ['mfa-enrol,Mfa-Verify', true],
    ['mfa-enrol', false],
    ['', false],
    ['mfa-verifyx', false],
    ['xmfa-verify', false],
    ['mfa verify', false],
  ])('%j → mfa-verify %s', (raw, expected) => {
    expect(hasClientCapability(parseClientCapabilities(raw), CAPABILITY_MFA_VERIFY)).toBe(expected);
  });

  it('fails closed on missing, oversized or repeated headers', () => {
    expect(parseClientCapabilities(undefined)).toEqual([]);
    expect(parseClientCapabilities(`${'a,'.repeat(300)}mfa-verify`)).toEqual([]);
    expect(hasClientCapability(parseClientCapabilities(['mfa-enrol', 'mfa-verify']), CAPABILITY_MFA_VERIFY)).toBe(true);
    expect(hasClientCapability(undefined, CAPABILITY_MFA_VERIFY)).toBe(false);
  });
});
