/**
 * Owner-login lifecycle (PR 3): the pure decisions, database-free. The live behaviour (bootstrap, phases, shim, races,
 * kill points, golden equivalence on PostgreSQL 16 and 18) is exercised on disposable clusters by
 * scripts/migration-security-check.ts (scenario owner-login) and owner-login-lifecycle-check.ts.
 */
import type { QueryRunner } from 'typeorm';

import {
  EXPECTED_WORKSPACE_FINGERPRINTS,
  EXPECTED_WORKSPACE_FINGERPRINTS_PG16,
  missingFingerprintVersions,
  postgresMajorOf,
  resetWorkspaceFingerprintSelectionForTests,
  selectWorkspaceFingerprintMajor,
  UnsupportedPostgresVersionError,
  workspaceFingerprintMajor,
} from '../../../workspace-schema/v1/expected-fingerprints';
import { approvalDecision, selectFingerprintsForRun } from '../locked-migration-runner';
import { BOOTSTRAP_ROLES, isRoleRace, RoleFacts, roleShapeProblems } from './bootstrap';
import { CatalogFacts, classifyDatabase, decideFreshInstall } from './fresh-install';
import { blockingPostCheckProblems, codeMigrationNames, deriveOwnerLoginGuardEnv, outcomeOf, readTestSeams, synthesiseGuardEnv } from './migrate-on-start';
import { deployPrepareFailureExitCode } from '../../deploy-prepare';
import { Migration } from 'typeorm/migration/Migration';

import { LAST_ROLE_MIGRATION_TIMESTAMP, needsCoreCreateWindow, needsSplitReassignWindow, ROLE_SPLIT_TIMESTAMP, selectPhaseBMigration } from './owner-login-chain';
import { TENANT_EVIDENCE_SQL } from './fresh-install';
import { assertOwnerLoginMigrationIdentity, OwnerLoginIdentityFacts } from './owner-login-identity';
import {
  AI_ASSISTANT_ROUND_ONLY_MIGRATION,
  AI_PROPOSAL_ACTIVATE_MIGRATION,
  PRIVILEGED_COPY_MIGRATION,
  RowCopyShimRefusal,
  SHIMMED_MIGRATIONS,
  shimMigrationInstance,
  shimQueryRunner,
} from './row-copy-shim';
import { assessUpgradeFailure } from './upgrade-failure-policy';
import { assertDeploymentIdentity, MARKER_PRESENT_SQL, MARKER_READ_SQL } from '../../../../deployment-identity/deployment-identity';

const spec = (name: string) => BOOTSTRAP_ROLES.find((r) => r.name === name)!;
const role = (name: string, over: Partial<RoleFacts> = {}): RoleFacts => ({
  name,
  super: false,
  bypassrls: false,
  replication: false,
  createrole: false,
  createdb: false,
  login: spec(name).login,
  inherit: true,
  members: [],
  memberOf: [],
  ...over,
});
const ownerRows = [
  { member: 'crewflow_owner', admin: true, inherit: false, set: false }, // implicit ADMIN row (creator)
  { member: 'crewflow_owner', admin: false, inherit: true, set: true },
];

describe('bootstrap: pre-existing roles must have exactly the bootstrap shape', () => {
  it('accepts the shapes the bootstrap itself produces', () => {
    for (const r of ['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow']) expect(roleShapeProblems(spec(r), role(r, { members: ownerRows }))).toEqual([]);
    expect(
      roleShapeProblems(
        spec('crewflow_app'),
        role('crewflow_app', { members: [{ member: 'crewflow_owner', admin: true, inherit: false, set: false }, { member: 'crewflow_worker', admin: false, inherit: true, set: false }] }),
      ),
    ).toEqual([]);
    expect(roleShapeProblems(spec('crewflow_worker'), role('crewflow_worker', { memberOf: [{ role: 'crewflow_app', admin: false, inherit: true, set: false }] }))).toEqual([]);
  });

  it('refuses wrong attributes, LOGIN, extra members and memberships, and roles it cannot adopt', () => {
    const p = (r: string, over: Partial<RoleFacts>) => roleShapeProblems(spec(r), role(r, { members: ownerRows, ...over })).join(' | ');
    expect(p('rab_owner', { super: true })).toMatch(/SUPERUSER/);
    expect(p('rab_owner', { bypassrls: true })).toMatch(/BYPASSRLS/);
    expect(p('rab_secure_owner', { login: true })).toMatch(/is LOGIN/);
    expect(p('crewflow', { login: false })).toMatch(/is NOLOGIN/);
    expect(p('crewflow', { createrole: true })).toMatch(/CREATEROLE/);
    expect(p('rab_owner', { members: [...ownerRows, { member: 'evil', admin: false, inherit: true, set: true }] })).toMatch(/unexpected member evil/);
    expect(p('rab_owner', { memberOf: [{ role: 'pg_read_all_data', admin: false, inherit: true, set: true }] })).toMatch(/is a member of pg_read_all_data/);
    // Created by someone else (a superuser): crewflow_owner is not a member and cannot adopt it.
    expect(roleShapeProblems(spec('rab_owner'), role('rab_owner')).join()).toMatch(/is not a member/);
    // crewflow_worker must have ZERO members (B3) and exactly its crewflow_app membership.
    expect(
      roleShapeProblems(spec('crewflow_worker'), role('crewflow_worker', { members: [{ member: 'crewflow_owner', admin: true, inherit: false, set: false }], memberOf: [{ role: 'crewflow_app', admin: false, inherit: true, set: false }] })).join(),
    ).toMatch(/must have none/);
    expect(roleShapeProblems(spec('crewflow_worker'), role('crewflow_worker', { memberOf: [{ role: 'crewflow_app', admin: false, inherit: true, set: true }] })).join()).toMatch(/wrong options/);
    expect(roleShapeProblems(spec('crewflow_app'), role('crewflow_app', { members: ownerRows })).join()).toMatch(/INHERIT or SET/);
  });

  it('a lost CREATE ROLE race is recognised (42710 / 23505), nothing else', () => {
    expect(isRoleRace({ code: '42710' })).toBe(true);
    expect(isRoleRace({ driverError: { code: '23505' } })).toBe(true);
    expect(isRoleRace({ code: '42501' })).toBe(false);
  });
});

const facts = (over: Partial<CatalogFacts> = {}): CatalogFacts => ({
  coreExists: false,
  coreOwner: null,
  coreRelations: 0,
  hasLedger: false,
  workspaceSchemas: 0,
  otherSchemas: [],
  publicForeignObjects: 0,
  ...over,
});
const CODE = ['A1786000000001', 'B1786000000002', 'C1786000000003'];

describe('classifier: EMPTY / BOOTSTRAP-PARTIAL / CHAIN-PARTIAL / CURRENT / AHEAD / FOREIGN', () => {
  it('each state', () => {
    expect(classifyDatabase(facts(), CODE, []).state).toBe('EMPTY');
    expect(classifyDatabase(facts({ coreExists: true, coreOwner: 'rab_owner' }), CODE, []).state).toBe('BOOTSTRAP-PARTIAL');
    expect(classifyDatabase(facts({ coreExists: true, hasLedger: true }), CODE, ['A1786000000001']).state).toBe('CHAIN-PARTIAL');
    expect(classifyDatabase(facts({ coreExists: true, hasLedger: true }), CODE, CODE).state).toBe('CURRENT');
    expect(classifyDatabase(facts({ coreExists: true, hasLedger: true }), CODE, [...CODE, 'D1786000000009']).state).toBe('AHEAD');
  });

  it('FOREIGN: other schemas, public objects, a foreign core, an interleaved or non-linear ledger', () => {
    expect(classifyDatabase(facts({ otherSchemas: ['metadata'] }), CODE, []).state).toBe('FOREIGN');
    expect(classifyDatabase(facts({ publicForeignObjects: 3 }), CODE, []).state).toBe('FOREIGN');
    expect(classifyDatabase(facts({ workspaceSchemas: 1 }), CODE, []).state).toBe('FOREIGN');
    // Twenty's own `core` schema (owned by someone else, full of tables, no Crewflow ledger).
    expect(classifyDatabase(facts({ coreExists: true, coreOwner: 'twenty', coreRelations: 40 }), CODE, []).state).toBe('FOREIGN');
    expect(classifyDatabase(facts({ coreExists: true, coreOwner: 'rab_owner', coreRelations: 1 }), CODE, []).state).toBe('FOREIGN');
    expect(classifyDatabase(facts({ coreExists: true, hasLedger: true }), CODE, ['A1786000000001', 'X1786000000002']).state).toBe('FOREIGN');
    expect(classifyDatabase(facts({ coreExists: true, hasLedger: true }), CODE, ['A1786000000001', 'D1786000000009']).state).toBe('FOREIGN');
  });
});

describe('fresh-install proof: physical, independent of RLS', () => {
  const ok = { organisationBytes: 0, workspaceBytes: '0', registryBytes: 0, workspaceSchemas: 0, bootstrapRoles: true };
  it('EMPTY / BOOTSTRAP-PARTIAL / CHAIN-PARTIAL with no tenant data ever written', () => {
    for (const s of ['EMPTY', 'BOOTSTRAP-PARTIAL', 'CHAIN-PARTIAL'] as const) expect(decideFreshInstall(s, ok).fresh).toBe(true);
  });
  it('refused on any page, any workspace schema, a finished database or a separated-built chain', () => {
    expect(decideFreshInstall('CHAIN-PARTIAL', { ...ok, organisationBytes: '8192' }).fresh).toBe(false);
    expect(decideFreshInstall('CHAIN-PARTIAL', { ...ok, workspaceBytes: 8192 }).fresh).toBe(false);
    expect(decideFreshInstall('CHAIN-PARTIAL', { ...ok, registryBytes: 8192 }).fresh).toBe(false);
    expect(decideFreshInstall('CHAIN-PARTIAL', { ...ok, workspaceSchemas: 1 }).fresh).toBe(false);
    expect(decideFreshInstall('CHAIN-PARTIAL', { ...ok, bootstrapRoles: false }).fresh).toBe(false);
    for (const s of ['CURRENT', 'AHEAD', 'FOREIGN'] as const) expect(decideFreshInstall(s, ok).fresh).toBe(false);
  });
});

describe('owner-login migration identity: exactly crewflow_owner, nothing privileged reachable', () => {
  const good: OwnerLoginIdentityFacts = {
    sessionUser: 'crewflow_owner',
    currentUser: 'crewflow_owner',
    super: false,
    bypassrls: false,
    replication: false,
    createrole: true,
    reachable: ['rab_owner', 'rab_app', 'rab_secure_owner', 'crewflow', 'crewflow_app'].map((r) => ({ role: r, super: false, bypassrls: false, replication: false })),
  };
  it('accepts the M0 §5.1 shape', () => {
    expect(() => assertOwnerLoginMigrationIdentity(good, { needCreateRole: true })).not.toThrow();
    expect(() => assertOwnerLoginMigrationIdentity({ ...good, createrole: false }, { needCreateRole: false })).not.toThrow();
  });
  it('refuses another login, SET ROLE, SUPERUSER, BYPASSRLS, REPLICATION, missing CREATEROLE, and every privileged reach (ADMIN edges included)', () => {
    const bad = (over: Partial<OwnerLoginIdentityFacts>, re: RegExp, needCreateRole = false) =>
      expect(() => assertOwnerLoginMigrationIdentity({ ...good, ...over }, { needCreateRole })).toThrow(re);
    bad({ sessionUser: 'postgres', currentUser: 'postgres' }, /not crewflow_owner/);
    bad({ currentUser: 'rab_secure_owner' }, /SET ROLE/);
    bad({ super: true }, /SUPERUSER/);
    bad({ bypassrls: true }, /BYPASSRLS/);
    bad({ replication: true }, /REPLICATION/);
    bad({ createrole: false }, /CREATEROLE/, true);
    bad({ reachable: [...good.reachable, { role: 'neon_superuser', super: false, bypassrls: true, replication: true }] }, /neon_superuser/);
    bad({ reachable: [...good.reachable, { role: 'pg_write_all_data', super: false, bypassrls: false, replication: false }] }, /predefined role pg_write_all_data/);
    bad({ reachable: [...good.reachable, { role: 'crewflow_worker', super: false, bypassrls: false, replication: false }] }, /crewflow_worker is reachable/);
  });
  it('CREATEROLE is needed through the last role migration only', () => {
    expect(LAST_ROLE_MIGRATION_TIMESTAMP).toBeGreaterThan(ROLE_SPLIT_TIMESTAMP);
    expect(ROLE_SPLIT_TIMESTAMP).toBe(1786682000000);
  });
});

/** A fake QueryRunner recording what reaches the database; pg_relation_size answers `bytes`. */
function fakeRunner(bytes: number) {
  const executed: string[] = [];
  const runner = {
    query: async (sql: string) => {
      executed.push(sql.replace(/\s+/g, ' ').trim());
      if (/pg_relation_size/.test(sql)) return [{ bytes, workspaceBytes: bytes, registryBytes: bytes, workspaceSchemas: 0 }];
      return [{ n: 0 }];
    },
    isTransactionActive: true,
  } as unknown as QueryRunner;
  return { runner, executed };
}

describe('D3(b) ROW_COPY shim: exactly three migrations, exact windows, physical emptiness proof', () => {
  it('the closed table', () => {
    expect([...SHIMMED_MIGRATIONS].sort()).toEqual([AI_ASSISTANT_ROUND_ONLY_MIGRATION, AI_PROPOSAL_ACTIVATE_MIGRATION, PRIVILEGED_COPY_MIGRATION].sort());
    expect(() => shimQueryRunner(fakeRunner(0).runner, 'SomethingElse1786000000000')).toThrow(RowCopyShimRefusal);
    expect(() => shimMigrationInstance('SomethingElse1786000000000', { up: async () => undefined, down: async () => undefined })).toThrow(RowCopyShimRefusal);
  });

  it('1786720960000: row_security = off is replaced by the size proof; the count runs unchanged, RLS-bound', async () => {
    const { runner, executed } = fakeRunner(0);
    const shim = shimQueryRunner(runner, AI_PROPOSAL_ACTIVATE_MIGRATION);
    await shim.runner.query('SET LOCAL row_security = off');
    await shim.runner.query('SELECT count(*)::int AS n FROM core.ai_action_proposal ');
    await shim.runner.query('SET LOCAL row_security = on');
    await shim.runner.query('ALTER TABLE core.ai_action_proposal ADD COLUMN x int');
    shim.finish();
    expect(executed).toEqual([
      'SELECT pg_catalog.pg_relation_size($1::regclass)::bigint AS "bytes"',
      'SELECT count(*)::int AS n FROM core.ai_action_proposal',
      'SET LOCAL row_security = on',
      'ALTER TABLE core.ai_action_proposal ADD COLUMN x int',
    ]);
    expect(executed.some((s) => /row_security = off/.test(s))).toBe(false);
  });

  it('1786720990000: both windows (the UPDATE and the shape count)', async () => {
    const { runner, executed } = fakeRunner(0);
    const shim = shimQueryRunner(runner, AI_ASSISTANT_ROUND_ONLY_MIGRATION);
    for (const stmt of [
      'SET LOCAL row_security = off',
      "UPDATE core.organisation_ai_assistant SET shape = 'circle' WHERE shape <> 'circle'",
      'SET LOCAL row_security = on',
      'ALTER TABLE core.organisation_ai_assistant DROP CONSTRAINT organisation_ai_assistant_shape_check',
      'SET LOCAL row_security = off',
      'SELECT count(*)::int AS n FROM core.organisation_ai_assistant WHERE shape <> ALL($1::text[])',
      'SET LOCAL row_security = on',
    ]) {
      await shim.runner.query(stmt);
    }
    shim.finish();
    expect(executed.filter((s) => /pg_relation_size/.test(s))).toHaveLength(2);
    expect(executed.some((s) => /row_security = off/.test(s))).toBe(false);
  });

  it('refuses: a table with any page, an unreviewed statement in a window, an unreviewed row_security statement, an unconsumed window', async () => {
    const full = shimQueryRunner(fakeRunner(8192).runner, AI_PROPOSAL_ACTIVATE_MIGRATION);
    await expect(full.runner.query('SET LOCAL row_security = off')).rejects.toThrow(/has data pages/);

    const wrong = shimQueryRunner(fakeRunner(0).runner, AI_PROPOSAL_ACTIVATE_MIGRATION);
    await wrong.runner.query('SET LOCAL row_security = off');
    await expect(wrong.runner.query('DELETE FROM core.ai_action_proposal')).rejects.toThrow(/unreviewed statement/);

    const session = shimQueryRunner(fakeRunner(0).runner, AI_PROPOSAL_ACTIVATE_MIGRATION);
    await expect(session.runner.query('SET row_security = off')).rejects.toThrow(/unreviewed row_security/);

    const short = shimQueryRunner(fakeRunner(0).runner, AI_ASSISTANT_ROUND_ONLY_MIGRATION);
    expect(() => short.finish()).toThrow(/0 of 2/);
  });

  it('1786719520000 is recorded only with the no-workspace proof; its body never runs; down() is refused', async () => {
    let ran = false;
    const instance = { up: async () => void (ran = true), down: async () => undefined };
    const wrapped = shimMigrationInstance(PRIVILEGED_COPY_MIGRATION, instance);
    await wrapped.up(fakeRunner(0).runner);
    expect(ran).toBe(false);
    await expect(wrapped.up(fakeRunner(8192).runner)).rejects.toThrow(/not a provable no-op/);
    await expect(wrapped.down(fakeRunner(0).runner)).rejects.toThrow(/not available/);
  });
});

describe('D4: workspace fingerprints selected by server major; PG16 unchanged', () => {
  afterEach(() => resetWorkspaceFingerprintSelectionForTests());
  it('nothing selected = the unchanged PostgreSQL 16 table', () => {
    expect(workspaceFingerprintMajor()).toBe(16);
    expect(EXPECTED_WORKSPACE_FINGERPRINTS[19]).toBe('b2afa389eec7c5fb0a304ace57cb39d813bb5b6ac044be2387d4e67f804655c3');
    expect(Object.entries(EXPECTED_WORKSPACE_FINGERPRINTS)).toEqual(Object.entries(EXPECTED_WORKSPACE_FINGERPRINTS_PG16));
  });
  it('18 selects the PG18 table; 17, 19 and below 16 are refused; a second, different major is refused', () => {
    selectWorkspaceFingerprintMajor(18);
    expect(workspaceFingerprintMajor()).toBe(18);
    expect(EXPECTED_WORKSPACE_FINGERPRINTS[19]).toBe('af115ec7490665c7df38fbc78128e95e680e59764bb626e4c21d0c061fe699e6');
    expect(missingFingerprintVersions(18)).toEqual([]);
    expect(() => selectWorkspaceFingerprintMajor(16)).toThrow(/cannot switch/);
    resetWorkspaceFingerprintSelectionForTests();
    expect(() => selectWorkspaceFingerprintMajor(17)).toThrow(UnsupportedPostgresVersionError);
    expect(() => selectWorkspaceFingerprintMajor(19)).toThrow(/not supported/);
    expect(() => selectWorkspaceFingerprintMajor(15)).toThrow(/refused/);
  });
  it('server_version_num parsing; the runner is strict for the owner login and lenient for the legacy path', () => {
    expect(postgresMajorOf('160015')).toBe(16);
    expect(postgresMajorOf(180006)).toBe(18);
    expect(() => postgresMajorOf('16.4')).toThrow();
    expect(() => selectFingerprintsForRun('150008', true, () => undefined)).toThrow(/refused/);
    // PG18 is supported, but until its fingerprints are generated and committed the owner login refuses it up front.
    if (missingFingerprintVersions(18).length) expect(() => selectFingerprintsForRun('180006', true, () => undefined)).toThrow(/no generated workspace fingerprints/);
    expect(missingFingerprintVersions(16)).toEqual([]);
    resetWorkspaceFingerprintSelectionForTests();
    const lines: string[] = [];
    expect(selectFingerprintsForRun('170002', false, (l) => lines.push(l))).toBe(17);
    expect(lines.join()).toMatch(/no reviewed workspace fingerprints/);
    expect(workspaceFingerprintMajor()).toBe(16);
  });
});

describe('migrate-on-start child: guard environment, post-check tolerance, outcome mapping', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  it('the target authority is synthesised in memory: production only for CREWFLOW_DEPLOYMENT_ENVIRONMENT=production', () => {
    const dev = synthesiseGuardEnv({ DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' }, 'absent', 'crewflow', ID);
    expect(dev.guardEnv.DB_TARGET).toBe('local');
    expect(dev.guardEnv.ALLOW_PRODUCTION_DB_COMMANDS).toBeUndefined();
    const fresh = synthesiseGuardEnv({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' }, 'absent', 'crewflow', ID);
    expect(fresh.guardEnv).toMatchObject({
      DB_TARGET: 'production',
      ALLOW_PRODUCTION_DB_COMMANDS: 'true',
      CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database',
      PG_EXPECTED_DATABASE_NAME: 'crewflow',
      CREWFLOW_DEPLOYMENT_ID: ID,
    });
    expect(fresh.generatedDeploymentId).toBe(ID);
    // Bound: never the bootstrap flag, never a generated id (D6: mandatory once bound; the guard refuses it missing).
    const bound = synthesiseGuardEnv({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' }, 'bound', 'crewflow', ID);
    expect(bound.guardEnv.CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP).toBeUndefined();
    expect(bound.guardEnv.CREWFLOW_DEPLOYMENT_ID).toBeUndefined();
    expect(bound.generatedDeploymentId).toBeNull();
  });

  it('AHEAD tolerates only the newer-code findings (C-1); everything else blocks', () => {
    const problems = ['schema-compatibility provision-function-ahead: x', 'schema-compatibility workspace-ahead: y', 'rls-disabled core.shift'];
    expect(blockingPostCheckProblems('AHEAD', problems)).toEqual({ blocking: ['rls-disabled core.shift'], warnings: problems.slice(0, 2) });
    expect(blockingPostCheckProblems('CURRENT', problems).blocking).toEqual(problems);
  });

  it('error → startup outcome', () => {
    const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });
    expect(outcomeOf(named('RuntimeDbConfigError'))).toBe('config');
    expect(outcomeOf(named('UnsupportedPostgresVersionError'))).toBe('config');
    expect(outcomeOf(named('MigrationLockError'))).toBe('lockTimeout');
    for (const n of ['OwnerLoginIdentityError', 'DatabaseStateError', 'BootstrapRefusal', 'DeploymentIdentityError', 'DbTargetError']) expect(outcomeOf(named(n))).toBe('identity');
    expect(outcomeOf(named('UnapprovedProductionMigrationError'))).toBe('behind');
    expect(outcomeOf(named('PostCheckFailure'))).toBe('postCheck');
    expect(outcomeOf(named('QueryFailedError'))).toBe('migrationFailed');
    expect(outcomeOf(named('RowCopyShimRefusal'))).toBe('migrationFailed');
  });
});

describe('upgrade-failure policy', () => {
  const base = { failedMigration: null, expectedMigrations: CODE, production: true, query: async () => [] };
  it('a first-install failure never serves; refuse never serves; neither runs a check', async () => {
    const fresh = await assessUpgradeFailure({ ...base, policy: 'continue-if-compatible', freshInstall: true });
    expect(fresh).toMatchObject({ serve: false, checks: [] });
    const refuse = await assessUpgradeFailure({ ...base, policy: 'refuse', freshInstall: false });
    expect(refuse).toMatchObject({ serve: false, checks: [] });
  });

  it('continue-if-compatible: fails closed while the posture monitor or the identity check is absent, and on a partial transaction=false migration', async () => {
    const v = await assessUpgradeFailure({ ...base, policy: 'continue-if-compatible', freshInstall: false, failedMigration: 'StatementDispatchPointer1786721320000' });
    expect(v.serve).toBe(false);
    const byName = Object.fromEntries(v.checks.map((c) => [c.name, c.ok]));
    expect(byName).toMatchObject({ 'no-partial-migration': false, posture: false, 'deployment-identity': false });
    expect(v.checks.map((c) => c.name)).toEqual(['ledger-compatible', 'no-partial-migration', 'post-checks', 'required-functions', 'deployment-identity', 'posture']);
  });
});

describe('test seams (Agent 5): honoured only on a disposable test database outside production', () => {
  const ok = { production: false, disposableTestDatabase: true };
  it('unset = no seam; set = parsed', () => {
    expect(readTestSeams({}, { production: true, disposableTestDatabase: false })).toEqual({ failAt: null, stopBefore: null });
    expect(
      readTestSeams({ NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'StatementDispatchPointer1786721320000', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '1786721350000' }, ok),
    ).toEqual({ failAt: 'StatementDispatchPointer1786721320000', stopBefore: 1786721350000 });
  });
  it('refused (exit 64) outside NODE_ENV=test, in production, on a non-disposable database, or malformed', () => {
    const seam = { CREWFLOW_MIGRATION_TEST_FAIL_AT: 'StatementDispatchPointer1786721320000' };
    expect(() => readTestSeams({ ...seam, NODE_ENV: 'development' }, ok)).toThrow(/test seams/);
    expect(() => readTestSeams({ ...seam, NODE_ENV: 'test' }, { production: true, disposableTestDatabase: true })).toThrow(/never production/);
    expect(() => readTestSeams({ ...seam, NODE_ENV: 'test' }, { production: false, disposableTestDatabase: false })).toThrow(/disposable/);
    expect(() => readTestSeams({ NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'DROP TABLE x' }, ok)).toThrow(/class name/);
    expect(() => readTestSeams({ NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '17867' }, ok)).toThrow(/13-digit/);
    const named = (name: string) => Object.assign(new Error('x'), { name });
    expect(outcomeOf(named('TestSeamRefusal'))).toBe('config');
    expect(outcomeOf(named('InjectedMigrationFailure'))).toBe('migrationFailed');
  });
});

describe('deploy-prepare failure exit codes are the startup exit codes', () => {
  const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });
  it('maps each kind; post-check failures are 68', () => {
    expect(deployPrepareFailureExitCode(new Error('post-migration checks failed (1): rls-disabled core.x'))).toBe(68);
    expect(deployPrepareFailureExitCode(named('MigrationLockError'))).toBe(69);
    expect(deployPrepareFailureExitCode(named('MigrationIdentityError'))).toBe(67);
    expect(deployPrepareFailureExitCode(named('MigrationApprovalError'))).toBe(65);
    expect(deployPrepareFailureExitCode(named('PgConfigError'))).toBe(64);
    expect(deployPrepareFailureExitCode(named('QueryFailedError'))).toBe(66);
  });
});

describe('the code migration list read from the files (the assessment of a run that failed before classifying)', () => {
  it('class names in timestamp order, the gated 1786721330000 never among them', () => {
    const names = codeMigrationNames();
    expect(names.length).toBeGreaterThanOrEqual(250);
    expect(names).toContain('HwsHistoricalRowsPrivilegedCopy1786719520000');
    expect(names).toContain('CrewflowSingleCredentialRoleArchitecture1786682000000');
    expect(names.some((n) => n.endsWith('1786721330000'))).toBe(false);
    const ts = names.map((n) => Number(n.slice(-13)));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});

describe('regressions found by CI on PR #71', () => {
  it('the tenant evidence never hands a literal relation name to pg_relation_size (planned as regclass: 42P01 on EMPTY)', () => {
    expect(TENANT_EVIDENCE_SQL).not.toMatch(/pg_relation_size\('core\./);
    expect(TENANT_EVIDENCE_SQL.match(/pg_relation_size\(pg_catalog\.to_regclass\('core\.[a-z_]+'\)\)/g)).toHaveLength(3);
  });

  it('phase B passes an ALREADY-APPLIED ROW_COPY migration through on a non-fresh database (transition), and still refuses a pending one', () => {
    const instance = { name: PRIVILEGED_COPY_MIGRATION, up: async () => undefined, down: async () => undefined };
    const m = new Migration(undefined, 1786719520000, PRIVILEGED_COPY_MIGRATION, instance);
    const shimmed: string[] = [];
    expect(selectPhaseBMigration(m, { pending: new Set(['Other1786721350000']), freshInstall: false, shimmed })).toBe(m);
    expect(() => selectPhaseBMigration(m, { pending: new Set([PRIVILEGED_COPY_MIGRATION]), freshInstall: false, shimmed })).toThrow(/proven fresh install/);
    const wrapped = selectPhaseBMigration(m, { pending: new Set([PRIVILEGED_COPY_MIGRATION]), freshInstall: true, shimmed });
    expect(wrapped).not.toBe(m);
    expect(shimmed).toEqual([PRIVILEGED_COPY_MIGRATION]);
    expect(selectPhaseBMigration(new Migration(undefined, 1786681000000, 'PhaseA1786681000000', instance), { pending: new Set(), freshInstall: true, shimmed })).toBeNull();
  });
});

describe('regression found by the PG16 lifecycle run: the pre-0b CREATE window follows the ledger, not the loaded set', () => {
  it('open while Phase 0b is not applied and rab_secure_owner lacks CREATE; closed otherwise', () => {
    expect(needsCoreCreateWindow({ phase0bApplied: false, secureOwnerHasCreate: false })).toBe(true);
    expect(needsCoreCreateWindow({ phase0bApplied: false, secureOwnerHasCreate: true })).toBe(false);
    expect(needsCoreCreateWindow({ phase0bApplied: true, secureOwnerHasCreate: false })).toBe(false);
  });
});

describe('regression found by the PG16 BOOTSTRAP-PARTIAL run: the role split REASSIGN is made order-independent', () => {
  it('crewflow gets CREATE on core before the split only (the split grants it itself; Phase 0b removes it)', () => {
    expect(needsSplitReassignWindow({ roleSplitApplied: false, crewflowHasCreate: false })).toBe(true);
    expect(needsSplitReassignWindow({ roleSplitApplied: false, crewflowHasCreate: true })).toBe(false);
    expect(needsSplitReassignWindow({ roleSplitApplied: true, crewflowHasCreate: false })).toBe(false);
  });
});

describe('regression found by the PG16 three-replica run: a waiting run never blocks in pg_advisory_lock', () => {
  it('acquireMigrationLock only polls pg_try_advisory_lock and never changes lock_timeout', async () => {
    const { acquireMigrationLock } = await import('../migration-lock');
    const sql: string[] = [];
    let tries = 0;
    const runner = { query: async (q: string) => (sql.push(q), [{ ok: ++tries >= 3 }]) } as never;
    const ds = { query: async () => [] } as never;
    const r = await acquireMigrationLock(runner, ds, 5, () => undefined);
    expect(r.waitedMs).toBeGreaterThan(0);
    expect(sql.every((q) => /pg_try_advisory_lock/.test(q))).toBe(true);
    expect(sql.some((q) => /pg_advisory_lock\(|lock_timeout/.test(q))).toBe(false);
  });
  it('gives up after the bound with MigrationLockError, nothing applied', async () => {
    const { acquireMigrationLock, MigrationLockError } = await import('../migration-lock');
    const runner = { query: async () => [{ ok: false }] } as never;
    await expect(acquireMigrationLock(runner, { query: async () => [] } as never, 1, () => undefined)).rejects.toBeInstanceOf(MigrationLockError);
  });
});

describe('Agent 5 finding 2: deploy-prepare derives target authority for the owner login only, never over an explicit DB_TARGET', () => {
  it('null (legacy path unchanged, no connection) for an explicit DB_TARGET, another login, or no URL', async () => {
    await expect(deriveOwnerLoginGuardEnv({ DB_TARGET: 'production', PG_DATABASE_URL: 'postgres://crewflow_owner:x@127.0.0.1:1/db' })).resolves.toBeNull();
    await expect(deriveOwnerLoginGuardEnv({ PG_DATABASE_URL: 'postgres://crewflow_migrator:x@127.0.0.1:1/db' })).resolves.toBeNull();
    await expect(deriveOwnerLoginGuardEnv({})).resolves.toBeNull();
  });
});

describe('derived-authority path (deploy-prepare / child, production): the bound marker must match CREWFLOW_DEPLOYMENT_ID', () => {
  const ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  const OTHER = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d';
  const HOST = 'db.example.internal';
  const markerQuery = (boundId: string) =>
    (async (sql: string) => {
      if (sql === MARKER_PRESENT_SQL) return [{ present: true, database: 'crewflow', disposable_test: false }];
      if (sql === MARKER_READ_SQL) {
        return [{ environment: 'production', deployment_id: boundId, bound_database: 'crewflow', bound_hosts: [HOST], bound_system_identifier: null, current_system_identifier: null }];
      }
      return [];
    }) as never;
  const derived = (env: Record<string, string>) => synthesiseGuardEnv(env, 'bound', 'crewflow', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').guardEnv;
  const check = (env: Record<string, string | undefined>, boundId: string) =>
    assertDeploymentIdentity(markerQuery(boundId), { processLabel: 'migrations command', production: env.DB_TARGET === 'production', env, connectionHost: HOST, command: true });

  it('the derived environment is production, keeps the declared id, and never adds the bootstrap flag on a bound database', () => {
    const env = derived({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: ID });
    expect(env).toMatchObject({ DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true', CREWFLOW_DEPLOYMENT_ID: ID });
    expect(env.CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP).toBeUndefined();
  });
  it('passes when the marker is bound to the declared id; refuses another id and a missing id (the guard the runner runs before and after the lock)', async () => {
    await expect(check(derived({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: ID }), ID)).resolves.toMatchObject({ summary: `production/${ID}` });
    await expect(check(derived({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: ID }), OTHER)).rejects.toThrow(/bound to production\/0b9a8c7d/);
    await expect(check(derived({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' }), ID)).rejects.toThrow(/CREWFLOW_DEPLOYMENT_ID/);
  });
});

describe('Agent 5 finding 1: a fresh NON-production install with a declared identity reaches its auto-bind; production unchanged', () => {
  const ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  const declared = { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: ID };
  const absentMarker = (async (sql: string) => (sql === MARKER_PRESENT_SQL ? [{ present: false, database: 'crewflow', disposable_test: false }] : [])) as never;
  const guard = (env: Record<string, string | undefined>) =>
    assertDeploymentIdentity(absentMarker, { processLabel: 'migrations command', production: false, env, connectionHost: '127.0.0.1', command: true });

  it('the regression: the declaration itself is refused on an unmarked database, so the guard must not see it before the bind', async () => {
    await expect(guard({ ...declared, DB_TARGET: 'local' })).rejects.toThrow(/no deployment identity marker/);
    const derived = synthesiseGuardEnv(declared, 'absent', 'crewflow', 'x').guardEnv;
    expect(derived.CREWFLOW_DEPLOYMENT_ENVIRONMENT).toBeUndefined();
    expect(derived.CREWFLOW_DEPLOYMENT_ID).toBeUndefined();
    await expect(guard(derived)).resolves.toMatchObject({ summary: 'absent' });
    expect(synthesiseGuardEnv(declared, 'unbound', 'crewflow', 'x').guardEnv.CREWFLOW_DEPLOYMENT_ID).toBeUndefined();
  });
  it('once the marker is bound the declaration is checked again (a mismatch still refuses); production keeps its declaration', () => {
    expect(synthesiseGuardEnv(declared, 'bound', 'crewflow', 'x').guardEnv).toMatchObject(declared);
    const prod = synthesiseGuardEnv({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: ID }, 'absent', 'crewflow', 'x').guardEnv;
    expect(prod).toMatchObject({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: ID, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' });
  });
});

describe('Agent 5 finding 2: CREWFLOW_MIGRATION_APPROVAL_MODE=token gates EVERY non-fresh apply, whatever the target', () => {
  const base = { mode: 'apply' as const, ownerLogin: true, fresh: false, pending: 3, hasApprover: false, production: false };
  it('token without a token on an existing non-production database: refused (exit 65); with a token: the F5 gate', () => {
    expect(approvalDecision({ ...base, approvalMode: 'token' })).toBe('refuse-token');
    expect(approvalDecision({ ...base, approvalMode: 'token', production: true })).toBe('refuse-token');
    expect(approvalDecision({ ...base, approvalMode: 'token', hasApprover: true })).toBe('f5');
    const named = Object.assign(new Error('migrate-on-start: CREWFLOW_MIGRATION_APPROVAL_MODE=token needs CREWFLOW_MIGRATION_APPROVED for the 3 pending'), { name: 'Error' });
    expect(outcomeOf(named)).toBe('behind');
  });
  it('a proven fresh install, nothing pending, approval mode none, a check run and deploy-prepare (mode unset) are unchanged', () => {
    expect(approvalDecision({ ...base, approvalMode: 'token', fresh: true })).toBe('f5');
    expect(approvalDecision({ ...base, approvalMode: 'token', pending: 0 })).toBe('f5');
    expect(approvalDecision({ ...base, approvalMode: 'none' })).toBe('none-mode');
    expect(approvalDecision({ ...base, approvalMode: 'token', mode: 'check' })).toBe('check');
    expect(approvalDecision({ ...base, approvalMode: undefined })).toBe('f5');
    expect(approvalDecision({ ...base, approvalMode: 'token', ownerLogin: false })).toBe('f5');
  });
});

describe('Agent 5 ID-2 (BC-11): deployment id mandatory after the first bind — enforced for production, lenient outside it by design', () => {
  const HOST = 'db.example.internal';
  const bound = (environment: string) =>
    (async (sql: string) => {
      if (sql === MARKER_PRESENT_SQL) return [{ present: true, database: 'crewflow', disposable_test: false }];
      if (sql === MARKER_READ_SQL) {
        return [{ environment, deployment_id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', bound_database: 'crewflow', bound_hosts: [HOST], bound_system_identifier: null, current_system_identifier: null }];
      }
      return [];
    }) as never;
  const guard = (env: Record<string, string | undefined>, marker: string) =>
    assertDeploymentIdentity(bound(marker), { processLabel: 'migrations command', production: env.DB_TARGET === 'production', env, connectionHost: HOST, command: true });

  it('a database bound to PRODUCTION and a child with no declaration: refused (exit 67), whatever the child derives', async () => {
    const derived = synthesiseGuardEnv({}, 'bound', 'crewflow', 'x').guardEnv;
    expect(derived.DB_TARGET).toBe('local');
    await expect(guard(derived, 'production')).rejects.toThrow(/bound to production .* must not use it/);
    // Declaring production without an id is refused too (assertDeclaredIdentityForProcess).
    await expect(guard(synthesiseGuardEnv({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' }, 'bound', 'crewflow', 'x').guardEnv, 'production')).rejects.toThrow(/CREWFLOW_DEPLOYMENT_ID/);
  });

  it('a database bound to staging / test with no declaration: allowed with a warning (the existing non-production rule)', async () => {
    const r = await guard(synthesiseGuardEnv({}, 'bound', 'crewflow', 'x').guardEnv, 'staging');
    expect(r.warnings.join(' ')).toMatch(/declares no identity; set CREWFLOW_DEPLOYMENT_ENVIRONMENT and CREWFLOW_DEPLOYMENT_ID/);
  });
});
