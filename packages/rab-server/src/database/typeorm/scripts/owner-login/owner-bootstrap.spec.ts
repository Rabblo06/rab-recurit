/**
 * DB setup the Twenty way (owner decision 2026-11-18): unit tests of the bootstrap child's decisions, error mapping,
 * statement hygiene, the fixed advisory key and the CREATEROLE step. No database: every session is a fake that records the
 * statements it receives. The real-database behaviour (PG16/17/18, the three modes, the CREATEROLE lifecycle, races, PG15)
 * is bootstrap-owner-login-check.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DB_SETUP_INPUT_MESSAGES, OWNER_CREDENTIAL_MESSAGES, scramSha256Verifier } from '../../../owner-login/owner-credential';
import { PgSessionProbeError, resolvePgEnvironment } from '../../../postgres';
import { MIGRATION_LOCK_KEY } from '../migrate/migration-lock';
import { OWNER_CREATEROLE_GRACE_SECONDS, OWNER_CREATEROLE_MARK_PREFIX, OWNER_CREATEROLE_MARK_SQL_RE } from '../../../boot-checks/owner-login-posture';
import {
  ADMIN_DIRECT_URL_LABEL,
  applyAdminDirectUrl,
  applyAppSessionUrl,
  bootstrapDriverConfigs,
  bootstrapOwnerWithIo,
  PASSWORD_REQUIRED_SQLSTATES,
  OWNER_APP_PASSWORD_PATTERN,
  OWNER_SQL_BEGIN_MARKER,
  OWNER_SQL_END_MARKER,
  doBlockStage,
  isPasswordFormRefusal,
  PASSWORD_FORM_REFUSAL_SQLSTATES,
  RACE_SQLSTATES,
  WriteCommitError,
  classifyAdminConnectError,
  classifyOwnerUrlConnectError,
  classifyWriteError,
  decideBeforeProbe,
  decideCreateRole,
  decideOwnerSelf,
  decideOwnerUrlCreateRole,
  factsFromRow,
  HARDEN_DEFAULT_TIMEOUT_SECONDS,
  HardenIo,
  hardenOwnerWithIo,
  hardenTimeoutSeconds,
  imageMigrationNames,
  isSchemaComplete,
  OWNER_BOOTSTRAP_APPLICATION_NAME,
  OWNER_BOOTSTRAP_MESSAGES,
  OWNER_PROBE_APPLICATION_NAME,
  OwnerBootstrapFailure,
  OwnerBootstrapIo,
  OwnerBootstrapRefusal,
  OwnerFacts,
  OwnerUrlIo,
  planWrite,
  readLedgerNames,
  resultLine,
  runOwnerBootstrap,
  runOwnerHarden,
  setupOwnerUrlWithIo,
  SqlSession,
} from './owner-bootstrap';
import {
  OWNER_BOOTSTRAP_ADMIN_STATEMENTS,
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_LOCK_KEY,
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD,
  OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY,
  OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT,
  OWNER_AWAITING_PASSWORD_MARK,
  OWNER_SET_PASSWORD_SQL,
  OWNER_RESET_PASSWORD_SQL,
  awaitingMarkShapeSql,
  awaitingMarkValidSql,
  OWNER_BOOTSTRAP_NO_PASSWORD_STATEMENTS,
  OWNER_MANUAL_ROLE_SQL,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_HARDEN_ADMIN_STATEMENTS,
  OWNER_HARDEN_H1_NOCREATEROLE,
  OWNER_HARDEN_H2_CLEAR_MARK,
  OWNER_HARDEN_H3_MARK_PENDING,
  OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK,
  OWNER_HARDEN_M1_TRY_MIGRATION_LOCK,
  OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK,
  OWNER_HARDEN_R1_LEGACY_LOGINS,
  MIGRATION_LOCK_KEY_DECIMAL,
  OWNER_SCHEMA_S1_HAS_LEDGER,
  OWNER_SCHEMA_S2_LEDGER,
  OWNER_SELF_O1_SESSION,
  OWNER_SELF_STATEMENTS,
  OWNER_URL_SESSION_STARTUP_OPTIONS,
  BOOTSTRAP_SESSION_STARTUP_OPTIONS,
} from './owner-bootstrap-sql';

const SECRET = 'a'.repeat(16) + 'B'.repeat(16) + 'unit-test-only-secret';
const ADMIN_PW = 'adminpw0123456789';
const OWNER_PW = 'ownerpw-0123456789-abcdefghij-KLMNOPQR';
const ADMIN_URL = `postgres://dbadmin:${ADMIN_PW}@db.internal.example:5432/crewflow_unit`;
const APP_URL = `postgres://crewflow_owner:${OWNER_PW}@db.internal.example:5432/crewflow_unit`;
const H_STATEMENTS: string[] = [OWNER_HARDEN_H1_NOCREATEROLE, OWNER_HARDEN_H2_CLEAR_MARK, OWNER_HARDEN_H3_MARK_PENDING];

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
  oCreateRolePending: false,
  oCreateRoleMarkExpired: false,
  searchPathDefaultSet: false,
  oAwaitingPassword: false,
  oStaleAwaitingMark: false,
  oAwaitingMarkExpired: false,
  oForeignMembers: null,
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
  oForeignMembers: 0,
};
const marked: OwnerFacts = { ...existing, oCreateRolePending: true };
const hardened: OwnerFacts = { ...existing, oCreateRole: false };

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnerBootstrapRefusal) return error.message;
    throw error;
  }
  throw new Error('expected a refusal');
}

const factsRow = (f: OwnerFacts) => ({
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
  o_owns_db: f.oOwnsDb,
  o_createrole_pending: f.oCreateRolePending,
  o_createrole_mark_expired: f.oCreateRoleMarkExpired,
  search_path_default_set: f.searchPathDefaultSet,
  o_awaiting_password: f.oAwaitingPassword,
  o_stale_awaiting_mark: f.oStaleAwaitingMark,
  o_awaiting_mark_expired: f.oAwaitingMarkExpired,
  o_foreign_members: f.oForeignMembers === null ? null : String(f.oForeignMembers),
});

describe('owner bootstrap: §3.3 decisions', () => {
  it('refuses every PostgreSQL major outside 16-18 (14, 15, 19, 20, garbage), accepts 16, 17 and 18', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: 140011 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(14));
    expect(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(14)).toBe('PostgreSQL 14 is not supported; use 16-18 (PostgreSQL 16, 17 or 18). Nothing was created. Refusing.');
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: 150008 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(15));
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: 190000 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(19));
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: 200001 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(20));
    expect(refusalOf(() => decideBeforeProbe({ ...base, serverVersionNum: Number.NaN }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(null));
    expect(decideBeforeProbe({ ...base, serverVersionNum: 160015 })).toEqual([]);
    expect(decideBeforeProbe({ ...base, serverVersionNum: 170000 })).toEqual([]);
    expect(decideBeforeProbe({ ...base, serverVersionNum: 180001 })).toEqual([]);
  });

  it('the owner-URL mode refuses the same majors', () => {
    const self = { sessionLogin: 'crewflow_owner', currentLogin: 'crewflow_owner' };
    expect(refusalOf(() => decideOwnerSelf(self, { ...existing, serverVersionNum: 150008 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(15));
    expect(refusalOf(() => decideOwnerSelf(self, { ...existing, serverVersionNum: 190002 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(19));
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
    expect(decideBeforeProbe(hardened)).toEqual([OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened]);
  });

  it('refuses a privileged membership and an expired VALID UNTIL', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oPrivilegedMemberships: 1 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedMembership);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oExpired: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.expired);
  });

  it('refuses an admin that can neither create roles nor grant on the database', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...base, adminCreateRole: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotCreateRoles);
    expect(decideBeforeProbe({ ...base, adminCreateRole: false, adminSuper: true })).toEqual([]);
    expect(refusalOf(() => decideBeforeProbe({ ...base, adminCanGrantDb: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminCannotGrantDb);
    expect(decideBeforeProbe({ ...existing, adminCanGrantDb: false, adminCreateRole: false })).toEqual([]);
  });
});

describe('owner bootstrap: §3.4 the write plan (the password inside PG_DATABASE_URL)', () => {
  it('creates a missing role with that password and the grant', () => {
    expect(planWrite(base, null)).toEqual({ write: true, create: true, needPassword: true, needGrant: true });
  });
  it('the password logs in + grant present: changes nothing (Twenty: an existing user is skipped)', () => {
    expect(planWrite(existing, { ok: true })).toEqual({ write: false, create: false, needPassword: false, needGrant: false });
  });
  it('adds only the grant when the password is right', () => {
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: true })).toEqual({ write: true, create: false, needPassword: false, needGrant: true });
  });
  it('28P01 (the password does not log in): SET it when the admin may', () => {
    expect(planWrite(existing, { ok: false, code: '28P01' })).toEqual({ write: true, create: false, needPassword: true, needGrant: false });
    expect(planWrite({ ...existing, adminCreateRole: false, adminSuper: true }, { ok: false, code: '28P01' })).toMatchObject({ needPassword: true });
  });
  it('28P01 refuses a password change without ADMIN OPTION, or without CREATEROLE (and not superuser)', () => {
    expect(refusalOf(() => planWrite({ ...existing, adminHasAdminOption: false }, { ok: false, code: '28P01' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNoAdminOption);
    expect(refusalOf(() => planWrite({ ...existing, adminCreateRole: false, adminSuper: false }, { ok: false, code: '28P01' }))).toBe(
      OWNER_BOOTSTRAP_MESSAGES.adminCannotResetPassword,
    );
  });
  it('42501 while CONNECT is not granted yet: only the grant (the post-commit probe decides)', () => {
    expect(planWrite({ ...existing, oHasDbGrant: false }, { ok: false, code: '42501' })).toEqual({ write: true, create: false, needPassword: false, needGrant: true });
  });
  it('refuses any other probe failure with the SQLSTATE class only (42501 with the grant present included)', () => {
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '42501' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('42'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: '28000' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('28'));
    expect(refusalOf(() => planWrite(existing, { ok: false, code: 'TLS' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.probeFailed('??'));
  });
  it('an existing role without a probe is a failure (70)', () => {
    expect(() => planWrite(existing, null)).toThrow(OwnerBootstrapFailure);
  });
});

describe('owner bootstrap: error mapping', () => {
  const err = (code: string, message = 'secret-bearing driver text') => Object.assign(new Error(message), { code });
  it('admin connection', () => {
    expect(classifyAdminConnectError(err('28P01'), false)).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyAdminConnectError(err('28P01'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminAuth('28P01'));
    expect(classifyAdminConnectError(err('3D000'), false)).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyAdminConnectError(err('DEPTH_ZERO_SELF_SIGNED_CERT'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminTls);
    expect(classifyAdminConnectError(new Error('The server does not support SSL connections'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminTls);
    expect(classifyAdminConnectError(err('ECONNREFUSED'), true).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminUnreachable);
    expect(classifyAdminConnectError(err('53300'), false)).toBeInstanceOf(OwnerBootstrapFailure);
  });
  it('the crewflow_owner session of mode c: a login refusal names PG_DATABASE_URL and the no-admin rule', () => {
    for (const code of ['28P01', '28000']) {
      const e = classifyOwnerUrlConnectError(err(code), false);
      expect(e).toBeInstanceOf(OwnerBootstrapRefusal);
      expect(e.message).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerUrlAuth(code));
    }
    expect(OWNER_BOOTSTRAP_MESSAGES.ownerUrlAuth('28P01')).toContain('Without PG_ADMIN_URL db-setup never changes the password');
    expect(classifyOwnerUrlConnectError(err('3D000'), false).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNoDatabase);
  });
  it('write transaction', () => {
    expect(classifyWriteError(err('42710'))).toBe('race');
    expect(classifyWriteError(err('23505'))).toBe('race');
    // Owner decision 2026-11-19: XX000 is a race ONLY with PostgreSQL's fixed "tuple concurrently updated" text.
    expect(classifyWriteError(err('XX000', 'tuple concurrently updated'))).toBe('race');
    expect(classifyWriteError(err('XX000'))).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyWriteError(err('40P01'))).toBe('race');
    expect(classifyWriteError(err('42501'))).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyWriteError(err('22023'))).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(classifyWriteError(err('57014'))).toBeInstanceOf(OwnerBootstrapFailure);
  });
  it('never carries the driver message', () => {
    for (const e of [classifyAdminConnectError(err('XX001'), false), classifyOwnerUrlConnectError(err('XX001'), false), classifyWriteError(err('XX001')) as Error]) {
      expect(e.message).not.toContain('secret-bearing');
    }
  });
});

/** The last statement of a run, ignoring the migration-lock release that follows a removal's COMMIT / ROLLBACK. */
const lastTx = (t: readonly string[]): string | undefined => t.filter((x) => x !== OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK).slice(-1)[0];

type Probe = { ok: true } | { ok: false; code: string };

/** A fake admin session + probe recording every statement and its bind values. */
function fakeIo(
  facts: OwnerFacts[],
  probes: Probe[],
  opts: {
    failOn?: string;
    failCode?: string;
    failTimes?: number;
    failMessage?: string;
    failHint?: string;
    openErrors?: string[];
    otherDatabase?: unknown;
    schemaComplete?: boolean;
    migrationBusy?: boolean;
    legacyLogin?: string[];
  } = {},
) {
  const sent: Array<{ text: string; values?: unknown[] }> = [];
  const lines: string[] = [];
  let clock = 0;
  let failures = opts.failTimes ?? Number.POSITIVE_INFINITY;
  const openErrors = [...(opts.openErrors ?? [])];
  let legacyLeft = [...(opts.legacyLogin ?? [])];
  const session: SqlSession = {
    async query(text, values) {
      sent.push({ text, values });
      if (opts.failOn && text === opts.failOn && failures > 0) {
        failures -= 1;
        throw Object.assign(new Error(opts.failMessage ?? 'driver text with verifier SCRAM-SHA-256$4096:x'), {
          code: opts.failCode,
          ...(opts.failHint ? { hint: opts.failHint } : {}),
        });
      }
      if (text === OWNER_BOOTSTRAP_Q2_FACTS) {
        const f = facts.length > 1 ? facts.shift()! : facts[0]!;
        return { rows: [factsRow(f)] };
      }
      if (text === OWNER_BOOTSTRAP_Q4D_REVERIFY || text === OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY) return { rows: [{ ok: true }] };
      if (text === OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES) return { rows: [{ o_other_database: 'otherDatabase' in opts ? opts.otherDatabase : false }] };
      if (text === OWNER_HARDEN_M1_TRY_MIGRATION_LOCK) return { rows: [{ got: !opts.migrationBusy }] };
      // Re-review R1: the legacy logins still LOGIN until the admin's NOLOGIN statements ran.
      if (text === OWNER_HARDEN_R1_LEGACY_LOGINS) return { rows: legacyLeft.map((name) => ({ name })) };
      if (text.startsWith('ALTER ROLE crewflow') && text.includes('NOLOGIN PASSWORD NULL')) legacyLeft = legacyLeft.filter((n) => !text.includes(`ROLE ${n} `));
      if (text === OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK) return { rows: [{ released: true }] };
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
    // Independent review L3 of #259: both are required members; the default stubs are the normal answers.
    probeWrongPassword: async () => ({ ok: false, code: '28P01' }),
    sessionProbe: async () => undefined,
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  if ('schemaComplete' in opts) io.schemaComplete = async () => opts.schemaComplete as boolean;
  return { io, sent, lines, texts: () => sent.map((s) => s.text) };
}

describe('owner bootstrap: the admin session', () => {
  it('fresh: one write transaction; the verifier travels only as bind parameter $1', async () => {
    const { io, sent } = fakeIo([base, base, existing], [{ ok: true }]);
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toMatchObject({ outcome: 'created', exitCode: 0, created: true, passwordSet: true, grantAdded: true, createRole: 'not-run' });
    expect(sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)?.values).toEqual(['SCRAM-SHA-256$4096:c2FsdA==$stored:server', 'true']);
    for (const s of sent) expect(s.text).not.toContain('SCRAM-SHA-256$');
    expect(sent.map((s) => s.text)).toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('DENIAL createrole_self_grant: the admin never self-grants crewflow_owner (pinned empty, transaction-local, before CREATE ROLE)', async () => {
    const { io, texts, sent } = fakeIo([base, base, existing], [{ ok: true }]);
    await bootstrapOwnerWithIo(io);
    const t = texts();
    expect(t.indexOf(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT)).toBeGreaterThan(t.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
    expect(t.indexOf(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO));
    expect(t.filter((x) => x === OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT)).toHaveLength(1);
    expect(sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT)?.values).toBeUndefined();
    expect(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT).toBe("SELECT pg_catalog.set_config('createrole_self_grant', '', true);");
  });

  it('a password that does not log in on an EXISTING role: Q2b runs BEFORE the write (and again under the lock), then the password is SET ("updated", passwordSet log line)', async () => {
    const { io, sent, texts, lines } = fakeIo([existing, existing, existing], [{ ok: false, code: '28P01' }, { ok: false, code: '28P01' }, { ok: true }]);
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toMatchObject({ outcome: 'updated', exitCode: 0, created: false, passwordSet: true, grantAdded: false });
    const t = texts();
    expect(t.indexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(t.lastIndexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toBeGreaterThan(t.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
    expect(sent.find((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS)?.values?.[1]).toBe('true');
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.passwordSet);
  });

  it('DENIAL L4: setting the password while crewflow_owner is used by another database is refused (64) before any transaction', async () => {
    const { io, texts } = fakeIo([existing, existing], [{ ok: false, code: '28P01' }], { otherDatabase: true });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase);
    expect(OWNER_BOOTSTRAP_MESSAGES.ownerInOtherDatabase).toContain('one deployment per PostgreSQL cluster when using an admin URL');
    expect(texts()).toContain(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it("Q2b is sent only before setting an EXISTING role's password: never when the password logs in, never when the role is created", async () => {
    for (const [facts, probes] of [
      [[existing], [{ ok: true }]],
      [[base, base, existing], [{ ok: true }]],
    ] as Array<[OwnerFacts[], Probe[]]>) {
      const { io, texts } = fakeIo(facts, probes);
      await bootstrapOwnerWithIo(io);
      expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES);
    }
  });

  it('fail closed: a Q2b row that is not exactly one boolean is a failure (70), never a password change', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: false, code: '28P01' }], { otherDatabase: 'true' });
    await expect(bootstrapOwnerWithIo(io)).rejects.toBeInstanceOf(OwnerBootstrapFailure);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('grant only, then the post-commit probe is 28P01: the attempt re-runs and SETS the password (never a silent success, never a refusal)', async () => {
    const noGrant = { ...existing, oHasDbGrant: false };
    const { io, sent, lines } = fakeIo(
      [noGrant, noGrant, existing, existing, existing, existing],
      [{ ok: false, code: '42501' }, { ok: false, code: '42501' }, { ok: false, code: '28P01' }, { ok: false, code: '28P01' }, { ok: false, code: '28P01' }, { ok: true }],
    );
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toMatchObject({ outcome: 'updated', exitCode: 0, passwordSet: true, grantAdded: false });
    expect(sent.filter((s) => s.text === OWNER_BOOTSTRAP_Q4B_SET_INPUTS).map((s) => s.values)).toEqual([
      ['', 'false'],
      ['SCRAM-SHA-256$4096:c2FsdA==$stored:server', 'true'],
    ]);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.passwordRecheck);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.passwordSet);
  });

  it.each([140011, 190000])('server_version_num %d: refused before anything is created (no transaction, no write)', async (v) => {
    const { io, texts } = fakeIo([{ ...base, serverVersionNum: v }], [{ ok: true }]);
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.unsupportedPostgres(Math.floor(v / 10000)));
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts().filter((t) => /(CREATE|GRANT|ALTER|COMMENT)/i.test(t) && t !== OWNER_BOOTSTRAP_Q2_FACTS)).toEqual([]);
  });

  it('re-plans under the lock: when the other start already did everything, this one writes nothing and reports "unchanged"', async () => {
    const { io, texts } = fakeIo([base, existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toEqual({ outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: null });
    expect(texts()).toContain(OWNER_BOOTSTRAP_Q4A_LOCK);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('re-plans under the lock: a refusal decided under the lock keeps its own message and rolls back', async () => {
    const { io, texts } = fakeIo([base, { ...existing, oBypassRls: true }], [{ ok: true }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['BYPASSRLS']));
    expect(texts()).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('restart with everything in place: no transaction at all', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('a CREATE ROLE race is retried from the facts', async () => {
    const { io, texts, lines } = fakeIo([base, base, existing], [{ ok: true }], { failOn: OWNER_BOOTSTRAP_Q4C_DO, failCode: '42710', failTimes: 1 });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(texts()).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.raceRetry('statement', '42710'));
  });

  it('a failing DO block rolls back and refuses (42501) without the driver text', async () => {
    const { io, texts } = fakeIo([base], [{ ok: true }], { failOn: OWNER_BOOTSTRAP_Q4C_DO, failCode: '42501' });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501'));
    expect(texts()).toContain(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('fails closed when the post-commit probe does not log in after the password was set', async () => {
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

describe('owner bootstrap: the CREATEROLE decisions (owner decision 2026-11-18)', () => {
  it.each<[string, Partial<OwnerFacts>, boolean, string]>([
    ['no role', { ownerExists: false, oCreateRole: null }, true, 'none'],
    ['CREATEROLE, complete, unmarked', { oCreateRole: true }, true, 'remove'],
    ['CREATEROLE, complete, marked', { oCreateRole: true, oCreateRolePending: true }, true, 'remove'],
    ['CREATEROLE, incomplete, unmarked', { oCreateRole: true }, false, 'mark'],
    ['CREATEROLE, incomplete, marked', { oCreateRole: true, oCreateRolePending: true }, false, 'none'],
    // Owner decision M1: an EXPIRED mark while the schema is still incomplete is marked again (a first migrate that failed
    // for a day); complete + expired is still 'remove'.
    ['CREATEROLE, incomplete, marked but EXPIRED', { oCreateRole: true, oCreateRolePending: true, oCreateRoleMarkExpired: true }, false, 'mark'],
    ['CREATEROLE, complete, marked but EXPIRED', { oCreateRole: true, oCreateRolePending: true, oCreateRoleMarkExpired: true }, true, 'remove'],
    ['NOCREATEROLE, marked but EXPIRED', { oCreateRole: false, oCreateRolePending: true, oCreateRoleMarkExpired: true }, true, 'clear-mark'],
    ['NOCREATEROLE, marked (complete)', { oCreateRole: false, oCreateRolePending: true }, true, 'clear-mark'],
    ['NOCREATEROLE, marked (incomplete)', { oCreateRole: false, oCreateRolePending: true }, false, 'clear-mark'],
    ['NOCREATEROLE, unmarked', { oCreateRole: false }, true, 'none'],
    ['NOCREATEROLE, unmarked, incomplete (never granted back)', { oCreateRole: false }, false, 'none'],
  ])('decideCreateRole: %s', (_label, patch, complete, want) => {
    expect(decideCreateRole({ ...existing, ...patch }, complete)).toBe(want);
  });

  it('decideOwnerUrlCreateRole (mode c, read-only): refuses what the boot gate would refuse, notes the rest', () => {
    const f = (oCreateRole: boolean, oCreateRolePending: boolean, oCreateRoleMarkExpired = false) => ({ oCreateRole, oCreateRolePending, oCreateRoleMarkExpired });
    expect(decideOwnerUrlCreateRole(f(false, false), true)).toEqual([]);
    expect(decideOwnerUrlCreateRole(f(false, true), false)).toEqual([]);
    expect(decideOwnerUrlCreateRole(f(false, true, true), true)).toEqual([]);
    expect(refusalOf(() => decideOwnerUrlCreateRole(f(true, false), true))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleComplete);
    expect(refusalOf(() => decideOwnerUrlCreateRole(f(true, false), false))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRolePendingUnmarked);
    expect(decideOwnerUrlCreateRole(f(true, true), true)).toEqual([OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleCompleteMarked]);
    expect(decideOwnerUrlCreateRole(f(true, true), false)).toEqual([OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked]);
    // Owner decision M1, the 24 h grace period: an EXPIRED mark is refused (what the boot gate refuses once complete).
    expect(refusalOf(() => decideOwnerUrlCreateRole(f(true, true, true), true))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleExpired);
    expect(refusalOf(() => decideOwnerUrlCreateRole(f(true, true, true), false))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleExpiredBeforeStart);
    expect(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleExpired).toContain('ALTER ROLE crewflow_owner NOCREATEROLE; COMMENT ON ROLE crewflow_owner IS NULL;');
    expect(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRolePendingUnmarked).toContain('step 5b of own-database-app-login.sql');
  });

  it('isSchemaComplete: every migration of the image in the ledger (CURRENT or AHEAD); no ledger = incomplete; an empty image list fails closed (70)', () => {
    expect(() => isSchemaComplete([], ['A1'])).toThrow(OwnerBootstrapFailure);
    expect(() => isSchemaComplete([], ['A1'])).toThrow(OWNER_BOOTSTRAP_MESSAGES.migrationsUnlisted);
    expect(isSchemaComplete(['A1', 'B2'], null)).toBe(false);
    expect(isSchemaComplete(['A1', 'B2'], [])).toBe(false);
    expect(isSchemaComplete(['A1', 'B2'], ['A1'])).toBe(false);
    expect(isSchemaComplete(['A1', 'B2'], ['B2', 'A1'])).toBe(true);
    expect(isSchemaComplete(['A1', 'B2'], ['A1', 'B2', 'C3'])).toBe(true); // AHEAD after a rollback
  });

  it('imageMigrationNames: the REAL migrations directory; every name is exactly the class name and `name` its file declares (the ledger name)', () => {
    const dir = path.join(__dirname, '..', '..', 'core', 'migrations');
    const names = imageMigrationNames();
    expect(names).toEqual(imageMigrationNames(dir));
    const files = fs.readdirSync(dir).filter((f) => /^\d{13}-.*\.ts$/.test(f));
    expect(names.length).toBeGreaterThan(200);
    expect(names).toHaveLength(files.length);
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const cls = /export class ([A-Za-z0-9]+) implements MigrationInterface/.exec(text)?.[1];
      const declared = /\bname = '([A-Za-z0-9]+)'/.exec(text)?.[1];
      const [, ts, stem] = /^(\d{13})-([A-Za-z0-9]+)\.ts$/.exec(file) ?? [];
      const derived = `${stem}${ts}`;
      expect({ file, cls }).toEqual({ file, cls: derived });
      if (declared !== undefined) expect({ file, declared }).toEqual({ file, declared: derived });
      expect(names).toContain(derived);
    }
  });

  it('imageMigrationNames ignores what is not a migration file (.d.ts, maps, specs, other names)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-mig-'));
    try {
      for (const f of ['1786665600000-InitSchema.js', '1786665600000-InitSchema.d.ts', '1786665600000-InitSchema.js.map', 'x.spec.ts', 'README.md', '178666560000-Short.ts']) {
        fs.writeFileSync(path.join(tmp, f), '');
      }
      expect(imageMigrationNames(tmp)).toEqual(['InitSchema1786665600000']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('readLedgerNames: no ledger -> null (S2 never sent); rows -> names; a malformed S1 fact -> failure (70)', async () => {
    const make = (s1: unknown, s2: Array<{ name: string }> = []) => {
      const sent: string[] = [];
      const session: SqlSession = {
        async query(text) {
          sent.push(text);
          if (text === OWNER_SCHEMA_S1_HAS_LEDGER) return { rows: s1 === undefined ? [] : [{ has_ledger: s1 }] };
          if (text === OWNER_SCHEMA_S2_LEDGER) return { rows: s2 };
          throw new Error('unexpected');
        },
        async end() {
          /* closed */
        },
      };
      return { session, sent };
    };
    const none = make(false);
    expect(await readLedgerNames(none.session)).toBeNull();
    expect(none.sent).toEqual([OWNER_SCHEMA_S1_HAS_LEDGER]);
    expect(await readLedgerNames(make(true, [{ name: 'A1' }, { name: 'B2' }]).session)).toEqual(['A1', 'B2']);
    for (const bad of ['t', null, 1, undefined]) await expect(readLedgerNames(make(bad).session)).rejects.toBeInstanceOf(OwnerBootstrapFailure);
  });

  it('the S1 / S2 statements are read-only fixed text; S1 never names core.migrations as a relation (42P01 at planning time)', () => {
    expect(OWNER_SCHEMA_S1_HAS_LEDGER).toBe("SELECT pg_catalog.to_regclass('core.migrations') IS NOT NULL AS has_ledger;");
    expect(OWNER_SCHEMA_S2_LEDGER).toBe('SELECT name FROM core.migrations;');
  });
});

describe('owner bootstrap: the CREATEROLE step through bootstrapOwnerWithIo (schema state stubbed)', () => {
  /** Every H statement sent sits inside BEGIN ... COMMIT/ROLLBACK, after the advisory lock of that same transaction. */
  const assertInsideLockedTransaction = (t: string[]) => {
    t.forEach((text, i) => {
      if (!H_STATEMENTS.includes(text)) return;
      const begin = t.lastIndexOf(OWNER_BOOTSTRAP_BEGIN, i);
      expect(begin).toBeGreaterThanOrEqual(0);
      const lock = t.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK, begin);
      expect(lock).toBeGreaterThan(begin);
      expect(lock).toBeLessThan(i);
      expect(t.slice(begin, i).some((x) => x === OWNER_BOOTSTRAP_COMMIT || x === OWNER_BOOTSTRAP_ROLLBACK)).toBe(false);
      expect(t.slice(i).some((x) => x === OWNER_BOOTSTRAP_COMMIT || x === OWNER_BOOTSTRAP_ROLLBACK)).toBe(true);
    });
  };

  it('complete + CREATEROLE (unmarked): H1 only, "removed", one log line', async () => {
    const { io, texts, lines } = fakeIo([existing, existing, existing, hardened], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0, createRole: 'removed' });
    const t = texts();
    expect(t.filter((x) => x === OWNER_HARDEN_H1_NOCREATEROLE)).toHaveLength(1);
    expect(t).not.toContain(OWNER_HARDEN_H2_CLEAR_MARK);
    expect(t).not.toContain(OWNER_HARDEN_H3_MARK_PENDING);
    expect(lastTx(t)).toBe(OWNER_BOOTSTRAP_COMMIT);
    assertInsideLockedTransaction(t);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleRemoved);
  });

  it('complete + CREATEROLE marked: H1 then H2 (the mark goes with the attribute), "removed"', async () => {
    const { io, texts } = fakeIo([marked, marked, marked, hardened], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'removed' });
    const t = texts();
    expect(t.indexOf(OWNER_HARDEN_H2_CLEAR_MARK)).toBeGreaterThan(t.indexOf(OWNER_HARDEN_H1_NOCREATEROLE));
    assertInsideLockedTransaction(t);
  });

  it('incomplete + CREATEROLE unmarked: H3 (the exact mark), "marked", one log line', async () => {
    const { io, texts, lines } = fakeIo([existing, existing, existing, marked], [{ ok: true }], { schemaComplete: false });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'marked' });
    const t = texts();
    expect(t.filter((x) => x === OWNER_HARDEN_H3_MARK_PENDING)).toHaveLength(1);
    expect(t).not.toContain(OWNER_HARDEN_H1_NOCREATEROLE);
    assertInsideLockedTransaction(t);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleMarked);
  });

  it('a FRESH role (created this run) on an empty schema is marked in the same run', async () => {
    const { io, texts } = fakeIo([base, base, existing, existing, existing, marked], [{ ok: true }], { schemaComplete: false });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'created', createRole: 'marked' });
    expect(texts().indexOf(OWNER_HARDEN_H3_MARK_PENDING)).toBeGreaterThan(texts().indexOf(OWNER_BOOTSTRAP_Q4C_DO));
  });

  it('incomplete + marked: no transaction at all, "kept", one log line', async () => {
    const { io, texts, lines } = fakeIo([marked], [{ ok: true }], { schemaComplete: false });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'kept' });
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts().filter((x) => H_STATEMENTS.includes(x))).toEqual([]);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked);
  });

  it('NOCREATEROLE + a leftover mark: H2 only, "mark-cleared"', async () => {
    const leftover = { ...hardened, oCreateRolePending: true };
    const { io, texts, lines } = fakeIo([leftover, leftover, leftover, hardened], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'mark-cleared' });
    expect(texts().filter((x) => H_STATEMENTS.includes(x))).toEqual([OWNER_HARDEN_H2_CLEAR_MARK]);
    assertInsideLockedTransaction(texts());
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleMarkCleared);
  });

  it('NOCREATEROLE, no mark: nothing (never grants CREATEROLE back, even when the schema is incomplete)', async () => {
    for (const complete of [true, false]) {
      const { io, texts } = fakeIo([hardened], [{ ok: true }], { schemaComplete: complete });
      expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'none' });
      expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    }
  });

  it('re-decides under the lock: another db-setup already removed it -> rolled back, "none"', async () => {
    const { io, texts } = fakeIo([existing, existing, hardened], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'none' });
    expect(texts().filter((x) => H_STATEMENTS.includes(x))).toEqual([]);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it.each<[string, boolean]>([
    ['remove', true],
    ['mark', false],
  ])('DENIAL no rights (%s): not superuser and no ADMIN OPTION -> refusal 64, ROLLBACK, no H statement sent', async (_label, complete) => {
    const noAdmin = { ...existing, adminHasAdminOption: false };
    const { io, texts } = fakeIo([noAdmin], [{ ok: true }], { schemaComplete: complete });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.createRoleNoRights);
    expect(texts().filter((x) => H_STATEMENTS.includes(x))).toEqual([]);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it.each<[string, boolean]>([
    ['remove', true],
    ['mark', false],
  ])('DENIAL review L1 (%s): crewflow_owner is used by another database of the cluster -> refusal 64, ROLLBACK, no ALTER ROLE / COMMENT sent', async (_label, complete) => {
    const { io, texts } = fakeIo([existing], [{ ok: true }], { schemaComplete: complete, otherDatabase: true });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.createRoleOtherDatabase);
    const t = texts();
    expect(t.filter((x) => H_STATEMENTS.includes(x))).toEqual([]);
    // Q2b ran under the lock, inside the transaction, before any H statement could be sent.
    expect(t.indexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toBeGreaterThan(t.lastIndexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
    expect(lastTx(t)).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('no rights also without CREATEROLE (ADMIN OPTION alone is not enough); superuser alone is enough', async () => {
    const plain = { ...existing, adminCreateRole: false, adminSuper: false };
    const a = fakeIo([plain], [{ ok: true }], { schemaComplete: true });
    await expect(bootstrapOwnerWithIo(a.io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.createRoleNoRights);
    const su = { ...existing, adminCreateRole: false, adminSuper: true, adminHasAdminOption: false };
    const b = fakeIo([su, su, su, { ...su, oCreateRole: false }], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(b.io)).toMatchObject({ createRole: 'removed' });
  });

  it('fail closed: the facts after the statements do not show the result -> failure 70, rolled back', async () => {
    const { io, texts } = fakeIo([existing, existing, existing, existing], [{ ok: true }], { schemaComplete: true });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_COMMIT);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('fail closed: a mark that does not show after H3 -> failure 70', async () => {
    const { io } = fakeIo([existing, existing, existing, existing], [{ ok: true }], { schemaComplete: false });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
  });

  it('a race (XX000: another database of the cluster changed the role row) on H1 is retried from the facts, then succeeds', async () => {
    const { io, texts, lines } = fakeIo([existing, existing, existing, existing, existing, hardened], [{ ok: true }], {
      schemaComplete: true,
      failOn: OWNER_HARDEN_H1_NOCREATEROLE,
      failCode: 'XX000',
      failMessage: 'tuple concurrently updated',
      failTimes: 1,
    });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0, createRole: 'removed' });
    expect(texts().filter((x) => x === OWNER_HARDEN_H1_NOCREATEROLE)).toHaveLength(2);
    expect(texts()).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.raceRetry('statement', 'XX000'));
    assertInsideLockedTransaction(texts());
  });

  it('three races in a row: failure 70 (raceExhausted), nothing committed', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }], {
      schemaComplete: true,
      failOn: OWNER_HARDEN_H1_NOCREATEROLE,
      failCode: 'XX000',
      failMessage: 'tuple concurrently updated',
    });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.raceExhausted('statement', 'XX000'));
    expect(texts().filter((x) => x === OWNER_HARDEN_H1_NOCREATEROLE)).toHaveLength(3);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_COMMIT);
  });

  it('a non-race error on a CREATEROLE statement (42501) is a refusal, not a retry', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }], { schemaComplete: true, failOn: OWNER_HARDEN_H1_NOCREATEROLE, failCode: '42501' });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501'));
    expect(texts().filter((x) => x === OWNER_HARDEN_H1_NOCREATEROLE)).toHaveLength(1);
  });

  it('a schema-state read that fails is a failure (70) and nothing is changed', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }]);
    io.schemaComplete = async () => {
      throw new OwnerBootstrapFailure(OWNER_BOOTSTRAP_MESSAGES.migrationsUnlisted);
    };
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.migrationsUnlisted);
    expect(texts().filter((x) => H_STATEMENTS.includes(x))).toEqual([]);
  });
});

describe('owner bootstrap: the whole step without a database', () => {
  const run = async (env: Record<string, string | undefined>) => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(env, {
      log: (l) => lines.push(l),
      retryWindowMs: 0,
      expectedMigrations: () => {
        throw new Error('expectedMigrations must not be read before a connection');
      },
    });
    return { result, text: [...lines, resultLine(result)].join('\n') };
  };
  const assertClean = (text: string) => {
    for (const forbidden of [ADMIN_PW, OWNER_PW, 'db.internal.example', 'crewflow_unit', 'dbadmin', SECRET, 'SCRAM-SHA-256$', 'p\u00e9ssword']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s)]*@/i);
  };

  it('SQL audit of #259: the mode-c weak-password refusal (production) prints the safe password step, never a top-level ALTER ROLE ... PASSWORD', async () => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(
      { PG_DATABASE_URL: 'postgres://crewflow_owner:changeme@db.internal.example:5432/crewflow_unit', NODE_ENV: 'production' },
      { log: (l) => lines.push(l), retryWindowMs: 0 },
    );
    expect(result.exitCode).toBe(64);
    expect(lines).toEqual([
      DB_SETUP_INPUT_MESSAGES.weakPasswordProduction,
      OWNER_BOOTSTRAP_MESSAGES.resetPasswordStep,
      OWNER_SQL_BEGIN_MARKER,
      ...OWNER_RESET_PASSWORD_SQL.flatMap((st) => st.split('\n')),
      OWNER_SQL_END_MARKER,
      OWNER_BOOTSTRAP_MESSAGES.passwordVisibilityStep,
    ]);
    expect(DB_SETUP_INPUT_MESSAGES.weakPasswordProduction).toBe(
      'The crewflow_owner password inside PG_DATABASE_URL is too weak for production: it must be at least 32 characters with at least 10 different characters. As your admin, set a strong one (openssl rand -hex 32) with the SQL db-setup prints below (never a top-level ALTER ROLE ... PASSWORD, which a server log can quote) and put it in PG_DATABASE_URL, or set PG_ADMIN_URL so db-setup sets it. Refusing.',
    );
    expect(OWNER_RESET_PASSWORD_SQL[0]).toBe('ROLLBACK;');
    expect(OWNER_RESET_PASSWORD_SQL[1]).toBe('BEGIN;');
    expect(OWNER_RESET_PASSWORD_SQL[2]).toBe("SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true) IS NOT NULL AS value_set;");
    expect(OWNER_RESET_PASSWORD_SQL[3]).toBe(OWNER_SET_PASSWORD_SQL[3].replace(
      "    EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner LOGIN PASSWORD %L', v_pw);\n    COMMENT ON ROLE crewflow_owner IS NULL;",
      "    EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_pw);",
    ));
    expect(OWNER_RESET_PASSWORD_SQL[3]).not.toContain('<PG_DATABASE_APP_PASSWORD>');
    expect(OWNER_RESET_PASSWORD_SQL[4]).toBe('COMMIT;');
    expect(lines.filter((l) => /^\s*ALTER ROLE/.test(l))).toEqual([]);
  });

  it('DENIAL: every input refusal is exit 64 BEFORE any connection, createRole "not-run", no secret in the log or the result line', async () => {
    const other = `postgres://dbadmin:${ADMIN_PW}@db.internal.example:5432/another_db`;
    const cases: Array<[string, Record<string, string>, string]> = [
      ['no PG_DATABASE_URL', { PG_ADMIN_URL: ADMIN_URL }, DB_SETUP_INPUT_MESSAGES.appUrlMissing],
      ['nothing at all', {}, DB_SETUP_INPUT_MESSAGES.appUrlMissing],
      ['blank PG_DATABASE_URL', { PG_DATABASE_URL: '  ' }, DB_SETUP_INPUT_MESSAGES.appUrlMissing],
      ['PG_DATABASE_URL not crewflow_owner', { PG_DATABASE_URL: ADMIN_URL }, DB_SETUP_INPUT_MESSAGES.appUrlNotOwner],
      ['admin URL in both', { PG_DATABASE_URL: ADMIN_URL, PG_ADMIN_URL: ADMIN_URL }, DB_SETUP_INPUT_MESSAGES.appUrlNotOwner],
      ['PG_ADMIN_URL is crewflow_owner', { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: APP_URL }, DB_SETUP_INPUT_MESSAGES.adminUrlIsOwner],
      ['different databases', { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: other }, DB_SETUP_INPUT_MESSAGES.targetMismatch],
      [
        'different hosts',
        { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@db2.internal.example:5432/crewflow_unit` },
        DB_SETUP_INPUT_MESSAGES.targetMismatch,
      ],
      [
        'a pooler-shaped app URL',
        { PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit` },
        OWNER_CREDENTIAL_MESSAGES.transactionPooler,
      ],
      [
        // owner-credential.ts planDbSetup still refuses a documented pooler shape on this base (PR #258 removes that rule);
        // db-setup itself adds no address rule (owner decision 2026-11-19: by capability only).
        'a pooler-shaped admin URL',
        { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@ep-abc-pooler.eu-west-2.aws.neon.tech/crewflow_unit` },
        OWNER_CREDENTIAL_MESSAGES.transactionPooler.split('PG_DATABASE_URL').join('PG_ADMIN_URL'),
      ],
      ['PG_ADMIN_DIRECT_URL without PG_ADMIN_URL', { PG_DATABASE_URL: APP_URL, PG_ADMIN_DIRECT_URL: ADMIN_URL }, OWNER_BOOTSTRAP_MESSAGES.adminDirectWithoutAdmin],
      [
        'PG_ADMIN_DIRECT_URL with another login',
        { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: ADMIN_URL, PG_ADMIN_DIRECT_URL: `postgres://other:${ADMIN_PW}@db.internal.example:5432/crewflow_unit` },
        OWNER_BOOTSTRAP_MESSAGES.adminDirectMismatch,
      ],
      [
        'PG_ADMIN_DIRECT_URL with another database',
        { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: ADMIN_URL, PG_ADMIN_DIRECT_URL: `postgres://dbadmin:${ADMIN_PW}@db.internal.example:5432/another_db` },
        OWNER_BOOTSTRAP_MESSAGES.adminDirectMismatch,
      ],
      [
        'a non-ASCII crewflow_owner password with an admin (no SCRAM verifier)',
        { PG_DATABASE_URL: 'postgres://crewflow_owner:p%C3%A9ssword-0123456789-abcdefghij-KLMNOP@db.internal.example:5432/crewflow_unit', PG_ADMIN_URL: ADMIN_URL },
        OWNER_CREDENTIAL_MESSAGES.nonAsciiScramPassword,
      ],
      ['the retired admin name', { PG_DATABASE_URL: APP_URL, PG_DATABASE_ADMIN_URL: ADMIN_URL }, DB_SETUP_INPUT_MESSAGES.retiredAdminName('PG_DATABASE_ADMIN_URL')],
      // Security review of PR #246, M2: db-setup never creates or sets a weak schema-owner password (9 characters here).
      [
        'an admin URL and a 9-character crewflow_owner password',
        { PG_DATABASE_URL: 'postgres://crewflow_owner:Short9pw1@db.internal.example:5432/crewflow_unit', PG_ADMIN_URL: ADMIN_URL },
        DB_SETUP_INPUT_MESSAGES.weakPassword,
      ],
      [
        'mode c in production with a weak crewflow_owner password',
        { PG_DATABASE_URL: 'postgres://crewflow_owner:changeme@db.internal.example:5432/crewflow_unit', NODE_ENV: 'production' },
        DB_SETUP_INPUT_MESSAGES.weakPasswordProduction,
      ],
      ['only the legacy DATABASE_URL', { DATABASE_URL: APP_URL }, DB_SETUP_INPUT_MESSAGES.appUrlMissing],
      // Re-review (a) of #259: modes a and b create or set this password, so only A-Z a-z 0-9 _ - (decoded), refused before connecting.
      ...(["'", '$$', '%27', '%5C'] as const).map((bad): [string, Record<string, string>, string] => [
        `an admin URL and a crewflow_owner password holding ${bad}`,
        { PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}${bad}@db.internal.example:5432/crewflow_unit`, PG_ADMIN_URL: ADMIN_URL },
        OWNER_BOOTSTRAP_MESSAGES.appPasswordCharset,
      ]),
    ];
    for (const [label, env, message] of cases) {
      const { result, text } = await run(env);
      expect({ label, result }).toEqual({
        label,
        result: { outcome: 'refused', exitCode: 64, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: null },
      });
      expect({ label, has: text.includes(message) }).toEqual({ label, has: true });
      expect(text).not.toContain(OWNER_BOOTSTRAP_MESSAGES.passThrough);
      assertClean(text);
    }
  });

  it('refuses a URL the policy refuses (sslrootcert, ?host=, garbage) without echoing it', async () => {
    for (const env of [
      { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: `${ADMIN_URL}?sslrootcert=/etc/x.pem` },
      { PG_DATABASE_URL: APP_URL, PG_ADMIN_URL: `${ADMIN_URL}?host=elsewhere` },
      { PG_DATABASE_URL: `${APP_URL}?sslrootcert=/etc/x.pem` },
      { PG_DATABASE_URL: `not a url with crewflow_owner and ${OWNER_PW}` },
    ]) {
      const { result, text } = await run(env);
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
      assertClean(text);
    }
  });

  it('a URL-policy refusal names the variable the operator set (PG_ADMIN_URL)', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: `${APP_URL}?sslmode=verify-full`, PG_ADMIN_URL: `${ADMIN_URL}?sslmode=disable`, NODE_ENV: 'production' });
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 64 });
    expect(text).toContain('PG_ADMIN_URL');
    assertClean(text);
  });

  it('APP_SECRET plays no part: the same failure with or without it (db-setup does not receive it)', async () => {
    for (const extra of [{}, { APP_SECRET: SECRET }, { APP_SECRET: 'short' }]) {
      const { result, text } = await run({
        PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@127.0.0.1:1/crewflow_unit`,
        PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit`,
        ...extra,
      });
      expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED', createRole: 'not-run' });
      assertClean(text);
    }
  });

  it('mode c (PG_DATABASE_URL only): logs the read-only line, then an unreachable port is exit 70 with fixed text', async () => {
    const { result, text } = await run({ PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit` });
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    expect(text).toContain(OWNER_BOOTSTRAP_MESSAGES.passThrough);
    assertClean(text);
  });
});

describe('owner bootstrap: statements and the advisory key', () => {
  it('no statement can carry a value: only code constants are interpolated, inputs are $1/$2', () => {
    for (const text of [...OWNER_BOOTSTRAP_ADMIN_STATEMENTS, ...OWNER_HARDEN_ADMIN_STATEMENTS, ...OWNER_SELF_STATEMENTS, ...OWNER_BOOTSTRAP_NO_PASSWORD_STATEMENTS]) {
      expect(text).not.toMatch(/SCRAM-SHA-256\$|postgres(ql)?:\/\//);
    }
    // Owner decision 2026-11-19 (option 1): the no-password block carries no input and no PASSWORD at all.
    expect(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD).toContain('CREATE ROLE crewflow_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;');
    expect(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD).not.toMatch(/PASSWORD|current_setting\('crewflow_bootstrap/);
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.verifier', $1, true)");
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.need_password', $2, true)");
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L');
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain(
      "RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE, HINT = 'crewflow-stage=' || v_stage;",
    );
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION');
  });

  it('the CREATEROLE statements are exactly the reviewed text; db-setup never grants CREATEROLE to an existing role', () => {
    expect(OWNER_HARDEN_H1_NOCREATEROLE).toBe('ALTER ROLE crewflow_owner NOCREATEROLE;');
    expect(OWNER_HARDEN_H2_CLEAR_MARK).toBe('COMMENT ON ROLE crewflow_owner IS NULL;');
    // Owner decision M1: the mark carries a unix expiry, now + 24 h by the SERVER clock (COMMENT takes only a literal: a DO block).
    expect(OWNER_HARDEN_H3_MARK_PENDING).toBe(`DO $mark$
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON ROLE crewflow_owner IS %L',
    'crewflow:createrole-until-schema-current:' || (pg_catalog.date_part('epoch', pg_catalog.now())::bigint + 86400)::text);
END
$mark$;`);
    expect(OWNER_CREATEROLE_MARK_PREFIX).toBe('crewflow:createrole-until-schema-current:');
    expect(OWNER_CREATEROLE_GRACE_SECONDS).toBe(86400);
    for (const constant of [OWNER_CREATEROLE_MARK_PREFIX, OWNER_CREATEROLE_MARK_SQL_RE]) expect(constant).not.toMatch(/['\\]/);
    for (const text of [...OWNER_BOOTSTRAP_ADMIN_STATEMENTS, ...OWNER_HARDEN_ADMIN_STATEMENTS]) {
      expect(text).not.toMatch(/ALTER ROLE crewflow_owner (WITH )?CREATEROLE/);
    }
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain(
      `COALESCE(pg_catalog.shobj_description(o.oid, 'pg_authid') OPERATOR(pg_catalog.~) '${OWNER_CREATEROLE_MARK_SQL_RE}', false) AS o_createrole_pending`,
    );
    // The expiry is parsed only for a matching mark, and compared with the SERVER clock (never the client's).
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain(
      "pg_catalog.split_part(pg_catalog.shobj_description(o.oid, 'pg_authid'), ':', 3)::bigint <= pg_catalog.date_part('epoch', pg_catalog.now())::bigint",
    );
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain('AS o_createrole_mark_expired');
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
    expect(found).toContain(0x637265776d696772n); // "crewmigr", migration-lock.ts
    expect(found).toContain(7165901520760811569n); // "crewpa01", platform-admin.service.ts
    expect(found).not.toContain(key);
  });
});

describe('owner bootstrap: the read-only crewflow_owner session (mode c)', () => {
  const ownerFacts: OwnerFacts = { ...existing, adminSuper: false, adminCreateRole: true, adminHasAdminOption: false, oCreateRolePending: true };
  const me = { session_login: 'crewflow_owner', current_login: 'crewflow_owner' };
  type Who = { session_login: string; current_login: string };

  function ownerIo(o: { urlErrors?: string[]; facts?: OwnerFacts; who?: Who; ledger?: string[] | null; expected?: string[] | null } = {}) {
    const sent: string[] = [];
    const lines: string[] = [];
    const urlErrors = [...(o.urlErrors ?? [])];
    let clock = 0;
    const session: SqlSession = {
      async query(text) {
        sent.push(text);
        if (text === OWNER_BOOTSTRAP_Q0_SESSION) return { rows: [] };
        if (text === OWNER_SELF_O1_SESSION) return { rows: [o.who ?? me] };
        if (text === OWNER_BOOTSTRAP_Q2_FACTS) return { rows: [factsRow(o.facts ?? ownerFacts)] };
        if (text === OWNER_SCHEMA_S1_HAS_LEDGER) return { rows: [{ has_ledger: o.ledger !== null && o.ledger !== undefined }] };
        if (text === OWNER_SCHEMA_S2_LEDGER) return { rows: (o.ledger ?? []).map((name) => ({ name })) };
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
    if (o.expected !== null) io.expectedMigrations = () => o.expected ?? ['A1', 'B2'];
    return { io, sent, lines };
  }

  it('sends only read-only statements (Q0, O1, Q2, S1, S2) and reports pass-through, nothing written', async () => {
    const f = ownerIo({ ledger: ['A1'] });
    expect(await setupOwnerUrlWithIo(f.io, 0)).toEqual({ outcome: 'pass-through', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'none', code: null });
    expect(f.sent).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS, OWNER_SCHEMA_S1_HAS_LEDGER, OWNER_SCHEMA_S2_LEDGER]);
    for (const t of f.sent) expect(OWNER_SELF_STATEMENTS).toContain(t);
  });

  it('DENIAL: CREATEROLE unmarked on a COMPLETE schema is refused (64)', async () => {
    const f = ownerIo({ facts: { ...ownerFacts, oCreateRolePending: false }, ledger: ['A1', 'B2'] });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleComplete);
  });

  it('DENIAL: CREATEROLE unmarked on an INCOMPLETE schema (no ledger) is refused (64): the boot gate would refuse it after the bootstrap', async () => {
    const f = ownerIo({ facts: { ...ownerFacts, oCreateRolePending: false }, ledger: null });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRolePendingUnmarked);
    expect(f.sent).toEqual([OWNER_BOOTSTRAP_Q0_SESSION, OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS, OWNER_SCHEMA_S1_HAS_LEDGER]);
  });

  it('a marked CREATEROLE passes with a note: kept while incomplete, "remove it by hand" once complete', async () => {
    const incomplete = ownerIo({ ledger: ['A1'] });
    await setupOwnerUrlWithIo(incomplete.io, 0);
    expect(incomplete.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.createRoleKeptMarked]);
    const complete = ownerIo({ ledger: ['A1', 'B2', 'C3'] });
    await setupOwnerUrlWithIo(complete.io, 0);
    expect(complete.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.ownerUrlCreateRoleCompleteMarked]);
  });

  it('the NOCREATEROLE (hardened) owner is accepted with the D2 note only', async () => {
    const f = ownerIo({ facts: { ...ownerFacts, oCreateRole: false, oCreateRolePending: false }, ledger: ['A1', 'B2'] });
    await setupOwnerUrlWithIo(f.io, 0);
    expect(f.lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.noCreateRoleHardened]);
  });

  it('an empty image migration list fails closed (70), never a silent pass', async () => {
    const f = ownerIo({ ledger: ['A1'], expected: [] });
    await expect(setupOwnerUrlWithIo(f.io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.migrationsUnlisted);
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

  it('DENIAL: a wrong password (28P01) is the ownerUrlAuth refusal (64: no admin, the password is never changed); 3D000 the missing-database refusal', async () => {
    await expect(setupOwnerUrlWithIo(ownerIo({ urlErrors: ['28P01'] }).io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.ownerUrlAuth('28P01'));
    await expect(setupOwnerUrlWithIo(ownerIo({ urlErrors: ['3D000'] }).io, 0)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.adminNoDatabase);
  });

  it('retries connection-refused within the window', async () => {
    expect((await setupOwnerUrlWithIo(ownerIo({ urlErrors: ['ECONNREFUSED', '57P03'], ledger: ['A1'] }).io, 10_000)).outcome).toBe('pass-through');
  });
});

describe('owner bootstrap: security review H1 / L2 / M2 / I1 / I2', () => {
  it('H1/L2/I1: every driver config is pinned (LAST); only the crewflow_owner reading session is read-only; ownerUrl and probe log in with PG_DATABASE_URL', () => {
    for (const connectUrl of [ADMIN_URL, APP_URL]) {
      const configs = bootstrapDriverConfigs(resolvePgEnvironment({ PG_DATABASE_URL: connectUrl, NODE_ENV: 'test' }, { processRole: 'migrate' }), APP_URL);
      expect(Object.keys(configs).sort()).toEqual(['admin', 'ownerUrl', 'probe']);
      for (const [name, config] of Object.entries(configs)) {
        const options = String(config.options ?? '');
        expect({ name, pinned: options.includes('-c search_path=pg_catalog,pg_temp') }).toEqual({ name, pinned: true });
        const want = name === 'ownerUrl' ? OWNER_URL_SESSION_STARTUP_OPTIONS : BOOTSTRAP_SESSION_STARTUP_OPTIONS;
        expect({ name, ro: options.includes('-c default_transaction_read_only=on') }).toEqual({ name, ro: name === 'ownerUrl' });
        expect({ name, rw: options.includes('-c default_transaction_read_only=off') }).toEqual({ name, rw: name !== 'ownerUrl' });
        expect({ name, last: options.endsWith(want) }).toEqual({ name, last: true });
      }
      expect(configs.admin.user).toBe(connectUrl === ADMIN_URL ? 'dbadmin' : 'crewflow_owner');
      expect(configs.ownerUrl.user).toBe('crewflow_owner');
      expect(configs.probe.user).toBe('crewflow_owner');
      expect(configs.ownerUrl.password).toBe(OWNER_PW);
      expect(configs.ownerUrl.application_name).toBe(OWNER_BOOTSTRAP_APPLICATION_NAME);
      expect(configs.probe.application_name).toBe(OWNER_PROBE_APPLICATION_NAME);
      const strip = (c: Record<string, unknown>) => {
        const { options: _o, application_name: _a, ...rest } = c;
        return rest;
      };
      expect(strip(configs.ownerUrl as Record<string, unknown>)).toEqual(strip(configs.probe as Record<string, unknown>));
    }
  });

  it('H1: Q0 pins search_path before anything else; Q2 reads the database owner and the search_path defaults', () => {
    expect(OWNER_BOOTSTRAP_Q0_SESSION.startsWith('SET search_path TO pg_catalog, pg_temp;')).toBe(true);
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain("pg_catalog.pg_has_role(o.oid, d.datdba, 'MEMBER')");
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain('FROM pg_catalog.pg_db_role_setting s');
  });

  it('H1: the admin path refuses (64) a database crewflow_owner owns, and a database-wide / crewflow_owner search_path default', () => {
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oOwnsDb: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.ownerOwnsDatabase);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, searchPathDefaultSet: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.searchPathDefault);
    expect(decideBeforeProbe(existing)).toEqual([]);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oSuper: true, oOwnsDb: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['SUPERUSER']));
  });

  it('a missing right is reported as such (owner decision 2026-11-19: a refused verifier leads to option 1, never a plain-text password)', () => {
    const message = OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501');
    expect(message).toContain('lacks a needed right');
    expect(message).not.toMatch(/pre-hashed|by hand|ALTER ROLE|01-crewflow-owner|derive command/);
  });

  it('I1 / N3: the Q4c shape check accepts a real verifier and rejects malformed values (the 22023 branch)', () => {
    const match = /OPERATOR\(pg_catalog\.~\) '(\^SCRAM[^']+)'/.exec(OWNER_BOOTSTRAP_Q4C_DO);
    expect(match).not.toBeNull();
    const pattern = new RegExp(match![1]!);
    expect(pattern.test(scramSha256Verifier('a'.repeat(64)))).toBe(true);
    const key = 'A'.repeat(43) + '=';
    for (const bad of [
      '', 'a'.repeat(64), 'SCRAM-SHA-256$4096:c2FsdA==', 'SCRAM-SHA-256$x:c2FsdA==$a:b', 'SCRAM-SHA-256$4096:c2FsdA==$a:b;DROP', 'md5abc',
      'SCRAM-SHA-256$4096:c2FsdA==$a:b\n',
      `SCRAM-SHA-256$0:c2FsdA==$${key}:${key}`, `SCRAM-SHA-256$04096:c2FsdA==$${key}:${key}`,
      `SCRAM-SHA-256$4096:c2FsdA==$${'A'.repeat(42)}=:${key}`, `SCRAM-SHA-256$4096:c2FsdA==$${key}:${'A'.repeat(10)}=`,
      `SCRAM-SHA-256$4096:c2=FsdA==$${key}:${key}`, `SCRAM-SHA-256$12345678901:c2FsdA==$${key}:${key}`,
    ]) {
      expect({ bad, ok: pattern.test(bad) }).toEqual({ bad, ok: false });
    }
    expect(pattern.test(`SCRAM-SHA-256$4096:c2FsdA==$${key}:${key}`)).toBe(true);
    expect(OWNER_BOOTSTRAP_Q4C_DO.indexOf('not a pre-hashed verifier')).toBeLessThan(OWNER_BOOTSTRAP_Q4C_DO.indexOf('CREATE ROLE crewflow_owner'));
  });

  it('the owner-URL statements are read-only: no O4c, no write of any kind', () => {
    const sql = fs.readFileSync(path.join(__dirname, 'owner-bootstrap-sql.ts'), 'utf8');
    expect(sql).not.toMatch(/export const OWNER_SELF_O4C_DO/);
    for (const text of OWNER_SELF_STATEMENTS) {
      for (const statement of text.split(';')) expect(statement).not.toMatch(/^\s*(ALTER|CREATE|GRANT|REVOKE|INSERT|UPDATE|DELETE|DO|DROP|COMMENT)/i);
    }
  });
});

describe('owner bootstrap: security re-review N2 / N4', () => {
  it('N2: o_owns_db uses MEMBER (an INHERIT FALSE, SET TRUE membership of the owner counts)', () => {
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain("pg_catalog.pg_has_role(o.oid, d.datdba, 'MEMBER')");
    expect(OWNER_BOOTSTRAP_Q2_FACTS).not.toContain("d.datdba, 'USAGE'");
  });

  it('N4: a facts column that is not a boolean (or a count) is a failure (70), never silently false', () => {
    const row = factsRow(existing);
    expect(factsFromRow(row).oOwnsDb).toBe(false);
    expect(factsFromRow({ ...row, o_createrole_pending: true }).oCreateRolePending).toBe(true);
    for (const [column, value] of [
      ['o_owns_db', 't'],
      ['search_path_default_set', undefined],
      ['admin_super', 1],
      ['o_super', 'false'],
      ['o_privileged_memberships', 'x'],
      ['server_version_num', 'abc'],
      ['o_createrole_pending', null],
      ['o_createrole_pending', undefined],
      ['o_createrole_pending', 'true'],
      ['o_createrole_mark_expired', null],
      ['o_createrole_mark_expired', 'false'],
    ] as const) {
      expect(() => factsFromRow({ ...row, [column]: value })).toThrow(OwnerBootstrapFailure);
    }
    expect(factsFromRow({ ...row, owner_exists: false, o_login: null, o_super: null, o_privileged_memberships: null }).oSuper).toBeNull();
    expect(() => factsFromRow({ ...row, o_owns_db: null })).toThrow(OwnerBootstrapFailure);
  });
});

/**
 * db-harden (owner decision M1): a fake admin session per round. `rounds` is the facts each round reads (the last one
 * repeats); inside the CREATEROLE step's transaction the facts come from `stepFacts` (under the lock, then the re-check).
 */
function hardenFake(opts: {
  rounds: OwnerFacts[];
  stepFacts?: OwnerFacts[];
  complete?: Array<boolean | null>;
  openErrors?: string[];
  otherDatabase?: boolean;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  /** Answers of the migration try-lock, one per removal attempt (true = a migrate child holds it). */
  migrationBusy?: boolean[];
}) {
  const migrationBusy = [...(opts.migrationBusy ?? [false])];
  const sent: string[] = [];
  const lines: string[] = [];
  let clock = 0;
  let opens = 0;
  let completeAsked = 0;
  const rounds = [...opts.rounds];
  const stepFacts = [...(opts.stepFacts ?? [])];
  const completes = [...(opts.complete ?? [true])];
  const openErrors = [...(opts.openErrors ?? [])];
  let inStep = false;
  const nextFacts = (): OwnerFacts => {
    if (inStep && stepFacts.length) return stepFacts.length > 1 ? stepFacts.shift()! : stepFacts[0]!;
    return rounds.length > 1 ? rounds.shift()! : rounds[0]!;
  };
  const session: SqlSession = {
    async query(text) {
      sent.push(text);
      if (text === OWNER_BOOTSTRAP_BEGIN) inStep = true;
      if (text === OWNER_BOOTSTRAP_COMMIT || text === OWNER_BOOTSTRAP_ROLLBACK) inStep = false;
      if (text === OWNER_BOOTSTRAP_Q2_FACTS) return { rows: [factsRow(nextFacts())] };
      if (text === OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES) return { rows: [{ o_other_database: opts.otherDatabase ?? false }] };
      if (text === OWNER_HARDEN_M1_TRY_MIGRATION_LOCK) {
        const busy = migrationBusy.length > 1 ? migrationBusy.shift()! : (migrationBusy[0] ?? false);
        return { rows: [{ got: !busy }] };
      }
      if (text === OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK) return { rows: [{ released: true }] };
      return { rows: [] };
    },
    async end() {
      /* closed */
    },
  };
  const io: HardenIo = {
    async openAdmin() {
      opens += 1;
      const code = openErrors.shift();
      if (code) throw Object.assign(new Error('connect failed'), { code });
      return session;
    },
    async schemaComplete() {
      completeAsked += 1;
      return completes.length > 1 ? completes.shift()! : completes[0]!;
    },
    log: (l) => lines.push(l),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutSeconds: opts.timeoutSeconds ?? 60,
    pollIntervalMs: opts.pollIntervalMs ?? 10_000,
  };
  return { io, sent, lines, opens: () => opens, completeAsked: () => completeAsked, clock: () => clock };
}

describe('db-harden (owner decision M1): hardenOwnerWithIo', () => {
  const markedFacts: OwnerFacts = { ...existing, oCreateRolePending: true };
  const removedFacts: OwnerFacts = { ...existing, oCreateRole: false, oCreateRolePending: false };
  const H = [OWNER_HARDEN_H1_NOCREATEROLE, OWNER_HARDEN_H2_CLEAR_MARK, OWNER_HARDEN_H3_MARK_PENDING];

  it('happy path: polls (not readable, then incomplete, then complete), then H1 + H2 under the lock, "removed", exit 0; each waiting line once', async () => {
    const f = hardenFake({ rounds: [markedFacts], stepFacts: [markedFacts, removedFacts], complete: [null, false, false, true] });
    const result = await hardenOwnerWithIo(f.io);
    expect(result).toMatchObject({ outcome: 'unchanged', exitCode: 0, createRole: 'removed', created: false, passwordSet: false, grantAdded: false });
    expect(f.completeAsked()).toBe(4);
    const lock = f.sent.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK);
    expect(lock).toBeGreaterThan(f.sent.indexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(f.sent.indexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES)).toBeGreaterThan(lock);
    expect(f.sent.indexOf(OWNER_HARDEN_H1_NOCREATEROLE)).toBeGreaterThan(f.sent.indexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES));
    expect(f.sent.indexOf(OWNER_HARDEN_H2_CLEAR_MARK)).toBeGreaterThan(f.sent.indexOf(OWNER_HARDEN_H1_NOCREATEROLE));
    expect(lastTx(f.sent)).toBe(OWNER_BOOTSTRAP_COMMIT);
    expect(f.sent).not.toContain(OWNER_HARDEN_H3_MARK_PENDING);
    // db-harden never creates a role, never sets a password, never touches a grant.
    for (const never of [OWNER_BOOTSTRAP_Q4B_SET_INPUTS, OWNER_BOOTSTRAP_Q4C_DO, OWNER_BOOTSTRAP_Q4D_REVERIFY]) expect(f.sent).not.toContain(never);
    expect(f.lines.filter((l) => l === OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForSchema)).toHaveLength(1);
    expect(f.lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleRemoved);
  });

  it('crewflow_owner missing at first (db-setup not run yet): waits, then hardens once it appears', async () => {
    const f = hardenFake({ rounds: [base, base, markedFacts], stepFacts: [markedFacts, removedFacts], complete: [true] });
    expect(await hardenOwnerWithIo(f.io)).toMatchObject({ exitCode: 0, createRole: 'removed' });
    expect(f.lines.filter((l) => l === OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForRole)).toHaveLength(1);
    expect(f.opens()).toBe(3);
  });

  it('already hardened (NOCREATEROLE, unmarked): no transaction, no schema read, "none", exit 0 at once', async () => {
    const f = hardenFake({ rounds: [removedFacts] });
    expect(await hardenOwnerWithIo(f.io)).toMatchObject({ exitCode: 0, createRole: 'none' });
    expect(f.sent).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(f.completeAsked()).toBe(0);
    expect(f.lines).toContain(OWNER_BOOTSTRAP_MESSAGES.hardenAlready);
    expect(f.clock()).toBe(0);
  });

  it('a leftover mark only (NOCREATEROLE, marked): H2 alone, "mark-cleared"', async () => {
    const leftover = { ...removedFacts, oCreateRolePending: true };
    const f = hardenFake({ rounds: [leftover], stepFacts: [leftover, removedFacts], complete: [true] });
    expect(await hardenOwnerWithIo(f.io)).toMatchObject({ exitCode: 0, createRole: 'mark-cleared' });
    expect(f.sent.filter((t) => H.includes(t))).toEqual([OWNER_HARDEN_H2_CLEAR_MARK]);
  });

  it('timeout: the schema never completes -> failure (code TIMEOUT, the hardenTimeout message), no H statement ever sent, CREATEROLE untouched', async () => {
    const f = hardenFake({ rounds: [markedFacts], complete: [false], timeoutSeconds: 60, pollIntervalMs: 10_000 });
    const error = await hardenOwnerWithIo(f.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect((error as OwnerBootstrapFailure).code).toBe('TIMEOUT');
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.hardenTimeout(60));
    expect(f.sent.filter((t) => H.includes(t))).toEqual([]);
    expect(f.sent).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    // Bounded: it polled at the interval until the deadline (60 s / 10 s), never beyond it.
    expect(f.clock()).toBeLessThanOrEqual(60_000);
    expect(f.completeAsked()).toBeGreaterThanOrEqual(5);
  });

  it('DENIAL review L1: crewflow_owner used by another database of the cluster -> createRoleOtherDatabase, ROLLBACK, no H statement', async () => {
    const f = hardenFake({ rounds: [markedFacts], stepFacts: [markedFacts], complete: [true], otherDatabase: true });
    const error = await hardenOwnerWithIo(f.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.createRoleOtherDatabase);
    expect(f.sent.filter((t) => H.includes(t))).toEqual([]);
    expect(lastTx(f.sent)).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('an admin login refusal (28P01) is a refusal at once: no polling', async () => {
    const f = hardenFake({ rounds: [markedFacts], openErrors: ['28P01'] });
    const error = await hardenOwnerWithIo(f.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminAuth('28P01'));
    expect(f.opens()).toBe(1);
    expect(f.clock()).toBe(0);
  });

  it('a not-ready connect error (ECONNREFUSED: the db starting) is polled, then it hardens', async () => {
    const f = hardenFake({ rounds: [markedFacts], stepFacts: [markedFacts, removedFacts], openErrors: ['ECONNREFUSED', 'ECONNREFUSED'], complete: [true] });
    expect(await hardenOwnerWithIo(f.io)).toMatchObject({ exitCode: 0, createRole: 'removed' });
    expect(f.opens()).toBe(3);
    expect(f.clock()).toBe(20_000);
  });

  it('hardenTimeoutSeconds: unset / blank = 1200; whole seconds 60-7200; 1-59 only with NODE_ENV=test; anything else refused', () => {
    expect(HARDEN_DEFAULT_TIMEOUT_SECONDS).toBe(1200);
    expect(hardenTimeoutSeconds({})).toBe(1200);
    expect(hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: ' ' })).toBe(1200);
    expect(hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '60' })).toBe(60);
    expect(hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '7200' })).toBe(7200);
    expect(hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '1', NODE_ENV: 'test' })).toBe(1);
    for (const bad of ['59', '7201', '20m', '1'.repeat(20), '-5', '1.5', '0']) {
      expect(refusalOf(() => hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: bad }))).toBe(OWNER_BOOTSTRAP_MESSAGES.hardenTimeoutSetting);
    }
    expect(refusalOf(() => hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '1', NODE_ENV: 'production' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.hardenTimeoutSetting);
    expect(refusalOf(() => hardenTimeoutSeconds({ CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '0', NODE_ENV: 'test' }))).toBe(OWNER_BOOTSTRAP_MESSAGES.hardenTimeoutSetting);
  });

  it('runOwnerHarden, mode c (PG_DATABASE_URL only, no admin): exit 0, createRole "not-run", the no-admin line, and no connection at all', async () => {
    const lines: string[] = [];
    const result = await runOwnerHarden(
      { PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit` },
      {
        log: (l) => lines.push(l),
        expectedMigrations: () => {
          throw new Error('mode c must not read the migration list');
        },
      },
    );
    expect(result).toEqual({ outcome: 'unchanged', exitCode: 0, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: null });
    expect(lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.hardenNoAdmin]);
  });

  it('runOwnerHarden refuses a bad timeout and a weak password before anything connects (exit 64, fixed text only)', async () => {
    const lines: string[] = [];
    const bad = await runOwnerHarden({ PG_ADMIN_URL: ADMIN_URL, PG_DATABASE_URL: APP_URL, CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS: '20m' }, { log: (l) => lines.push(l) });
    expect(bad).toMatchObject({ outcome: 'refused', exitCode: 64, createRole: 'not-run' });
    const weak = await runOwnerHarden(
      { PG_ADMIN_URL: ADMIN_URL, PG_DATABASE_URL: 'postgres://crewflow_owner:Short9pw1@db.internal.example:5432/crewflow_unit' },
      { log: (l) => lines.push(l) },
    );
    expect(weak).toMatchObject({ outcome: 'refused', exitCode: 64 });
    expect(lines).toEqual([OWNER_BOOTSTRAP_MESSAGES.hardenTimeoutSetting, DB_SETUP_INPUT_MESSAGES.weakPassword]);
    for (const l of lines) for (const leak of [ADMIN_PW, OWNER_PW, 'Short9pw1', 'db.internal.example']) expect(l).not.toContain(leak);
  });
});

describe('the CREATEROLE mark re-check after H3 requires a valid, UNEXPIRED mark (owner decision M1)', () => {
  it('a mark that shows as expired right after H3 -> failure 70, rolled back', async () => {
    const expiredMark = { ...existing, oCreateRolePending: true, oCreateRoleMarkExpired: true };
    const { io, texts } = fakeIo([existing, existing, existing, expiredMark], [{ ok: true }], { schemaComplete: false });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
    expect(texts()).toContain(OWNER_HARDEN_H3_MARK_PENDING);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('an expired mark on an incomplete schema is marked again (H3), "marked"', async () => {
    const expiredMark = { ...existing, oCreateRolePending: true, oCreateRoleMarkExpired: true };
    const fresh = { ...existing, oCreateRolePending: true };
    const { io, texts } = fakeIo([expiredMark, expiredMark, expiredMark, fresh], [{ ok: true }], { schemaComplete: false });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'marked' });
    expect(texts().filter((t) => t === OWNER_HARDEN_H3_MARK_PENDING)).toHaveLength(1);
  });
});

describe('the CREATEROLE removal waits for a running migration (review race: disableLegacyLogins needs CREATEROLE)', () => {
  const markedFacts: OwnerFacts = { ...existing, oCreateRolePending: true };
  const removedFacts: OwnerFacts = { ...existing, oCreateRole: false, oCreateRolePending: false };

  it('the try-lock key is the migration lock key ("crewmigr", migration-lock.ts MIGRATION_LOCK_KEY)', () => {
    expect(BigInt(MIGRATION_LOCK_KEY_DECIMAL)).toBe(MIGRATION_LOCK_KEY);
    expect(OWNER_HARDEN_M1_TRY_MIGRATION_LOCK).toBe(`SELECT pg_catalog.pg_try_advisory_lock(${MIGRATION_LOCK_KEY_DECIMAL}) AS got;`);
  });

  it('db-harden: the migration lock is held -> no transaction, waits, then removes once it is free; the lock is released after the removal', async () => {
    const f = hardenFake({ rounds: [markedFacts], stepFacts: [markedFacts, removedFacts], complete: [true], migrationBusy: [true, true, false] });
    const result = await hardenOwnerWithIo(f.io);
    expect(result).toMatchObject({ exitCode: 0, createRole: 'removed' });
    expect(f.lines.filter((l) => l === OWNER_BOOTSTRAP_MESSAGES.hardenWaitingForMigration)).toHaveLength(1);
    const tries = f.sent.filter((t) => t === OWNER_HARDEN_M1_TRY_MIGRATION_LOCK).length;
    expect(tries).toBe(3);
    // No H statement before the try-lock that succeeded; the release comes after COMMIT.
    const lastTry = f.sent.lastIndexOf(OWNER_HARDEN_M1_TRY_MIGRATION_LOCK);
    expect(f.sent.indexOf(OWNER_HARDEN_H1_NOCREATEROLE)).toBeGreaterThan(lastTry);
    expect(f.sent.lastIndexOf(OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK)).toBeGreaterThan(f.sent.lastIndexOf(OWNER_BOOTSTRAP_COMMIT));
    expect(f.sent.filter((t) => t === OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK)).toHaveLength(1);
  });

  it('db-harden: a migration that never finishes -> the timeout, no H statement ever sent', async () => {
    const f = hardenFake({ rounds: [markedFacts], complete: [true], migrationBusy: [true], timeoutSeconds: 60, pollIntervalMs: 10_000 });
    const error = await hardenOwnerWithIo(f.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapFailure);
    expect(f.sent).not.toContain(OWNER_HARDEN_H1_NOCREATEROLE);
    expect(f.sent).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('db-setup: the migration lock is held -> CREATEROLE kept this time ("kept", one log line), no transaction, no release', async () => {
    const { io, texts, lines } = fakeIo([existing], [{ ok: true }], { schemaComplete: true, migrationBusy: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0, createRole: 'kept' });
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.createRoleBusyKept);
    expect(texts()).not.toContain(OWNER_HARDEN_H1_NOCREATEROLE);
    expect(texts()).not.toContain(OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK);
  });

  it('marking (an incomplete schema) never takes the migration lock: the first start marks while the migrate child may run later', async () => {
    const { io, texts } = fakeIo([existing, existing, existing, { ...existing, oCreateRolePending: true }], [{ ok: true }], { schemaComplete: false, migrationBusy: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ createRole: 'marked' });
    expect(texts()).not.toContain(OWNER_HARDEN_M1_TRY_MIGRATION_LOCK);
  });
});

describe('re-review R1: the CREATEROLE removal never leaves a legacy login LOGIN (BC-17)', () => {
  const hardened: OwnerFacts = { ...existing, oCreateRole: false, oCreateRolePending: false };
  const APP_NOLOGIN = 'ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL';
  const CF_NOLOGIN = 'ALTER ROLE crewflow NOLOGIN PASSWORD NULL';

  it('ledger complete + crewflow_app still LOGIN -> the admin makes it NOLOGIN in the same transaction, BEFORE NOCREATEROLE', async () => {
    const { io, texts, lines } = fakeIo([existing, existing, existing, hardened], [{ ok: true }], { schemaComplete: true, legacyLogin: ['crewflow_app'] });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0, createRole: 'removed' });
    const t = texts();
    const begin = t.lastIndexOf(OWNER_BOOTSTRAP_BEGIN);
    expect(t.indexOf(APP_NOLOGIN)).toBeGreaterThan(begin);
    expect(t.indexOf(OWNER_HARDEN_H1_NOCREATEROLE)).toBeGreaterThan(t.indexOf(APP_NOLOGIN));
    expect(t).not.toContain(CF_NOLOGIN);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.legacyLoginsDisabled(1));
  });

  it('DENIAL: the admin cannot make it NOLOGIN (42501) -> refusal 64, ROLLBACK, NO NOCREATEROLE', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }], { schemaComplete: true, legacyLogin: ['crewflow', 'crewflow_app'], failOn: CF_NOLOGIN, failCode: '42501' });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.legacyLoginsNoRights);
    expect(texts()).not.toContain(OWNER_HARDEN_H1_NOCREATEROLE);
    expect(lastTx(texts())).toBe(OWNER_BOOTSTRAP_ROLLBACK);
  });

  it('no legacy login LOGIN -> no ALTER ROLE on them; marking (incomplete schema) never touches them', async () => {
    const a = fakeIo([existing, existing, existing, hardened], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(a.io)).toMatchObject({ createRole: 'removed' });
    expect(a.texts().filter((x) => x.includes('NOLOGIN'))).toEqual([]);
    const b = fakeIo([existing, existing, existing, { ...existing, oCreateRolePending: true }], [{ ok: true }], { schemaComplete: false, legacyLogin: ['crewflow_app'] });
    expect(await bootstrapOwnerWithIo(b.io)).toMatchObject({ createRole: 'marked' });
    expect(b.texts()).not.toContain(OWNER_HARDEN_R1_LEGACY_LOGINS);
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Owner decision 2026-11-19: provider-neutral. The password form and a pooler are decided by capability at run time.
// ---------------------------------------------------------------------------------------------------------------------

describe('owner decision 2026-11-19: no provider-specific code', () => {
  it('neither owner-bootstrap.ts nor owner-bootstrap-sql.ts names a provider or matches a provider host', () => {
    for (const file of ['owner-bootstrap.ts', 'owner-bootstrap-sql.ts']) {
      const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect({ file, hit: /neon|supabase|digitalocean|\baws\b|azure|heroku|render\.com|PG_PROVIDER|[a-z0-9]-pooler\./i.exec(text)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});

describe('the password form: which refusals mean "the server refused the verifier"', () => {
  const dbErr = (code: string, opts: { message?: string; hint?: string } = {}) =>
    Object.assign(new Error(opts.message ?? 'secret-bearing driver text'), { code, ...(opts.hint ? { hint: opts.hint } : {}) });
  const role = { hint: 'crewflow-stage=role' };

  it('the refusal set is exactly 22023, 28P01, 0A000, XX000 (never 42501), and XX000 is no longer a race SQLSTATE', () => {
    expect([...PASSWORD_FORM_REFUSAL_SQLSTATES].sort()).toEqual(['0A000', '22023', '28P01', 'XX000']);
    expect([...RACE_SQLSTATES].sort()).toEqual(['23505', '40001', '40P01', '42710']);
  });

  it('the DO-block stage hint is read only in its exact fixed form', () => {
    expect(doBlockStage(dbErr('XX000', role))).toBe('role');
    expect(doBlockStage(dbErr('XX000', { hint: 'crewflow-stage=check' }))).toBe('check');
    expect(doBlockStage(dbErr('XX000', { hint: 'crewflow-stage=role; DROP' }))).toBeNull();
    expect(doBlockStage(dbErr('XX000'))).toBeNull();
  });

  it.each([
    ['XX000 at COMMIT (a server that checks the password when the transaction commits)', new WriteCommitError(dbErr('XX000')), true],
    ['0A000 at COMMIT', new WriteCommitError(dbErr('0A000')), true],
    ['22023 from the role step', dbErr('22023', role), true],
    ['28P01 from the role step (a password hook)', dbErr('28P01', role), true],
    ['XX000 from the role step', dbErr('XX000', role), true],
    ['22023 from the DO block\'s own shape check (a bug, never a fallback)', dbErr('22023', { hint: 'crewflow-stage=check' }), false],
    ['XX000 from the grant step', dbErr('XX000', { hint: 'crewflow-stage=grant' }), false],
    ['42501 from the role step (a missing right)', dbErr('42501', role), false],
    ['42501 at COMMIT', new WriteCommitError(dbErr('42501')), false],
    ['the genuine race at the role step', dbErr('XX000', { ...role, message: 'tuple concurrently updated' }), false],
    ['XX000 without a stage hint (outside the DO block)', dbErr('XX000'), false],
  ])('%s: password-form refusal = %s', (_label, error, expected) => {
    expect(isPasswordFormRefusal(error, true)).toBe(expected);
  });

  it('never a password-form refusal when the transaction sent no password (grant only)', () => {
    expect(isPasswordFormRefusal(new WriteCommitError(dbErr('XX000')), false)).toBe(false);
    expect(classifyWriteError(new WriteCommitError(dbErr('XX000')), { passwordSent: false })).toEqual(
      new OwnerBootstrapRefusal(OWNER_BOOTSTRAP_MESSAGES.commitInternalError('XX000'), 'XX000'),
    );
  });

  it('the classification: verifier refused -> option 1; COMMIT XX000 never a race', () => {
    expect(classifyWriteError(new WriteCommitError(dbErr('XX000')), { passwordSent: true })).toBe('verifier-refused');
    expect(classifyWriteError(new WriteCommitError(dbErr('40001')))).toBe('race');
    expect(classifyWriteError(new WriteCommitError(dbErr('XX000', { message: 'tuple concurrently updated' })))).not.toBe('race');
    expect((classifyWriteError(new WriteCommitError(dbErr('57014'))) as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.commitFailed('57014'));
    for (const e of [classifyWriteError(new WriteCommitError(dbErr('XX000'))) as Error]) expect(e.message).not.toContain('secret-bearing');
  });


});


describe('a pooler in PG_ADMIN_URL, detected by capability', () => {
  it('the session probe failing refuses (64) before any read or write, with the direct-address options', async () => {
    const { io, texts } = fakeIo([base], [{ ok: true }]);
    io.sessionProbe = async () => {
      throw new PgSessionProbeError('PG_ADMIN_URL connection is not session-stable (x). Refusing to start.');
    };
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNotSessionStable);
    expect(OWNER_BOOTSTRAP_MESSAGES.adminNotSessionStable).toContain('PG_ADMIN_DIRECT_URL');
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q2_FACTS);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('a server that refuses the session settings at connect (08P01) is refused with the direct-address options', () => {
    const e = classifyAdminConnectError(Object.assign(new Error('unsupported startup parameter: options'), { code: '08P01' }), false);
    expect(e).toBeInstanceOf(OwnerBootstrapRefusal);
    expect(e.message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminStartupRefused('08P01'));
    expect(e.message).not.toContain('unsupported startup parameter');
  });

  it('applyAdminDirectUrl: same login and database required; db-setup then connects with the direct address only', () => {
    const pooled = `postgres://dbadmin:${ADMIN_PW}@pool.internal.example:6432/crewflow_unit?sslmode=require`;
    const direct = `postgres://dbadmin:${ADMIN_PW}@db.internal.example:5432/crewflow_unit?sslmode=require`;
    const out = applyAdminDirectUrl({ PG_ADMIN_URL: pooled, [ADMIN_DIRECT_URL_LABEL]: direct, OTHER: 'x' });
    expect(out.used).toBe(true);
    expect(out.env).toEqual({ PG_ADMIN_URL: direct, OTHER: 'x' });
    expect(applyAdminDirectUrl({ PG_ADMIN_URL: pooled })).toEqual({ env: { PG_ADMIN_URL: pooled }, used: false });
    expect(() => applyAdminDirectUrl({ PG_ADMIN_URL: pooled, [ADMIN_DIRECT_URL_LABEL]: direct.replace('dbadmin', 'other') })).toThrow(
      OWNER_BOOTSTRAP_MESSAGES.adminDirectMismatch,
    );
  });

  it('runOwnerBootstrap with PG_ADMIN_DIRECT_URL: logs that it is used, connects with it (unreachable here: 70), prints no value', async () => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(
      {
        PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@pool.internal.example:6432/crewflow_unit`,
        PG_ADMIN_DIRECT_URL: `postgres://dbadmin:${ADMIN_PW}@127.0.0.1:1/crewflow_unit`,
        PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit`,
      },
      { log: (l) => lines.push(l), retryWindowMs: 0 },
    );
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.adminDirectUsed);
    const text = lines.join('\n');
    for (const forbidden of [ADMIN_PW, OWNER_PW, 'pool.internal.example', 'crewflow_unit']) expect(text).not.toContain(forbidden);
  });
});

describe('#257 + #259 combined: sslmode=require (OpenShip) in production', () => {
  it('PG_ADMIN_URL and PG_DATABASE_URL at sslmode=require pass every input check and db-setup connects (unreachable here: 70); prefer is refused (64)', async () => {
    const urls = (mode: string) => ({
      NODE_ENV: 'production',
      PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@127.0.0.1:1/crewflow_unit?sslmode=${mode}`,
      PG_DATABASE_URL: `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit?sslmode=${mode}`,
    });
    const ok = await runOwnerBootstrap(urls('require'), { log: () => undefined, retryWindowMs: 0 });
    expect(ok).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    const refused = await runOwnerBootstrap(urls('prefer'), { log: () => undefined, retryWindowMs: 0 });
    expect(refused.exitCode).toBe(64);
  });
});

describe('lead audit 2026-11-19 item 6 (NOT applied, owner decision): mode c keeps the reviewed N1 rule', () => {
  it('decideOwnerSelf accepts a crewflow_owner that owns the database through a role (the transition-shaped database)', () => {
    const self = { sessionLogin: 'crewflow_owner', currentLogin: 'crewflow_owner' };
    expect(decideOwnerSelf(self, { ...existing, oOwnsDb: true })).toEqual([]);
  });
});


describe('PR #258: PG_DATABASE_SESSION_URL (the crewflow_owner session address) in db-setup', () => {
  const pooledApp = `postgres://crewflow_owner:${OWNER_PW}@pool.internal.example:6432/crewflow_unit`;
  const sessionApp = `postgres://crewflow_owner:${OWNER_PW}@127.0.0.1:1/crewflow_unit`;

  it('applyAppSessionUrl: the same login, password and database as PG_DATABASE_URL, or refused; then it replaces PG_DATABASE_URL in db-setup\'s copy only', () => {
    const env = { PG_DATABASE_URL: pooledApp, PG_DATABASE_SESSION_URL: sessionApp };
    expect(applyAppSessionUrl(env)).toEqual({ env: { PG_DATABASE_URL: sessionApp }, used: true });
    expect(env.PG_DATABASE_URL).toBe(pooledApp);
    expect(applyAppSessionUrl({ PG_DATABASE_URL: pooledApp })).toEqual({ env: { PG_DATABASE_URL: pooledApp }, used: false });
    expect(() => applyAppSessionUrl({ PG_DATABASE_SESSION_URL: sessionApp })).toThrow(OWNER_BOOTSTRAP_MESSAGES.appSessionWithoutApp);
    for (const bad of [sessionApp.replace('crewflow_owner', 'other'), sessionApp.replace(OWNER_PW, `${OWNER_PW}x`), sessionApp.replace('/crewflow_unit', '/other')]) {
      expect(() => applyAppSessionUrl({ PG_DATABASE_URL: pooledApp, PG_DATABASE_SESSION_URL: bad })).toThrow(OWNER_BOOTSTRAP_MESSAGES.appSessionMismatch);
    }
  });

  it('runOwnerBootstrap: logs that the session address is used and connects there (unreachable here: 70); no value printed', async () => {
    const lines: string[] = [];
    const result = await runOwnerBootstrap(
      { PG_ADMIN_URL: `postgres://dbadmin:${ADMIN_PW}@127.0.0.1:1/crewflow_unit`, PG_DATABASE_URL: pooledApp, PG_DATABASE_SESSION_URL: sessionApp },
      { log: (l) => lines.push(l), retryWindowMs: 0 },
    );
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 70, code: 'ECONNREFUSED' });
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.appSessionUsed);
    for (const forbidden of [ADMIN_PW, OWNER_PW, 'pool.internal.example', 'crewflow_unit']) expect(lines.join('\n')).not.toContain(forbidden);
  });
});


describe('security review of #259: F1 / F5 / F7 (G1 / L1 / G2 went with the plain-text path)', () => {
  it('F1: both DO blocks catch query_canceled (57014) as well as OTHERS', () => {
    for (const block of [OWNER_BOOTSTRAP_Q4C_DO, OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD]) {
      expect(block).toContain('EXCEPTION WHEN OTHERS OR query_canceled THEN');
      expect(block).not.toMatch(/EXCEPTION WHEN OTHERS THEN/);
    }
  });

  it('F7: the input statement echoes no value back (booleans only)', () => {
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.verifier', $1, true) IS NOT NULL");
    expect(OWNER_BOOTSTRAP_Q4B_SET_INPUTS).toContain("set_config('crewflow_bootstrap.need_password', $2, true) IS NOT NULL AS done");
  });

  it('F5: db-harden runs the session probe once before reading or changing anything; a pooler is refused (64) with the direct-address message', async () => {
    const f = hardenFake({ rounds: [existing], complete: [true] });
    f.io.sessionProbe = async () => {
      throw new PgSessionProbeError('PG_ADMIN_URL connection is not session-stable (x). Refusing to start.');
    };
    const error = await hardenOwnerWithIo(f.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.adminNotSessionStable);
    expect(f.sent).not.toContain(OWNER_BOOTSTRAP_Q2_FACTS);
    let probes = 0;
    const g = hardenFake({ rounds: [{ ...existing, oCreateRole: false }] });
    g.io.sessionProbe = async () => {
      probes += 1;
    };
    await hardenOwnerWithIo(g.io);
    expect(probes).toBe(1);
  });
});


describe('owner decision 2026-11-19, option 1 "Create login, you set password": a server that refuses pre-hashed passwords', () => {
  const noGrant: OwnerFacts = { ...existing, oHasDbGrant: false };
  const neverPlainText = (sent: Array<{ text: string; values?: unknown[] }>) => {
    for (const s of sent) {
      expect(s.text).not.toContain(OWNER_PW);
      for (const v of s.values ?? []) expect(String(v)).not.toContain(OWNER_PW);
    }
  };

  it('the fixed texts (the docs reconcile against these)', () => {
    expect(OWNER_BOOTSTRAP_MESSAGES.verifierRefused('commit', 'XX000')).toBe(
      'The server refused a pre-hashed password (SQLSTATE XX000 at COMMIT). Crewflow never sends a plain-text password.',
    );
    // Re-review N1 of #259: the value only in the set_config line; the DO block reads it from the setting. Pinned exactly.
    const doHead = `DO $$
DECLARE
  v_pw text := pg_catalog.current_setting('crewflow.pw', true);
BEGIN
  IF v_pw IS NULL OR v_pw = '' THEN
    RAISE EXCEPTION 'crewflow password step: run all lines together in one go, inside one transaction';
  END IF;
  BEGIN
`;
    const doTail = `  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'crewflow password step failed (%)', SQLSTATE;
  END;
END$$;`;
    expect([...OWNER_SET_PASSWORD_SQL]).toEqual([
      'ROLLBACK;',
      'BEGIN;',
      "SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true) IS NOT NULL AS value_set;",
      `${doHead}    EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner LOGIN PASSWORD %L', v_pw);
    COMMENT ON ROLE crewflow_owner IS NULL;
${doTail}`,
      'COMMIT;',
    ]);
    expect([...OWNER_MANUAL_ROLE_SQL]).toEqual([
      'ROLLBACK;',
      'BEGIN;',
      "SET LOCAL createrole_self_grant = '';",
      "SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true) IS NOT NULL AS value_set;",
      `${doHead}    EXECUTE pg_catalog.format('CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L', v_pw);
${doTail}`,
      "DO $grant$ BEGIN EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', pg_catalog.current_database()); END $grant$;",
      'COMMIT;',
    ]);
    // No DO block holds the placeholder (so never the value): only the one set_config line of each step does.
    for (const steps of [OWNER_SET_PASSWORD_SQL, OWNER_MANUAL_ROLE_SQL]) {
      for (const st of steps.filter((x) => x.startsWith('DO '))) expect(st).not.toContain('<PG_DATABASE_APP_PASSWORD>');
      expect(steps.filter((x) => x.includes('<PG_DATABASE_APP_PASSWORD>'))).toEqual(["SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true) IS NOT NULL AS value_set;"]);
    }
    expect(OWNER_BOOTSTRAP_MESSAGES.setPasswordStep).toBe(
      "Set crewflow_owner's password once in your database provider's SQL editor (or psql), connected to this database as your admin login, with exactly the SQL below, replacing <PG_DATABASE_APP_PASSWORD> with that value (32+ characters of A-Z a-z 0-9 _ -, openssl rand -hex 32; if you set PG_DATABASE_URL yourself, the password inside it; never a console password reset, which generates a different, shorter password). Copy only the lines between the BEGIN SQL and END SQL markers, and remove any log prefix such as [owner-bootstrap] or db-setup-1 | from each line. Run them all together in one go, in a fresh session (they are one transaction, and the first line, ROLLBACK;, would discard anything uncommitted in a session already in use; psql sends each statement on its own). If your SQL editor runs lines one at a time, each in its own transaction, use psql instead. If it fails, run ROLLBACK; (or open a new session) before running it again. A failed run's value can be in the server log, so use a new value and update PG_DATABASE_APP_PASSWORD (or the password inside PG_DATABASE_URL). Then redeploy: db-setup checks the login and continues.",
    );
    expect(OWNER_BOOTSTRAP_MESSAGES.manualRoleStep).toBe(
      "Create crewflow_owner once in your database provider's SQL editor (or psql), connected to this database as your admin login, with exactly the SQL below; replace <PG_DATABASE_APP_PASSWORD> with that value (32+ characters of A-Z a-z 0-9 _ -, openssl rand -hex 32; if you set PG_DATABASE_URL yourself, the password inside it). Copy only the lines between the BEGIN SQL and END SQL markers, and remove any log prefix such as [owner-bootstrap] or db-setup-1 | from each line. Run them all together in one go, in a fresh session (they are one transaction, and the first line, ROLLBACK;, would discard anything uncommitted in a session already in use; psql sends each statement on its own). If your SQL editor runs lines one at a time, each in its own transaction, use psql instead. If it fails, run ROLLBACK; (or open a new session) before running it again. A failed run's value can be in the server log, so use a new value and update PG_DATABASE_APP_PASSWORD (or the password inside PG_DATABASE_URL). Then redeploy: db-setup then only checks the login and handles CREATEROLE.",
    );
    expect(OWNER_BOOTSTRAP_MESSAGES.passwordVisibilityStep).toBe(
      "The value you type is only in the set_config line. It can remain in the server log (log_statement = all, log_min_duration_statement, auto_explain, or any error on these statements: an editor that sends all lines as one message has all of them quoted), in pg_stat_statements when pg_stat_statements.track = all (the ALTER / CREATE ROLE run inside the DO block; the default, top, does not record it), in pg_stat_activity while it runs, and in your provider's own logs and SQL-editor history. If pg_stat_statements is installed, run SELECT pg_stat_statements_reset(); afterwards where you are permitted to; otherwise treat the value as visible to anyone who can read query statistics.",
    );
    // The SET log_statement advice is gone (it needs superuser).
    for (const step of [OWNER_BOOTSTRAP_MESSAGES.setPasswordStep, OWNER_BOOTSTRAP_MESSAGES.manualRoleStep]) expect(step).not.toContain('SET log_statement');
    // The printed SQL creates exactly OWNER_BOOTSTRAP_Q4C_DO's attributes and grant.
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L');
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION');
    for (const text of Object.values(OWNER_BOOTSTRAP_MESSAGES)) if (typeof text === 'string') expect(text).not.toMatch(/neon|supabase|digitalocean/i);
  });

  it('role missing, the verifier refused at COMMIT: crewflow_owner created WITHOUT a password, grant added, the steps, 64 (awaiting-password)', async () => {
    const { io, sent, texts, lines } = fakeIo([base, base, base, existing], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toEqual({ outcome: 'awaiting-password', exitCode: 64, created: true, passwordSet: false, grantAdded: true, createRole: 'not-run', code: 'XX000' });
    const t = texts();
    expect(t.filter((x) => x === OWNER_BOOTSTRAP_Q4C_DO)).toHaveLength(1);
    expect(t.filter((x) => x === OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD)).toHaveLength(1);
    expect(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD));
    expect(t.lastIndexOf(OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD));
    expect(t.lastIndexOf(OWNER_BOOTSTRAP_Q4A_LOCK)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD));
    expect(lines).toEqual([
      OWNER_BOOTSTRAP_MESSAGES.verifierRefused('commit', 'XX000'),
      OWNER_BOOTSTRAP_MESSAGES.passwordlessCreated,
      OWNER_BOOTSTRAP_MESSAGES.setPasswordStep,
      OWNER_SQL_BEGIN_MARKER,
      ...OWNER_SET_PASSWORD_SQL.flatMap((st) => st.split('\n')),
      OWNER_SQL_END_MARKER,
      OWNER_BOOTSTRAP_MESSAGES.passwordVisibilityStep,
      OWNER_BOOTSTRAP_MESSAGES.awaitingPassword,
    ]);
    neverPlainText(sent);
  });

  it('a verifier refused in the role step (28P01, a password hook) takes the same path', async () => {
    const { io, lines } = fakeIo([base, base, base, existing], [{ ok: true }], { failOn: OWNER_BOOTSTRAP_Q4C_DO, failCode: '28P01', failHint: 'crewflow-stage=role', failTimes: 1 });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'awaiting-password', exitCode: 64, created: true });
    expect(lines[0]).toBe(OWNER_BOOTSTRAP_MESSAGES.verifierRefused('statement', '28P01'));
  });

  it('role exists and PG_DATABASE_APP_PASSWORD does not log in, verifier refused again: the password is LEFT ALONE, nothing written, the steps again, 64 (no loop)', async () => {
    const { io, sent, texts, lines } = fakeIo([existing], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toEqual({ outcome: 'awaiting-password', exitCode: 64, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: 'XX000' });
    expect(texts().filter((x) => x === OWNER_BOOTSTRAP_Q4C_DO)).toHaveLength(1);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD);
    const afterLastBegin = texts().slice(texts().lastIndexOf(OWNER_BOOTSTRAP_BEGIN));
    expect(afterLastBegin).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(afterLastBegin).not.toContain(OWNER_BOOTSTRAP_COMMIT);
    expect(texts().filter((x) => x === OWNER_BOOTSTRAP_COMMIT)).toHaveLength(1);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.passwordlessKept);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.setPasswordStep);
    neverPlainText(sent);
  });

  it('role exists without its grant: only the grant is added (the no-password block never touches an existing password)', async () => {
    const { io, texts } = fakeIo([noGrant, noGrant, noGrant, existing], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'awaiting-password', created: false, grantAdded: true });
    expect(texts()).toContain(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD);
  });

  it('the next run, after the operator set the password: the login probe succeeds, no write at all, setup continues (0)', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('the server refuses the passwordless (NOLOGIN) role too (XX000 at its COMMIT): nothing created, the reviewed SQL with the placeholder, 64 (awaiting-manual-role)', async () => {
    const { io, sent, lines } = fakeIo([base], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000' });
    const result = await bootstrapOwnerWithIo(io);
    expect(result).toEqual({ outcome: 'awaiting-manual-role', exitCode: 64, created: false, passwordSet: false, grantAdded: false, createRole: 'not-run', code: 'XX000' });
    expect(lines).toEqual([
      OWNER_BOOTSTRAP_MESSAGES.verifierRefused('commit', 'XX000'),
      OWNER_BOOTSTRAP_MESSAGES.passwordlessRefused('commit', 'XX000'),
      OWNER_BOOTSTRAP_MESSAGES.manualRoleStep,
      OWNER_SQL_BEGIN_MARKER,
      ...OWNER_MANUAL_ROLE_SQL.flatMap((st) => st.split('\n')),
      OWNER_SQL_END_MARKER,
      OWNER_BOOTSTRAP_MESSAGES.passwordVisibilityStep,
      OWNER_BOOTSTRAP_MESSAGES.awaitingManualRole,
    ]);
    expect(sent.filter((s) => s.text === OWNER_BOOTSTRAP_COMMIT)).toHaveLength(2);
    neverPlainText(sent);
  });

  it('a passwordless transaction that fails for another reason (42501) is that refusal, never the manual path', async () => {
    let commits = 0;
    const { io } = fakeIo([base], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    const realOpen = io.openAdmin.bind(io);
    io.openAdmin = async () => {
      const s = await realOpen();
      return {
        query: async (text: string, values?: unknown[]) => {
          if (text === OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD) throw Object.assign(new Error('x'), { code: '42501', hint: 'crewflow-stage=grant' });
          if (text === OWNER_BOOTSTRAP_COMMIT) commits += 1;
          return s.query(text, values);
        },
        end: () => s.end(),
      };
    };
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.writeRefused('42501'));
    expect(commits).toBe(1);
  });

  it('runOwnerBootstrap never prints the ready line for a 64 result', async () => {
    expect(OWNER_BOOTSTRAP_MESSAGES.ready('x')).toBe('crewflow_owner is ready (x).');
  });
});


describe('security re-review R1 of #259: the passwordless role is NOLOGIN; a server that needs no password is refused', () => {
  const awaiting: OwnerFacts = { ...existing, oLogin: false, oAwaitingPassword: true };

  it('NOLOGIN is accepted ONLY in the awaiting-password state (db-setup\'s marked passwordless role); any other NOLOGIN stays refused', () => {
    expect(decideBeforeProbe(awaiting)).toEqual([]);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oLogin: false }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['NOLOGIN']));
    // The mark never excuses a privileged attribute.
    expect(refusalOf(() => decideBeforeProbe({ ...awaiting, oBypassRls: true }))).toBe(OWNER_BOOTSTRAP_MESSAGES.privilegedAttributes(['BYPASSRLS']));
    expect(OWNER_AWAITING_PASSWORD_MARK).toBe('crewflow:awaiting-password:');
  });

  it('the SQL: NOLOGIN + the mark on creation; Q2 / both DO blocks / the no-password Q4d accept NOLOGIN only with the mark; the verifier block then makes it LOGIN and clears the mark', () => {
    expect(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD).toContain(
      "EXECUTE pg_catalog.format('COMMENT ON ROLE crewflow_owner IS %L',\n        'crewflow:awaiting-password:' || (pg_catalog.date_part('epoch', pg_catalog.now())::bigint + 86400)::text);",
    );
    expect(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD).toContain('(NOT r.rolcanlogin AND NOT r.awaiting)');
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain(`(o.oid IS NOT NULL AND NOT o.rolcanlogin\n        AND ${awaitingMarkValidSql("pg_catalog.shobj_description(o.oid, 'pg_authid')")})`);
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('(NOT r.rolcanlogin AND NOT v_awaiting)');
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain("EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner LOGIN PASSWORD %L', v_verifier);");
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain('COMMENT ON ROLE crewflow_owner IS NULL;');
    expect(OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY).toContain(`(rolcanlogin OR ${awaitingMarkValidSql("pg_catalog.shobj_description(oid, 'pg_authid')")})`);
    expect(OWNER_BOOTSTRAP_Q4D_REVERIFY).toContain('SELECT rolcanlogin AND');
  });

  it('run 2 in the awaiting state: the verifier is refused again, the role stays NOLOGIN and passwordless (no write), the steps again, 64', async () => {
    const { io, texts, lines } = fakeIo([awaiting], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'awaiting-password', exitCode: 64, created: false });
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.passwordlessKept);
  });

  it('a login that works with a deliberately WRONG password is refused before anything is written (pre-lock)', async () => {
    const { io, texts } = fakeIo([existing], [{ ok: true }]);
    let wrongProbes = 0;
    io.probeWrongPassword = async () => {
      wrongProbes += 1;
      return { ok: true };
    };
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.serverIgnoresPassword);
    expect(wrongProbes).toBe(1);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
  });

  it('... and after a creation (the post-commit login is trusted only if a wrong password fails)', async () => {
    const { io } = fakeIo([base, base, existing], [{ ok: true }]);
    io.probeWrongPassword = async () => ({ ok: true });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.serverIgnoresPassword);
  });

  it('a wrong password that fails (28P01) is the normal case; it is never tried while the real password fails', async () => {
    const ok = fakeIo([existing], [{ ok: true }]);
    ok.io.probeWrongPassword = async () => ({ ok: false, code: '28P01' });
    expect(await bootstrapOwnerWithIo(ok.io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    const failing = fakeIo([awaiting], [{ ok: false, code: '28P01' }], { failOn: OWNER_BOOTSTRAP_COMMIT, failCode: 'XX000', failTimes: 1 });
    let tried = 0;
    failing.io.probeWrongPassword = async () => {
      tried += 1;
      return { ok: false, code: '28P01' };
    };
    await bootstrapOwnerWithIo(failing.io);
    expect(tried).toBe(0);
  });

  it('re-review F1 remainder: lock_timeout below deadlock_timeout before the verifier DO block whenever it sets a password, never otherwise', async () => {
    expect(OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT).toContain("pg_catalog.set_config('lock_timeout', GREATEST(1, s.setting::bigint / 2)::text || 'ms', true) IS NOT NULL AS done");
    const setting = fakeIo([base, base, existing], [{ ok: true }]);
    await bootstrapOwnerWithIo(setting.io);
    const t = setting.texts();
    expect(t.indexOf(OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT)).toBeGreaterThan(t.indexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
    expect(t.indexOf(OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT)).toBeLessThan(t.indexOf(OWNER_BOOTSTRAP_Q4C_DO));
    const noGrant = { ...existing, oHasDbGrant: false };
    const grantOnly = fakeIo([noGrant, noGrant, existing], [{ ok: false, code: '42501' }, { ok: false, code: '42501' }, { ok: true }]);
    await bootstrapOwnerWithIo(grantOnly.io);
    expect(grantOnly.texts()).toContain(OWNER_BOOTSTRAP_Q4C_DO);
    expect(grantOnly.texts()).not.toContain(OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT);
  });
});


describe('security re-review N1 / N2 of #259', () => {
  it('N1: only 28P01 / 28000 on the wrong-password login count as "a password is required"; anything else is a failure (70), never a pass', async () => {
    expect([...PASSWORD_REQUIRED_SQLSTATES].sort()).toEqual(['28000', '28P01']);
    for (const code of ['28P01', '28000']) {
      const { io } = fakeIo([existing], [{ ok: true }]);
      io.probeWrongPassword = async () => ({ ok: false, code });
      expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0 });
    }
    for (const code of ['TLS', 'ECONNREFUSED', '53300', '57P03', '3D000', 'no-code']) {
      const { io, texts } = fakeIo([existing], [{ ok: true }]);
      io.probeWrongPassword = async () => ({ ok: false, code });
      const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
      expect({ code, failure: error instanceof OwnerBootstrapFailure }).toEqual({ code, failure: true });
      expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.wrongPasswordProbeUnclear(code));
      expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    }
  });

  it('N2: a LOGIN crewflow_owner that still carries the awaiting mark loses it in the CREATEROLE transaction, under the lock, even when nothing else changes', async () => {
    const stale: OwnerFacts = { ...existing, oCreateRole: false, oStaleAwaitingMark: true };
    const clean: OwnerFacts = { ...existing, oCreateRole: false };
    const { io, texts, lines } = fakeIo([stale, stale, stale, clean], [{ ok: true }], { schemaComplete: true });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0, createRole: 'none' });
    const t = texts();
    expect(t).toContain(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK);
    expect(t.indexOf(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK)).toBeGreaterThan(t.lastIndexOf(OWNER_BOOTSTRAP_Q4A_LOCK));
    expect(t.indexOf(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK)).toBeGreaterThan(t.lastIndexOf(OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES));
    expect(lastTx(t)).toBe(OWNER_BOOTSTRAP_COMMIT);
    expect(lines).toContain(OWNER_BOOTSTRAP_MESSAGES.awaitingMarkCleared);
    // The statement removes ONLY that exact comment, and only on a LOGIN role (never a CREATEROLE mark).
    expect(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK).toContain("r.rolcanlogin");
    expect(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK).toContain(awaitingMarkShapeSql("pg_catalog.shobj_description(r.oid, 'pg_authid')"));
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain('AS o_stale_awaiting_mark');
  });

  it('N2: with the stale mark and a CREATEROLE mark to set, both happen in the same transaction (H4 before H3)', async () => {
    const stale: OwnerFacts = { ...existing, oStaleAwaitingMark: true };
    const marked2: OwnerFacts = { ...existing, oCreateRolePending: true };
    const { io, texts } = fakeIo([stale, stale, stale, marked2], [{ ok: true }], { schemaComplete: false });
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ exitCode: 0, createRole: 'marked' });
    const t = texts();
    expect(t.indexOf(OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK)).toBeLessThan(t.indexOf(OWNER_HARDEN_H3_MARK_PENDING));
  });

  it('N2: a re-check that still shows the stale mark after H4 fails closed (70)', async () => {
    const stale: OwnerFacts = { ...existing, oCreateRole: false, oStaleAwaitingMark: true };
    const { io } = fakeIo([stale], [{ ok: true }], { schemaComplete: true });
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.reverifyFailed);
  });
});


describe('independent review of #259 (L1, L2, L3, I5) and its re-review (N2, N5, a)', () => {
  it('the mark SQL: shape by regex, expiry compared with the SERVER clock, nothing cast before the shape matches', () => {
    expect(awaitingMarkShapeSql('c')).toBe("COALESCE(c OPERATOR(pg_catalog.~) '^crewflow:awaiting-password:[0-9]{1,12}$', false)");
    expect(awaitingMarkValidSql('c')).toContain('CASE WHEN');
    expect(awaitingMarkValidSql('c')).toContain("pg_catalog.split_part(c, ':', 3)::bigint > pg_catalog.date_part('epoch', pg_catalog.now())::bigint");
    expect(OWNER_BOOTSTRAP_Q2_FACTS).toContain('AS o_awaiting_mark_expired');
  });

  it('L1: a NOLOGIN crewflow_owner whose awaiting mark expired is refused (64) before any probe or write; no ALTER ROLE', async () => {
    const expired: OwnerFacts = { ...existing, oLogin: false, oAwaitingPassword: false, oAwaitingMarkExpired: true };
    expect(refusalOf(() => decideBeforeProbe(expired))).toBe(OWNER_BOOTSTRAP_MESSAGES.awaitingMarkExpired);
    let probes = 0;
    const { io, texts } = fakeIo([expired], [{ ok: false, code: '28P01' }]);
    io.probeOwner = async () => {
      probes += 1;
      return { ok: false, code: '28P01' };
    };
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.awaitingMarkExpired);
    expect(probes).toBe(0);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('L2: another member of crewflow_owner (role squatting) is refused (64) before any probe or write, and again under the lock', async () => {
    expect(OWNER_BOOTSTRAP_Q2_FACTS.replace(/\s+/g, ' ')).toContain(
      "AND NOT (m.member = a.oid AND m.admin_option AND (pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'inherit_option') IS DISTINCT FROM 'true' AND (pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'set_option') IS DISTINCT FROM 'true')) END",
    );
    // PostgreSQL 15 has no inherit_option / set_option: Q2 must not name them as columns (it would fail before the version refusal).
    expect(OWNER_BOOTSTRAP_Q2_FACTS).not.toMatch(/m\.(inherit|set)_option/);
    expect(refusalOf(() => decideBeforeProbe({ ...existing, oForeignMembers: 1 }))).toBe(OWNER_BOOTSTRAP_MESSAGES.foreignMembers);
    expect(decideBeforeProbe({ ...existing, oForeignMembers: 0 })).toEqual([]);
    const first = fakeIo([{ ...existing, oForeignMembers: 2 }], [{ ok: true }]);
    await expect(bootstrapOwnerWithIo(first.io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.foreignMembers);
    expect(first.texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    // Appears between the pre-lock read and the locked read: refused under the lock, rolled back, nothing written.
    const noGrant: OwnerFacts = { ...existing, oHasDbGrant: false };
    const later = fakeIo([noGrant, { ...noGrant, oForeignMembers: 1 }], [{ ok: false, code: '42501' }]);
    await expect(bootstrapOwnerWithIo(later.io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.foreignMembers);
    expect(later.texts()).toContain(OWNER_BOOTSTRAP_ROLLBACK);
    expect(later.texts()).not.toContain(OWNER_BOOTSTRAP_Q4C_DO);
  });

  it('L3: probeWrongPassword and sessionProbe are required members of OwnerBootstrapIo (a type test)', () => {
    // @ts-expect-error probeWrongPassword and sessionProbe are required (independent review L3 of #259)
    const io: OwnerBootstrapIo = {
      openAdmin: async () => {
        throw new Error('unused');
      },
      probeOwner: async () => ({ ok: true }),
      verifier: () => '',
      log: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    };
    expect(typeof io.verifier).toBe('function');
  });

  it('re-review N2: every run that logs in runs the wrong-password check right after the successful login (marked or hardened role)', async () => {
    for (const facts of [{ ...existing, oCreateRolePending: true }, { ...existing, oCreateRole: false }]) {
      const order: string[] = [];
      const { io, texts } = fakeIo([facts], [{ ok: true }]);
      const real = io.probeOwner;
      io.probeOwner = async () => {
        order.push('real');
        return real();
      };
      io.probeWrongPassword = async () => {
        order.push('wrong');
        return { ok: false, code: '28P01' };
      };
      expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
      expect(order).toEqual(['real', 'wrong']);
      expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    }
  });

  it('re-review N2: a hardened, unmarked role that logs in while a WRONG password also logs in is refused (64, serverIgnoresPassword), zero writes', async () => {
    const hardened: OwnerFacts = { ...existing, oCreateRole: false, oCreateRolePending: false };
    const { io, texts } = fakeIo([hardened], [{ ok: true }]);
    io.probeWrongPassword = async () => ({ ok: true });
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.serverIgnoresPassword);
    expect(texts()).not.toContain(OWNER_BOOTSTRAP_BEGIN);
    expect(texts().filter((x) => /\b(ALTER|CREATE|GRANT|COMMENT)\b/.test(x) && x !== OWNER_BOOTSTRAP_Q2_FACTS)).toEqual([]);
  });

  it('after a creation the check runs once more (post-commit, after the new login works); after a grant-only transaction only the pre-lock one', async () => {
    let wrong = 0;
    const created = fakeIo([base, base, { ...existing, oCreateRolePending: true }], [{ ok: true }]);
    created.io.probeWrongPassword = async () => {
      wrong += 1;
      return { ok: false, code: '28P01' };
    };
    await bootstrapOwnerWithIo(created.io);
    expect(wrong).toBe(1);
    wrong = 0;
    const noGrant: OwnerFacts = { ...existing, oCreateRolePending: true, oHasDbGrant: false };
    const grantOnly = fakeIo([noGrant, noGrant, { ...existing, oCreateRolePending: true }], [{ ok: true }, { ok: true }, { ok: true }]);
    grantOnly.io.probeWrongPassword = async () => {
      wrong += 1;
      return { ok: false, code: '28P01' };
    };
    await bootstrapOwnerWithIo(grantOnly.io);
    expect(wrong).toBe(1);
  });

  it('re-review N5: the expired-mark refusal prints the password step and where the value can remain', async () => {
    const { io, lines } = fakeIo([{ ...existing, oLogin: false, oAwaitingMarkExpired: true }], [{ ok: true }]);
    await expect(bootstrapOwnerWithIo(io)).rejects.toThrow(OWNER_BOOTSTRAP_MESSAGES.awaitingMarkExpired);
    expect(lines).toEqual([
      OWNER_BOOTSTRAP_MESSAGES.setPasswordStep,
      OWNER_SQL_BEGIN_MARKER,
      ...OWNER_SET_PASSWORD_SQL.flatMap((st) => st.split('\n')),
      OWNER_SQL_END_MARKER,
      OWNER_BOOTSTRAP_MESSAGES.passwordVisibilityStep,
    ]);
    expect(OWNER_BOOTSTRAP_MESSAGES.foreignMembers).toContain('REVOKE crewflow_owner FROM <your admin login>');
    expect(OWNER_BOOTSTRAP_MESSAGES.foreignMembers).toContain('SET or INHERIT');
  });

  it('re-review (a): the crewflow_owner password db-setup creates or sets is ^[A-Za-z0-9_-]{32,}$ only', () => {
    expect(OWNER_APP_PASSWORD_PATTERN.source).toBe('^[A-Za-z0-9_-]{32,}$');
    expect(OWNER_APP_PASSWORD_PATTERN.test('a'.repeat(31))).toBe(false);
    expect(OWNER_APP_PASSWORD_PATTERN.test('0123456789abcdef0123456789abcdef')).toBe(true);
    for (const bad of ["'", '$$', '\\', '%', ' ']) expect(OWNER_APP_PASSWORD_PATTERN.test(`ownerpw-0123456789-abcdefghij-KLMNOPQR${bad}`)).toBe(false);
  });

  it('owner SQL review (a): every printed admin-grant hint reads exactly the INHERIT FALSE, SET FALSE form; (b) a password change is logged once, no value', async () => {
    const hint = 'GRANT crewflow_owner TO <admin> WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;';
    for (const text of [OWNER_BOOTSTRAP_MESSAGES.adminNoAdminOption, OWNER_BOOTSTRAP_MESSAGES.createRoleNoRights]) expect(text).toContain(hint);
    for (const text of Object.values(OWNER_BOOTSTRAP_MESSAGES)) {
      if (typeof text !== 'string') continue;
      // Any other GRANT crewflow_owner TO in a printed text is the hint above, verbatim.
      for (const m of text.match(/GRANT crewflow_owner TO [^;]*;/g) ?? []) expect(m).toBe(hint);
    }
    expect(OWNER_BOOTSTRAP_MESSAGES.passwordSet).toBe(
      'db-setup CHANGED the crewflow_owner password: the password inside PG_DATABASE_URL did not log in, so crewflow_owner now uses it (set with the admin login, PG_ADMIN_URL). Anything else that used the old password no longer logs in. Value not shown.',
    );
    const { io, lines } = fakeIo([existing, existing, existing], [{ ok: false, code: '28P01' }, { ok: false, code: '28P01' }, { ok: true }]);
    expect(await bootstrapOwnerWithIo(io)).toMatchObject({ outcome: 'updated', passwordSet: true, created: false });
    expect(lines.filter((l) => l === OWNER_BOOTSTRAP_MESSAGES.passwordSet)).toHaveLength(1);
    const created = fakeIo([base, base, { ...existing, oCreateRolePending: true }], [{ ok: true }]);
    await bootstrapOwnerWithIo(created.io);
    expect(created.lines).not.toContain(OWNER_BOOTSTRAP_MESSAGES.passwordSet);
  });

  it('re-check F2 / F3 / F4 of #259: markers, ROLLBACK first, the retry advice, and a set_config that echoes no value', () => {
    expect(OWNER_SQL_BEGIN_MARKER).toBe('----- BEGIN SQL (copy the lines between these markers, without any log prefix) -----');
    expect(OWNER_SQL_END_MARKER).toBe('----- END SQL -----');
    const retry =
      "If it fails, run ROLLBACK; (or open a new session) before running it again. A failed run's value can be in the server log, so use a new value and update PG_DATABASE_APP_PASSWORD (or the password inside PG_DATABASE_URL).";
    const prefix = 'remove any log prefix such as [owner-bootstrap] or db-setup-1 | from each line.';
    for (const step of [OWNER_BOOTSTRAP_MESSAGES.setPasswordStep, OWNER_BOOTSTRAP_MESSAGES.manualRoleStep, OWNER_BOOTSTRAP_MESSAGES.resetPasswordStep]) {
      expect(step).toContain(retry);
      expect(step).toContain(prefix);
      expect(step).toContain('in a fresh session');
    }
    expect(OWNER_BOOTSTRAP_MESSAGES.resetPasswordStep).toBe(
      "Set the new crewflow_owner password once in your database provider's SQL editor (or psql), connected to this database as your admin login, with exactly the SQL below, replacing <PG_DATABASE_APP_PASSWORD> with the new value (32+ characters of A-Z a-z 0-9 _ -, openssl rand -hex 32), then put it in PG_DATABASE_URL. Copy only the lines between the BEGIN SQL and END SQL markers, and remove any log prefix such as [owner-bootstrap] or db-setup-1 | from each line. Run them all together in one go, in a fresh session (they are one transaction, and the first line, ROLLBACK;, would discard anything uncommitted in a session already in use; psql sends each statement on its own). If your SQL editor runs lines one at a time, each in its own transaction, use psql instead. " + retry,
    );
    for (const steps of [OWNER_SET_PASSWORD_SQL, OWNER_MANUAL_ROLE_SQL, OWNER_RESET_PASSWORD_SQL]) {
      expect(steps[0]).toBe('ROLLBACK;');
      expect(steps.filter((x) => x.includes('set_config'))).toEqual(["SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true) IS NOT NULL AS value_set;"]);
    }
    expect(OWNER_BOOTSTRAP_MESSAGES.awaitingMarkExpired).toContain('the password step above');
  });

  it('re-check F1 of #259: a pre-lock login refused with 42501 (no CONNECT grant yet), then a grant-only run: the wrong-password check still runs after COMMIT', async () => {
    const noGrant: OwnerFacts = { ...existing, oCreateRolePending: true, oHasDbGrant: false };
    const order: string[] = [];
    const { io, texts } = fakeIo([noGrant, noGrant, { ...existing, oCreateRolePending: true }], [{ ok: false, code: '42501' }, { ok: true }]);
    const real = io.probeOwner;
    io.probeOwner = async () => {
      order.push('real');
      return real();
    };
    io.probeWrongPassword = async () => {
      order.push('wrong');
      return { ok: true };
    };
    const error = await bootstrapOwnerWithIo(io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((error as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.serverIgnoresPassword);
    // pre-lock (42501), under the lock (ok: the grant is still added), after COMMIT (ok), then the wrong password.
    expect(order).toEqual(['real', 'real', 'real', 'wrong']);
    expect(texts()).toContain(OWNER_BOOTSTRAP_COMMIT);
  });

  it('I5: the "waiting for its password" branch of the DO block has its own SQLSTATE (55000) and message', () => {
    expect(OWNER_BOOTSTRAP_Q4C_DO).toContain("RAISE EXCEPTION 'crewflow_owner is waiting for its password' USING ERRCODE = '55000';");
    const e = classifyWriteError(Object.assign(new Error('x'), { code: '55000', hint: 'crewflow-stage=check' }), { passwordSent: false });
    expect(e).toBeInstanceOf(OwnerBootstrapRefusal);
    expect((e as Error).message).toBe(OWNER_BOOTSTRAP_MESSAGES.awaitingNotWritable);
  });
});
