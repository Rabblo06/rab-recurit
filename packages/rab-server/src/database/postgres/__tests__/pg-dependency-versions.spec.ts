import * as fs from 'fs';
import * as path from 'path';

// The TLS policy (pg-tls.ts, pg-url-policy.ts; THREAT-MODEL.md "SSL like Twenty", TLS-1 / TLS-2) depends on how these exact
// driver versions behave: how pg-connection-string turns sslmode and the other URL parameters into config keys, that pg merges
// the parsed URL LAST (so URL ssl parameters would replace a code-built `ssl` object; the factory never hands pg the URL), and
// how pg reaches Node's TLS. The code builds verify-full explicitly whatever the driver does with sslmode, but the proof that
// a wrong CA and a wrong host name are refused is a real handshake against THESE versions: pg-tls-ca.integration.spec.ts
// ("DENIAL: a WRONG CA is refused", "DENIAL: the right CA but a host name the certificate does not carry is refused", for
// sslmode=require and verify-ca, each with and without channel_binding=require). Any change here, an upgrade through
// yarn.lock included, must re-run those denial tests and update this record and THREAT-MODEL.md together.
//
// Read from each package's own package.json, found the way the code finds the package: `pg` as rab-server resolves it,
// and its dependencies from pg's own directory (as pg-url-policy.ts resolves pg-connection-string). The three pg-*
// packages do not export ./package.json, so the file is found by walking up from the resolved entry point.
const RECORDED_VERSIONS = {
  pg: '8.23.0',
  'pg-pool': '3.14.0',
  'pg-connection-string': '2.14.0',
  'pg-protocol': '1.16.0',
} as const;

type RecordedPackage = keyof typeof RECORDED_VERSIONS;

function ownPackageJson(name: string, entry: string): { file: string; version: string } {
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (manifest.name === name && typeof manifest.version === 'string') return { file, version: manifest.version };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json named ${name} above ${entry}`);
    dir = parent;
  }
}

function installedVersions(): Record<RecordedPackage, { file: string; version: string }> {
  const pg = ownPackageJson('pg', require.resolve('pg'));
  const fromPg = { paths: [path.dirname(pg.file)] };
  return {
    pg,
    'pg-pool': ownPackageJson('pg-pool', require.resolve('pg-pool', fromPg)),
    'pg-connection-string': ownPackageJson('pg-connection-string', require.resolve('pg-connection-string', fromPg)),
    'pg-protocol': ownPackageJson('pg-protocol', require.resolve('pg-protocol', fromPg)),
  };
}

describe('the pg driver versions the TLS policy was proved against', () => {
  it('the installed pg, pg-pool, pg-connection-string and pg-protocol are exactly the recorded versions', () => {
    const installed = installedVersions();
    const drift = (Object.keys(RECORDED_VERSIONS) as RecordedPackage[])
      .filter((name) => installed[name].version !== RECORDED_VERSIONS[name])
      .map((name) => `${name}: recorded ${RECORDED_VERSIONS[name]}, installed ${installed[name].version} (${installed[name].file})`);
    if (drift.length > 0) {
      throw new Error(
        `pg driver versions changed: ${drift.join('; ')}. ` +
          're-run the TLS denial integration tests (pg-tls-ca.integration.spec.ts) and update the record ' +
          '(RECORDED_VERSIONS here, and the pinned-versions entry in THREAT-MODEL.md next to TLS-1 / TLS-2).',
      );
    }
  });
});
