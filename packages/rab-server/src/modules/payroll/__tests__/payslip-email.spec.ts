import { payslipEmailText } from '../constants/payslip-email';

/** Owner decision 7: the payslip email is a pointer only (no attachment, no pay figures, no file link, sign-in required). */
describe('payslip email text (decision 7)', () => {
  const run = { period_start: '2026-10-12', period_end: '2026-10-25', payday: '2026-11-04' };

  it('names the period and payday and tells the reader to sign in to the app', () => {
    const text = payslipEmailText(run, 1);
    expect(text).toContain('Your payslip is ready for 2026-10-12 – 2026-10-25 (payday 2026-11-04).');
    expect(text).toContain('Open the Crewflow app and sign in to view it.');
    expect(text).toContain('payslips are never attached to emails');
    expect(payslipEmailText(run, 2)).toContain('Your payslip has been updated');
  });

  it('carries no link, token, file id or money', () => {
    const text = payslipEmailText(run, 3);
    expect(text).not.toMatch(/https?:\/\/|www\.|token|\/files\//i);
    expect(text).not.toMatch(/£|\bGBP\b|pence|\bnet\b|\bgross\b/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
