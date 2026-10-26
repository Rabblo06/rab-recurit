import { OfferStatus, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OfferAssistantService } from '../../../offer/services/offer-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, rangeInput } from '../ai-date-range';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeInput(92);

/** Phase 3: offer pipeline counts (never a decline / rejection reason or estimated pay). */
@Injectable()
@DefineTool({
  name: 'get_offer_pipeline',
  description:
    'The offer pipeline for offers on assignments starting in a date range (organisation local days, at most 92): counts per offer status, offers waiting for a staff reply, accepted offers awaiting manager confirmation, pending offers expiring within 24 hours, pending offers older than 24 hours and the median response time in minutes. Counts only, never reasons or pay. Read-only.',
  summary: 'Offer pipeline for a date range (up to 92 days): status counts, expiring and stale pending offers, median response minutes.',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: {
    keys: [
      'range', 'from', 'to', 'total', 'byStatus', ...Object.values(OfferStatus), 'awaitingStaffResponse', 'awaitingManagerConfirmation', 'expiringWithin24h', 'pendingOver24h',
      'medianResponseMinutes', 'definition',
    ],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 92 },
})
export class GetOfferPipelineTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly offers: OfferAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const p = await this.offers.assistantOfferPipeline(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone));
    return {
      range: { from: input.from, to: input.to },
      total: p.total,
      byStatus: p.byStatus,
      awaitingStaffResponse: p.awaitingStaffResponse,
      awaitingManagerConfirmation: p.awaitingManagerConfirmation,
      expiringWithin24h: p.expiringWithin24h,
      pendingOver24h: p.pendingOver24h,
      medianResponseMinutes: p.medianResponseMinutes,
      definition: 'Expiring = pending offers whose reply deadline is within the next 24 hours. Response time = from sending to the staff reply, over offers that have one.',
    };
  }
}
