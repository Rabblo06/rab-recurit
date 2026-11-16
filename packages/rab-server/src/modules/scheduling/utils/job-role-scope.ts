import { ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JobRole } from '../entities/job-role.entity';

/**
 * The job-role scope rule, in one place (SF-4): may this caller reference `jobRole` from a shift, a staff profile or a
 * venue pay rate? A Venue Manager (`scope.kind === 'venue'`) may reference any job role RLS shows them (job roles are org
 * reference data with no venue link); everyone else only a role they created themselves. Callers answer `false` with a
 * 404 ("Job role not found."), never a 403, so an out-of-scope role looks the same as a missing one. Archive rules are
 * separate and stay with each caller.
 */
export function isJobRoleInScope(scope: ResourceScope, ctx: Pick<AuthContext, 'userId'>, jobRole: Pick<JobRole, 'createdBy'>): boolean {
  if (scope.kind === 'venue') return true;
  return scope.kind === 'owner' && jobRole.createdBy === ctx.userId;
}
