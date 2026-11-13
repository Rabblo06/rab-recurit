import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parsePgUrl } from '../postgres/pg-url-policy';
import { scramVerifier } from '../typeorm/scripts/twenty-mode-check';

import {
  buildRuntimeDatabaseUrl,
  deriveOwnerPassword,
  isOwnerLoginUrl,
  OWNER_CREDENTIAL_MESSAGES,
  OWNER_LOGIN,
  OWNER_PASSWORD_HKDF_INFO,
  OwnerCredentialError,
  planOwnerLogin,
  scramSha256Verifier,
} from './owner-credential';

/**
 * DB-SETUP-PLAN §4, §5.1, §10 B10. Every secret below is a generated test value; no assertion message prints one.
 */
const APP_SECRET = 'crewflow-test-vector-app-secret-0123456789';
const ADMIN_PASSWORD = 'adminSentinel7f3a';
const DERIVED = deriveOwnerPassword(APP_SECRET);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnerCredentialError) return error.message;
    throw error;
  }
  throw new Error('expected an OwnerCredentialError');
}

/** RFC 5869 HKDF-SHA256 written out with HMAC only, independent of node's hkdfSync. */
function referenceHkdf(
  ikm: Buffer,
  salt: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  const prk = createHmac('sha256', salt.length ? salt : Buffer.alloc(32))
    .update(ikm)
    .digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([i])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** The documented HKDF info label (DB-SETUP-PLAN §4), spelled out for the independent reference check. */
const OWNER_LABEL_LITERAL = 'crewflow-owner-db-password-v1';

describe('deriveOwnerPassword (HKDF-SHA256, §4)', () => {
  it('matches fixed vectors', () => {
    expect(deriveOwnerPassword(APP_SECRET)).toBe(
      'a8004daf794dd15df01b5788f54e1aac22c533385d1caf5cdc6ec112b40ffc09',
    );
    expect(deriveOwnerPassword('0123456789abcdef0123456789abcdef')).toBe(
      'fa6eee1b378ce8152c28f011e6843db0d3a2ce9246ecefe2016f10d3a1d06bec',
    );
  });

  it('is RFC 5869 HKDF with an empty salt and the owner label (vectors from an independent HMAC implementation)', () => {
    // These vectors were computed with the RFC 5869 reference implementation below (referenceHkdf, itself checked against
    // RFC 5869 test case 3) and the documented label; recomputing them here would feed a password-labelled derivation into
    // a plain HMAC, which CodeQL reports as an insecure password hash (PR #125 review), so they are pinned instead.
    expect(OWNER_PASSWORD_HKDF_INFO).toBe(OWNER_LABEL_LITERAL);
    const vectors: Array<[string, string]> = [
      [APP_SECRET, 'a8004daf794dd15df01b5788f54e1aac22c533385d1caf5cdc6ec112b40ffc09'],
      ['x'.repeat(32), '1f469d6e59903c1c658a49e25521157e7ac39423e2bb9930b57cec1505ee3998'],
      ['ünïcödé-secret-with-multibyte-chars-✓✓✓', '130fbff403cdb14f620c810299661cdf605ac343ff919ee50561509f2c84a084'],
    ];
    for (const [input, expected] of vectors) expect(deriveOwnerPassword(input) === expected).toBe(true);
  });

  it('reference HKDF reproduces RFC 5869 test case 3 (empty salt, empty info)', () => {
    const okm = referenceHkdf(
      Buffer.alloc(22, 0x0b),
      Buffer.alloc(0),
      Buffer.alloc(0),
      42,
    ).toString('hex');
    expect(okm).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('is 64 lowercase hex, deterministic, and different per APP_SECRET', () => {
    expect(/^[0-9a-f]{64}$/.test(DERIVED)).toBe(true);
    expect(deriveOwnerPassword(APP_SECRET) === DERIVED).toBe(true);
    expect(deriveOwnerPassword(`${APP_SECRET}!`) === DERIVED).toBe(false);
  });

  it('refuses a missing or short APP_SECRET with the environment-validation messages', () => {
    expect(refusal(() => deriveOwnerPassword(undefined))).toBe(
      'APP_SECRET is required — the process must not start without it',
    );
    expect(refusal(() => deriveOwnerPassword(null))).toBe(
      OWNER_CREDENTIAL_MESSAGES.appSecretMissing,
    );
    expect(refusal(() => deriveOwnerPassword(''))).toBe(
      OWNER_CREDENTIAL_MESSAGES.appSecretMissing,
    );
    expect(refusal(() => deriveOwnerPassword('y'.repeat(31)))).toBe(
      'APP_SECRET must be at least 32 characters',
    );
    expect(() => deriveOwnerPassword('y'.repeat(32))).not.toThrow();
  });

  it('keeps the same messages as environment-variables.ts', () => {
    const envSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../engine/core-modules/environment/environment-variables.ts',
      ),
      'utf8',
    );
    expect(envSource).toContain(
      `'${OWNER_CREDENTIAL_MESSAGES.appSecretMissing}'`,
    );
    expect(envSource).toContain(
      `'${OWNER_CREDENTIAL_MESSAGES.appSecretShort}'`,
    );
    expect(envSource).toMatch(
      /@MinLength\(32, \{ message: 'APP_SECRET must be at least 32 characters' \}\)/,
    );
  });
});

/**
 * Label separation (§4): every `hkdfSync(` call site in packages/<pkg>/src is found, its `info` argument resolved to its
 * static label (or the static prefix before a runtime interpolation), and labels from DIFFERENT call-site families must be
 * pairwise distinct with neither a prefix of the other. A new call site fails this test until it is added here, reviewed.
 */
describe('HKDF label separation across the repository', () => {
  const PACKAGES = path.resolve(__dirname, '../../../../');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('dist'))
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (
        /\.(ts|tsx|js|cjs|mjs)$/.test(entry.name) &&
        !/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name) &&
        !full.includes(`${path.sep}__tests__${path.sep}`)
      ) {
        out.push(full);
      }
    }
    return out;
  }

  function callArguments(source: string, open: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        if (depth === 1) continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          args.push(current.trim());
          return args;
        }
      }
      if (ch === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    throw new Error('unbalanced hkdfSync call');
  }

  function resolveLabel(arg: string, source: string): string {
    const constant = (name: string): string => {
      const m = new RegExp(
        `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*'([^']*)'`,
      ).exec(source);
      if (!m) throw new Error(`cannot resolve HKDF label constant ${name}`);
      return m[1];
    };
    if (/^'[^']*'$/.test(arg)) return arg.slice(1, -1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(arg)) return constant(arg);
    if (/^`.*`$/.test(arg)) {
      // Static prefix: resolve leading ${CONSTANT} parts, stop at the first runtime interpolation.
      let body = arg.slice(1, -1);
      let label = '';
      while (body.length) {
        const interp = /^\$\{([^}]+)\}/.exec(body);
        if (interp) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(interp[1])) break;
          label += constant(interp[1]);
          body = body.slice(interp[0].length);
        } else {
          const literal = /^[^$]+/.exec(body);
          if (!literal) break;
          label += literal[0];
          body = body.slice(literal[0].length);
        }
      }
      return label;
    }
    throw new Error(`unrecognised HKDF info argument: ${arg}`);
  }

  const sites: { file: string; label: string }[] = [];
  for (const pkg of fs.readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, 'src');
    if (!fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const source = fs.readFileSync(file, 'utf8');
      const re = /hkdfSync\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) {
        const args = callArguments(source, m.index + 'hkdfSync'.length).filter(
          (a) => a !== '',
        ); // trailing comma
        if (args.length !== 5)
          throw new Error(`unexpected hkdfSync call shape in ${file}`);
        sites.push({
          file: path.relative(PACKAGES, file).split(path.sep).join('/'),
          label: resolveLabel(args[3], source),
        });
      }
    }
  }

  it('finds exactly the reviewed call sites', () => {
    expect(sites.map((s) => `${s.file} ${s.label}`).sort()).toEqual(
      [
        'rab-server/src/database/owner-login/owner-credential.ts crewflow-owner-db-password-v1',
        'rab-server/src/engine/core-modules/secret-encryption/keyring.util.ts crewflow:key-purpose:v1:',
        'rab-server/src/engine/core-modules/secret-encryption/secret-encryption.service.ts rab-secret-encryption',
        'rab-server/src/engine/core-modules/secret-encryption/secret-encryption.service.ts rab-secret-encryption:',
        'rab-server/src/modules/attendance/services/qr-token.service.ts rab-qr-token-v1',
      ].sort(),
    );
  });

  it('labels of different call-site families are distinct and never a prefix of one another', () => {
    for (const a of sites) {
      for (const b of sites) {
        if (a.file === b.file) continue;
        expect({
          a: a.label,
          b: b.label,
          prefix: b.label.startsWith(a.label),
        }).toEqual({ a: a.label, b: b.label, prefix: false });
      }
    }
  });

  it('the owner label is unique against every other label', () => {
    const others = sites
      .filter((s) => s.label !== OWNER_PASSWORD_HKDF_INFO)
      .map((s) => s.label);
    expect(
      sites.filter((s) => s.label === OWNER_PASSWORD_HKDF_INFO),
    ).toHaveLength(1);
    for (const other of others) {
      expect(
        other.startsWith(OWNER_PASSWORD_HKDF_INFO) ||
          OWNER_PASSWORD_HKDF_INFO.startsWith(other),
      ).toBe(false);
    }
  });
});

describe('scramSha256Verifier', () => {
  /** RFC 7677 §3 example exchange: user "user", password "pencil". */
  const RFC = {
    password: 'pencil',
    salt: Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'),
    authMessage:
      'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
      'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
    clientProof: 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
    serverSignature: '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
  };

  function parseVerifier(v: string): {
    iterations: number;
    salt: Buffer;
    storedKey: Buffer;
    serverKey: Buffer;
  } {
    const m =
      /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(
        v,
      );
    if (!m) throw new Error('not a SCRAM-SHA-256 verifier');
    return {
      iterations: Number(m[1]),
      salt: Buffer.from(m[2], 'base64'),
      storedKey: Buffer.from(m[3], 'base64'),
      serverKey: Buffer.from(m[4], 'base64'),
    };
  }

  it('reproduces the RFC 7677 exchange (ServerSignature and ClientProof verify against the stored keys)', () => {
    const v = parseVerifier(scramSha256Verifier(RFC.password, RFC.salt));
    expect(v.iterations).toBe(4096);
    expect(v.salt.equals(RFC.salt)).toBe(true);
    const serverSignature = createHmac('sha256', v.serverKey)
      .update(RFC.authMessage)
      .digest('base64');
    expect(serverSignature).toBe(RFC.serverSignature);
    const clientSignature = createHmac('sha256', v.storedKey)
      .update(RFC.authMessage)
      .digest();
    const proof = Buffer.from(RFC.clientProof, 'base64');
    const clientKey = Buffer.from(
      proof.map((byte, i) => byte ^ clientSignature[i]),
    );
    expect(
      createHash('sha256').update(clientKey).digest().equals(v.storedKey),
    ).toBe(true);
  });

  it('uses a fresh 16-byte salt per call and is deterministic for a fixed salt', () => {
    const a = parseVerifier(scramSha256Verifier(DERIVED));
    const b = parseVerifier(scramSha256Verifier(DERIVED));
    expect(a.salt).toHaveLength(16);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(
      scramSha256Verifier(DERIVED, RFC.salt) ===
        scramSha256Verifier(DERIVED, RFC.salt),
    ).toBe(true);
  });

  it('never contains the password', () => {
    expect(scramSha256Verifier(DERIVED).includes(DERIVED)).toBe(false);
  });

  it('refuses an empty or non-printable-ASCII password and an empty salt', () => {
    expect(refusal(() => scramSha256Verifier(''))).toBe(
      OWNER_CREDENTIAL_MESSAGES.emptyScramPassword,
    );
    expect(refusal(() => scramSha256Verifier('pässword'))).toBe(
      OWNER_CREDENTIAL_MESSAGES.nonAsciiScramPassword,
    );
    expect(refusal(() => scramSha256Verifier('a\nb'))).toBe(
      OWNER_CREDENTIAL_MESSAGES.nonAsciiScramPassword,
    );
    expect(refusal(() => scramSha256Verifier('pencil', Buffer.alloc(0)))).toBe(
      OWNER_CREDENTIAL_MESSAGES.badScramSalt,
    );
  });

  it('twenty-mode-check keeps working through its scramVerifier name', () => {
    const v = parseVerifier(scramVerifier(DERIVED));
    expect(v.iterations).toBe(4096);
    expect(v.salt).toHaveLength(16);
  });
});

describe('buildRuntimeDatabaseUrl (§5.1)', () => {
  const admin = (rest: string, scheme = 'postgres') =>
    `${scheme}://neondb_owner:${ADMIN_PASSWORD}@${rest}`;

  it('keeps host, port, database and the allowed query; drops application_name; swaps the userinfo', () => {
    const url = buildRuntimeDatabaseUrl(
      admin(
        'db.example.internal:6000/crewflow?sslmode=verify-full&application_name=admin-tool&channel_binding=require&target_session_attrs=any&connect_timeout=10&keepalives=1',
      ),
      DERIVED,
    );
    expect(
      url ===
        `postgres://${OWNER_LOGIN}:${DERIVED}@db.example.internal:6000/crewflow?sslmode=verify-full&channel_binding=require&target_session_attrs=any&connect_timeout=10&keepalives=1`,
    ).toBe(true);
    expect(url.includes(ADMIN_PASSWORD) || url.includes('neondb_owner')).toBe(
      false,
    );
  });

  it('round-trips through parsePgUrl to the same target as crewflow_owner', () => {
    const source = admin(
      'db:5432/crewflow?sslmode=verify-full&channel_binding=prefer',
    );
    const a = parsePgUrl(source, 'PG_DATABASE_URL');
    const r = parsePgUrl(
      buildRuntimeDatabaseUrl(source, DERIVED),
      'PG_DATABASE_URL',
    );
    expect({
      host: r.host,
      port: r.port,
      database: r.database,
      sslmode: r.sslmode,
      channelBinding: r.channelBinding,
    }).toEqual({
      host: a.host,
      port: a.port,
      database: a.database,
      sslmode: a.sslmode,
      channelBinding: a.channelBinding,
    });
    expect(r.user).toBe(OWNER_LOGIN);
    expect(r.password === DERIVED).toBe(true);
  });

  it('writes the default port explicitly and keeps the postgresql scheme', () => {
    expect(
      buildRuntimeDatabaseUrl(admin('db/crewflow', 'postgresql'), DERIVED) ===
        `postgresql://${OWNER_LOGIN}:${DERIVED}@db:5432/crewflow`,
    ).toBe(true);
  });

  it('keeps an IPv6 host and a percent-encoded database name', () => {
    const url = buildRuntimeDatabaseUrl(admin('[::1]:5433/my%20db'), DERIVED);
    expect(
      url === `postgres://${OWNER_LOGIN}:${DERIVED}@[::1]:5433/my%20db`,
    ).toBe(true);
    expect(parsePgUrl(url, 'PG_DATABASE_URL').database).toBe('my db');
  });

  it("keeps a Neon endpoint options token naming the host's own endpoint", () => {
    const url = buildRuntimeDatabaseUrl(
      admin(
        'ep-cool-1234.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full&options=endpoint%3Dep-cool-1234',
      ),
      DERIVED,
    );
    expect(parsePgUrl(url, 'PG_DATABASE_URL').providerOptions).toBe(
      'endpoint=ep-cool-1234',
    );
  });

  it.each([
    [
      'sslrootcert',
      'db:5432/crewflow?sslmode=verify-full&sslrootcert=/etc/ca.pem',
    ],
    ['sslcert', 'db:5432/crewflow?sslcert=/tmp/c.pem'],
    ['a target override (?host=)', 'db:5432/crewflow?host=elsewhere'],
    ['an unknown parameter', 'db:5432/crewflow?search_path=x'],
    ['-c role options', 'db:5432/crewflow?options=-c%20role%3Dpostgres'],
    [
      'a repeated parameter',
      'db:5432/crewflow?sslmode=require&sslmode=disable',
    ],
  ])('refuses %s, without echoing the URL', (_name, rest) => {
    const message = refusal(() =>
      buildRuntimeDatabaseUrl(admin(rest), DERIVED),
    );
    expect(message).toMatch(/^PG_DATABASE_URL /);
    expect(
      message.includes(ADMIN_PASSWORD) ||
        message.includes('neondb_owner') ||
        message.includes(DERIVED),
    ).toBe(false);
  });

  it.each([
    [
      'Neon -pooler host',
      'ep-cool-1234-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',
    ],
    [
      'Supabase port 6543',
      'aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=verify-full',
    ],
    [
      'DigitalOcean pool port 25061',
      'db-x.ondigitalocean.com:25061/defaultdb?sslmode=verify-full',
    ],
  ])('refuses a transaction pooler admin URL (%s)', (_name, rest) => {
    expect(refusal(() => buildRuntimeDatabaseUrl(admin(rest), DERIVED))).toBe(
      OWNER_CREDENTIAL_MESSAGES.transactionPooler,
    );
  });

  it('refuses a malformed or missing URL without echoing it', () => {
    expect(refusal(() => buildRuntimeDatabaseUrl('', DERIVED))).toBe(
      OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing,
    );
    expect(
      refusal(() =>
        buildRuntimeDatabaseUrl(`mysql://u:${ADMIN_PASSWORD}@h/d`, DERIVED),
      ).includes(ADMIN_PASSWORD),
    ).toBe(false);
    expect(
      refusal(() =>
        buildRuntimeDatabaseUrl(`postgres://u:${ADMIN_PASSWORD}@/d`, DERIVED),
      ).includes(ADMIN_PASSWORD),
    ).toBe(false);
  });

  it('refuses an owner password that is not 64 lowercase hex (no string surgery with arbitrary text)', () => {
    for (const bad of [
      '',
      'short',
      DERIVED.toUpperCase(),
      `${DERIVED}0`,
      `${DERIVED.slice(0, 63)}@`,
    ]) {
      expect(
        refusal(() => buildRuntimeDatabaseUrl(admin('db/crewflow'), bad)),
      ).toBe(OWNER_CREDENTIAL_MESSAGES.badOwnerPassword);
    }
  });

  it('passes a crewflow_owner URL through byte for byte (the password argument is not used)', () => {
    for (const source of [
      `postgres://crewflow_owner:${ADMIN_PASSWORD}@db.example.internal/crewflow?sslmode=verify-full&application_name=keep-me`,
      `postgresql://crewflow_owner:p%40ss@[::1]:5433/Crew%20Flow`,
    ]) {
      expect(buildRuntimeDatabaseUrl(source, 'not-used') === source).toBe(true);
      expect(isOwnerLoginUrl(source)).toBe(true);
    }
  });

  it('still refuses a policy-invalid crewflow_owner URL (pass-through is not a policy bypass)', () => {
    expect(
      refusal(() =>
        buildRuntimeDatabaseUrl(
          'postgres://crewflow_owner:x@db/crewflow?sslrootcert=/x',
          DERIVED,
        ),
      ),
    ).toMatch(/sslrootcert/);
  });
});

describe('planOwnerLogin', () => {
  const ADMIN_URL = `postgres://doadmin:${ADMIN_PASSWORD}@db-x.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;

  it('bootstrap mode: admin target, runtime target as crewflow_owner with the derived password', () => {
    const plan = planOwnerLogin({
      databaseUrl: ADMIN_URL,
      appSecret: APP_SECRET,
    });
    if (plan.mode !== 'bootstrap') throw new Error('expected bootstrap');
    expect(plan.adminTarget.user).toBe('doadmin');
    expect(plan.runtimeTarget.user).toBe(OWNER_LOGIN);
    expect(plan.runtimeTarget.password === DERIVED).toBe(true);
    expect(plan.ownerPassword === DERIVED).toBe(true);
    expect(
      plan.runtimeUrl === buildRuntimeDatabaseUrl(ADMIN_URL, DERIVED),
    ).toBe(true);
    expect(plan.runtimeTarget.display).toBe(plan.adminTarget.display);
  });

  it('never serialises a secret', () => {
    const plan = planOwnerLogin({
      databaseUrl: ADMIN_URL,
      appSecret: APP_SECRET,
    });
    const text = JSON.stringify(plan);
    expect(text.includes(DERIVED) || text.includes(ADMIN_PASSWORD)).toBe(false);
    expect(Object.keys(plan).sort()).toEqual([
      'adminTarget',
      'mode',
      'runtimeTarget',
    ]);
  });

  it('pass-through mode: crewflow_owner URL unchanged, APP_SECRET not required', () => {
    const source = `postgres://crewflow_owner:${ADMIN_PASSWORD}@db/crewflow?sslmode=verify-full`;
    const plan = planOwnerLogin({ databaseUrl: source, appSecret: undefined });
    expect(plan.mode).toBe('pass-through');
    expect(plan.runtimeUrl === source).toBe(true);
    expect(JSON.stringify(plan).includes(ADMIN_PASSWORD)).toBe(false);
    expect(Object.keys(plan).sort()).toEqual(['mode', 'target']);
  });

  it('bootstrap mode needs APP_SECRET, a URL, and no pooler', () => {
    expect(
      refusal(() =>
        planOwnerLogin({ databaseUrl: ADMIN_URL, appSecret: undefined }),
      ),
    ).toBe(OWNER_CREDENTIAL_MESSAGES.appSecretMissing);
    expect(
      refusal(() =>
        planOwnerLogin({ databaseUrl: ADMIN_URL, appSecret: 'short' }),
      ),
    ).toBe(OWNER_CREDENTIAL_MESSAGES.appSecretShort);
    expect(
      refusal(() =>
        planOwnerLogin({ databaseUrl: undefined, appSecret: APP_SECRET }),
      ),
    ).toBe(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
    expect(
      refusal(() =>
        planOwnerLogin({ databaseUrl: '   ', appSecret: APP_SECRET }),
      ),
    ).toBe(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
    expect(
      refusal(() =>
        planOwnerLogin({
          databaseUrl: ADMIN_URL.replace(':25060', ':25061'),
          appSecret: APP_SECRET,
        }),
      ),
    ).toBe(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  });

  it('owner-credential.ts never imports pg and never logs', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'owner-credential.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from 'pg'|require\('pg'\)/);
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)/);
  });
});
