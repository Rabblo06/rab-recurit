import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ShiftReportService } from '../../modules/attendance/services/shift-report.service';
import { WorkspaceService } from '../../modules/identity/services/workspace.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 (docs/plans/untangle/server-modules.md M3), part 3: the layer-2 (service) re-check of the route's own flag on the
 * VenueService (create, update, role-rate list), ShiftReportService (list, get, finalise) and WorkspaceService (settings
 * reads) methods that relied on the route guard alone.
 *
 * Every call goes to the SERVICE directly (no PermissionGuard in the path), as a job, CLI command, AI tool or another service
 * reaches it. The actor lacking the flag is the SAME identity with a real per-user `revoke` override for that one flag, so a
 * refusal can only come from the new check. Each refusal must be a ForbiddenException AND leave the organisation's rows as
 * they were (audit log, outbox, organisation, venues, venue pay rates, shift reports). Real PostgreSQL with RLS on
 * (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-2 layer-2 re-checks: venues, shift reports, workspace settings (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let venues: VenueService;
  let reports: ShiftReportService;
  let workspace: WorkspaceService;
  let orgId: string;
  let owner: TestIdentity; // Internal Manager, production permission set
  let venueId: string;
  let shiftId: string; // a started shift of the owner's, so finalise would otherwise proceed

  const ctxOf = (who: TestIdentity): AuthContext => ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' });

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  /** Runs `fn` while `flag` is revoked for `identity` by a per-user override; the override is removed afterwards, whatever happens. */
  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
      [identity.userId, identity.organisationId, flag],
    )) as unknown[];
    if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
    await bumpSecurityVersion(identity);
    try {
      return await fn();
    } finally {
      await admin.query(
        `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
        [identity.userId, flag],
      );
      await bumpSecurityVersion(identity);
    }
  }

  /** Everything a refused call could have written in this organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(): Promise<Record<string, unknown>> {
    const ws = owner.workspaceId!;
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT json_build_object('name', name, 'slug', slug) FROM core.organisation WHERE id = $1) AS organisation,
         (SELECT json_agg(json_build_object('id', id, 'name', name, 'status', status) ORDER BY id) FROM ${businessTable(ws, 'venue')} WHERE organisation_id = $1) AS venues,
         (SELECT count(*) FROM ${businessTable(ws, 'venue_role_rate')} WHERE organisation_id = $1)::int AS role_rates,
         (SELECT json_agg(json_build_object('shift', shift_id, 'status', status, 'finalised', finalised_at) ORDER BY shift_id) FROM ${businessTable(ws, 'shift_report')} WHERE organisation_id = $1) AS reports,
         (SELECT json_agg(json_build_object('id', id, 'status', status) ORDER BY id) FROM ${businessTable(ws, 'shift')} WHERE organisation_id = $1) AS shifts`,
      [orgId],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  /** The call is refused with 403 and nothing in the organisation changed. */
  async function expectRefusedAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(await snapshot()).toEqual(before);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    venues = moduleRef.get(VenueService);
    reports = moduleRef.get(ShiftReportService);
    workspace = moduleRef.get(WorkspaceService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sf2c' });
    orgId = seeded.organisation.id;
    owner = seeded.managers[0]!;
    venueId = (await venues.create(ctxOf(owner), { name: `SF2c Venue ${randomUUID().slice(0, 8)}`, type: 'hotel' } as never)).id;
    shiftId = await tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      const jr = await m.save(JobRole, { organisationId: orgId, name: `SF2c Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const startsAt = new Date(Date.now() - 2 * 3600 * 1000);
      const endsAt = new Date(Date.now() + 2 * 3600 * 1000);
      const shift = await m.save(Shift, {
        organisationId: orgId, venueId, jobRoleId: jr.id, startsAt, endsAt, defaultStartsAt: startsAt, defaultEndsAt: endsAt, breakMinutes: 0,
        requiredCount: 1, payRatePence: 1500, status: ShiftStatus.IN_PROGRESS, createdBy: owner.userId, workspaceId: owner.workspaceId!,
      } as Partial<Shift>);
      return shift.id;
    });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── VenueService

  it('create without venue.create → 403, no venue row', async () => {
    await withRevoked(owner, PermissionFlag.VENUE_CREATE, () =>
      expectRefusedAndInert(() => venues.create(ctxOf(owner), { name: `SF2c New ${randomUUID().slice(0, 8)}`, type: 'hotel' } as never)),
    );
  });

  it('update without venue.edit → 403 for the own venue AND an unknown id (no existence oracle), the name is unchanged', async () => {
    await withRevoked(owner, PermissionFlag.VENUE_EDIT, async () => {
      for (const id of [venueId, randomUUID()]) await expectRefusedAndInert(() => venues.update(ctxOf(owner), id, { name: 'Renamed' } as never));
    });
  });

  it('role-rate list without venue.view → 403 for the own venue and an unknown id; with it, the list works', async () => {
    await withRevoked(owner, PermissionFlag.VENUE_VIEW, async () => {
      for (const id of [venueId, randomUUID()]) await expectRefusedAndInert(() => venues.listRoleRates(ctxOf(owner), id));
    });
    await expect(venues.listRoleRates(ctxOf(owner), venueId)).resolves.toEqual(expect.any(Array));
  });

  // ─────────────────────────────────────────────── ShiftReportService

  it('report reads without report.view → 403 for a real and an unknown shift, nothing written', async () => {
    await withRevoked(owner, PermissionFlag.REPORT_VIEW, async () => {
      await expectRefusedAndInert(() => reports.listReports(ctxOf(owner), {} as never));
      for (const id of [shiftId, randomUUID()]) await expectRefusedAndInert(() => reports.getReport(ctxOf(owner), id));
      // The finalise route returns the report under its own flag (report.export), so that read is unchanged.
      expect((await reports.getReport(ctxOf(owner), shiftId, PermissionFlag.REPORT_EXPORT)).shiftId).toBe(shiftId);
    });
  });

  it('finalise without report.export → 403, no report row is finalised; the post-finalise read under report.export is refused too', async () => {
    await withRevoked(owner, PermissionFlag.REPORT_EXPORT, async () => {
      await expectRefusedAndInert(() => reports.finalise(ctxOf(owner), shiftId, {}));
      await expectRefusedAndInert(() => reports.getReport(ctxOf(owner), shiftId, PermissionFlag.REPORT_EXPORT));
    });
  });

  it('getReport fails closed on any flag other than the two route flags', async () => {
    await expectRefusedAndInert(() => reports.getReport(ctxOf(owner), shiftId, PermissionFlag.STAFF_VIEW as never));
  });

  // ─────────────────────────────────────────────── WorkspaceService

  it('organisation settings reads without settings.view → 403; with it they work', async () => {
    await withRevoked(owner, PermissionFlag.SETTINGS_VIEW, async () => {
      await expectRefusedAndInert(() => workspace.get(ctxOf(owner)));
      await expectRefusedAndInert(() => workspace.getAuthProviders(ctxOf(owner)));
    });
    expect((await workspace.get(ctxOf(owner))).id).toBe(orgId);
    await expect(workspace.getAuthProviders(ctxOf(owner))).resolves.toMatchObject({ password: expect.any(Object) });
  });

  // ─────────────────────────────────────────────── HTTP path unchanged

  it('HTTP behaviour is unchanged: the route guard answers 403 first, 200 with the flag', async () => {
    const http = () => request(app.getHttpServer());
    const token = await factory.login(owner);
    await withRevoked(owner, PermissionFlag.VENUE_VIEW, async () => {
      expect((await http().get(`/rest/v1/venues/${venueId}/role-rates`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });
    expect((await http().get(`/rest/v1/venues/${venueId}/role-rates`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await http().get(`/rest/v1/attendance/report/shift/${shiftId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await http().get('/rest/v1/workspace').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });
});
