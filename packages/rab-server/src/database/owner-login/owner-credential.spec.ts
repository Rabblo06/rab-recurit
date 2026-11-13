import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parsePgUrl } from '../postgres/pg-url-policy';
import { scramVerifier } from '../typeorm/scripts/twenty-mode-check';

import {
  buildRuntimeDatabaseUrl,
  generateOwnerPassword,
  isOwnerLoginUrl,
  isValidOwnerPassword,
  OWNER_CREDENTIAL_MESSAGES,
  OWNER_LOGIN,
  OwnerCredentialError,
  planDbSetup,
  scramSha256Verifier,
} from './owner-credential';
import { dbTargetFromRuntimeUrl, runtimeUrlFromDbTarget } from './db-target';

/**
 * The Twenty Helm model (OWNER-DB-FINAL.md Part A). Every secret below is a generated test value; no assertion message prints one.
 */
const ADMIN_PASSWORD = 'adminSentinel7f3a';
/** A crewflow_owner password as db-setup generates it (Twenty: randAlphaNum 32, secret-db-url.yaml:3-8). */
const DERIVED = generateOwnerPassword();

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnerCredentialError) return error.message;
    throw error;
  }
  throw new Error('expected an OwnerCredentialError');
}

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

  it('the crewflow_owner password is no longer HKDF-derived (APP_SECRET is never part of a database credential)', () => {
    expect(sites.some((site) => site.file.includes('owner-login/'))).toBe(false);
    const source = fs.readFileSync(path.join(__dirname, 'owner-credential.ts'), 'utf8');
    expect(source).not.toMatch(/hkdfSync|deriveOwnerPassword|appSecret/);
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

  it('refuses an empty, oversized or control-character password; percent-encodes any other (a copied crewflow_owner password)', () => {
    for (const bad of ['', 'x'.repeat(1025), 'tab\there', 'new\nline', 'nul\u0000']) {
      expect(refusal(() => buildRuntimeDatabaseUrl(admin('db/crewflow'), bad))).toBe(OWNER_CREDENTIAL_MESSAGES.badOwnerPassword);
    }
    for (const odd of ['p@ss:w/rd?#%', 'ünïcödé', ' leading-space', 'x'.repeat(1024)]) {
      const url = buildRuntimeDatabaseUrl(admin('db/crewflow?sslmode=verify-full'), odd);
      const parsed = parsePgUrl(url, 'PG_DATABASE_URL');
      expect(parsed.user).toBe(OWNER_LOGIN);
      expect(parsed.password === odd).toBe(true);
    }
  });

  it('a crewflow_owner URL is rebuilt with the given password too (no pass-through: the stored password wins)', () => {
    const source = `postgres://crewflow_owner:${ADMIN_PASSWORD}@db.example.internal/crewflow?sslmode=verify-full&application_name=keep-me`;
    const url = buildRuntimeDatabaseUrl(source, DERIVED);
    expect(url.includes(ADMIN_PASSWORD)).toBe(false);
    expect(parsePgUrl(url, 'PG_DATABASE_URL').password === DERIVED).toBe(true);
    expect(isOwnerLoginUrl(source)).toBe(true);
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

describe('generateOwnerPassword and planDbSetup (the Twenty Helm model)', () => {
  const ADMIN_URL = `postgres://doadmin:${ADMIN_PASSWORD}@db-x.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
  const OWN = `postgres://crewflow_owner:${ADMIN_PASSWORD}@db.example.internal:5432/crewflow?sslmode=verify-full`;

  it('a new password is 32 crypto-random bytes as 64 lowercase hex, different every time (Twenty: randAlphaNum 32)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const pw = generateOwnerPassword();
      expect(/^[0-9a-f]{64}$/.test(pw)).toBe(true);
      expect(isValidOwnerPassword(pw)).toBe(true);
      seen.add(pw);
    }
    expect(seen.size).toBe(50);
  });

  it('an admin URL is the bootstrap mode; no password is derived or needed up front', () => {
    const plan = planDbSetup(ADMIN_URL);
    expect(plan.mode).toBe('bootstrap');
    expect(plan.urlTarget.user).toBe('doadmin');
    expect(JSON.stringify(plan)).not.toContain(ADMIN_PASSWORD);
  });

  it('a crewflow_owner URL is the owner-url mode with the URL password (non-enumerable)', () => {
    const plan = planDbSetup(OWN);
    if (plan.mode !== 'owner-url') throw new Error('expected owner-url');
    expect(plan.ownerPassword === ADMIN_PASSWORD).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(ADMIN_PASSWORD);
    expect(refusal(() => planDbSetup('postgres://crewflow_owner@db.example.internal:5432/crewflow?sslmode=verify-full'))).toBe(OWNER_CREDENTIAL_MESSAGES.ownerUrlWithoutPassword);
  });

  it('refuses a missing URL and a pooler shape in both modes', () => {
    expect(refusal(() => planDbSetup(''))).toBe(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
    expect(refusal(() => planDbSetup(undefined))).toBe(OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing);
    for (const login of ['doadmin', 'crewflow_owner']) {
      expect(refusal(() => planDbSetup(`postgres://${login}:${ADMIN_PASSWORD}@ep-abc-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`))).toBe(
        OWNER_CREDENTIAL_MESSAGES.transactionPooler,
      );
    }
  });

  it('the credential-free target round-trips with the stored password for either URL', () => {
    for (const url of [ADMIN_URL, OWN]) {
      const runtime = buildRuntimeDatabaseUrl(url, DERIVED);
      const target = dbTargetFromRuntimeUrl(runtime, DERIVED);
      expect(JSON.stringify(target)).not.toContain(DERIVED);
      expect(runtimeUrlFromDbTarget(target, DERIVED)).toBe(runtime);
    }
  });

  it('owner-credential.ts never imports pg, never logs, and has no HKDF / APP_SECRET', () => {
    const source = fs.readFileSync(path.join(__dirname, 'owner-credential.ts'), 'utf8');
    expect(source).not.toMatch(/from 'pg'|require\('pg'\)/);
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)/);
    expect(source).not.toMatch(/hkdfSync|deriveOwnerPassword|appSecret/);
  });
});
