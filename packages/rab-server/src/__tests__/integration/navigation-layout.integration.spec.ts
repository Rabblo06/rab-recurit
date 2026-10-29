/**
 * Phase A gating: `RealtimeEventService.record()` writes a `core.realtime_event` row only when REALTIME_ENABLED is true
 * (the SSE gateway serves nobody otherwise). This suite asserts the rows real producers write, i.e. the realtime-ON
 * behaviour, so it turns the flag on BEFORE ANY import (the config snapshot is taken at import time — see
 * realtime-gateway.integration.spec.ts). The flag-OFF behaviour is proven in realtime-push-gating.integration.spec.ts.
 */
process.env.REALTIME_ENABLED = 'true';

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RealtimeEventService } from '../../engine/core-modules/realtime/realtime-event.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Personal navigation layout (draft/Save/Cancel editor, 2026-10-20) on real PostgreSQL with RLS: save semantics
 * (revision, replay, conflict, rollback), validation, re-checking referenced records, isolation between users /
 * workspaces / organisations, raw RLS under the runtime role, and the web-only / inspect / CSRF restrictions.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeIfDb('navigation layout (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let runtime: DataSource;
  let factory: TestIdentityFactory;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'object', label: 'Shifts', icon: 'shift', target: 'shifts', parentId: null, ...extra });
  const put = (token: string, body: Record<string, unknown>) => http().put('/rest/v1/navigation-layout').set(bearer(token)).send(body);
  const rows = async (userId: string) => (await owner.query(`SELECT revision, items, last_request_id FROM core.navigation_layout WHERE user_id = $1`, [userId])) as Array<{ revision: number; items: unknown[] }>;
  const audits = async (userId: string) => Number((await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'navigation_layout.saved' AND entity_id = $1`, [userId]))[0].n);

  async function manager(label: string): Promise<{ id: TestIdentity; token: string }> {
    const id = await factory.createInternalManager(await factory.createOrganisation(label), { permissions: 'production' });
    return { id, token: await factory.login(id) };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    runtime = moduleRef.get(DataSource); // the app's own runtime identity (crewflow_app), RLS-bound
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  it('GET starts empty at revision 0; one Save writes one revision, one audit row and one targeted realtime event', async () => {
    const a = await manager('nav-basic');
    const empty = await http().get('/rest/v1/navigation-layout').set(bearer(a.token));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ scope: 'personal', revision: 0, items: [] });
    const saved = await put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [item('s1'), { id: 'f1', kind: 'folder', label: 'Weekend', icon: 'folder', target: null, parentId: null }, { id: 'l1', kind: 'link', label: 'Rota', icon: 'link', target: 'https://docs.example.com/rota', parentId: 'f1' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    expect(saved.body.items.map((i: { id: string }) => i.id)).toEqual(['s1', 'f1', 'l1']);
    expect((await http().get('/rest/v1/navigation-layout').set(bearer(a.token))).body.revision).toBe(1);
    expect(await audits(a.id.userId)).toBe(1);
    const events = await owner.query(`SELECT target_user_id, event_type FROM core.realtime_event WHERE entity_id = $1 AND event_type = 'navigation_layout.saved'`, [a.id.userId]);
    expect(events).toEqual([{ target_user_id: a.id.userId, event_type: 'navigation_layout.saved' }]);
  });

  it('a stale base revision is a 409 and changes nothing; a retried request after a lost response is replayed, not applied twice', async () => {
    const a = await manager('nav-rev');
    const requestId = randomUUID();
    expect((await put(a.token, { baseRevision: 0, requestId, items: [item('s1')] })).status).toBe(200);
    const retry = await put(a.token, { baseRevision: 0, requestId, items: [item('s1')] });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ revision: 1, replayed: true });
    const stale = await put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [item('s1'), item('s2', { target: 'offers', label: 'Offers' })] });
    expect(stale.status).toBe(409);
    expect(stale.body.currentRevision).toBe(1);
    expect((await rows(a.id.userId))[0]!.revision).toBe(1);
    expect(await audits(a.id.userId)).toBe(1);
  });

  it('two concurrent saves from the same revision: exactly one commits, the other conflicts (no silent overwrite)', async () => {
    const a = await manager('nav-race');
    const [r1, r2] = await Promise.all([
      put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [item('s1')] }),
      put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [item('s2', { target: 'offers', label: 'Offers' })] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const [row] = await rows(a.id.userId);
    expect(row!.revision).toBe(1);
    expect(await audits(a.id.userId)).toBe(1);
  });

  it.each([
    ['javascript link', [{ id: 'l', kind: 'link', label: 'x', icon: 'link', target: 'javascript:alert(1)', parentId: null }]],
    ['credentials in link', [{ id: 'l', kind: 'link', label: 'x', icon: 'link', target: 'https://u:p@example.com', parentId: null }]],
    ['nested folder (cycle-capable)', [{ id: 'a', kind: 'folder', label: 'A', icon: 'folder', target: null, parentId: null }, { id: 'b', kind: 'folder', label: 'B', icon: 'folder', target: null, parentId: 'a' }]],
    ['parent that is not a folder', [item('s1'), item('s2', { target: 'offers', parentId: 's1' })]],
    ['unknown view / free query', [{ id: 'v', kind: 'view', label: 'x', icon: 'view', target: '/shifts?sql=1', parentId: null }]],
    ['duplicate destination', [item('s1'), item('s2')]],
    ['html-ish control characters in label', [item('s1', { label: 'a\u0000b' })]],
    ['too many items', Array.from({ length: 41 }, (_, i) => item(`s${i}`, { target: i ? 'calendar' : 'shifts' }))],
  ])('rejects %s with 400 and writes nothing', async (_name, items) => {
    const a = await manager('nav-bad');
    const res = await put(a.token, { baseRevision: 0, requestId: randomUUID(), items });
    expect(res.status).toBe(400);
    expect(await rows(a.id.userId)).toEqual([]);
  });

  it('mass assignment of owner/organisation/workspace is a 400 (forbidNonWhitelisted)', async () => {
    const a = await manager('nav-mass');
    for (const field of ['organisationId', 'workspaceId', 'userId', 'revision', 'scope']) {
      const res = await put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [], [field]: 'x' });
      expect(res.status).toBe(400);
    }
  });

  it('records are re-checked at save: own staff OK; another workspace’s staff (same organisation) is refused; Audit Log needs AUDIT_VIEW', async () => {
    const org = await factory.createOrganisation('nav-records');
    const mA = await factory.createInternalManager(org, { permissions: 'production' });
    const mB = await factory.createInternalManager(org, { permissions: 'production' });
    const own = await factory.createStaff(org, { owner: mA });
    const foreign = await factory.createStaff(org, { owner: mB });
    const tokenA = await factory.login(mA);
    const ok = await put(tokenA, { baseRevision: 0, requestId: randomUUID(), items: [{ id: 'r1', kind: 'record', label: 'Mine', icon: 'person', target: `Staff:${own.profileId}`, parentId: null }] });
    expect(ok.status).toBe(200);
    const bad = await put(tokenA, { baseRevision: 1, requestId: randomUUID(), items: [{ id: 'r2', kind: 'record', label: 'Theirs', icon: 'person', target: `Staff:${foreign.profileId}`, parentId: null }] });
    expect(bad.status).toBe(400);
    expect((await rows(mA.userId))[0]!.revision).toBe(1);

    const limited = await factory.createInternalManager(await factory.createOrganisation('nav-noaudit'), { permissions: ['staff.view', 'venue.view'] });
    const audit = await put(await factory.login(limited), { baseRevision: 0, requestId: randomUUID(), items: [item('a1', { target: 'audit', label: 'Audit' })] });
    expect(audit.status).toBe(400);
  });

  it('isolation: another Manager (same organisation, other workspace) and another organisation see and change only their own layout', async () => {
    const org = await factory.createOrganisation('nav-iso');
    const mA = await factory.createInternalManager(org, { permissions: 'production' });
    const mB = await factory.createInternalManager(org, { permissions: 'production' });
    const c = await manager('nav-iso-other');
    const [tA, tB] = [await factory.login(mA), await factory.login(mB)];
    expect((await put(tA, { baseRevision: 0, requestId: randomUUID(), items: [item('s1')] })).status).toBe(200);
    expect((await http().get('/rest/v1/navigation-layout').set(bearer(tB))).body).toMatchObject({ revision: 0, items: [] });
    expect((await http().get('/rest/v1/navigation-layout').set(bearer(c.token))).body).toMatchObject({ revision: 0, items: [] });
    expect((await put(tB, { baseRevision: 0, requestId: randomUUID(), items: [] })).status).toBe(200);
    expect((await rows(mA.userId))[0]!.items).toHaveLength(1); // A untouched by B's save
  });

  it('raw RLS under the runtime role: no context → zero rows and refused writes; one user cannot read/update/insert another’s row; context never leaks across transactions', async () => {
    const org = await factory.createOrganisation('nav-rls');
    const mA = await factory.createInternalManager(org, { permissions: 'production' });
    const mB = await factory.createInternalManager(org, { permissions: 'production' });
    expect((await put(await factory.login(mA), { baseRevision: 0, requestId: randomUUID(), items: [item('s1')] })).status).toBe(200);
    const [{ role }] = await runtime.query(`SELECT current_user AS role`);
    const [{ rolbypassrls }] = await runtime.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rolbypassrls).toBe(false);
    expect(await runtime.query(`SELECT * FROM core.navigation_layout WHERE user_id = $1`, [mA.userId])).toEqual([]); // no context
    await expect(runtime.query(`INSERT INTO core.navigation_layout (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [org.id, mA.workspaceId, mA.userId])).rejects.toThrow(/row-level security/);
    const asB = async <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<T>) => Promise<T>) => runtime.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [org.id, mB.workspaceId, mB.userId]);
      return fn((sql, p) => m.query(sql, p as unknown[]));
    });
    await asB(async (q) => {
      expect(await q(`SELECT * FROM core.navigation_layout WHERE user_id = $1`, [mA.userId])).toEqual([]);
      expect(await q(`UPDATE core.navigation_layout SET items = '[]'::jsonb WHERE user_id = $1 RETURNING id`, [mA.userId])).toEqual([[], 0]); // [rows, affected]
      return undefined as never;
    });
    await expect(asB((q) => q(`INSERT INTO core.navigation_layout (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [org.id, mA.workspaceId, mA.userId]))).rejects.toThrow(/row-level security/);
    await expect(asB((q) => q(`INSERT INTO core.navigation_layout (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [randomUUID(), mB.workspaceId, mB.userId]))).rejects.toThrow();
    // Pooled connection after a context-bound transaction: still no context.
    expect(await runtime.query(`SELECT current_setting('rab.user_id', true) AS uid`)).toEqual([{ uid: '' }]);
    expect(await runtime.query(`SELECT * FROM core.navigation_layout`)).toEqual([]);
    expect((await rows(mA.userId))[0]!.items).toHaveLength(1);
    expect(role).toBeTruthy();
  });

  it('a failure midway through the save transaction rolls back the layout, the audit row and the event', async () => {
    const a = await manager('nav-rollback');
    expect((await put(a.token, { baseRevision: 0, requestId: randomUUID(), items: [item('s1')] })).status).toBe(200);
    const spy = jest.spyOn(app.get(RealtimeEventService), 'record').mockRejectedValueOnce(new Error('simulated failure after the layout write'));
    const res = await put(a.token, { baseRevision: 1, requestId: randomUUID(), items: [item('s1'), item('s2', { target: 'offers', label: 'Offers' })] });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(calls).toBe(1); // failed AFTER the layout UPDATE and the audit insert, not before
    const [row] = await rows(a.id.userId);
    expect(row!.revision).toBe(1);
    expect(row!.items).toHaveLength(1);
    expect(await audits(a.id.userId)).toBe(1);
    // The same edit succeeds once nothing fails — the 500 above was the simulated failure, not a broken update path.
    const retry = await put(a.token, { baseRevision: 1, requestId: randomUUID(), items: [item('s1'), item('s2', { target: 'offers', label: 'Offers' })] });
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(2);
    expect(await audits(a.id.userId)).toBe(2);
  });

  it('web only, never while inspecting, and a cookie mutation from an untrusted origin is refused (CSRF)', async () => {
    const org = await factory.createOrganisation('nav-guards');
    const m = await factory.createInternalManager(org, { permissions: 'production' });
    const mobile = await factory.login(m, { applicationTarget: 'staff_app' });
    expect((await put(mobile, { baseRevision: 0, requestId: randomUUID(), items: [] })).status).toBe(403);

    const admin = await factory.createInternalManager(org, { permissions: 'production', platformAdmin: true });
    const adminToken = await factory.login(admin);
    const started = await http().post(`/rest/v1/admin/inspect/${m.userId}`).set(bearer(adminToken));
    expect(started.status).toBe(201);
    const inspect = { ...bearer(adminToken), 'x-inspect-session-id': started.body.sessionId as string };
    expect((await http().put('/rest/v1/navigation-layout').set(inspect).send({ baseRevision: 0, requestId: randomUUID(), items: [] })).status).toBe(403);
    await http().post('/rest/v1/admin/inspect/end').set(bearer(adminToken));

    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: m.email, password: m.password, applicationTarget: 'manager_web' });
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewflow_session='))!.split(';')[0]!;
    const csrf = await http().put('/rest/v1/navigation-layout').set({ Cookie: cookie, Origin: 'https://evil.example' }).send({ baseRevision: 0, requestId: randomUUID(), items: [] });
    expect(csrf.status).toBe(403);
    const ok = await http().put('/rest/v1/navigation-layout').set({ Cookie: cookie, Origin: ORIGIN }).send({ baseRevision: 0, requestId: randomUUID(), items: [item('s1')] });
    expect(ok.status).toBe(200);
    expect(await rows(m.userId)).toHaveLength(1);
  });

  it('saving navigation never changes business records', async () => {
    const org = await factory.createOrganisation('nav-business');
    const m = await factory.createInternalManager(org, { permissions: 'production' });
    const s = await factory.createStaff(org, { owner: m });
    const count = async () => Number((await owner.query(`SELECT (SELECT count(*) FROM core.staff_profile WHERE organisation_id = $1) + (SELECT count(*) FROM core."user" WHERE organisation_id = $1) AS n`, [org.id]))[0].n);
    const before = await count();
    const token = await factory.login(m);
    expect((await put(token, { baseRevision: 0, requestId: randomUUID(), items: [{ id: 'r', kind: 'record', label: 'S', icon: 'person', target: `Staff:${s.profileId}`, parentId: null }] })).status).toBe(200);
    expect((await put(token, { baseRevision: 1, requestId: randomUUID(), items: [] })).status).toBe(200); // removing the shortcut
    expect(await count()).toBe(before);
  });
});
