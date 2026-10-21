/**
 * "Adolphus Recruitment Calendar of Payment 2026", as published (owner decision 2026-10-21). Loaded only by an explicit,
 * authorised import (`payroll:import-calendar --official-2026` or POST /payroll/calendar/import), never applied
 * automatically. The two February periods are irregular and are USED AS PUBLISHED (owner decision), with a note.
 * No 2027 periods beyond the last published row.
 */
export const OFFICIAL_CALENDAR_2026 = {
  year: 2026,
  source: 'Adolphus Recruitment Calendar of Payment 2026',
  notes:
    'Guidance only, never a payment confirmation: payments are made every 2 weeks; money typically arrives in the bank between 5pm and 6pm on payday; a first salary may arrive one day late.',
  periods: [
    ['2025-12-08', '2025-12-21', '2025-12-31'],
    ['2025-12-22', '2026-01-04', '2026-01-14'],
    ['2026-01-05', '2026-01-18', '2026-01-28'],
    ['2026-01-19', '2026-02-01', '2026-02-11'],
    ['2026-02-02', '2026-02-16', '2026-02-25', 'Published irregular period (15 days); used as published.'],
    ['2026-02-17', '2026-03-01', '2026-03-11', 'Published irregular period (13 days); used as published.'],
    ['2026-03-02', '2026-03-15', '2026-03-25'],
    ['2026-03-16', '2026-03-29', '2026-04-08'],
    ['2026-03-30', '2026-04-12', '2026-04-22'],
    ['2026-04-13', '2026-04-26', '2026-05-06'],
    ['2026-04-27', '2026-05-10', '2026-05-20'],
    ['2026-05-11', '2026-05-24', '2026-06-03'],
    ['2026-05-25', '2026-06-07', '2026-06-17'],
    ['2026-06-08', '2026-06-21', '2026-07-01'],
    ['2026-06-22', '2026-07-05', '2026-07-15'],
    ['2026-07-06', '2026-07-19', '2026-07-29'],
    ['2026-07-20', '2026-08-02', '2026-08-12'],
    ['2026-08-03', '2026-08-16', '2026-08-26'],
    ['2026-08-17', '2026-08-30', '2026-09-09'],
    ['2026-08-31', '2026-09-13', '2026-09-23'],
    ['2026-09-14', '2026-09-27', '2026-10-07'],
    ['2026-09-28', '2026-10-11', '2026-10-21'],
    ['2026-10-12', '2026-10-25', '2026-11-04'],
    ['2026-10-26', '2026-11-08', '2026-11-18'],
    ['2026-11-09', '2026-11-22', '2026-12-02'],
    ['2026-11-23', '2026-12-06', '2026-12-16'],
    ['2026-12-07', '2026-12-20', '2026-12-30'],
    ['2026-12-21', '2027-01-03', '2027-01-13'],
  ].map(([start, end, payday, note]) => ({ start: start!, end: end!, payday: payday!, note: note ?? null, needsConfirmation: false })),
} as const;
