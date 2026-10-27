import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ASSISTANT_SHIFT_STATUSES, SchedulingAssistantService } from '../../../scheduling/services/scheduling-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, uuidArg } from '../ai-date-range';
import { limitArg, rangeWith } from '../ai-read-tool.helpers';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeWith(31, {
  venueId: uuidArg.optional().describe('Only shifts at this venue (an id from another tool result).'),
  jobRoleId: uuidArg.optional().describe('Only shifts for this job role.'),
  statuses: z.array(z.enum(ASSISTANT_SHIFT_STATUSES)).min(1).max(6).optional().describe('Only shifts in these statuses (default: all except drafts and requests).'),
  limit: limitArg(AI_TOOL_DEFAULT_MAX_ROWS),
});

/** Phase 3: the caller's shifts in a range (the ONE shift read scope), operational fields only. */
@Injectable()
@DefineTool({
  name: 'find_shifts',
  description:
    'Shifts starting in a date range (organisation local days, at most 31), optionally only at one venue, for one job role or in given statuses. Returns the total and, per shift: id, venue name (only if the user may view venues), job role, start/end time, status, required, confirmed and vacancies. Drafts and shift requests are never included. Read-only.',
  summary: 'Find shifts in a date range (up to 31 days) by venue, job role or status, with seats per shift.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'total', 'listed', 'truncated', 'shifts', 'shiftId', 'venue', 'jobRole', 'startsAt', 'endsAt', 'status', 'required', 'confirmed', 'vacancies'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 31 },
})
export class FindShiftsTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const r = await this.scheduling.assistantFindShifts(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), {
      venueId: input.venueId,
      jobRoleId: input.jobRoleId,
      statuses: input.statuses,
      limit: input.limit ?? 10,
    });
    return {
      range: { from: input.from, to: input.to },
      total: r.total,
      listed: r.shifts.length,
      truncated: r.truncated,
      shifts: r.shifts.map((s) => ({
        shiftId: s.shiftId,
        venue: s.venueName,
        jobRole: s.jobRoleName,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: s.status,
        required: s.requiredCount,
        confirmed: s.filledCount,
        vacancies: s.vacancies,
      })),
    };
  }
}
