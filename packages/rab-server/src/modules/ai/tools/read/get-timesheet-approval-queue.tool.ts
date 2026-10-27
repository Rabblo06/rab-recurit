import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PayrollAssistantService } from '../../../payroll/services/payroll-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange } from '../ai-date-range';
import { optionalRange } from '../ai-read-tool.helpers';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = optionalRange(92);

/** Phase 3 (P3 C9: payroll.view, read-only counts as on `GET /payroll`; attendance stages only with attendance.view). */
@Injectable()
@DefineTool({
  name: 'get_timesheet_approval_queue',
  description:
    'Counts of the timesheets of this workspace (payroll records) awaiting payroll approval, rejected, and awaiting but of your own hours, with the oldest awaiting shift date; optionally for shifts starting in a date range (at most 92 days). With attendance access: records under review or disputed and shift reports not finalised. Counts only. Read-only.',
  summary: 'Timesheets awaiting payroll approval, rejected and own-hours counts, plus earlier review stages. Counts only, never amounts.',
  kind: 'read',
  permission: PermissionFlag.PAYROLL_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'awaitingApproval', 'rejected', 'ownHoursAwaiting', 'oldestAwaitingShiftDate', 'attendanceUnderReview', 'attendanceDisputed', 'reportsNotFinalised', 'definition'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 92 },
})
export class GetTimesheetApprovalQueueTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly payroll: PayrollAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const range = input.from && input.to ? { from: input.from, to: input.to } : null;
    const q = await this.payroll.assistantApprovalQueue(aiTenantContext(actor), range ? localRange(range.from, range.to, actor.timezone) : null, actor.timezone);
    return {
      range,
      ...q,
      definition:
        'A timesheet awaits approval once its shift report is finalised. Attendance under review / disputed and shift reports not finalised are earlier stages (null when you may not view attendance). Own-hours records must be approved by someone else.',
    };
  }
}
