/**
 * Phase B (P7) — unit rules of the one-off migration process: URL resolution, lock parameters, deploy-prepare's extra identity
 * and phase rules, the cache-flush allow-list, and the migrator role password verifier. The live behaviour (lock contention,
 * killed holder, gates after the lock) is exercised against a disposable cluster by the B6-A verification script; the cache
 * flush against a real Redis is in entity-cache-flush.integration.spec.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { assertMigrationPhase, cacheFlushRequest } from '../deploy-prepare';
import { readSetupDbDotenvSources, setupDbApprovalRefusal } from '../setup-db';
import { assertDisposableCluster, disposableAdminUrl, DISPOSABLE_MARKER_SQL, MigratorRoleSetupError, scramSha256Verifier } from '../setup/migrator-role';
import { assertCacheEnvName, assertFlushableNamespace, entityCacheBaseOf } from './entity-cache-flush';
import { assertIdentityCanMigrate, redactConnectionStrings, runLockedMigrations } from './locked-migration-runner';
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
      /setup-db with DB_TARGET=production applies pending migrations only with CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations .*Refusing\./,
    );
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'yes' })).toMatch(/Refusing/);
    expect(setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' })).toBeNull();
    // An approval sitting in a .env file is a standing approval: refused even when the process environment repeats it.
    expect(
      setupDbApprovalRefusal({ DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }, { CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }),
    ).toMatch(/present in a \.env file/);
    for (const DB_TARGET of ['local', 'test', undefined]) expect(setupDbApprovalRefusal({ DB_TARGET })).toBeNull();
  });

  it('L-2 follow-up: an approval in ANY dotenv source that can reach setup-db is refused — cwd .env, DOTENV_CONFIG_PATH / dotenv_config_path=, packages/rab-server/.env (Nx)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crewflow-setup-db-'));
    try {
      const prodEnv = { DB_TARGET: 'production', CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' };
      const approval = 'CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations\n';
      const none = () => ({});
      // Nothing anywhere: the process-environment approval proceeds.
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, [], dir, none))).toBeNull();
      // packages/rab-server/.env (what Nx injects; read as data through database-target.ts readDotenvValues).
      expect(setupDbApprovalRefusal(prodEnv, readSetupDbDotenvSources({}, [], dir, () => ({ CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' })))).toMatch(
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
    expect(template).toMatch(/^#\s*CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations$/m);
  });
});
