import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { BadRequestException, ForbiddenException, HttpException, INestApplication, NotFoundException } from '@nestjs/common';
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
 * Copy previous week (M2): `POST /shifts/copy-previous-week[/preview]` → DraftShiftBatchService. Abuse cases first
 * (architecture §1.2 style): the flag is re-checked in the service (a direct caller with the flag revoked gets 403 and
 * nothing is written), a Venue Manager is refused at the route, another manager's shifts are never read, another
 * manager's / organisation's venue is a 404, and a body carrying organisationId / status / pay is a 400. Then the
 * happy path: new rows are DRAFTs with no assignment, offer or publication, and a second confirm creates nothing.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Copy previous week (integration)', () => {
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

  // Each test uses its own target week (weeks ahead, so every copied shift is in the future and weeks never overlap).
  let weekOffset = 3;
  const nextWeek = () => addDays(localDate(new Date(), 'Europe/London'), 7 * weekOffset++);
  /** A shift on day `day` (0–6) of the week BEFORE `weekStart`, 10:00–16:00 UTC (inside the London-local day). */
  const sourceWindow = (weekStart: string, day: number) => {
    const date = addDays(weekStart, day - 7);
    return { startsAt: `${date}T10:00:00.000Z`, endsAt: `${date}T16:00:00.000Z` };
  };
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
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'copywk' });
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

  it('copies the previous week as new DRAFTs: no publication, assignment, offer or recurrence; pay re-resolved; audited', async () => {
    const weekStart = nextWeek();
    const published = await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 0), requiredCount: 2, notes: 'Bring ID', breakMinutes: 30 } as never);
    await scheduling.publish(ctxA, published.id);
    const draft = await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 3), requiredCount: 1, payRatePence: 9999 } as never);
    const cancelled = await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 4), requiredCount: 1 } as never);
    await scheduling.publish(ctxA, cancelled.id);
    await scheduling.cancel(ctxA, cancelled.id, 'not needed');

    const preview = await batch.previewCopyPreviousWeek(ctxA, { weekStart });
    expect(preview.rows.map((r) => [r.key, r.outcome])).toEqual([
      [published.id, 'create'],
      [draft.id, 'create'],
    ]); // the cancelled shift is not a source
    expect(JSON.stringify(preview)).not.toMatch(/payRate|pay_rate|9999/);
    expect(await shiftCount(ctxA, addDays(weekStart, 0), addDays(weekStart, 7))).toBe(0); // preview wrote nothing

    const result = await batch.copyPreviousWeek(ctxA, { weekStart });
    expect(result.created).toHaveLength(2);
    const shiftTable = await businessTableOf(admin, 'shift', published.id);
    for (const { key, shiftId } of result.created) {
      const [row] = await admin.query(
        `SELECT status, published_at, filled_count, recurrence_group_id, created_by, pay_rate_pence, required_count, notes, break_minutes, starts_at, ends_at FROM ${shiftTable} WHERE id = $1`,
        [shiftId],
      );
      const [source] = await admin.query(`SELECT starts_at, ends_at, required_count, notes, break_minutes FROM ${shiftTable} WHERE id = $1`, [key]);
      expect(row).toMatchObject({ status: ShiftStatus.DRAFT, published_at: null, filled_count: 0, recurrence_group_id: null, created_by: a.userId });
      expect(row.pay_rate_pence).toBe('1400'); // resolved for the new date: the source's manual 9999 is not carried
      expect(new Date(row.starts_at).getTime() - new Date(source.starts_at).getTime()).toBe(7 * 86_400_000);
      expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(new Date(source.ends_at).getTime() - new Date(source.starts_at).getTime());
      expect(row).toMatchObject({ required_count: source.required_count, notes: source.notes, break_minutes: source.break_minutes });
      const offers = await admin.query(
        `SELECT count(*)::int AS n FROM ${siblingTable(shiftTable, 'job_offer')} o JOIN ${siblingTable(shiftTable, 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1`,
        [shiftId],
      );
      const seats = await admin.query(`SELECT count(*)::int AS n FROM ${siblingTable(shiftTable, 'shift_assignment')} WHERE shift_id = $1`, [shiftId]);
      expect([offers[0].n, seats[0].n]).toEqual([0, 0]);
      const audit = await admin.query(`SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'shift.created' AND entity_id = $2`, [orgId, shiftId]);
      expect(audit).toHaveLength(1);
    }

    // A second confirm is idempotent: every row is now `already_exists`.
    const again = await batch.copyPreviousWeek(ctxA, { weekStart });
    expect(again.created).toEqual([]);
    expect(again.rows.every((r) => r.outcome === 'skip' && r.reason === 'already_exists')).toBe(true);
  });

  it('confirm with sourceShiftIds copies only those; others are reported not_selected', async () => {
    const weekStart = nextWeek();
    const keep = await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 1), requiredCount: 1 } as never);
    const drop = await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 2), requiredCount: 1 } as never);
    const result = await batch.copyPreviousWeek(ctxA, { weekStart, sourceShiftIds: [keep.id] });
    expect(result.created.map((c) => c.key)).toEqual([keep.id]);
    expect(result.rows.find((r) => r.key === drop.id)).toMatchObject({ outcome: 'skip', reason: 'not_selected' });
  });

  it('abuse: SCHEDULE_BULK revoked (SCHEDULE_CREATE kept) → 403 at the route and in the service; nothing written', async () => {
    const weekStart = nextWeek();
    await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 1), requiredCount: 1 } as never);
    await withRevoked(a, PermissionFlag.SCHEDULE_BULK, async () => {
      await expect(batch.previewCopyPreviousWeek(ctxA, { weekStart })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(batch.copyPreviousWeek(ctxA, { weekStart })).rejects.toBeInstanceOf(ForbiddenException);
      const token = await factory.login(a);
      expect((await http().post('/rest/v1/shifts/copy-previous-week').set('Authorization', `Bearer ${token}`).send({ weekStart })).status).toBe(403);
      expect((await http().post('/rest/v1/shifts/copy-previous-week/preview').set('Authorization', `Bearer ${token}`).send({ weekStart })).status).toBe(403);
    });
    expect(await shiftCount(ctxA, weekStart, addDays(weekStart, 7))).toBe(0);
  });

  it('two confirms of the same week at once (two tabs, a retry) create each draft once, not twice', async () => {
    const weekStart = nextWeek();
    for (const day of [0, 2, 4]) await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, day), requiredCount: 1 } as never);
    const [first, second] = await Promise.all([batch.copyPreviousWeek(ctxA, { weekStart }), batch.copyPreviousWeek(ctxA, { weekStart })]);
    expect(first.created.length + second.created.length).toBe(3);
    expect(await shiftCount(ctxA, weekStart, addDays(weekStart, 7))).toBe(3);
  });

  it('EXPENSIVE class: the 11th bulk-scheduling call in a minute is refused with 429 (per user)', async () => {
    const fresh = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'copywk-rate' });
    const ctx = ctxOf(fresh.managers[0]!);
    const previous = process.env.RAB_DISABLE_RATE_LIMIT;
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
    try {
      const weekStart = nextWeek();
      for (let i = 0; i < 10; i++) await batch.previewCopyPreviousWeek(ctx, { weekStart });
      const refused = await batch.previewCopyPreviousWeek(ctx, { weekStart }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(429);
    } finally {
      if (previous === undefined) delete process.env.RAB_DISABLE_RATE_LIMIT;
      else process.env.RAB_DISABLE_RATE_LIMIT = previous;
    }
  });

  it('abuse: SCHEDULE_CREATE revoked → the SERVICE refuses preview and confirm with 403 and writes nothing', async () => {
    const weekStart = nextWeek();
    await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 1), requiredCount: 1 } as never);
    await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
      await expect(batch.previewCopyPreviousWeek(ctxA, { weekStart })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(batch.copyPreviousWeek(ctxA, { weekStart })).rejects.toBeInstanceOf(ForbiddenException);
      const token = await factory.login(a);
      const res = await http().post('/rest/v1/shifts/copy-previous-week').set('Authorization', `Bearer ${token}`).send({ weekStart });
      expect(res.status).toBe(403);
    });
    expect(await shiftCount(ctxA, weekStart, addDays(weekStart, 7))).toBe(0);
  });

  it('abuse: another manager never reads my week (copies nothing of mine); my venue is a 404 to them', async () => {
    const weekStart = nextWeek();
    await scheduling.create(ctxA, { venueId, jobRoleId, ...sourceWindow(weekStart, 2), requiredCount: 1 } as never);
    const ctxB = ctxOf(b);
    const preview = await batch.previewCopyPreviousWeek(ctxB, { weekStart });
    expect(preview.rows).toEqual([]);
    expect((await batch.copyPreviousWeek(ctxB, { weekStart })).created).toEqual([]);
    await expect(batch.previewCopyPreviousWeek(ctxB, { weekStart, venueId })).rejects.toBeInstanceOf(NotFoundException);
    await expect(batch.copyPreviousWeek(ctxB, { weekStart, venueId })).rejects.toBeInstanceOf(NotFoundException);
    expect(await shiftCount(ctxA, weekStart, addDays(weekStart, 7))).toBe(0);
  });

  it('abuse: another organisation’s venue is a 404, never a 403', async () => {
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'copywk-x' });
    const foreign = other.managers[0]!;
    const foreignVenue = (await venues.create(ctxOf(foreign), { name: `Foreign ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    await expect(batch.previewCopyPreviousWeek(ctxA, { weekStart: nextWeek(), venueId: foreignVenue })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('abuse: a Venue Manager is refused at the route; organisationId / status / pay in the body → 400; a bad date → 400', async () => {
    const vm = await factory.createVenueManager({ id: orgId }, { owner: a, venueIds: [venueId] });
    const vmToken = await factory.login(vm);
    const vmRes = await http().post('/rest/v1/shifts/copy-previous-week/preview').set('Authorization', `Bearer ${vmToken}`).send({ weekStart: nextWeek() });
    expect(vmRes.status).toBe(403);

    const token = await factory.login(a);
    const weekStart = nextWeek();
    for (const extra of [{ organisationId: orgId }, { status: 'open' }, { payRatePence: 1 }, { createdBy: b.userId }]) {
      const res = await http().post('/rest/v1/shifts/copy-previous-week').set('Authorization', `Bearer ${token}`).send({ weekStart, ...extra });
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 });
    }
    for (const bad of ['2026-02-30', '2026-7-1', 'next monday']) {
      expect((await http().post('/rest/v1/shifts/copy-previous-week/preview').set('Authorization', `Bearer ${token}`).send({ weekStart: bad })).status).toBe(400);
    }
    await expect(batch.previewCopyPreviousWeek(ctxA, { weekStart: '2026-02-30' })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await http().post('/rest/v1/shifts/copy-previous-week/preview').set('Authorization', `Bearer ${token}`).send({ weekStart });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ timezone: expect.any(String), createCount: 0, rows: [] });
  });
});
