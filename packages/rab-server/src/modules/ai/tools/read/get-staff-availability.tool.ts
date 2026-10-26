import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { StaffAssistantService } from '../../../staff/services/staff-assistant.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localDays, uuidArg } from '../ai-date-range';
import { rangeWith } from '../ai-read-tool.helpers';
import { DefineTool } from '../define-tool.decorator';

const MAX_DAYS = 14;
const INPUT = rangeWith(MAX_DAYS, { jobRoleId: uuidArg.optional().describe('Only staff whose job role is this one.') });

/**
 * Phase 3 (PARTIAL, advisory — P3-D9): weekday-declared availability COUNTS per day. Never a name, an id or a ranking;
 * it never says who should get work (rule 3.6). The `definition` states what the numbers can and cannot mean.
 */
@Injectable()
@DefineTool({
  name: 'get_staff_availability',
  description:
    'For each day of a date range (organisation local days, at most 14): how many of your active staff declared that weekday as available, how many of those have no confirmed shift that day, how many are booked, and how many never declared availability. Counts only, never names; advisory: weekday declarations only, no leave or date-specific unavailability exists. Read-only.',
  summary: 'Per day (up to 14 days): counts of active staff declared available, available and not booked, booked, not declared. Advisory counts only.',
  kind: 'read',
  permission: PermissionFlag.STAFF_VIEW,
  input: INPUT,
  output: {
    keys: ['range', 'from', 'to', 'activeStaff', 'truncated', 'byDay', 'date', 'weekday', 'declaredAvailable', 'availableNotBooked', 'booked', 'notDeclared', 'definition'],
    maxRows: MAX_DAYS,
  },
  limits: { maxDays: MAX_DAYS },
})
export class GetStaffAvailabilityTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly staff: StaffAssistantService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const r = await this.staff.assistantAvailabilityCounts(aiTenantContext(actor), localDays(input.from, input.to, actor.timezone), { jobRoleId: input.jobRoleId });
    return {
      range: { from: input.from, to: input.to },
      activeStaff: r.activeStaff,
      truncated: r.truncated,
      byDay: r.byDay,
      definition:
        'Advisory only. Declared available = the staff member listed that weekday in their availability; booked = has a confirmed shift overlapping that day. There is no leave, holiday or date-specific unavailability data, so a declared-available person may still be unavailable. Not a recommendation of who should work.',
    };
  }
}
