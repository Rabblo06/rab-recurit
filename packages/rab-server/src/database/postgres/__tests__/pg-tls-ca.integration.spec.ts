import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

import { assertTlsGate, BOOT_FACTS_SQL, DatabaseBootGateError, parseBootFacts } from '../../boot-checks/database-boot-gate-rules';
import { clientTlsOf } from '../../boot-checks/database-boot-gates';
import { createPgClient } from '../create-pg-pool';
import { resolvePgEnvironment } from '../pg-config';
import { integrationTestDatabaseReady } from '../../typeorm/core/integration-test-database-gate';

// PG_SSL_CA_CERT end to end: a real pg Client from the factory, through a real TLS handshake, to the disposable test
// PostgreSQL, under the PRODUCTION rules (verify-full required). The server side is a TLS front made here the way the
// bundled `db` service makes its own (docker-compose.image.yml): a private CA (openssl, EC P-256, CA:TRUE) and a server
// certificate it signs for DNS:localhost only, plus a self-signed leaf for the "self-hosted server" case. The front speaks
// PostgreSQL's own SSLRequest negotiation (answers 'S', then TLS) and refuses any plaintext start (like `hostssl` only),
// then forwards the decrypted stream to TEST_DATABASE_URL's server. So every assertion is about the CLIENT side, which is
// what PG_SSL_CA_CERT changes: which root is trusted, with host-name verification still on.
const appUrl = process.env.TEST_DATABASE_URL;
// FAIL, never skip, without its database: the gate throws (TestDatabaseConfigError) instead of returning false, and the
// suite is a plain describe. ci-server.yaml runs it in the job that owns the disposable PostgreSQL; a missing openssl
// fails beforeAll the same way. The fronts listen on 127.0.0.1 AND ::1 on one port, so "localhost" works whichever address
// family the resolver returns first (no reliance on net.connect's autoSelectFamily fallback).
integrationTestDatabaseReady();

const SSL_REQUEST_CODE = 80877103;

interface TlsFront {
  port: number;
  /** TLS sessions completed (the client verified the certificate and finished the handshake). */
  secured: number;
  /** Connections that started without TLS (refused). */
  plaintext: number;
  close: () => Promise<void>;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

/**
 * A TLS-only PostgreSQL front: SSLRequest → 'S' → TLS (key/cert; `cert` may carry the chain) → the real server, decrypted.
 * Listens on 127.0.0.1 and on ::1, same port.
 */
function startTlsFront(key: string, cert: string, upstream: { host: string; port: number }): Promise<TlsFront> {
  const front: TlsFront = { port: 0, secured: 0, plaintext: 0, close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const handler = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', (first) => {
      if (first.length !== 8 || first.readInt32BE(0) !== 8 || first.readInt32BE(4) !== SSL_REQUEST_CODE) {
        front.plaintext += 1;
        socket.destroy();
        return;
      }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      secure.on('error', () => socket.destroy());
      secure.once('secure', () => {
        front.secured += 1;
        const db = net.connect(upstream.port, upstream.host);
        sockets.add(db);
        db.on('close', () => sockets.delete(db));
        db.on('error', () => secure.destroy());
        secure.pipe(db).pipe(secure);
      });
    });
  };
  const v4 = net.createServer(handler);
  const v6 = net.createServer(handler);
  const listen = (server: net.Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  front.close = () =>
    new Promise<void>((done) => {
      for (const s of sockets) s.destroy();
      let open = 2;
      const one = () => {
        open -= 1;
        if (open === 0) done();
      };
      for (const server of [v4, v6]) {
        if (server.listening) server.close(one);
        else one();
      }
    });
  return (async () => {
    await listen(v4, 0, '127.0.0.1');
    front.port = (v4.address() as net.AddressInfo).port;
    // ::1 on the same port. No IPv6 loopback on the runner fails the suite (it is never silently narrowed to IPv4).
    await listen(v6, front.port, '::1');
    return front;
  })();
}

describe('PG_SSL_CA_CERT against a PostgreSQL behind a private / self-signed certificate (production rules)', () => {
  let dir: string;
  let caPem: string;
  let otherCaPem: string;
  let selfSignedPem: string;
  let caFront: TlsFront;
  let selfSignedFront: TlsFront;
  let ipFront: TlsFront;
  let ip6Front: TlsFront;
  let chainFront: TlsFront;
  let leafOnlyFront: TlsFront;
  let intermediatePem: string;
  let creds: { user: string; password: string; database: string };

  beforeAll(async () => {
    const url = new URL(String(appUrl));
    creds = { user: url.username, password: url.password, database: url.pathname.slice(1) };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tls-ca-'));
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    // The bundled db's pattern: a CA, then a server certificate signed by it for one DNS name.
    openssl(['req', '-x509', '-new', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=crewflow test db CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], dir);
    openssl(['req', '-new', ...ec, '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost'], dir);
    fs.writeFileSync(path.join(dir, 'server.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext'], dir);
    // The same CA, a server certificate for an IP address (IP SAN 127.0.0.1 only).
    openssl(['req', '-new', ...ec, '-keyout', 'server-ip.key', '-out', 'server-ip.csr', '-subj', '/CN=127.0.0.1'], dir);
    fs.writeFileSync(path.join(dir, 'server-ip.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'server-ip.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server-ip.crt', '-days', '2', '-extfile', 'server-ip.ext'], dir);
    // The same CA, a server certificate for the IPv6 loopback (IP SAN ::1 only).
    openssl(['req', '-new', ...ec, '-keyout', 'server-ip6.key', '-out', 'server-ip6.csr', '-subj', '/CN=ip6'], dir);
    fs.writeFileSync(path.join(dir, 'server-ip6.ext'), 'subjectAltName=IP:::1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n');
    openssl(['x509', '-req', '-in', 'server-ip6.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server-ip6.crt', '-days', '2', '-extfile', 'server-ip6.ext'], dir);
    // A chain: the root CA signs an intermediate CA (pathlen 0), which signs the server certificate (DNS:localhost).
    openssl(['req', '-new', ...ec, '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=crewflow test intermediate CA'], dir);
    fs.writeFileSync(path.join(dir, 'int.ext'), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
    openssl(['x509', '-req', '-in', 'int.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'int.crt', '-days', '2', '-extfile', 'int.ext'], dir);
    openssl(['req', '-new', ...ec, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost'], dir);
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'server.ext'], dir);
    // An unrelated CA (the wrong root).
    openssl(['req', '-x509', '-new', ...ec, '-keyout', 'other.key', '-out', 'other.crt', '-days', '2', '-subj', '/CN=some other CA',
      '-addext', 'basicConstraints=critical,CA:TRUE'], dir);
    // A self-hosted server's self-signed certificate (no separate CA), with the right name.
    openssl(['req', '-x509', '-new', ...ec, '-keyout', 'self.key', '-out', 'self.crt', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-addext', 'extendedKeyUsage=serverAuth'], dir);
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    caPem = read('ca.crt');
    otherCaPem = read('other.crt');
    selfSignedPem = read('self.crt');
    const upstream = { host: url.hostname, port: Number(url.port || 5432) };
    caFront = await startTlsFront(read('server.key'), read('server.crt'), upstream);
    selfSignedFront = await startTlsFront(read('self.key'), selfSignedPem, upstream);
    ipFront = await startTlsFront(read('server-ip.key'), read('server-ip.crt'), upstream);
    ip6Front = await startTlsFront(read('server-ip6.key'), read('server-ip6.crt'), upstream);
    intermediatePem = read('int.crt');
    // The server sends leaf + intermediate (the usual deployment) / the leaf only (the client's bundle must hold the rest).
    chainFront = await startTlsFront(read('leaf.key'), read('leaf.crt') + intermediatePem, upstream);
    leafOnlyFront = await startTlsFront(read('leaf.key'), read('leaf.crt'), upstream);
  });

  afterAll(async () => {
    await caFront?.close();
    await selfSignedFront?.close();
    await ipFront?.close();
    await ip6Front?.close();
    await chainFront?.close();
    await leafOnlyFront?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const urlFor = (host: string, port: number, query = 'sslmode=verify-full') =>
    `postgresql://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${host}:${port}/${encodeURIComponent(creds.database)}?${query}`;
  const prodEnv = (url: string, extra: Record<string, string>) => ({ NODE_ENV: 'production', PG_DATABASE_URL: url, ...extra });

  async function connectAndQuery(env: Record<string, string>): Promise<{ user: string; encrypted: boolean; authorized: boolean }> {
    const client = createPgClient(resolvePgEnvironment(env, { processRole: 'api' }), { purpose: 'tls-check', statementTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
    await client.connect();
    try {
      const { rows } = await client.query<{ user: string }>('SELECT current_user AS "user"');
      const stream = (client as unknown as { connection: { stream: tls.TLSSocket } }).connection.stream;
      return { user: rows[0]?.user ?? '', encrypted: stream.encrypted === true, authorized: stream.authorized === true };
    } finally {
      await client.end();
    }
  }

  async function connectError(env: Record<string, string>): Promise<{ code?: string; message: string }> {
    const client = createPgClient(resolvePgEnvironment(env, { processRole: 'api' }), { purpose: 'tls-check', connectTimeoutMs: 5_000 });
    try {
      await client.connect();
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end().catch(() => undefined);
    }
    throw new Error('expected the TLS handshake to be refused');
  }

  it('verify-full succeeds with the private CA given as PEM text, and the session really is TLS, verified', async () => {
    const before = caFront.secured;
    const r = await connectAndQuery(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(r).toEqual({ user: creds.user, encrypted: true, authorized: true });
    expect(caFront.secured).toBe(before + 1);
    expect(caFront.plaintext).toBe(0);
  });

  it('the one-line `\\n`-escaped form (an env file or a platform UI) works the same', async () => {
    const oneLine = caPem.trim().split(/\r?\n/).join('\\n');
    expect((await connectAndQuery(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: oneLine }))).authorized).toBe(true);
  });

  it('the same CA through PG_SSL_CA_CERT_PATH behaves identically', async () => {
    expect((await connectAndQuery(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT_PATH: path.join(dir, 'ca.crt') }))).authorized).toBe(true);
  });

  it("a self-hosted server's self-signed certificate, given as PG_SSL_CA_CERT, verifies (verify-full, no relaxation)", async () => {
    expect((await connectAndQuery(prodEnv(urlFor('localhost', selfSignedFront.port), { PG_SSL_CA_CERT: selfSignedPem }))).authorized).toBe(true);
  });

  it('DENIAL: without the CA (system store only) the private certificate is refused', async () => {
    const e = await connectError(prodEnv(urlFor('localhost', caFront.port), {}));
    expect(e.code ?? e.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|unable to (verify the first|get local issuer)/i);
  });

  it('DENIAL: the wrong CA is refused', async () => {
    const e = await connectError(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: otherCaPem }));
    expect(e.code ?? e.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to (verify the first|get local issuer)/i);
    const self = await connectError(prodEnv(urlFor('localhost', selfSignedFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(self.code ?? self.message).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed/i);
  });

  it('DENIAL: host-name verification stays on — the right CA but a host the certificate does not name is refused', async () => {
    // The certificate names DNS:localhost only; dialling 127.0.0.1 is exactly the "IP address / proxy host" mismatch.
    // REGRESSION (found here): before pg-tls.ts bound the check to the IP, pg + Node verified an IP host against
    // "localhost", so this certificate was ACCEPTED for 127.0.0.1.
    const e = await connectError(prodEnv(urlFor('127.0.0.1', caFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(e.code ?? e.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate/i);
  });

  it('an IP-address host verifies against the IP SAN (the check is bound to the IP, not to "localhost")', async () => {
    expect((await connectAndQuery(prodEnv(urlFor('127.0.0.1', ipFront.port), { PG_SSL_CA_CERT: caPem }))).authorized).toBe(true);
  });

  it('IPv6: [::1] verifies against an IP SAN ::1, and a localhost-only certificate is refused for it', async () => {
    expect((await connectAndQuery(prodEnv(urlFor('[::1]', ip6Front.port), { PG_SSL_CA_CERT: caPem }))).authorized).toBe(true);
    const e = await connectError(prodEnv(urlFor('[::1]', caFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(e.code ?? e.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate/i);
  });

  it('a leaf + intermediate chain verifies against the root alone, and a leaf-only server against a root + intermediate bundle', async () => {
    expect((await connectAndQuery(prodEnv(urlFor('localhost', chainFront.port), { PG_SSL_CA_CERT: caPem }))).authorized).toBe(true);
    expect((await connectAndQuery(prodEnv(urlFor('localhost', leafOnlyFront.port), { PG_SSL_CA_CERT: caPem + intermediatePem }))).authorized).toBe(true);
    // DENIAL: a leaf-only server and the root alone (the intermediate is missing on both sides).
    const e = await connectError(prodEnv(urlFor('localhost', leafOnlyFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(e.code ?? e.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to (verify the first|get local issuer)/i);
  });

  // Owner decision 2026-11-19 ("SSL like Twenty"): production accepts sslmode=require and verify-ca as well, and enforces them
  // EXACTLY like verify-full (certificate chain AND host name), as node-pg treats require. Proved through a real handshake:
  // libpq's `require` would accept every one of the DENIAL cases below (it does not verify), and libpq's `verify-ca` would
  // accept the wrong-host one.
  describe.each([
    ['sslmode=require'],
    ['sslmode=verify-ca'],
    ['sslmode=require&channel_binding=require'],
    ['sslmode=verify-ca&channel_binding=require'],
  ])('%s is full verification, like verify-full', (query) => {
    it('the right CA and a host the certificate names: connects, and the session is TLS, verified', async () => {
      const before = caFront.secured;
      const r = await connectAndQuery(prodEnv(urlFor('localhost', caFront.port, query), { PG_SSL_CA_CERT: caPem }));
      expect(r).toEqual({ user: creds.user, encrypted: true, authorized: true });
      expect(caFront.secured).toBe(before + 1);
      expect(caFront.plaintext).toBe(0);
    });

    it('DENIAL: a WRONG CA is refused (an unrelated root; a self-signed server against the private CA; the system store only)', async () => {
      const wrong = await connectError(prodEnv(urlFor('localhost', caFront.port, query), { PG_SSL_CA_CERT: otherCaPem }));
      expect(wrong.code ?? wrong.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to (verify the first|get local issuer)/i);
      const self = await connectError(prodEnv(urlFor('localhost', selfSignedFront.port, query), { PG_SSL_CA_CERT: caPem }));
      expect(self.code ?? self.message).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed/i);
      const none = await connectError(prodEnv(urlFor('localhost', caFront.port, query), {}));
      expect(none.code ?? none.message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|unable to (verify the first|get local issuer)/i);
    });

    it('DENIAL: the right CA but a host name the certificate does not carry is refused (127.0.0.1 and ::1 vs DNS:localhost)', async () => {
      const v4 = await connectError(prodEnv(urlFor('127.0.0.1', caFront.port, query), { PG_SSL_CA_CERT: caPem }));
      expect(v4.code ?? v4.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate/i);
      const v6 = await connectError(prodEnv(urlFor('[::1]', caFront.port, query), { PG_SSL_CA_CERT: caPem }));
      expect(v6.code ?? v6.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate/i);
    });
  });

  it('DENIAL: production refuses sslmode=disable, allow, prefer, no-verify and a missing sslmode before any connection is attempted', () => {
    const before = caFront.secured + caFront.plaintext;
    for (const query of ['sslmode=disable', 'sslmode=allow', 'sslmode=prefer', 'sslmode=no-verify', 'application_name=no-sslmode']) {
      expect(() => resolvePgEnvironment(prodEnv(urlFor('localhost', caFront.port, query), { PG_SSL_CA_CERT: caPem }), { processRole: 'api' })).toThrow(
        /must set sslmode=require, verify-ca or verify-full in production/,
      );
    }
    expect(caFront.secured + caFront.plaintext).toBe(before);
  });

  // Gate 6, provider-neutral (owner instruction 2026-11-19: "trust our side of the connection"). The TLS front above is
  // exactly a TLS-terminating proxy in front of plain PostgreSQL: the backend's pg_stat_ssl says ssl=false. The gate's
  // decision is taken here on the real facts of a real session: the BOOT_FACTS_SQL row and the pg client's own socket.
  async function gate6On(env: Record<string, string>, production: boolean): Promise<{ ssl: unknown; warnings?: string[]; refusal?: string }> {
    const resolved = resolvePgEnvironment(env, { processRole: 'api' });
    const client = createPgClient(resolved, { purpose: 'tls-check', statementTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
    await client.connect();
    try {
      const [row] = (await client.query(BOOT_FACTS_SQL)).rows as Array<Record<string, unknown>>;
      const facts = parseBootFacts(row);
      try {
        return { ssl: facts.ssl, warnings: assertTlsGate(facts, production, { clientTls: clientTlsOf(client, resolved.primary.ssl) }) };
      } catch (error) {
        if (!(error instanceof DatabaseBootGateError)) throw error;
        return { ssl: facts.ssl, refusal: error.message };
      }
    } finally {
      await client.end();
    }
  }

  it('gate 6: behind a TLS-terminating proxy (backend pg_stat_ssl.ssl=false), verified client TLS is accepted in production', async () => {
    for (const query of ['sslmode=require', 'sslmode=verify-ca', 'sslmode=verify-full']) {
      const r = await gate6On(prodEnv(urlFor('localhost', caFront.port, query), { PG_SSL_CA_CERT: caPem }), true);
      expect(r.ssl).toBe(false);
      expect(r.refusal).toBeUndefined();
      expect((r.warnings ?? []).join(' ')).toMatch(/verified TLS on the client side/);
    }
  });

  it('gate 6 DENIAL: the same proxy with UNVERIFIED client TLS (self-signed accepted, outside production) is refused by the production rule', async () => {
    const env = { NODE_ENV: 'test', PG_DATABASE_URL: urlFor('localhost', selfSignedFront.port, 'sslmode=require'), PG_SSL_ALLOW_SELF_SIGNED: 'true' };
    const r = await gate6On(env, true);
    expect(r.ssl).toBe(false);
    // Review L-1: an unverified client config is refused up front (the message names the missing verification).
    expect(r.refusal).toMatch(/does not verify the server certificate and host name/);
  });

  it('DENIAL: both CA variables set refuses before any connection is attempted', () => {
    const before = caFront.secured + caFront.plaintext;
    expect(() => resolvePgEnvironment(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: caPem, PG_SSL_CA_CERT_PATH: path.join(dir, 'ca.crt') }), { processRole: 'api' })).toThrow(
      /PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH are both set/,
    );
    expect(caFront.secured + caFront.plaintext).toBe(before);
  });
});
