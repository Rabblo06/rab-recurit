/**
 * Phase B (B2): the ONE place the `ssl` option for a PostgreSQL connection is decided.
 *
 * The object is built from configuration only — the URL's `sslmode` is read as a declaration, never handed to pg — and
 * the factory never passes the URL itself to the driver, so nothing can override it (pg 8.23 lets URL ssl parameters
 * replace a code-built `ssl` object wholesale; see pg-url-policy.ts). The result is always explicit (`false` or an
 * object), so pg never falls back to `PGSSLMODE` either.
 *
 *   sslmode in URL   production                                   outside production
 *   (absent)         verify-full                                  no TLS, unless a CA is configured (verify-full)
 *   disable          REFUSED                                      no TLS
 *   allow, prefer    REFUSED                                      REFUSED (pg cannot fall back between TLS and plaintext)
 *   require          verify-full                                  verify-full (self-signed accepted with the flag)
 *   verify-ca        REFUSED (weaker than verify-full)            verify-full (self-signed accepted with the flag)
 *   verify-full      verify-full                                  verify-full (self-signed accepted with the flag)
 *   no-verify        REFUSED                                      only with PG_SSL_ALLOW_SELF_SIGNED=true
 *
 * verify-full = `{ rejectUnauthorized: true }` with Node's default `checkServerIdentity` (certificate chain AND host name),
 * against the configured CA when there is one, otherwise the system store. pg sends SNI for a DNS host name, and Node
 * checks that name. For an IP-literal host pg sets neither `servername` nor `host`, and Node then checks the certificate
 * against the literal name "localhost" instead of the IP (reproduced with pg 8.23 / Node 24): so for an IP host the
 * object carries an explicit `checkServerIdentity` bound to that IP, and the certificate must carry it as an IP SAN.
 * PG_SSL_ALLOW_SELF_SIGNED=true (`rejectUnauthorized: false`) is refused in production. Note `require` is deliberately
 * STRONGER here than libpq's `require` (which does not verify): pg 8 already treats it as verify-full, and pg 9 announces it
 * will weaken it, so the mapping is pinned here instead.
 *
 * The CA comes from ONE of two variables, never both (both set refuses to start):
 *   PG_SSL_CA_CERT_PATH   a file holding the PEM bundle (a mounted secret or volume);
 *   PG_SSL_CA_CERT        the PEM text itself, for hosts that cannot mount a file (PaaS platforms such as OpenShip). Real
 *                         newlines or `\n` escapes (one line, as env files and most platform UIs need) both work.
 * Either way the text is validated at boot by the same function (validatePgCaPem): BEGIN/END markers balanced, at least one
 * PEM block, every block a CERTIFICATE that X509Certificate parses, nothing else (a pasted private key is refused), and no
 * long base64 run outside the blocks (key material pasted without its armour). A CA file is fstat-checked first: a regular
 * file of at most PG_CA_PEM_MAX_BYTES, opened non-blocking (a FIFO or a device never hangs the boot). The same rules are
 * ported to packages/rab-docker/scripts/pg-ca-pem.cjs for the env-file lint and the --environment preflight, and
 * pg-ca-pem-parity.spec.ts runs both over one corpus. The text is never logged and
 * never part of an error message: it is a public certificate, but an operator mistake (a key pasted into it) must not
 * reach a log. A configured CA only changes WHICH root is trusted: verification stays verify-full, host name included.
 */
import { X509Certificate } from 'crypto';
import * as fs from 'fs';
import { isIP } from 'net';
import { checkServerIdentity, type ConnectionOptions } from 'tls';

import { PgConfigError, PgSslMode } from './pg-url-policy';

/** Which variable supplied the CA (named in refusals; the value never is). */
export type PgCaSource = 'PG_SSL_CA_CERT' | 'PG_SSL_CA_CERT_PATH';

export interface PgTlsSettings {
  production: boolean;
  /** Validated PEM certificate text from PG_SSL_CA_CERT or from the file named by PG_SSL_CA_CERT_PATH; null = system store. */
  caPem: string | null;
  /** The variable caPem came from, or null. */
  caSource: PgCaSource | null;
  allowSelfSigned: boolean;
}

export type PgSsl = false | ConnectionOptions;

/** Upper bound on the CA text (a regional provider bundle is a few KB; Linux caps one environment string at 128 KiB). */
export const PG_CA_PEM_MAX_BYTES = 256 * 1024;

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/g;

/**
 * Validates CA text from either source and returns it normalised: the CERTIFICATE blocks only, LF line ends (explanatory
 * text between blocks, which RFC 7468 allows, is dropped). Throws PgConfigError naming `source` only, never the text.
 */
export function validatePgCaPem(raw: string, source: PgCaSource): string {
  const refuse = (why: string): never => {
    throw new PgConfigError(`${source} ${why} Refusing to start.`);
  };
  if (Buffer.byteLength(raw, 'utf8') > PG_CA_PEM_MAX_BYTES) refuse(`is larger than ${PG_CA_PEM_MAX_BYTES / 1024} KiB; use your provider's regional CA bundle.`);
  // `\n` escapes (a one-line value) become real newlines; CRLF becomes LF. A PEM body never contains a backslash.
  const text = raw.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n');
  // Markers first, before any block is matched: an unbalanced BEGIN/END is refused outright.
  const begins = text.split('-----BEGIN ').length - 1;
  const ends = text.split('-----END ').length - 1;
  if (begins !== ends) refuse('contains an incomplete PEM block (a BEGIN line without its END line, or the reverse).');
  // Key material pasted WITHOUT its PEM armour: a long base64 run outside every block. A run of only `=` (a comment
  // banner) or only hex digits (a SHA-256 fingerprint in a comment) is not key material and is ignored.
  // Keep in step with packages/rab-docker/scripts/pg-ca-pem.cjs: a new rule needs a new parity corpus entry
  // (__tests__/pg-ca-pem-parity.spec.ts).
  const longRuns = text.replace(PEM_BLOCK, '').match(/[A-Za-z0-9+/=]{64,}/g) ?? [];
  if (longRuns.some((run) => !/^=+$/.test(run) && !/^[0-9A-Fa-f]+$/.test(run))) {
    refuse('holds a long base64 run outside the PEM blocks, which looks like key material. It must hold only CA certificate(s).');
  }
  const certificates: string[] = [];
  for (const [, beginLabel, body, endLabel] of text.matchAll(PEM_BLOCK)) {
    if (beginLabel !== endLabel) refuse('contains a PEM block whose BEGIN and END labels differ.');
    if (beginLabel !== 'CERTIFICATE') {
      refuse(
        /PRIVATE KEY/.test(beginLabel)
          ? 'contains a PRIVATE KEY block. It must hold only CA certificate(s): remove the key, and treat that key as exposed.'
          : `contains a "${beginLabel}" PEM block; only CERTIFICATE blocks are accepted.`,
      );
    }
    const base64 = body.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) refuse(`certificate ${certificates.length + 1} is not valid base64.`);
    const pem = `-----BEGIN CERTIFICATE-----\n${base64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
    try {
      new X509Certificate(pem);
    } catch {
      refuse(`certificate ${certificates.length + 1} is not a parseable X.509 certificate.`);
    }
    certificates.push(pem);
  }
  if (certificates.length === 0) refuse('does not contain a PEM certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----).');
  if (begins !== certificates.length) refuse('contains an incomplete PEM block (a BEGIN line without its END line, or the reverse).');
  return certificates.join('');
}

/**
 * The default reader of PG_SSL_CA_CERT_PATH: opened read-only and non-blocking, fstat-checked BEFORE reading (a regular
 * file of at most PG_CA_PEM_MAX_BYTES; a directory, FIFO, socket or device is refused), then read from the same descriptor.
 * Symbolic links are followed on purpose (Kubernetes mounts secrets through them). Throws PgConfigError; no path echoed.
 */
export function readPgCaFile(caPath: string): string {
  const unreadable = () => new PgConfigError('PG_SSL_CA_CERT_PATH is set but the file cannot be read. Refusing to start.');
  let fd: number;
  try {
    fd = fs.openSync(caPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw unreadable();
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new PgConfigError('PG_SSL_CA_CERT_PATH does not name a regular file. Refusing to start.');
    if (stat.size > PG_CA_PEM_MAX_BYTES) {
      throw new PgConfigError(`PG_SSL_CA_CERT_PATH is larger than ${PG_CA_PEM_MAX_BYTES / 1024} KiB; use your provider's regional CA bundle. Refusing to start.`);
    }
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof PgConfigError) throw error;
    throw unreadable();
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads and validates PG_SSL_CA_CERT_PATH at boot, not at first connect. The path is not echoed. */
export function readPgCaCertificate(caPath: string, readFile: (p: string) => string = readPgCaFile): string {
  let pem: string;
  try {
    pem = readFile(caPath);
  } catch (error) {
    if (error instanceof PgConfigError) throw error;
    throw new PgConfigError('PG_SSL_CA_CERT_PATH is set but the file cannot be read. Refusing to start.');
  }
  return validatePgCaPem(pem, 'PG_SSL_CA_CERT_PATH');
}

/**
 * The CA of this process, from its (trimmed; undefined = unset) PG_SSL_CA_CERT (inline PEM) or PG_SSL_CA_CERT_PATH (file),
 * never both. Validated at boot. `caPem: null` = the system store.
 */
export function resolvePgCaCertificate(
  inline: string | undefined,
  caPath: string | undefined,
  readFile?: (p: string) => string,
): Pick<PgTlsSettings, 'caPem' | 'caSource'> {
  if (inline !== undefined && caPath !== undefined) {
    throw new PgConfigError(
      'PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH are both set. Set exactly one: the PEM text itself, or the path of a file holding it. Refusing to start.',
    );
  }
  if (inline !== undefined) return { caPem: validatePgCaPem(inline, 'PG_SSL_CA_CERT'), caSource: 'PG_SSL_CA_CERT' };
  if (caPath !== undefined) return { caPem: readPgCaCertificate(caPath, readFile), caSource: 'PG_SSL_CA_CERT_PATH' };
  return { caPem: null, caSource: null };
}

/**
 * Builds the explicit `ssl` value for one connection string; `host` is the host that connection dials (the URL's).
 * Throws PgConfigError on any refused combination.
 */
export function buildPgSsl(sslmode: PgSslMode | null, settings: PgTlsSettings, label: string, host: string): PgSsl {
  const { production, caPem, allowSelfSigned } = settings;
  const verifyFull = (): ConnectionOptions => {
    const ssl: ConnectionOptions = caPem ? { rejectUnauthorized: true, ca: caPem } : { rejectUnauthorized: true };
    // pg passes no name to Node for an IP host, and Node would then verify the certificate against "localhost" (see the
    // header). Bind the check to the IP itself. A DNS host keeps Node's default check of pg's servername (no override).
    const literal = host.replace(/^\[(.*)\]$/, '$1');
    if (isIP(literal) !== 0) ssl.checkServerIdentity = (_name, cert) => checkServerIdentity(literal, cert);
    return ssl;
  };

  if (production) {
    if (allowSelfSigned) {
      throw new PgConfigError('PG_SSL_ALLOW_SELF_SIGNED=true is refused in production: the server certificate must be verified.');
    }
    if (sslmode === null || sslmode === 'require' || sslmode === 'verify-full') return verifyFull();
    throw new PgConfigError(
      `${label} declares sslmode=${sslmode}, which production refuses. Use sslmode=verify-full (or require, treated as verify-full); TLS with certificate and host-name verification is required.`,
    );
  }

  switch (sslmode) {
    case 'disable':
      if (caPem) throw new PgConfigError(`${label} declares sslmode=disable while ${settings.caSource ?? 'a CA'} is set. Remove one of them.`);
      return false;
    case 'allow':
    case 'prefer':
      throw new PgConfigError(
        `${label} declares sslmode=${sslmode}. node-postgres cannot fall back between TLS and plaintext, so the outcome would not match the declaration. Use disable, require or verify-full.`,
      );
    case 'no-verify':
      if (!allowSelfSigned) {
        throw new PgConfigError(`${label} declares sslmode=no-verify. Outside production that needs PG_SSL_ALLOW_SELF_SIGNED=true; production never accepts it.`);
      }
      return { rejectUnauthorized: false };
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return allowSelfSigned ? { rejectUnauthorized: false } : verifyFull();
    case null:
      return caPem ? verifyFull() : false;
  }
}

/** Short, credential-free description for the boot log line. */
export function describePgSsl(ssl: PgSsl): string {
  if (ssl === false) return 'off';
  if (ssl.rejectUnauthorized === false) return 'on (self-signed accepted)';
  return ssl.ca ? 'verify-full (configured CA)' : 'verify-full (system CA)';
}
