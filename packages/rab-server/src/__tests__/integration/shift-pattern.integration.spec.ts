import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { BadRequestException, ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { DraftShiftBatchService } from '../../modules/scheduling/services/draft-shift-batch.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { addDays } from '../../modules/ai/tools/ai-date-range';
import { localDate } from '../../modules/scheduling/utils/draft-batch-plan';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTableOf, siblingTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Recurring shift pattern (M2): `POST /shifts/pattern[/preview]` → DraftShiftBatchService. Abuse cases: the flag is
 * re-checked in the service (403, nothing written), another manager's / organisation's venue is a 404, a Venue Manager
 * is refused at the route, and a body carrying recurrenceGroupId / status / pay / organisationId is a 400. Happy path:
 * one server-generated recurrence group, DRAFTs only, the set-wide pre-check skips duplicates, a second run creates
 * nothing.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Recurring shift pattern (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let scheduling: SchedulingService;
  let batch: DraftShiftBatchService;
  let venues: VenueService;
  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity; // second Internal Manager, same organisation
  let ctxA: AuthContext;
  let venueId: string;
  let jobRoleId: string;

  const ctxOf = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId, userId: id.userId, role: '' });
  const http = () => request(app.getHttpServer());
  const bump = (id: TestIdentity) => admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [id.userId]);
  async function withRevoked<T>(id: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    await admin.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`, [
      id.userId,
      id.organisationId,
      flag,
    ]);
    await bump(id);
    try {
      return await fn();
    } finally {
      await admin.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [id.userId, flag]);
      await bump(id);
    }
  }

  // Each test uses its own fortnight, weeks ahead, so every occurrence is in the future and tests never overlap.
  let fortnight = 2;
  const nextRange = () => {
    const startDate = addDays(localDate(new Date(), 'Europe/London'), 14 * fortnight++);
    return { startDate, endDate: addDays(startDate, 13) };
  };
  const pattern = (over: Record<string, unknown> = {}) => ({
    venueId,
    jobRoleId,
    ...nextRange(),
    weekdays: ['Monday', 'Wednesday', 'Friday'] as never,
    startTime: '10:00',
    endTime: '16:00',
    requiredCount: 2,
    ...over,
  });
  const shiftCount = async (ctx: AuthContext, from: string, to: string) => (await scheduling.list(ctx, { from, to, limit: 200 } as never)).total;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    scheduling = moduleRef.get(SchedulingService);
    batch = moduleRef.get(DraftShiftBatchService);
    venues = moduleRef.get(VenueService);
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'pattern' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    b = seeded.managers[1]!;
    ctxA = ctxOf(a);
    venueId = (await venues.create(ctxA, { name: `Copy Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    jobRoleId = (await scheduling.createJobRole(ctxA, { name: `Copy Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1400 } as never)).id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });


  it('generates DRAFTs sharing one server-generated recurrence group; pay resolved; a second run creates nothing', async () => {
    const def = pattern();
    const preview = await batch.previewShiftPattern(ctxA, def);
    expect(preview.createCount).toBe(6); // Mon/Wed/Fri x 2 weeks
    expect(preview.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key))).toBe(true);
    expect(await shiftCount(ctxA, def.startDate, addDays(def.endDate, 1))).toBe(0); // preview wrote nothing

    const result = await batch.generateShiftPattern(ctxA, def);
    expect(result.created).toHaveLength(6);
    expect(result.recurrenceGroupId).toMatch(/^[0-9a-f-]{36}$/);
    const ids = result.created.map((c) => c.shiftId);
    const shiftTable = await businessTableOf(admin, 'shift', ids[0]);
    const rows = await admin.query(`SELECT status, recurrence_group_id, pay_rate_pence, published_at, created_by FROM ${shiftTable} WHERE id = ANY($1)`, [ids]);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row).toMatchObject({ status: ShiftStatus.DRAFT, recurrence_group_id: result.recurrenceGroupId, pay_rate_pence: '1400', published_at: null, created_by: a.userId });
    }
    const offers = await admin.query(
      `SELECT count(*)::int AS n FROM ${siblingTable(shiftTable, 'job_offer')} o JOIN ${siblingTable(shiftTable, 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = ANY($1)`,
      [ids],
    );
    expect(offers[0].n).toBe(0);

    const again = await batch.generateShiftPattern(ctxA, def);
    expect(again.created).toEqual([]);
    expect(again.recurrenceGroupId).toBeNull();
    expect(again.rows.every((r) => r.reason === 'already_exists')).toBe(true);
  });

  it('confirm with dates creates only those occurrences', async () => {
    const def = pattern({ weekdays: ['Tuesday'] });
    const preview = await batch.previewShiftPattern(ctxA, def);
    const first = preview.rows[0]!.key;
    const result = await batch.generateShiftPattern(ctxA, { ...def, dates: [first] });
    expect(result.created.map((c) => c.key)).toEqual([first]);
    expect(result.rows.filter((r) => r.reason === 'not_selected')).toHaveLength(preview.rows.length - 1);
  });

  it('abuse: SCHEDULE_CREATE revoked -> the SERVICE refuses with 403 and writes nothing', async () => {
    const def = pattern();
    await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
      await expect(batch.previewShiftPattern(ctxA, def)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(batch.generateShiftPattern(ctxA, def)).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(await shiftCount(ctxA, def.startDate, addDays(def.endDate, 1))).toBe(0);
  });

  it('abuse: another manager\'s venue and another organisation\'s venue are 404s; nothing is written', async () => {
    const def = pattern();
    await expect(batch.generateShiftPattern(ctxOf(b), def)).rejects.toBeInstanceOf(NotFoundException);
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'pattern-x' });
    const foreignVenue = (await venues.create(ctxOf(other.managers[0]!), { name: `Foreign ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    await expect(batch.generateShiftPattern(ctxA, { ...def, venueId: foreignVenue })).rejects.toBeInstanceOf(NotFoundException);
    expect(await shiftCount(ctxA, def.startDate, addDays(def.endDate, 1))).toBe(0);
  });

  it('abuse: Venue Manager -> 403; recurrenceGroupId / status / pay / organisationId in the body -> 400; bad definitions -> 400', async () => {
    const vm = await factory.createVenueManager({ id: orgId }, { owner: a, venueIds: [venueId] });
    const vmRes = await http().post('/rest/v1/shifts/pattern/preview').set('Authorization', `Bearer ${await factory.login(vm)}`).send(pattern());
    expect(vmRes.status).toBe(403);

    const token = await factory.login(a);
    const def = pattern();
    for (const extra of [{ recurrenceGroupId: randomUUID() }, { status: 'open' }, { payRatePence: 1 }, { organisationId: orgId }, { createdBy: b.userId }]) {
      const res = await http().post('/rest/v1/shifts/pattern').set('Authorization', `Bearer ${token}`).send({ ...def, ...extra });
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 });
    }
    for (const bad of [{ weekdays: ['Funday'] }, { startTime: '25:00' }, { endDate: addDays(def.startDate, 200) }, { intervalWeeks: 9 }, { startDate: '2026-02-30' }]) {
      const res = await http().post('/rest/v1/shifts/pattern/preview').set('Authorization', `Bearer ${token}`).send({ ...def, ...bad });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
    await expect(batch.previewShiftPattern(ctxA, { ...def, endTime: def.startTime })).rejects.toBeInstanceOf(BadRequestException);
    expect(await shiftCount(ctxA, def.startDate, addDays(def.endDate, 1))).toBe(0);
  });
});
