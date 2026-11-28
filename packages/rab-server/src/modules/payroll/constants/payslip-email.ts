/**
 * Owner decision 7 (2026-11-21): the payslip email is a pointer only. Period and payday dates (no amounts, no name of the
 * employer's provider, no link that opens the file); the reader signs in to the Crewflow app to open it.
 */
export function payslipEmailText(run: { period_start: string; period_end: string; payday: string }, version: number): string {
  return [
    `${version === 1 ? 'Your payslip is ready' : 'Your payslip has been updated'} for ${run.period_start} – ${run.period_end} (payday ${run.payday}).`,
    'Open the Crewflow app and sign in to view it.',
    'For your security, payslips are never attached to emails.',
  ].join('\n\n');
}
