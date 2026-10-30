/**
 * Phase B (P7) — unit rules of the one-off migration process: URL resolution, lock parameters, deploy-prepare's extra identity
 * and phase rules, the cache-flush allow-list, and the migrator role password verifier. The live behaviour (lock contention,
 * killed holder, gates after the lock) is exercised against a disposable cluster by the B6-A verification script; the cache
 * flush against a real Redis is in entity-cache-flush.integration.spec.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { assertMigrationPhase, cacheFlushRequest, deployPrepare, EXIT_PENDING_NOT_APPROVED } from '../deploy-prepare';
import { readSetupDbDotenvSources, setupDbApprovalRefusal } from '../setup-db';
import { assertDisposableCluster, disposableAdminUrl, DISPOSABLE_MARKER_SQL, MigratorRoleSetupError, scramSha256Verifier } from '../setup/migrator-role';
import { assertCacheEnvName, assertFlushableNamespace, entityCacheBaseOf } from './entity-cache-flush';
import { assertIdentityCanMigrate, LockedMigrationOptions, LockedMigrationResult, redactConnectionStrings, runLockedMigrations } from './locked-migration-runner';
import {
  assertMigrationApproval,
  describePendingSet,
  isMigrationApprovalToken,
  LEGACY_MIGRATION_APPROVAL,
  MigrationApprovalError,
  migrationApprovalToken,
  pendingInRunOrder,
  readMigrationApproval,
} from './migration-approval';
import { PgProbeClient, PgSessionProbeError, probePgSessionAffinity } from '../../../postgres';
import { resolveMigrationConnection, targetGuardEnv } from './migration-database-url';
import { lockKeyParts, MAX_MIGRATION_LOCK_WAIT_SECONDS, MIGRATION_LOCK_KEY, migrationLockWaitSeconds } from './migration-lock';
import { MigrationIdentityError, MigrationIdentityFacts } from '../../core/migration-identity';

const MIG = 'postgres://crewflow_migrator:pw@127.0.0.1:15436/rab';
const APP = 'postgres://crewflow_app:pw@127.0.0.1:15436/rab';
const OTHER = 'postgres://crewflow_migrator:pw@127.0.0.1:15436/other';

describe('resolveMigrationConnection (P1/P7, through the shared factory)', () => {
  const PROD_MIG = `${MIG}?sslmode=verify-full`;
  it('production: PG_DATABASE_URL only, as the primary endpoint', () => {
    const c = resolveMigrationConnection({ NODE_ENV: 'production', DB_TARGET: 'production', PG_DATABASE_URL: PROD_MIG });
    expect(c).toMatchObject({ endpoint: 'primary', source: 'PG_DATABASE_URL', url: PROD_MIG });
    expect(c.resolved.processRole).toBe('migrate');
  });
  it('production: refuses a missing PG_DATABASE_URL and every legacy name (even when equal)', () => {
    expect(() => resolveMigrationConnection({ DB_TARGET: 'production', DATABASE_URL_UNPOOLED: PROD_MIG })).toThrow(/PG_DATABASE_URL is required|legacy/);
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
      expect(() => resolveMigrationConnection({ DB_TARGET: 'production', PG_DATABASE_URL: PROD_MIG, [name]: PROD_MIG })).toThrow(/legacy/);
    }
  });
  it('production: refuses a PG_DATABASE_URL that came from packages/rab-server/.env', () => {
    expect(() => resolveMigrationConnection({ DB_TARGET: 'production', PG_DATABASE_URL: PROD_MIG }, { PG_DATABASE_URL: PROD_MIG })).toThrow(/\.env/);
  });
  it('production: a transaction-pooler URL is refused for the migrate process (session advisory lock)', () => {
    expect(() =>
      resolveMigrationConnection({ DB_TARGET: 'production', PG_DATABASE_URL: 'postgres://m:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full' }),
    ).toThrow(/pooler/);
  });
  it('non-production: the deprecated DATABASE_URL_UNPOOLED names the migration endpoint, with a warning', () => {
    const c = resolveMigrationConnection({ DB_TARGET: 'test', DATABASE_URL_UNPOOLED: MIG, DATABASE_URL: APP });
    expect(c).toMatchObject({ endpoint: 'elevated', source: 'DATABASE_URL_UNPOOLED', url: MIG });
    expect(c.warnings.join()).toMatch(/deprecated/);
    expect(resolveMigrationConnection({ DB_TARGET: 'local', DATABASE_URL: MIG })).toMatchObject({ endpoint: 'primary', source: 'DATABASE_URL' });
  });
  it('non-production: PG_DATABASE_URL and a DATABASE_URL_UNPOOLED naming another target is refused, not silently overridden', () => {
    expect(() => resolveMigrationConnection({ DB_TARGET: 'test', PG_DATABASE_URL: MIG, DATABASE_URL_UNPOOLED: APP })).toThrow(/different targets/);
    expect(resolveMigrationConnection({ DB_TARGET: 'test', PG_DATABASE_URL: MIG, DATABASE_URL_UNPOOLED: MIG }).url).toBe(MIG);
  });
  it('non-production: PG_DATABASE_URL and a DATABASE_URL naming another target is refused (factory rule)', () => {
    expect(() => resolveMigrationConnection({ DB_TARGET: 'test', PG_DATABASE_URL: MIG, DATABASE_URL: OTHER })).toThrow(/different targets/);
  });
  it('nothing set is refused; messages never contain the URL', () => {
    expect(() => resolveMigrationConnection({ DB_TARGET: 'test' })).toThrow(/PG_DATABASE_URL is required/);
    try {
      resolveMigrationConnection({ DB_TARGET: 'production', PG_DATABASE_URL: PROD_MIG, DATABASE_URL: PROD_MIG });
    } catch (error) {
      expect((error as Error).message).not.toContain('pw@');
    }
  });
  it('the target guard sees exactly one connection', () => {
    expect(targetGuardEnv({ DB_TARGET: 'test', DATABASE_URL: APP, DATABASE_URL_UNPOOLED: APP, DATABASE_DIRECT_URL: APP }, MIG)).toEqual({
      DB_TARGET: 'test',
      PG_DATABASE_URL: MIG,
      DATABASE_URL: undefined,
      DATABASE_URL_UNPOOLED: undefined,
      DATABASE_DIRECT_URL: undefined,
    });
  });
});

describe('migration lock parameters', () => {
  it('the key is the fixed literal "crewmigr" in the single-bigint keyspace', () => {
    expect(Buffer.from(MIGRATION_LOCK_KEY.toString(16), 'hex').toString('ascii')).toBe('crewmigr');
    expect(MIGRATION_LOCK_KEY <= 0x7fffffffffffffffn).toBe(true);
    expect(lockKeyParts()).toEqual({ classid: String(0x63726577), objid: String(0x6d696772) });
  });
  it('wait bound: default 600 s, 1..840 accepted, anything else refused', () => {
    expect(migrationLockWaitSeconds(undefined)).toBe(600);
    expect(migrationLockWaitSeconds(' 30 ')).toBe(30);
    expect(migrationLockWaitSeconds(String(MAX_MIGRATION_LOCK_WAIT_SECONDS))).toBe(840);
    for (const bad of ['0', '841', '-1', '1.5', 'ten', '900']) expect(() => migrationLockWaitSeconds(bad)).toThrow(/1 to 840/);
  });
});

const facts = (over: Partial<MigrationIdentityFacts>): MigrationIdentityFacts => ({
  currentUser: 'crewflow_migrator',
  isSuperuser: false,
  roleSplitApplied: true,
  canActAsOwnerRoles: true,
  pendingMigrations: 0,
  pendingBeforeRoleSplit: 0,
  ...over,
});

describe('deploy-prepare identity rules', () => {
  it('a runtime credential is refused even with nothing pending; a migration identity or superuser passes', () => {
    expect(() => assertIdentityCanMigrate(facts({ currentUser: 'crewflow_app', canActAsOwnerRoles: false }))).toThrow(MigrationIdentityError);
    expect(() => assertIdentityCanMigrate(facts({ currentUser: 'crewflow', canActAsOwnerRoles: false }))).toThrow(/not a migration identity/);
    expect(() => assertIdentityCanMigrate(facts({}))).not.toThrow();
    expect(() => assertIdentityCanMigrate(facts({ currentUser: 'rab', isSuperuser: true, canActAsOwnerRoles: true }))).not.toThrow();
    // Before the role split the CF-41 phase-A rule applies instead (rab_owner).
    expect(() => assertIdentityCanMigrate(facts({ currentUser: 'rab_owner', roleSplitApplied: false, canActAsOwnerRoles: false }))).not.toThrow();
  });
  it('CREWFLOW_MIGRATION_PHASE is applied to the live session role', () => {
    expect(() => assertMigrationPhase(undefined, facts({}))).not.toThrow();
    expect(() => assertMigrationPhase('A', facts({ currentUser: 'rab_owner' }))).not.toThrow();
    expect(() => assertMigrationPhase('A', facts({}))).toThrow(/rab_owner/);
    for (const role of ['rab_app', 'rab_owner', 'crewflow', 'crewflow_app']) expect(() => assertMigrationPhase('B', facts({ currentUser: role }))).toThrow(/phase|PHASE/);
    expect(() => assertMigrationPhase('B', facts({}))).not.toThrow();
    expect(() => assertMigrationPhase('C', facts({}))).toThrow(/A or B/);
  });
});

describe('cache flush allow-list', () => {
  it('only the entitycache namespace is flushable', () => {
    expect(assertFlushableNamespace('entitycache')).toBe('entitycache');
    for (const ns of ['authctx', 'usersession', 'login-rate', 'invite-rate', 'mfa-challenge', 'step-up', 'ai', 'rt', '*', '']) {
      expect(() => assertFlushableNamespace(ns)).toThrow(/not flushable/);
    }
    expect(cacheFlushRequest(['--cache-flush=entitycache'], {})).toBe('entitycache');
    expect(cacheFlushRequest([], { CREWFLOW_DEPLOY_CACHE_FLUSH: 'entitycache' })).toBe('entitycache');
    expect(cacheFlushRequest([], {})).toBeNull();
    expect(() => cacheFlushRequest(['--cache-flush=authctx'], {})).toThrow(/not flushable/);
  });
  it('NODE_ENV must be a plain name (never a SCAN glob)', () => {
    expect(assertCacheEnvName('production')).toBe('production');
    for (const bad of [undefined, '', '*', 'prod*', 'a:b', 'PROD', 'x?']) expect(() => assertCacheEnvName(bad)).toThrow(/NODE_ENV/);
  });
  it('recognises exactly the epoch and data keys of the entity cache of one environment', () => {
    const e = 'production';
    expect(entityCacheBaseOf('crewflow:production:entitycache:user:u1:epoch', e)).toBe('crewflow:production:entitycache:user:u1');
    expect(entityCacheBaseOf('crewflow:production:entitycache:user:u1:v12', e)).toBe('crewflow:production:entitycache:user:u1');
    expect(entityCacheBaseOf('crewflow:production:entitycache:workspace_host_label:3:acme:v0', e)).toBe('crewflow:production:entitycache:workspace_host_label:3:acme');
    for (const k of [
      'crewflow:test:entitycache:user:u1:epoch',
      'crewflow:production:authctx:o:s:w:1.1.1.1.1.1',
      'crewflow:production:usersession:abc',
      'crewflow:production:entitycache:user:epoch',
      'crewflow:production:entitycache:user:u1:vx',
      'crewflow:production:entitycache:user:u1',
    ]) {
      expect(entityCacheBaseOf(k, e)).toBeNull();
    }
  });
});

describe('migrator role setup helpers', () => {
  it('SCRAM-SHA-256 verifier in PostgreSQL format, deterministic for a fixed salt, never the password', () => {
    const salt = Buffer.alloc(16, 7);
    const v = scramSha256Verifier('abcdefghijklmnopqrstuvwxyz123456', salt);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).toBe(scramSha256Verifier('abcdefghijklmnopqrstuvwxyz123456', salt));
    expect(v).not.toContain('abcdefghij');
  });
  it('the admin URL must be loopback and is pinned to the postgres database', () => {
    expect(() => disposableAdminUrl(undefined)).toThrow(/required/);
    expect(() => disposableAdminUrl('postgres://u:p@db.example.com:5432/x')).toThrow(/loopback/);
    expect(new URL(disposableAdminUrl('postgres://u:p@127.0.0.1:15436/x')).pathname).toBe('/postgres');
  });
  it('L-1: the admin URL goes through the factory URL policy: a query-string host / port / user override or session options are refused, by name only', () => {
    for (const [query, pattern] of [
      ['host=real-db.example', /sets "host" as a query parameter/],
      ['hostaddr=203.0.113.9', /sets "hostaddr"/],
      ['port=6543', /sets "port"/],
      ['user=postgres', /sets "user"/],
      ['options=-c%20crewflow.disposable_cluster%3Don', /sets "options"/],
    ] as const) {
      let message = '';
      try {
        disposableAdminUrl(`postgres://su:S3cretPW@localhost:15436/x?${query}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MigratorRoleSetupError);
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain('S3cretPW');
    }
    expect(() => disposableAdminUrl('not a url')).toThrow(/must be a postgres:\/\/ or postgresql:\/\/ URL \(value not shown\)/);
    expect(new URL(disposableAdminUrl('postgres://u:p@[::1]:15436/x')).pathname).toBe('/postgres');
  });
  it('L-1: the disposable marker must be a server-side fact (database setting, configuration file or server command line), never a session setting', () => {
    const none = { rolsuper: true, database_marker: false, file_marker: false, command_line_marker: false };
    // A session-only marker (startup options / SET) shows in current_setting() but in none of these facts: refused.
    expect(() => assertDisposableCluster(none)).toThrow(/not marked disposable server-side .*a session setting does not count/);
    expect(() => assertDisposableCluster({ ...none, database_marker: true, rolsuper: false })).toThrow(/must be a superuser/);
    expect(() => assertDisposableCluster(undefined)).toThrow(/must be a superuser/);
    expect(assertDisposableCluster({ ...none, database_marker: true })).toBe('database setting');
    expect(assertDisposableCluster({ ...none, file_marker: true })).toBe('configuration file');
    expect(assertDisposableCluster({ ...none, command_line_marker: true })).toBe('server command line');
    // The SQL reads catalog / server facts only, never current_setting().
    expect(DISPOSABLE_MARKER_SQL).not.toMatch(/current_setting/);
    expect(DISPOSABLE_MARKER_SQL).toMatch(/pg_db_role_setting/);
    expect(DISPOSABLE_MARKER_SQL).toMatch(/pg_file_settings/);
    expect(DISPOSABLE_MARKER_SQL).toMatch(/postmaster\.opts/);
  });
  it('connection strings are redacted from messages', () => {
    expect(redactConnectionStrings('failed postgres://u:p@h/db and redis://:p@h:1/5 end')).toBe('failed <url> and <url> end');
  });
});

describe('runLockedMigrations: live session-stability probe before any migration session or lock (security review L-3)', () => {
  // A self-hosted transaction-mode pooler on a port no URL rule knows: every statement outside a transaction may land on
  // another backend, so the probe's two-transaction pid check fails. Port 1 is never listening: had the runner gone on to
  // open its migration DataSource, the failure would be a connection error, not the probe's refusal.
  const POOLER_LIKE = 'postgres://crewflow_migrator:pw@127.0.0.1:1/rab';
  let nextPid = 100;
  const poolerClient = (): PgProbeClient => ({
    connect: async () => undefined,
    end: async () => undefined,
    on: () => undefined,
    query: async <R>(sql: string): Promise<{ rows: R[] }> => ({ rows: (sql.includes('pg_backend_pid') ? [{ pid: nextPid++ }] : []) as R[] }),
  });

  it('a pooled (session-unstable) migration connection is refused before the lock, the second gate or any DDL', async () => {
    const targetCalls: string[] = [];
    const probedHosts: string[] = [];
    const run = runLockedMigrations({
      label: 'test-runner',
      env: { DB_TARGET: 'local', PG_DATABASE_URL: POOLER_LIKE },
      dotenvValues: {},
      log: () => undefined,
      assertTarget: async (purpose) => {
        targetCalls.push(purpose);
        return { target: 'local', app: { database: 'rab', host: '127.0.0.1' } };
      },
      sessionProbe: (config, options) => {
        probedHosts.push(String(config.host));
        return probePgSessionAffinity(config, { ...options, createClient: poolerClient });
      },
    });
    await expect(run).rejects.toThrow(PgSessionProbeError);
    await expect(run).rejects.toThrow(/the migration session connection is not session-stable .*Refusing to start\./);
    expect(probedHosts).toEqual(['127.0.0.1']);
    expect(targetCalls).toEqual(['migrations']); // only the pre-lock gate ran: no lock, no post-lock gate, nothing applied
  });

  it('the default probe is the real one (no seam): it cannot reach a closed port and refuses before any migration session', async () => {
    await expect(
      runLockedMigrations({
        label: 'test-runner',
        env: { DB_TARGET: 'local', PG_DATABASE_URL: POOLER_LIKE },
        dotenvValues: {},
        log: () => undefined,
        assertTarget: async () => ({ target: 'local', app: { database: 'rab', host: '127.0.0.1' } }),
      }),
    ).rejects.toThrow(/cannot open the two the migration session connection probe connections/);
  });
});

describe('setup-db production approval (security review L-2)', () => {
  it('DB_TARGET=production refuses without the per-release approval, before any connection; local/test are unchanged', () => {
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' })).toMatch(
      /setup-db with DB_TARGET=production applies pending migrations only with CREWFLOW_MIGRATION_APPROVED=<approval token> .*Refusing\./,
    );
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'yes' })).toMatch(/not a migration approval token.*Refusing/);
    // Final review F5: the retired constant is refused before any connection (it would approve whatever is pending).
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' })).toMatch(
      /apply-pending-migrations is no longer accepted: final review F5.*deploy-prepare without an approval.*Refusing/,
    );
    // A well-formed token proceeds; the locked runner compares it with the set pending after the lock.
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: TOKEN_AB })).toBeNull();
    // An approval sitting in a .env file is a standing approval: refused even when the process environment repeats it.
    expect(
      setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: TOKEN_AB }, { CREWFLOW_MIGRATION_APPROVED: TOKEN_AB }),
    ).toMatch(/present in a \.env file/);
    for (const DB_TARGET of ['local', 'test', undefined]) expect(setupDbApprovalRefusal({ DB_TARGET })).toBeNull();
  });

  it('L-2 follow-up: an approval in ANY dotenv source that can reach setup-db is refused — cwd .env, DOTENV_CONFIG_PATH / dotenv_config_path=, packages/rab-server/.env (Nx)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crewflow-setup-db-'));
    try {
      const prodEnv = { DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: TOKEN_AB };
      const approval = `CREWFLOW_MIGRATION_APPROVED=${TOKEN_AB}\n`;
      const none = () => ({});
      // Nothing anywhere: the process-environment approval proceeds.
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, [], dir, none))).toBeNull();
      // packages/rab-server/.env (what Nx injects; read as data through database-target.ts readDotenvValues).
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, [], dir, () => ({ CREWFLOW_MIGRATION_APPROVED: TOKEN_AB })))).toMatch(
        /present in a \.env file/,
      );
      // DOTENV_CONFIG_PATH (relative to the working directory) and the dotenv_config_path= argument.
      writeFileSync(join(dir, 'custom.env'), approval);
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({ DOTENV_CONFIG_PATH: 'custom.env' }, [], dir, none))).toMatch(/present in a \.env file/);
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, ['node', 'setup-db.js', 'dotenv_config_path=custom.env'], dir, none))).toMatch(
        /present in a \.env file/,
      );
      // The working directory's .env.
      writeFileSync(join(dir, '.env'), approval);
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, [], dir, none))).toMatch(/present in a \.env file/);
      // Local / test never need an approval, wherever files are.
      expect(setupDbApprovalRefusal({ DB_TARGET: 'local' }, readSetupDbDotenvSources({}, [], dir, none))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.env.migrate.example ships the approval commented out (no standing approval in a copied template)', () => {
    const template = readFileSync(join(__dirname, '../../../../../../rab-docker/.env.migrate.example'), 'utf8');
    expect(template).not.toMatch(/^\s*CREWFLOW_MIGRATION_APPROVED\s*=/m);
    expect(template).toMatch(/^#\s*CREWFLOW_MIGRATION_APPROVED=pending-<count>-<sha256>$/m);
    // F5: the template no longer documents the retired constant as an approval to set.
    expect(template).not.toMatch(/CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations/);
  });
});

const PENDING_AB = ['AddThing1786000000001', 'AddOther1786000000002'];
const TOKEN_AB = migrationApprovalToken(PENDING_AB);

describe('final review F5: the migration approval names the exact pending set', () => {
  it('the token is pending-<count>-<sha256> of the set in RUN order; any change to the set changes it, the load order does not', () => {
    expect(TOKEN_AB).toMatch(/^pending-2-[0-9a-f]{64}$/);
    expect(isMigrationApprovalToken(TOKEN_AB)).toBe(true);
    expect(migrationApprovalToken([...PENDING_AB])).toBe(TOKEN_AB); // deterministic
    // The same set loaded in another order (glob / filesystem order) is the same set, run in the same (timestamp) order.
    expect(migrationApprovalToken([...PENDING_AB].reverse())).toBe(TOKEN_AB);
    expect(pendingInRunOrder(['B1786000000003', 'A1786000000001', 'C1786000000001'])).toEqual(['A1786000000001', 'C1786000000001', 'B1786000000003']);
    expect(() => migrationApprovalToken(['AddThing1786000000001', 'AddThing1786000000001'])).toThrow(/appears twice/);
    expect(migrationApprovalToken(PENDING_AB.slice(0, 1))).not.toBe(TOKEN_AB);
    expect(migrationApprovalToken([...PENDING_AB, 'AddMore1786000000003'])).not.toBe(TOKEN_AB);
    expect(migrationApprovalToken([])).toMatch(/^pending-0-[0-9a-f]{64}$/);
    expect(() => migrationApprovalToken(['Bad\nName1786000000001'])).toThrow(MigrationApprovalError);
    for (const bad of ['apply-pending-migrations', 'yes', 'true', 'pending-2-abc', `pending-02-${'a'.repeat(64)}`, `${TOKEN_AB}x`, TOKEN_AB.toUpperCase()]) {
      expect(isMigrationApprovalToken(bad)).toBe(false);
    }
    expect(readMigrationApproval({})).toBeNull();
    expect(readMigrationApproval({ CREWFLOW_MIGRATION_APPROVED: '  ' })).toBeNull();
    expect(readMigrationApproval({ CREWFLOW_MIGRATION_APPROVED: ` ${TOKEN_AB} ` })).toBe(TOKEN_AB);
  });

  it('the apply gate accepts only the token of the set pending NOW; stale, other-set, malformed and the retired constant are refused with the token to use', () => {
    expect(() => assertMigrationApproval(TOKEN_AB, PENDING_AB)).not.toThrow();
    const refusalOf = (approval: string, pending: readonly string[]): string => {
      try {
        assertMigrationApproval(approval, pending);
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationApprovalError);
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    const next = [...PENDING_AB, 'AddMore1786000000003'];
    const nextToken = migrationApprovalToken(next);
    // A token left over from the previous release (it approved PENDING_AB) does not approve the next release's set.
    const stale = refusalOf(TOKEN_AB, next);
    expect(stale).toMatch(/approves a different set of migrations than the one pending now/);
    expect(stale).toContain('3 pending: AddThing1786000000001, AddOther1786000000002, AddMore1786000000003.');
    expect(stale).toContain(`CREWFLOW_MIGRATION_APPROVED=${nextToken} for this one run`);
    expect(stale).toMatch(/Nothing was applied\. Refusing\.$/);
    // A token for a subset or a superset is another set.
    expect(refusalOf(migrationApprovalToken(PENDING_AB.slice(0, 1)), PENDING_AB)).toMatch(/approves a different set/);
    expect(refusalOf(nextToken, PENDING_AB)).toMatch(/approves a different set/);
    // The retired standing constant: refused whatever is pending (also when nothing is), with the token to use.
    const legacy = refusalOf(LEGACY_MIGRATION_APPROVAL, PENDING_AB);
    expect(legacy).toMatch(/apply-pending-migrations is no longer accepted: a standing approval approved every later release \(final review F5\)/);
    expect(legacy).toContain(`CREWFLOW_MIGRATION_APPROVED=${TOKEN_AB} for this one run`);
    expect(legacy).toMatch(/Nothing was applied\. Refusing\.$/);
    expect(refusalOf(LEGACY_MIGRATION_APPROVAL, [])).toMatch(/no longer accepted.*Nothing is pending: remove CREWFLOW_MIGRATION_APPROVED\./);
    // Malformed: refused, and the value itself is never echoed.
    const malformed = refusalOf('approve-it-please', PENDING_AB);
    expect(malformed).toMatch(/is not a migration approval token/);
    expect(malformed).toContain(TOKEN_AB);
    expect(malformed).not.toContain('approve-it-please');
    expect(refusalOf('yes', [])).toMatch(/not a migration approval token/);
    // Nothing pending: a well-formed token approves nothing and passes (a second run that waited behind the first).
    expect(() => assertMigrationApproval(TOKEN_AB, [])).not.toThrow();
  });

  it('a long pending set is summarised in the refusal (the check run lists every name)', () => {
    const many = Array.from({ length: 25 }, (_, i) => `Step${i}17860000000${String(i).padStart(2, '0')}`);
    expect(describePendingSet(many)).toMatch(/^25 pending: Step0\d+, .*, … \(\+15 more; the check run lists them all\)$/);
    expect(describePendingSet([])).toBe('nothing is pending');
  });
});

/**
 * deployPrepare's decision flow with a fake locked runner that behaves like the real one: the gates (approvePending
 * included) run "after the lock" on the pending set it holds, and only then is anything applied (post-checks are not part of
 * this fake; they have their own specs). The real runner's ordering (approval as the last gate before MigrationExecutor) is
 * exercised against the disposable cluster by src/__tests__/integration/migration-approval.integration.spec.ts.
 */
describe('final review F5: deploy-prepare check run prints the set and its token; the apply run applies only the approved set', () => {
  function fakeRunner(pendingNow: string[]) {
    const applied: string[] = [];
    const calls: LockedMigrationOptions[] = [];
    const runner = (async (options: LockedMigrationOptions): Promise<LockedMigrationResult> => {
      calls.push(options);
      const pendingBefore = [...pendingNow];
      if (options.mode === 'apply') {
        options.approvePending?.(pendingBefore);
        applied.push(...pendingBefore);
      }
      return { target: 'production', pendingBefore, applied: [...applied], waitedMs: 0, currentUser: 'crewflow_migrator' };
    }) as typeof runLockedMigrations;
    return { runner, applied, calls };
  }
  const run = (env: Record<string, string>, pendingNow: string[]) => {
    const fake = fakeRunner(pendingNow);
    const lines: string[] = [];
    const result = deployPrepare({ env: { ...env }, argv: [], log: (l) => lines.push(l), runner: fake.runner, cacheFlush: async () => undefined });
    return { result, lines, ...fake };
  };

  it('no approval: check mode, exit 3 with every pending name and the token for exactly that set; nothing applied', async () => {
    const r = run({}, PENDING_AB);
    await expect(r.result).resolves.toBe(EXIT_PENDING_NOT_APPROVED);
    expect(r.calls[0].mode).toBe('check');
    expect(r.calls[0].approvePending).toBeUndefined();
    expect(r.applied).toEqual([]);
    expect(r.lines).toEqual(
      expect.arrayContaining([`  pending: ${PENDING_AB[0]}`, `  pending: ${PENDING_AB[1]}`, `approval token for exactly this set: ${TOKEN_AB}`]),
    );
    // Nothing pending: exit 0, no token.
    const current = run({}, []);
    await expect(current.result).resolves.toBe(0);
    expect(current.lines.join('\n')).not.toMatch(/approval token/);
  });

  it('the token printed by the check run applies exactly that set', async () => {
    const r = run({ CREWFLOW_MIGRATION_APPROVED: TOKEN_AB }, PENDING_AB);
    await expect(r.result).resolves.toBe(0);
    expect(r.calls[0].mode).toBe('apply');
    expect(r.applied).toEqual(PENDING_AB);
  });

  it('a stale approval (previous release), an approval for another set, a malformed value and the retired constant: refused (exit 1), nothing applied', async () => {
    const next = [...PENDING_AB, 'AddMore1786000000003'];
    for (const approval of [TOKEN_AB, migrationApprovalToken(['SomethingElse1786000000009']), 'yes', LEGACY_MIGRATION_APPROVAL]) {
      const r = run({ CREWFLOW_MIGRATION_APPROVED: approval }, next);
      await expect(r.result).rejects.toBeInstanceOf(MigrationApprovalError);
      expect(r.applied).toEqual([]);
    }
    // The set changed between the check run and the apply run: refused.
    const changed = run({ CREWFLOW_MIGRATION_APPROVED: TOKEN_AB }, PENDING_AB.slice(1));
    await expect(changed.result).rejects.toThrow(/approves a different set/);
    expect(changed.applied).toEqual([]);
  });

  it('an approval with nothing pending applies nothing and warns that it must be removed; the retired constant is refused even then', async () => {
    const r = run({ CREWFLOW_MIGRATION_APPROVED: TOKEN_AB }, []);
    await expect(r.result).resolves.toBe(0);
    expect(r.lines.join('\n')).toMatch(/is set but nothing is pending, so it approved nothing\. Remove it/);
    await expect(run({ CREWFLOW_MIGRATION_APPROVED: LEGACY_MIGRATION_APPROVAL }, []).result).rejects.toThrow(/no longer accepted/);
  });
});
