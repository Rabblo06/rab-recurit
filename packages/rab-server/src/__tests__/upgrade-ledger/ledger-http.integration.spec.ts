/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B2/B3; UPGRADE-LEDGER-INTERFACE.md §3) through the REAL application (AppModule, HTTP,
 * real PostgreSQL with RLS, no mocks of the ledger):
 *
 *   LW-1  a workspace created through POST /rest/v1/manager-workspaces gets exactly ONE ledger row: its workspace_id,
 *         is_initial, attempt 1, not forced, at the current version (Twenty workspace.service.ts:813, markAsWorkspaceInitial);
 *         no instance row is added.
 *   LW-2  a creation that fails (subdomain taken) leaves no ledger row.
 *   LW-3  the scope cannot come from the API: a body carrying upgrade_scope / upgradeScope / rab.upgrade_scope is a 400
 *         (forbidNonWhitelisted) and changes nothing; a header of the same name changes nothing either.
 *   LW-4  deleting the workspace removes its ledger row (the FK cascade).
 *   LH-1  /healthz (owner decision 2026-11-14): the upgrade entry is exactly { status: 'up', upgradeFailed: <bool> }; no
 *         version, step name, state word or error message anywhere in the body (the state is on the admin report, LH-2).
 *   LH-2  GET /rest/v1/admin/health/report (platform admin): `upgrade` = { appVersion, state, step, executedByVersion,
 *         attempt, forced, at }, never error_message; a failed latest attempt shows state `failed` (the admin banner);
 *         a non-admin gets no report.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AdminHealthService } from '../../engine/core-modules/platform-admin/admin-health.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from '../integration/helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from '../integration/helpers/test-identities';
import { b1, LEDGER_SELECT_SQL, LedgerRow } from './ledger-contract';

jest.setTimeout(300_000);

/** Nothing about the upgrade beyond the boolean may reach public /healthz ("ok" is Terminus's own top-level status). */
const HEALTHZ_FORBIDDEN = /TypeOrmMigrations|_[0-9]{13}|\d+\.\d+\.\d+|"(failed|behind|ahead|none|unknown)"|error_message|errorMessage|executedByVersion|appVersion|"step"|"state"/;

// DEAD-07: the validated TEST pair decides (an invalid pair throws, never a silent skip).
const RUN = integrationTestDatabaseReady() && b1() !== null;
const describeIfB1 = RUN ? describe : describe.skip;

describeIfB1('the logbook through the real application (new workspace, /healthz, admin banner)', () => {
  const B1 = b1()!;
  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  /** X2.4 (main): the admin report is cached IN PROCESS for 10 s; a test that changes the logbook forgets it. */
  let forgetAdminReport: () => void = () => undefined;
  let statusService: { cached: unknown } | null = null;
  /** UpgradeStatusService keeps its answer 30 s (B1); a test that changes the logbook forgets it. */
  const forgetStatus = () => {
    if (statusService) statusService.cached = null;
  };
  let platformAdmin: TestIdentity;
  let adminToken: string;
  const http = () => request(app.getHttpServer());
  const ledger = async (): Promise<LedgerRow[]> => admin.query(LEDGER_SELECT_SQL);
  const createdWorkspaces: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    const adminHealth = moduleRef.get(AdminHealthService, { strict: false }) as unknown as { cache: unknown };
    forgetAdminReport = () => {
      adminHealth.cache = null;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UpgradeStatusService } = require('../../engine/core-modules/upgrade/upgrade-status.service');
    statusService = moduleRef.get(UpgradeStatusService, { strict: false }) as { cached: unknown };
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const org = await factory.createOrganisation('b2-ledger-http-admin');
    platformAdmin = await factory.createInternalManager(org, { permissions: 'all', label: 'b2ldgadm', platformAdmin: true });
    adminToken = await factory.login(platformAdmin, { applicationTarget: 'manager_web' });
  });

  afterAll(async () => {
    for (const id of createdWorkspaces) await deleteWorkspace(id).catch(() => undefined);
    await app.close();
    await admin.destroy();
  });

  /**
   * Superuser fixture: deletes a provisioned workspace the way an operator would. Its workspace schema is dropped, then the
   * rows that reference it through a NON-cascading foreign key (manager_profile.workspace_id, the RESTRICT
   * workspace_schema_registry (workspace_id, organisation_id), ...; found from the catalog, composite keys included) are
   * removed, then the workspace itself, so the logbook's own ON DELETE CASCADE is what removes its row.
   */
  async function deleteWorkspace(id: string): Promise<void> {
    const schemas = (await admin.query('SELECT schema_name FROM core.workspace_schema_registry WHERE workspace_id = $1', [id])) as { schema_name: string }[];
    for (const { schema_name } of schemas) {
      if (!/^workspace_[0-9a-f]{32}$/.test(schema_name)) throw new Error('unexpected workspace schema name');
      // sql-injection-reviewed: schema_name matches ^workspace_[0-9a-f]{32}$
      await admin.query(`DROP SCHEMA IF EXISTS ${schema_name} CASCADE`);
    }
    const refs = (await admin.query(
      `SELECT n.nspname AS schema, c.relname AS "table",
              array(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i) AS cols,
              array(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i) AS refcols
         FROM pg_catalog.pg_constraint k
         JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'f' AND k.confrelid = 'core.manager_workspace'::regclass AND k.confdeltype <> 'c'`,
    )) as { schema: string; table: string; cols: string[]; refcols: string[] }[];
    const qid = (x: string) => `"${x.replace(/"/g, '""')}"`;
    for (const r of refs) {
      // sql-injection-reviewed: identifiers come from the catalog and are quoted
      await admin.query(
        `DELETE FROM ${qid(r.schema)}.${qid(r.table)} WHERE (${r.cols.map(qid).join(', ')}) IN (SELECT ${r.refcols.map(qid).join(', ')} FROM core.manager_workspace WHERE id = $1)`,
        [id],
      );
    }
    await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [id]);
  }

  async function ceoToken(label: string): Promise<{ token: string }> {
    const org = await factory.createOrganisation(label);
    const ceo = await factory.createInternalManager(org, { type: 'ceo' as never, workspace: false });
    return { token: await factory.loginByEmail(ceo.email) };
  }

  const createWorkspace = (token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    http()
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .set(headers)
      .send(body);

  it('LW-1/LW-4 the real creation path writes exactly one is_initial row for the new workspace; deleting it removes the row', async () => {
    const { token } = await ceoToken('b2-ledger-ws');
    const before = await ledger();
    const res = await createWorkspace(token, { name: 'B2 ledger workspace', subdomain: `b2l-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    const ws = res.body.id as string;
    createdWorkspaces.push(ws);
    const added = (await ledger()).filter((r) => !before.some((b) => b.id === r.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ workspace_id: ws, is_initial: true, attempt: 1, forced: false, error_message: null, executed_by_version: B1.currentVersion });
    // Interface §3: name and status copied from the last attempted instance step (Twenty markAsWorkspaceInitial).
    const lastInstance = before.filter((r) => r.workspace_id === null && !r.is_initial).sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).pop();
    if (lastInstance) expect({ name: added[0]!.name, status: added[0]!.status }).toEqual({ name: lastInstance.name, status: lastInstance.status });
    await deleteWorkspace(ws);
    expect((await ledger()).filter((r) => r.workspace_id === ws)).toEqual([]);
    expect((await ledger()).map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it('LW-2 a creation that fails (the subdomain is taken) leaves no ledger row', async () => {
    const subdomain = `b2l-${randomUUID().slice(0, 8)}`;
    const first = await ceoToken('b2-ledger-ws-first');
    const ok = await createWorkspace(first.token, { name: 'B2 first', subdomain });
    expect(ok.status).toBe(201);
    createdWorkspaces.push(ok.body.id);
    const before = (await ledger()).map((r) => r.id).sort();
    const second = await ceoToken('b2-ledger-ws-second');
    const refused = await createWorkspace(second.token, { name: 'B2 second', subdomain });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await ledger()).map((r) => r.id).sort()).toEqual(before);
  });

  it('LW-3 the upgrade scope cannot come from API input: body fields are a 400, headers change nothing', async () => {
    const before = (await ledger()).map((r) => r.id).sort();
    for (const field of ['upgrade_scope', 'upgradeScope', 'rab.upgrade_scope', 'scope']) {
      const { token } = await ceoToken(`b2-ledger-scope-${field.replace(/\W/g, '')}`);
      const res = await createWorkspace(token, { name: 'B2 scope', subdomain: `b2s-${randomUUID().slice(0, 8)}`, [field]: 'upgrade' });
      expect([field, res.status]).toEqual([field, 400]);
    }
    expect((await ledger()).map((r) => r.id).sort()).toEqual(before);
    // A header of the same name: the request is served normally and writes only the new workspace's own initial row.
    const { token } = await ceoToken('b2-ledger-scope-header');
    const res = await createWorkspace(token, { name: 'B2 header', subdomain: `b2h-${randomUUID().slice(0, 8)}` }, { 'x-rab-upgrade-scope': 'upgrade', 'rab-upgrade-scope': 'upgrade' });
    expect(res.status).toBe(201);
    createdWorkspaces.push(res.body.id);
    const added = (await ledger()).filter((r) => !before.includes(r.id));
    expect(added.map((r) => [r.workspace_id, r.is_initial])).toEqual([[res.body.id, true]]);
  });

  it('LH-1 /healthz says only whether the upgrade failed: a boolean, no version, step, state word or message', async () => {
    const res = await http().get('/healthz');
    expect(res.status).toBe(200);
    const upgrade = res.body?.info?.upgrade ?? res.body?.details?.upgrade;
    // Owner decision 2026-11-14: exactly { status: 'up', upgradeFailed }. A fresh install at the code's version: false.
    expect(upgrade).toEqual({ status: 'up', upgradeFailed: false });
    expect(JSON.stringify(res.body)).not.toMatch(HEALTHZ_FORBIDDEN);
  });

  it('LH-2 the admin health report carries the upgrade state (the banner), never error_message; a failed latest attempt shows failed', async () => {
    forgetAdminReport();
    let res = await http().get('/rest/v1/admin/health/report').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.upgrade ?? {}).sort()).toEqual(['appVersion', 'at', 'attempt', 'executedByVersion', 'forced', 'state', 'step']);
    expect(JSON.stringify(res.body)).not.toMatch(/error_message|errorMessage/);

    // A failed newer attempt of the current version's last step (superuser fixture), then removed again.
    const steps = B1.stepsOf(B1.currentVersion);
    const last = steps[steps.length - 1]!;
    const [{ next }] = await admin.query('SELECT coalesce(max(attempt), 0) + 1 AS next FROM core.upgrade_migration WHERE name = $1 AND workspace_id IS NULL', [last]);
    const [{ id }] = await admin.query(
      "INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced) VALUES ($1, 'failed', $2, $3, 'b2 planted secret-looking text password=planted', false, NULL, false) RETURNING id::text",
      [last, next, B1.currentVersion],
    );
    try {
      forgetAdminReport();
      forgetStatus();
      res = await http().get('/rest/v1/admin/health/report').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.upgrade).toMatchObject({ state: 'failed', step: last, attempt: next });
      // The banner card: degraded, names the step and attempt, never the stored message.
      const card = (res.body.cards as { key: string; status: string; detail: string }[]).find((c) => c.key === 'upgrade');
      expect(card?.status).toBe('degraded');
      expect(card?.detail).toContain(last);
      expect(JSON.stringify(res.body)).not.toMatch(/planted/);
      // /healthz follows the logbook too: upgradeFailed true and nothing else, still 200, no step, version or message.
      forgetStatus();
      const hz = await http().get('/healthz');
      expect(hz.status).toBe(200);
      const up = hz.body?.info?.upgrade ?? hz.body?.details?.upgrade;
      expect(up).toEqual({ status: 'up', upgradeFailed: true });
      expect(JSON.stringify(hz.body)).not.toMatch(/planted/);
      expect(JSON.stringify(hz.body)).not.toMatch(HEALTHZ_FORBIDDEN);
    } finally {
      await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [id]);
      forgetAdminReport();
      forgetStatus();
    }
    const nonAdmin = await ceoToken('b2-ledger-nonadmin');
    const denied = await http().get('/rest/v1/admin/health/report').set('Authorization', `Bearer ${nonAdmin.token}`);
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toMatch(/executedByVersion/);
  });
});
