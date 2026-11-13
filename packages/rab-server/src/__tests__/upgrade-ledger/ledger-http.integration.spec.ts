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
 *   LH-1  /healthz: `upgrade.upgradeFailed` (boolean) and `upgrade.upgrade` in ok | failed | behind | ahead | none | unknown; never a step
 *         name or an error message.
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
import { ADMIN_HEALTH_CACHE_KEY } from '../../engine/core-modules/platform-admin/admin-health.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from '../integration/helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from '../integration/helpers/test-identities';
import { b1, LEDGER_SELECT_SQL, LedgerRow } from './ledger-contract';

jest.setTimeout(300_000);

const RUN = Boolean(process.env.DATABASE_URL) && b1() !== null;
const describeIfB1 = RUN ? describe : describe.skip;

describeIfB1('the logbook through the real application (new workspace, /healthz, admin banner)', () => {
  const B1 = b1()!;
  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let throttlerRedis: ThrottlerRedisClientProvider;
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
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
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
    for (const id of createdWorkspaces) await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [id]).catch(() => undefined);
    await app.close();
    await admin.destroy();
  });

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
    await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws]);
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

  it('LH-1 /healthz reports the upgrade state without a step name or a message', async () => {
    const res = await http().get('/healthz');
    expect(res.status).toBe(200);
    const upgrade = res.body?.info?.upgrade ?? res.body?.details?.upgrade;
    expect(typeof upgrade?.upgradeFailed).toBe('boolean');
    expect(['ok', 'failed', 'behind', 'ahead', 'none', 'unknown']).toContain(upgrade?.upgrade);
    // A fresh owner-login install at the code's version: the logbook says ok.
    expect(upgrade?.upgrade).toBe('ok');
    expect(JSON.stringify(res.body)).not.toMatch(/TypeOrmMigrations|_[0-9]{13}|error_message|errorMessage/);
  });

  it('LH-2 the admin health report carries the upgrade state (the banner), never error_message; a failed latest attempt shows failed', async () => {
    await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
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
      await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
      forgetStatus();
      res = await http().get('/rest/v1/admin/health/report').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.upgrade).toMatchObject({ state: 'failed', step: last, attempt: next });
      expect(JSON.stringify(res.body)).not.toMatch(/planted/);
      // /healthz follows the logbook too: upgradeFailed true, upgrade "failed", still 200, still no name or message.
      forgetStatus();
      const hz = await http().get('/healthz');
      expect(hz.status).toBe(200);
      const up = hz.body?.info?.upgrade ?? hz.body?.details?.upgrade;
      expect({ upgrade: up?.upgrade, upgradeFailed: up?.upgradeFailed }).toEqual({ upgrade: 'failed', upgradeFailed: true });
      expect(JSON.stringify(hz.body)).not.toMatch(/planted|TypeOrmMigrations/);
    } finally {
      await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [id]);
      await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
      forgetStatus();
    }
    const nonAdmin = await ceoToken('b2-ledger-nonadmin');
    const denied = await http().get('/rest/v1/admin/health/report').set('Authorization', `Bearer ${nonAdmin.token}`);
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toMatch(/executedByVersion/);
  });
});
