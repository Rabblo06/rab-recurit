import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { SchedulingAssistantService } from '../../../scheduling/services/scheduling-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, uuidArg } from '../ai-date-range';
import { limitArg, rangeWith } from '../ai-read-tool.helpers';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeWith(31, {
  venueId: uuidArg.optional().describe('Only gaps at this venue.'),
  jobRoleId: uuidArg.optional().describe('Only gaps for this job role.'),
  limit: limitArg(AI_TOOL_DEFAULT_MAX_ROWS),
});

/** Phase 3 (PARTIAL, §5.3): no rota template or demand model exists — a gap is a vacant seat on a shift that exists. */
@Injectable()
@DefineTool({
  name: 'get_rota_coverage_gaps',
  description:
    'Vacant seats on existing shifts starting in a date range (organisation local days, at most 31), grouped by day, venue (name only if you may view venues) and job role, largest first within a day. There is no rota template or demand forecast: days without shifts are not gaps. Counts only. Read-only.',
  summary: 'Vacant seats on existing shifts in a date range (up to 31 days), grouped by day, venue and job role.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'gapGroups', 'listed', 'truncated', 'gaps', 'date', 'venue', 'jobRole', 'shifts', 'seatsVacant', 'definition'],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 31 },
})
export class GetRotaCoverageGapsTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const r = await this.scheduling.assistantCoverageGaps(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), actor.timezone, {
      venueId: input.venueId,
      jobRoleId: input.jobRoleId,
      limit: input.limit ?? 10,
    });
    return {
      range: { from: input.from, to: input.to },
      gapGroups: r.gapGroups,
      listed: r.gaps.length,
      truncated: r.truncated,
      gaps: r.gaps.map((g) => ({ date: g.date, venue: g.venueName, jobRole: g.jobRoleName, shifts: g.shifts, seatsVacant: g.seatsVacant })),
      definition: 'A gap is a vacant seat on an existing open, offered, partially/fully filled, confirmed or in-progress shift. No rota template or demand forecast exists, so days without shifts are not reported.',
    };
  }
}
