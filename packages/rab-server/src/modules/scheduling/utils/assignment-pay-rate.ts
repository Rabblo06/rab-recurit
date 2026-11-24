import { EntityManager } from 'typeorm';
import { JobRole } from '../entities/job-role.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';
import { Shift } from '../entities/shift.entity';
import { ShiftAssignment } from '../entities/shift-assignment.entity';
import { effectiveAssignmentTime } from './assignment-time';

export async function resolveRolePayRate(manager: EntityManager, params: { venueId: string; jobRoleId: string; startsAt: string; payRatePence?: number }): Promise<number> {
  if (params.payRatePence !== undefined) return params.payRatePence;
  const rate = await manager.createQueryBuilder(VenueRoleRate, 'r')
    .where('r.venue_id = :venueId', { venueId: params.venueId })
    .andWhere('r.job_role_id = :jobRoleId', { jobRoleId: params.jobRoleId })
    .andWhere('r.effective_from <= :start', { start: params.startsAt })
    .andWhere('(r.effective_to IS NULL OR r.effective_to >= :start)', { start: params.startsAt })
    .orderBy('r.effective_from', 'DESC').getOne();
  if (rate) return rate.payRatePence;
  const role = await manager.findOne(JobRole, { where: { id: params.jobRoleId } });
  return role?.defaultRatePence ?? 0;
}

/** Used at send for the estimate and again at confirmation for the authoritative snapshot. */
export function resolveAssignmentPayRate(manager: EntityManager, shift: Shift, assignment: Pick<ShiftAssignment, 'jobRoleId' | 'payRateOverridePence' | 'period'>): Promise<number> {
  if (!assignment.jobRoleId) return Promise.resolve(shift.payRatePence);
  return resolveRolePayRate(manager, { venueId: shift.venueId, jobRoleId: assignment.jobRoleId,
    startsAt: effectiveAssignmentTime(assignment, shift).startsAt.toISOString(), payRatePence: assignment.payRateOverridePence ?? undefined });
}
