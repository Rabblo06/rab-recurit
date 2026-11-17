import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { UpdateStaffDto } from '../../modules/staff/dto/update-staff.dto';
import { StaffService } from '../../modules/staff/services/staff.service';
import { CreateVenueDto } from '../../modules/venue/dto/create-venue.dto';
import { UpdateVenueRoleRateDto } from '../../modules/venue/dto/update-venue-role-rate.dto';
import { UpdateVenueDto } from '../../modules/venue/dto/update-venue.dto';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { businessTable } from './helpers/hws-fixtures';

/**
 * SF-7 abuse cases: a DIRECT (non-HTTP) caller — a job, a CLI command, another service — never passes the global
 * ValidationPipe, so `forbidNonWhitelisted` does not protect it. Each former DTO spread / merge site is called directly with
 * fields the DTO does not declare (`staffRef`, `createdBy`, `status`, `employmentStatus`, `jobRoleId`, `venueId`); none of
 * them may reach the row, while the declared field in the same call is written. Real PostgreSQL, RLS on.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-7: undeclared fields never reach an entity write (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let staffService: StaffService;
  let venueService: VenueService;
  let a: TestIdentity;
  let b: TestIdentity;
  let tokenA: string;
  let ctxA: AuthContext;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const row = async (table: string, id: string) => (await admin.query(`SELECT * FROM ${businessTable(a.workspaceId!, table)} WHERE id = $1`, [id]))[0];

  async function createVenue(name: string): Promise<string> {
    const res = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name, type: 'hotel' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createJobRole(): Promise<string> {
    const res = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Sf7 Role ${randomUUID().slice(0, 8)}`, defaultRatePence: 1500 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    staffService = moduleRef.get(StaffService);
    venueService = moduleRef.get(VenueService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'sf7' });
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    tokenA = await factory.login(a);
    ctxA = { organisationId: a.organisationId, workspaceId: a.workspaceId, userId: a.userId, role: '' } as AuthContext;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('StaffService.update: staffRef, createdBy and employmentStatus on a direct call are not written; the declared field is', async () => {
    const staff = await factory.createStaff({ id: a.organisationId }, { owner: a, label: 'sf7s' });
    const before = await row('staff_profile', staff.profileId!);

    const hostile = { preferredName: 'Kept', staffRef: 'SF7-HACKED', createdBy: b.userId, employmentStatus: 'inactive' };
    await staffService.update(ctxA, staff.profileId!, hostile as unknown as UpdateStaffDto);

    const after = await row('staff_profile', staff.profileId!);
    expect(after.preferred_name).toBe('Kept');
    expect(after.staff_ref).toBe(before.staff_ref);
    expect(after.created_by).toBe(a.userId);
    expect(after.employment_status).toBe(before.employment_status);
    // The audit row lists only the field that was actually written.
    const [audit] = await admin.query(
      `SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND target_user_id = $2 AND action = 'profile.updated' ORDER BY created_at DESC LIMIT 1`,
      [a.organisationId, staff.userId],
    );
    expect(audit?.metadata?.fields).toEqual(['preferredName']);
  });

  it('VenueService.create: status and createdBy on a direct call are not written; the tenant and owner columns are the caller\'s', async () => {
    const name = `Sf7 Create ${randomUUID().slice(0, 8)}`;
    const hostile = { name, type: 'hotel', status: 'archived', createdBy: b.userId, archivedAt: new Date().toISOString() };
    const created = await venueService.create(ctxA, hostile as unknown as CreateVenueDto);

    const stored = await row('venue', created.id);
    expect(stored.name).toBe(name);
    expect(stored.status).toBe('active');
    expect(stored.archived_at).toBeNull();
    expect(stored.created_by).toBe(a.userId);
    expect(stored.organisation_id).toBe(a.organisationId);
    expect(stored.workspace_id).toBe(a.workspaceId);
  });

  it('VenueService.update: status and createdBy on a direct call are not merged; the declared field is', async () => {
    const venueId = await createVenue(`Sf7 Update ${randomUUID().slice(0, 8)}`);
    const hostile = { name: 'Sf7 Renamed', status: 'archived', createdBy: b.userId };
    await venueService.update(ctxA, venueId, hostile as unknown as UpdateVenueDto);

    const stored = await row('venue', venueId);
    expect(stored.name).toBe('Sf7 Renamed');
    expect(stored.status).toBe('active');
    expect(stored.created_by).toBe(a.userId);
  });

  it('VenueService.updateRoleRate: jobRoleId and venueId on a direct call cannot re-point the rate; the declared field is written', async () => {
    const venueId = await createVenue(`Sf7 Rate ${randomUUID().slice(0, 8)}`);
    const otherVenueId = await createVenue(`Sf7 Rate Other ${randomUUID().slice(0, 8)}`);
    const [roleId, otherRoleId] = [await createJobRole(), await createJobRole()];
    const rate = await http().post(`/rest/v1/venues/${venueId}/role-rates`).set(auth(tokenA)).send({ jobRoleId: roleId, payRatePence: 1500 });
    expect(rate.status).toBe(201);

    const hostile = { payRatePence: 1600, jobRoleId: otherRoleId, venueId: otherVenueId };
    await venueService.updateRoleRate(ctxA, venueId, rate.body.id, hostile as unknown as UpdateVenueRoleRateDto);

    const stored = await row('venue_role_rate', rate.body.id);
    expect(Number(stored.pay_rate_pence)).toBe(1600);
    expect(stored.job_role_id).toBe(roleId);
    expect(stored.venue_id).toBe(venueId);
  });
});
