import type { DocumentShiftInfo } from '../../modules/attendance/templates/adolphus-document';
import type { PreShiftReportData, PreShiftReportStaffRow } from '../../modules/attendance/templates/pre-shift-report.html';

/**
 * (Under src/__tests__ so it never ships in the server dist.) Deterministic pre-shift attendance sheet (roster) fixtures, shared by the golden-HTML spec (the Chromium template must
 * stay byte-identical across the view-model refactor) and by the renderer comparison (Chromium vs native, same data).
 *
 * `qrPngBase64` here is a fixed 1×1 PNG: the HTML embeds it verbatim and the native renderer checks the PNG signature,
 * so a tiny valid PNG keeps the golden files small. Comparisons that decode the QR substitute the real
 * `QrImageService.generatePng(token)` output.
 */
export const FIXTURE_QR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LONDON = 'Europe/London';

export const BASE_SHIFT_INFO: DocumentShiftInfo = {
  venueName: 'The Grand Hall & Terrace <Main>',
  venueAddress: '1 "High" Street, London',
  roleName: 'Bar Staff',
  department: null,
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-21T01:00:00.000Z',
  contactName: 'Jo Venue',
  contactPhone: '020 7946 0000',
  shiftReference: 'SHIFT-20261020-9A3B0C',
  workspaceName: 'Adolphus Events',
  notes: 'Black tie. Report to the side door.',
  timezone: LONDON,
  generatedAt: '2026-10-20T15:00:00.000Z',
};

function staff(n: number, overrides: (i: number) => Partial<PreShiftReportStaffRow> = () => ({})): PreShiftReportStaffRow[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Staff Member ${String(i + 1).padStart(2, '0')}`,
    staffRef: i % 2 === 0 ? `ST-${1000 + i}` : null,
    roleName: 'Bar Staff',
    scheduledStart: BASE_SHIFT_INFO.startsAt,
    scheduledEnd: BASE_SHIFT_INFO.endsAt,
    breakMinutes: i % 3 === 0 ? 30 : i % 3 === 1 ? null : 0,
    ...overrides(i),
  }));
}

function fixture(info: Partial<DocumentShiftInfo>, rows: PreShiftReportStaffRow[]): PreShiftReportData {
  return { ...BASE_SHIFT_INFO, ...info, staff: rows, qrPngBase64: FIXTURE_QR_PNG_BASE64 };
}

const HOSTILE_INFO: Partial<DocumentShiftInfo> = {
  venueName: '<img src="http://127.0.0.1:9/venue.png"><script>document.title="x"</script> & Co',
  venueAddress: `"Quoted" & 'single' <address>`,
  roleName: 'R&D <ops>',
  department: 'Events & <Ops>',
  contactName: '</td><td onclick="x()">',
  contactPhone: 'javascript:alert(1)',
  shiftReference: 'SHIFT-<b>REF</b>',
  workspaceName: '<img src="http://127.0.0.1:9/footer.png">',
  notes: '<link rel="stylesheet" href="http://127.0.0.1:9/x.css">&amp; &lt;b&gt; ${notes} {{x}}',
};

export const PRE_SHIFT_FIXTURES: Readonly<Record<string, PreShiftReportData>> = Object.freeze({
  'four-staff': fixture({}, staff(4)),
  empty: fixture({ notes: null }, []),
  'sixty-staff': fixture({}, staff(60)),
  hostile: fixture(
    HOSTILE_INFO,
    [
      { name: '<script>alert(1)</script> Smith', staffRef: '<i>ref</i>', roleName: 'R&D <ops>', scheduledStart: BASE_SHIFT_INFO.startsAt, scheduledEnd: BASE_SHIFT_INFO.endsAt, breakMinutes: 15 },
      { name: "Zoë O'Brien-Ñúñez", staffRef: null, roleName: 'Bar & "Floor"', scheduledStart: BASE_SHIFT_INFO.startsAt, scheduledEnd: BASE_SHIFT_INFO.endsAt, breakMinutes: null },
      { name: '&nbsp; &#60;x&#62;', staffRef: 'ST-&amp;', roleName: 'Bar Staff', scheduledStart: BASE_SHIFT_INFO.startsAt, scheduledEnd: BASE_SHIFT_INFO.endsAt, breakMinutes: 0 },
    ],
  ),
  'optional-absent': fixture({ venueAddress: null, contactName: null, contactPhone: '   ', workspaceName: null, notes: '   ', department: null }, staff(2)),
  'contact-phone-only': fixture({ contactName: null, contactPhone: '07700 900123', workspaceName: null }, staff(1)),
  // BST → GMT at 01:00 UTC on 2026-10-25: the start prints in BST, the finish in GMT.
  'dst-autumn-night': fixture(
    { startsAt: '2026-10-24T23:30:00.000Z', endsAt: '2026-10-25T06:00:00.000Z', generatedAt: '2026-10-24T21:00:00.000Z' },
    staff(3, (i) => ({ scheduledStart: '2026-10-24T23:30:00.000Z', scheduledEnd: i === 0 ? '2026-10-25T00:59:00.000Z' : '2026-10-25T06:00:00.000Z' })),
  ),
  // GMT → BST at 01:00 UTC on 2026-03-29.
  'dst-spring-night': fixture(
    { startsAt: '2026-03-28T23:00:00.000Z', endsAt: '2026-03-29T05:00:00.000Z', generatedAt: '2026-03-28T20:00:00.000Z' },
    staff(2, () => ({ scheduledStart: '2026-03-28T23:00:00.000Z', scheduledEnd: '2026-03-29T05:00:00.000Z' })),
  ),
  'non-london-timezone': fixture({ timezone: 'America/New_York' }, staff(3)),
  'per-assignment-windows': fixture(
    {},
    staff(3, (i) => ({
      scheduledStart: ['2026-10-20T16:00:00.000Z', '2026-10-20T18:15:00.000Z', '2026-10-20T17:00:00.000Z'][i]!,
      scheduledEnd: ['2026-10-20T23:00:00.000Z', '2026-10-21T02:45:00.000Z', '2026-10-21T01:00:00.000Z'][i]!,
      breakMinutes: [45, 0, null][i]!,
    })),
  ),
  'long-text': fixture(
    {
      venueName: 'The Exceptionally Long Venue Name Conference And Banqueting Centre At The Old Riverside Warehouse Quarter',
      notes: 'Arrive 15 minutes early. '.repeat(24).trim(),
      contactName: 'Alexandria Constance Montgomery-Fitzwilliam',
    },
    staff(5, (i) => ({
      name: i === 0 ? 'Bartholomew-Maximilian Featherstonehaugh-Cholmondeley Worthington-Smythe' : i === 1 ? 'Supercalifragilisticexpialidociousandthensomemorewithoutanyspaces' : `Staff Member ${i}`,
    })),
  ),
});

export const PRE_SHIFT_FIXTURE_NAMES = Object.freeze(Object.keys(PRE_SHIFT_FIXTURES));
