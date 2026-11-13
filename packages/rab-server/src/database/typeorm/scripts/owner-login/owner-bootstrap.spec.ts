/**
 * DB setup like Twenty, area 2: unit tests of the bootstrap child's decisions, error mapping, statement hygiene and the
 * fixed advisory key. The real-database behaviour (PG16/17/18, B3/B4/B5, restart, rotation, races) is
 * bootstrap-owner-login-check.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import { deriveOwnerPassword, OWNER_CREDENTIAL_MESSAGES } from '../../../owner-login/owner-credential';
import {
  bootstrapDriverConfigs,
  bootstrapOwnerWithIo,
  classifyAdminConnectError,
  classifyWriteError,
  decideBeforeProbe,
  decideOwnerSelf,
  factsFromRow,
  OWNER_BOOTSTRAP_MESSAGES,
  OwnerBootstrapFailure,
  OwnerBootstrapIo,
  OwnerBootstrapRefusal,
  OwnerFacts,
  OwnerUrlIo,
  planWrite,
  resultLine,
  runOwnerBootstrap,
  setupOwnerUrlWithIo,
  SqlSession,
} from './owner-bootstrap';
import {
  OWNER_BOOTSTRAP_ADMIN_STATEMENTS,
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_LOCK_KEY,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_SELF_O1_SESSION,
  OWNER_SELF_O4C_DO,
  OWNER_SELF_STATEMENTS,
  BOOTSTRAP_SESSION_STARTUP_OPTIONS,
} from './owner-bootstrap-sql';
import { planDbSetup, scramSha256Verifier } from '../../../owner-login/owner-credential';
import { resolvePgEnvironment } from '../../../postgres';

const SECRET = 'a'.repeat(16) + 'B'.repeat(16) + 'unit-test-only-secret';
const ADMIN_PW = 'adminpw0123456789';
const ADMIN_URL = `postgres://dbadmin:${ADMIN_PW}@db.internal.example:5432/crewflow_unit`;

const base: OwnerFacts = {
  serverVersionNum: 160004,
  adminSuper: false,
  adminCreateRole: true,
  adminCanGrantDb: true,
  ownerExists: false,
  oLogin: null,
  oSuper: null,
  oBypassRls: null,
  oReplication: null,
  oCreateDb: null,
  oCreateRole: null,
  oInherit: null,
  oExpired: null,
  adminHasAdminOption: false,
  oPrivilegedMemberships: null,
  oHasDbGrant: false,
  oOwnsDb: false,
  searchPathDefaultSet: false,
};
const existing: OwnerFacts = {
  ...base,
  ownerExists: true,
  oLogin: true,
  oSuper: false,
  oBypassRls: false,
  oReplication: false,
  oCreateDb: false,
  oCreateRole: true,
  oInherit: true,
  oExpired: false,
  adminHasAdminOption: true,
  oPrivilegedMemberships: 0,
  oHasDbGrant: true,
};

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal) return error.message;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('owner bootstrap: §3.3 decisions', () => {
  it('refuses PostgreSQL below 16', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: 150008 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.pgTooOld);
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: Number.NaN }))).toBe(OWNER_BOOTSTRAP_MESSAGES.pgTooOld);
    expect(decideBeforeProbe({ ...base, serverVersionNum: 170000 })).toEqual([]);
    expect(decideBeforeProbe({ ...base, serverVersionNum: 180001 })).toEqual([]);
  });

  it.each([
    [{ oSuper: true }, ['SUPERUSER']],
    [{ oBypassRls: true }, ['BYPASSRLS']],
    [{ oReplication: true }, ['REPLICATION']],
    [{ oCreateDb: true }, ['CREATEDB']],
    [{ oLogin: false }, ['NOLOGIN']],
    [{ oInherit: false }, ['NOINHERIT']],
    [{ oSuper: true, oBypassRls: true }, ['SUPERUSER', 'BYPASSRLS']],
  ] as Array<[Partial<OwnerFacts>, string[]]>)('refuses an existing crewflow_owner with %j', (attrs, names) => {
    expect(refusalOf(() => decideBeforeProbe({ ...existing, ...attrs }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(names));
  });

  it('D2: accepts NOCREATEROLE with one note', () => {
    expect(decideBeforeProbe({ ...existing, oCreateRole: false })).toEqual([OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened]);
  });

  it('refuses a privileged membership and an expired VALID UNTIL', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oPrivilegedMemberships: 1 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedMembership);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oExpired: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.expired);
  });

  it('refuses an admin that can neither create roles nor grant on the database', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...base, adminCreateRole: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotCreateRoles);
    expect(decideBeforeProbe({ ...base, adminCreateRole: false, adminSuper: true })).toEqual([]);
    expect(refusalOf(() => decideBeforeProbe({ ...base, adminCanGrantDb: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotGrantDb);
    // An existing role that already holds the grant needs nothing granted: an admin without grant rights is fine.
    expect(decideBeforeProbe({ ...existing, adminCanGrantDb: false, adminCreateRole: false })).toEqual([]);
  });
});

describe('owner bootstrap: §3.4 probe and the write plan', () => {
  it('creates a missing role with its password and grant', () => {
    expect(planWrite(base, null)).toEqual({ write: true, create: true, needPassword: true, needGrant: true });
  });
  it('changes nothing when the probe succeeds and the grant exists (idempotent restart)', () => {
    expect(planWrite(existing, { ok: true })).toEqual({ write: false, create: false, needPassword: false, needGrant: false });
  });
  it('adds only the grant when the password is right', () => {
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: true })).toEqual({ write: true, create: false, needPassword: false, needGrant: true });
  });
  it('resets the password on 28P01, and on 42501 while CONNECT is not granted yet', () => {
    expect(planWrite(existing, { ok: false, code: '28P01' })).toMatchObject({ write: true, needPassword: true, needGrant: false });
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: false, code: '42501' })).toMatchObject({ needPassword: true, needGrant: true });
  });
  it('refuses a reset without ADMIN OPTION, or without CREATEROLE', () => {
    expect(refusalOf(() => planWrite({ ...existing, adminHasAdminOption: false }, { ok: false, code: '28P01' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNoAdminOption);
    expect(refusalOf(() => planWrite({ ...existing, adminCreateRole: false }, { ok: false, code: '28P01' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotResetPassword);
    // Without a reset, no ADMIN OPTION is needed (a role created by another login, password already right).
    expect(planWrite({ ...existing, adminHasAdminOption: false }, { ok: true }).write).toBe(false);
  });
  it('refuses any other probe failure with the SQLSTATE class only', () => {
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '28000' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('28'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '42501' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('42'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: 'ECONNRESET' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('??'));
  });
});

describe('owner bootstrap: error mapping', () => {
  const err = (code: string, message = 'secret-bearing driver text') => Object.assign(new Error(message), { code });
  it('admin connection', () => {
    expect(classifyAdminConnectError(err('28P01'), false)).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyAdminConnectError(err('3D000'), false)).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyAdminConnectError(err('DEPTH_ZERO_SELF_SIGNED_CERT'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminTls);
    expect(classifyAdminConnectError(new Error('The server does not support SSL connections'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminTls);
    expect(classifyAdminConnectError(err('ECONNREFUSED'), true).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminUnreachable);
    expect(classifyAdminConnectError(err('53300'), false)).toBeInstanceOf(OwnerBootstrapFailure);
  });
  it('write transaction', () => {
    expect(classifyWriteError(err('42710'))).toBe('race');
    expect(classifyWriteError(err('23505'))).toBe('race');
    expect(classifyWriteError(err('XX000'))).toBe('race'); // tuple concurrently updated (two databases, one role)
    expect(classifyWriteError(err('40P01'))).toBe('race');
    expect(classifyWriteError(err('42501'))).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyWriteError(err('22023'))).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyWriteError(err('57014'))).toBeInstanceOf(OwnerBootstrapFailure);
  });
  it('never carries the driver message', () => {
    for (const e of [classifyAdminConnectError(err('XX001'), false), classifyWriteError(err('XX001')) as Error]) {
      expect(e.message).not.toContain('secret-bearing');
    }
  });
});

/** A fake admin session + probe recording every statement and its bind values. */
function fakeIo(facts: OwnerFacts[], probes: Array<{ ok: true } | { ok: false; code: string }>, opts: { failOn?: string; failCode?: string; openErrors?: string[] } = {}) {
  const sent: Array<{ text: string; values?: unknown[] }> = [];
  const lines: string[] = [];
  let clock = 0;
  const openErrors = [...(opts.openErrors ?? [])];
  const session: SqlSession = {
    async query(text, values) {
      sent.push({ text, values });
      if (opts.failOn && text === opts.failOn) throw Object.assign(new Error('driver text with verifier SCRAM-SHA-256$4096:x'), { code: opts.failCode });
      if (text === OWNER_BOOTSTRAP_Q2_FACTS) {
        const f = facts.length > 1 ? facts.shift()! : facts[0]!;
        return {
          rows: [
            {
              server_version_num: f.serverVersionNum,
              admin_super: f.adminSuper,
              admin_createrole: f.adminCreateRole,
              admin_can_grant_db: f.adminCanGrantDb,
              owner_exists: f.ownerExists,
              o_login: f.oLogin,
              o_super: f.oSuper,
              o_bypassrls: f.oBypassRls,
              o_replication: f.oReplication,
              o_createdb: f.oCreateDb,
              o_createrole: f.oCreateRole,
              o_inherit: f.oInherit,
              o_expired: f.oExpired,
              admin_has_admin_option: f.adminHasAdminOption,
              o_privileged_memberships: f.oPrivilegedMemberships === null ? null : String(f.oPrivilegedMemberships),
              o_has_db_grant: f.oHasDbGrant,
              o_owns_db: f.oOwnsDb ?? false,
              search_path_default_set: f.searchPathDefaultSet ?? false,
            },
          ],
        };
      }
      if (text === OWNER_BOOTSTRAP_Q4D_REVERIFY) return { rows: [{ ok: true }] };
      return { rows: [] };
    },
    async end() {
      /* closed */
    },
  };
  const io: OwnerBootstrapIo = {
    async openAdmin() {
      const code = openErrors.shift();
      if (code) throw Object.assign(new Error('connect failed'), { code });
      return session;
    },
    async probeOwner() {
      return probes.length > 1 ? probes.shift()! : probes[0]!;
    },
    verifier: () => 'SCRAM-SHA-256$4096:c2FsdA==$stored:server',
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { io, sent, lines };
}

describe('owner bootstrap: the admin session', () => {
  it('fresh: one write transaction; the verifier travels only as bind parameter $1', async () => {
    const { io, sent } = fakeIo([base, base, existing], [{ ok: true }]);
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toMatchObject({ outcome: 'created', exitCode: 0, created: true, passwordSet: true, grantAdded: true });
    const bind = sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS);
    expect(bind?.values).toEqual(['SCRAM-SHA-256$4096:c2FsdA==$stored:server', 'true']);
    for (const s of sent) expect(s.text).not.toContain('SCRAM-SHA-256$');
    expect(sent.map((s) => s.text)).toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('re-plans under the lock: a concurrent first start that created the role first makes this one report the password reset, not "created"', async () => {
    // Pre-lock read: no crewflow_owner (plan: create). Post-lock read: another start created it meanwhile, with a password
    // this start's probe rejects (28P01), so the post-lock plan is "set the password". Post-commit read: exact.
    const { io, sent, lines } = fakeIo([base, existing, existing], [{ ok: false, code: '28P01' }, { ok: true }]);
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toEqual({ outcome: 'updated', exitCode: 0, created: false, passwordSet: true, grantAdded: false, code: null });
    const texts = sent.map((s) => s.text);
    // The second facts read happens AFTER the advisory lock, inside the transaction.
    const lockAt = texts.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK);
    expect(lockAt).toBeGreaterThan(texts.indexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(texts.indexOf(OWNER_BOOTSTRAP_Q2_FACTS, lockAt)).toBeGreaterThan(lockAt);
    expect(sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)?.values?.[1]).toBe('true');
    expect(lines).toEqual([]); // no "created" claim, no D2 note twice
  });

  it('re-plans under the lock: when the other start already did everything, this one writes nothing and reports "unchanged"', async () => {
    const { io, sent } = fakeIo([base, existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toEqual({ outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null });
    const texts = sent.map((s) => s.text);
    expect(texts).toContain(OWNER_BOOTSTRAP_Q4A_LOCK);
    expect(texts).not.toContain(OWNER_BOOTSTRAP_Q4B_SET_INPUTS);
    expect(texts).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
    expect(texts[texts.length - 1]).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('re-plans under the lock: a refusal decided under the lock keeps its own message and rolls back', async () => {
    const { io, sent } = fakeIo([base, { ...existing, oBypassRls: true }], [{ ok: true }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['BYPASSRLS']));
    expect(sent.map((s) => s.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(sent.map((s) => s.text)).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('restart with everything in place: no transaction at all', async () => {
    const { io, sent } = fakeIo([existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(sent.map((s) => s.text)).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('grant only: the verifier is not sent (empty), need_password false', async () => {
    const { io, sent } = fakeIo([{ ...existing, oHasDbGrant: false }, { ...existing, oHasDbGrant: false }, existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'updated', passwordSet: false, grantAdded: true });
    expect(sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)?.values).toEqual(['', 'false']);
  });

  it('a CREATE ROLE race is retried from the facts', async () => {
    let first = true;
    const { io, sent, lines } = fakeIo([base, base, existing], [{ ok: true }]);
    const query = io.openAdmin;
    io.openAdmin = async () => {
      const s = await query();
      const q = s.query.bind(s);
      s.query = async (text, values) => {
        if (text === OWNER_BOOTSTRAP_Q4C_DO && first) {
          first = false;
          sent.push({ text, values });
          throw Object.assign(new Error('dup'), { code: '42710' });
        }
        return q(text, values);
      };
      return s;
    };
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(sent.map((s) => s.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.raceRetry);
  });

  it('a failing DO block rolls back and refuses (42501) without the driver text', async () => {
    const { io, sent } = fakeIo([base], [{ ok: true }], { failOn: OWNER_BOOTSTRAP_Q4C_DO, failCode: '42501' });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501'));
    expect(sent.map((s) => s.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('fails closed when the post-commit probe does not log in', async () => {
    const { io } = fakeIo([base, base], [{ ok: false, code: '28P01' }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toBeInstanceOf(OwnerBootstrapFailure);
  });

  it('retries connection-refused and 57P03 within the window, then gives up with exit-70 failure', async () => {
    const ok = fakeIo([existing], [{ ok: true }], { openErrors: ['ECONNREFUSED', '57P03', 'ECONNREFUSED'] });
    expect(await bootstrapOwnerWithIo(ok.io)).toMatchObject({ outcome: 'unchanged' });
    const never = fakeIo([existing], [{ ok: true }], { openErrors: Array(100).fill('ECONNREFUSED') });
    await expect(bootstrapOwnerWithIo(never.io, 10_000)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.adminUnreachable);
  });

  it('does not retry an authentication failure', async () => {
    const { io } = fakeIo([existing], [{ ok: true }], { openErrors: ['28P01'] });
    await expect(bootstrapOwnerWithIo(io)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
  });
});

describe('owner bootstrap: the whole step without a database', () => {
  const run = async (env: Record<string, string | undefined>) => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(env, { log: (l) => lines.push(l), retryWindowMs: 0 });
    return { result, text: [...lines, resultLine(result)].join('\n') };
  };
  const assertClean = (text: string) => {
    for (const forbidden of [ADMIN_PW, 'db.internal.example', 'crewflow_unit', 'dbadmin', SECRET, deriveOwnerPassword(SECRET), 'SCRAM-SHA-256$']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s)]*@/i); // a URL with userinfo (the fixed text "a postgres:// URL" is fine)
  };

  it('option 2: a crewflow_owner URL needs APP_SECRET too (refused before connecting, no echo)', async () => {
    for (const secret of [undefined, 'short']) {
      const { result, text } = await run({ PG_DATABASE_URL: 'postgres://crewflow_owner:ownerpw0123456789@127.0.0.1:1/crewflow_unit', APP_SECRET: secret });
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      expect(text).not.toContain('ownerpw0123456789');
      assertClean(text);
    }
  });

  it('option 2: a crewflow_owner URL is no longer skipped: it connects (unreachable port -> exit 70, fixed text)', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://crewflow_owner:ownerpw0123456789@127.0.0.1:1/crewflow_unit', APP_SECRET: SECRET });
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    expect(text).toContain(OWNER_BOOTSTRAP_MESSAGES.passThrough);
    expect(text).not.toContain('ownerpw0123456789');
    assertClean(text);
  });

  it('option 2: a pooler-shaped crewflow_owner URL is refused (the setup needs one real session)', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://crewflow_owner:ownerpw0123456789@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit', APP_SECRET: SECRET });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
    expect(text).toContain(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
  });

  it('refuses a missing or short APP_SECRET before connecting', async () => {
    for (const [secret, message] of [
      [undefined, OWNER_CREDENTIAL_MESSAGES.appSecretMissing],
      ['short', OWNER_CREDENTIAL_MESSAGES.appSecretShort],
    ] as const) {
      const { result, text } = await run({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET: secret });
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      expect(text).toContain(message);
      assertClean(text);
    }
  });

  it('refuses a URL the policy refuses (sslrootcert, ?host=, pooler) without echoing it', async () => {
    for (const url of [
      `${ADMIN_URL}?sslrootcert=/etc/x.pem`,
      `${ADMIN_URL}?host=elsewhere`,
      `postgres://dbadmin:${ADMIN_PW}@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit`,
      'not a url with dbadmin and adminpw0123456789',
    ]) {
      const { result, text } = await run({ PG_DATABASE_URL: url, APP_SECRET: SECRET });
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      assertClean(text);
    }
  });

  it('refuses when only the legacy DATABASE_URL is set (the step takes PG_DATABASE_URL only)', async () => {
    const { result } = await run({ DATABASE_URL: ADMIN_URL, APP_SECRET: SECRET });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
  });

  it('production refuses a non-verify-full admin URL before connecting', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: `${ADMIN_URL}?sslmode=disable`, APP_SECRET: SECRET, NODE_ENV: 'production' });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
    assertClean(text);
  });

  it('an unreachable admin target is exit 70 with fixed text', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit', APP_SECRET: SECRET });
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    assertClean(text);
  });
});

describe('owner bootstrap: statements and the advisory key', () => {
  it('no admin statement can carry a value: only the lock-key constant is interpolated, inputs are $1/$2', () => {
    for (const text of OWNER_BOOTSTRAP_ADMIN_STATEMENTS) {
      // No value, and not the verifier prefix either (the shape pattern spells its dollar signs as [$]).
      expect(text).not.toMatch(/SCRAM-SHA-256\$|postgres:\/\//);
    }
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.verifier', $1, true)");
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.need_password', $2, true)");
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L');
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain("RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE;");
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION');
  });

  it('the lock key is "crewboot", 64-bit (never an int4 hashtext key), and differs from every other numeric advisory key', () => {
    const key = BigInt(OWNER_BOOTSTRAP_LOCK_KEY);
    expect(Buffer.from(key.toString(16), 'hex').toString('latin1')).toBe('crewboot');
    expect(key > 2n ** 32n).toBe(true);

    const repo = path.resolve(__dirname, '../../../../../../..');
    const roots = ['packages/rab-server/src', 'packages/rab-worker/src', 'tools'].map((r) => path.join(repo, r));
    const own = new Set(['owner-bootstrap-sql.ts', 'owner-bootstrap.spec.ts']);
    const found: bigint[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|cjs|mjs|sql)$/.test(entry.name) && !own.has(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (!/advisory/i.test(text)) continue;
          for (const m of text.matchAll(/\b0x[0-9a-fA-F]{9,16}n?\b|\bx'([0-9a-fA-F]{9,16})'|\b\d{10,20}\b/g)) {
            const literal = m[1] ? `0x${m[1]}` : m[0].replace(/n$/, '');
            found.push(BigInt(literal));
          }
        }
      }
    };
    roots.filter((r) => fs.existsSync(r)).forEach(walk);
    // The two known fixed keys are found by the scan, so the scan works.
    expect(found).toContain(0x637265776d696772n); // "crewmigr", migration-lock.ts
    expect(found).toContain(7165901520760811569n); // "crewpa01", platform-admin.service.ts
    expect(found).not.toContain(key);
  });
});

describe('owner bootstrap: option A target hooks (publish only after success, withdraw on refusal/failure)', () => {
  const hooks = () => {
    const calls: string[] = [];
    return {
      calls,
      options: {
        retryWindowMs: 0,
        publishTarget: () => void calls.push('publish'),
        withdrawTarget: () => void calls.push('withdraw'),
      },
    };
  };

  it('option 2: a crewflow_owner URL that fails withdraws the stale target and never publishes', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: 'postgres://crewflow_owner:x@127.0.0.1:1/crewflow_unit', APP_SECRET: SECRET }, h.options);
    expect(result.exitCode).toBe(70);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a refusal (short APP_SECRET) withdraws the stale target and never publishes', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET: 'short' }, h.options);
    expect(result.exitCode).toBe(64);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a failure (unreachable database) withdraws and never publishes', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit', APP_SECRET: SECRET }, h.options);
    expect(result.exitCode).toBe(70);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a withdraw that fails is reported with a fixed line; the exit code is unchanged', async () => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(
      { PG_DATABASE_URL: ADMIN_URL, APP_SECRET: 'short' },
      {
        log: (l) => lines.push(l),
        withdrawTarget: () => {
          throw Object.assign(new Error('/run/crewflow/db-target/target.json busy'), { code: 'EBUSY' });
        },
      },
    );
    expect(result.exitCode).toBe(64);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.targetWithdrawFailed('EBUSY'));
    expect(lines.join('\n')).not.toContain('/run/crewflow');
  });
});

describe('owner bootstrap, option 2: PG_DATABASE_URL is crewflow_owner itself (steps a and b)', () => {
  const ownerFacts: OwnerFacts = { ...existing, adminSuper: false, adminCreateRole: true, adminHasAdminOption: false };
  const me = { session_login: 'crewflow_owner', current_login: 'crewflow_owner' };
  const VERIFIER = 'SCRAM-SHA-256$4096:c2FsdA==$stored:server';

  type Who = { session_login: string; current_login: string };
  function ownerIo(o: {
    derivedErrors?: string[]; // one per openDerived() call; '' = connects
    urlError?: string;
    facts?: OwnerFacts[];
    who?: Who;
    probes?: Array<{ ok: true } | { ok: false; code: string }>;
    failOn?: string;
    failCode?: string;
    onCommit?: OwnerUrlIo['onCommit'];
  }) {
    const sent: Array<{ via: 'derived' | 'url'; text: string; values?: unknown[] }> = [];
    const lines: string[] = [];
    const facts = [...(o.facts ?? [ownerFacts])];
    const derivedErrors = [...(o.derivedErrors ?? [''])];
    const probes = [...(o.probes ?? [{ ok: false, code: '28P01' } as const])];
    let clock = 0;
    const session = (via: 'derived' | 'url'): SqlSession => ({
      async query(text, values) {
        sent.push({ via, text, values });
        if (o.failOn && text === o.failOn) throw Object.assign(new Error('driver text with verifier SCRAM-SHA-256$4096:x'), { code: o.failCode });
        if (text === OWNER_SELF_O1_SESSION) return { rows: [o.who ?? me] };
        if (text === OWNER_BOOTSTRAP_Q2_FACTS) {
          const f = facts.length > 1 ? facts.shift()! : facts[0]!;
          return {
            rows: [
              {
                server_version_num: f.serverVersionNum,
                admin_super: f.adminSuper,
                admin_createrole: f.adminCreateRole,
                admin_can_grant_db: f.adminCanGrantDb,
                owner_exists: f.ownerExists,
                o_login: f.oLogin,
                o_super: f.oSuper,
                o_bypassrls: f.oBypassRls,
                o_replication: f.oReplication,
                o_createdb: f.oCreateDb,
                o_createrole: f.oCreateRole,
                o_inherit: f.oInherit,
                o_expired: f.oExpired,
                admin_has_admin_option: f.adminHasAdminOption,
                o_privileged_memberships: f.oPrivilegedMemberships === null ? null : String(f.oPrivilegedMemberships),
                o_has_db_grant: f.oHasDbGrant,
                o_owns_db: f.oOwnsDb ?? false,
                search_path_default_set: f.searchPathDefaultSet ?? false,
              },
            ],
          };
        }
        if (text === OWNER_BOOTSTRAP_Q4D_REVERIFY) return { rows: [{ ok: true }] };
        return { rows: [] };
      },
      async end() {
        /* closed */
      },
    });
    const io: OwnerUrlIo = {
      async openDerived() {
        const code = derivedErrors.length > 1 ? derivedErrors.shift()! : derivedErrors[0]!;
        if (code) throw Object.assign(new Error('password authentication failed for user "crewflow_owner"'), { code });
        return session('derived');
      },
      async openUrl() {
        if (o.urlError) throw Object.assign(new Error('connect failed'), { code: o.urlError });
        return session('url');
      },
      async probeOwner() {
        return probes.length > 1 ? probes.shift()! : probes[0]!;
      },
      verifier: () => VERIFIER,
      log: (l) => lines.push(l),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      onCommit: o.onCommit,
    };
    const writes = () => sent.filter((q) => [OWNER_BOOTSTRAP_BEGIN, OWNER_BOOTSTRAP_Q4A_LOCK, OWNER_BOOTSTRAP_Q4B_SET_INPUTS, OWNER_SELF_O4C_DO, OWNER_BOOTSTRAP_COMMIT].includes(q.text as never));
    return { io, sent, lines, writes };
  }

  it('step a: the derived password already works -> read-only, unchanged, nothing written', async () => {
    const f = ownerIo({ derivedErrors: [''] });
    const result = await setupOwnerUrlWithIo(f.io, 0);
    expect(result).toEqual({ outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null });
    expect(f.sent.map((q) => q.text)).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS]);
    expect(f.sent.every((q) => q.via === 'derived')).toBe(true);
  });

  it.each<[string, Partial<OwnerFacts>]>([
    ['SUPERUSER', { oSuper: true }],
    ['BYPASSRLS', { oBypassRls: true }],
    ['REPLICATION', { oReplication: true }],
    ['CREATEDB', { oCreateDb: true }],
  ])('step a: a %s crewflow_owner with the derived password is refused, nothing written', async (_label, patch) => {
    const f = ownerIo({ derivedErrors: [''], facts: [{ ...ownerFacts, ...patch }] });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
    expect(f.writes()).toEqual([]);
  });

  it('step b: the derived password fails (28P01) -> URL password, every refusal BEFORE the write, then the self ALTER under the lock', async () => {
    const f = ownerIo({ derivedErrors: ['28P01', ''], probes: [{ ok: false, code: '28P01' }] });
    const result = await setupOwnerUrlWithIo(f.io, 0);
    expect(result).toEqual({ outcome: 'pass-through', exitCode: 0, created: false, passwordSet: true, grantAdded: false, code: null });
    const url = f.sent.filter((q) => q.via === 'url').map((q) => q.text);
    expect(url).toEqual([
      OWNER_BOOTSTRAP_Q0_SESSION,
      OWNER_SELF_O1_SESSION,
      OWNER_BOOTSTRAP_Q2_FACTS,
      OWNER_BOOTSTRAP_BEGIN,
      OWNER_BOOTSTRAP_Q4A_LOCK,
      OWNER_SELF_O1_SESSION,
      OWNER_BOOTSTRAP_Q2_FACTS,
      OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
      OWNER_SELF_O4C_DO,
      OWNER_BOOTSTRAP_Q4D_REVERIFY,
      OWNER_BOOTSTRAP_COMMIT,
    ]);
    // The verifier travels only as bind parameter $1; never the plaintext; never in a statement text.
    const inputs = f.sent.find((q) => q.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)!;
    expect(inputs.values).toEqual([VERIFIER, 'true']);
    // Then the re-verify on a NEW session with the derived password.
    expect(f.sent.filter((q) => q.via === 'derived').map((q) => q.text)).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS]);
  });

  it.each<[string, Partial<OwnerFacts>]>([
    ['SUPERUSER', { oSuper: true }],
    ['BYPASSRLS', { oBypassRls: true }],
    ['a privileged membership', { oPrivilegedMemberships: 1 }],
    ['an expired VALID UNTIL', { oExpired: true }],
    ['no database grant', { oHasDbGrant: false }],
    ['PostgreSQL 15', { serverVersionNum: 150008 }],
  ])('step b: %s is refused before ANY write (no BEGIN, no lock, no ALTER)', async (_label, patch) => {
    const f = ownerIo({ derivedErrors: ['28P01'], facts: [{ ...ownerFacts, ...patch }] });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
    expect(f.writes()).toEqual([]);
  });

  it('step b: a session that is not crewflow_owner itself (SET ROLE / a different session user) is refused before any write', async () => {
    for (const who of [
      { session_login: 'crewflow_owner', current_login: 'postgres' },
      { session_login: 'postgres', current_login: 'crewflow_owner' },
    ]) {
      const f = ownerIo({ derivedErrors: ['28P01'], who });
      await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerNotSelf);
      expect(f.writes()).toEqual([]);
    }
  });

  it('step b: neither password works -> the fixed "matches neither" refusal (64), nothing written', async () => {
    const f = ownerIo({ derivedErrors: ['28P01'], urlError: '28P01' });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerNoPassword);
    expect(f.sent).toEqual([]);
  });

  it('step a: a non-password failure (pg_hba 28000, TLS, missing database) is NOT retried with the URL password', async () => {
    for (const code of ['28000', '3D000', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      const f = ownerIo({ derivedErrors: [code] });
      await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
      expect(f.sent).toEqual([]);
    }
  });

  it('step b: a concurrent db-setup set the derived password first -> under the lock the probe succeeds, ROLLBACK, no ALTER', async () => {
    const f = ownerIo({ derivedErrors: ['28P01', ''], probes: [{ ok: true }] });
    const result = await setupOwnerUrlWithIo(f.io, 0);
    expect(result.passwordSet).toBe(false);
    expect(f.sent.map((q) => q.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(f.sent.map((q) => q.text)).not.toContain(OWNER_SELF_O4C_DO);
  });

  it('step b: under the lock the role turned privileged -> refused, ROLLBACK, no ALTER', async () => {
    const f = ownerIo({ derivedErrors: ['28P01'], facts: [ownerFacts, { ...ownerFacts, oBypassRls: true }] });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
    expect(f.sent.map((q) => q.text)).not.toContain(OWNER_SELF_O4C_DO);
    expect(f.sent.map((q) => q.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('step b: a race SQLSTATE (XX000) is retried, bounded', async () => {
    const f = ownerIo({ derivedErrors: ['28P01'], failOn: OWNER_SELF_O4C_DO, failCode: 'XX000' });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.raceExhausted);
    expect(f.sent.filter((q) => q.text === OWNER_SELF_O4C_DO)).toHaveLength(3);
  });

  it('step b: the database refusing the ALTER (42501 / 22023) is the option-2 refusal, never the driver text', async () => {
    for (const code of ['42501', '22023']) {
      const f = ownerIo({ derivedErrors: ['28P01'], failOn: OWNER_SELF_O4C_DO, failCode: code });
      const error = await setupOwnerUrlWithIo(f.io, 0).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
      expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerWriteRefused(code));
      expect((error as Error).message).not.toContain('SCRAM');
    }
  });

  it('step b: the post-COMMIT login with the derived password fails -> exit 70 (re-verify), never a silent success', async () => {
    const f = ownerIo({ derivedErrors: ['28P01', '28P01'] });
    const error = await setupOwnerUrlWithIo(f.io, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
  });

  it('interrupted BEFORE the COMMIT: nothing committed; the next run takes step b again', async () => {
    const points: string[] = [];
    const f = ownerIo({
      derivedErrors: ['28P01'],
      onCommit: (p) => {
        points.push(p);
        if (p === 'before-commit') throw new Error('killed');
      },
    });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeDefined();
    expect(f.sent.map((q) => q.text)).not.toContain(OWNER_BOOTSTRAP_COMMIT);
    expect(f.sent.map((q) => q.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    const next = ownerIo({ derivedErrors: ['28P01', ''] });
    expect((await setupOwnerUrlWithIo(next.io, 0)).passwordSet).toBe(true);
  });

  it('interrupted AFTER the COMMIT: the next run takes step a (the derived password works), unchanged', async () => {
    const f = ownerIo({
      derivedErrors: ['28P01'],
      onCommit: (p) => {
        if (p === 'after-commit') throw new Error('killed');
      },
    });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeDefined();
    expect(f.sent.map((q) => q.text)).toContain(OWNER_BOOTSTRAP_COMMIT);
    const next = ownerIo({ derivedErrors: [''] });
    const result = await setupOwnerUrlWithIo(next.io, 0);
    expect(result.passwordSet).toBe(false);
    expect(next.writes()).toEqual([]);
  });

  it('decideOwnerSelf: the NOCREATEROLE (hardened) owner is accepted with the D2 note', () => {
    expect(decideOwnerSelf({ sessionLogin: 'crewflow_owner', currentLogin: 'crewflow_owner' }, { ...ownerFacts, oCreateRole: false })).toEqual([
      OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened,
    ]);
  });

  it('the option-2 statements carry no value; the self ALTER only through %L of the bind-parameter setting; CONTEXT stripped', () => {
    // No value, and not even the verifier prefix (the server-log scans search for it).
    for (const text of OWNER_SELF_STATEMENTS) expect(text).not.toMatch(/postgres:\/\/|\$4096:|SCRAM-SHA-256\$/);
    expect(OWNER_SELF_O4C_DO).toContain("pg_catalog.current_setting('crewflow_bootstrap.verifier')");
    expect(OWNER_SELF_O4C_DO).toContain("EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_verifier);");
    expect(OWNER_SELF_O4C_DO).toContain("RAISE EXCEPTION 'crewflow_owner password reset failed (%)', SQLSTATE USING ERRCODE = SQLSTATE;");
    expect(OWNER_SELF_O4C_DO).toContain("session_user::text <> 'crewflow_owner' OR current_user::text <> session_user::text");
    // Never anything but the password: no CREATE ROLE, no GRANT, no attribute, no extension.
    expect(OWNER_SELF_O4C_DO).not.toMatch(/CREATE |GRANT |EXTENSION|SUPERUSER |BYPASSRLS |VALID UNTIL/);
  });
});

describe('owner bootstrap: security review H1 / L2 / M2 / I1 / I2', () => {
  it('H1/L2: every bootstrap driver config (admin, probe, derived) carries search_path=pg_catalog,pg_temp and default_transaction_read_only=off', () => {
    for (const url of [ADMIN_URL, 'postgres://crewflow_owner:ownerpw0123456789@db.internal.example:5432/crewflow_unit']) {
      const env = { PG_DATABASE_URL: url, APP_SECRET: SECRET, NODE_ENV: 'test' };
      const plan = planDbSetup({ databaseUrl: url, appSecret: SECRET });
      const configs = bootstrapDriverConfigs(resolvePgEnvironment(env, { processRole: 'migrate' }), plan.runtimeUrl);
      for (const [name, config] of Object.entries(configs)) {
        const options = String(config.options ?? '');
        expect({ name, pinned: options.includes('-c search_path=pg_catalog,pg_temp') }).toEqual({ name, pinned: true });
        expect({ name, rw: options.includes('-c default_transaction_read_only=off') }).toEqual({ name, rw: true });
        // The pin comes LAST, after the factory's own options (a later -c wins in the startup packet).
        expect(options.endsWith(BOOTSTRAP_SESSION_STARTUP_OPTIONS)).toBe(true);
      }
    }
  });

  it('H1: Q0 pins search_path before anything else; Q2 reads the database owner and the search_path defaults', () => {
    expect(OWNER_BOOTSTRAP_Q0_SESSION.startsWith('SET search_path TO pg_catalog, pg_temp;')).toBe(true);
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain("pg_catalog.pg_has_role(o.oid, d.datdba, 'MEMBER')");
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain('FROM pg_catalog.pg_db_role_setting s');
  });

  it('H1: the admin path refuses (64) a database crewflow_owner owns, and a database-wide / crewflow_owner search_path default', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oOwnsDb: true, searchPathDefaultSet: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerOwnsDatabase);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oOwnsDb: false, searchPathDefaultSet: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.searchPathDefault);
    expect(decideBeforeProbe({ ...existing, oOwnsDb: false, searchPathDefaultSet: false })).toEqual([]);
    // A SUPERUSER crewflow_owner is a member of every role (the database owner included): named by its attribute first.
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oSuper: true, oOwnsDb: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['SUPERUSER']));
  });

  it('M2: the pre-hashed refusals say the configuration is not supported and offer no workaround', () => {
    for (const message of [OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501'), OWNER_BOOTSTRAP_MESSAGES.ownerWriteRefused('42501')]) {
      expect(message).toContain('If this provider refuses pre-hashed passwords, this configuration is not supported.');
      expect(message).not.toMatch(/by hand|ALTER ROLE|01-crewflow-owner|derive command/);
    }
  });

  it('I1: the O4c shape check accepts a real verifier and rejects malformed values (the 22023 branch)', () => {
    const match = /OPERATOR\(pg_catalog\.~\) '([^']+)'/.exec(OWNER_SELF_O4C_DO);
    expect(match).not.toBeNull();
    const pattern = new RegExp(match![1]!);
    expect(pattern.test(scramSha256Verifier('a'.repeat(64)))).toBe(true);
    const key = 'A'.repeat(43) + '=';
    for (const bad of [
      '', 'a'.repeat(64), 'SCRAM-SHA-256$4096:c2FsdA==', 'SCRAM-SHA-256$x:c2FsdA==$a:b', 'SCRAM-SHA-256$4096:c2FsdA==$a:b;DROP', 'md5abc',
      'SCRAM-SHA-256$4096:c2FsdA==$a:b\n',
      // Re-review N3: zero / leading-zero iterations, short keys, padding in the middle, an over-long iteration count.
      `SCRAM-SHA-256$0:c2FsdA==$${key}:${key}`, `SCRAM-SHA-256$04096:c2FsdA==$${key}:${key}`,
      `SCRAM-SHA-256$4096:c2FsdA==$${'A'.repeat(42)}=:${key}`, `SCRAM-SHA-256$4096:c2FsdA==$${key}:${'A'.repeat(10)}=`,
      `SCRAM-SHA-256$4096:c2=FsdA==$${key}:${key}`, `SCRAM-SHA-256$12345678901:c2FsdA==$${key}:${key}`,
    ]) {
      expect({ bad, ok: pattern.test(bad) }).toEqual({ bad, ok: false });
    }
    expect(pattern.test(`SCRAM-SHA-256$4096:c2FsdA==$${key}:${key}`)).toBe(true);
    expect(OWNER_SELF_O4C_DO).toContain("RAISE EXCEPTION 'not a pre-hashed verifier' USING ERRCODE = '22023';");
    // N3: the admin path's Q4c carries the SAME pattern, before CREATE / ALTER ROLE.
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain(`OPERATOR(pg_catalog.~) '${match![1]}'`);
    expect(OWNER_BOOTSTRAP_Q4C_DO.indexOf('not a pre-hashed verifier')).toBeLessThan(OWNER_BOOTSTRAP_Q4C_DO.indexOf('CREATE ROLE crewflow_owner'));
  });

  it('I2: O4c re-checks the recursive privileged membership inside the statement, before the ALTER', () => {
    const at = (needle: string) => OWNER_SELF_O4C_DO.indexOf(needle);
    expect(at('WITH RECURSIVE up(oid)')).toBeGreaterThan(0);
    expect(at("RAISE EXCEPTION 'crewflow_owner is a member of a privileged role'")).toBeGreaterThan(0);
    expect(at('WITH RECURSIVE up(oid)')).toBeLessThan(at('ALTER ROLE crewflow_owner PASSWORD'));
    for (const role of ['pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program', 'pg_maintain']) expect(OWNER_SELF_O4C_DO).toContain(`'${role}'`);
  });
});

describe('owner bootstrap: security re-review N2 / N4', () => {
  it('N2: o_owns_db uses MEMBER (an INHERIT FALSE, SET TRUE membership of the owner counts)', () => {
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain("pg_catalog.pg_has_role(o.oid, d.datdba, 'MEMBER')");
    expect(OWNER_BOOTSTRAP_Q2_FACTS).not.toContain("d.datdba, 'USAGE'");
  });

  it('N4: a facts column that is not a boolean (or a count) is a failure (70), never silently false', () => {
    const row = {
      server_version_num: 160004, admin_super: false, admin_createrole: true, admin_can_grant_db: true, owner_exists: true,
      o_login: true, o_super: false, o_bypassrls: false, o_replication: false, o_createdb: false, o_createrole: true,
      o_inherit: true, o_expired: false, admin_has_admin_option: true, o_privileged_memberships: '0', o_has_db_grant: true,
      o_owns_db: false, search_path_default_set: false,
    };
    expect(factsFromRow(row).oOwnsDb).toBe(false);
    for (const [column, value] of [['o_owns_db', 't'], ['search_path_default_set', undefined], ['admin_super', 1], ['o_super', 'false'], ['o_privileged_memberships', 'x'], ['server_version_num', 'abc']] as const) {
      expect(() => factsFromRow({ ...row, [column]: value })).toThrow(OwnerBootstrapFailure);
    }
    // NULL is accepted only where crewflow_owner may be missing.
    expect(factsFromRow({ ...row, owner_exists: false, o_login: null, o_super: null, o_privileged_memberships: null }).oSuper).toBeNull();
    expect(() => factsFromRow({ ...row, o_owns_db: null })).toThrow(OwnerBootstrapFailure);
  });
});
