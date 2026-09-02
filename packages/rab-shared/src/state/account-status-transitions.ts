import { EmploymentStatus, EmploymentStatusType, UserStatus, UserStatusType } from '../types';
import { TransitionTable } from './assert-transition';

/**
 * `StaffProfile.employmentStatus` — reachable actions today are only
 * `deactivate` (→ INACTIVE) and `reactivate` (→ ACTIVE), driven by
 * `StaffService`. Deliberately no PENDING_COMPLIANCE → ACTIVE edge:
 * `reactivate` undoes a deactivation, it must never be usable to wave a
 * never-vetted starter straight to ACTIVE — that requires its own explicit
 * "compliance approved" action if/when that workflow is built, not a
 * side effect of the unrelated deactivate/reactivate pair.
 */
export const EMPLOYMENT_STATUS_TRANSITIONS: TransitionTable<EmploymentStatusType> = {
  [EmploymentStatus.PENDING_COMPLIANCE]: [EmploymentStatus.INACTIVE],
  [EmploymentStatus.ACTIVE]: [EmploymentStatus.INACTIVE, EmploymentStatus.SUSPENDED],
  [EmploymentStatus.INACTIVE]: [EmploymentStatus.ACTIVE],
  [EmploymentStatus.SUSPENDED]: [EmploymentStatus.ACTIVE, EmploymentStatus.INACTIVE],
};

/**
 * `User.status` — reachable actions today are only `ManagerService.setActive`
 * toggling ACTIVE/SUSPENDED. DEACTIVATED is terminal: nothing currently sets
 * it, but it's modeled as a dead end (no path back to ACTIVE) so a future
 * "deactivate account" action can't be silently resurrected by `setActive`.
 */
export const USER_STATUS_TRANSITIONS: TransitionTable<UserStatusType> = {
  [UserStatus.INVITED]: [UserStatus.ACTIVE, UserStatus.DEACTIVATED, UserStatus.INVITE_EXPIRED],
  [UserStatus.ACTIVE]: [UserStatus.SUSPENDED, UserStatus.DEACTIVATED],
  [UserStatus.SUSPENDED]: [UserStatus.ACTIVE, UserStatus.DEACTIVATED],
  [UserStatus.DEACTIVATED]: [],
  [UserStatus.INVITE_EXPIRED]: [],
};
