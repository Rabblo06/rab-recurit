/**
 * DB setup like Twenty, area 2: unit tests of the bootstrap child's decisions, error mapping, statement hygiene and the
 * fixed advisory key. The real-database behaviour (PG16/17/18, B3/B4/B5, restart, rotation, races) is
 * bootstrap-owner-login-check.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import { OWNER_CREDENTIAL_MESSAGES } from '../../../owner-login/owner-credential';
import { type OwnerPasswordRead, OwnerPasswordFileError, OWNER_PASSWORD_FILE_MESSAGES } from '../../../owner-login/owner-password-file';
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
  type OwnerPasswordFiles,
  OwnerUrlIo,
  planWrite,
  resolveStoredPassword,
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
  OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES,
  OWNER_URL_SESSION_STARTUP_OPTIONS,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_SELF_O1_SESSION,
  OWNER_SELF_STATEMENTS,
  BOOTSTRAP_SESSION_STARTUP_OPTIONS,
} from './owner-bootstrap-sql';
import { buildRuntimeDatabaseUrl, scramSha256Verifier } from '../../../owner-login/owner-credential';
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

describe('owner bootstrap: §3.4 probe and the write plan (Twenty Helm model)', () => {
  it('creates a missing role with this run\'s password and the grant (stored or new password alike)', () => {
    expect(planWrite(base, null, 'file')).toEqual({ write: true, create: true, needPassword: true, needGrant: true });
    expect(planWrite(base, null, 'new')).toEqual({ write: true, create: true, needPassword: true, needGrant: true });
  });
  it('stored password logs in + grant present: changes nothing (Twenty: an existing user is skipped)', () => {
    expect(planWrite(existing, { ok: true }, 'file')).toEqual({ write: false, create: false, needPassword: false, needGrant: false });
  });
  it('adds only the grant when the stored password is right', () => {
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: true }, 'file')).toEqual({ write: true, create: false, needPassword: false, needGrant: true });
  });
  it('A3.1: the stored password no longer logs in (28P01) -> REFUSED with the fix message, never an automatic reset', () => {
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '28P01' }, 'file'))).toBe(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale);
    expect(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale).toContain('Delete the password file and start again with the admin address');
  });
  it('42501 while CONNECT is not granted yet: only the grant (the post-commit probe decides)', () => {
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: false, code: '42501' }, 'file')).toEqual({ write: true, create: false, needPassword: false, needGrant: true });
  });
  it('A4 (Crewflow addition): the file was lost and the role exists -> reset to the new password (no probe needed)', () => {
    expect(planWrite(existing, null, 'new')).toEqual({ write: true, create: false, needPassword: true, needGrant: false });
  });
  it('A4 refuses a reset without ADMIN OPTION, or without CREATEROLE', () => {
    expect(refusalOf(() => planWrite({ ...existing, adminHasAdminOption: false }, null, 'new'))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNoAdminOption);
    expect(refusalOf(() => planWrite({ ...existing, adminCreateRole: false }, null, 'new'))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotResetPassword);
    // Without a reset, no ADMIN OPTION is needed (a role created by another login, stored password right).
    expect(planWrite({ ...existing, adminHasAdminOption: false }, { ok: true }, 'file').write).toBe(false);
  });
  it('refuses any other probe failure with the SQLSTATE class only', () => {
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '28000' }, 'file'))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('28'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '42501' }, 'file'))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('42'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: 'ECONNRESET' }, 'file'))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('??'));
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
function fakeIo(
  facts: OwnerFacts[],
  probes: Array<{ ok: true } | { ok: false; code: string }>,
  opts: { failOn?: string; failCode?: string; openErrors?: string[]; otherDatabase?: unknown } = {},
) {
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
      if (text === OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES) return { rows: [{ o_other_database: 'otherDatabase' in opts ? opts.otherDatabase : false }] };
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

  it('re-plans under the lock: with the stored password, a role another start created meanwhile that it cannot log in to is the stale-file refusal (rolled back)', async () => {
    const { io, sent } = fakeIo([base, existing], [{ ok: false, code: '28P01' }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale);
    const texts = sent.map((s) => s.text);
    const lockAt = texts.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK);
    expect(lockAt).toBeGreaterThan(texts.indexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(texts.indexOf(OWNER_BOOTSTRAP_Q2_FACTS, lockAt)).toBeGreaterThan(lockAt);
    expect(texts).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
    expect(texts[texts.length - 1]).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('a NEW password (file lost) is stored BEFORE the transaction, once; a role found under the lock is reset to it (A4), "updated"', async () => {
    const order: string[] = [];
    const { io, sent } = fakeIo([base, existing, existing], [{ ok: true }]);
    io.passwordSource = 'new';
    io.persistPassword = () => void order.push(`persist@${sent.length}`);
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toEqual({ outcome: 'updated', exitCode: 0, created: false, passwordSet: true, grantAdded: false, code: null });
    expect(order).toHaveLength(1);
    const persistAt = Number(order[0]!.split('@')[1]);
    expect(persistAt).toBeLessThanOrEqual(sent.findIndex((q) => q.text === OWNER_BOOTSTRAP_BEGIN));
    expect(sent.find((q) => q.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)?.values?.[1]).toBe('true');
  });

  it('a NEW password that cannot be stored (another run stored one first, EEXIST) stops the run before any database write', async () => {
    const { io, sent } = fakeIo([base], [{ ok: true }]);
    io.passwordSource = 'new';
    io.persistPassword = () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    };
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.passwordFileRace);
    expect(sent.map((q) => q.text)).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('a refused run never stores a NEW password (refusals first)', async () => {
    const stored: string[] = [];
    const { io } = fakeIo([{ ...base, adminCreateRole: false, adminSuper: false }], [{ ok: true }]);
    io.passwordSource = 'new';
    io.persistPassword = () => void stored.push('x');
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.adminCannotCreateRoles);
    expect(stored).toEqual([]);
  });

  it('grant only, then the post-commit probe is 28P01: the stale-file refusal (64), not a silent success', async () => {
    const { io } = fakeIo([{ ...existing, oHasDbGrant: false }, { ...existing, oHasDbGrant: false }], [{ ok: false, code: '42501' }, { ok: false, code: '42501' }, { ok: false, code: '28P01' }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale);
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

describe('owner bootstrap: one Crewflow deployment per PostgreSQL cluster (security review L4, owner-approved, read-only)', () => {
  it('Q2b is one fixed SELECT (no write, no parameter, no value), in the admin statement list', () => {
    expect(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES.startsWith('SELECT EXISTS (')).toBe(true);
    expect(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|SET|DO|COPY|TRUNCATE|set_config|nextval|pg_advisory)\b|\$\d/i);
    expect(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES).toContain('pg_catalog.pg_shdepend');
    expect(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES).toContain('pg_catalog.current_database()');
    expect(OWNER_BOOTSTRAP_ADMIN_STATEMENTS).toContain(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
  });

  it('DENIAL: an A4 reset while crewflow_owner is used by another database is refused (64) before anything is stored or written', async () => {
    const stored: string[] = [];
    const { io, sent } = fakeIo([existing, existing], [{ ok: true }], { otherDatabase: true });
    io.passwordSource = 'new';
    io.persistPassword = () => void stored.push('x');
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase);
    expect(OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase).toContain('one deployment per PostgreSQL cluster when using an admin URL');
    expect(stored).toEqual([]);
    const texts = sent.map((q) => q.text);
    expect(texts).toContain(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
    expect(texts).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('an A4 reset with no other database runs (Q2b false, before and under the lock)', async () => {
    const { io, sent } = fakeIo([existing, existing, existing], [{ ok: true }], { otherDatabase: false });
    io.passwordSource = 'new';
    io.persistPassword = () => undefined;
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'updated', passwordSet: true });
    const texts = sent.map((q) => q.text);
    expect(texts.filter((t) => t === OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toHaveLength(2);
    expect(texts.lastIndexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toBeGreaterThan(texts.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
  });

  it('Q2b is sent only before an A4 reset: never for a stored password, never when the role is created', async () => {
    const restart = fakeIo([existing], [{ ok: true }], { otherDatabase: true });
    expect(await bootstrapOwnerWithIo(restart.io)).toMatchObject({ outcome: 'unchanged' });
    const fresh = fakeIo([base, base, existing], [{ ok: true }], { otherDatabase: true });
    fresh.io.passwordSource = 'new';
    fresh.io.persistPassword = () => undefined;
    expect(await bootstrapOwnerWithIo(fresh.io)).toMatchObject({ outcome: 'created' });
    for (const f of [restart, fresh]) expect(f.sent.map((q) => q.text)).not.toContain(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
  });

  it('fail closed: a Q2b row that is not exactly one boolean is a failure (70), never a reset', async () => {
    for (const v of [null, 'false', 0, undefined]) {
      const { io, sent } = fakeIo([existing, existing], [{ ok: true }], { otherDatabase: v });
      io.passwordSource = 'new';
      io.persistPassword = () => undefined;
      await expect(bootstrapOwnerWithIo(io)).rejects.toBeInstanceOf(OwnerBootstrapFailure);
      expect(sent.map((q) => q.text)).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
    }
  });
});

describe('owner bootstrap: the pending password file (security review L1)', () => {
  const quiet = () => {
    const lines: string[] = [];
    let clock = 0;
    return {
      lines,
      io: {
        log: (l: string) => void lines.push(l),
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      },
    };
  };
  const neverProbed = async (): Promise<never> => {
    throw new Error('the pending password must not be probed');
  };

  it('no pending file: owner-password decides (ready -> file, missing -> new); nothing is written', async () => {
    const a = memFiles({ main: 'stored-password-1' });
    const r1 = await resolveStoredPassword(a.files, neverProbed, quiet().io, 0);
    expect(r1.source).toBe('file');
    expect(r1.source === 'file' && r1.password).toBe('stored-password-1');
    expect(Object.keys(r1)).toEqual(['source']); // the password is not enumerable
    const b = memFiles();
    expect(await resolveStoredPassword(b.files, neverProbed, quiet().io, 0)).toEqual({ source: 'new' });
    expect([...a.calls, ...b.calls]).toEqual([]);
  });

  it('a pending password that logs in (or authenticates without CONNECT, 42501) is promoted and used', async () => {
    for (const probe of [{ ok: true } as const, { ok: false, code: '42501' } as const]) {
      const m = memFiles({ next: 'new-password-2' });
      const q = quiet();
      const tried: string[] = [];
      const r = await resolveStoredPassword(m.files, async (pw) => (tried.push(pw), probe), q.io, 0);
      expect(r.source === 'file' && r.password).toBe('new-password-2');
      expect(tried).toEqual(['new-password-2']);
      expect(m.state).toEqual({ main: 'new-password-2' });
      expect(q.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.pendingPromoted]);
    }
  });

  it('a pending password that does not log in (28P01) is deleted; owner-password decides', async () => {
    const m = memFiles({ main: 'stored-password-1', next: 'new-password-2' });
    const q = quiet();
    const r = await resolveStoredPassword(m.files, async () => ({ ok: false, code: '28P01' }), q.io, 0);
    expect(r.source === 'file' && r.password).toBe('stored-password-1');
    expect(m.state).toEqual({ main: 'stored-password-1' });
    expect(q.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.pendingDiscarded]);
  });

  it('the pending probe retries connection-refused within the window; any other failure keeps the pending file (70)', async () => {
    const m = memFiles({ next: 'new-password-2' });
    const probes = [{ ok: false, code: 'ECONNREFUSED' }, { ok: false, code: '57P03' }, { ok: true }] as const;
    let i = 0;
    const r = await resolveStoredPassword(m.files, async () => probes[i++]!, quiet().io, 60_000);
    expect(r.source).toBe('file');
    expect(i).toBe(3);
    for (const code of ['TLS', '28000', 'ECONNREFUSED']) {
      const k = memFiles({ next: 'new-password-2' });
      const error = await resolveStoredPassword(k.files, async () => ({ ok: false, code }), quiet().io, 0).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OwnerBootstrapFailure);
      expect(k.state).toEqual({ next: 'new-password-2' });
    }
  });

  it('an unusable pending file (empty, symlink, FIFO, ...) is deleted, never used; an unusable owner-password is a refusal (64)', async () => {
    const m = memFiles({ main: 'stored-password-1', next: 'x' });
    const files: OwnerPasswordFiles = {
      ...m.files,
      readNext: () => {
        throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.notRegular);
      },
    };
    const q = quiet();
    const r = await resolveStoredPassword(files, neverProbed, q.io, 0);
    expect(r.source === 'file' && r.password).toBe('stored-password-1');
    expect(m.state.next).toBeUndefined();
    expect(q.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.pendingUnusable]);
    const bad: OwnerPasswordFiles = {
      ...memFiles().files,
      readMain: () => {
        throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
      },
    };
    await expect(resolveStoredPassword(bad, neverProbed, quiet().io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
  });

  it('A4: the new password is stored as the pending file before the transaction and promoted only after COMMIT + the post-commit login', async () => {
    const m = memFiles();
    const { io, sent } = fakeIo([existing, existing, existing], [{ ok: true }]);
    const order: string[] = [];
    io.passwordSource = 'new';
    io.persistPassword = () => {
      order.push(`persist@${sent.length}`);
      m.files.writeNextExclusive('new-password-2');
    };
    io.promotePassword = () => {
      order.push(`promote@${sent.length}`);
      m.files.promoteNext();
    };
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'updated', passwordSet: true });
    const texts = sent.map((q) => q.text);
    expect(Number(order[0]!.split('@')[1])).toBeLessThanOrEqual(texts.indexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(Number(order[1]!.split('@')[1])).toBeGreaterThan(texts.indexOf(OWNER_BOOTSTRAP_COMMIT));
    expect(m.state).toEqual({ main: 'new-password-2' });
  });

  it('A4: Q4c throws 22023 after the new password was stored -> owner-password untouched; the next start probes 28P01, deletes the pending file and resets again', async () => {
    // The role still has the old password P1; owner-password was lost (that is why A4 runs).
    const m = memFiles();
    const first = fakeIo([existing, existing], [{ ok: true }], { failOn: OWNER_BOOTSTRAP_Q4C_DO, failCode: '22023' });
    first.io.passwordSource = 'new';
    first.io.persistPassword = () => m.files.writeNextExclusive('new-password-2');
    first.io.promotePassword = () => m.files.promoteNext();
    await expect(bootstrapOwnerWithIo(first.io)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
    expect(first.sent.map((q) => q.text)).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(m.state).toEqual({ next: 'new-password-2' }); // never promoted: no file the role rejects

    // The rerun: the pending password does not log in (nothing was committed).
    const q = quiet();
    const stored = await resolveStoredPassword(m.files, async () => ({ ok: false, code: '28P01' }), q.io, 0);
    expect(stored).toEqual({ source: 'new' });
    expect(m.state).toEqual({});
    expect(q.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.pendingDiscarded]);

    // ... and the intended A4 outcome: a fresh password, reset, promoted.
    const second = fakeIo([existing, existing, existing], [{ ok: true }]);
    second.io.passwordSource = 'new';
    second.io.persistPassword = () => m.files.writeNextExclusive('new-password-3');
    second.io.promotePassword = () => m.files.promoteNext();
    expect(await bootstrapOwnerWithIo(second.io)).toMatchObject({ outcome: 'updated', passwordSet: true });
    expect(m.state).toEqual({ main: 'new-password-3' });
  });

  it('a crash after COMMIT (before the promotion): the next start finds the pending password logs in and promotes it', async () => {
    const m = memFiles();
    const { io } = fakeIo([base, base, existing], [{ ok: true }]);
    io.passwordSource = 'new';
    io.persistPassword = () => m.files.writeNextExclusive('new-password-2');
    io.promotePassword = () => {
      throw Object.assign(new Error('/run/crewflow/db-target busy'), { code: 'EIO' });
    };
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.passwordPromoteFailed('EIO'));
    expect(m.state).toEqual({ next: 'new-password-2' });
    const r = await resolveStoredPassword(m.files, async () => ({ ok: true }), quiet().io, 0);
    expect(r.source === 'file' && r.password).toBe('new-password-2');
    expect(m.state).toEqual({ main: 'new-password-2' });
  });

  it('the stale-file and race messages are neutral (no claim about who changed what)', () => {
    expect(OWNER_BOOTSTRAP_MESSAGES.passwordFileStale).toBe(
      'The stored crewflow_owner password does not log in. Delete the password file and start again with the admin address in PG_DATABASE_URL. Refusing.',
    );
    expect(OWNER_BOOTSTRAP_MESSAGES.passwordFileRace).not.toMatch(/stored a crewflow_owner password/);
  });
});

const ready = (password: string): OwnerPasswordRead => ({ state: 'ready', password });

/** In-memory db-setup password files (`main` = owner-password, `next` = owner-password.next); `calls` records every write. */
function memFiles(init: { main?: string; next?: string } = {}, calls: string[] = []) {
  const state: { main?: string; next?: string } = { ...init };
  const files: OwnerPasswordFiles = {
    readMain: () => (state.main === undefined ? { state: 'missing' } : ready(state.main)),
    readNext: () => (state.next === undefined ? { state: 'missing' } : ready(state.next)),
    writeMain: (pw) => {
      calls.push('write-main');
      state.main = pw;
    },
    writeNextExclusive: (pw) => {
      if (state.next !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      calls.push('write-next');
      state.next = pw;
    },
    promoteNext: () => {
      calls.push('promote');
      state.main = state.next;
      delete state.next;
    },
    removeNext: () => {
      if (state.next !== undefined) calls.push('remove-next');
      delete state.next;
    },
  };
  return { files, state, calls };
}
describe('owner bootstrap: the whole step without a database', () => {
  const run = async (env: Record<string, string | undefined>, written: string[] = []) => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(env, {
      log: (l) => lines.push(l),
      retryWindowMs: 0,
      passwordFiles: memFiles({}, written).files,
    });
    return { result, text: [...lines, resultLine(result)].join('\n') };
  };
  const assertClean = (text: string) => {
    for (const forbidden of [ADMIN_PW, 'db.internal.example', 'crewflow_unit', 'dbadmin', SECRET, 'SCRAM-SHA-256$']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s)]*@/i); // a URL with userinfo (the fixed text "a postgres:// URL" is fine)
  };

  it('APP_SECRET plays no part: the same refusal / failure with or without it (db-setup does not receive it)', async () => {
    for (const env of [{}, { APP_SECRET: SECRET }, { APP_SECRET: 'short' }]) {
      const { result, text } = await run({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit', ...env });
      expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
      assertClean(text);
    }
  });

  it('a crewflow_owner URL connects (unreachable port -> exit 70, fixed text); nothing is stored when it fails', async () => {
    const written: string[] = [];
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://crewflow_owner:ownerpw0123456789@127.0.0.1:1/crewflow_unit' }, written);
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    expect(text).toContain(OWNER_BOOTSTRAP_MESSAGES.passThrough);
    expect(text).not.toContain('ownerpw0123456789');
    expect(written).toEqual([]);
    assertClean(text);
  });

  it('a pooler-shaped URL (either login) is refused before connecting', async () => {
    for (const login of ['crewflow_owner', 'dbadmin']) {
      const { result, text } = await run({ PG_DATABASE_URL: `postgres://${login}:ownerpw0123456789@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit` });
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      expect(text).toContain(OWNER_CREDENTIAL_MESSAGES.transactionPooler);
    }
  });

  it('a refused or failed admin run never stores a new password (the file is written only before a real database write)', async () => {
    const written: string[] = [];
    await run({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit' }, written);
    await run({ PG_DATABASE_URL: `${ADMIN_URL}?sslrootcert=/etc/x.pem` }, written);
    expect(written).toEqual([]);
  });

  it('without the password-file I/O the step fails closed (70)', async () => {
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: ADMIN_URL }, { retryWindowMs: 0 });
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70 });
  });

  it('an unreadable / invalid password file is a refusal (64) before connecting', async () => {
    const { OwnerPasswordFileError: E } = await import('../../../owner-login/owner-password-file');
    const result = await runOwnerBootstrap(
      { PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit' },
      { retryWindowMs: 0, passwordFiles: { ...memFiles().files, readMain: () => { throw new E('bad'); } } },
    );
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
  });

  it('refuses a URL the policy refuses (sslrootcert, ?host=, pooler) without echoing it', async () => {
    for (const url of [
      `${ADMIN_URL}?sslrootcert=/etc/x.pem`,
      `${ADMIN_URL}?host=elsewhere`,
      `postgres://dbadmin:${ADMIN_PW}@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit`,
      'not a url with dbadmin and adminpw0123456789',
    ]) {
      const { result, text } = await run({ PG_DATABASE_URL: url });
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      assertClean(text);
    }
  });

  it('refuses when only the legacy DATABASE_URL is set (the step takes PG_DATABASE_URL only)', async () => {
    const { result } = await run({ DATABASE_URL: ADMIN_URL });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
  });

  it('production refuses a non-verify-full admin URL before connecting', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: `${ADMIN_URL}?sslmode=disable`, NODE_ENV: 'production' });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
    assertClean(text);
  });

  it('an unreachable admin target is exit 70 with fixed text', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit' });
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
        passwordFiles: memFiles({}, calls).files,
        publishTarget: () => void calls.push('publish'),
        withdrawTarget: () => void calls.push('withdraw'),
      },
    };
  };

  it('a crewflow_owner URL that fails withdraws the stale target, never publishes, never stores a password', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: 'postgres://crewflow_owner:x@127.0.0.1:1/crewflow_unit' }, h.options);
    expect(result.exitCode).toBe(70);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a refusal (a policy-refused URL) withdraws the stale target and never publishes', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: `${ADMIN_URL}?sslrootcert=/x` }, h.options);
    expect(result.exitCode).toBe(64);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a failure (unreachable database) withdraws and never publishes', async () => {
    const h = hooks();
    const result = await runOwnerBootstrap({ PG_DATABASE_URL: 'postgres://dbadmin:adminpw0123456789@127.0.0.1:1/crewflow_unit' }, h.options);
    expect(result.exitCode).toBe(70);
    expect(h.calls).toEqual(['withdraw']);
  });

  it('a withdraw that fails is reported with a fixed line; the exit code is unchanged', async () => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(
      { PG_DATABASE_URL: `${ADMIN_URL}?sslrootcert=/x` },
      {
        log: (l) => lines.push(l),
        passwordFiles: memFiles().files,
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

describe('owner bootstrap: an existing crewflow_owner URL (read-only; Twenty: no setup step for an external database)', () => {
  const ownerFacts: OwnerFacts = { ...existing, adminSuper: false, adminCreateRole: true, adminHasAdminOption: false };
  const me = { session_login: 'crewflow_owner', current_login: 'crewflow_owner' };
  type Who = { session_login: string; current_login: string };

  function ownerIo(o: { urlErrors?: string[]; facts?: OwnerFacts; who?: Who } = {}) {
    const sent: string[] = [];
    const lines: string[] = [];
    const urlErrors = [...(o.urlErrors ?? [])];
    let clock = 0;
    const session: SqlSession = {
      async query(text) {
        sent.push(text);
        if (text === OWNER_BOOTSTRAP_Q0_SESSION) return { rows: [] };
        if (text === OWNER_SELF_O1_SESSION) return { rows: [o.who ?? me] };
        if (text === OWNER_BOOTSTRAP_Q2_FACTS) {
          const f = o.facts ?? ownerFacts;
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
        throw new Error(`unexpected statement in the read-only mode: ${text.slice(0, 30)}`);
      },
      async end() {
        /* closed */
      },
    };
    const io: OwnerUrlIo = {
      async openUrl() {
        const code = urlErrors.shift();
        if (code) throw Object.assign(new Error('connect failed'), { code });
        return session;
      },
      log: (l) => lines.push(l),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    return { io, sent, lines };
  }

  it('sends only Q0, O1, Q2 (read-only) and reports pass-through, nothing written', async () => {
    const f = ownerIo();
    expect(await setupOwnerUrlWithIo(f.io, 0)).toEqual({ outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, code: null });
    expect(f.sent).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS]);
  });

  it.each<[string, Partial<OwnerFacts>]>([
    ['SUPERUSER', { oSuper: true }],
    ['BYPASSRLS', { oBypassRls: true }],
    ['REPLICATION', { oReplication: true }],
    ['CREATEDB', { oCreateDb: true }],
    ['a privileged membership', { oPrivilegedMemberships: 1 }],
    ['an expired VALID UNTIL', { oExpired: true }],
    ['no database grant', { oHasDbGrant: false }],
    ['PostgreSQL 15', { serverVersionNum: 150008 }],
  ])('%s is refused (64)', async (_label, patch) => {
    const f = ownerIo({ facts: { ...ownerFacts, ...patch } });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toBeInstanceOf(OwnerBootstrapRefusal);
  });

  it('a session that is not crewflow_owner itself is refused', async () => {
    for (const who of [
      { session_login: 'crewflow_owner', current_login: 'postgres' },
      { session_login: 'postgres', current_login: 'crewflow_owner' },
    ]) {
      await expect(setupOwnerUrlWithIo(ownerIo({ who }).io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerNotSelf);
    }
  });

  it('a wrong URL password (28P01) is the login refusal (64); a missing database is the 3D000 refusal', async () => {
    await expect(setupOwnerUrlWithIo(ownerIo({ urlErrors: ['28P01'] }).io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.adminAuth('28P01'));
    await expect(setupOwnerUrlWithIo(ownerIo({ urlErrors: ['3D000'] }).io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.adminNoDatabase);
  });

  it('retries connection-refused within the window', async () => {
    expect((await setupOwnerUrlWithIo(ownerIo({ urlErrors: ['ECONNREFUSED', '57P03'] }).io, 10_000)).outcome).toBe('pass-through');
  });

  it('the NOCREATEROLE (hardened) owner is accepted with the D2 note', async () => {
    const f = ownerIo({ facts: { ...ownerFacts, oCreateRole: false } });
    await setupOwnerUrlWithIo(f.io, 0);
    expect(f.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened]);
    expect(decideOwnerSelf({ sessionLogin: 'crewflow_owner', currentLogin: 'crewflow_owner' }, { ...ownerFacts, oCreateRole: false })).toEqual([
      OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened,
    ]);
  });
});

describe('owner bootstrap: security review H1 / L2 / M2 / I1 / I2', () => {
  it('H1/L2: every bootstrap driver config (admin / URL login, probe) carries search_path=pg_catalog,pg_temp and default_transaction_read_only=off', () => {
    for (const url of [ADMIN_URL, 'postgres://crewflow_owner:ownerpw0123456789@db.internal.example:5432/crewflow_unit']) {
      const env = { PG_DATABASE_URL: url, NODE_ENV: 'test' };
      const configs = bootstrapDriverConfigs(resolvePgEnvironment(env, { processRole: 'migrate' }), buildRuntimeDatabaseUrl(url, 'f'.repeat(64)));
      expect(Object.keys(configs).sort()).toEqual(['admin', 'ownerUrl', 'probe']);
      for (const [name, config] of Object.entries(configs)) {
        const options = String(config.options ?? '');
        expect({ name, pinned: options.includes('-c search_path=pg_catalog,pg_temp') }).toEqual({ name, pinned: true });
        // I1: only the owner-URL mode's crewflow_owner session is read-only; the admin and probe sessions stay read-write.
        const want = name === 'ownerUrl' ? OWNER_URL_SESSION_STARTUP_OPTIONS : BOOTSTRAP_SESSION_STARTUP_OPTIONS;
        expect({ name, ro: options.includes('-c default_transaction_read_only=on') }).toEqual({ name, ro: name === 'ownerUrl' });
        expect({ name, rw: options.includes('-c default_transaction_read_only=off') }).toEqual({ name, rw: name !== 'ownerUrl' });
        // The pin comes LAST, after the factory's own options (a later -c wins in the startup packet).
        expect({ name, last: options.endsWith(want) }).toEqual({ name, last: true });
      }
      // The same login, host and database: only the startup options differ.
      const { options: _a, ...admin } = configs.admin;
      const { options: _b, ...ownerUrl } = configs.ownerUrl;
      expect(ownerUrl).toEqual(admin);
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
    for (const message of [OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501')]) {
      expect(message).toContain('If this provider refuses pre-hashed passwords, this configuration is not supported.');
      expect(message).not.toMatch(/by hand|ALTER ROLE|01-crewflow-owner|derive command/);
    }
  });

  it('I1 / N3: the Q4c shape check accepts a real verifier and rejects malformed values (the 22023 branch)', () => {
    const match = /OPERATOR\(pg_catalog\.~\) '([^']+)'/.exec(OWNER_BOOTSTRAP_Q4C_DO);
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
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain("RAISE EXCEPTION 'not a pre-hashed verifier' USING ERRCODE = '22023';");
    expect(OWNER_BOOTSTRAP_Q4C_DO.indexOf('not a pre-hashed verifier')).toBeLessThan(OWNER_BOOTSTRAP_Q4C_DO.indexOf('CREATE ROLE crewflow_owner'));
  });

  it('Part A: O4c (crewflow_owner changing its own password) and step b are deleted; the owner-URL statements are read-only', () => {
    const sql = fs.readFileSync(path.join(__dirname, 'owner-bootstrap-sql.ts'), 'utf8');
    expect(sql).not.toMatch(/export const OWNER_SELF_O4C_DO/);
    expect(OWNER_SELF_STATEMENTS).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS]);
    for (const text of OWNER_SELF_STATEMENTS) {
      for (const statement of text.split(';')) expect(statement).not.toMatch(/^\s*(ALTER|CREATE|GRANT|REVOKE|INSERT|UPDATE|DELETE|DO|DROP)/i);
    }
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
