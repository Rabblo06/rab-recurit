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

const FIXTURES: Array<[string, ApprovedShiftStatementData, string]> = [
  ['typical', base, 'fc934e0db7e95e56519d155afecea819948e919e3d5604e1399b49353ea2b426'],
  ['night shift in BST, paid break, no period, no approver', {
    ...base, statementReference: 'ASS-20260815-0F0E0D0C', scheduledStart: '2026-08-15T21:00:00.000Z', scheduledEnd: '2026-08-16T05:30:00.000Z',
    clockInAt: '2026-08-15T20:55:00.000Z', clockOutAt: '2026-08-16T05:31:00.000Z', breakMinutes: 45, breakPaid: true, payableMinutes: 516, payRatePence: 1525,
    amountPence: 13115, approvedByName: null, payrollPeriodLabel: null, paydayLabel: null,
  }, '69b05670109bf9b5ce12fd07ebdaac3b618a70fc6b5b3a84aeea5475b08a2184'],
  ['zero pence, no clock times, no break, no staff ref', {
    ...base, payRatePence: 0, amountPence: 0, payableMinutes: 0, clockInAt: null, clockOutAt: null, breakMinutes: null, breakPaid: null, staffRef: null,
  }, 'ac826fc69a635f0a460ef2a08b223701322d90435404a8bae89e9edd1e4f8ac0'],
  ['one penny', { ...base, payRatePence: 1, amountPence: 1, payableMinutes: 1, breakMinutes: 7, breakPaid: null }, '0cf0bd6613c7afddeafeb8ae39f3efa0837c34cf99ab5e946f5528a777ee088c'],
  ['large amount', { ...base, payRatePence: 99_999_999, amountPence: 123_456_789_012, payableMinutes: 7_407_407 }, 'd7156ec17638b041ff04989a90d71bbf92d0e93360e717b54e07db743ff67b5c'],
  ['hostile text', {
    ...base, staffName: HOSTILE, employerName: HOSTILE, workspaceName: HOSTILE, venueName: HOSTILE, roleName: HOSTILE, approvedByName: HOSTILE, staffRef: '<b>ref</b>',
    payrollPeriodLabel: '<i>period</i>', paydayLabel: '&nbsp;payday',
  }, '1117add25b39961959eccb3f697190753acbfca3be747cf0ce651c9167d0f7bc'],
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
