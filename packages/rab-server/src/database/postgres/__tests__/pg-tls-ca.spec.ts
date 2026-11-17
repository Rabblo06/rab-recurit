import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPgClientForUrl, pgClientConfig, pgConnectionString } from '../create-pg-pool';
import { emitPgWarnings, PgConfigError, resolvePgEnvironment, resolvePgEnvironmentCached } from '../pg-config';
import { describePgSsl, PG_CA_PEM_MAX_BYTES, validatePgCaPem } from '../pg-tls';
import { databaseConfigurationProblem, validate } from '../../../engine/core-modules/environment/env.validation';
import { environmentRows } from '../../../engine/core-modules/platform-admin/admin-config.service';
import { TEST_CA_A, TEST_CA_B } from './fixtures/pg-test-ca';

// PG_SSL_CA_CERT: the database CA as PEM TEXT in an environment variable, for hosts that cannot mount a file (a PaaS such
// as OpenShip). Same verification as PG_SSL_CA_CERT_PATH (verify-full, host name included), validated at boot, never both,
// never logged. Pure: every case passes its own env object.
// What pg ACTUALLY uses: pg's own ConnectionParameters (as create-pg-pool.spec.ts does).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ConnectionParameters = require('pg/lib/connection-parameters') as new (config: unknown) => Record<string, unknown>;
const SECRET = 'Pw-s3cret-9f';
const DO = `postgresql://crewflow_app:${SECRET}@db-postgresql-lon1-1.db.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
const prod = { NODE_ENV: 'production', PG_DATABASE_URL: DO };
/** The base64 body lines of both fixtures: none of them may ever reach a log line or an error message. */
const BODY_LINES = [TEST_CA_A, TEST_CA_B].flatMap((pem) => pem.split('\n').filter((l) => l !== '' && !l.startsWith('-----')));
const oneLine = (pem: string) => pem.trim().split('\n').join('\\n');
// Built, so no secret scanner mistakes the test fixture for a real key.
const KEY_LABEL = ['PRIVATE', 'KEY'].join(' ');

function refusal(env: Record<string, string | undefined>, readFile?: (p: string) => string): string {
  try {
    resolvePgEnvironment(env, { processRole: 'api', readFile });
  } catch (error) {
    expect(error).toBeInstanceOf(PgConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('PG_SSL_CA_CERT: a valid PEM is accepted and verifies exactly like PG_SSL_CA_CERT_PATH', () => {
  it('production: verify-full (rejectUnauthorized + Node host-name check) against the inline CA', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'api' });
    expect(r.tls).toMatchObject({ caSource: 'PG_SSL_CA_CERT', caPath: null, caPem: TEST_CA_A });
    const ssl = new ConnectionParameters(pgClientConfig(r, { purpose: 'runtime' })).ssl as Record<string, unknown>;
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
    // No checkServerIdentity override: Node's default host-name verification stays on.
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it('gives the same ssl object as the same PEM read from PG_SSL_CA_CERT_PATH (one validator, one result)', () => {
    const inline = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'worker' });
    const file = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT_PATH: '/run/crewflow/pg-ca.crt' }, { processRole: 'worker', readFile: () => TEST_CA_A });
    expect(inline.primary.ssl).toEqual(file.primary.ssl);
    expect(inline.lock.ssl).toEqual(file.lock.ssl);
  });

  it.each([
    ['one line with \\n escapes (env files, platform UIs)', oneLine(TEST_CA_A)],
    ['CRLF line ends', TEST_CA_A.replace(/\n/g, '\r\n')],
    ['newlines collapsed to spaces by a platform UI', TEST_CA_A.trim().replace(/\n/g, ' ')],
    ['leading and trailing blanks', `\n  ${TEST_CA_A}  \n`],
    ['explanatory text around the block (RFC 7468)', `# DigitalOcean cluster CA\n${TEST_CA_A}`],
  ])('accepts %s and normalises it to the same PEM', (_name, value) => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: value }, { processRole: 'api' });
    expect(r.primary.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
  });

  it('accepts a bundle of several certificates (both roots trusted, in order)', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: `${TEST_CA_A}${TEST_CA_B}` }, { processRole: 'api' });
    expect(r.primary.ssl).toEqual({ rejectUnauthorized: true, ca: `${TEST_CA_A}${TEST_CA_B}` });
  });

  it('applies to the replica too (same TLS settings for every endpoint)', () => {
    const replica = DO.replace('db-postgresql-lon1-1', 'replica-db-postgresql-lon1-1');
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: TEST_CA_A, PG_DATABASE_REPLICA_URL: replica }, { processRole: 'api' });
    expect(r.replica?.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
  });

  it('outside production, a URL without sslmode turns verify-full on, as the path does', () => {
    const local = `postgres://crewflow_app:${SECRET}@db.internal.example:5432/rab`;
    expect(resolvePgEnvironment({ PG_DATABASE_URL: local, PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'api' }).primary.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
    expect(refusal({ PG_DATABASE_URL: `${local}?sslmode=disable`, PG_SSL_CA_CERT: TEST_CA_A })).toMatch(/sslmode=disable while PG_SSL_CA_CERT is set/);
  });

  it('an operator script (createPgClientForUrl: db-setup checks, CLI) takes PG_SSL_CA_CERT from its environment', () => {
    const client = createPgClientForUrl(DO, 'POSTURE_DATABASE_URL', { purpose: 'check' }, { NODE_ENV: 'production', PG_SSL_CA_CERT: TEST_CA_A });
    expect((client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA_A });
  });

  it('the string form refuses an inline CA instead of silently dropping it (sslrootcert names a file)', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'worker' });
    expect(() => pgConnectionString(r, { purpose: 'drift' })).toThrow(/cannot carry the inline PG_SSL_CA_CERT/);
  });
});

describe('verify-full binds the host-name check to an IP-address host (pg + Node would otherwise check "localhost")', () => {
  // A peer certificate as Node hands it to checkServerIdentity.
  const peer = (subjectaltname: string) => ({ subject: { CN: 'x' }, subjectaltname }) as unknown as import('tls').PeerCertificate;
  const ipUrl = (host: string) => `postgresql://crewflow_app:${SECRET}@${host}:5432/rab?sslmode=verify-full`;

  it.each([
    ['IPv4', '10.0.0.7', 'IP Address:10.0.0.7'],
    ['IPv6', '[fd00::7]', 'IP Address:FD00:0:0:0:0:0:0:7'],
  ])('%s: only a certificate naming that IP passes', (_n, host, san) => {
    const r = resolvePgEnvironment({ ...prod, PG_DATABASE_URL: ipUrl(host), PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'api' });
    const check = (r.primary.ssl as import('tls').ConnectionOptions).checkServerIdentity;
    expect(typeof check).toBe('function');
    // pg passes no name for an IP host; whatever Node passes in, the IP is what is checked.
    expect((check?.('localhost', peer('DNS:localhost')) as { code?: string } | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect((check?.('localhost', peer('DNS:db.example.com, IP Address:10.9.9.9')) as { code?: string } | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(check?.('localhost', peer(san))).toBeUndefined();
  });

  it('applies with the system store too (not only with a configured CA), and the string form refuses it', () => {
    const r = resolvePgEnvironment({ ...prod, PG_DATABASE_URL: ipUrl('10.0.0.7') }, { processRole: 'worker' });
    expect(typeof (r.primary.ssl as import('tls').ConnectionOptions).checkServerIdentity).toBe('function');
    expect(() => pgConnectionString(r, { purpose: 'drift' })).toThrow(/cannot carry the host-name check for an IP-address host/);
  });

  it('a DNS host keeps Node default check (no override): pg sends that name as servername', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: TEST_CA_A }, { processRole: 'api' });
    expect((r.primary.ssl as import('tls').ConnectionOptions).checkServerIdentity).toBeUndefined();
  });
});

describe('PG_SSL_CA_CERT: a malformed value refuses to start (fail closed), naming the variable only', () => {
  const corruptBody = TEST_CA_A.replace(/^(-----BEGIN CERTIFICATE-----\n)MIIB/, '$1MIIC');
  it.each([
    ['plain text', 'not a certificate', /PG_SSL_CA_CERT does not contain a PEM certificate/],
    ['a file path in the wrong variable', '/run/crewflow/pg-ca.crt', /PG_SSL_CA_CERT does not contain a PEM certificate/],
    ['a BEGIN line without its END line', TEST_CA_A.replace('-----END CERTIFICATE-----', ''), /does not contain a PEM certificate|incomplete PEM block/],
    ['a truncated second block', `${TEST_CA_A}-----BEGIN CERTIFICATE-----\nMIIB`, /incomplete PEM block/],
    ['mismatched labels', TEST_CA_A.replace('-----END CERTIFICATE-----', '-----END X509 CRL-----'), /BEGIN and END labels differ/],
    ['an empty block', '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----', /certificate 1 is not valid base64/],
    ['base64 that is not DER', '-----BEGIN CERTIFICATE-----\naGVsbG8gd29ybGQ=\n-----END CERTIFICATE-----', /certificate 1 is not a parseable X\.509 certificate/],
    ['a corrupted certificate', corruptBody, /certificate 1 is not a parseable X\.509 certificate/],
    ['a corrupted second certificate', `${TEST_CA_A}${TEST_CA_B.replace(/\n.{10}/, '\n!!!!!!!!!!')}`, /certificate 2 is not valid base64/],
    ['a public key instead of a certificate', '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----', /"PUBLIC KEY" PEM block; only CERTIFICATE blocks/],
  ])('refuses %s', (_name, value, expected) => {
    const message = refusal({ ...prod, PG_SSL_CA_CERT: value });
    expect(message).toMatch(expected);
    expect(message).toMatch(/Refusing to start\.$/);
  });

  it('refuses a private key pasted next to the certificate, and says the key is exposed', () => {
    const value = `${TEST_CA_A}-----BEGIN ${KEY_LABEL}-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END ${KEY_LABEL}-----\n`;
    const message = refusal({ ...prod, PG_SSL_CA_CERT: value });
    expect(message).toMatch(/PG_SSL_CA_CERT contains a PRIVATE KEY block\..*treat that key as exposed/);
    expect(message).not.toMatch(/MIGHAgEA/);
  });

  it(`refuses a value over ${PG_CA_PEM_MAX_BYTES / 1024} KiB`, () => {
    expect(refusal({ ...prod, PG_SSL_CA_CERT: TEST_CA_A.repeat(Math.ceil(PG_CA_PEM_MAX_BYTES / TEST_CA_A.length) + 1) })).toMatch(/larger than 256 KiB/);
  });

  it('the same validator guards PG_SSL_CA_CERT_PATH (a key or garbage in the file is refused at boot, not at first connect)', () => {
    expect(refusal({ ...prod, PG_SSL_CA_CERT_PATH: '/ca.pem' }, () => `${TEST_CA_A}-----BEGIN ${KEY_LABEL}-----\nMIGH\n-----END ${KEY_LABEL}-----`)).toMatch(
      /PG_SSL_CA_CERT_PATH contains a PRIVATE KEY block/,
    );
    expect(refusal({ ...prod, PG_SSL_CA_CERT_PATH: '/ca.pem' }, () => '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----')).toMatch(
      /PG_SSL_CA_CERT_PATH certificate 1 is not a parseable X\.509 certificate/,
    );
  });

  it('env.validation reports the refusal at boot (the API, the Worker and the CLI all validate through it)', () => {
    expect(databaseConfigurationProblem({ ...prod, PG_SSL_CA_CERT: 'garbage' })).toMatch(/PG_SSL_CA_CERT does not contain a PEM certificate/);
    expect(databaseConfigurationProblem({ ...prod, PG_SSL_CA_CERT: TEST_CA_A })).toBeNull();
  });
});

describe('PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH are mutually exclusive', () => {
  it('both set refuses to start, before the file is even read', () => {
    let read = false;
    const message = refusal({ ...prod, PG_SSL_CA_CERT: TEST_CA_A, PG_SSL_CA_CERT_PATH: '/run/crewflow/pg-ca.crt' }, () => {
      read = true;
      return TEST_CA_A;
    });
    expect(message).toMatch(/PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH are both set\. Set exactly one/);
    expect(read).toBe(false);
  });

  it('outside production too, and for the operator-script client', () => {
    expect(refusal({ PG_DATABASE_URL: DO, PG_SSL_CA_CERT: TEST_CA_A, PG_SSL_CA_CERT_PATH: '/x' })).toMatch(/both set/);
    expect(() => createPgClientForUrl(DO, 'DRIFT_DATABASE_URL', { purpose: 'check' }, { PG_SSL_CA_CERT: TEST_CA_A, PG_SSL_CA_CERT_PATH: '/x' })).toThrow(/both set/);
  });

  it('an empty value counts as unset (OpenShip passes an empty string for an unset variable)', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: '  ', PG_SSL_CA_CERT_PATH: '/ca.pem' }, { processRole: 'api', readFile: () => TEST_CA_A });
    expect(r.tls.caSource).toBe('PG_SSL_CA_CERT_PATH');
    expect(resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: '' }, { processRole: 'api' }).primary.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('PG_SSL_CA_CERT never appears in a log line, an error message or the admin environment viewer', () => {
  const captured: string[] = [];
  const spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    captured.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(' '))));
    }
  });
  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
  });
  const assertNoCaText = (texts: string[]) => {
    for (const text of texts) for (const line of BODY_LINES) expect(text.includes(line)).toBe(false);
  };

  it('a successful boot resolution (with warnings emitted) prints nothing of the CA', () => {
    // A legacy name makes resolvePgEnvironmentCached emit a warning line through console.warn.
    const env = { PG_DATABASE_URL: DO, DATABASE_URL: DO, PG_SSL_CA_CERT: oneLine(`${TEST_CA_A}${TEST_CA_B}`) };
    const r = resolvePgEnvironmentCached(env, { processRole: 'api' });
    emitPgWarnings(r, env, (line) => captured.push(line));
    expect(r.warnings.length).toBeGreaterThan(0);
    captured.push(describePgSsl(r.primary.ssl), ...r.warnings);
    assertNoCaText(captured);
    expect(describePgSsl(r.primary.ssl)).toBe('verify-full (configured CA)');
  });

  it('no refusal message carries any part of the value', () => {
    const corrupted = TEST_CA_A.replace(/\n.{10}/, '\n!!!!!!!!!!');
    const values = [
      corrupted,
      `${TEST_CA_A}${TEST_CA_B.replace('-----END CERTIFICATE-----', '-----END X509 CRL-----')}`,
      `${TEST_CA_A}-----BEGIN ${KEY_LABEL}-----\nMIGH\n-----END ${KEY_LABEL}-----`,
      TEST_CA_A.repeat(500),
    ];
    const messages = values.map((value) => refusal({ ...prod, PG_SSL_CA_CERT: value }));
    messages.push(refusal({ ...prod, PG_SSL_CA_CERT: TEST_CA_A, PG_SSL_CA_CERT_PATH: '/x' }));
    messages.push(refusal({ PG_DATABASE_URL: `${DO.replace('verify-full', 'disable')}`, PG_SSL_CA_CERT: TEST_CA_B }));
    assertNoCaText([...messages, ...captured]);
    expect(() => validatePgCaPem(corrupted, 'PG_SSL_CA_CERT')).toThrow(PgConfigError);
  });

  it('env.validation (class-validator + the pg rules) never echoes it', () => {
    let message = '';
    try {
      validate({ ...prod, PG_SSL_CA_CERT: TEST_CA_A.replace(/\n.{10}/, '\n!!!!!!!!!!') });
    } catch (error) {
      message = (error as Error).message;
    }
    assertNoCaText([message, ...captured]);
  });

  it('the admin environment viewer shows Set / Not set only', () => {
    const rows = environmentRows((key) => (key === 'PG_SSL_CA_CERT' ? TEST_CA_A : undefined));
    const row = rows.find((r) => r.key === 'PG_SSL_CA_CERT');
    expect(row).toMatchObject({ state: 'set', value: null });
    assertNoCaText([JSON.stringify(rows)]);
  });
});

describe('I-1 / I-2: key material outside the blocks, unbalanced markers, and the CA file itself', () => {
  it('refuses a long base64 run outside every PEM block ("looks like key material"), without echoing it', () => {
    const bare = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const message = refusal({ ...prod, PG_SSL_CA_CERT: `${TEST_CA_A}${bare}\n` });
    expect(message).toMatch(/PG_SSL_CA_CERT holds a long base64 run outside the PEM blocks, which looks like key material/);
    expect(message).not.toContain('MIGH');
    // Short explanatory text (RFC 7468) stays accepted.
    expect(resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT: `Issuer: crewflow unit-test CA a (expires 2126)\n${TEST_CA_A}` }, { processRole: 'api' }).tls.caPem).toBe(TEST_CA_A);
  });

  it.each([
    ['an END without a BEGIN', `${TEST_CA_A}-----END CERTIFICATE-----\n`],
    ['two BEGINs, one END', `-----BEGIN CERTIFICATE-----\n${TEST_CA_A}`],
  ])('counts BEGIN/END markers first and refuses %s', (_n, value) => {
    expect(refusal({ ...prod, PG_SSL_CA_CERT: value })).toMatch(/contains an incomplete PEM block/);
  });

  it.each([
    ['a CRL block', `${TEST_CA_A}-----BEGIN X509 CRL-----\nMIIBFjCBvQIBATAKBggqhkjOPQQDAjAi\n-----END X509 CRL-----\n`, /"X509 CRL" PEM block/],
    ['a TRUSTED CERTIFICATE block', TEST_CA_A.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE'), /"TRUSTED CERTIFICATE" PEM block/],
  ])('PG_SSL_CA_CERT_PATH: a file with %s now refuses to boot (upgrade note)', (_n, content, expected) => {
    expect(refusal({ ...prod, PG_SSL_CA_CERT_PATH: '/ca.pem' }, () => content)).toMatch(expected);
  });

  describe('the default reader (readPgCaFile): fstat before reading', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ca-file-'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fileEnv = (p: string) => ({ ...prod, PG_SSL_CA_CERT_PATH: p });

    it('a regular file within the cap is read and validated', () => {
      const p = path.join(dir, 'ca.pem');
      fs.writeFileSync(p, TEST_CA_A);
      expect(resolvePgEnvironment(fileEnv(p), { processRole: 'api' }).tls).toMatchObject({ caSource: 'PG_SSL_CA_CERT_PATH', caPem: TEST_CA_A });
    });

    it('a directory is refused as "not a regular file"', () => {
      expect(refusal(fileEnv(dir))).toMatch(/PG_SSL_CA_CERT_PATH does not name a regular file/);
    });

    it('a file over 256 KiB is refused from its size, before it is read', () => {
      const p = path.join(dir, 'big.pem');
      fs.writeFileSync(p, Buffer.alloc(PG_CA_PEM_MAX_BYTES + 1, 0x41));
      expect(refusal(fileEnv(p))).toMatch(/PG_SSL_CA_CERT_PATH is larger than 256 KiB/);
    });

    it('a missing file is refused without naming the path', () => {
      const message = refusal(fileEnv(path.join(dir, 'missing.pem')));
      expect(message).toMatch(/PG_SSL_CA_CERT_PATH is set but the file cannot be read/);
      expect(message).not.toContain('missing.pem');
    });
  });
});
