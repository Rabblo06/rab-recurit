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
  /**
   * AI Phase 1 "real models only" (docs/ai/PHASE1_TWENTY_PLAN.md §7, D6): choose the organisation's AI model per tier in
   * Settings → AI. Default holder: the `ceo` system role only (AiSettingsPermission1786720240000). Never sufficient on its
   * own: the service and the RLS writer predicate `core.ai_settings_writer()` (AiModelPreference1786720250000) also
   * require the bound user to be the organisation's CEO, so a custom role carrying the flag grants nothing to anyone else.
   * A pin can only name a model that is security-approved in code and available on the platform.
   */
  AI_SETTINGS: 'ai.settings',
  /**
   * AI Phase 6a (docs/ai/PHASE6_TWENTY_PLAN.md §3 M6.1, P6-D12): define AI agents and their triggers in Settings → AI →
   * Agents (STORAGE ONLY until the owner approves EX-3 — no trigger can be enabled and nothing runs). Default holder: the
   * `ceo` system role only (AiAgentsPermission1786720600000). Never sufficient on its own: the service and the RLS writer
   * predicate `core.ai_agent_writer()` (AiAgentSchema1786720620000) also require the bound user to be the organisation's CEO.
   */
  AI_AGENTS_MANAGE: 'ai.agents.manage',
} as const;

export type PermissionFlagType = (typeof PermissionFlag)[keyof typeof PermissionFlag];
