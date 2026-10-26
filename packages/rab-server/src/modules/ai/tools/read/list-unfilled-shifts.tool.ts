import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { SchedulingService } from '../../../scheduling/services/scheduling.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange } from '../ai-date-range';
import { limitArg, rangeWith } from '../ai-read-tool.helpers';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeWith(31, { limit: limitArg(AI_TOOL_DEFAULT_MAX_ROWS) });

/** Phase 1 tool, name unchanged (audit continuity). Backed by the unchanged `SchedulingService.assistantStaffing`. */
@Injectable()
@DefineTool({
  name: 'list_unfilled_shifts',
  description:
    'Shifts starting in a date range (organisation local days, at most 31) that still need staff. Returns, per shift: id, venue name (only if the user may view venues), job role, start/end time, required, confirmed and remaining vacancies. Read-only.',
  summary: 'Shifts in a date range (up to 31 days) that still need staff, with vacancies per shift.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'unfilledShiftCount', 'listed', 'truncated', 'shifts', 'shiftId', 'venue', 'jobRole', 'startsAt', 'endsAt', 'required', 'confirmed', 'vacancies', 'offersAwaitingReply', 'acceptedAwaitingConfirmation'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 31 },
})
export class ListUnfilledShiftsTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const snapshot = await this.scheduling.assistantStaffing(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), { unfilledLimit: input.limit ?? 10 });
    return {
      range: { from: input.from, to: input.to },
      unfilledShiftCount: snapshot.unfilledTotal,
      listed: snapshot.unfilled.length,
      truncated: snapshot.truncated,
      shifts: snapshot.unfilled.map((s) => ({
        shiftId: s.shiftId,
        venue: s.venueName,
        jobRole: s.jobRoleName,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        required: s.requiredCount,
        confirmed: s.confirmedCount,
        vacancies: s.vacancies,
        offersAwaitingReply: s.pendingOffers,
        acceptedAwaitingConfirmation: s.awaitingConfirmation,
      })),
    };
  }
}
