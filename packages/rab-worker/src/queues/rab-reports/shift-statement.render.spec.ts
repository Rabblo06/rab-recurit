import { AuditAction } from '@rab/server/engine/core-modules/audit/audit.service';
import { buildApprovedShiftStatementViewModel } from '@rab/server/modules/payroll/templates/approved-shift-statement.view-model';

import { fakeTenant } from '../../__tests__/helpers/dispatch-fakes';
import { PdfNativeRenderError } from './native/runtime/render-protocol';
import { PdfRenderTimeoutError } from './native/runtime/render-timeout';
import { ReportDocument } from './render-pdf.util';
import { processShiftStatementJob } from './shift-statement.job';

/**
 * Approved Shift Statement consumer, renderer hand-off (no database): the job passes the renderer DATA (owner decision
 * D1), and the payroll record's frozen bigint pence enter that data through `@rab/shared` money.ts's `assertSafePence`
 * — a value outside Number's exact range is refused (the statement fails closed, retried and audited like any other
 * failure), never rounded to a neighbouring, plausible-looking amount.
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const REC = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const JOB = { payrollRecordId: REC, organisationId: ORG, workspaceId: WS, generation: 3 };

function recordRow(over: Record<string, unknown> = {}) {
  return {
    id: REC, organisation_id: ORG, workspace_id: WS, worked_minutes: 455, pay_rate_pence: '1250', amount_pence: '9479',
    approved_at: '2026-10-22T10:00:00.000Z', clock_in_at: '2026-10-20T16:58:00.000Z', clock_out_at: '2026-10-21T01:03:00.000Z',
    break_minutes: 30, staff_ref: 'ST-1001', staff_user_id: '00000000-0000-4000-8000-0000000000u1', first_name: 'Alex', last_name: 'Example',
    venue_name: 'The Grand Hall', role_name: 'Bar Staff', starts_at: '2026-10-20T17:00:00.000Z', ends_at: '2026-10-21T01:00:00.000Z',
    approved_by_name: 'Pat Payroll', org_name: 'Adolphus Group Ltd', timezone: 'Europe/London', workspace_name: 'Adolphus Events',
    ...over,
  };
}

function harness(row: Record<string, unknown>) {
  const { tenant, statements } = fakeTenant((sql) => {
    if (sql.startsWith('SELECT statement_status, statement_dispatch_generation')) {
      return [{ statement_status: 'queued', statement_dispatch_generation: 3, statement_file_id: null, status: 'approved' }];
    }
    if (sql.startsWith('SELECT pr.id, pr.organisation_id')) return [row];
    if (sql.startsWith("UPDATE payroll_record SET statement_status = 'failed'")) return [[], 1];
    return [];
  });
  const docs: ReportDocument[] = [];
  const render = jest.fn(async (doc: ReportDocument) => { docs.push(doc); return Buffer.from('%PDF-1.3 test'); });
  // Stop right after the render: the upload / registration path is covered by shift-statement.integration.spec.ts.
  const files = { putObject: jest.fn(async () => { throw new Error('stop after render'); }), discardUnregistered: jest.fn(async () => undefined) };
  const deps = { tenantContext: tenant, files, notifications: {}, render } as never;
  const failure = () => statements.find((s) => s.sql.startsWith("UPDATE payroll_record SET statement_status = 'failed'"));
  return { deps, render, docs, failure };
}

describe('shift statement consumer: data-in renderer hand-off and pence entry', () => {
  it('hands the renderer the data-in document (kind + data), with the frozen pence exact', async () => {
    const h = harness(recordRow());
    await processShiftStatementJob(JOB, h.deps);
    expect(h.render).toHaveBeenCalledTimes(1);
    const doc = h.docs[0]!;
    expect(doc.kind).toBe('approved-shift-statement');
    expect(doc.data).toMatchObject({ payRatePence: 1250, amountPence: 9479, payableMinutes: 455, statementReference: 'ASS-20261020-0F1E2D3C' });
    const vm = buildApprovedShiftStatementViewModel(doc.data);
    expect(vm.total).toEqual({ label: 'Approved gross', value: '£94.79' });
    expect(vm.details.find((r) => r.label === 'Approved hourly rate')!.value).toBe('£12.50 per hour');
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['123456789012', 123456789012],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('accepts amount_pence %s exactly', async (raw, pence) => {
    const h = harness(recordRow({ amount_pence: raw, pay_rate_pence: raw }));
    await processShiftStatementJob(JOB, h.deps);
    expect(h.docs[0]!.data.amountPence).toBe(pence);
    expect(h.docs[0]!.data.payRatePence).toBe(pence);
  });

  it.each([
    ['amount_pence', '9007199254740993'], // 2^53 + 1: Number() would silently print 2^53 pence
    ['amount_pence', '-9007199254740993'],
    ['pay_rate_pence', '99999999999999999999'],
  ])('refuses %s = %s (outside the exact range): no render, recorded as a failed attempt', async (column, raw) => {
    const h = harness(recordRow({ [column]: raw }));
    expect(await processShiftStatementJob(JOB, h.deps)).toBe('failed');
    expect(h.render).not.toHaveBeenCalled();
    const failure = h.failure();
    expect(failure).toBeDefined();
    expect(failure!.params).toEqual([REC, 3, 'generation_failed']);
  });
});

/**
 * A native renderer failure is visible and auditable, never a silent Chromium fallback (owner decision, FINAL): the
 * statement is recorded as failed with the renderer's own code, and the SHIFT_STATEMENT_FAILED audit row carries it.
 */
describe('shift statement consumer: a native render failure keeps its code', () => {
  it.each([
    ['render error', () => new PdfNativeRenderError('native PDF render thread failed to start'), 'error_PDF_NATIVE_RENDER'],
    ['deadline', () => new PdfRenderTimeoutError('native-render', 30_000), 'error_PDF_RENDER_TIMEOUT'],
  ])('%s → statement_error and the audit metadata carry the renderer code', async (_label, make, code) => {
    const h = harness(recordRow());
    h.render.mockRejectedValueOnce(make());
    const audit = { record: jest.fn(async () => undefined) };
    expect(await processShiftStatementJob(JOB, { ...(h.deps as object), audit } as never)).toBe('failed');
    expect(h.failure()!.params).toEqual([REC, 3, code]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      AuditAction.SHIFT_STATEMENT_FAILED,
      expect.objectContaining({ entityId: REC, metadata: expect.objectContaining({ code }) }),
    );
  });
});
