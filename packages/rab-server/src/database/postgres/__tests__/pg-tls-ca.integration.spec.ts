import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

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
const describeDb = integrationTestDatabaseReady() ? describe : describe.skip;

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

/** A TLS-only PostgreSQL front: SSLRequest → 'S' → TLS (key/cert) → the real server, decrypted. */
function startTlsFront(key: string, cert: string, upstream: { host: string; port: number }): Promise<TlsFront> {
  const front: TlsFront = { port: 0, secured: 0, plaintext: 0, close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
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
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      front.port = (server.address() as net.AddressInfo).port;
      front.close = () =>
        new Promise<void>((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        });
      resolve(front);
    });
  });
}

describeDb('PG_SSL_CA_CERT against a PostgreSQL behind a private / self-signed certificate (production rules)', () => {
  let dir: string;
  let caPem: string;
  let otherCaPem: string;
  let selfSignedPem: string;
  let caFront: TlsFront;
  let selfSignedFront: TlsFront;
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
  });

  afterAll(async () => {
    await caFront?.close();
    await selfSignedFront?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const urlFor = (host: string, port: number) =>
    `postgresql://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${host}:${port}/${encodeURIComponent(creds.database)}?sslmode=verify-full`;
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
    expect(e.code ?? e.message).toMatch(/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|unable to get local issuer/i);
  });

  it('DENIAL: the wrong CA is refused', async () => {
    const e = await connectError(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: otherCaPem }));
    expect(e.code ?? e.message).toMatch(/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to get local issuer/i);
    const self = await connectError(prodEnv(urlFor('localhost', selfSignedFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(self.code ?? self.message).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed/i);
  });

  it('DENIAL: host-name verification stays on — the right CA but a host the certificate does not name is refused', async () => {
    // The certificate names DNS:localhost only; dialling 127.0.0.1 is exactly the "IP address / proxy host" mismatch.
    const e = await connectError(prodEnv(urlFor('127.0.0.1', caFront.port), { PG_SSL_CA_CERT: caPem }));
    expect(e.code ?? e.message).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate/i);
  });

  it('DENIAL: both CA variables set refuses before any connection is attempted', () => {
    const before = caFront.secured + caFront.plaintext;
    expect(() => resolvePgEnvironment(prodEnv(urlFor('localhost', caFront.port), { PG_SSL_CA_CERT: caPem, PG_SSL_CA_CERT_PATH: path.join(dir, 'ca.crt') }), { processRole: 'api' })).toThrow(
      /PG_SSL_CA_CERT and PG_SSL_CA_CERT_PATH are both set/,
    );
    expect(caFront.secured + caFront.plaintext).toBe(before);
  });
});
