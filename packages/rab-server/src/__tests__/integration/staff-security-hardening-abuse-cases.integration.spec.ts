import 'reflect-metadata';
import { UserStatus, PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { idsOf, rowsOf } from './helpers/response-shapes';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Covers the concrete gaps found during the Staff data-model/security
 * audit: `jobRoleId` was org-checked but not ownership-checked (a real
 * IDOR — Manager A could assign Manager B's private job role by guessing
 * its UUID), `create()` had no unique-violation race backstop, staffRef
 * had no case-insensitive collision check, DOB had no bounds validation,
 * and the list endpoint returned DOB/emergency-contact for every row.
 * Real Postgres, RLS on, no mocks — matches this repo's standing pattern.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('staff security hardening abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_EDIT,
    PermissionFlag.STAFF_DEACTIVATE,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.AUDIT_VIEW,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  async function seedOrgWithManagers(count: number): Promise<{ organisation: Organisation; managers: Array<{ email: string; userId: string }> }> {
    // Canonical Internal Managers (role `manager`, ManagerProfile, own workspace) — see helpers/test-identities.ts.
    return factory.createOrganisationWithManagers(count, { permissions: MANAGER_PERMS, firstIsPlatformAdmin: false, workspace: true });
  }

  async function login(email: string): Promise<string> {
    return factory.loginByEmail(email);
  }

  async function createJobRole(token: string, name = `Role-${randomUUID()}`): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, defaultRatePence: 1200 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function staffPayload(overrides: Record<string, unknown> = {}) {
    return {
      email: `staff-${randomUUID()}@example.test`,
      firstName: 'A',
      lastName: 'B',
      staffRef: `S-${randomUUID().slice(0, 8)}`,
      ...overrides,
    };
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
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('Manager B cannot assign Manager A\'s private job role to their own Staff at creation — 404, not silently ignored', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const jobRoleAId = await createJobRole(tokenA);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenB}`)
      .send(staffPayload({ jobRoleId: jobRoleAId }));
    expect(res.status).toBe(404);
  });

  it("Manager B cannot assign Manager A's private job role to their own Staff via update — 404", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const jobRoleAId = await createJobRole(tokenA);

    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenB}`)
      .send(staffPayload());
    expect(createRes.status).toBe(201);

    const patchRes = await request(app.getHttpServer())
      .patch(`/rest/v1/staff/${createRes.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ jobRoleId: jobRoleAId });
    expect(patchRes.status).toBe(404);
  });

  it("Manager B assigning their own job role still works — this isn't a blanket lock", async () => {
    const { managers } = await seedOrgWithManagers(1);
    const [a] = managers;
    const tokenA = await login(a!.email);
    const jobRoleId = await createJobRole(tokenA);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ jobRoleId }));
    expect(res.status).toBe(201);
    expect(res.body.jobRoleId).toBe(jobRoleId);
  });

  it('a nonexistent job role id is rejected as 404, not a silent null-out', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ jobRoleId: randomUUID() }));
    expect(res.status).toBe(404);
  });

  it('two concurrent creates for the same (case-varying) staffRef: exactly one succeeds, the other gets a controlled 409, never a raw 500', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const ref = `RACE-${randomUUID().slice(0, 8)}`;

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer()).post('/rest/v1/staff').set('Authorization', `Bearer ${tokenA}`).send(staffPayload({ staffRef: ref.toUpperCase() })),
      request(app.getHttpServer()).post('/rest/v1/staff').set('Authorization', `Bearer ${tokenA}`).send(staffPayload({ staffRef: ref.toLowerCase() })),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('a same-case duplicate staffRef, created sequentially, is rejected by the case-insensitive pre-check (409)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const ref = `DUP-${randomUUID().slice(0, 8)}`;

    const first = await request(app.getHttpServer()).post('/rest/v1/staff').set('Authorization', `Bearer ${tokenA}`).send(staffPayload({ staffRef: ref }));
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ staffRef: ref.toLowerCase() === ref ? ref.toUpperCase() : ref.toLowerCase() }));
    expect(second.status).toBe(409);
  });

  it('a future date of birth is rejected (400)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ dateOfBirth: future }));
    expect(res.status).toBe(400);
  });

  it('an unrealistic date of birth (e.g. 130 years old) is rejected (400)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ dateOfBirth: '1890-01-01' }));
    expect(res.status).toBe(400);
  });

  it('a realistic date of birth is accepted', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ dateOfBirth: '1995-06-15' }));
    expect(res.status).toBe(201);
  });

  it('a negative default pay rate is rejected (400)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ defaultPayRatePence: -100 }));
    expect(res.status).toBe(400);
  });

  it('an invalid phone format is rejected (400), a valid international one is accepted', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const bad = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ phone: 'not-a-phone-number!!' }));
    expect(bad.status).toBe(400);

    const good = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ phone: '+1 (555) 123-4567' }));
    expect(good.status).toBe(201);
  });

  it('GET /staff (list) never returns dateOfBirth or emergency contact fields — GET /staff/:id (detail) still does', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const create = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({
        dateOfBirth: '1995-06-15',
        emergencyContactName: 'Jane Doe',
        emergencyContactRelationship: 'Spouse',
        emergencyContactPhone: '+15551234567',
      }));
    expect(create.status).toBe(201);

    const list = await request(app.getHttpServer()).get('/rest/v1/staff').set('Authorization', `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    const row = rowsOf<Record<string, unknown> & { id: string }>(list.body).find((r) => r.id === create.body.id);
    expect(row).toBeDefined(); // the row MUST be in the list — a missing row must never pass the field-absence checks vacuously
    expect(row!.dateOfBirth).toBeUndefined();
    expect(row!.emergencyContactName).toBeUndefined();
    expect(row!.emergencyContactRelationship).toBeUndefined();
    expect(row!.emergencyContactPhone).toBeUndefined();

    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.status).toBe(200);
    expect(detail.body.dateOfBirth).toBe('1995-06-15');
    expect(detail.body.emergencyContactName).toBe('Jane Doe');
  });

  it('cannot set organisationId, workspaceId, createdBy, or employmentStatus from the request body — DTO whitelist rejects them', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload({ organisationId: randomUUID(), workspaceId: randomUUID(), createdBy: randomUUID(), employmentStatus: 'active' }));
    expect(res.status).toBe(400);
  });

  it('updating a Staff member writes one PROFILE_UPDATED audit entry naming the changed fields, never the sensitive values themselves', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const create = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(staffPayload());
    expect(create.status).toBe(201);

    const patch = await request(app.getHttpServer())
      .patch(`/rest/v1/staff/${create.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ dateOfBirth: '1990-01-01', emergencyContactName: 'New Contact' });
    expect(patch.status).toBe(200);

    // Read back through the real, RLS-respecting API — the acting manager
    // IS the actor of record for this entry, and `GET /audit-logs` is
    // actor-scoped (Piece 1's own fix, earlier this session), so their own
    // token sees it directly. (A raw admin-role query without tenant
    // context bound would correctly see zero rows here too — `audit_log`
    // is FORCE-RLS'd, and FORCE applies even to the table owner; that's
    // the fail-closed behaviour working as intended, not a way to verify
    // an insert.)
    const auditList = await request(app.getHttpServer())
      .get('/rest/v1/audit-logs')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(auditList.status).toBe(200);
    const entry = auditList.body.items.find((i: { action: string }) => i.action === 'profile.updated');
    expect(entry).toBeDefined();
    const fields: string[] = entry.metadata.fields;
    expect(fields).toEqual(expect.arrayContaining(['dateOfBirth', 'emergencyContactName']));
    expect(JSON.stringify(entry.metadata)).not.toContain('1990-01-01');
    expect(JSON.stringify(entry.metadata)).not.toContain('New Contact');
  });

  it('a query with no tenant context bound returns zero rows for staff_profile', async () => {
    const rows = await dataSource.manager.query(`SELECT id FROM core.staff_profile LIMIT 1`);
    expect(rows).toEqual([]);
  });
});
