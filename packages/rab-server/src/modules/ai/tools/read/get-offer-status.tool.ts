import { OfferStatus, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OfferService } from '../../../offer/services/offer.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, rangeInput } from '../ai-date-range';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeInput(92);

/** Phase 1 tool, name unchanged; kept for one release next to `get_offer_pipeline` (P3-D7). */
@Injectable()
@DefineTool({
  name: 'get_offer_status',
  description:
    'How many shift offers are in each offer status, for offers on assignments starting in a date range (organisation local days, at most 92). Statuses: pending (waiting for the staff member), staff_accepted (accepted, awaiting manager confirmation), manager_confirmed, manager_rejected, declined, expired, withdrawn. Counts only. Read-only.',
  summary: 'Offer counts per offer status for assignments starting in a date range (up to 92 days).',
  kind: 'read',
  permission: PermissionFlag.SCHEDULE_VIEW,
  input: INPUT,
  output: { keys: ['range', 'from', 'to', 'total', 'awaitingStaffResponse', 'awaitingManagerConfirmation', 'byStatus', ...Object.values(OfferStatus)], maxRows: AI_TOOL_DEFAULT_MAX_ROWS },
  limits: { maxDays: 92 },
})
export class GetOfferStatusTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly offers: OfferService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const counts = await this.offers.assistantOfferStatusCounts(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone));
    return {
      range: { from: input.from, to: input.to },
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      awaitingStaffResponse: counts[OfferStatus.PENDING],
      awaitingManagerConfirmation: counts[OfferStatus.STAFF_ACCEPTED],
      byStatus: counts,
    };
  }
}
