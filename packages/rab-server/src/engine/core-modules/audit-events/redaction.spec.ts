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
    expect(maskEmailForAudit('user@münchen.de')).toBe('u***@münchen.de');
    expect(maskEmailForAudit('user@xn--mnchen-3ya.de')).toBe('u***@xn--mnchen-3ya.de');
    expect(maskEmailForAudit('user@shop.xn--p1ai')).toBe('u***@shop.xn--p1ai');
    expect(maskEmailForAudit('first.last+tag@sub.corp-mail.example.co.uk')).toBe('f***@sub.corp-mail.example.co.uk');
    expect(maskEmailForAudit('not an email')).toBe('[not-an-email]');
    expect(maskEmailForAudit('a b@example.com')).toBe('[not-an-email]');
    expect(maskEmailForAudit('user@example.')).toBe('[not-an-email]');
    expect(maskEmailForAudit('user@.example')).toBe('[not-an-email]');
  });

  // Re-review REQUIRED: a password typed into the login e-mail field must never ship almost whole.
  it.each([
    'P@ss.word1',
    'Summer@2024.!',
    'Tr0ub4dor&3@x.y9',
    'hunter@2.0',
    'Qwerty@123.45',
    'pa@ss.w0rd',
    'abc@-x.com',
    'abc@x-.com',
    'abc@x..com',
    'abc@x.c',
    'abc@x.c0m',
    'abc@x_y.com',
    'abc@x.com!',
    'abc@localhost',
    'abc@[127.0.0.1]',
    `abc@${'a'.repeat(64)}.com`,
  ])('a password-shaped login input (%s) ships as [not-an-email]', (input) => {
    expect(maskEmailForAudit(input)).toBe('[not-an-email]');
  });

  it('hostile input stays fast (no backtracking): login e-mail field and free-text metadata', () => {
    const hostileLogin = `!@!.${'!.'.repeat(150)}`; // under the 320-character limit, so every check really runs
    expect(hostileLogin.length).toBeLessThan(320);
    const hostileDomain = `a@${'a-'.repeat(150)}`;
    const hostileText = `${'a='.repeat(1_000)}`;
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      expect(maskEmailForAudit(hostileLogin)).toBe('[not-an-email]');
      expect(maskEmailForAudit(hostileDomain)).toBe('[not-an-email]');
      redactString(hostileText);
      redactString(`${'@'.repeat(1_000)}x`);
      redactString('a@'.repeat(1_000));
      redactString('eyJ'.repeat(680));
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a string over the 2,048-character cap is never shipped, not even truncated (a cut JWT could leak)', () => {
    expect(redactString('x'.repeat(2_049))).toBe('[too-long]');
    expect(redactString(`${'x'.repeat(2_040)} eyJhbGciOiJIUzI1NiJ9`)).toBe('[too-long]');
    expect(redactString('x'.repeat(2_048))).toHaveLength(256);
  });

  it('redacts secret keys by NORMALISED name (`-` and spaces → `_`, any case)', () => {
    const v = () => `v-${randomUUID()}`;
    const input = {
      privateKey: v(), private_key: v(), 'private-key': v(), 'x-api-key': v(), 'X-API-KEY': v(), 'Api Key': v(),
      access_key: v(), accessKey: v(), signingKey: v(), encryptionKey: v(),
      session: v(), sessionId: v(), sid: v(), pwd: v(), pin: v(), backupCodes: v(), smsCode: v(), codes: v(),
      dsn: v(), connectionString: v(), databaseUrl: v(), DATABASE_URL: v(),
      jwt: v(), idJwt: v(), bearer: v(), mfaCode: v(), otpCode: v(), verificationCode: v(), resetCode: v(), second_factor_code: v(),
    };
    const out = ship({ metadata: input }).metadata as Record<string, string>;
    for (const key of Object.keys(input)) expect([key, out[key]]).toEqual([key, '[REDACTED]']);
    // Not over-broad: ordinary keys are kept.
    const kept = ship({ metadata: { reason: 'routine', pinned: true, sessions: 3, codeOfConduct: 'v2', errorCode: 'E1' } }).metadata;
    expect(kept).toEqual({ reason: 'routine', pinned: true, sessions: 3, codeOfConduct: 'v2', errorCode: 'E1' });
  });

  it('a bare `code` is redacted only when it holds one-time code digits (also grouped, also arrays); an error code is kept', () => {
    for (const code of ['123456', 87654321, '123 456', '123-456', ' 1234 ', ['123456', '654 321']]) {
      expect([code, ship({ metadata: { code } }).metadata.code]).toEqual([code, '[REDACTED]']);
    }
    expect(ship({ metadata: { code: 'CHECKSUM_MISMATCH' } }).metadata.code).toBe('CHECKSUM_MISMATCH');
    expect(ship({ metadata: { code: ['E1', 'E2'] } }).metadata.code).toEqual(['E1', 'E2']);
    expect(ship({ metadata: { code: [] } }).metadata.code).toEqual([]);
  });

  it('redacts secret name=value pairs inside strings (URL query / fragment / logs), by the same normalised names', () => {
    const t = randomUUID();
    const cases: Array<[string, string]> = [
      [`https://app.example/reset?token=${t}&lang=en`, 'https://app.example/reset?token=[REDACTED]&lang=en'],
      [`https://app.example/invite?inviteToken=${t}`, 'https://app.example/invite?inviteToken=[REDACTED]'],
      [`https://app.example/oauth/cb?state=s&code=${t}`, 'https://app.example/oauth/cb?state=s&code=[REDACTED]'],
      [`https://app.example/#access_token=${t}&x=1`, 'https://app.example/#access_token=[REDACTED]&x=1'],
      [`token=${t}`, 'token=[REDACTED]'],
      [`client_secret=${t}&grant_type=x`, 'client_secret=[REDACTED]&grant_type=x'],
      [`https://s3.example/o?X-Amz-Credential=${t}&X-Amz-Signature=${t}&X-Amz-Date=1`, 'https://s3.example/o?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Date=1'],
      [`access_key=${t} auth_code=${t} refresh-token=${t}`, 'access_key=[REDACTED] auth_code=[REDACTED] refresh-token=[REDACTED]'],
      ['reason=routine&count=3', 'reason=routine&count=3'],
      ['a==b token==x', 'a==b token=[REDACTED]'],
    ];
    for (const [input, expected] of cases) expect(redactString(input)).toBe(expected);
    const shipped = JSON.stringify(ship({ metadata: { resetUrl: `https://app.example/reset?token=${t}` } }));
    expect(shipped).not.toContain(t);
  });

  it('redacts Bearer and Basic credentials and JWTs inside strings', () => {
    const t = randomUUID();
    expect(redactString(`header was Bearer ${t} here`)).toBe('header was [bearer] here');
    const basic = Buffer.from(`user:${t}`).toString('base64');
    expect(redactString(`Authorization: Basic ${basic} sent`)).toBe('Authorization: [basic] sent');
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: t })}.${t.replace(/-/g, '')}`; // built at run time, never a literal
    expect(redactString(`session ${jwt} end`)).toBe('session [jwt] end');
  });

  it('one event ships at most ~16 KB of strings; values after the budget become [truncated]', () => {
    // Each string is cut at 256 characters; 3 arrays x 50 strings would be 38,400 characters without the budget.
    const list = () => Array.from({ length: 50 }, () => 'y'.repeat(2_000));
    const out = ship({ metadata: { a: list(), b: list(), c: list() } }).metadata as Record<string, string[]>;
    const values = [...out.a!, ...out.b!, ...out.c!];
    expect(values.filter((v) => v === '[truncated]').length).toBeGreaterThan(0);
    expect(values.filter((v) => v !== '[truncated]').reduce((n, v) => n + v.length, 0)).toBeLessThanOrEqual(16_384 + 256);
  });
});
