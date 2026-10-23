import { base32Encode, formatManualKey, hotp, normaliseTotpInput, totpProvisioningUri, totpStepAt, verifyTotp } from './totp';

/** RFC 4226 Appendix D / RFC 6238 Appendix B shared secret (ASCII "12345678901234567890"). */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('totp (RFC 4226 / RFC 6238)', () => {
  it('matches every RFC 4226 Appendix D HOTP vector', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 Appendix B SHA-1 vectors (truncated to six digits)', () => {
    // [unix seconds, 8-digit RFC value] — the last six digits are the 6-digit TOTP for the same T.
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, eightDigits] of vectors) {
      expect(hotp(RFC_SECRET, totpStepAt(seconds * 1000), 8)).toBe(eightDigits);
      expect(hotp(RFC_SECRET, totpStepAt(seconds * 1000))).toBe(eightDigits.slice(2));
    }
  });

  it('base32-encodes per RFC 4648 (no padding)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(formatManualKey('GEZDGNBVGY3TQOJQ')).toBe('GEZD GNBV GY3T QOJQ');
  });

  it('accepts the current step and ±1 only, and returns the matched step', () => {
    const now = 1_700_000_000_000;
    const step = totpStepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it('rejects malformed codes without computing anything useful for an attacker', () => {
    const now = 1_700_000_000_000;
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６', '123456\n']) {
      expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
    }
    expect(normaliseTotpInput(' 123 456 ')).toBe('123456');
    expect(normaliseTotpInput('123-456')).toBe('123456');
    expect(normaliseTotpInput('12345a')).toBeNull();
    expect(normaliseTotpInput(123456)).toBeNull();
  });

  it('builds a standard otpauth URI without leaking separators into the label', () => {
    const uri = totpProvisioningUri({ issuer: 'Crewflow: Acme', accountName: 'a@b.test', secretBase32: 'ABCDEFGH' });
    expect(uri.startsWith('otpauth://totp/Crewflow%20Acme:a%40b.test?')).toBe(true);
    const query = new URLSearchParams(uri.split('?')[1]);
    expect(query.get('secret')).toBe('ABCDEFGH');
    expect(query.get('issuer')).toBe('Crewflow Acme');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
    expect(query.get('algorithm')).toBe('SHA1');
  });
});
