export const PermissionFlag = {
  STAFF_VIEW: 'staff.view',
  STAFF_CREATE: 'staff.create',
  STAFF_EDIT: 'staff.edit',
  STAFF_DEACTIVATE: 'staff.deactivate',
  STAFF_VIEW_SENSITIVE: 'staff.view_sensitive',
  MANAGER_MANAGE: 'manager.manage',
  USER_MANAGE_PERMISSIONS: 'user.manage_permissions',
  USER_RESET_PASSWORD: 'user.reset_password',
  VENUE_VIEW: 'venue.view',
  VENUE_CREATE: 'venue.create',
  /** Normal Manager flow: create a Venue Manager inside the caller's OWN workspace only (narrow; not MANAGER_MANAGE). */
  VENUE_MANAGER_CREATE: 'venue_manager.create',
  VENUE_EDIT: 'venue.edit',
  SCHEDULE_VIEW: 'schedule.view',
  SCHEDULE_CREATE: 'schedule.create',
  SCHEDULE_PUBLISH: 'schedule.publish',
  SCHEDULE_BULK: 'schedule.bulk',
  SCHEDULE_OVERRIDE_CONFLICT: 'schedule.override_conflict',
  OFFER_SEND: 'offer.send',
  OFFER_WITHDRAW: 'offer.withdraw',
  OFFER_RESPOND: 'offer.respond',
  OFFER_CONFIRM: 'offer.confirm',
  /** Self-service clock in/out — distinct from the manager-facing flags below. */
  ATTENDANCE_CLOCK: 'attendance.clock',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_EDIT: 'attendance.edit',
  ATTENDANCE_APPROVE: 'attendance.approve',
  ATTENDANCE_CLOCK_OVERRIDE: 'attendance.clock_override',
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_CALCULATE: 'payroll.calculate',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_MARK_PAID: 'payroll.mark_paid',
  PAYSLIP_VIEW_OWN: 'payslip.view_own',
  PAYSLIP_VIEW_ALL: 'payslip.view_all',
  REVIEW_CREATE: 'review.create',
  STAFFING_REQUEST_CREATE: 'staffing_request.create',
  STAFFING_REQUEST_APPROVE: 'staffing_request.approve',
  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',
  AUDIT_VIEW: 'audit.view',
  SETTINGS_EDIT: 'settings.edit',
  DASHBOARD_VIEW: 'dashboard.view',
  SETTINGS_VIEW: 'settings.view',
  ROLE_VIEW: 'role.view',
  ROLE_MANAGE: 'role.manage',
  /**
   * AI Phase 1 (docs/ai/PHASE1_PLAN.md): use the read-only Crewflow AI assistant (web console only). Default holders: the
   * system roles `ceo` and `manager`, narrowed in the service and in RLS to the CEO and the organisation's CURRENT Initial
   * Manager (AiPhase1PermissionDefault1786720210000). Never sufficient on its own: the platform kill switch, the per-org
   * switch and every tool's own permission still apply.
   */
  AI_USE: 'ai.use',
} as const;

export type PermissionFlagType = (typeof PermissionFlag)[keyof typeof PermissionFlag];
