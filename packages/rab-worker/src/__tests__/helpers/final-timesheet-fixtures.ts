import { FinalTimesheetData, FinalTimesheetStaffRow } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

/**
 * Synthetic final-timesheet data for the renderer specs (no database): the shape `final-timesheet.job.ts` builds from
 * real rows, with every status, a no-show, a missing clock-out, corrections and reviews. Worked minutes are fixed
 * numbers standing in for the attendance service's stored values (the renderers never compute them).
 */
const TZ = 'Europe/London';

export const SHIFT_INFO = Object.freeze({
  venueName: 'The Grand Hall & Terrace <Main>',
  venueAddress: '12 Riverside Walk, London SE1 9PG',
  roleName: 'Bar Staff',
  department: null,
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-21T01:00:00.000Z',
  contactName: 'Jordan Lee',
  contactPhone: '+44 20 7946 0000',
  shiftReference: 'SHF-20261020-4F2A',
  workspaceName: 'Adolphus Events',
  notes: 'Black tie. Report to the staff entrance <rear>.',
  timezone: TZ,
  generatedAt: '2026-10-20T15:00:00.000Z',
});

const STATUSES = ['approved', 'clocked_out', 'missing_clock_out', 'under_review', 'absent', 'disputed'];

export function staffRows(n: number, name: (i: number) => string = (i) => `Staff Member ${String(i + 1).padStart(2, '0')}`): FinalTimesheetStaffRow[] {
  return Array.from({ length: n }, (_, i) => ({
    name: name(i),
    staffRef: `ST-${1000 + i}`,
    roleName: i % 3 === 0 ? 'Supervisor' : 'Bar Staff',
    scheduledStart: SHIFT_INFO.startsAt,
    scheduledEnd: SHIFT_INFO.endsAt,
    clockInAt: i === 4 ? null : '2026-10-20T16:58:00.000Z',
    clockOutAt: i === 2 || i === 4 ? null : '2026-10-21T01:03:00.000Z',
    breakMinutes: i % 4 === 0 ? null : 30,
    workedMinutes: i === 4 ? null : 455 + i,
    status: STATUSES[i % STATUSES.length]!,
    assignmentStatus: i === 4 ? 'no_show' : 'confirmed',
    corrected: i % 5 === 1,
    review: i % 2 === 0 ? { grooming: 5, attitude: 4, skills: 4, attendance: 5, timeKeeping: 3 } : null,
  }));
}

const SIGNED = { unsigned: false, finalisedByName: 'Morgan Manager', finalisedAt: '2026-10-21T09:30:00.000Z', signedOffName: 'Morgan A. Manager', breakConfirmed: true };

const LONG_NAMES = [
  'Maximilian-Alexander Bartholomew Fitzgerald-Montgomery-Worthington III',
  'Anna-Katharina Schmidt-Müller von Hohenzollern-Sigmaringen',
  'Oluwaseun Adebayo-Ogunleye Chukwuemeka Nwachukwu',
  'Ng',
];

const SPECIAL_NAMES = [
  '<script>alert(1)</script> Smith',
  '<img src=http://127.0.0.1:9/x.png> Jones',
  'Zoë O\'Brien-Ållström & "Søren" Ðorđević',
  'Łukasz Żółć · Ñandú — “quoted” ‘single’ … €£$',
  '&lt;b&gt;Entity&amp; Name',
  'javascript:alert(1) Name',
];

/** The comparison set: 1 page, 40+ rows, the unsigned original, long names, special characters, no staff. */
export const FINAL_TIMESHEET_CASES: Readonly<Record<string, FinalTimesheetData>> = Object.freeze({
  'one-page': { ...SHIFT_INFO, ...SIGNED, staff: staffRows(5) },
  'multi-page-45': { ...SHIFT_INFO, ...SIGNED, staff: staffRows(45) },
  'unsigned-original': { ...SHIFT_INFO, unsigned: true, finalisedByName: 'Morgan Manager', finalisedAt: '2026-10-21T09:30:00.000Z', staff: staffRows(8) },
  'long-names': {
    ...SHIFT_INFO,
    ...SIGNED,
    venueName: 'The Exceptionally Long Venue Name Conference Centre & Riverside Banqueting Suites (East Wing)',
    venueAddress: 'Unit 4B, The Old Brewery Courtyard, 1234 Extraordinarily Long Industrial Estate Road, Kingston upon Thames, Greater London KT1 1AA, United Kingdom',
    workspaceName: 'Adolphus Events & Hospitality Staffing — South-East Regional Workspace',
    notes: 'Notes '.repeat(60).trim(),
    staff: staffRows(8, (i) => LONG_NAMES[i % LONG_NAMES.length]!),
  },
  'special-chars': {
    ...SHIFT_INFO,
    ...SIGNED,
    venueName: '<b>Venue</b> & "Ballroom" — Café Ünïcödé',
    notes: '<script>fetch("http://127.0.0.1:9")</script> &amp; <iframe src=file:///etc/passwd>',
    signedOffName: '<i>Morgan</i> "MM" O\'Manager',
    staff: staffRows(6, (i) => SPECIAL_NAMES[i % SPECIAL_NAMES.length]!),
  },
  empty: { ...SHIFT_INFO, ...SIGNED, staff: [] },
});
