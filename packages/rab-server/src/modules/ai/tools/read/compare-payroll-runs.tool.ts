import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PayrollAssistantService } from '../../../payroll/services/payroll-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { isoDay } from '../ai-date-range';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = z.strictObject({
  periodStart: isoDay.optional().describe('Start date of the period to examine (default: the latest period with a run).'),
  comparePeriodStart: isoDay.optional().describe('Start date of the period to compare with (default: the run before it).'),
});

/**
 * Phase 1 tool, name unchanged ("payroll totals"), RE-BACKED (P3 C8 / D6): `PayrollAssistantService.assistantRunTotals`
 * computes every figure as a SQL aggregate (no per-staff row ever reaches this process); money is integer pence plus the
 * `formatPence` string. The Phase 1 float `grossTotalPounds` is gone.
 */
@Injectable()
@DefineTool({
  name: 'compare_payroll_runs',
  description:
    'Compares the totals of two payroll runs of this workspace (by default the two most recent runs; or the runs of the periods starting on the given dates): shift records, staff count, hours, gross total (integer pence plus a formatted amount) and late approvals, and the differences. Aggregate totals only, never individual pay, rates, bank details or payslips. Read-only.',
  summary: 'Totals of two payroll runs (records, staff, hours, gross in pence, late approvals) and their differences. Aggregates only.',
  kind: 'read',
  permission: PermissionFlag.PAYROLL_VIEW,
  input: INPUT,
  output: {
    keys: ['current', 'previous', 'differences', 'periodStart', 'periodEnd', 'payday', 'runStatus', 'shiftRecords', 'staff', 'hours', 'grossTotalPence', 'grossTotalFormatted', 'lateApprovals', 'available', 'reason'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
})
export class ComparePayrollRunsTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly payroll: PayrollAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    return { ...(await this.payroll.assistantRunTotals(aiTenantContext(actor), { periodStart: input.periodStart, comparePeriodStart: input.comparePeriodStart })) };
  }
}
