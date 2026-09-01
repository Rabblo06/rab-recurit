import 'reflect-metadata';
import { ManagerType, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, User } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * `ManagerWorkspace` — a private, individually-owned workspace per Manager.
 * Real Postgres, RLS on, no mocks, matching this repo's standing
 * abuse-case pattern.
 *
 * `manager_workspace`'s RLS is intentionally NOT the usual single
 * tenant-scoped policy — but it is also NOT the permissive `USING (true)`
 * SELECT design an earlier iteration of this migration briefly had.
 * `ManagerWorkspaceRls1786667900000` found and closed that as a real,
 * confirmed enumeration vulnerability (any authenticated user could read
 * every workspace's id/owner/name/subdomain/logo/status) — the current,
 * final shape is two narrow policies: `manager_workspace_write` (FOR ALL,
 * `owner_user_id = current_uid()`) and `manager_workspace_member` (FOR
 * SELECT, `id = current_workspace() OR owner_user_id = current_uid()` —
 * the `owner_user_id` branch was added by `ManagerWorkspaceSelectOwner
 * Visibility1786669000000` specifically so a Manager's own first-ever
 * workspace INSERT...RETURNING can see the row it just created, before
 * `current_workspace()` reflects it). Cross-tenant subdomain-availability
 * checking never needed a broad SELECT policy at all — it goes through
 * `core.workspace_subdomain_taken()`, a narrow SECURITY DEFINER function
 * returning a bare boolean, never a row. See the "no enumeration" describe
 * block below for the direct, raw-SQL `rab_app` proof of all of this.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('manager workspace abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  /** One org, N Managers, each with a real ManagerProfile row and a login-capable User. */
  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: { email: string; userId: string }[];
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    const managers: { email: string; userId: string }[] = [];
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
      for (let i = 0; i < count; i++) {
        const email = `manager-${i}-${randomUUID()}@example.test`;
        const passwordHash = await passwordHashing.hash(password);
        const userResult = await m.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: `Manager${i}`,
          lastName: 'Test',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3)`, [
          organisation.id,
          userId,
          ManagerType.INTERNAL,
        ]);
        managers.push({ email, userId });
      }
    });

    return { organisation, managers };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('a fresh available subdomain creates successfully and records an audit entry', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);
    const subdomain = `issac-${randomUUID().slice(0, 8)}`;

    const res = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Issac Recruitment', subdomain });
    expect(res.status).toBe(201);
    expect(res.body.subdomain).toBe(subdomain);

    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: managers[0]!.userId, role: '' },
      (m) =>
        m.query(`SELECT actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action = 'manager_workspace.created'`, [
          organisation.id,
        ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(managers[0]!.userId);
  });

  it('a taken subdomain returns a suggested alternative, not a dead-end 409', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));
    const subdomain = `queen-${randomUUID().slice(0, 8)}`;

    const first = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Queen', subdomain });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Queen', subdomain });
    expect(second.status).toBe(409);
    expect(second.body.suggested).toBe(`${subdomain}01`);
  });

  it('a reserved name is rejected with no suffixed variant offered', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Admin Co', subdomain: 'admin' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This subdomain cannot be used.');
    expect(res.body.suggested).toBeUndefined();
  });

  it('a Manager who already owns a workspace gets 409 on a second create', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const first = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'First', subdomain: `first-${randomUUID().slice(0, 8)}` });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second', subdomain: `second-${randomUUID().slice(0, 8)}` });
    expect(second.status).toBe(409);
  });

  it('two concurrent creation requests for the same subdomain produce exactly one row', async () => {
    const { organisation, managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));
    const subdomain = `race-${randomUUID().slice(0, 8)}`;

    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Race A', subdomain }),
      request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Race B', subdomain }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await adminDataSource.manager.query(`SELECT id FROM core.manager_workspace WHERE organisation_id = $1 AND subdomain = $2`, [
      organisation.id,
      subdomain,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('a client-supplied ownerUserId/organisationId in the body is rejected by DTO whitelisting', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Hijack',
        subdomain: `hijack-${randomUUID().slice(0, 8)}`,
        ownerUserId: randomUUID(),
        organisationId: organisation.id,
      });
    expect(res.status).toBe(400);
  });

  it("Manager B never sees Manager A's workspace — GET /me is always the caller's own, and there is no id-addressable route", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));

    const createA = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Manager A Workspace', subdomain: `mgra-${randomUUID().slice(0, 8)}` });
    expect(createA.status).toBe(201);

    const getMeB = await request(app.getHttpServer()).get('/rest/v1/manager-workspaces/me').set('Authorization', `Bearer ${tokenB}`);
    expect(getMeB.status).toBe(404);

    const getMeA = await request(app.getHttpServer()).get('/rest/v1/manager-workspaces/me').set('Authorization', `Bearer ${tokenA}`);
    expect(getMeA.status).toBe(200);
    expect(getMeA.body.id).toBe(createA.body.id);
  });

  it('case-insensitive collision is caught ("Issac" vs "issac")', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));
    const base = `issac-${randomUUID().slice(0, 8)}`;

    const first = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Issac', subdomain: base });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Issac Again', subdomain: base.toUpperCase() });
    expect(second.status).toBe(409);
  });

  it('a Staff account (no ManagerProfile) cannot create a workspace', async () => {
    const { organisation } = await seedOrgWithManagers(0);
    const email = `staff-${randomUUID()}@example.test`;
    const passwordHash = await passwordHashing.hash(password);
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, (m) =>
      m.insert(User, { organisationId: organisation.id, email, passwordHash, firstName: 'Staff', lastName: 'Test', status: UserStatus.ACTIVE }),
    );
    const token = await login(email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should Fail', subdomain: `nope-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(404);
  });

  it('POST /subdomain/check reports availability and a suggestion for a taken name', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));
    const subdomain = `check-${randomUUID().slice(0, 8)}`;

    const fresh = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/subdomain/check')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ candidate: subdomain });
    expect(fresh.status).toBe(201);
    expect(fresh.body).toEqual({ available: true, normalized: subdomain, reserved: false });

    await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Taken', subdomain });

    const taken = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/subdomain/check')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ candidate: subdomain });
    expect(taken.status).toBe(201);
    expect(taken.body.available).toBe(false);
    expect(taken.body.suggested).toBe(`${subdomain}01`);
  });

  it('PATCH /me/subdomain changes the caller\'s own workspace subdomain and records an audit entry', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);
    const original = `orig-${randomUUID().slice(0, 8)}`;
    const renamed = `renamed-${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Rename Me', subdomain: original });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch('/rest/v1/manager-workspaces/me/subdomain')
      .set('Authorization', `Bearer ${token}`)
      .send({ subdomain: renamed });
    expect(patched.status).toBe(200);
    expect(patched.body.subdomain).toBe(renamed);

    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: managers[0]!.userId, role: '' },
      (m) =>
        m.query(
          `SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'manager_workspace.subdomain_changed'`,
          [organisation.id],
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ oldSubdomain: original, newSubdomain: renamed });
  });

  it('PATCH /profile updates jobTitle on the caller\'s own ManagerProfile only, never another Manager\'s', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));

    const patchA = await request(app.getHttpServer())
      .patch('/rest/v1/profile')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ jobTitle: 'Head of Placements' });
    expect(patchA.status).toBe(200);
    expect(patchA.body.jobTitle).toBe('Head of Placements');

    const getB = await request(app.getHttpServer()).get('/rest/v1/profile').set('Authorization', `Bearer ${tokenB}`);
    expect(getB.status).toBe(200);
    expect(getB.body.jobTitle).toBeNull();
  });

  it('PATCH /me updates the name without touching the subdomain', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);
    const subdomain = `nameonly-${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Old Name', subdomain });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch('/rest/v1/manager-workspaces/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('New Name');
    expect(patched.body.subdomain).toBe(subdomain);
  });

  it('logo upload/delete are owner-only and clear on delete', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [tokenA, tokenB] = await Promise.all(managers.map((m) => login(m.email)));

    const created = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Logo Test', subdomain: `logo-${randomUUID().slice(0, 8)}` });
    expect(created.status).toBe(201);

    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const uploadA = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/me/logo')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPng, 'logo.png');
    expect(uploadA.status).toBe(201);
    expect(uploadA.body.logoKey).toBeTruthy();

    // Manager B, who has no workspace of their own, has nothing to upload to — 404, not the wrong workspace.
    const uploadB = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/me/logo')
      .set('Authorization', `Bearer ${tokenB}`)
      .attach('file', tinyPng, 'logo.png');
    expect(uploadB.status).toBe(404);

    const deleteA = await request(app.getHttpServer()).delete('/rest/v1/manager-workspaces/me/logo').set('Authorization', `Bearer ${tokenA}`);
    expect(deleteA.status).toBe(200);
    expect(deleteA.body.logoKey).toBeNull();
  });

  it('complete-onboarding sets onboardingCompletedAt, is idempotent, and only affects the caller\'s own workspace', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const created = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Onboard Me', subdomain: `onboard-${randomUUID().slice(0, 8)}` });
    expect(created.body.onboardingCompletedAt).toBeNull();

    const first = await request(app.getHttpServer()).post('/rest/v1/manager-workspaces/me/complete-onboarding').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.onboardingCompletedAt).not.toBeNull();

    const second = await request(app.getHttpServer()).post('/rest/v1/manager-workspaces/me/complete-onboarding').set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);

    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: managers[0]!.userId, role: '' },
      (m) => m.query(`SELECT actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action = 'manager_workspace.onboarding_completed'`, [organisation.id]),
    );
    expect(rows).toHaveLength(2);
  });

  it('a write with no tenant context bound is rejected (SELECT is narrowly self/owner-scoped on this table, not permissive — see the top-of-file note)', async () => {
    await expect(
      dataSource.manager.query(`INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain) VALUES ($1, $2, $3, $4)`, [
        randomUUID(),
        randomUUID(),
        'No Context',
        `nocontext-${randomUUID().slice(0, 8)}`,
      ]),
    ).rejects.toThrow();
  });

  describe('no cross-Manager enumeration (Stage 2A final verification)', () => {
    it('the exact final RLS policies on manager_workspace: no permissive USING(true) or equivalent remains', async () => {
      const policies = await dataSource.manager.query<Array<{ polname: string; polcmd: string; using_expr: string | null; with_check_expr: string | null }>>(
        `SELECT polname, polcmd,
                pg_get_expr(polqual, polrelid) AS using_expr,
                pg_get_expr(polwithcheck, polrelid) AS with_check_expr
           FROM pg_policy WHERE polrelid = 'core.manager_workspace'::regclass
          ORDER BY polname`,
      );
      expect(policies).toHaveLength(2);

      const write = policies.find((p) => p.polname === 'manager_workspace_write')!;
      expect(write.polcmd).toBe('*');
      expect(write.using_expr).toBe('(owner_user_id = core.current_uid())');
      expect(write.with_check_expr).toBe('(owner_user_id = core.current_uid())');

      const member = policies.find((p) => p.polname === 'manager_workspace_member')!;
      expect(member.polcmd).toBe('r'); // SELECT
      expect(member.using_expr).toBe('((id = core.current_workspace()) OR (owner_user_id = core.current_uid()))');
      expect(member.with_check_expr).toBeNull();

      // No policy anywhere on this table evaluates to an unconditional
      // `true` — the literal shape the retired vulnerability had.
      for (const p of policies) {
        expect(p.using_expr).not.toBe('true');
        expect(p.using_expr).not.toContain(' true)');
      }
    });

    it('Manager A can read Workspace A directly; cannot SELECT Workspace B by id; cannot enumerate it through a list query; obtains none of its owner/name/subdomain/logo/onboarding metadata', async () => {
      const { managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const tokenA = await login(a!.email);

      const createA = await request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Manager A Real Workspace', subdomain: `mgra-${randomUUID().slice(0, 8)}` });
      expect(createA.status).toBe(201);
      const workspaceAId = createA.body.id as string;

      const tokenB = await login(b!.email);
      const createB = await request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Manager B Real Workspace', subdomain: `mgrb-${randomUUID().slice(0, 8)}` });
      expect(createB.status).toBe(201);
      const workspaceBId = createB.body.id as string;

      // Raw SQL as rab_app, bound to Manager A's own real, resolved context
      // — deliberately no service layer, no controller, proving RLS itself,
      // not route design, is what blocks this.
      const orgRow = await adminDataSource.manager.query<Array<{ organisation_id: string }>>(
        `SELECT organisation_id FROM core.manager_workspace WHERE id = $1`,
        [workspaceAId],
      );
      const organisationId = orgRow[0]!.organisation_id;

      // Workspace A's own bound context: can read its own row directly by id.
      const ownRow = await tenantContext.runInTenantContext(
        { organisationId, workspaceId: workspaceAId, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT id, owner_user_id, name, subdomain, logo_key, status, onboarding_completed_at FROM core.manager_workspace WHERE id = $1`, [workspaceAId]),
      );
      expect(ownRow).toHaveLength(1);
      expect(ownRow[0].id).toBe(workspaceAId);

      // Direct SELECT of Workspace B by id, from Workspace A's own bound
      // context — must come back empty, not an error and not the row.
      const byIdB = await tenantContext.runInTenantContext(
        { organisationId, workspaceId: workspaceAId, userId: a!.userId, role: '' },
        (m) => m.query(`SELECT id, owner_user_id, name, subdomain, logo_key, status, onboarding_completed_at FROM core.manager_workspace WHERE id = $1`, [workspaceBId]),
      );
      expect(byIdB).toHaveLength(0);

      // Enumeration via a plain, unfiltered list query — never returns
      // Workspace B's id (or anyone else's) alongside Workspace A's own.
      const listRows = await tenantContext.runInTenantContext(
        { organisationId, workspaceId: workspaceAId, userId: a!.userId, role: '' },
        (m) => m.query<Array<{ id: string }>>(`SELECT id FROM core.manager_workspace`),
      );
      const listedIds = listRows.map((r) => r.id);
      expect(listedIds).toContain(workspaceAId);
      expect(listedIds).not.toContain(workspaceBId);
    });

    it('POST /subdomain/check on a taken subdomain returns only {available, normalized, reserved, suggested, alternatives} — never owner/workspace metadata', async () => {
      const { managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const tokenA = await login(a!.email);
      const subdomain = `leaktest-${randomUUID().slice(0, 8)}`;
      const createA = await request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Leak Test Owner', subdomain });
      expect(createA.status).toBe(201);

      const tokenB = await login(b!.email);
      const checkRes = await request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces/subdomain/check')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ candidate: subdomain });
      expect(checkRes.status).toBe(201);
      expect(Object.keys(checkRes.body).sort()).toEqual(['alternatives', 'available', 'normalized', 'reserved', 'suggested'].sort());
      expect(checkRes.body.available).toBe(false);
      expect(JSON.stringify(checkRes.body)).not.toContain(a!.userId);
      expect(JSON.stringify(checkRes.body).toLowerCase()).not.toContain('leak test owner');
    });
  });
});
