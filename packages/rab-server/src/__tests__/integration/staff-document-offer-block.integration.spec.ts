import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Lane D PR 3: an expired REQUIRED staff document blocks NEW offers, with the reason code the manager sees.
 *
 * Abuse cases: the bulk-offer path cannot bypass the block (the blocked recipient is reported with the code, the others
 * still get their offer); single send answers 409 STAFF_REQUIRED_DOCUMENT_EXPIRED; an expired document of a type the
 * organisation does NOT require blocks nothing; a missing document blocks nothing (owner decision pending); a current
 * document of the same type satisfies the requirement; an offer sent before expiry is not revoked.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(180_000);

describeIfDb('staff documents: offer block (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;

  const pdf = () => Buffer.from('%PDF-1.4\n%%EOF\n');
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface World {
    orgId: string;
    a: TestIdentity;
    token: string;
    shiftId: string;
  }

  async function world(): Promise<World> {
    const { organisation, managers } =
      await factory.createOrganisationWithManagers(1, { workspace: true });
    const a = managers[0]!;
    const token = await factory.login(a);
    const venue = await http()
      .post('/rest/v1/venues')
      .set(auth(token))
      .send({ name: `Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    expect(venue.status).toBe(201);
    const role = await http()
      .post('/rest/v1/job-roles')
      .set(auth(token))
      .send({ name: `Role-${randomUUID()}`, defaultRatePence: 1200 });
    expect(role.status).toBe(201);
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 6 * 3600 * 1000);
    const shift = await http()
      .post('/rest/v1/shifts')
      .set(auth(token))
      .send({
        venueId: venue.body.id,
        jobRoleId: role.body.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        requiredCount: 3,
      });
    expect(shift.status).toBe(201);
    expect(
      (
        await http()
          .post(`/rest/v1/shifts/${shift.body.id}/publish`)
          .set(auth(token))
      ).status,
    ).toBe(201);
    return {
      orgId: organisation.id,
      a,
      token,
      shiftId: shift.body.id as string,
    };
  }

  async function activeStaff(w: World, label: string): Promise<TestIdentity> {
    const staff = await factory.createStaff(
      { id: w.orgId },
      { owner: w.a, label },
    );
    await adminDataSource.query(
      `UPDATE ${businessTable(w.a.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = $1`,
      [staff.profileId],
    );
    return staff;
  }

  const uploadDoc = async (
    w: World,
    staff: TestIdentity,
    documentType: string,
    expiresOn: string,
  ) => {
    const res = await http()
      .post(`/rest/v1/staff/${staff.profileId}/documents`)
      .set(auth(w.token))
      .field('documentType', documentType)
      .field('expiresOn', expiresOn)
      .attach('file', pdf(), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
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
    app.getHttpServer().closeAllConnections?.();
    await app.close();
    await adminDataSource.destroy();
  });

  it('single send: an expired Right to Work (required by default) is a 409 with the reason code', async () => {
    const w = await world();
    const staff = await activeStaff(w, 'expired');
    await uploadDoc(w, staff, 'right_to_work', '2020-01-31');
    const res = await http()
      .post(`/rest/v1/shifts/${w.shiftId}/offers`)
      .set(auth(w.token))
      .send({ staffProfileId: staff.profileId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STAFF_REQUIRED_DOCUMENT_EXPIRED');
    expect(res.body.message).toContain('Right to work (expired 2020-01-31)');
  });

  it('bulk send cannot bypass the block: the blocked recipient is reported with the code, the others are offered', async () => {
    const w = await world();
    const blocked = await activeStaff(w, 'blocked');
    const fine = await activeStaff(w, 'fine');
    const missing = await activeStaff(w, 'missing');
    await uploadDoc(w, blocked, 'right_to_work', '2020-01-31');
    await uploadDoc(w, fine, 'right_to_work', '2099-12-31');
    const res = await http()
      .post(`/rest/v1/shifts/${w.shiftId}/offers/bulk`)
      .set(auth(w.token))
      .send({
        staffProfileIds: [blocked.profileId, fine.profileId, missing.profileId],
      });
    expect(res.status).toBe(201);
    const byStaff = Object.fromEntries(
      (
        res.body.results as Array<{
          staffProfileId: string;
          ok: boolean;
          message?: string;
        }>
      ).map((r) => [r.staffProfileId, r]),
    );
    expect(byStaff[blocked.profileId!]).toMatchObject({ ok: false });
    expect(byStaff[blocked.profileId!]!.message).toContain(
      'STAFF_REQUIRED_DOCUMENT_EXPIRED',
    );
    expect(byStaff[fine.profileId!]).toMatchObject({ ok: true });
    // Missing evidence does not block (OWNER DECISION pending).
    expect(byStaff[missing.profileId!]).toMatchObject({ ok: true });
    const seats = await adminDataSource.query(
      `SELECT staff_profile_id FROM ${businessTable(w.a.workspaceId!, 'shift_assignment')} WHERE shift_id = $1`,
      [w.shiftId],
    );
    expect(
      seats.map((s: { staff_profile_id: string }) => s.staff_profile_id).sort(),
    ).toEqual([fine.profileId, missing.profileId].sort());
  });

  it('a newer current document of the same type satisfies the requirement; a revoked one does not count', async () => {
    const w = await world();
    const staff = await activeStaff(w, 'renewed');
    await uploadDoc(w, staff, 'right_to_work', '2020-01-31');
    const current = await uploadDoc(w, staff, 'right_to_work', '2099-12-31');
    const revoke = await http()
      .post(`/rest/v1/staff/${staff.profileId}/documents/${current}/revoke`)
      .set(auth(w.token))
      .send({ reason: 'Superseded in error' });
    expect(revoke.status).toBe(200);
    expect(
      (
        await http()
          .post(`/rest/v1/shifts/${w.shiftId}/offers`)
          .set(auth(w.token))
          .send({ staffProfileId: staff.profileId })
      ).status,
    ).toBe(409);
    await uploadDoc(w, staff, 'right_to_work', '2099-12-31');
    expect(
      (
        await http()
          .post(`/rest/v1/shifts/${w.shiftId}/offers`)
          .set(auth(w.token))
          .send({ staffProfileId: staff.profileId })
      ).status,
    ).toBe(201);
  });

  it('a type the organisation does not require blocks nothing; once required, it blocks', async () => {
    const w = await world();
    const staff = await activeStaff(w, 'dbs');
    await uploadDoc(w, staff, 'dbs_check', '2020-01-31');
    const other = await activeStaff(w, 'dbs2');
    await uploadDoc(w, other, 'dbs_check', '2020-01-31');
    expect(
      (
        await http()
          .post(`/rest/v1/shifts/${w.shiftId}/offers`)
          .set(auth(w.token))
          .send({ staffProfileId: staff.profileId })
      ).status,
    ).toBe(201);
    expect(
      (
        await http()
          .put('/rest/v1/staff-documents/requirements')
          .set(auth(w.token))
          .send({ requiredTypes: ['dbs_check'] })
      ).status,
    ).toBe(200);
    const res = await http()
      .post(`/rest/v1/shifts/${w.shiftId}/offers`)
      .set(auth(w.token))
      .send({ staffProfileId: other.profileId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STAFF_REQUIRED_DOCUMENT_EXPIRED');
    // The offer sent before the requirement changed is not revoked.
    const seats = await adminDataSource.query(
      `SELECT status FROM ${businessTable(w.a.workspaceId!, 'shift_assignment')} WHERE shift_id = $1 AND staff_profile_id = $2`,
      [w.shiftId, staff.profileId],
    );
    expect(seats).toEqual([{ status: 'offered' }]);
  });

  it('a document expiring before the shift date blocks an offer for that shift', async () => {
    const w = await world();
    const staff = await activeStaff(w, 'soon');
    // The shift starts in 48 h; the document expires today (valid today, expired by the shift date).
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
    }).format(new Date());
    await uploadDoc(w, staff, 'right_to_work', today);
    const res = await http()
      .post(`/rest/v1/shifts/${w.shiftId}/offers`)
      .set(auth(w.token))
      .send({ staffProfileId: staff.profileId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STAFF_REQUIRED_DOCUMENT_EXPIRED');
  });
});
