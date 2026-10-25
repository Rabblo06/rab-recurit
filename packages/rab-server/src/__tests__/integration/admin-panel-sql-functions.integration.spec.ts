import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  ADMIN_AUDIT_ACTIONS_1786720100000,
  ADMIN_AUDIT_VIA_ACTIONS_1786720100000,
  ADMIN_READ_FUNCTIONS_1786720100000,
} from '../../database/typeorm/core/migrations/1786720100000-AdminPanelReadFunctions';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Crewflow Platform Admin Panel — the five admin-gated SECURITY DEFINER read functions (AdminPanelReadFunctions
 * 1786720100000), exercised as the REAL runtime role `crewflow_app`:
 *  - each raises 42501 for an unbound caller (no tenant context → error, never rows) and for a non-admin holding every
 *    permission; PUBLIC has no EXECUTE; crewflow (no CLI caller) has none either; owner/definer/search_path as declared;
 *  - fixed column sets with no secret/hash/token/IP/user-agent/payload column; page sizes clamped (≤25 / ≤50);
 *  - FORCE RLS is honoured by binding one organisation at a time, and the caller's binding is restored afterwards;
 *  - the audit function never returns an action outside the admin allowlist and refuses a filter outside it;
 *  - no FORCE flag or BYPASSRLS changed (the five tables still FORCE; runtime role still rolbypassrls = false).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const CALLS: Array<[string, string, unknown[]]> = [
  ['admin_platform_overview', 'SELECT * FROM core.admin_platform_overview()', []],
  ['admin_search_users', 'SELECT * FROM core.admin_search_users($1, $2, $3)', ['', null, 10]],
  ['admin_list_platform_admins', 'SELECT * FROM core.admin_list_platform_admins()', []],
  ['admin_list_workspace_schemas', 'SELECT * FROM core.admin_list_workspace_schemas($1, $2, $3, $4, $5)', [null, null, null, null, 10]],
  ['admin_list_audit_events', 'SELECT * FROM core.admin_list_audit_events($1::text[], $2, $3, $4, $5)', [null, null, null, null, 10]],
];

const FORBIDDEN_COLUMN = /password|hash|secret|token|user_?agent|ip_?address|^ip$|payload|body|rendered|amount|pence|metadata/i;

describeIfDb('admin panel SQL functions (integration, crewflow_app)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let admin: TestIdentity;
  let nonAdmin: TestIdentity;
  let otherOrgUser: TestIdentity;

  /** One transaction as crewflow_app with exactly these GUCs bound (empty string = unbound). */
  async function as<T>(userId: string, organisationId: string, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.user_id', $1, true), set_config('rab.organisation_id', $2, true), set_config('rab.workspace_id', '', true)`, [userId, organisationId]);
      return fn(m);
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const adminOrg = await factory.createOrganisation('apsql-admin');
    admin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'apsqladm', platformAdmin: true });
    nonAdmin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'apsqlmgr' });
    const otherOrg = await factory.createOrganisation('apsql-other');
    otherOrgUser = await factory.createInternalManager(otherOrg, { permissions: 'all', label: 'apsqlother' });
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('the runtime connection really is crewflow_app, without BYPASSRLS', async () => {
    const [row] = await dataSource.query(`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`);
    expect(row).toEqual({ u: 'crewflow_app', b: false });
  });

  it.each(CALLS)('ABUSE %s: no tenant context bound → 42501, never rows', async (_name, sql, params) => {
    await expect(as('', '', (m) => m.query(sql, params))).rejects.toMatchObject({ code: '42501' });
  });

  it.each(CALLS)('ABUSE %s: a non-admin holding EVERY permission → 42501', async (_name, sql, params) => {
    await expect(as(nonAdmin.userId, nonAdmin.organisationId, (m) => m.query(sql, params))).rejects.toMatchObject({ code: '42501' });
  });

  it.each(CALLS)('%s: an active platform admin gets rows (or an empty set), never an error', async (_name, sql, params) => {
    await expect(as(admin.userId, admin.organisationId, (m) => m.query(sql, params))).resolves.toEqual(expect.any(Array));
  });

  it('catalog: owner rab_secure_owner, SECURITY DEFINER, pinned search_path, no PUBLIC / crewflow EXECUTE, crewflow_app EXECUTE', async () => {
    const rows: Array<{ sig: string; owner: string; definer: boolean; config: string[]; pub: boolean; app: boolean; cf: boolean }> = await owner.query(
      `SELECT replace(p.oid::regprocedure::text, 'core.', '') AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')) AS pub,
              has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crewflow', p.oid, 'EXECUTE') AS cf
         FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'admin\\_%' AND p.proname <> 'admin_workspace_in_org' ORDER BY 1`,
    );
    expect(rows.map((r) => r.sig).sort()).toEqual([...ADMIN_READ_FUNCTIONS_1786720100000].sort());
    for (const r of rows) {
      expect({ sig: r.sig, owner: r.owner, definer: r.definer, pub: r.pub, app: r.app, cf: r.cf }).toEqual({ sig: r.sig, owner: 'rab_secure_owner', definer: true, pub: false, app: true, cf: false });
      expect(r.config).toContain('search_path=pg_catalog, pg_temp');
    }
  });

  it('fixed column sets: no password/hash/secret/token/IP/user-agent/payload/metadata column in any function result', async () => {
    const rows: Array<{ sig: string; cols: string }> = await owner.query(
      `SELECT p.proname AS sig, array_to_string(p.proargnames[p.pronargs + 1:], ',') AS cols
         FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'admin\\_%' AND p.proname <> 'admin_workspace_in_org'`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) for (const col of r.cols.split(',')) expect({ fn: r.sig, col, bad: FORBIDDEN_COLUMN.test(col) }).toEqual({ fn: r.sig, col, bad: false });
  });

  it('admin_search_users: exact email first, 2FA state + role keys, never secrets; bounded to 25; < 3 chars refused', async () => {
    const rows = await as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_search_users($1, NULL, 25)', [otherOrgUser.email]));
    expect(rows[0]).toMatchObject({ userId: otherOrgUser.userId, organisationId: otherOrgUser.organisationId, matchKind: 'email', totpEnabled: false, isPlatformAdmin: false });
    expect(rows[0].roleKeys).toContain('manager');
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['createdAt', 'email', 'firstName', 'isPlatformAdmin', 'lastLoginAt', 'lastName', 'matchKind', 'mfaEnabledAt', 'organisationId', 'organisationName',
        'recoveryCodesRemaining', 'recoveryCodesTotal', 'roleKeys', 'roleNames', 'status', 'totpEnabled', 'userId'].sort(),
    );
    const many = await as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_search_users($1, NULL, 10000)', ['']));
    expect(many.length).toBeLessThanOrEqual(25);
    await expect(as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_search_users($1, NULL, 10)', ['ab']))).rejects.toMatchObject({ code: '22023' });
    await expect(as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_search_users($1, $2, 10)', ['', 'superuser']))).rejects.toMatchObject({ code: '22023' });
  });

  it('admin_search_users: LIKE wildcards in the query are literal (no "%" enumeration)', async () => {
    const rows = await as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_search_users($1, NULL, 25)', ['%%%']));
    expect(rows).toEqual([]);
  });

  it('admin_search_users: role filter binds each organisation and returns only holders of that role; caller binding restored', async () => {
    const result = await as(admin.userId, admin.organisationId, async (m) => {
      const rows = await m.query('SELECT * FROM core.admin_search_users($1, $2, 25)', [otherOrgUser.email.slice(0, 12), 'manager']);
      const [{ org }] = await m.query(`SELECT current_setting('rab.organisation_id', true) AS org`);
      return { rows, org };
    });
    expect(result.org).toBe(admin.organisationId);
    expect(result.rows.map((r: { userId: string }) => r.userId)).toContain(otherOrgUser.userId);
    for (const r of result.rows) expect(r.roleKeys).toContain('manager');
  });

  it('admin_list_audit_events: allowlist only (a non-admin action in the same organisation never appears); outside filter refused; ≤50', async () => {
    const plain = randomUUID();
    const adminRow = randomUUID();
    await owner.query(`INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata) VALUES ($1, $2, $3, 'user.created', '{}')`, [plain, otherOrgUser.organisationId, otherOrgUser.userId]);
    await owner.query(
      `INSERT INTO core.audit_log (id, organisation_id, actor_user_id, target_user_id, action, metadata) VALUES ($1, $2, $3, $4, 'admin.sessions_revoked', $5)`,
      [adminRow, otherOrgUser.organisationId, admin.userId, otherOrgUser.userId, JSON.stringify({ reason: 'support ticket', count: 2, secretToken: 'tok_should_not_leak' })],
    );
    const rows = await as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_list_audit_events(NULL, $1, NULL, NULL, 50)', [otherOrgUser.userId]));
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(adminRow);
    expect(ids).not.toContain(plain);
    const row = rows.find((r: { id: string }) => r.id === adminRow);
    expect(row).toMatchObject({ action: 'admin.sessions_revoked', reason: 'support ticket', detail: { count: 2 } });
    expect(JSON.stringify(rows)).not.toContain('tok_should_not_leak');
    for (const r of rows) expect([...ADMIN_AUDIT_ACTIONS_1786720100000, ...ADMIN_AUDIT_VIA_ACTIONS_1786720100000]).toContain(r.action);
    await expect(as(admin.userId, admin.organisationId, (m) => m.query(`SELECT * FROM core.admin_list_audit_events(ARRAY['user.created'], NULL, NULL, NULL, 10)`))).rejects.toMatchObject({ code: '22023' });
    const page = await as(admin.userId, admin.organisationId, (m) => m.query('SELECT * FROM core.admin_list_audit_events(NULL, NULL, NULL, NULL, 5000)'));
    expect(page.length).toBeLessThanOrEqual(50);
  });

  it('admin_list_audit_events: user.invite_resent is returned only for a platform-admin resend (via = platform_admin)', async () => {
    const tenant = randomUUID();
    const viaAdmin = randomUUID();
    await owner.query(`INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata) VALUES ($1, $2, $3, 'user.invite_resent', '{"sendNumber":2}')`, [tenant, otherOrgUser.organisationId, otherOrgUser.userId]);
    await owner.query(`INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata) VALUES ($1, $2, $3, 'user.invite_resent', '{"sendNumber":2,"via":"platform_admin","reason":"lost email"}')`, [viaAdmin, otherOrgUser.organisationId, admin.userId]);
    const rows = await as(admin.userId, admin.organisationId, (m) => m.query(`SELECT id FROM core.admin_list_audit_events(ARRAY['user.invite_resent'], NULL, NULL, NULL, 50)`));
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(viaAdmin);
    expect(ids).not.toContain(tenant);
  });

  it('admin_list_workspace_schemas: unknown status / half a cursor refused; ≤50; caller binding restored', async () => {
    await expect(as(admin.userId, admin.organisationId, (m) => m.query(`SELECT * FROM core.admin_list_workspace_schemas('BOGUS', NULL, NULL, NULL, 10)`))).rejects.toMatchObject({ code: '22023' });
    await expect(as(admin.userId, admin.organisationId, (m) => m.query(`SELECT * FROM core.admin_list_workspace_schemas(NULL, NULL, now(), NULL, 10)`))).rejects.toMatchObject({ code: '22023' });
    const out = await as(admin.userId, admin.organisationId, async (m) => {
      const rows = await m.query('SELECT * FROM core.admin_list_workspace_schemas(NULL, $1, NULL, NULL, 500)', [otherOrgUser.organisationId]);
      const [{ org }] = await m.query(`SELECT current_setting('rab.organisation_id', true) AS org`);
      return { rows, org };
    });
    expect(out.org).toBe(admin.organisationId);
    expect(out.rows.length).toBeLessThanOrEqual(50);
    expect(out.rows.map((r: { workspaceId: string }) => r.workspaceId)).toContain(otherOrgUser.workspaceId);
  });

  it('no FORCE / BYPASSRLS drift: the tables the functions read keep their RLS flags', async () => {
    const rows: Array<{ relname: string; force: boolean; enable: boolean }> = await owner.query(
      `SELECT relname, relforcerowsecurity AS force, relrowsecurity AS enable FROM pg_class
        WHERE relnamespace = 'core'::regnamespace AND relname IN ('audit_log', 'workspace_schema_registry', 'user_role', 'role', 'user', 'user_session')`,
    );
    const flags = Object.fromEntries(rows.map((r) => [r.relname, `${r.enable}/${r.force}`]));
    expect(flags).toEqual({ audit_log: 'true/true', workspace_schema_registry: 'true/true', user_role: 'true/true', role: 'true/true', user: 'true/false', user_session: 'true/false' });
    const [secure] = await owner.query(`SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'rab_secure_owner'`);
    expect(secure).toEqual({ rolbypassrls: false, rolcanlogin: false });
  });
});
