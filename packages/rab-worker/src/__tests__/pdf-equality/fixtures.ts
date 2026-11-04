import { JwtService } from '@nestjs/jwt';
import { computeWorkedMinutes, payForMinutes } from '@rab/shared';
import type { EntityManager } from 'typeorm';

import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { QrTokenService } from '@rab/server/modules/attendance/services/qr-token.service';
import { loadDocumentShiftInfo } from '@rab/server/modules/attendance/templates/document-context';
import type { FinalTimesheetData, StaffReviewScores } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import type { ApprovedShiftStatementData } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';
import { breakPaidFromFigures, shiftStatementReference } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';
import { paydayLabel, PeriodRef, periodLabel } from '@rab/server/modules/payroll/services/payroll-allocation';
import type { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { effectiveAssignmentBreakMinutes, effectiveAssignmentTime } from '@rab/server/modules/scheduling/utils/assignment-time';

import { DocumentKind, ReportDocument } from './documents';

/**
 * FIXTURE GENERATOR. Synthetic inputs for every document, built through the EXISTING builders — nothing is re-derived:
 *
 *   header data      `loadDocumentShiftInfo` (document-context.ts) — the real builder, fed venue / role / organisation /
 *                    workspace rows through a read-only fake EntityManager that answers ONLY its four SELECTs and throws
 *                    on any other SQL (so a change to that builder fails here instead of being silently mirrored);
 *                    the shift reference comes from it too (`shiftReference`).
 *   scheduled times  `effectiveAssignmentTime` / `effectiveAssignmentBreakMinutes` (scheduling/utils/assignment-time.ts)
 *   worked minutes   `computeWorkedMinutes` (@rab/shared duration.ts) with the inputs AttendanceService.performClockOut
 *                    passes (`scheduledBreakMinutes: attendance.breakMinutes ?? effectiveAssignmentBreakMinutes(...)`)
 *   money            `payForMinutes` (@rab/shared money.ts) — the same call that snapshots `earned_pence` / payroll gross
 *   statement        `shiftStatementReference`, `breakPaidFromFigures` (approved-shift-statement.html.ts),
 *                    `periodLabel` / `paydayLabel` (payroll-allocation.ts)
 *   shift QR         the real `AttendanceQrService.sign` (→ `QrTokenService`, HS256 JWT) and `QrImageService.generatePng`,
 *                    with a fixed, obviously fake test APP_SECRET (never a real secret)
 *
 * The only code here that mirrors a job is the row → template mapping (name concatenation, ISO strings, the
 * `status ?? 'absent'` default), copied from final-timesheet.job.ts / shift-report-scheduler.job.ts /
 * shift-statement.job.ts `loadStatementData`, because the jobs do it inline and do not export it. The P0 plan's
 * view-model builders (§5.1) sit AFTER this point, so the harness exercises them unchanged.
 *
 * Matrix (P0 plan §5.2 + the brief): empty; 1, 5, 40, 45, 200, 300, 500 rows; every status label, no-show, missing
 * clock-out, no attendance, corrections, review / no review; unsigned / signed / no typed sign-off / break not
 * confirmed; long text (10 KB note, 80-character names); a 1,000-character unbroken token; Welsh, Polish, Arabic, CJK,
 * emoji, accents; hostile text (§8 P3 list); worked minutes 0 / 1 / 1,439 / break > elapsed; pence 0, 1, 99, 100,
 * 1,000,000.00, half-penny rounding, large; breakPaid true / false / null; across midnight; BST→GMT and GMT→BST nights;
 * a non-London organisation timezone. (Negative amounts: none of the three documents has an adjustment line.)
 */

// ─── seeds (database-shaped rows) ───────────────────────────────────────────────────────────────────────────────────

export interface StaffSeed {
  first: string;
  last: string;
  ref: string | null;
  /** Per-assignment window, or null for the shift's own window. */
  period?: [Date, Date] | null;
  assignmentBreak?: number | null;
  assignmentStatus: 'confirmed' | 'completed' | 'no_show';
  clockIn: Date | null;
  clockOut: Date | null;
  /** attendance.break_minutes (a manager-confirmed break); null → the assignment / shift default. */
  attendanceBreak?: number | null;
  attendanceStatus: string | null;
  corrected?: boolean;
  review?: StaffReviewScores | null;
}

export interface StatementSeed {
  /** Suffix of the fixture id (several statements per scenario, e.g. the money edge cases). */
  id: string;
  recordId: string;
  staff: StaffSeed;
  payRatePence: number;
  approvedAt: Date;
  approvedBy: string | null;
  employerName: string;
  period: PeriodRef | null;
  /** Venue/role "breaks are paid" override (computeWorkedMinutes `breaksPaidByDefault`) → breakPaid true. */
  breaksPaid?: boolean;
}

export interface ScenarioSeed {
  id: string;
  description: string;
  shift: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    breakMinutes: number;
    notes: string | null;
    address: string | null;
    workspaceId: string | null;
  };
  venue: { name: string; address: string | null; contact: Record<string, unknown> | null };
  role: string;
  timezone: string;
  workspaceName: string | null;
  staff: StaffSeed[];
  finalisedBy: { first: string; last: string } | null;
  signedOffName: string | null;
  breakConfirmed: boolean | null;
  finalisedAt: Date;
  generatedAt: Date;
  statements: StatementSeed[];
}

export interface FixtureOptions {
  /** Base URL embedded in hostile text (a local counting server in the hostile-text suite). */
  hostileBase?: string;
}

// ─── the real builders, wired with test-only collaborators ──────────────────────────────────────────────────────────

/** Obviously fake; the QR key is HKDF-derived from it exactly as in production. */
export const FIXTURE_APP_SECRET = 'pdf-equality-fixture-app-secret-NOT-A-REAL-SECRET-0000000000';
const FIXTURE_ENV: Record<string, unknown> = { APP_SECRET: FIXTURE_APP_SECRET, CLOCK_IN_EARLY_MINUTES: 15, QR_POST_SHIFT_GRACE_MINUTES: 120 };
const env = { get: (key: string) => FIXTURE_ENV[key] } as never;
export const fixtureQrTokens = new QrTokenService(new JwtService(), env);
export const fixtureAttendanceQr = new AttendanceQrService(fixtureQrTokens, env);
const qrImage = new QrImageService();

export const FIXTURE_ORG_ID = '0e6f3a4c-1111-4a5b-9c8d-000000000001';
export const FIXTURE_VENUE_ID = '0e6f3a4c-2222-4a5b-9c8d-000000000002';
const ROLE_ID = '0e6f3a4c-3333-4a5b-9c8d-000000000003';

/** Answers exactly the four reads `loadDocumentShiftInfo` makes; anything else is a builder change and fails loudly. */
function documentContextManager(seed: ScenarioSeed): EntityManager {
  const query = async (sql: string, params: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'SELECT name, address, contact FROM venue WHERE id = $1' && params[0] === FIXTURE_VENUE_ID) {
      return [{ name: seed.venue.name, address: seed.venue.address, contact: seed.venue.contact }];
    }
    if (s === 'SELECT name FROM job_role WHERE id = $1' && params[0] === ROLE_ID) return [{ name: seed.role }];
    if (s === 'SELECT timezone FROM core.organisation WHERE id = $1' && params[0] === FIXTURE_ORG_ID) return [{ timezone: seed.timezone }];
    if (s === 'SELECT name FROM core.manager_workspace WHERE id = $1') return seed.workspaceName == null ? [] : [{ name: seed.workspaceName }];
    throw new Error(`pdf-equality fixture: loadDocumentShiftInfo issued an unexpected query (update fixtures.ts): ${s}`);
  };
  return { query } as unknown as EntityManager;
}

export function shiftEntity(seed: ScenarioSeed): Shift {
  return {
    id: seed.shift.id,
    organisationId: FIXTURE_ORG_ID,
    venueId: FIXTURE_VENUE_ID,
    jobRoleId: ROLE_ID,
    workspaceId: seed.shift.workspaceId ?? undefined,
    startsAt: seed.shift.startsAt,
    endsAt: seed.shift.endsAt,
    breakMinutes: seed.shift.breakMinutes,
    notes: seed.shift.notes ?? undefined,
    address: seed.shift.address ?? undefined,
    qrVersion: 1,
    status: 'published',
  } as unknown as Shift;
}

/** tstzrange text as PostgreSQL returns `shift_assignment.period`. */
const periodText = (p: [Date, Date] | null | undefined) => (p ? `["${p[0].toISOString()}","${p[1].toISOString()}")` : null);

/** attendance.worked_minutes as AttendanceService.performClockOut stores it. */
function storedWorkedMinutes(s: StaffSeed, shift: Shift, breaksPaidByDefault = false): number | null {
  if (!s.clockIn || !s.clockOut) return null;
  return computeWorkedMinutes({
    clockInAt: s.clockIn,
    clockOutAt: s.clockOut,
    scheduledBreakMinutes: s.attendanceBreak ?? effectiveAssignmentBreakMinutes({ breakMinutes: s.assignmentBreak ?? null }, shift),
    breaksPaidByDefault,
  }).workedMinutes;
}

/** Builds every document a scenario yields. */
export async function buildScenarioDocuments(seed: ScenarioSeed): Promise<Array<{ id: string; scenario: string; doc: ReportDocument }>> {
  const shift = shiftEntity(seed);
  const info = await loadDocumentShiftInfo(documentContextManager(seed), shift, seed.generatedAt);
  const out: Array<{ id: string; scenario: string; doc: ReportDocument }> = [];

  // Final timesheet — the row shape of final-timesheet.job.ts's SELECT, mapped as that job maps it.
  const rows = seed.staff
    .filter((s) => ['confirmed', 'completed', 'no_show'].includes(s.assignmentStatus))
    .map((s) => ({
      period: periodText(s.period),
      assignment_break_minutes: s.assignmentBreak ?? null,
      assignment_status: s.assignmentStatus,
      staff_ref: s.ref,
      first_name: s.first,
      last_name: s.last,
      clock_in_at: s.clockIn,
      clock_out_at: s.clockOut,
      break_minutes: s.attendanceBreak ?? null,
      worked_minutes: storedWorkedMinutes(s, shift),
      status: s.attendanceStatus,
      corrected: s.corrected ?? false,
      review: s.review ?? null,
    }));
  const finalisedByName = seed.finalisedBy ? `${seed.finalisedBy.first} ${seed.finalisedBy.last}` : 'Venue Manager';
  const template: FinalTimesheetData = {
    ...info,
    staff: rows.map((r) => ({
      name: `${r.first_name} ${r.last_name}`,
      staffRef: r.staff_ref,
      roleName: info.roleName,
      assignmentStatus: r.assignment_status,
      review: r.review,
      scheduledStart: effectiveAssignmentTime(r, shift).startsAt.toISOString(),
      scheduledEnd: effectiveAssignmentTime(r, shift).endsAt.toISOString(),
      clockInAt: r.clock_in_at ? new Date(r.clock_in_at).toISOString() : null,
      clockOutAt: r.clock_out_at ? new Date(r.clock_out_at).toISOString() : null,
      breakMinutes: r.break_minutes ?? effectiveAssignmentBreakMinutes({ breakMinutes: r.assignment_break_minutes }, shift),
      workedMinutes: r.worked_minutes,
      status: r.status ?? 'absent',
      corrected: r.corrected,
    })),
    finalisedByName,
    signedOffName: seed.signedOffName,
    breakConfirmed: seed.breakConfirmed,
    finalisedAt: seed.finalisedAt.toISOString(),
  };
  out.push({ id: `${seed.id}/final-timesheet-original`, scenario: seed.id, doc: { kind: 'final-timesheet-original', data: { ...template, unsigned: true }, shift: info } });
  out.push({ id: `${seed.id}/final-timesheet`, scenario: seed.id, doc: { kind: 'final-timesheet', data: template, shift: info } });

  // Pre-shift roster — confirmed assignments only, as shift-report-scheduler.job.ts selects them; the real signed QR.
  const qrPayload = fixtureAttendanceQr.sign(shift);
  const qrPng = await qrImage.generatePng(qrPayload);
  out.push({
    id: `${seed.id}/pre-shift-report`,
    scenario: seed.id,
    doc: {
      kind: 'pre-shift-report',
      shift: info,
      qrPayload,
      data: {
        ...info,
        staff: seed.staff
          .filter((s) => s.assignmentStatus === 'confirmed')
          .map((s) => {
            const r = { period: periodText(s.period), assignment_break_minutes: s.assignmentBreak ?? null };
            return {
              name: `${s.first} ${s.last}`,
              staffRef: s.ref,
              roleName: info.roleName,
              scheduledStart: effectiveAssignmentTime(r, shift).startsAt.toISOString(),
              scheduledEnd: effectiveAssignmentTime(r, shift).endsAt.toISOString(),
              breakMinutes: effectiveAssignmentBreakMinutes({ breakMinutes: r.assignment_break_minutes }, shift),
            };
          }),
        qrPngBase64: qrPng.toString('base64'),
      },
    },
  });

  // Approved Shift Statements — loadStatementData's shape.
  for (const st of seed.statements) {
    const s = st.staff;
    const window = effectiveAssignmentTime({ period: periodText(s.period) }, shift);
    const startsAt = window.startsAt.toISOString();
    const breakMinutes = s.attendanceBreak ?? s.assignmentBreak ?? seed.shift.breakMinutes; // COALESCE(a.break_minutes, sa.break_minutes, s.break_minutes)
    const payableMinutes = storedWorkedMinutes(s, shift, st.breaksPaid) ?? 0;
    const clockIn = s.clockIn ? s.clockIn.toISOString() : null;
    const clockOut = s.clockOut ? s.clockOut.toISOString() : null;
    const data: ApprovedShiftStatementData = {
      statementReference: shiftStatementReference(st.recordId, startsAt, seed.timezone),
      employerName: st.employerName,
      workspaceName: seed.workspaceName,
      staffName: `${s.first} ${s.last}`,
      staffRef: s.ref,
      venueName: seed.venue.name,
      roleName: seed.role,
      scheduledStart: startsAt,
      scheduledEnd: window.endsAt.toISOString(),
      clockInAt: clockIn,
      clockOutAt: clockOut,
      breakMinutes,
      breakPaid: breakPaidFromFigures(clockIn, clockOut, breakMinutes, payableMinutes),
      payableMinutes,
      payRatePence: st.payRatePence,
      amountPence: payForMinutes(st.payRatePence, payableMinutes),
      approvedAt: st.approvedAt.toISOString(),
      approvedByName: st.approvedBy,
      payrollPeriodLabel: st.period ? periodLabel(st.period) : null,
      paydayLabel: st.period ? paydayLabel(st.period.payday) : null,
      timezone: seed.timezone,
      generatedAt: seed.generatedAt.toISOString(),
    };
    out.push({ id: `${seed.id}/approved-shift-statement${st.id ? `-${st.id}` : ''}`, scenario: seed.id, doc: { kind: 'approved-shift-statement', data } });
  }
  return out;
}

// ─── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────────────

const d = (iso: string) => new Date(iso);
const addMin = (t: Date, m: number) => new Date(t.getTime() + m * 60_000);
const uuid = (n: number) => `5f1c${String(n).padStart(4, '0')}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
const FIRST = ['Amelia', 'Oliver', 'Isla', 'George', 'Ava', 'Arthur', 'Mia', 'Noah', 'Ivy', 'Leo', 'Freya', 'Oscar'];
const LAST = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Patel', 'Robinson', 'Wright', 'Evans'];
/** Every attendance status the timesheet labels (STATUS_LABEL), plus an unknown one (printed with spaces). */
const STATUSES = ['approved', 'clocked_out', 'under_review', 'clocked_in', 'on_break', 'late', 'disputed', 'some_new_status'];
const REVIEW: StaffReviewScores = { grooming: 5, attitude: 4, skills: 4, attendance: 5, timeKeeping: 3 };
const PERIOD: PeriodRef = { id: uuid(9001), start: '2026-11-02', end: '2026-11-15', payday: '2026-11-20', note: null, needsConfirmation: false };

function baseSeed(id: string, description: string, startsAt: Date, endsAt: Date, timezone = 'Europe/London'): ScenarioSeed {
  return {
    id,
    description,
    shift: { id: uuid(id.length * 97 + id.charCodeAt(0)), startsAt, endsAt, breakMinutes: 30, notes: 'Black tie. Report to the staff entrance.', address: null, workspaceId: uuid(7) },
    venue: { name: 'The Grand Hall', address: '1 Example Street, London SW1A 1AA', contact: { name: 'Jamie Duty-Manager', phone: '+44 20 7946 0000' } },
    role: 'Bar Staff',
    timezone,
    workspaceName: 'Adolphus Events',
    staff: [],
    finalisedBy: { first: 'Morgan', last: 'Manager' },
    signedOffName: 'Morgan A. Manager',
    breakConfirmed: true,
    finalisedAt: addMin(endsAt, 9 * 60),
    generatedAt: addMin(startsAt, -120),
    statements: [],
  };
}

/** n generated staff: lateness, early leave, no-shows, missing clock-outs, no attendance, corrections, reviews. */
function generatedStaff(n: number, startsAt: Date, endsAt: Date): StaffSeed[] {
  return Array.from({ length: n }, (_, i) => {
    const noShow = i % 11 === 4;
    const missingOut = i % 13 === 6;
    const noAttendance = i % 17 === 9; // confirmed, never clocked in: "No attendance"
    const clockIn = noShow || noAttendance ? null : addMin(startsAt, (i % 7) - 3);
    return {
      first: FIRST[i % FIRST.length]!,
      last: `${LAST[(i * 5) % LAST.length]!} ${String(i + 1).padStart(3, '0')}`,
      ref: `ST-${1000 + i}`,
      assignmentBreak: i % 4 === 0 ? 45 : null,
      assignmentStatus: noShow ? 'no_show' : 'confirmed',
      clockIn,
      clockOut: noShow || missingOut || noAttendance ? null : addMin(endsAt, (i % 9) - 2),
      attendanceStatus: noShow || noAttendance ? null : missingOut ? 'missing_clock_out' : STATUSES[i % STATUSES.length]!,
      corrected: i % 5 === 1,
      review: i % 2 === 0 ? REVIEW : null,
    };
  });
}

function statementFor(seed: ScenarioSeed, staff: StaffSeed, id = '', overrides: Partial<StatementSeed> = {}): StatementSeed {
  return {
    id,
    recordId: uuid(5000 + seed.statements.length * 7 + id.length),
    staff,
    payRatePence: 1250,
    approvedAt: addMin(seed.shift.endsAt, 24 * 60),
    approvedBy: 'Pat Payroll',
    employerName: 'Adolphus Group Ltd',
    period: PERIOD,
    ...overrides,
  };
}

export function scenarioSeeds(options: FixtureOptions = {}): ScenarioSeed[] {
  const H = (options.hostileBase ?? 'http://127.0.0.1:9').replace(/\/$/, '');
  const seeds: ScenarioSeed[] = [];

  // 1. Empty report: no staff. The statement (always one record) has every optional field absent instead.
  {
    const s = baseSeed('empty', 'no staff; statement with every optional field absent', d('2026-11-12T18:00:00Z'), d('2026-11-12T23:00:00Z'));
    s.shift.notes = null;
    s.venue = { name: 'The Grand Hall', address: null, contact: null };
    s.workspaceName = null;
    s.shift.workspaceId = null;
    s.signedOffName = null;
    s.breakConfirmed = null;
    s.finalisedBy = null;
    const lone: StaffSeed = { first: 'Ava', last: 'Smith', ref: null, assignmentStatus: 'completed', clockIn: d('2026-11-12T18:02:00Z'), clockOut: d('2026-11-12T22:58:00Z'), attendanceBreak: 0, attendanceStatus: 'approved' };
    s.statements.push(statementFor(s, lone, 'minimal', { approvedBy: null, period: null }));
    seeds.push(s);
  }
  // 2. One row.
  {
    const s = baseSeed('one-row', 'a single staff member', d('2026-11-13T17:00:00Z'), d('2026-11-13T23:30:00Z'));
    s.staff = [{ first: 'Oliver', last: 'Jones', ref: 'ST-1001', assignmentStatus: 'confirmed', clockIn: d('2026-11-13T16:58:00Z'), clockOut: d('2026-11-13T23:34:00Z'), attendanceStatus: 'approved', corrected: true, review: REVIEW }];
    s.statements.push(statementFor(s, s.staff[0]!));
    seeds.push(s);
  }
  // 3. Table sizes (P0 plan §5.2: 0, 1, 5, 40, 300, 500; the brief: 45 and 200), every status label, no-shows, missing
  //    clock-outs, no attendance, corrections, review / no review, and the sign-off variants spread across them.
  for (const n of [5, 40, 45, 200, 300, 500]) {
    const s = baseSeed(`rows-${n}`, `${n} staff (multi-page; header repeat, footer numbering)`, d('2026-11-14T16:00:00Z'), d('2026-11-15T00:00:00Z'));
    s.staff = generatedStaff(n, s.shift.startsAt, s.shift.endsAt);
    if (n === 5) {
      s.signedOffName = null; // finalised before the typed sign-off existed
      s.breakConfirmed = null;
    }
    if (n === 40) s.breakConfirmed = false; // signed off, break details NOT confirmed
    seeds.push(s);
  }
  // 4. Long names and notes.
  {
    const s = baseSeed('long-text', 'long names, refs, venue, address, contact and a 10 KB note (wrapping)', d('2026-11-16T09:00:00Z'), d('2026-11-16T17:00:00Z'));
    s.venue = {
      name: 'The Royal Grand Exhibition and Conference Centre — North Hall, Level Three, Members Entrance and Terrace Suites',
      address: 'Unit 14B, The Old Ropeworks Industrial Estate, 221 Long Acre Lane, Stoke Newington, London N16 7XY, United Kingdom',
      contact: { name: 'Bartholomew Alexander Fitzgerald-Worthington, Senior Duty Operations Manager', phone: '+44 (0) 20 7946 0000 ext. 4471' },
    };
    s.role = 'Senior Hospitality Supervisor (Banqueting, Silver Service and Private Dining)';
    // A 10 KB note (P0 plan §8 P3) of ordinary prose.
    s.shift.notes = Array.from(
      { length: 56 },
      (_, k) => `Paragraph ${k + 1}: arrive via the loading bay, sign the visitor book, collect lanyards from security, and brief the team on allergens, fire exits and the running order.`,
    ).join('\n\n');
    s.workspaceName = 'Adolphus Events — London & South East Corporate Hospitality Division';
    s.staff = Array.from({ length: 12 }, (_, i) => ({
      // 80+ characters with spaces (wraps in its cell).
      first: `Maximilian-Alexander Christopher ${FIRST[i % FIRST.length]}`,
      last: `Montgomery-Fitzgerald Worthington-Smythe ${LAST[i % LAST.length]} ${['III', 'IV', 'V', 'VI'][i % 4]}`,
      ref: `AGENCY-REF-2026-LONDON-${900000 + i}`,
      assignmentStatus: 'confirmed' as const,
      clockIn: addMin(s.shift.startsAt, i - 4),
      clockOut: addMin(s.shift.endsAt, i * 3),
      attendanceStatus: 'approved',
      corrected: i % 3 === 0,
      review: REVIEW,
    }));
    s.signedOffName = 'Bartholomew Alexander Fitzgerald-Worthington';
    s.finalisedBy = { first: 'Bartholomew Alexander', last: 'Fitzgerald-Worthington' };
    s.statements.push(statementFor(s, s.staff[0]!, '', { employerName: 'Adolphus Group Recruitment Consultants International Holdings Limited', approvedBy: 'Penelope Josephine Hargreaves-Cholmondeley' }));
    seeds.push(s);
  }
  // 5. A 1,000-character unbroken token and an 80-character unbroken name (P0 plan §8 P3): Chromium lets them overflow;
  //    the native renderer must wrap them.
  {
    const s = baseSeed('unbroken-token', 'a 1,000-character unbroken token in the notes and an 80-character unbroken name', d('2026-11-16T18:00:00Z'), d('2026-11-16T23:00:00Z'));
    s.shift.notes = `Token: ${'A1b2C3d4E5'.repeat(100)}`;
    s.staff = [{ first: 'X'.repeat(40), last: 'Y'.repeat(40), ref: 'ST-80', assignmentStatus: 'confirmed', clockIn: s.shift.startsAt, clockOut: s.shift.endsAt, attendanceStatus: 'approved' }];
    s.statements.push(statementFor(s, s.staff[0]!));
    seeds.push(s);
  }
  // 6. Unicode: Welsh, Polish, Arabic, CJK, emoji, accents.
  {
    const s = baseSeed('unicode', 'Welsh, Polish, Arabic, CJK, emoji and accented names, venue and notes', d('2026-11-17T18:00:00Z'), d('2026-11-18T01:00:00Z'));
    s.venue = { name: 'Caffi’r Ŵyl · Kraków Café 🎉 مقهى', address: 'Heol y Frenhines, Caerdydd CF10 2BH · ul. Floriańska 15, Kraków', contact: { name: 'Siân Llŷr', phone: '+48 12 345 67 89' } };
    s.role = 'Barista / Kelnerka / نادل';
    s.shift.notes = 'Croeso! Zażółć gęślą jaźń. مرحبا بكم. 欢迎光临. Bring your apron 👩\u200D🍳 and smile 😀. Crème brûlée, naïve façade, Ångström, Øresund.';
    s.workspaceName = 'Digwyddiadau Cymru · Wydarzenia';
    const names: Array<[string, string]> = [
      ['Siân', 'Llŷr ap Gwynedd'],
      ['Gwenllïan', 'Ŵyn-Jones'],
      ['Ffion', 'Llanfairpwllgwyngyll'],
      ['Zażółć', 'Gęślą-Jaźń'],
      ['Łukasz', 'Wiśniewski'],
      ['Małgorzata', 'Żółkiewska'],
      ['محمد', 'عبد الله'],
      ['فاطمة', 'الزهراء'],
      ['Chef 👩\u200D🍳', 'Emoji 🎉'],
      ['Zoë', 'Renée Ångström'],
      ['François', 'Müller-Lüdenscheidt'],
      ['Søren', 'Kierkegård'],
      ['王', '小明'],
      ['佐藤', '花子'],
      ['김', '민준'],
    ];
    s.staff = names.map(([first, last], i) => ({
      first,
      last,
      ref: `ŚT-${2000 + i}`,
      assignmentStatus: 'confirmed' as const,
      clockIn: addMin(s.shift.startsAt, i - 2),
      clockOut: addMin(s.shift.endsAt, i),
      attendanceStatus: 'approved',
      review: i % 2 ? REVIEW : null,
    }));
    s.finalisedBy = { first: 'Gwenllïan', last: 'Ŵyn' };
    s.signedOffName = 'Gwenllïan Ŵyn — Rheolwr';
    s.statements.push(statementFor(s, s.staff[6]!, '', { employerName: 'Grŵp Adolphus Sp. z o.o.', approvedBy: 'Łucja Żak' }));
    seeds.push(s);
  }
  // 7. Hostile text (the brief + P0 plan §8 P3): markup, URLs, javascript:, entities, template / PDF syntax, NUL, C0/C1
  //    controls, a lone surrogate, RTL override and isolates, zero-width characters.
  {
    const s = baseSeed('hostile', 'markup, URLs, javascript:, entities, PDF syntax, NUL / C0 / C1, lone surrogate, bidi overrides, zero-width', d('2026-11-19T18:00:00Z'), d('2026-11-19T23:00:00Z'));
    s.venue = {
      name: `<script>document.title='pwned'</script>Venue <b>Bold</b>`,
      address: `<img src=${H}/addr.png onerror=alert(1)> 1 Example St`,
      contact: { name: `javascript:alert(document.domain)`, phone: `<a href="${H}/phone">+44 20 7946 0000</a>` },
    };
    s.role = `<style>*{display:none}</style>Bar`;
    s.shift.notes =
      `<meta http-equiv="refresh" content="0;url=${H}/meta"><link rel=stylesheet href=${H}/x.css><iframe src=${H}/frame></iframe> ` +
      `<object data=${H}/obj></object> <style>@import url(${H}/imp.css); body{background:url(${H}/bg.png)}</style> ` +
      `&amp; &lt;b&gt; &#x3C;script&#x3E; "quoted" 'single' </td></tr></table> NUL[\u0000] C0[\u0001\u001F] ` +
      `RLO[\u202Eexe.txt] ZW[a\u200Bb\u200Cc\u200Dd\uFEFFe] %PDF-1.4 endstream endobj << /JavaScript >>`;
    s.workspaceName = `<i>WS</i>&nbsp;<!-- comment -->`;
    const hostileNames: Array<[string, string]> = [
      ['<script>alert(1)</script>', 'Scripted'],
      [`<img src=${H}/img.png>`, 'Imaged'],
      ['javascript:alert(1)', 'Linked'],
      ['Tom &amp; Jerry', '&lt;b&gt;Bold&lt;/b&gt;'],
      ['Nul\u0000l', 'By\u0000te'],
      ['Right\u202Eto-left', 'Override\u202C'],
      ['Zero\u200Bwidth', 'Jo\u200Diner\u200C'],
      [`"><svg onload=fetch('${H}/svg')>`, `'; DROP TABLE staff;--`],
      ['<link rel=stylesheet href=file:///etc/passwd>', `@import url(${H}/i.css);`],
      ['url(javascript:alert(1))', '{{constructor.constructor("x")()}}'],
      ['${process.env.APP_SECRET}', '%PDF-1.7 endstream endobj'],
      ['( ) \\ (unbalanced', '/Type /Action /S /JavaScript /JS (app.alert(1))'],
      ['<</S /JavaScript /JS (x)>>', '/OpenAction /Launch /URI (http://x)'],
      ['C1[\u0085\u009B]', 'Lone[\uD800]surrogate'],
      ['Isolates[\u2066a\u2067b\u2068c\u2069]', 'RLO[\u202Egnp.exe]'],
    ];
    s.staff = hostileNames.map(([first, last], i) => ({
      first,
      last,
      ref: i % 2 ? `<u>REF-${i}</u>` : `REF-${i}&copy;`,
      assignmentStatus: 'confirmed' as const,
      clockIn: addMin(s.shift.startsAt, i),
      clockOut: addMin(s.shift.endsAt, i),
      attendanceStatus: 'approved',
      review: REVIEW,
    }));
    s.finalisedBy = { first: '<b>Morgan</b>', last: `<img src=${H}/sig.png>` };
    s.signedOffName = `<script>alert('sig')</script> Morgan \u202Eregnam`;
    s.statements.push(statementFor(s, s.staff[0]!, '', { employerName: `<h1>Employer</h1> &amp; Co`, approvedBy: `<img src=${H}/approver.png>` }));
    seeds.push(s);
  }
  // 8. Edge values: worked minutes 0 / 1 / 23h59m / break longer than elapsed; pence edges; breakPaid true / false / null.
  {
    const s = baseSeed('edge-values', 'worked minutes 0, 1, 1439, break > elapsed; pence 0, 1, 99, 100, 1,000,000.00, rounding, large; breakPaid variants', d('2026-11-21T00:00:00Z'), d('2026-11-21T23:59:00Z'));
    const t0 = s.shift.startsAt;
    s.staff = [
      { first: 'Zero', last: 'Minutes', ref: 'E-0', assignmentStatus: 'confirmed', clockIn: t0, clockOut: t0, attendanceBreak: 0, attendanceStatus: 'approved' },
      { first: 'One', last: 'Minute', ref: 'E-1', assignmentStatus: 'confirmed', clockIn: t0, clockOut: addMin(t0, 1), attendanceBreak: 0, attendanceStatus: 'approved' },
      { first: 'Full', last: 'Day', ref: 'E-1439', assignmentStatus: 'confirmed', clockIn: t0, clockOut: addMin(t0, 1439), attendanceBreak: 0, attendanceStatus: 'approved' },
      { first: 'Break', last: 'Longer', ref: 'E-BRK', assignmentStatus: 'confirmed', clockIn: t0, clockOut: addMin(t0, 20), attendanceBreak: 45, attendanceStatus: 'approved' },
      { first: 'Rounding', last: 'Case', ref: 'E-RND', assignmentStatus: 'confirmed', clockIn: t0, clockOut: addMin(t0, 485), attendanceStatus: 'approved' },
    ];
    // Exactly one paid hour, so payForMinutes(rate, 60) = rate: the P0 plan's pence edges.
    const hour: StaffSeed = { ...s.staff[1]!, clockOut: addMin(t0, 60) };
    for (const p of [0, 1, 99, 100, 100_000_000]) s.statements.push(statementFor(s, hour, `pence-${p}`, { payRatePence: p }));
    s.statements.push(statementFor(s, s.staff[0]!, 'zero-minutes', { payRatePence: 1250 }));
    s.statements.push(statementFor(s, s.staff[4]!, 'half-penny-rounding', { payRatePence: 1251 }));
    s.statements.push(statementFor(s, s.staff[2]!, 'large', { payRatePence: 999_999 }));
    s.statements.push(statementFor(s, s.staff[2]!, 'very-large', { payRatePence: 2_500_000_000 }));
    const eight: StaffSeed = { first: 'Break', last: 'Variants', ref: 'E-BP', assignmentStatus: 'confirmed', clockIn: t0, clockOut: addMin(t0, 480), attendanceBreak: 30, attendanceStatus: 'approved' };
    s.statements.push(statementFor(s, eight, 'break-paid', { breaksPaid: true }));
    s.statements.push(statementFor(s, eight, 'break-unpaid'));
    s.statements.push(statementFor(s, { ...eight, attendanceBreak: 0 }, 'no-break'));
    seeds.push(s);
  }
  // 9. Across midnight (with a per-assignment window).
  {
    const s = baseSeed('midnight', 'shift and clock times across midnight', d('2026-11-20T22:00:00Z'), d('2026-11-21T06:00:00Z'));
    s.staff = generatedStaff(6, s.shift.startsAt, s.shift.endsAt);
    s.staff[0]!.period = [d('2026-11-20T23:30:00Z'), d('2026-11-21T04:00:00Z')];
    s.statements.push(statementFor(s, s.staff[0]!));
    seeds.push(s);
  }
  // 10/11. Europe/London changeovers: BST → GMT (25 Oct 2026, 02:00 BST = 01:00 GMT) and GMT → BST (29 Mar 2026).
  {
    const s = baseSeed('bst-to-gmt', 'shift across the BST→GMT change (Sun 25 Oct 2026): 00:30 BST → 05:00 GMT', d('2026-10-24T23:30:00Z'), d('2026-10-25T05:00:00Z'));
    s.staff = generatedStaff(5, s.shift.startsAt, s.shift.endsAt);
    s.staff[0]!.clockIn = d('2026-10-25T00:55:00Z'); // 01:55 BST
    s.staff[0]!.clockOut = d('2026-10-25T01:05:00Z'); // 01:05 GMT — the clock shows an EARLIER time than clock-in
    s.statements.push(statementFor(s, s.staff[0]!, 'repeated-hour'));
    s.statements.push(statementFor(s, s.staff[1]!, 'whole-shift'));
    seeds.push(s);
  }
  {
    const s = baseSeed('gmt-to-bst', 'shift across the GMT→BST change (Sun 29 Mar 2026): 00:30 GMT → 05:00 BST', d('2026-03-29T00:30:00Z'), d('2026-03-29T04:00:00Z'));
    s.staff = generatedStaff(5, s.shift.startsAt, s.shift.endsAt);
    s.staff[0]!.clockIn = d('2026-03-29T00:55:00Z'); // 00:55 GMT
    s.staff[0]!.clockOut = d('2026-03-29T01:05:00Z'); // 02:05 BST — 10 elapsed minutes print as 70 wall-clock minutes
    s.statements.push(statementFor(s, s.staff[0]!, 'skipped-hour'));
    seeds.push(s);
  }
  // 12. A non-London organisation timezone (America/New_York; its own DST change is Sun 1 Nov 2026).
  {
    const s = baseSeed('non-london', 'organisation timezone America/New_York, shift across its DST change (1 Nov 2026)', d('2026-11-01T04:00:00Z'), d('2026-11-01T10:00:00Z'), 'America/New_York');
    s.staff = generatedStaff(6, s.shift.startsAt, s.shift.endsAt);
    s.statements.push(statementFor(s, s.staff[0]!));
    seeds.push(s);
  }
  return seeds;
}

export interface FixtureDocument {
  /** `<scenario>/<document>` (+ `-<statement variant>`). */
  id: string;
  scenario: string;
  kind: DocumentKind;
  doc: ReportDocument;
}

/** Every fixture document of every scenario (optionally only some scenarios / kinds). */
export async function buildFixtures(options: FixtureOptions & { scenarios?: string[]; kinds?: DocumentKind[] } = {}): Promise<FixtureDocument[]> {
  const out: FixtureDocument[] = [];
  for (const seed of scenarioSeeds(options)) {
    if (options.scenarios && !options.scenarios.includes(seed.id)) continue;
    for (const f of await buildScenarioDocuments(seed)) {
      if (options.kinds && !options.kinds.includes(f.doc.kind)) continue;
      out.push({ id: f.id, scenario: f.scenario, kind: f.doc.kind, doc: f.doc });
    }
  }
  return out;
}

/** The fixture ids `buildFixtures` yields, computed synchronously (Jest needs test names before `beforeAll` runs). */
export function fixtureIds(options: FixtureOptions = {}): string[] {
  return scenarioSeeds(options).flatMap((s) => [
    `${s.id}/final-timesheet-original`,
    `${s.id}/final-timesheet`,
    `${s.id}/pre-shift-report`,
    ...s.statements.map((st) => `${s.id}/approved-shift-statement${st.id ? `-${st.id}` : ''}`),
  ]);
}
