import { StaffTimeOffStatus, StaffTimeOffStatusType } from '../types';
import { TransitionTable } from './assert-transition';

/**
 * `core.staff_time_off.status` (owner decisions 42, 48). Who may take each edge is decided in StaffTimeOffService (and,
 * as far as a core policy can express it, by the table's RLS policies):
 *   requested → approved   a non-venue manager of the workspace (never on their own row)
 *   requested → declined   the same, with a reason
 *   requested → cancelled  the staff member themselves (withdrawing their own request)
 *   approved  → cancelled  a manager only (FLAGGED: a staff member cannot withdraw approved time off; they ask a manager)
 * declined and cancelled are final: a new range is a new request. Nothing returns to `requested`.
 */
export const STAFF_TIME_OFF_TRANSITIONS: TransitionTable<StaffTimeOffStatusType> =
  {
    [StaffTimeOffStatus.REQUESTED]: [
      StaffTimeOffStatus.APPROVED,
      StaffTimeOffStatus.DECLINED,
      StaffTimeOffStatus.CANCELLED,
    ],
    [StaffTimeOffStatus.APPROVED]: [StaffTimeOffStatus.CANCELLED],
    [StaffTimeOffStatus.DECLINED]: [],
    [StaffTimeOffStatus.CANCELLED]: [],
  };
