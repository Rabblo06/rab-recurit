import { ReportKey } from '@rab/shared';
import type { EntityManager } from 'typeorm';

import { bindBusinessSchema, CORE_BUSINESS_SCHEMA } from '../../../engine/core-modules/tenant/business-tables';
import { buildReportCsv, minutesToHours, penceToDecimal, REPORT_MAX_ROWS, ReportExportJob, ReportTooLargeError, toCsv } from '../services/report-builders';

/** A tenant-bound fake transaction manager that records every statement and answers with the queued rows. */
function fakeManager(answers: unknown[][] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    queryRunner: { isReleased: false, isTransactionActive: true },
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return answers.shift() ?? [];
    }),
  };
  bindBusinessSchema(manager as unknown as EntityManager, CORE_BUSINESS_SCHEMA, null);
  return { manager: manager as unknown as EntityManager, calls };
}

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const VENUE_A = '00000000-0000-4000-8000-0000000000b1';
const VENUE_B = '00000000-0000-4000-8000-0000000000b2';

function job(over: Partial<ReportExportJob> = {}): ReportExportJob {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    organisation_id: '00000000-0000-4000-8000-0000000000d1',
    workspace_id: '00000000-0000-4000-8000-0000000000e1',
    requested_by: OWNER,
    report_key: ReportKey.HOURS_AND_PAY_BY_VENUE,
    period_from: '2026-11-01',
    period_to: '2026-11-30',
    venue_id: null,
    payroll_run_id: null,
    include_pay: true,
    include_hours: true,
    scope_kind: 'owner',
    scope_owner_user_id: OWNER,
    scope_venue_ids: [],
    ...over,
  };
}

describe('report builders (owner decision 29)', () => {
  it('formats pence with integer arithmetic only (bigint-safe), and minutes as hours', () => {
    expect(penceToDecimal('0')).toBe('0.00');
    expect(penceToDecimal('5')).toBe('0.05');
    expect(penceToDecimal('123456')).toBe('1234.56');
    expect(penceToDecimal('-250')).toBe('-2.50');
    expect(penceToDecimal('9007199254740993')).toBe('90071992547409.93'); // past 2^53: still exact
    expect(minutesToHours(90)).toBe('1.50');
  });

  it('neutralises spreadsheet formulas in every cell and quotes every cell (a CSV never runs code in Excel)', () => {
    const csv = toCsv({ header: ['Venue', 'Staff'], rows: [['=HYPERLINK("http://x")', '+1'], ['@SUM(A1)', '-2'], [' =1+1', 'a;=1+1'], ['\uff1d1+1', 'ok']] });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Venue","Staff"');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://x"")","'+1"`);
    expect(lines[2]).toBe(`"'@SUM(A1)","'-2"`);
    expect(lines[3]).toBe(`"' =1+1","'a;=1+1"`);
    expect(lines[4]).toBe(`"'\uff1d1+1","ok"`);
  });

  it('enforces the size budget while building: stops at the line that would pass it, never a partial file', () => {
    const table = { header: ['A'], rows: Array.from({ length: 100 }, () => ['x'.repeat(100)]) };
    expect(() => toCsv(table, 1_000)).toThrow(ReportTooLargeError);
    expect(toCsv(table, 1_000_000).split('\n')).toHaveLength(101);
  });

  it('a query result over the row cap fails as too large (each query asks for one row more than the cap)', async () => {
    const tooMany = Array.from({ length: REPORT_MAX_ROWS + 1 }, () => ({ venue: 'V', shifts: 1, required: 1, filled: 1 }));
    const { manager, calls } = fakeManager([tooMany]);
    await expect(buildReportCsv(manager, job({ report_key: ReportKey.FILL_RATE_BY_VENUE, include_pay: false }), { lateGraceMinutes: 10 })).rejects.toThrow(ReportTooLargeError);
    expect(calls[0]!.sql).toContain(`LIMIT ${REPORT_MAX_ROWS + 1}`);
  });

  it('report 1: owner scope filters by the stored owner; pay and hours columns only when stored as allowed', async () => {
    const { manager, calls } = fakeManager([[{ venue: 'Pier', shifts: 3, minutes: '600', pence: '15000' }]]);
    const full = await buildReportCsv(manager, job(), { lateGraceMinutes: 10 });
    expect(full.csv.split('\n')).toEqual([
      '"Venue","Period start","Period end","Shifts worked","Hours","Gross pay recorded at clock-out (GBP)"',
      '"Pier","2026-11-01","2026-11-30","3","10.00","150.00"',
    ]);
    expect(full.rowCount).toBe(1);
    expect(calls[0]!.sql).toContain('sp.created_by = $1');
    expect(calls[0]!.params[0]).toBe(OWNER);

    const { manager: m2 } = fakeManager([[{ venue: 'Pier', shifts: 3, minutes: '600', pence: '15000' }]]);
    const noPay = await buildReportCsv(m2, job({ include_pay: false, include_hours: false }), { lateGraceMinutes: 10 });
    expect(noPay.csv).toBe('"Venue","Period start","Period end","Shifts worked"\n"Pier","2026-11-01","2026-11-30","3"');
    expect(noPay.csv).not.toContain('150.00');
  });

  it('a Venue Manager export is limited to the stored venues in SQL (never the owner predicate), and never has pay', async () => {
    const { manager, calls } = fakeManager([[]]);
    await buildReportCsv(manager, job({ scope_kind: 'venue', scope_owner_user_id: null, scope_venue_ids: [VENUE_A, VENUE_B], include_pay: false }), { lateGraceMinutes: 10 });
    expect(calls[0]!.sql).toContain('s.venue_id = ANY($1::uuid[])');
    expect(calls[0]!.sql).not.toContain('created_by');
    expect(calls[0]!.params[0]).toEqual([VENUE_A, VENUE_B]);
  });

  it('every period report query carries a scope predicate and the London work-date period', async () => {
    for (const key of [ReportKey.HOURS_AND_PAY_BY_VENUE, ReportKey.ATTENDANCE_EXCEPTIONS, ReportKey.WEEKLY_HOURS_PER_STAFF, ReportKey.FILL_RATE_BY_VENUE]) {
      const { manager, calls } = fakeManager();
      await buildReportCsv(manager, job({ report_key: key, venue_id: VENUE_A }), { lateGraceMinutes: 10, now: new Date('2026-12-01T00:00:00Z') });
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.sql).toMatch(/(sp|s)\.created_by = \$\d+/);
        expect(c.sql).toContain(`AT TIME ZONE 'Europe/London')::date BETWEEN`);
        expect(c.sql).toMatch(/s\.venue_id = \$\d+/);
        expect(c.params).toContain(OWNER);
        expect(c.params).toContain(VENUE_A);
      }
    }
  });

  it('report 2 lists each exception with a plain reason, including out-of-area clock-ins measured against the geofence', async () => {
    const at = new Date('2026-11-03T10:00:00Z');
    const { manager } = fakeManager([
      [{ at, venue: 'Pier', first_name: 'Ann', last_name: 'Lee', staff_ref: 'S1', reviewed: true }],
      [
        { at, venue: 'Pier', first_name: 'Bob', last_name: 'Ray', staff_ref: 'S2', late_minutes: 25, missing_clock_out: true, clock_in_lat: '51.5', clock_in_lng: '-0.1', venue_lat: '51.51', venue_lng: '-0.1', radius_m: 200 },
        { at, venue: 'Pier', first_name: 'Cat', last_name: 'Day', staff_ref: 'S3', late_minutes: 0, missing_clock_out: false, clock_in_lat: '51.51', clock_in_lng: '-0.1', venue_lat: '51.51', venue_lng: '-0.1', radius_m: 200 },
      ],
    ]);
    const { csv, rowCount } = await buildReportCsv(manager, job({ report_key: ReportKey.ATTENDANCE_EXCEPTIONS, include_pay: false }), { lateGraceMinutes: 10 });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Date","Venue","Staff reference","Staff name","Exception","Detail"');
    expect(rowCount).toBe(4); // Ann no-show; Bob late + missing clock-out + out of area; Cat nothing
    expect(csv).toContain('"No-show","Confirmed by a manager"');
    expect(csv).toContain('"Late arrival","Clocked in 25 min after the start"');
    expect(csv).toContain('"Missing clock-out"');
    expect(csv).toMatch(/"Out-of-area clock-in","Clocked in about 1\d{3} m from the venue \(geofence 200 m\)"/);
    expect(csv).not.toContain('Cat Day');
  });

  it('report 3 warns above 48 hours a week (more than 2,880 minutes), not at exactly 48', async () => {
    const { manager } = fakeManager([
      [
        { staff_ref: 'S1', first_name: 'Ann', last_name: 'Lee', week_start: '2026-11-02', shifts: 6, minutes: 2880 },
        { staff_ref: 'S1', first_name: 'Ann', last_name: 'Lee', week_start: '2026-11-09', shifts: 6, minutes: 2881 },
      ],
    ]);
    const { csv } = await buildReportCsv(manager, job({ report_key: ReportKey.WEEKLY_HOURS_PER_STAFF, include_pay: false }), { lateGraceMinutes: 10 });
    expect(csv.split('\n').slice(1)).toEqual(['"S1","Ann Lee","2026-11-02","6","48.00","No"', '"S1","Ann Lee","2026-11-09","6","48.02","Yes"']);
  });

  it('report 4 uses the shift owner (or the stored venues) and computes the fill rate from capped filled counts', async () => {
    const { manager, calls } = fakeManager([[{ venue: 'Pier', shifts: 4, required: 8, filled: 6 }]]);
    const { csv } = await buildReportCsv(manager, job({ report_key: ReportKey.FILL_RATE_BY_VENUE, include_pay: false }), { lateGraceMinutes: 10 });
    expect(calls[0]!.sql).toContain('s.created_by = $1');
    expect(calls[0]!.sql).toContain('LEAST(s.filled_count, s.required_count)');
    expect(csv.split('\n')[1]).toBe('"Pier","2026-11-01","2026-11-30","4","8","6","2","75.0"');
  });

  it('an unknown report key builds nothing (fail closed)', async () => {
    const { manager, calls } = fakeManager();
    await expect(buildReportCsv(manager, job({ report_key: 'everything' as never }), { lateGraceMinutes: 10 })).rejects.toThrow(/Unknown report key/);
    expect(calls).toHaveLength(0);
  });
});
