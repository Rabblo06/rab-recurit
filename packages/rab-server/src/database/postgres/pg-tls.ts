/**
 * Phase B (B2): the ONE place the `ssl` option for a PostgreSQL connection is decided.
 *
 * The object is built from configuration only — the URL's `sslmode` is read as a declaration, never handed to pg — and
 * the factory never passes the URL itself to the driver, so nothing can override it (pg 8.23 lets URL ssl parameters
 * replace a code-built `ssl` object wholesale; see pg-url-policy.ts). The result is always explicit (`false` or an
 * object), so pg never falls back to `PGSSLMODE` either.
 *
 *   sslmode in URL   production                                   outside production
 *   (absent)         verify-full                                  no TLS, unless PG_SSL_CA_CERT_PATH is set (verify-full)
 *   disable          REFUSED                                      no TLS
 *   allow, prefer    REFUSED                                      REFUSED (pg cannot fall back between TLS and plaintext)
 *   require          verify-full                                  verify-full (self-signed accepted with the flag)
 *   verify-ca        REFUSED (weaker than verify-full)            verify-full (self-signed accepted with the flag)
 *   verify-full      verify-full                                  verify-full (self-signed accepted with the flag)
 *   no-verify        REFUSED                                      only with PG_SSL_ALLOW_SELF_SIGNED=true
 *
 * verify-full = `{ rejectUnauthorized: true }` with Node's default `checkServerIdentity` (certificate chain AND host name),
 * CA from PG_SSL_CA_CERT_PATH when set, otherwise the system store. pg sends SNI for a DNS host name; with an IP-literal
 * host the certificate must carry that IP as a SAN. PG_SSL_ALLOW_SELF_SIGNED=true (`rejectUnauthorized: false`) is
 * refused in production. Note `require` is deliberately STRONGER here than libpq's `require` (which does not verify):
 * pg 8 already treats it as verify-full, and pg 9 announces it will weaken it, so the mapping is pinned here instead.
 */
import * as fs from 'fs';
import type { ConnectionOptions } from 'tls';

import { PgConfigError, PgSslMode } from './pg-url-policy';

export interface PgTlsSettings {
  production: boolean;
  /** PEM text read from PG_SSL_CA_CERT_PATH at boot, or null for the system CA store. */
  caPem: string | null;
  allowSelfSigned: boolean;
}

export type PgSsl = false | ConnectionOptions;

/** Reads and sanity-checks PG_SSL_CA_CERT_PATH at boot, not at first connect. The path is not echoed. */
export function readPgCaCertificate(caPath: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): string {
  let pem: string;
  try {
    pem = readFile(caPath);
  } catch {
    throw new PgConfigError('PG_SSL_CA_CERT_PATH is set but the file cannot be read. Refusing to start.');
  }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) {
    throw new PgConfigError('PG_SSL_CA_CERT_PATH does not contain a PEM certificate. Refusing to start.');
  }
  return pem;
}

/** Builds the explicit `ssl` value for one connection string. Throws PgConfigError on any refused combination. */
export function buildPgSsl(sslmode: PgSslMode | null, settings: PgTlsSettings, label: string): PgSsl {
  const { production, caPem, allowSelfSigned } = settings;
  const verifyFull = (): ConnectionOptions => (caPem ? { rejectUnauthorized: true, ca: caPem } : { rejectUnauthorized: true });

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
      if (caPem) throw new PgConfigError(`${label} declares sslmode=disable while PG_SSL_CA_CERT_PATH is set. Remove one of them.`);
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
