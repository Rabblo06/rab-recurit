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
  ['bare key material', `${TEST_CA_A}${'A'.repeat(64)}\n`],
  ['invalid base64', TEST_CA_A.replace(/\n.{10}/, '\n!!!!!!!!!!')],
  ['not DER', '-----BEGIN CERTIFICATE-----\naGVsbG8gd29ybGQ=\n-----END CERTIFICATE-----'],
  ['oversize', TEST_CA_A.repeat(Math.ceil(PG_CA_PEM_MAX_BYTES / TEST_CA_A.length) + 1)],
];

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

  it('the boot side throws PgConfigError (fail closed at start)', () => {
    expect(() => validatePgCaPem('x', 'PG_SSL_CA_CERT')).toThrow(PgConfigError);
  });
});
