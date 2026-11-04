import { createHash } from 'node:crypto';

import {
  ApprovedShiftStatementData,
  buildApprovedShiftStatementViewModel,
  TO_BE_CONFIRMED,
} from '@rab/server/modules/payroll/templates/approved-shift-statement.view-model';

import { inspectPdf } from '../../../__tests__/helpers/pdf-inspect';
import { renderReportPdf } from '../render-pdf.util';
import { STATEMENT_PAGE_MARGIN } from './approved-shift-statement.native';

/**
 * Approved Shift Statement, native renderer (PDF_RENDERER=native; no browser, no database). The layout prints the
 * shared view-model and nothing else: every printed string is a view-model string, every money value parses back to the
 * record's exact pence, user text is printed literally, nothing is fetched, the output is deterministic (D7), and the
 * page has the owner-approved 12 mm margins (D9). Chromium-vs-native comparison evidence: the P2 compare run.
 */
jest.setTimeout(60_000);

const NATIVE = { PDF_RENDERER: 'native' } as NodeJS.ProcessEnv;
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
  payrollPeriodLabel: null,
  paydayLabel: null,
  timezone: 'Europe/London',
  generatedAt: '2026-10-22T10:05:00.000Z',
};

const render = (data: ApprovedShiftStatementData) => renderReportPdf({ kind: 'approved-shift-statement', data }, NATIVE);
const squash = (s: string) => s.replace(/\s+/g, '');
/** "£1,234.56" → 123456n, with no float arithmetic. */
const pence = (s: string): bigint => {
  const m = /^£(-?)([\d,]+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error(`not money: ${s}`);
  const v = BigInt(m[2]!.replace(/,/g, '')) * 100n + BigInt(m[3]!);
  return m[1] ? -v : v;
};
function printedStrings(data: ApprovedShiftStatementData): string[] {
  const vm = buildApprovedShiftStatementViewModel(data);
  return [vm.title.toUpperCase(), vm.brandLine, vm.approvedLine, vm.staffLabel.toUpperCase(), vm.staffName, vm.staffRefLine, vm.referenceLabel.toUpperCase(),
    vm.statementReference, ...[...vm.details, vm.total, ...vm.approval].flatMap((r) => [r.label, r.value]), vm.generatedLine, vm.disclaimer];
}

describe('Approved Shift Statement — native renderer', () => {
  it('prints every view-model string (and "To be confirmed" exactly twice without a period), one page, the logo only', async () => {
    const pdf = await render(base);
    const doc = inspectPdf(pdf);
    expect(doc.pageCount).toBe(1);
    expect(doc.images).toEqual(['166x70']);
    for (const s of printedStrings(base)) expect(squash(doc.text)).toContain(squash(s));
    expect(doc.text.split(TO_BE_CONFIRMED).length - 1).toBe(2);
    expect(doc.text).not.toMatch(/payslip<\/|Net pay/i);
  });

  it.each([
    [0, 0],
    [1, 1],
    [99, 100],
    [9479, 1250],
    [123_456_789_012, 99_999_999],
  ])('money parses back to the exact pence: gross %d, rate %d', async (amountPence, payRatePence) => {
    const text = inspectPdf(await render({ ...base, amountPence, payRatePence })).text;
    const printed = text.match(/£-?[\d,]+\.\d{2}/g) ?? [];
    expect(printed.map(pence)).toEqual([BigInt(payRatePence), BigInt(amountPence)]);
  });

  it('prints hostile text literally: no markup, no extra image, no PDF action, no network', async () => {
    const net = require('net') as typeof import('net');
    const dns = require('dns') as typeof import('dns');
    const connect = jest.spyOn(net.Socket.prototype, 'connect');
    const lookup = jest.spyOn(dns, 'lookup');
    try {
      const hostile: ApprovedShiftStatementData = {
        ...base,
        staffName: '<script>alert(1)</script>',
        venueName: '<img src="http://127.0.0.1:9/leak.png">',
        roleName: '&lt;b&gt;not bold&lt;/b&gt; &amp;',
        employerName: '<link rel="stylesheet" href="file:///etc/passwd">',
        workspaceName: 'javascript:alert(1)',
        approvedByName: '/Type /Action /S /JavaScript (x) endstream endobj',
        staffRef: '%PDF-1.7',
        payrollPeriodLabel: '${7*7} {{7*7}}',
        paydayLabel: '<i>payday</i>',
      };
      const pdf = await render(hostile);
      const doc = inspectPdf(pdf);
      for (const s of printedStrings(hostile)) expect(squash(doc.text)).toContain(squash(s));
      expect(doc.images).toEqual(['166x70']);
      expect(pdf.toString('latin1')).not.toMatch(/\/(JavaScript|JS|OpenAction|Launch|URI|EmbeddedFile|AA|AcroForm)\b/);
      expect(connect).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      lookup.mockRestore();
    }
  });

  it('is deterministic (D7): the same record renders to the same bytes', async () => {
    const sha = async () => createHash('sha256').update(await render(base)).digest('hex');
    expect(await sha()).toBe(await sha());
  });

  it('A4 portrait with 12 mm margins on every side (D9; Chromium prints this document with 0 mm)', async () => {
    const pdf = (await render(base)).toString('latin1');
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
    expect(box && [Math.round(Number(box[1])), Math.round(Number(box[2]))]).toEqual([595, 842]);
    const twelveMm = (12 * 72) / 25.4;
    expect(STATEMENT_PAGE_MARGIN).toEqual({ top: twelveMm, right: twelveMm, bottom: twelveMm, left: twelveMm });
  });
});
