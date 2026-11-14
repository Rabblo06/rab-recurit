import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { STAFF_PROFILE_MEMBER_SELECT } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/staff-profile-member-select';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import {
  dropWorkspaceSchema,
  FROZEN_TEMPLATE_REGISTRY,
  ledgerOf,
  provisionServerPath,
  provisionTypeScript,
  registryOf,
  SeededWorkspace,
  seedWorkspace,
} from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, owner decision 0b (2026-11-14): the first real workspace upgrade command,
 * `0.6.0_StaffProfileMemberSelect_1786721480000` (structure level 21), and its core half WorkspaceStaffMemberSelect1786721480000
 * (fingerprint v2, the level-aware verify function, core.provision_workspace at level 21). Real PostgreSQL, the one runtime
 * login (TEST_DATABASE_URL = crewflow_owner) holding the migration lock for the runner, exactly as the migrate child.
 *
 * Proves:
 *  - EXISTING READY workspaces (built from the frozen module-20 template, as before this release) are adopted and brought to
 *    level 21 by the runner: the policy exists, module_version 21, the v2 fingerprint equals the declared value of this
 *    PostgreSQL major, the registry keeps the v1 value; idempotent (a second start writes nothing; a crash after COMMIT re-runs
 *    and completes without changing the structure);
 *  - NEW workspaces get it from the template: the TypeScript provisioner and core.provision_workspace both build level 21 with
 *    the same v2 (and v1) fingerprint as an upgraded one;
 *  - the owner's three tests: a member WITHOUT staff.view reads 0 staff; a member of ANOTHER workspace reads 0; money fields
 *    are hidden without payroll.view (service layer: MemberAccessPolicyService projection + role-write escalation check);
 *  - abuse: inactive membership, a role of another workspace, a system role, another organisation, no tenant context → 0 rows.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.6.0_${STAFF_PROFILE_MEMBER_SELECT.name}_${STAFF_PROFILE_MEMBER_SELECT.timestamp}`;
/** The registry through level 21 only (later structural commands, e.g. 0a's level 22, are proven by their own spec). */
const L21 = { '0-6': [STAFF_PROFILE_MEMBER_SELECT] };

describeIfDb('Part D 0b: staff_profile_member_select as a workspace upgrade command (integration)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  let declared: string;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  let seq = 0;

  const make = async (n: string, how: 'frozen' | 'ts' | 'sql' | 'none' = 'frozen', orgSlug?: string): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `ws0b-${n}-${SFX}-${String.fromCharCode(97 + (seq % 26))}${seq}`, orgSlug ? { orgSlug } : {});
    created.push(ws);
    if (how === 'frozen') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY })).toBe('READY');
    if (how === 'ts') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L21 })).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const fp = async (ws: SeededWorkspace) =>
    (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS v1, core.workspace_schema_fingerprint_v2($1) AS v2', [ws.id])).rows[0] as { v1: string; v2: string };
  const hasPolicy = async (ws: SeededWorkspace) =>
    Number(
      (await admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_policies WHERE schemaname = $1 AND tablename = 'staff_profile' AND policyname = 'staff_profile_member_select'`, [ws.schema]))
        .rows[0].n,
    ) === 1;
  const rows = async (ws: SeededWorkspace) =>
    (await admin.query(`SELECT name, status, attempt, is_initial FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY created_at, attempt`, [ws.id])).rows as Array<{
      name: string;
      status: string;
      attempt: number;
      is_initial: boolean;
    }>;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], force: false, adopt: true, log: (l) => lines.push(l), workspaceRegistry: L21, ...o }).run(session);

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    session = upgradeSessionOf(app);
    declared = declaredFingerprint(21, workspaceFingerprintMajor())!;
  });

  afterAll(async () => {
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  it('the command is the reviewed level 21 of this code, declared for this PostgreSQL major, and the database runs fingerprint v2', async () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(21);
    expect(STAFF_PROFILE_MEMBER_SELECT.structure).toMatchObject({ level: 21, provisionFunctionLiteral: 'db:provision_workspace@WorkspaceStaffMemberSelect1786721480000' });
    expect(STAFF_PROFILE_MEMBER_SELECT.structure?.mayDrop).toBeUndefined();
    expect(declared).toMatch(/^[0-9a-f]{64}$/);
    const { rows: fns } = await admin.query(
      `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_catalog.pg_proc p WHERE p.oid IN ('core.workspace_schema_fingerprint_v2(uuid)'::regprocedure, 'core.workspace_schema_fingerprint_v2_lines(uuid)'::regprocedure)`,
    );
    expect(fns).toEqual([
      { owner: 'rab_secure_owner', definer: false, app_exec: false },
      { owner: 'rab_secure_owner', definer: false, app_exec: false },
    ]);
  });

  describe('existing READY workspaces: the runner brings them to level 21', () => {
    it('adopted frozen-template workspaces get the policy, level 21, the declared v2; a second start writes nothing', async () => {
      const [a, b] = [await make('ex-a'), await make('ex-b')];
      for (const w of [a, b]) {
        expect(await hasPolicy(w)).toBe(false);
        expect((await registryOf(admin, w.id)).module_version).toBe(20);
      }
      const first = await runner({ workspaceIds: [a.id, b.id] });
      expect(first.failures).toEqual([]);
      for (const w of [a, b]) {
        expect(first.outcomes.find((o) => o.workspaceId === w.id)).toMatchObject({ status: 'adopted', completed: [STEP] });
        expect(await hasPolicy(w)).toBe(true);
        const reg = await registryOf(admin, w.id);
        const f = await fp(w);
        expect(reg).toMatchObject({ module_version: 21, drift_status: 'OK' });
        expect(f.v2).toBe(declared);
        expect(reg.expected_fingerprint).toBe(f.v1);
        expect((await rows(w)).map((r) => [r.name, r.status, r.attempt, r.is_initial])).toEqual([
          ['0.6.0_TypeOrmMigrations', 'completed', 1, true],
          [STEP, 'completed', 1, false],
        ]);
      }
      const second = await runner({ workspaceIds: [a.id, b.id] });
      expect(second.failures).toEqual([]);
      expect(second.outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
      expect((await rows(a)).length).toBe(2);
    });

    it('idempotent after a crash between COMMIT and the logbook row: the step re-runs, completes, and changes nothing', async () => {
      const w = await make('ex-crash');
      // Adopt with a registry that has no workspace command (the cursor is then the last instance step), then simulate the
      // committed step whose row was lost: the policy and level 21 exist, no row.
      await runner({ workspaceIds: [w.id], workspaceRegistry: FROZEN_TEMPLATE_REGISTRY as never });
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      await admin.query(STAFF_PROFILE_MEMBER_SELECT.sql!(w.schema));
      await admin.query('RESET ROLE');
      await admin.query(`UPDATE core.workspace_schema_registry SET module_version = 21 WHERE workspace_id = $1`, [w.id]);
      await admin.query('COMMIT');
      const before = await fp(w);
      const out = await runner({ workspaceIds: [w.id] });
      expect(out.failures).toEqual([]);
      expect((await rows(w)).map((r) => [r.name, r.status, r.attempt])).toEqual([
        ['0.6.0_TypeOrmMigrations', 'completed', 1],
        [STEP, 'completed', 1],
      ]);
      expect(await fp(w)).toEqual(before);
      expect(before.v2).toBe(declared);
    });

    it('a tampered policy of the same name is not "fixed" silently: the step is refused (fingerprint) and rolled back, the workspace blocked', async () => {
      const w = await make('ex-tamper');
      await runner({ workspaceIds: [w.id], workspaceRegistry: FROZEN_TEMPLATE_REGISTRY as never });
      await admin.query(`CREATE POLICY staff_profile_member_select ON ${w.schema}.staff_profile FOR SELECT USING (true)`);
      const out = await runner({ workspaceIds: [w.id] });
      expect(out.failures.map((f) => [f.step, f.errorClass, f.blocked])).toEqual([[STEP, 'FINGERPRINT_MISMATCH', true]]);
      expect((await registryOf(admin, w.id)).module_version).toBe(20);
      expect((await registryOf(admin, w.id)).migration_error).toMatch(/^upgrade-blocked: /);
    });
  });

  it('new workspaces get it from the template: the TypeScript provisioner and core.provision_workspace build level 21 identical to an upgraded one', async () => {
    const upgraded = await make('nw-up');
    await runner({ workspaceIds: [upgraded.id] });
    const ts = await make('nw-ts', 'ts');
    const sql = await make('nw-sql', 'sql');
    const want = await fp(upgraded);
    expect(want.v2).toBe(declared);
    // core.provision_workspace builds THIS code's level: compared with the upgraded one only while that is 21.
    expect(await hasPolicy(sql)).toBe(true);
    expect((await registryOf(admin, sql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    for (const w of codeWorkspaceStructureLevel() === 21 ? [ts, sql] : [ts]) {
      expect(await hasPolicy(w)).toBe(true);
      const reg = await registryOf(admin, w.id);
      expect(reg).toMatchObject({ status: 'READY', module_version: 21, drift_status: 'OK' });
      expect(await fp(w)).toEqual(want);
      expect(reg.expected_fingerprint).toBe(want.v1);
      // Owner decision D5: the 20 frozen modules stay the template history.
      expect((await ledgerOf(admin, w.id)).length).toBe(20);
    }
    // A new workspace's creation-time cursor (Part B is_initial) is the code version's last step: the runner runs nothing.
    for (const w of [ts]) {
      await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`, [STEP, w.id]);
    }
    const out = await runner({ workspaceIds: [ts.id] });
    expect(out.outcomes.map((o) => o.status)).toEqual(['up-to-date']);
  });

  describe('RLS: who reads a workspace\'s staff through staff_profile_member_select (runtime login, FORCE RLS)', () => {
    let w1: SeededWorkspace;
    let w2: SeededWorkspace;
    let other: SeededWorkspace;
    let staffView: string;
    let venueView: string;
    /** A user of `org` (no manager_profile, no staff_profile: only the member policy can grant them anything). */
    const user = async (org: string, label: string): Promise<string> =>
      (
        await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Mem', 'Ber', 'active') RETURNING id`, [
          org,
          `${label}-${randomUUID().slice(0, 8)}@ws0b.invalid`,
        ])
      ).rows[0].id as string;
    const role = async (org: string, workspace: string | null, permission: string, system = false): Promise<string> => {
      const key = system ? `ws0b_sys_${randomUUID().slice(0, 8)}` : `custom_ws0b_${randomUUID().slice(0, 8)}`;
      const id = (await admin.query(`INSERT INTO core.role(organisation_id, key, name, is_system, workspace_id) VALUES ($1, $2, $2, $3, $4) RETURNING id`, [org, key, system, workspace]))
        .rows[0].id as string;
      await admin.query(`INSERT INTO core.role_permission(role_id, permission_id, organisation_id) VALUES ($1, $2, $3)`, [id, permission, org]);
      return id;
    };
    const member = async (ws: SeededWorkspace, roleId: string, status = 'active', label = 'm'): Promise<string> => {
      const u = await user(ws.org, label);
      await admin.query(`INSERT INTO core.user_role(user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [u, roleId, ws.org]);
      await admin.query(`INSERT INTO core.workspace_membership(organisation_id, user_id, workspace_id, status) VALUES ($1, $2, $3, $4)`, [
        ws.org,
        u,
        ws.id,
        status,
      ]);
      return u;
    };
    const staffIn = async (ws: SeededWorkspace, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const u = await user(ws.org, 'staff');
        await admin.query(`INSERT INTO ${ws.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, default_pay_rate_pence) VALUES ($1, $2, $3, $4, 1550)`, [
          ws.org,
          u,
          `WS0B-${randomUUID().slice(0, 8)}`,
          ws.id,
        ]);
      }
    };
    /** count(*) of `table` as the runtime login with the request GUCs bound (null = nothing bound). */
    const visible = async (bind: { org: string; ws: string; uid: string } | null, table: string): Promise<number> => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        if (bind) {
          await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', 'manager', true), set_config('rab.actor_type', 'user', true)`, [
            bind.org,
            bind.ws,
            bind.uid,
          ]);
        }
        return Number((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };

    beforeAll(async () => {
      // w1 and w2: two workspaces of ONE organisation, both at level 21 (one upgraded, one from the template); other: another
      // organisation's workspace.
      w1 = await make('rls-w1');
      await runner({ workspaceIds: [w1.id] });
      const owner2 = await user(w1.org, 'owner2');
      w2 = (await admin.query(
        `INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
         VALUES ($1, $2, $3::text, $3::text, 'active', 'CREATING') RETURNING id, organisation_id AS org, owner_user_id AS owner`,
        [w1.org, owner2, `ws0b-rls-w2-${SFX}`],
      )).rows.map((r) => ({ id: r.id, org: r.org, owner: r.owner, schema: `workspace_${String(r.id).replace(/-/g, '')}`, label: 'w2' }))[0]!;
      created.push(w2);
      expect(await provisionTypeScript(adminUrl, w2, { workspaceRegistry: L21 })).toBe('READY');
      other = await make('rls-other', 'ts');
      staffView = (await admin.query(`SELECT id FROM core.permission WHERE key = 'staff.view'`)).rows[0].id;
      venueView = (await admin.query(`SELECT id FROM core.permission WHERE key = 'venue.view'`)).rows[0].id;
      await staffIn(w1, 3);
      await staffIn(w2, 2);
      await staffIn(other, 2);
    });

    it('owner test 1: a member WITH staff.view (custom role of this workspace) reads its staff; WITHOUT staff.view reads 0', async () => {
      const yes = await member(w1, await role(w1.org, w1.id, staffView), 'active', 'yes');
      const no = await member(w1, await role(w1.org, w1.id, venueView), 'active', 'no');
      expect(await visible({ org: w1.org, ws: w1.id, uid: yes }, `${w1.schema}.staff_profile`)).toBe(3);
      expect(await visible({ org: w1.org, ws: w1.id, uid: no }, `${w1.schema}.staff_profile`)).toBe(0);
    });

    it('owner test 2: a member of ANOTHER workspace reads 0, whether bound to its own workspace or to this one', async () => {
      const m = await member(w1, await role(w1.org, w1.id, staffView), 'active', 'w1');
      // Bound to w2 (same organisation, not a member there): w2's staff are invisible.
      expect(await visible({ org: w1.org, ws: w2.id, uid: m }, `${w2.schema}.staff_profile`)).toBe(0);
      // Bound to w1 but reading w2's schema: the workspace binding refuses every row.
      expect(await visible({ org: w1.org, ws: w1.id, uid: m }, `${w2.schema}.staff_profile`)).toBe(0);
      // A member of w2 with staff.view in w2 sees w2's staff and none of w1's.
      const m2 = await member(w2, await role(w2.org, w2.id, staffView), 'active', 'w2');
      expect(await visible({ org: w2.org, ws: w2.id, uid: m2 }, `${w2.schema}.staff_profile`)).toBe(2);
      expect(await visible({ org: w2.org, ws: w1.id, uid: m2 }, `${w1.schema}.staff_profile`)).toBe(0);
    });

    it('abuse: inactive membership, a role of another workspace, a system role, another organisation, no tenant context → 0 rows', async () => {
      const r = await role(w1.org, w1.id, staffView);
      const suspended = await member(w1, r, 'suspended', 'susp');
      const removed = await member(w1, r, 'removed', 'rem');
      expect(await visible({ org: w1.org, ws: w1.id, uid: suspended }, `${w1.schema}.staff_profile`)).toBe(0);
      expect(await visible({ org: w1.org, ws: w1.id, uid: removed }, `${w1.schema}.staff_profile`)).toBe(0);
      // Active member of w1, but the staff.view role belongs to w2.
      const cross = await member(w1, await role(w1.org, w2.id, venueView), 'active', 'cross');
      await admin.query(`INSERT INTO core.user_role(user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [cross, await role(w1.org, w2.id, staffView), w1.org]);
      expect(await visible({ org: w1.org, ws: w1.id, uid: cross }, `${w1.schema}.staff_profile`)).toBe(0);
      // A system role holding staff.view never satisfies the member policy.
      const sys = await member(w1, await role(w1.org, null, staffView, true), 'active', 'sys');
      expect(await visible({ org: w1.org, ws: w1.id, uid: sys }, `${w1.schema}.staff_profile`)).toBe(0);
      // The w1 member bound to another organisation's workspace, or reading it while bound to its own: 0.
      const m = await member(w1, r, 'active', 'org');
      expect(await visible({ org: other.org, ws: other.id, uid: m }, `${other.schema}.staff_profile`)).toBe(0);
      expect(await visible({ org: w1.org, ws: w1.id, uid: m }, `${other.schema}.staff_profile`)).toBe(0);
      // No tenant context at all: zero rows, never all rows.
      expect(await visible(null, `${w1.schema}.staff_profile`)).toBe(0);
      // Sanity: the same member, correctly bound, does read w1.
      expect(await visible({ org: w1.org, ws: w1.id, uid: m }, `${w1.schema}.staff_profile`)).toBe(3);
    });

    it('the policy is SELECT only: a staff.view member can neither insert, update nor delete staff rows', async () => {
      const m = await member(w1, await role(w1.org, w1.id, staffView), 'active', 'ro');
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        const bound = async () => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [w1.org, w1.id, m]);
        };
        await bound();
        expect((await c.query(`UPDATE ${w1.schema}.staff_profile SET notes = 'x'`)).rowCount).toBe(0);
        expect((await c.query(`DELETE FROM ${w1.schema}.staff_profile`)).rowCount).toBe(0);
        await c.query('ROLLBACK');
        await bound();
        const u = await user(w1.org, 'ins');
        await expect(
          c.query(`INSERT INTO ${w1.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id) VALUES ($1, $2, 'WS0B-INS', $3)`, [w1.org, u, w1.id]),
        ).rejects.toMatchObject({ code: '42501' });
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });
  });
});

/**
 * Owner test 3: money is hidden without payroll.view. Field-level read permissions are enforced in the SERVICE layer (RLS is
 * row-level: a row the member may read carries every column):
 *  - MemberAccessPolicyService.project (member-access-policy.service.ts) whitelists the properties of every staff record a
 *    custom-role member reads; `payRate` (defaultPayRatePence) is `defaultVisible: false` with `sensitiveAuthority:
 *    payroll.view` (member-object-registry.ts);
 *  - RoleService (role.service.ts, `value === 'visible' && field.sensitiveAuthority`) and MemberRolePolicyService
 *    .assertSensitiveFieldsHeldTx refuse a role write / assignment that reveals a field whose authority the editor lacks;
 *  - FieldPolicyService (attendance / payroll objects) hides every payroll.view field from a caller who does not hold it.
 * Mode-agnostic: with HWS off the staff rows live in core, with HWS on (C1) in the workspace schema; the run with C1 merged is
 * the HWS-on proof (WS-COMMANDS.md).
 */
describeIfDb('Part D 0b: money fields are hidden from a staff.view member without payroll.view (HTTP)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let managerA: TestIdentity;
  let tokenA: string;
  let staff: TestIdentity;
  const STRONG = 'Correct-Horse-42-battery';
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 6)}`;
  const definition = (name: string, objects: unknown[]) => ({ name, assignableToMembers: true, readAllObjects: false, objects });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ws0b' });
    managerA = seeded.managers[0]!;
    tokenA = await factory.login(managerA);
    staff = await factory.createStaff(seeded.organisation, { owner: managerA, label: 'ws0b-pay' });
    // The pay rate is set where the row lives: core with HWS off, the workspace schema with HWS on (one of them matches).
    await owner.query(`UPDATE core.staff_profile SET default_pay_rate_pence = 1550 WHERE id = $1`, [staff.profileId]);
    const schema = `workspace_${String(managerA.workspaceId).replace(/-/g, '')}`;
    const [{ present }] = await owner.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${schema}.staff_profile`]);
    if (present) await owner.query(`UPDATE ${schema}.staff_profile SET default_pay_rate_pence = 1550 WHERE id = $1`, [staff.profileId]);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  async function onboardMember(roleId: string): Promise<string> {
    const address = `ws0b-${randomUUID().slice(0, 8)}@example.test`;
    const sent = await http().post('/rest/v1/member-invitations').set(bearer(tokenA)).send({ emails: [address], roleId });
    expect(sent.status).toBe(200);
    const [inv] = await owner.query(`SELECT id FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [address]);
    const [mail] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
    const raw = decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(mail.rendered_html as string)![1]!);
    expect((await http().post('/rest/v1/invitations/accept').send({ token: raw, firstName: 'Mem', lastName: 'Ber', newPassword: STRONG })).status).toBe(200);
    return factory.login({ kind: 'internal_manager', email: address, password: STRONG });
  }

  it('a staff.view member reads the staff row (list and detail) without defaultPayRatePence; a member without staff.view is refused', async () => {
    const viewer = await http().post('/rest/v1/roles').set(bearer(tokenA)).send(definition(uniq('Viewer'), [{ object: 'staff', read: 'grant' }]));
    expect(viewer.status).toBe(201);
    const token = await onboardMember(viewer.body.id as string);
    const list = await http().get('/rest/v1/staff').set(bearer(token));
    expect(list.status).toBe(200);
    const row = (list.body.data as Array<Record<string, unknown>>).find((s) => s.id === staff.profileId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('defaultPayRatePence');
    const detail = await http().get(`/rest/v1/staff/${staff.profileId}`).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('defaultPayRatePence');
    // The workspace owner (payroll.view) sees the money on the same row.
    const ownerDetail = await http().get(`/rest/v1/staff/${staff.profileId}`).set(bearer(tokenA));
    expect(ownerDetail.body.defaultPayRatePence).toBe(1550);

    const none = await http().post('/rest/v1/roles').set(bearer(tokenA)).send(definition(uniq('None'), []));
    expect(none.status).toBe(201);
    const noToken = await onboardMember(none.body.id as string);
    expect((await http().get('/rest/v1/staff').set(bearer(noToken))).status).toBe(403);
  });

  it('an editor without payroll.view cannot create a role that reveals the pay rate (403 ROLE_ESCALATION)', async () => {
    const leanOrg = await factory.createOrganisation('ws0b-lean');
    const lean = await factory.createInternalManager(leanOrg, { permissions: ['role.view', 'role.manage', 'staff.view'], workspace: true, label: 'ws0b-lean' });
    const leanToken = await factory.login(lean);
    const pay = await http().post('/rest/v1/roles').set(bearer(leanToken)).send(definition(uniq('Pay'), [{ object: 'staff', read: 'grant', fields: { payRate: 'visible' } }]));
    expect(pay.status).toBe(403);
    expect(pay.body.code).toBe('ROLE_ESCALATION');
  });
});
