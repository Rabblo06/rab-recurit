import { buildPgSsl, PG_CHANNEL_BINDING_WITHOUT_TLS_REFUSAL, PG_PRODUCTION_SSLMODES, PG_SSLMODE_PRODUCTION_REFUSAL, PgTlsSettings } from '../pg-tls';
import { PgConfigError, PgSslMode } from '../pg-url-policy';
import { resolvePgEnvironment } from '../pg-config';
import { TEST_CA_A } from './fixtures/pg-test-ca';

// Owner decision 2026-11-19 ("SSL like Twenty"): the full sslmode x environment matrix of pg-tls.ts buildPgSsl, the ONE place
// the `ssl` option is decided. Production accepts exactly require, verify-ca and verify-full, and maps all three to the SAME
// verify-full object (CA chain + host name, as node-pg treats require); disable, allow, prefer, no-verify and a missing
// sslmode are refused with one fixed message. channel_binding=require is accepted wherever TLS is on and refused without it.
// Pure: no connection. The real-handshake proof (a wrong CA or a wrong host refused with sslmode=require) is
// pg-tls-ca.integration.spec.ts.
const HOST = 'db.example.internal';
const LABEL = 'PG_DATABASE_URL';
const settings = (over: Partial<PgTlsSettings> = {}): PgTlsSettings => ({ production: false, caPem: null, caSource: null, allowSelfSigned: false, ...over });
const PROD = settings({ production: true });
const PROD_CA = settings({ production: true, caPem: TEST_CA_A, caSource: 'PG_SSL_CA_CERT' });

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PgConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('production: sslmode=require, verify-ca and verify-full are all full verification', () => {
  it('the accepted list is exactly require, verify-ca, verify-full', () => {
    expect([...PG_PRODUCTION_SSLMODES]).toEqual(['require', 'verify-ca', 'verify-full']);
  });

  it.each(['require', 'verify-ca', 'verify-full'] as const)('%s -> { rejectUnauthorized: true }, Node host-name check kept (system store)', (mode) => {
    const ssl = buildPgSsl(mode, PROD, LABEL, HOST);
    expect(ssl).toEqual({ rejectUnauthorized: true });
    // No checkServerIdentity override for a DNS host: Node's default check of pg's servername runs (host name verified).
    expect(ssl && 'checkServerIdentity' in ssl).toBe(false);
  });

  it.each(['require', 'verify-ca', 'verify-full'] as const)('%s with a configured CA -> that CA, still verified, host name included', (mode) => {
    expect(buildPgSsl(mode, PROD_CA, LABEL, HOST)).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
  });

  it('all three modes give the identical object (no mode is weaker than another)', () => {
    const [a, b, c] = PG_PRODUCTION_SSLMODES.map((mode) => buildPgSsl(mode, PROD_CA, LABEL, HOST));
    expect(a).toEqual(c);
    expect(b).toEqual(c);
  });

  it.each(['require', 'verify-ca', 'verify-full'] as const)('%s on an IP host binds the host-name check to that IP', (mode) => {
    const ssl = buildPgSsl(mode, PROD, LABEL, '10.1.2.3') as { rejectUnauthorized: boolean; checkServerIdentity?: (n: string, c: unknown) => Error | undefined };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.checkServerIdentity).toBe('function');
    // A certificate for another IP fails the check (Node's checkServerIdentity returns an Error).
    const wrong = ssl.checkServerIdentity?.('localhost', { subject: { CN: 'x' }, subjectaltname: 'IP Address:10.9.9.9' } as never);
    // (Node's Error comes from another realm under Jest, so the code is compared, not the constructor.)
    expect((wrong as { code?: string } | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    const right = ssl.checkServerIdentity?.('localhost', { subject: { CN: 'x' }, subjectaltname: 'IP Address:10.1.2.3' } as never);
    expect(right).toBeUndefined();
  });
});

describe('production: everything else is refused with the one fixed message', () => {
  it.each([['disable'], ['allow'], ['prefer'], ['no-verify'], [null]] as Array<[PgSslMode | null]>)('sslmode=%s is refused', (mode) => {
    expect(refused(() => buildPgSsl(mode, PROD, LABEL, HOST))).toBe(PG_SSLMODE_PRODUCTION_REFUSAL(LABEL));
    // A configured CA does not rescue it.
    expect(refused(() => buildPgSsl(mode, PROD_CA, LABEL, HOST))).toBe(PG_SSLMODE_PRODUCTION_REFUSAL(LABEL));
  });

  it('the message is fixed text: it names the variable and the accepted modes, never a value', () => {
    expect(PG_SSLMODE_PRODUCTION_REFUSAL('PG_ADMIN_URL')).toBe(
      'PG_ADMIN_URL must set sslmode=require, verify-ca or verify-full in production (all three are enforced as full verification: the certificate chain and the host name). sslmode=disable, allow, prefer, no-verify and a missing sslmode are refused. Refusing to start.',
    );
  });

  it.each(['require', 'verify-ca', 'verify-full', null] as Array<PgSslMode | null>)('PG_SSL_ALLOW_SELF_SIGNED=true is refused whatever the sslmode (%s)', (mode) => {
    expect(refused(() => buildPgSsl(mode, settings({ production: true, allowSelfSigned: true }), LABEL, HOST))).toMatch(/PG_SSL_ALLOW_SELF_SIGNED=true is refused in production/);
  });
});

describe('outside production: unchanged (local and test databases)', () => {
  it.each([
    ['require', { rejectUnauthorized: true }],
    ['verify-ca', { rejectUnauthorized: true }],
    ['verify-full', { rejectUnauthorized: true }],
    ['disable', false],
    [null, false],
  ] as Array<[PgSslMode | null, unknown]>)('sslmode=%s -> %j', (mode, expected) => {
    expect(buildPgSsl(mode, settings(), LABEL, HOST)).toEqual(expected);
  });

  it('no sslmode with a CA turns verify-full on; disable with a CA is a contradiction', () => {
    expect(buildPgSsl(null, settings({ caPem: TEST_CA_A, caSource: 'PG_SSL_CA_CERT' }), LABEL, HOST)).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
    expect(refused(() => buildPgSsl('disable', settings({ caPem: TEST_CA_A, caSource: 'PG_SSL_CA_CERT' }), LABEL, HOST))).toMatch(/sslmode=disable while PG_SSL_CA_CERT is set/);
  });

  it.each(['allow', 'prefer'] as const)('sslmode=%s is refused (pg cannot fall back between TLS and plaintext)', (mode) => {
    expect(refused(() => buildPgSsl(mode, settings(), LABEL, HOST))).toMatch(/cannot fall back between TLS and plaintext/);
  });

  it('no-verify only with PG_SSL_ALLOW_SELF_SIGNED=true; the flag also relaxes require / verify-ca / verify-full', () => {
    expect(refused(() => buildPgSsl('no-verify', settings(), LABEL, HOST))).toMatch(/needs PG_SSL_ALLOW_SELF_SIGNED=true/);
    for (const mode of ['no-verify', 'require', 'verify-ca', 'verify-full'] as const) {
      expect(buildPgSsl(mode, settings({ allowSelfSigned: true }), LABEL, HOST)).toEqual({ rejectUnauthorized: false });
    }
  });
});

describe('channel_binding=require', () => {
  it.each(['require', 'verify-ca', 'verify-full'] as const)('is accepted in production with sslmode=%s (TLS is always on there)', (mode) => {
    expect(buildPgSsl(mode, PROD, LABEL, HOST, 'require')).toEqual({ rejectUnauthorized: true });
  });

  it('is refused on a connection without TLS (outside production: disable, or no sslmode and no CA), fixed message', () => {
    expect(refused(() => buildPgSsl('disable', settings(), LABEL, HOST, 'require'))).toBe(PG_CHANNEL_BINDING_WITHOUT_TLS_REFUSAL(LABEL));
    expect(refused(() => buildPgSsl(null, settings(), LABEL, HOST, 'require'))).toBe(PG_CHANNEL_BINDING_WITHOUT_TLS_REFUSAL(LABEL));
  });

  it('prefer and disable never refuse (they do not demand anything)', () => {
    expect(buildPgSsl('disable', settings(), LABEL, HOST, 'prefer')).toBe(false);
    expect(buildPgSsl('disable', settings(), LABEL, HOST, 'disable')).toBe(false);
  });

  it('through the URL policy: the Neon string (sslmode=require&channel_binding=require) resolves in production; with sslmode=disable outside production it is refused', () => {
    const neon = 'postgresql://crewflow_owner:Pw-s3cret-9f@ep-cool-darkness-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: neon }, { processRole: 'api' });
    expect(r.primary.ssl).toEqual({ rejectUnauthorized: true });
    expect(r.primary.target.channelBinding).toBe(true);
    const local = 'postgres://crewflow_owner:pw@localhost:5432/rab?sslmode=disable&channel_binding=require';
    expect(refused(() => resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: local }, { processRole: 'api' }))).toBe(PG_CHANNEL_BINDING_WITHOUT_TLS_REFUSAL('PG_DATABASE_URL'));
  });
});

describe('PG_ADMIN_URL gets the same rules (db-setup resolves it through the same policy)', () => {
  // owner-bootstrap.ts resolveFor() hands the admin URL to resolvePgEnvironment under PG_DATABASE_URL and relabels the
  // message; the accepted / refused sets are therefore identical by construction. This pins the relabelled refusal text.
  it('the refusal relabels cleanly to PG_ADMIN_URL', () => {
    expect(PG_SSLMODE_PRODUCTION_REFUSAL('PG_DATABASE_URL').split('PG_DATABASE_URL').join('PG_ADMIN_URL')).toBe(PG_SSLMODE_PRODUCTION_REFUSAL('PG_ADMIN_URL'));
  });
});
