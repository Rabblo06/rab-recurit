import { randomUUID } from 'node:crypto';

import { formatSecurityAuditEvent, redactString } from '../audit-sink/security-audit-sink';
import { maskEmailForAudit } from './build-security-audit-event';

/**
 * X1.1 review (LOW 1 + 2): the masker is Unicode-aware and masks the WHOLE local part of any e-mail-like token (IDN
 * domains, apostrophes, accented local parts — raw addresses do reach shipped metadata: user deletion, e-mail change,
 * staff/manager invites, onboarding), and defence in depth redacts private keys, JWTs, bearer values, named one-time codes
 * and secret-bearing URL parameters.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ship = (detail: Record<string, unknown>) =>
  JSON.parse(formatSecurityAuditEvent({ type: 'user.email_change_confirmed', severity: 'warning', process: 'worker', organisationId: ORG, detail })).detail;

describe('security audit redaction (X1.1 review)', () => {
  it.each<[string, string, string]>([
    ['IDN domain', 'user@exämple.com', 'u***@exämple.com'],
    ['apostrophe in the local part', "o'brien@example.ie", 'o***@example.ie'],
    ['accented local part', 'jöhn.smith@example.com', 'j***@example.com'],
    ['accented first letter', 'élodie@exemple.fr', 'é***@exemple.fr'],
    ['astral first character (never half a surrogate pair)', '😀x@example.com', '😀***@example.com'],
    ['plus addressing', 'ops+alerts@corp.example', 'o***@corp.example'],
    ['double @', 'foo@@bar.example', 'f***@bar.example'],
    ['no TLD', 'root@localhost', 'r***@localhost'],
  ])('masks an e-mail with %s', (_label, raw, masked) => {
    expect(redactString(raw)).toBe(masked);
    expect(redactString(`contact ${raw}, thanks`)).toBe(`contact ${masked}, thanks`);
  });

  it('nothing of the local part after its first character survives (accents, apostrophes)', () => {
    const out = redactString("jöhn@exämple.com o'brien@example.ie");
    expect(out).not.toMatch(/öhn|brien|'b/);
  });

  it('the metadata shapes that carry raw addresses today are masked once shipped', () => {
    const detail = ship({
      metadata: { email: 'jöhn@exämple.com', previousEmail: "o'brien@example.ie", newEmail: 'user@exämple.com', supersededEmail: 'Élodie@Exemple.fr', deletedUser: { email: 'zoë@example.com' } },
    });
    expect(detail.metadata).toEqual({
      email: 'j***@exämple.com',
      previousEmail: 'o***@example.ie',
      newEmail: 'u***@exämple.com',
      supersededEmail: 'É***@Exemple.fr',
      deletedUser: { email: 'z***@example.com' },
    });
  });

  it('maskEmailForAudit (login failures) is Unicode-aware too', () => {
    expect(maskEmailForAudit('jöhn@exämple.com')).toBe('j***@exämple.com');
    expect(maskEmailForAudit("O'Brien@Example.ie")).toBe('o***@example.ie');
    expect(maskEmailForAudit('😀x@example.com')).toBe('😀***@example.com');
    expect(maskEmailForAudit('not an email')).toBe('[not-an-email]');
  });

  it('redacts private keys, JWTs, bearer values and named one-time codes by key', () => {
    const v = () => `v-${randomUUID()}`;
    const input = { privateKey: v(), private_key: v(), jwt: v(), idJwt: v(), bearer: v(), mfaCode: v(), otpCode: v(), verificationCode: v(), resetCode: v(), second_factor_code: v() };
    const out = ship({ metadata: input }).metadata as Record<string, string>;
    for (const key of Object.keys(input)) expect([key, out[key]]).toEqual([key, '[REDACTED]']);
  });

  it('a bare `code` is redacted only when it holds a one-time code; an error code is kept', () => {
    expect(ship({ metadata: { code: '123456' } }).metadata.code).toBe('[REDACTED]');
    expect(ship({ metadata: { code: 87654321 } }).metadata.code).toBe('[REDACTED]');
    expect(ship({ metadata: { code: 'CHECKSUM_MISMATCH' } }).metadata.code).toBe('CHECKSUM_MISMATCH');
  });

  it('redacts secret-bearing URL parameters (reset / invite / OAuth links), bearer values and JWTs inside strings', () => {
    const t = randomUUID();
    expect(redactString(`https://app.example/reset?token=${t}&lang=en`)).toBe('https://app.example/reset?token=[REDACTED]&lang=en');
    expect(redactString(`https://app.example/invite?inviteToken=${t}`)).toBe('https://app.example/invite?inviteToken=[REDACTED]');
    expect(redactString(`https://app.example/oauth/cb?state=s&code=${t}`)).toBe('https://app.example/oauth/cb?state=s&code=[REDACTED]');
    expect(redactString(`https://app.example/#access_token=${t}&x=1`)).toBe('https://app.example/#access_token=[REDACTED]&x=1');
    expect(redactString(`header was Bearer ${t} here`)).toBe('header was [bearer] here');
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: t })}.${t.replace(/-/g, '')}`; // built at run time, never a literal
    expect(redactString(`session ${jwt} end`)).toBe('session [jwt] end');
    const shipped = JSON.stringify(ship({ metadata: { resetUrl: `https://app.example/reset?token=${t}` } }));
    expect(shipped).not.toContain(t);
  });
});
