import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { SchedulingService } from '../../../scheduling/services/scheduling.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, rangeInput } from '../ai-date-range';
import { pct } from '../ai-read-tool.helpers';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeInput(62);

/** Phase 1 tool, name unchanged. Backed by the unchanged `SchedulingService.assistantStaffing`. */
@Injectable()
@DefineTool({
  name: 'get_fill_rate',
  description:
    'Fill rate of shifts starting in a date range (organisation local days, at most 62): counts of shifts and seats required/filled/vacant and the resulting percentages. Counts only. Read-only.',
  summary: 'Seat and shift fill-rate percentages for shifts in a date range (up to 62 days). Counts only.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'shifts', 'fullyStaffedShifts', 'shiftsWithVacancies', 'seatsRequired', 'seatsFilled', 'seatsVacant', 'seatFillRatePercent', 'shiftFillRatePercent', 'truncated', 'definition'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 62 },
})
export class GetFillRateTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const s = await this.scheduling.assistantStaffing(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), { unfilledLimit: 0 });
    return {
      range: { from: input.from, to: input.to },
      shifts: s.shiftCount,
      fullyStaffedShifts: s.fullyStaffedShiftCount,
      shiftsWithVacancies: s.shiftsWithVacancies,
      seatsRequired: s.seatsRequired,
      seatsFilled: s.seatsFilled,
      seatsVacant: s.seatsVacant,
      seatFillRatePercent: pct(s.seatsFilled, s.seatsRequired),
      shiftFillRatePercent: pct(s.fullyStaffedShiftCount, s.shiftCount),
      truncated: s.truncated,
      definition:
        'Seats filled = confirmed or completed assignments (unreviewed no-shows still hold their seat), capped at the required count; open, offered, partially/fully filled, confirmed, in-progress and completed shifts only.',
    };
  }
}
