import { AttendanceStatus, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AttendanceService } from '../../../attendance/services/attendance.service';
import type { AiDefinedReadTool } from '../../contracts/tools';
import { AiActor, aiTenantContext } from '../../services/ai-access.service';
import { localRange, rangeInput } from '../ai-date-range';
import { AI_TOOL_DEFAULT_MAX_ROWS } from '../ai-tool.constants';
import { DefineTool } from '../define-tool.decorator';

const INPUT = rangeInput(92);

/** Phase 1 tool, name unchanged ("attendance totals"); Phase 3 adds booked assignments starting / attended. */
@Injectable()
@DefineTool({
  name: 'get_attendance_summary',
  description:
    'Aggregated attendance counts for a date range (organisation local days, at most 92): clock-ins by attendance status, late clock-ins, no-shows (confirmed vs provisional), and booked assignments starting in the range with how many were attended. Organisation totals only, never per person; not an employment judgement. Read-only.',
  summary: 'Attendance totals for a date range (up to 92 days): clock-ins by status, late clock-ins, no-shows, attended bookings. Never per person.',
  kind: 'read',
  permission: PermissionFlag.ATTENDANCE_VIEW,
  input: INPUT,
  output: {
    keys: [
      'range', 'from', 'to', 'records', 'byStatus', ...Object.values(AttendanceStatus), 'lateClockIns', 'lateGraceMinutes', 'noShows', 'confirmed', 'provisional',
      'assignmentsStarting', 'attendedAssignments', 'definition',
    ],
    maxRows: AI_TOOL_DEFAULT_MAX_ROWS,
  },
  limits: { maxDays: 92 },
})
export class GetAttendanceSummaryTool implements AiDefinedReadTool<typeof INPUT> {
  constructor(private readonly attendance: AttendanceService) {}

  async run(actor: AiActor, input: z.infer<typeof INPUT>): Promise<Record<string, unknown>> {
    const s = await this.attendance.assistantAttendanceSummary(aiTenantContext(actor), localRange(input.from, input.to, actor.timezone));
    return {
      range: { from: input.from, to: input.to },
      records: s.records,
      byStatus: s.byStatus,
      lateClockIns: s.lateClockIns,
      lateGraceMinutes: s.lateGraceMinutes,
      noShows: s.noShows,
      assignmentsStarting: s.assignmentsStarting,
      attendedAssignments: s.attendedAssignments,
      definition: `A late clock-in is one recorded more than ${s.lateGraceMinutes} minutes after the assignment start. A provisional no-show has not been reviewed by a manager yet. Booked assignments are confirmed, completed or no-show assignments starting in the range; attended ones have a clock-in.`,
    };
  }
}
