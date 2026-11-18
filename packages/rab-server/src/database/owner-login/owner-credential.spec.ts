import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parsePgUrl } from '../postgres/pg-url-policy';
import { scramVerifier } from '../typeorm/scripts/twenty-mode-check';

import {
  ADMIN_URL_LABEL,
  DB_SETUP_INPUT_MESSAGES,
  isOwnerLoginUrl,
  isValidOwnerPassword,
  OWNER_CREDENTIAL_MESSAGES,
  OWNER_LOGIN,
  OwnerCredentialError,
  planDbSetup,
  RETIRED_ADMIN_URL_NAMES,
  scramSha256Verifier,
  runtimeUrlFacts,
  sameDatabase,
  selectDbSetupInput,
} from './owner-credential';

/**
 * The Twenty way (owner decision 2026-11-18). Every secret below is a generated test value; no assertion message prints one.
 */
const ADMIN_PASSWORD = 'adminSentinel7f3a';
/** A crewflow_owner password as the operator sets it (`openssl rand -hex 32`, PG_DATABASE_APP_PASSWORD). */
const DERIVED = randomBytes(32).toString('hex');

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

describe('planDbSetup and selectDbSetupInput (the Twenty way)', () => {
  const ADMIN_URL = `postgres://doadmin:${ADMIN_PASSWORD}@db-x.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
  const OWN = `postgres://crewflow_owner:${ADMIN_PASSWORD}@db.example.internal:5432/crewflow?sslmode=verify-full`;

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

  // Owner decision 2026-11-18: PG_DATABASE_URL (ALWAYS crewflow_owner, always required) + optional PG_ADMIN_URL (db-setup only).
  const SAME_DB_ADMIN = `postgres://doadmin:${ADMIN_PASSWORD}@db.example.internal:5432/crewflow?sslmode=verify-full`;
  it('selectDbSetupInput: PG_ADMIN_URL + PG_DATABASE_URL = bootstrap (mode b, the NORMAL case); PG_DATABASE_URL alone = owner-url (mode c); every secret non-enumerable', () => {
    const b = selectDbSetupInput({ PG_ADMIN_URL: SAME_DB_ADMIN, PG_DATABASE_URL: OWN });
    expect(b.mode).toBe('bootstrap');
    expect(b.name).toBe(ADMIN_URL_LABEL);
    expect(b.plan.mode).toBe('bootstrap');
    expect(b.url === SAME_DB_ADMIN).toBe(true);
    expect(b.appUrl === OWN).toBe(true);
    expect(b.ownerPassword === ADMIN_PASSWORD).toBe(true);
    expect(b.appTarget.user).toBe(OWNER_LOGIN);
    expect(JSON.stringify(b)).not.toContain(ADMIN_PASSWORD);
    expect(Object.keys(b)).not.toEqual(expect.arrayContaining(['url', 'appUrl', 'ownerPassword']));
    const c = selectDbSetupInput({ PG_DATABASE_URL: OWN, PG_ADMIN_URL: '  ' });
    expect(c.mode).toBe('owner-url');
    expect(c.name).toBe('PG_DATABASE_URL');
    expect(c.plan.mode).toBe('owner-url');
    expect(c.url === OWN && c.appUrl === OWN).toBe(true);
    expect(JSON.stringify(c)).not.toContain(ADMIN_PASSWORD);
  });

  it('the bundled shape (mode a): the db superuser URL and the compose-built crewflow_owner URL name the same database', () => {
    const app = `postgresql://crewflow_owner:${DERIVED}@db:5432/crewflow?sslmode=verify-full`;
    const admin = `postgresql://postgres:${ADMIN_PASSWORD}@db:5432/crewflow?sslmode=verify-full`;
    const input = selectDbSetupInput({ PG_ADMIN_URL: admin, PG_DATABASE_URL: app });
    expect(input.mode).toBe('bootstrap');
    expect(input.ownerPassword === DERIVED).toBe(true);
  });

  it('DENIAL selectDbSetupInput: PG_ADMIN_URL and PG_DATABASE_URL naming different databases (host, port, database or Neon endpoint) are refused', () => {
    for (const other of [
      OWN.replace('db.example.internal', 'db2.example.internal'),
      OWN.replace(':5432/', ':5433/'),
      OWN.replace('/crewflow?', '/crewflow2?'),
    ]) {
      expect(refusal(() => selectDbSetupInput({ PG_ADMIN_URL: SAME_DB_ADMIN, PG_DATABASE_URL: other }))).toBe(DB_SETUP_INPUT_MESSAGES.targetMismatch);
    }
    // Case-insensitive host, other query parameters: the same database.
    const upper = SAME_DB_ADMIN.replace('db.example.internal', 'DB.Example.Internal').replace('sslmode=verify-full', 'sslmode=verify-full&connect_timeout=5');
    expect(selectDbSetupInput({ PG_ADMIN_URL: upper, PG_DATABASE_URL: OWN }).mode).toBe('bootstrap');
    const a = parsePgUrl(SAME_DB_ADMIN, 'PG_ADMIN_URL');
    expect(sameDatabase(a, parsePgUrl(OWN, 'PG_DATABASE_URL'))).toBe(true);
    expect(sameDatabase(a, parsePgUrl(OWN.replace('/crewflow?', '/other?'), 'PG_DATABASE_URL'))).toBe(false);
  });

  it('runtimeUrlFacts: the login and the pooler shape, never a value', () => {
    expect(runtimeUrlFacts(OWN)).toEqual({ owner: true, transactionPooler: false });
    expect(runtimeUrlFacts(ADMIN_URL)).toEqual({ owner: false, transactionPooler: false });
    expect(runtimeUrlFacts(`postgres://crewflow_owner:${ADMIN_PASSWORD}@ep-abc-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`)).toEqual({
      owner: true,
      transactionPooler: true,
    });
    const message = refusal(() => runtimeUrlFacts(`mysql://u:${ADMIN_PASSWORD}@h/d`));
    expect(message).not.toContain(ADMIN_PASSWORD);
  });

  it('DENIAL selectDbSetupInput: an admin login in PG_DATABASE_URL is refused (renamed), never reinterpreted as the admin URL', () => {
    for (const login of ['doadmin', 'postgres', 'neondb_owner', 'crewflow_owner_x', 'CREWFLOW_OWNER']) {
      const url = ADMIN_URL.replace('doadmin', login);
      expect(refusal(() => selectDbSetupInput({ PG_DATABASE_URL: url }))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlNotOwner);
    }
    expect(DB_SETUP_INPUT_MESSAGES.appUrlNotOwner).toMatch(/an admin URL goes in PG_ADMIN_URL/);
    // ... also beside a valid admin URL (mode b): the app URL must still be crewflow_owner.
    expect(refusal(() => selectDbSetupInput({ PG_ADMIN_URL: SAME_DB_ADMIN, PG_DATABASE_URL: SAME_DB_ADMIN }))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlNotOwner);
  });

  it('I-4 (review of PR #230): a percent-encoded crewflow_owner login in PG_DATABASE_URL is the same login (decoded, accepted); a login smuggled in as ?user= is refused', () => {
    const encoded = OWN.replace('crewflow_owner', 'crewflow%5Fowner');
    const app = selectDbSetupInput({ PG_DATABASE_URL: encoded });
    expect(app.name).toBe('PG_DATABASE_URL');
    expect(app.plan.mode).toBe('owner-url');
    expect(app.plan.urlTarget.user).toBe(OWNER_LOGIN);
    // The admin login encoded: still an admin login, still refused in PG_DATABASE_URL.
    expect(refusal(() => selectDbSetupInput({ PG_DATABASE_URL: ADMIN_URL.replace('doadmin', 'do%61dmin') }))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlNotOwner);
    // ?user= (or any target override) on either URL: refused by the URL policy, before any mode decision.
    for (const [name, url] of [['PG_ADMIN_URL', SAME_DB_ADMIN], ['PG_DATABASE_URL', OWN]] as const) {
      for (const param of ['user=crewflow_owner', 'user=postgres', 'password=x', 'host=elsewhere', 'dbname=other']) {
        const env = { PG_DATABASE_URL: OWN, [name]: `${url}&${param}` };
        const message = refusal(() => selectDbSetupInput(env));
        expect(message).toMatch(/as a query parameter, which would override the connection target/);
        expect(message).toContain(name);
        expect(message).not.toContain(ADMIN_PASSWORD);
      }
    }
  });

  it('DENIAL selectDbSetupInput: crewflow_owner in PG_ADMIN_URL, no PG_DATABASE_URL (with or without an admin URL), the retired name; refusals are value-free and name the variable', () => {
    expect(refusal(() => selectDbSetupInput({ PG_ADMIN_URL: OWN, PG_DATABASE_URL: OWN }))).toBe(DB_SETUP_INPUT_MESSAGES.adminUrlIsOwner);
    expect(refusal(() => selectDbSetupInput({ PG_ADMIN_URL: SAME_DB_ADMIN }))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlMissing);
    expect(refusal(() => selectDbSetupInput({}))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlMissing);
    expect(refusal(() => selectDbSetupInput({ DATABASE_URL: ADMIN_URL }))).toBe(DB_SETUP_INPUT_MESSAGES.appUrlMissing);
    expect(RETIRED_ADMIN_URL_NAMES).toEqual(['PG_DATABASE_ADMIN_URL']);
    expect(refusal(() => selectDbSetupInput({ PG_DATABASE_ADMIN_URL: ADMIN_URL }))).toBe(DB_SETUP_INPUT_MESSAGES.retiredAdminName('PG_DATABASE_ADMIN_URL'));
    expect(refusal(() => selectDbSetupInput({ PG_DATABASE_ADMIN_URL: ADMIN_URL, PG_DATABASE_URL: OWN }))).toBe(DB_SETUP_INPUT_MESSAGES.retiredAdminName('PG_DATABASE_ADMIN_URL'));
    const pooler = refusal(() =>
      selectDbSetupInput({ PG_DATABASE_URL: OWN, PG_ADMIN_URL: `postgres://doadmin:${ADMIN_PASSWORD}@ep-abc-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require` }),
    );
    expect(pooler).toBe(OWNER_CREDENTIAL_MESSAGES.transactionPooler.split('PG_DATABASE_URL').join('PG_ADMIN_URL'));
    for (const m of Object.values(DB_SETUP_INPUT_MESSAGES)) {
      const text = typeof m === 'function' ? m('PG_DATABASE_ADMIN_URL') : m;
      expect(text).not.toContain(ADMIN_PASSWORD);
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it('owner-credential.ts never imports pg, never logs, and has no HKDF / APP_SECRET', () => {
    const source = fs.readFileSync(path.join(__dirname, 'owner-credential.ts'), 'utf8');
    expect(source).not.toMatch(/from 'pg'|require\('pg'\)/);
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)/);
    expect(source).not.toMatch(/hkdfSync|deriveOwnerPassword|appSecret/);
    // Owner decision 2026-11-18: no generated password and no URL rewriting any more (PG_DATABASE_URL is used as given).
    expect(source).not.toMatch(/generateOwnerPassword|buildRuntimeDatabaseUrl/);
  });
});
