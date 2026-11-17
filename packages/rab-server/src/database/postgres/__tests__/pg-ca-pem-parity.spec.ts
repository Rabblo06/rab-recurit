import * as path from 'path';

import { PgConfigError } from '../pg-url-policy';
import { PG_CA_PEM_MAX_BYTES, validatePgCaPem } from '../pg-tls';
import { TEST_CA_A, TEST_CA_B } from './fixtures/pg-test-ca';

// The operator tools (the env-file lint and the --environment preflight) cannot load this TypeScript, so they use a
// dependency-free port: packages/rab-docker/scripts/pg-ca-pem.cjs. This spec runs both over one corpus and requires the
// same verdict, the same reason and the same normalised PEM, so the lint and the preflight refuse exactly what the boot
// refuses. A rule changed in one and not the other fails here.
interface CjsPort {
  PG_CA_PEM_MAX_BYTES: number;
  validatePgCaPem: (raw: string, label: string) => string;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const port = require(path.resolve(__dirname, '../../../../../rab-docker/scripts/pg-ca-pem.cjs')) as CjsPort;

const KEY_LABEL = ['PRIVATE', 'KEY'].join(' ');
const oneLine = (pem: string) => pem.trim().split('\n').join('\\n');
/** Real-looking base64 key material (not hex, not only `=`), 72 characters. */
const BARE_KEY = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgq1w2e3r4t5y6u7i8o9p0Zx+/';
/** A SHA-256 fingerprint as 64 bare hex digits. */
const HEX_FINGERPRINT = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const CORPUS: Array<[string, string]> = [
  ['one certificate', TEST_CA_A],
  ['a bundle', `${TEST_CA_A}${TEST_CA_B}`],
  ['one line, \\n escapes', oneLine(TEST_CA_A)],
  ['CRLF', TEST_CA_A.replace(/\n/g, '\r\n')],
  ['spaces for newlines', TEST_CA_A.trim().replace(/\n/g, ' ')],
  ['explanatory text', `# a comment\n${TEST_CA_A}`],
  ['plain text', 'not a certificate'],
  ['empty block', '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----'],
  ['no END', TEST_CA_A.replace('-----END CERTIFICATE-----', '')],
  ['extra END', `${TEST_CA_A}-----END CERTIFICATE-----\n`],
  ['mismatched labels', TEST_CA_A.replace('-----END CERTIFICATE-----', '-----END X509 CRL-----')],
  ['a CRL', `${TEST_CA_A}-----BEGIN X509 CRL-----\nMIIB\n-----END X509 CRL-----\n`],
  ['TRUSTED CERTIFICATE', TEST_CA_A.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE')],
  ['a private key', `${TEST_CA_A}-----BEGIN ${KEY_LABEL}-----\nMIGH\n-----END ${KEY_LABEL}-----\n`],
  ['bare key material', `${TEST_CA_A}${BARE_KEY}\n`],
  ['= banner', `${'='.repeat(72)}\n# DigitalOcean cluster CA\n${'='.repeat(72)}\n${TEST_CA_A}`],
  ['hex fingerprint', `# SHA-256 ${HEX_FINGERPRINT}\n${TEST_CA_A}`],
  ['lowercase key label, balanced markers', `${TEST_CA_A}-----BEGIN private key-----\nMIGH\n-----END private key-----\n`],
  ['invalid base64', TEST_CA_A.replace(/\n.{10}/, '\n!!!!!!!!!!')],
  ['not DER', '-----BEGIN CERTIFICATE-----\naGVsbG8gd29ybGQ=\n-----END CERTIFICATE-----'],
  ['oversize', TEST_CA_A.repeat(Math.ceil(PG_CA_PEM_MAX_BYTES / TEST_CA_A.length) + 1)],
];

/**
 * The verdict each I-5 / I-6 entry must get from BOTH sides (parity alone would let both drift the same wrong way).
 * A new rule needs a new parity corpus entry, and an expected verdict here when it is about accept vs refuse.
 */
const EXPECTED: Record<string, RegExp | 'accepted'> = {
  'bare key material': /holds a long base64 run outside the PEM blocks, which looks like key material/,
  '= banner': 'accepted',
  'hex fingerprint': 'accepted',
  // PEM_BLOCK does not match a lowercase label, so the block is never parsed; the balanced marker count still exposes it.
  'lowercase key label, balanced markers': /contains an incomplete PEM block/,
};

function verdict(run: () => string, strip: (m: string) => string): { ok: string } | { refused: string } {
  try {
    return { ok: run() };
  } catch (error) {
    return { refused: strip((error as Error).message) };
  }
}

describe('pg-ca-pem.cjs (operator tools) and pg-tls.ts validatePgCaPem (boot) agree', () => {
  it('the same size cap', () => {
    expect(port.PG_CA_PEM_MAX_BYTES).toBe(PG_CA_PEM_MAX_BYTES);
  });

  it.each(CORPUS)('%s: same verdict, same reason, same normalised PEM', (_name, value) => {
    const boot = verdict(
      () => validatePgCaPem(value, 'PG_SSL_CA_CERT'),
      (m) => m.replace(/ Refusing to start\.$/, ''),
    );
    const tool = verdict(
      () => port.validatePgCaPem(value, 'PG_SSL_CA_CERT'),
      (m) => m,
    );
    expect(tool).toEqual(boot);
  });

  it.each(Object.entries(EXPECTED))('%s: the expected verdict on both sides', (name, expected) => {
    const value = CORPUS.find(([n]) => n === name)?.[1];
    expect(value).toBeDefined();
    for (const run of [() => validatePgCaPem(String(value), 'PG_SSL_CA_CERT'), () => port.validatePgCaPem(String(value), 'PG_SSL_CA_CERT')]) {
      if (expected === 'accepted') expect(run()).toBe(TEST_CA_A);
      else expect(run).toThrow(expected);
    }
  });

  it('the boot side throws PgConfigError (fail closed at start)', () => {
    expect(() => validatePgCaPem('x', 'PG_SSL_CA_CERT')).toThrow(PgConfigError);
  });
});
