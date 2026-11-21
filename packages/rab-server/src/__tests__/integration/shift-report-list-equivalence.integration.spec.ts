import 'reflect-metadata';
import { ShiftStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { businessTables } from '../../engine/core-modules/tenant/business-tables';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { REPORT_IN_HISTORY_SQL, REPORT_NEEDS_ATTENTION_SQL } from '../../modules/attendance/services/report-lifecycle';
import { REPORT_PAGE_SQL } from '../../modules/attendance/services/shift-report.service';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * M9 load test §4.4 (PR #325, security review L): the shift-report list now pages the shifts BEFORE aggregating staff and
 * attendance. This runs the PREVIOUS statement (copied verbatim from main before #325, below) and the new REPORT_PAGE_SQL
 * in the SAME transaction (same now(), same tenant context, RLS on as the runtime role) and requires identical rows,
 * order and totals for both buckets, both scopes (Manager: shifts they created; Venue Manager: assigned venues) and
 * several pages. The fixture covers every bucket input: future / in-progress / ended inside and past the five-hour
 * window, delivered long ago and recently, failed, pending, no outbox row, a CANCELLED outbox row next to a SENT one, an
 * unfinalised report, a cancelled shift, an excluded draft, and assignments that are confirmed, completed (with and
 * without attendance, reviewed or not) and no-show.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const HOUR = 3_600_000;

/** The list statement as it was on main before #325 (REPORT_ROWS_SQL + listReports' SELECT), verbatim apart from layout. */
function legacyListSql(m: EntityManager, scopeSql: string, bucketSql: string, order: string, limitRef: string, offsetRef: string): string {
  const t = businessTables(m);
  const delivery = `count(*) FILTER (WHERE eo.status IN ('PENDING','QUEUED','PROCESSING','RETRY')) AS d_pending,
  count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent, count(*) FILTER (WHERE eo.status = 'FAILED') AS d_failed, max(eo.sent_at) AS d_last_sent_at`;
  return `WITH base AS (
  SELECT s.id AS shift_id, s.status AS shift_status, s.starts_at, s.ends_at, s.required_count, s.filled_count,
    v.name AS venue_name, jr.name AS role_name,
    COALESCE(sr.status, 'pending') AS report_status, sr.final_pdf_sent_at AS final_queued_at, sr.final_file_id,
    count(sa.id) AS staff_count,
    count(sa.id) FILTER (WHERE sa.status = 'no_show') AS no_shows,
    count(a.id) FILTER (WHERE a.status IN ('clocked_in','on_break')) AS open_attendance,
    count(a.id) AS any_attendance,
    count(a.id) FILTER (WHERE a.clock_out_at IS NOT NULL) AS clocked_out,
    count(sa.id) FILTER (WHERE sa.status <> 'no_show' AND a.clock_out_at IS NULL) AS unresolved,
    count(sa.id) FILTER (WHERE sa.attendance_reviewed_at IS NULL) AS unreviewed
  FROM ${t.shift} s
  JOIN ${t.venue} v ON v.id = s.venue_id
  JOIN ${t.job_role} jr ON jr.id = s.job_role_id
  LEFT JOIN ${t.shift_assignment} sa ON sa.shift_id = s.id AND sa.status IN ('confirmed','completed','no_show')
  LEFT JOIN ${t.attendance} a ON a.shift_assignment_id = sa.id
  LEFT JOIN ${t.shift_report} sr ON sr.shift_id = s.id
  WHERE s.organisation_id = $1 AND ${scopeSql}
    AND s.status NOT IN ('draft','pending_manager_approval','declined')
  GROUP BY s.id, v.name, jr.name, sr.id
), rows AS (
  SELECT b.*, d.* FROM base b
  LEFT JOIN LATERAL (SELECT ${delivery} FROM core.email_outbox eo
    WHERE b.final_file_id IS NOT NULL AND eo.attachment_file_id = b.final_file_id AND eo.status <> 'CANCELLED') d ON true
)
        SELECT r.*, now() AS db_now, count(*) OVER () AS total FROM rows r
        WHERE ${bucketSql}
        ORDER BY ${order}
        LIMIT ${limitRef} OFFSET ${offsetRef}`;
}

/** listReports' own bucket predicate and order. */
const bucketOf = (bucket: 'current' | 'history') => ({
  bucketSql: bucket === 'history' ? REPORT_IN_HISTORY_SQL : `(NOT ${REPORT_IN_HISTORY_SQL} OR ${REPORT_NEEDS_ATTENTION_SQL})`,
  order: bucket === 'history' ? 'r.ends_at DESC, r.shift_id' : `${REPORT_NEEDS_ATTENTION_SQL} DESC, r.starts_at ASC, r.shift_id`,
});

/** Rows without db_now (the same now() anyway), with keys in a stable order, values as the driver returned them. */
const normalise = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => Object.fromEntries(Object.keys(r).filter((k) => k !== 'db_now').sort().map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]])));

describeIfDb('shift-report list: page-first statement returns exactly what the old statement did (integration)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let orgId: string;
  let manager: TestIdentity;
  let venueManager: TestIdentity;
  let venueA: string;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => admin.query(text, params) as Promise<T[]>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const org = await factory.createOrganisation('srleq');
    orgId = org.id;
    manager = await factory.createInternalManager(org, { permissions: 'production' });
    const ws = manager.workspaceId!;
    const mctx = { organisationId: orgId, workspaceId: ws, userId: manager.userId, role: '' };
    const venue = (name: string) => tenantContext.runInTenantContext(mctx, (m) => m.save(Venue, { organisationId: orgId, name, workspaceId: ws, createdBy: manager.userId }));
    venueA = (await venue(`SRL A ${randomUUID().slice(0, 6)}`)).id;
    const venueB = (await venue(`SRL B ${randomUUID().slice(0, 6)}`)).id;
    venueManager = await factory.createVenueManager(org, { owner: manager, venueIds: [venueA], label: 'srleqvm' });
    const [role] = await sql<{ id: string }>(
      `INSERT INTO ${businessTable(ws, 'job_role')} (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`,
      [orgId, `SRL Role ${randomUUID().slice(0, 6)}`, manager.userId, ws],
    );
    const s1 = (await factory.createStaff(org, { owner: manager, label: 'srleq1' })).profileId!;
    const s2 = (await factory.createStaff(org, { owner: manager, label: 'srleq2' })).profileId!;

    type Seat = { staff: string; status: 'confirmed' | 'completed' | 'no_show'; attendance?: boolean; reviewed?: boolean };
    type Report = { finalised: boolean; outbox: Array<{ status: 'SENT' | 'FAILED' | 'PENDING' | 'CANCELLED'; sentAgoH?: number }> | null };
    const now = Date.now();
    // Every shift is one hour long and ends at `endH` hours from now; windows never overlap, so no double-booking.
    const seed = async (endH: number, venueId: string, status: string, seats: Seat[], report?: Report) => {
      const startsAt = new Date(now + (endH - 1) * HOUR);
      const endsAt = new Date(now + endH * HOUR);
      const filled = seats.filter((x) => x.status !== 'no_show').length;
      const [shift] = await sql<{ id: string }>(
        `INSERT INTO ${businessTable(ws, 'shift')} (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, filled_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, $4, $5, 3, $6, 1500, $7, $8, $9) RETURNING id`,
        [orgId, venueId, role!.id, startsAt, endsAt, filled, manager.userId, ws, status],
      );
      for (const seat of seats) {
        const [sa] = await sql<{ id: string }>(
          `INSERT INTO ${businessTable(ws, 'shift_assignment')} (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id, attendance_reviewed_at)
           VALUES ($1, $2, $3, $4, 1500, tstzrange($5, $6, '[)'), $7, $8) RETURNING id`,
          [orgId, shift!.id, seat.staff, seat.status, startsAt, endsAt, ws, seat.reviewed ? new Date(now) : null],
        );
        if (seat.attendance) {
          await sql(
            `INSERT INTO ${businessTable(ws, 'attendance')} (organisation_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence, workspace_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'clocked_out', 60, 1500, $7)`,
            [orgId, sa!.id, shift!.id, seat.staff, startsAt, endsAt, ws],
          );
        }
      }
      if (report) {
        const [r] = await sql<{ id: string }>(
          report.finalised
            ? `INSERT INTO ${businessTable(ws, 'shift_report')} (organisation_id, workspace_id, shift_id, status, finalised_at, final_pdf_sent_at)
               VALUES ($1, $2, $3, 'finalised', $4, $4) RETURNING id`
            : `INSERT INTO ${businessTable(ws, 'shift_report')} (organisation_id, workspace_id, shift_id) VALUES ($1, $2, $3) RETURNING id`,
          report.finalised ? [orgId, ws, shift!.id, new Date(endsAt.getTime() + HOUR)] : [orgId, ws, shift!.id],
        );
        if (report.outbox) {
          const [file] = await sql<{ id: string }>(
            `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, mime_type, object_key, original_filename, resource_type, resource_id, size_bytes, storage_driver, status, sha256)
             VALUES ($1, $2, 'FINAL_TIMESHEET_PDF', 'application/pdf', $3, 'final-timesheet.pdf', 'shift_report', $4, 10, 'LOCAL', 'AVAILABLE', repeat('a', 64)) RETURNING id`,
            [orgId, ws, `test/${randomUUID()}.pdf`, r!.id],
          );
          await sql(`UPDATE ${businessTable(ws, 'shift_report')} SET final_file_id = $2 WHERE id = $1`, [r!.id, file!.id]);
          for (const o of report.outbox) {
            await sql(
              `INSERT INTO core.email_outbox (organisation_id, workspace_id, job_type, recipient_email, rendered_subject, attachment_file_id, status, sent_at, failed_at)
               VALUES ($1, $2, 'NOTIFICATION', 'srl@example.test', 'Final Timesheet', $3, $4, $5, $6)`,
              [orgId, ws, file!.id, o.status, o.sentAgoH === undefined ? null : new Date(now - o.sentAgoH * HOUR), o.status === 'FAILED' ? new Date(now) : null],
            );
          }
        }
      }
    };

    await seed(5, venueA, ShiftStatus.CONFIRMED, [{ staff: s1, status: 'confirmed' }]);
    await seed(0.5, venueB, ShiftStatus.IN_PROGRESS, [{ staff: s2, status: 'confirmed' }, { staff: s1, status: 'no_show' }]);
    await seed(-4.5, venueA, ShiftStatus.COMPLETED, [{ staff: s1, status: 'completed', attendance: true, reviewed: true }, { staff: s2, status: 'no_show' }]);
    await seed(-6.5, venueB, ShiftStatus.COMPLETED, [{ staff: s2, status: 'completed', attendance: true }]);
    await seed(-30, venueA, ShiftStatus.COMPLETED, [{ staff: s1, status: 'completed', attendance: true, reviewed: true }, { staff: s2, status: 'no_show' }], { finalised: true, outbox: [{ status: 'SENT', sentAgoH: 20 }, { status: 'CANCELLED' }] });
    await seed(-33, venueB, ShiftStatus.COMPLETED, [{ staff: s2, status: 'completed', attendance: true, reviewed: true }], { finalised: true, outbox: [{ status: 'SENT', sentAgoH: 2 }] });
    await seed(-36, venueA, ShiftStatus.COMPLETED, [], { finalised: true, outbox: [{ status: 'FAILED' }] });
    await seed(-39, venueB, ShiftStatus.COMPLETED, [{ staff: s1, status: 'completed', attendance: true }], { finalised: true, outbox: [{ status: 'PENDING' }] });
    await seed(-42, venueA, ShiftStatus.CANCELLED, []);
    await seed(10, venueA, ShiftStatus.DRAFT, []);
    await seed(-45, venueA, ShiftStatus.COMPLETED, [{ staff: s2, status: 'completed' }], { finalised: true, outbox: [] });
    await seed(-48, venueA, ShiftStatus.COMPLETED, [{ staff: s1, status: 'completed', attendance: true, reviewed: true }], { finalised: false, outbox: null });
    await seed(20, venueB, ShiftStatus.OPEN, []);
    await seed(-51, venueA, ShiftStatus.COMPLETED, [{ staff: s2, status: 'completed', attendance: true, reviewed: true }], { finalised: true, outbox: [{ status: 'SENT', sentAgoH: 4.5 }] });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  const ctxOf = (who: TestIdentity): AuthContext => ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' });

  const cases: Array<['manager' | 'venue manager', 'current' | 'history']> = [
    ['manager', 'current'],
    ['manager', 'history'],
    ['venue manager', 'current'],
    ['venue manager', 'history'],
  ];

  it.each(cases)('%s, %s bucket: identical rows, order and totals on every page (limit 2)', async (who, bucket) => {
    const identity = who === 'manager' ? manager : venueManager;
    const scopeSql = who === 'manager' ? 's.created_by = $2' : 's.venue_id = ANY($2::uuid[])';
    const scopeValue = who === 'manager' ? manager.userId : [venueA];
    const { bucketSql, order } = bucketOf(bucket);
    const take = 2;

    const pages = await tenantContext.runInWorkspaceContext(ctxOf(identity), async (m) => {
      const out: Array<{ legacy: Array<Record<string, unknown>>; paged: Array<Record<string, unknown>> }> = [];
      for (let page = 0; page < 8; page += 1) {
        const params = [orgId, scopeValue, take, page * take];
        const legacy = (await m.query(legacyListSql(m, scopeSql, bucketSql, order, '$3', '$4'), params)) as Array<Record<string, unknown>>;
        const paged = (await m.query(REPORT_PAGE_SQL(m, scopeSql, bucketSql, order, '$3', '$4'), params)) as Array<Record<string, unknown>>;
        out.push({ legacy, paged });
      }
      return out;
    });

    for (const { legacy, paged } of pages) expect(normalise(paged)).toEqual(normalise(legacy));
    // Not vacuous: the first page is full, there is more than one page, and the totals agree.
    const first = pages[0]!;
    expect(first.legacy).toHaveLength(take);
    expect(Number(first.legacy[0]!.total)).toBeGreaterThan(take);
    expect(pages.flatMap((p) => p.paged).length).toBe(Number(first.paged[0]!.total));
    // The draft shift is never listed, the Venue Manager sees venue A only.
    const all = pages.flatMap((p) => p.paged);
    expect(all.every((r) => r.shift_status !== 'draft')).toBe(true);
    if (who === 'venue manager') expect(all.every((r) => String(r.venue_name).startsWith('SRL A'))).toBe(true);
  });

  it('the fixture exercises the counts: some page row has staff, no-shows, clocked-out and unreviewed seats', async () => {
    const { bucketSql, order } = bucketOf('history');
    const rows = (await tenantContext.runInWorkspaceContext(ctxOf(manager), (m) =>
      m.query(REPORT_PAGE_SQL(m, 's.created_by = $2', bucketSql, order, '$3', '$4'), [orgId, manager.userId, 50, 0]),
    )) as Array<Record<string, unknown>>;
    const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k]), 0);
    expect(sum('staff_count')).toBeGreaterThan(0);
    expect(sum('no_shows')).toBeGreaterThan(0);
    expect(sum('clocked_out')).toBeGreaterThan(0);
    expect(sum('unreviewed')).toBeGreaterThan(0);
    expect(sum('d_sent')).toBeGreaterThan(0);
  });
});
