import { createHash } from 'node:crypto';

import { approvedShiftStatementHtmlFromViewModel, renderApprovedShiftStatementHtml } from './approved-shift-statement.html';
import { ApprovedShiftStatementData, buildApprovedShiftStatementViewModel, TO_BE_CONFIRMED } from './approved-shift-statement.view-model';

/**
 * Approved Shift Statement view-model (PDF renderer migration, P2). The Chromium template now prints from the shared
 * view-model; T1 pins that its HTML is byte-identical to the template on origin/main 824f0824 (sha256 of that template's
 * output for the same fixtures, computed before the refactor). The view-model is the one place money, minutes, dates
 * and labels are decided for BOTH renderers.
 */
const base: ApprovedShiftStatementData = {
  statementReference: 'ASS-20261020-1A2B3C4D',
  employerName: 'Adolphus Group Ltd',
  workspaceName: 'Adolphus Events',
  staffName: 'Alex Example',
  staffRef: 'ST-1001',
  venueName: 'The Grand Hall',
  roleName: 'Bar Staff',
  scheduledStart: '2026-10-20T17:00:00.000Z',
  scheduledEnd: '2026-10-21T01:00:00.000Z',
  clockInAt: '2026-10-20T16:58:00.000Z',
  clockOutAt: '2026-10-21T01:03:00.000Z',
  breakMinutes: 30,
  breakPaid: false,
  payableMinutes: 455,
  payRatePence: 1250,
  amountPence: 9479,
  approvedAt: '2026-10-22T10:00:00.000Z',
  approvedByName: 'Pat Payroll',
  payrollPeriodLabel: '12 Oct 2026 – 25 Oct 2026',
  paydayLabel: 'Wed, 4 Nov 2026',
  timezone: 'Europe/London',
  generatedAt: '2026-10-22T10:05:00.000Z',
};
const HOSTILE = `<script>alert('x')</script><img src="http://127.0.0.1:9/leak.png"> &amp; &lt;b&gt; "quoted" 'single' ‮evil‬ zero​width`;

// The pinned hashes changed ONCE since the refactor, for the shared DOCUMENT_CSS rules of the F-PDF-1 fix and pre-line
// notes (`.bottom > div { …; min-width: 0; overflow-wrap: anywhere; }`, `.notes-text { white-space: pre-line; }`, owner
// decision 2026-11-04). VERIFIED when re-pinned: with those two CSS lines restored, every fixture hashes to its old value,
// so nothing else in the statement HTML changed.
const FIXTURES: Array<[string, ApprovedShiftStatementData, string]> = [
  ['typical', base, '0a1200eee431d7bf30198d31a7e5d9a142b2ff5a2d793f6fbcb0adb519ceeada'],
  ['night shift in BST, paid break, no period, no approver', {
    ...base, statementReference: 'ASS-20260815-0F0E0D0C', scheduledStart: '2026-08-15T21:00:00.000Z', scheduledEnd: '2026-08-16T05:30:00.000Z',
    clockInAt: '2026-08-15T20:55:00.000Z', clockOutAt: '2026-08-16T05:31:00.000Z', breakMinutes: 45, breakPaid: true, payableMinutes: 516, payRatePence: 1525,
    amountPence: 13115, approvedByName: null, payrollPeriodLabel: null, paydayLabel: null,
  }, '7e5085757ea5307bfdbddceab2f6e4967005d95f3c8222ef807dbfb72cff1452'],
  ['zero pence, no clock times, no break, no staff ref', {
    ...base, payRatePence: 0, amountPence: 0, payableMinutes: 0, clockInAt: null, clockOutAt: null, breakMinutes: null, breakPaid: null, staffRef: null,
  }, 'ba35f4fb45baa4474e54c726d08ebd44b14a51dd6acab56fe8cc7a90e336f25e'],
  ['one penny', { ...base, payRatePence: 1, amountPence: 1, payableMinutes: 1, breakMinutes: 7, breakPaid: null }, '5df7f3e5c8799a8ee394a3c1adecb199875354da860631d272675d28023be739'],
  ['large amount', { ...base, payRatePence: 99_999_999, amountPence: 123_456_789_012, payableMinutes: 7_407_407 }, '53ab877c0312bdb4b26bf4fffd2a8b0f9ffb1eb862c17cef0d970445330f1ae0'],
  ['hostile text', {
    ...base, staffName: HOSTILE, employerName: HOSTILE, workspaceName: HOSTILE, venueName: HOSTILE, roleName: HOSTILE, approvedByName: HOSTILE, staffRef: '<b>ref</b>',
    payrollPeriodLabel: '<i>period</i>', paydayLabel: '&nbsp;payday',
  }, '279e1aa8847e283157f1194398c3ae6e8a589c34fc56a16532c6bac8fcc524ec'],
];

describe('Approved Shift Statement view-model', () => {
  it.each(FIXTURES)('T1: the Chromium HTML is byte-identical to the pre-refactor template (%s)', (_name, data, sha) => {
    const html = renderApprovedShiftStatementHtml(data);
    expect(createHash('sha256').update(html).digest('hex')).toBe(sha);
    expect(approvedShiftStatementHtmlFromViewModel(buildApprovedShiftStatementViewModel(data))).toBe(html);
  });

  it('money is formatted once, from integer pence, by @rab/shared formatPence', () => {
    const at = (amountPence: number, payRatePence: number) => {
      const vm = buildApprovedShiftStatementViewModel({ ...base, amountPence, payRatePence });
      return [vm.total.value, vm.details.find((r) => r.label === 'Approved hourly rate')!.value];
    };
    expect(at(0, 0)).toEqual(['£0.00', '£0.00 per hour']);
    expect(at(1, 1)).toEqual(['£0.01', '£0.01 per hour']);
    expect(at(99, 100)).toEqual(['£0.99', '£1.00 per hour']);
    expect(at(9479, 1250)).toEqual(['£94.79', '£12.50 per hour']);
    expect(at(123_456_789_012, 99_999_999)).toEqual(['£1,234,567,890.12', '£999,999.99 per hour']);
    expect(() => buildApprovedShiftStatementViewModel({ ...base, amountPence: 94.79 })).toThrow(RangeError);
  });

  it('prints stored minutes, scheduled hours, break wording and the London date, and "To be confirmed" without a period', () => {
    const vm = buildApprovedShiftStatementViewModel({ ...base, payrollPeriodLabel: null, paydayLabel: null });
    const value = (label: string) => [...vm.details, vm.total, ...vm.approval].find((r) => r.label === label)!.value;
    expect(value('Shift date')).toBe('Tue, 20 Oct 2026');
    expect(value('Scheduled hours')).toBe('18:00–02:00 (8h)');
    expect(value('Actual clock-in')).toBe('Tue, 20 Oct 2026, 17:58');
    expect(value('Break')).toBe('0h 30m (unpaid)');
    expect(value('Verified payable hours')).toBe('7h 35m');
    expect(value('Approval date')).toBe('Thu, 22 Oct 2026, 11:00 by Pat Payroll');
    expect(value('Payroll period')).toBe(TO_BE_CONFIRMED);
    expect(value('Official scheduled payday')).toBe(TO_BE_CONFIRMED);
    expect(vm.generatedLine).toBe('Generated Thu, 22 Oct 2026, 11:05.');
    expect(vm.brandLine).toBe('Adolphus Recruitment · Adolphus Group Ltd · Adolphus Events');
  });

  it('keeps user text as plain text (escaping is the HTML renderer\'s job, never the view-model\'s)', () => {
    const vm = buildApprovedShiftStatementViewModel({ ...base, staffName: HOSTILE });
    expect(vm.staffName).toBe(HOSTILE);
    const html = approvedShiftStatementHtmlFromViewModel(vm);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src="http');
    expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
  });
});
