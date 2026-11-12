/**
 * DB setup like Twenty, area 2: unit tests of the bootstrap child's decisions, error mapping, statement hygiene and the
 * fixed advisory key. The real-database behaviour (PG16/17/18, B3/B4/B5, restart, rotation, races) is
 * bootstrap-owner-login-check.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import { deriveOwnerPassword, OWNER_CREDENTIAL_MESSAGES } from '../../../owner-login/owner-credential';
import {
  bootstrapOwnerWithIo,
  classifyAdminConnectError,
  classifyWriteError,
  decideBeforeProbe,
  OWNER_BOOTSTRAP_MESSAGES,
  OwnerBootstrapFailure,
  OwnerBootstrapIo,
  OwnerBootstrapRefusal,
  OwnerFacts,
  planWrite,
  resultLine,
  runOwnerBootstrap,
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
} from './owner-bootstrap-sql';

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

  it('pass-through: a crewflow_owner URL never connects (unreachable port) and ignores APP_SECRET', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://crewflow_owner:x@127.0.0.1:1/crewflow_unit', APP_SECRET: undefined });
    expect(result).toEqual({ outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null });
    expect(text).toContain(OWNER_BOOTSTRAP_MESSAGES.passThrough);
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
      expect(text).not.toMatch(/SCRAM-SHA-256|postgres:\/\//);
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
