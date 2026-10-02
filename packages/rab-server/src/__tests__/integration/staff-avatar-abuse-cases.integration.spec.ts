import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Manager-initiated Staff avatar upload/replace/remove — a genuinely new
 * capability this session (there was previously no endpoint at all for a
 * Manager to set a Staff member's avatar; only self-service
 * `POST /profile/avatar` existed). Mirrors `ProfileService.uploadAvatar`'s
 * store-new -> swap-pointer -> tombstone-old sequencing, plus the same
 * creator-private `assertOwned` gate every other Staff mutation already
 * uses. Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(60_000);

describeIfDb('staff avatar abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const MANAGER_PERMS = [PermissionFlag.STAFF_VIEW, PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_EDIT];

  // 1x1 transparent PNG — real magic bytes, passes FileService's own sniff
  // (same fixture `multipart-upload-security.integration.spec.ts` uses).
  const tinyPngBuffer = () =>
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

  async function seedOrgWithManagers(count: number) {
    return factory.createOrganisationWithManagers(count, { permissions: MANAGER_PERMS, firstIsPlatformAdmin: false, workspace: true });
  }

  async function login(email: string): Promise<string> {
    return factory.loginByEmail(email);
  }

  function staffPayload(overrides: Record<string, unknown> = {}) {
    return {
      email: `staff-${randomUUID()}@example.test`,
      firstName: 'A',
      lastName: 'B',
      ...overrides,
    };
  }

  async function createStaff(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send(staffPayload());
    expect(res.status).toBe(201);
    return res.body.id as string;
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

  it('a first avatar upload sets avatarKey and tombstones nothing (no previous file to retire)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const staffId = await createStaff(tokenA);

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.avatarKey).toBeTruthy();

    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.avatarKey).toBe(res.body.avatarKey);
  });

  it('replacing an avatar tombstones the old StoredFile row (status DELETED) and links the new one', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const staffId = await createStaff(tokenA);

    const first = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'a.png', contentType: 'image/png' });
    expect(first.status).toBe(201);
    const oldFileId = first.body.avatarKey as string;

    const second = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'b.png', contentType: 'image/png' });
    expect(second.status).toBe(201);
    const newFileId = second.body.avatarKey as string;
    expect(newFileId).not.toBe(oldFileId);

    // `stored_file`'s RLS predicate is `organisation_id = current_org() AND
    // (workspace_id IS NULL OR workspace_id = current_workspace())` — the
    // file's own `workspace_id` is the owning Manager's real workspace
    // (Staff avatars are workspace-scoped, not org-wide), so binding
    // `workspaceId: null` here would filter every row out just like having
    // no tenant context at all. Use the same workspace the upload itself ran
    // under.
    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: managers[0]!.workspaceId, userId: randomUUID(), role: '' },
      (manager) => manager.query(
        'SELECT id, status FROM core.stored_file WHERE id = ANY($1::uuid[])',
        [[oldFileId, newFileId]],
      ),
    );
    const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId.get(oldFileId)).toBe('DELETED');
    expect(byId.get(newFileId)).toBe('AVAILABLE');

    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.avatarKey).toBe(newFileId);
  });

  it('a non-image upload (fails magic-byte sniff) is rejected (400) and leaves the existing avatar untouched', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const staffId = await createStaff(tokenA);

    const good = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(good.status).toBe(201);
    const existingFileId = good.body.avatarKey as string;

    const bad = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', Buffer.from('this is not an image at all'), { filename: 'fake.png', contentType: 'image/png' });
    expect(bad.status).toBe(400);

    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.avatarKey).toBe(existingFileId);

    const row = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: managers[0]!.workspaceId, userId: randomUUID(), role: '' },
      (manager) => manager.query('SELECT status FROM core.stored_file WHERE id = $1', [existingFileId]),
    );
    expect(row[0].status).toBe('AVAILABLE');
  });

  it("Manager B cannot upload an avatar for Manager A's Staff — 404, not 403", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const staffAId = await createStaff(tokenA);

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffAId}/avatar`)
      .set('Authorization', `Bearer ${tokenB}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });

  it("Manager B cannot remove Manager A's Staff member's avatar — 404", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const staffAId = await createStaff(tokenA);
    const upload = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffAId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);

    const res = await request(app.getHttpServer())
      .delete(`/rest/v1/staff/${staffAId}/avatar`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    // Untouched by the denied attempt.
    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffAId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.avatarKey).toBe(upload.body.avatarKey);
  });

  it('removing an avatar clears avatarKey and tombstones the file', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const staffId = await createStaff(tokenA);
    const upload = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const fileId = upload.body.avatarKey as string;

    const res = await request(app.getHttpServer())
      .delete(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.avatarKey).toBeNull();

    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(detail.body.avatarKey).toBeNull();

    const row = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: managers[0]!.workspaceId, userId: randomUUID(), role: '' },
      (manager) => manager.query('SELECT status FROM core.stored_file WHERE id = $1', [fileId]),
    );
    expect(row[0].status).toBe('DELETED');
  });

  it('a nonexistent staff id 404s on upload rather than throwing an unhandled error', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${randomUUID()}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', tinyPngBuffer(), { filename: 'avatar.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });

  it('uploading with no file attached is rejected (400)', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const tokenA = await login(managers[0]!.email);
    const staffId = await createStaff(tokenA);

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffId}/avatar`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
  });
});
