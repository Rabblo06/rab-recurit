import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ASSISTANT_MAX_VENUES, SchedulingAssistantService } from '../../../scheduling/services/scheduling-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, uuidArg } from '../ai-date-range';
import { rangeWith } from '../ai-read-tool.helpers';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeWith(31, { venueId: uuidArg.optional().describe('Only this venue.') });

/** Phase 3: venue.view gates the tool (rule 2.4: ONE flag); shift figures are null without schedule.view (P3 C3). */
@Injectable()
@DefineTool({
  name: 'get_venue_summary',
  description:
    'The venues you may view (at most 25, or one venue) with, for shifts starting in a date range (organisation local days, at most 31): shifts, seats required/filled/vacant, shifts still needing staff and offers awaiting a reply. Shift figures are null if you may not view schedules. No addresses, contacts or notes. Read-only.',
  summary: 'Your venues (up to 25) with shifts, seats and unfilled shifts in a date range (up to 31 days).',
  kind: 'read',
  permission: PermissionFlag.VENUE_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'listed', 'truncated', 'shiftsIncluded', 'venues', 'venueId', 'venue', 'venueStatus', 'shifts', 'seatsRequired', 'seatsFilled', 'seatsVacant', 'unfilledShifts', 'offersAwaitingReply'],
    maxRows: ASSISTANT_MAX_VENUES,
  },
  limits: { maxDays: 31 },
})
export class GetVenueSummaryTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly scheduling: SchedulingAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const r = await this.scheduling.assistantVenueSummary(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone), { venueId: input.venueId });
    return {
      range: { from: input.from, to: input.to },
      listed: r.venues.length,
      truncated: r.truncated,
      shiftsIncluded: r.shiftsIncluded,
      venues: r.venues.map((v) => ({
        venueId: v.venueId,
        venue: v.venueName,
        venueStatus: v.venueStatus,
        shifts: v.shifts,
        seatsRequired: v.seatsRequired,
        seatsFilled: v.seatsFilled,
        seatsVacant: v.seatsVacant,
        unfilledShifts: v.unfilledShifts,
        offersAwaitingReply: v.offersAwaitingReply,
      })),
    };
  }
}
