import { NotificationType } from '@rab/shared';
import { DataSource } from 'typeorm';

import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { assignmentTimeSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { activePeriods, payrollDate, periodLabel } from '@rab/server/modules/payroll/services/payroll-allocation';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { claimWorkerEvent, completeWorkerEvent } from '../../core/database/worker-event';

/** Periods that ended within this many days are checked (older ones were already reported or are out of scope). */
const LOOKBACK_DAYS = 14;

interface Candidate { organisation_id: string; workspace_id: string; period_id: string; period_start: string; period_end: string; pending: number; unfinalised: number; owner: string }

export interface PayrollPeriodAttentionResult { notified: number; candidates: number }

/**
 * When an agency calendar period has ENDED and this workspace still has work in it that cannot be paid yet (payroll
 * records pending approval, or clocked-out attendance whose timesheet is not finalised), notify the workspace owner
 * ONCE (worker event `payroll-period-attention:<workspace>:<period>`). Read-only towards payroll: it never prepares,
 * finalises or pays anything.
 */
export async function runPayrollPeriodAttentionCycle(
  discoveryDataSource: DataSource,
  tenantContext: TenantContextService,
  notifications: NotificationService,
  options: { organisationId?: string; today?: string } = {},
): Promise<PayrollPeriodAttentionResult> {
  const today = options.today ?? payrollDate(new Date());
  const candidates = await discoverInWorkspaces(discoveryDataSource, tenantContext, async (m) => {
    const [ws] = await m.query(`SELECT core.current_org() AS org, core.current_workspace() AS ws`);
    if (!ws?.org || !ws?.ws) return [];
    const ended = (await activePeriods(m, ws.org)).filter((p) => p.end < today && p.end >= addDays(today, -LOOKBACK_DAYS));
    const out: Candidate[] = [];
    for (const p of ended) {
      const [counts] = await m.query(
        `SELECT
           (SELECT count(*)::int FROM payroll_record pr JOIN attendance a ON a.id = pr.attendance_id JOIN shift_assignment sa ON sa.id = a.shift_assignment_id JOIN shift s ON s.id = pr.shift_id
             WHERE pr.status = 'pending_approval' AND (${assignmentTimeSql().start} AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date) AS pending,
           (SELECT count(*)::int FROM attendance a JOIN shift_assignment sa ON sa.id = a.shift_assignment_id JOIN shift s ON s.id = a.shift_id
             WHERE a.clock_out_at IS NOT NULL AND a.status <> 'approved'
               AND (${assignmentTimeSql().start} AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date) AS unfinalised,
           (SELECT owner_user_id FROM core.manager_workspace WHERE id = $3) AS owner`,
        [p.start, p.end, ws.ws]);
      if ((counts.pending > 0 || counts.unfinalised > 0) && counts.owner) {
        out.push({ organisation_id: ws.org, workspace_id: ws.ws, period_id: p.id, period_start: p.start, period_end: p.end, pending: counts.pending, unfinalised: counts.unfinalised, owner: counts.owner });
      }
    }
    return out;
  }, options.organisationId);

  let notified = 0;
  for (const c of candidates) {
    const done = await tenantContext.runInTenantContext(
      { organisationId: c.organisation_id, workspaceId: c.workspace_id, userId: '', role: '', actorType: 'worker' },
      async (m) => {
        const eventId = await claimWorkerEvent(m, { organisationId: c.organisation_id, workspaceId: c.workspace_id,
          eventKey: `payroll-period-attention:${c.workspace_id}:${c.period_id}`, eventType: 'payroll-period-attention', entityType: 'payroll_calendar_period', entityId: c.period_id });
        if (!eventId) return false;
        await notifications.notify(m, {
          organisationId: c.organisation_id, userId: c.owner, type: NotificationType.PAYROLL_PERIOD_ATTENTION,
          title: 'Payroll period ended with unfinished records',
          message: `${periodLabel({ id: c.period_id, start: c.period_start, end: c.period_end, payday: c.period_end, note: null, needsConfirmation: false })}: ${c.pending} awaiting approval, ${c.unfinalised} awaiting a finalised timesheet.`,
          relatedEntityType: 'payroll_calendar_period', relatedEntityId: c.period_id,
        });
        await completeWorkerEvent(m, eventId);
        return true;
      });
    if (done) notified += 1;
  }
  return { notified, candidates: candidates.length };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
