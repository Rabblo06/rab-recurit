import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ASSISTANT_SHIFT_STATUSES, SchedulingAssistantService } from '../../../scheduling/services/scheduling-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, rangeInput } from '../ai-date-range';
import { AI_TOOL_MAX_ROWS_EXCEPTIONS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeInput(62);

/** Phase 3: counts by status and by organisation-local day (the documented 62-row exception: one row per day). */
@Injectable()
@DefineTool({
  name: 'count_shifts',
  description:
    'Counts of shifts starting in a date range (organisation local days, at most 62): the total, the number in each status, and per day the number of staffable shifts with seats required and filled. Counts only. Read-only.',
  summary: 'Shift counts in a date range (up to 62 days) by status and by day, with seats required and filled per day.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'total', 'truncated', 'byStatus', ...ASSISTANT_SHIFT_STATUSES, 'byDay', 'date', 'shifts', 'seatsRequired', 'seatsFilled', 'definition'],
    maxRows: AI_TOOL_MAX_ROWS_EXCEPTIONS.count_shifts!,
  },
  limits: { maxDays: 62 },
})
export class CountShiftsTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const r = await this.scheduling.assistantShiftCounts(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), actor.timezone);
    return {
      range: { from: input.from, to: input.to },
      total: r.total,
      truncated: r.truncated,
      byStatus: r.byStatus,
      byDay: r.byDay,
      definition: 'Drafts and shift requests are not counted. byDay lists only days with staffable shifts (cancelled shifts are counted by status only); seats filled = confirmed or completed assignments, capped at the required count.',
    };
  }
}
