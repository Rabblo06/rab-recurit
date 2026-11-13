import type { SecurityAuditEvent } from '../audit-sink/security-audit-sink';

/**
 * Phase X Part 2, X1.1 (owner decision 2026-11-12): WHICH audit actions get an off-host copy. Pure (no Nest, no I/O).
 *
 * The owner's event list, one category each:
 *   login (success and fail) · mfa · password (reset and change) · access_grant (grants and revokes) · role_permission
 *   (role and permission changes) · platform_admin (platform-admin actions) · payroll_approval · account_deletion ·
 *   suspension · security_configuration.
 *
 * EVERY action string that can reach `core.audit_log` is classified exactly once: shipped (here, with its category and
 * severity) or deliberately not shipped (NOT_SHIPPED_AUDIT_ACTIONS: business events such as offers, attendance, AI
 * conversation telemetry, e-mail delivery). `security-audit-event-catalogue.spec.ts` fails when a new `AuditAction` (or
 * a new database-written action) is added without a decision, so the list cannot silently fall behind the code.
 *
 * An action that is not in this catalogue at all (a raw string nobody classified) is not shipped; the spec is the guard.
 */
export const SECURITY_AUDIT_CATEGORIES = [
  'login',
  'mfa',
  'password',
  'access_grant',
  'role_permission',
  'platform_admin',
  'payroll_approval',
  'account_deletion',
  'suspension',
  'security_configuration',
] as const;
export type SecurityAuditCategory = (typeof SECURITY_AUDIT_CATEGORIES)[number];

export interface SecurityAuditClassification {
  readonly category: SecurityAuditCategory;
  readonly severity: SecurityAuditEvent['severity'];
}

const c = (category: SecurityAuditCategory, severity: SecurityAuditEvent['severity'] = 'info'): SecurityAuditClassification => Object.freeze({ category, severity });

/**
 * The pre-authentication login failure (wrong e-mail or password, ambiguous accounts, provider sign-in refused before an
 * account is known). It has NO audit_log row and NO organisation: it is recorded in `core.login_history` only, so it cannot
 * ride the organisation-scoped queue; the API writes it to the sink directly (best effort, detached, never awaited).
 */
export const LOGIN_FAILED_EVENT_TYPE = 'auth.login_failed';

export const SHIPPED_AUDIT_ACTIONS: Readonly<Record<string, SecurityAuditClassification>> = Object.freeze({
  // ── login (success and fail) ─────────────────────────────────────────────────────────────────────────────────────
  'auth.login': c('login'),
  [LOGIN_FAILED_EVENT_TYPE]: c('login', 'warning'),
  'auth.application_access_denied': c('login', 'warning'),
  'auth.password_sign_in_provider_disabled': c('login', 'warning'),
  'auth.login_handoff_created': c('login'),
  'auth.login_handoff_exchanged': c('login'),
  'auth.refresh_reuse_detected': c('login', 'critical'),
  'auth.logout_token_ownership_mismatch': c('login', 'warning'),
  'auth.session_revoked': c('login'),
  'auth.sso_reauth_failed': c('login', 'warning'),
  'auth.step_up_succeeded': c('login'),
  'auth.step_up_failed': c('login', 'warning'),
  'user.logout': c('login'),
  'user.activated': c('login'),
  // ── MFA ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  'user.mfa_challenge_issued': c('mfa'),
  'user.mfa_challenge_succeeded': c('mfa'),
  'user.mfa_challenge_failed': c('mfa', 'warning'),
  'user.mfa_enrolment_started': c('mfa'),
  'user.mfa_enabled': c('mfa'),
  'user.mfa_disabled': c('mfa', 'critical'),
  'user.mfa_reset_by_admin': c('mfa', 'critical'),
  'user.mfa_recovery_codes_regenerated': c('mfa', 'warning'),
  'user.mfa_recovery_code_used': c('mfa', 'warning'),
  'user.mfa_client_update_required': c('mfa', 'warning'),
  'user.mfa_reset_refused': c('mfa', 'warning'),
  // ── password reset / change ─────────────────────────────────────────────────────────────────────────────────────
  'password.changed': c('password'),
  'password.reset_requested': c('password'),
  'password.reset_completed': c('password', 'warning'),
  'password.admin_reset': c('password', 'warning'),
  'user.email_change_requested': c('password', 'warning'),
  'user.email_change_confirmed': c('password', 'warning'),
  // ── grants and revokes (accounts, membership, access) ───────────────────────────────────────────────────────────
  'platform_admin.granted': c('access_grant', 'critical'),
  'platform_admin.revoked': c('access_grant', 'critical'),
  'platform_admin.bootstrapped': c('access_grant', 'critical'),
  'user.created': c('access_grant'),
  'manager.ceo_created': c('access_grant', 'warning'),
  'manager.initial_manager_replaced': c('access_grant', 'warning'),
  'admin.venue_manager_created': c('access_grant', 'warning'),
  'manager.venue_assigned': c('access_grant'),
  'manager.venue_unassigned': c('access_grant'),
  'venue_team.staff_assigned': c('access_grant'),
  'venue_team.staff_unassigned': c('access_grant'),
  'user.invite_accepted': c('access_grant'),
  'member_invitation.sent': c('access_grant'),
  'member_invitation.resent': c('access_grant'),
  'member_invitation.revoked': c('access_grant'),
  'member_invitation.accepted': c('access_grant'),
  'member_invitation.superseded': c('access_grant'),
  'organisation_invitation.sent': c('access_grant', 'warning'),
  'organisation_invitation.resent': c('access_grant', 'warning'),
  'organisation_invitation.revoked': c('access_grant', 'warning'),
  'organisation_invitation.accepted': c('access_grant', 'warning'),
  // ── role and permission changes ─────────────────────────────────────────────────────────────────────────────────
  'role.created': c('role_permission', 'warning'),
  'role.updated': c('role_permission', 'warning'),
  'role.permissions_updated': c('role_permission', 'critical'),
  'role.deleted': c('role_permission', 'critical'),
  'member.role_changed': c('role_permission', 'critical'),
  'ai.agent_role_updated': c('role_permission', 'warning'),
  // ── platform-admin actions ──────────────────────────────────────────────────────────────────────────────────────
  'organisation.created': c('platform_admin', 'warning'),
  'admin.inspect_started': c('platform_admin', 'warning'),
  'admin.inspect_ended': c('platform_admin'),
  'admin.inspect_mutation_refused': c('platform_admin', 'warning'),
  'admin.sessions_revoked': c('platform_admin', 'warning'),
  'admin.queue_jobs_retried': c('platform_admin', 'warning'),
  'admin.queue_jobs_deleted': c('platform_admin', 'warning'),
  'admin.user_searched': c('platform_admin'),
  'admin.user_viewed': c('platform_admin'),
  'admin.organisation_searched': c('platform_admin'),
  'admin.test_email_sent': c('platform_admin'),
  'admin.email_replay_reason': c('platform_admin', 'warning'),
  /** Written by the SQL function `core.replay_failed_email` (outbox-retention-sql.ts); shipped by its caller. */
  'email.replay_requested': c('platform_admin', 'warning'),
  'ai.organisation_setting_changed': c('platform_admin', 'warning'),
  'shift.completed_by_repair': c('platform_admin', 'warning'),
  'ops.user_session_backfill_applied': c('platform_admin', 'warning'),
  'ops.hws_backfill_applied': c('platform_admin', 'warning'),
  // ── payroll approval ────────────────────────────────────────────────────────────────────────────────────────────
  'payroll_record.approved': c('payroll_approval', 'warning'),
  'payroll_record.rejected': c('payroll_approval', 'warning'),
  'payroll_run.prepared': c('payroll_approval'),
  'payroll_run.finalised': c('payroll_approval', 'warning'),
  'payroll_run.late_carried_forward': c('payroll_approval'),
  'payroll_run.exported': c('payroll_approval', 'warning'),
  'payslip.net_recorded': c('payroll_approval', 'warning'),
  'payslip.marked_paid': c('payroll_approval', 'warning'),
  // ── account deletion ────────────────────────────────────────────────────────────────────────────────────────────
  'user.deleted': c('account_deletion', 'critical'),
  /** Written directly by the Worker's account-invite cleanup (account-invite-cleanup.job.ts): an invited account deleted. */
  'user.invite_cleaned_up': c('account_deletion', 'warning'),
  // ── suspension ──────────────────────────────────────────────────────────────────────────────────────────────────
  'user.suspended': c('suspension', 'warning'),
  'user.reactivated': c('suspension', 'warning'),
  'member.suspended': c('suspension', 'warning'),
  'member.reinstated': c('suspension', 'warning'),
  'organisation.suspended': c('suspension', 'critical'),
  'organisation.reactivated': c('suspension', 'warning'),
  // ── security configuration ──────────────────────────────────────────────────────────────────────────────────────
  'organisation.auth_providers_updated': c('security_configuration', 'critical'),
  'organisation.password_sessions_revoked': c('security_configuration', 'warning'),
  'platform_config.smtp_updated': c('security_configuration', 'critical'),
  'platform_config.maintenance_mode_changed': c('security_configuration', 'warning'),
  'workspace.subdomain_changed': c('security_configuration', 'warning'),
  'manager_workspace.subdomain_changed': c('security_configuration', 'warning'),
  'venue.geofence_updated': c('security_configuration', 'warning'),
  'report.integrity_failed': c('security_configuration', 'critical'),
});

/**
 * Deliberately NOT shipped: business, delivery and AI telemetry events. They stay in `core.audit_log` only. Moving one of
 * them to SHIPPED_AUDIT_ACTIONS is a one-line, owner-visible change.
 */
export const NOT_SHIPPED_AUDIT_ACTIONS: readonly string[] = Object.freeze([
  'user.invited',
  'offer.sent',
  'offer.availability_conflict_acknowledged',
  'shift.request_availability_conflict_acknowledged',
  'offer.accepted',
  'offer.declined',
  'offer.confirmed',
  'offer.rejected',
  'offer.withdrawn',
  'offer.expired',
  'profile.updated',
  'workspace.updated',
  'attendance.clocked_in',
  'attendance.clocked_out',
  'attendance.post_shift_completed',
  'attendance.post_shift_expired',
  'attendance.auto_clocked_out_geofence',
  'attendance.corrected',
  'attendance.reviewed',
  'attendance.manager_recorded',
  'attendance.no_show_confirmed',
  'attendance.no_show_reopened',
  'attendance.checked_in',
  'attendance.clocked_in_on_behalf',
  'attendance.clocked_out_on_behalf',
  'attendance.report_finalised',
  'payroll_record.shift_statement_generated',
  'payroll_record.shift_statement_failed',
  'payroll_record.shift_statement_retry_requested',
  'payroll_calendar.imported',
  'payslip.uploaded',
  'shift_review.saved',
  'venue.archived',
  'venue.restored',
  'job_role.archived',
  'job_role.restored',
  'staff.archived',
  'staff.restored',
  'staff.note_added',
  'manager.archived',
  'manager.restored',
  'shift.archived',
  'shift.restored',
  'shift.created',
  'shift.published',
  'venue.photo_updated',
  'file.uploaded',
  'file.download_authorized',
  'file.access_denied',
  'file.deleted',
  'file.migration_completed',
  'report.stored',
  'staff.suspension_notice_sent',
  'manager_workspace.created',
  'manager_workspace.updated',
  'manager_workspace.onboarding_completed',
  'manager_workspace.provisioned',
  'manager_workspace.provisioning_failed',
  'user.invite_failed',
  'user.invite_queued',
  'user.invite_resent',
  'user.invite_pending_email_changed',
  'user.invite_cancelled',
  'user.invite_expired',
  'user.invite_cleanup_skipped',
  'email.sent',
  'email.delivery_failed',
  'report.email_cancelled',
  'shift.reminder_sent',
  'shift_assignment.no_show',
  'shift_assignment.missing_clock_out_flagged',
  'offer.expired_by_worker',
  'shift.request_submitted',
  'shift.request_approved',
  'shift.request_declined',
  'shift.request_staff_removed',
  'shift.request_staff_added',
  'shift.cancelled',
  'shift_assignment.late_clock_in_flagged',
  'shift_assignment.cancelled_by_worker',
  'offer.withdrawn_by_worker',
  'offer.rejected_by_worker',
  'replacement_request.created',
  'replacement_request.approved',
  'replacement_request.rejected',
  'replacement_request.cancelled_at_approval',
  'offer.manager_confirmation_timeout_flagged',
  'storage.cleanup_run',
  'navigation_layout.saved',
  'ai.conversation_created',
  'ai.conversation_deleted',
  'ai.turn_started',
  'ai.turn_completed',
  'ai.turn_failed',
  'ai.turn_cancelled',
  'ai.turn_refused',
  'ai.tool_called',
  'ai.tool_denied',
  'ai.retention_purged',
  'ai.synthetic_data_marked',
  'ai.default_changed',
  'ai.model_policy_changed',
  'ai.assistant_profile_changed',
  'ai.budget_threshold',
  'ai.usage_viewed',
  'ai.proposal_created',
  'ai.proposal_approved',
  'ai.proposal_rejected',
  'ai.proposal_executed',
  'ai.proposal_failed',
  'ai.proposal_expired',
  'manager.note_added',
  'shift.draft_updated',
  'ai.title_generated',
  'ai.skill_created',
  'ai.skill_updated',
  'ai.skill_deleted',
  'ai.skill_activated',
  'ai.skill_deactivated',
  'ai.instructions_updated',
  'ai.prompt_previewed',
  'ai.agent_created',
  'ai.agent_updated',
  'ai.agent_deleted',
  'ai.agent_trigger_created',
  'ai.agent_trigger_updated',
  'ai.agent_trigger_deleted',
  'ai.agent_trigger_disabled',
  'ai.input_requested',
  'ai.input_answered',
  // Written directly by the Worker (not AuditAction constants): e-mail dispatch and account-invite cleanup outcomes.
  'email.delivery_uncertain',
  'user.invite_cleanup_failed',
  // Written only by the frozen one-off migration HwsHistoricalRowsPrivilegedCopy1786719520000 (privileged-copy.ts).
  'workspace.hws_backfill_privileged_copy',
  'workspace.hws_backfill_privileged_copy_skipped',
]);

/** The category and severity of a shipped action, or null (not shipped). */
export function classifyAuditAction(action: string): SecurityAuditClassification | null {
  return Object.prototype.hasOwnProperty.call(SHIPPED_AUDIT_ACTIONS, action) ? SHIPPED_AUDIT_ACTIONS[action]! : null;
}
