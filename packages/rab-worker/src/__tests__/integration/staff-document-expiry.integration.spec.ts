import 'reflect-metadata';
import './helpers/local-storage-env';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';
import {
  dueThreshold,
  runStaffDocumentExpiryCycle,
} from '../../queues/rab-reports/staff-document-expiry.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Lane D PR 4: staff document expiry alerts at 30 / 7 / 0 days. Real HTTP uploads, real Postgres/RLS, the real cycle with a
 * fixed `today`. Idempotent (a second run notifies nobody), per threshold (the 7-day notice still comes after the 30-day
 * one), per tenant (another organisation's documents never reach this organisation's people), and a revoked or already
 * expired document gets nothing.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(240_000);

describe('dueThreshold', () => {
  it('the tightest threshold reached, or none', () => {
    expect([45, 31, 30, 29, 8, 7, 6, 1, 0, -1].map(dueThreshold)).toEqual([
      null,
      null,
      30,
      30,
      30,
      7,
      7,
      7,
      0,
      null,
    ]);
  });
});

describeIfDb('staff document expiry alerts (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let notifications: NotificationService;
  let factory: TestIdentityFactory;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const pdf = () => Buffer.from('%PDF-1.4\n%%EOF\n');

  async function org(label: string): Promise<{
    orgId: string;
    a: TestIdentity;
    s1: TestIdentity;
    token: string;
  }> {
    const seeded = await factory.createOrganisationWithManagers(1, {
      workspace: true,
      permissions: 'production',
      label,
    });
    const a = seeded.managers[0]!;
    const s1 = await factory.createStaff(
      { id: seeded.organisation.id },
      { owner: a, label: `${label}-s1` },
    );
    return {
      orgId: seeded.organisation.id,
      a,
      s1,
      token: await factory.login(a),
    };
  }

  async function upload(
    token: string,
    staff: TestIdentity,
    expiresOn: string,
  ): Promise<string> {
    const res = await http()
      .post(`/rest/v1/staff/${staff.profileId}/documents`)
      .set(auth(token))
      .field('documentType', 'right_to_work')
      .field('expiresOn', expiresOn)
      .attach('file', pdf(), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    if (res.status !== 201)
      throw new Error(
        `upload failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body.id as string;
  }

  const alertsFor = async (
    userId: string,
  ): Promise<Array<{ related_entity_id: string; title: string }>> =>
    adminDataSource.query(
      `SELECT related_entity_id, title FROM core.notification WHERE user_id = $1 AND type = 'staff_document_expiring' ORDER BY created_at, id`,
      [userId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    notifications = moduleRef.get(NotificationService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('30 / 7 / 0 days: the staff member and the workspace owner, once per threshold; revoked and expired skipped; tenant-isolated', async () => {
    const w = await org('docexp');
    const other = await org('docexp-other');
    const in30 = await upload(w.token, w.s1, '2030-01-31');
    const in7 = await upload(w.token, w.s1, '2030-01-08');
    const today = await upload(w.token, w.s1, '2030-01-01');
    const revoked = await upload(w.token, w.s1, '2030-01-05');
    expect(
      (
        await http()
          .post(`/rest/v1/staff/${w.s1.profileId}/documents/${revoked}/revoke`)
          .set(auth(w.token))
          .send({ reason: 'Uploaded in error' })
      ).status,
    ).toBe(200);
    await upload(w.token, w.s1, '2029-12-31'); // already expired on 2030-01-01
    await upload(other.token, other.s1, '2030-01-08');

    const first = await runStaffDocumentExpiryCycle(
      adminDataSource,
      tenantContext,
      notifications,
      { organisationId: w.orgId, today: '2030-01-01' },
    );
    expect(first.notified).toBe(3);
    const staffAlerts = await alertsFor(w.s1.userId);
    expect(staffAlerts.map((n) => n.related_entity_id).sort()).toEqual(
      [in30, in7, today].sort(),
    );
    expect(
      staffAlerts.find((n) => n.related_entity_id === today)!.title,
    ).toMatch(/expires today/);
    expect(
      (await alertsFor(w.a.userId)).map((n) => n.related_entity_id).sort(),
    ).toEqual([in30, in7, today].sort());
    // The other organisation was not in scope of this run and its people got nothing from this organisation.
    expect(await alertsFor(other.s1.userId)).toEqual([]);

    // Idempotent: the same day again notifies nobody.
    expect(
      (
        await runStaffDocumentExpiryCycle(
          adminDataSource,
          tenantContext,
          notifications,
          { organisationId: w.orgId, today: '2030-01-01' },
        )
      ).notified,
    ).toBe(0);
    expect(await alertsFor(w.s1.userId)).toHaveLength(3);

    // Seven days before the first document's expiry: its 7-day notice (a NEW threshold) is sent, nothing else.
    const later = await runStaffDocumentExpiryCycle(
      adminDataSource,
      tenantContext,
      notifications,
      { organisationId: w.orgId, today: '2030-01-24' },
    );
    expect(later.notified).toBe(1);
    const after = await alertsFor(w.s1.userId);
    expect(after).toHaveLength(4);
    expect(after[3]!.related_entity_id).toBe(in30);
  });

  it('review L1: documents of one staff member reaching the same threshold together are ONE notice each to the staff member and the owner', async () => {
    const w = await org('docexp-coalesce');
    const docs = [
      await upload(w.token, w.s1, '2030-01-04'),
      await upload(w.token, w.s1, '2030-01-05'),
      await upload(w.token, w.s1, '2030-01-06'),
    ];
    const run = await runStaffDocumentExpiryCycle(
      adminDataSource,
      tenantContext,
      notifications,
      { organisationId: w.orgId, today: '2030-01-01' },
    );
    expect(run.notified).toBe(3); // three documents covered ...
    const owner = await alertsFor(w.a.userId);
    expect(owner).toHaveLength(1); // ... by one owner notice
    expect(owner[0]!.title).toMatch(/expiring soon/);
    expect(await alertsFor(w.s1.userId)).toHaveLength(1);
    // Every document was claimed: a second run sends nothing.
    expect(
      (
        await runStaffDocumentExpiryCycle(
          adminDataSource,
          tenantContext,
          notifications,
          { organisationId: w.orgId, today: '2030-01-01' },
        )
      ).notified,
    ).toBe(0);
    expect(docs).toHaveLength(3);
  });
});
