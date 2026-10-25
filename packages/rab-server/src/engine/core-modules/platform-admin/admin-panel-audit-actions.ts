import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthContext } from '../tenant/auth-context.interface';

/**
 * Crewflow Platform Admin Panel — audit actions written by the panel's NEW operations, and the fixed allowlist of
 * platform-admin actions the Audit tab may show. The values live in `AuditAction` and must stay byte-identical — the
 * timeline SQL function filters on them.
 */
export const ADMIN_PANEL_AUDIT_ACTION = {
  /** "Sign out everywhere": every session + refresh token of the target revoked (rows in actor org AND target org). */
  SESSIONS_REVOKED: AuditAction.ADMIN_SESSIONS_REVOKED,
  QUEUE_JOBS_RETRIED: AuditAction.ADMIN_QUEUE_JOBS_RETRIED,
  QUEUE_JOBS_DELETED: AuditAction.ADMIN_QUEUE_JOBS_DELETED,
  /** D10: a cross-organisation user search (metadata: match kind + result count + result ids, never the raw query). */
  USER_SEARCHED: AuditAction.ADMIN_USER_SEARCHED,
  /** A user summary opened from a search result (target = that user). */
  USER_VIEWED: AuditAction.ADMIN_USER_VIEWED,
  ORGANISATION_SEARCHED: AuditAction.ADMIN_ORGANISATION_SEARCHED,
  TEST_EMAIL_SENT: AuditAction.ADMIN_TEST_EMAIL_SENT,
  /** The admin's reason for an email replay (same transaction as DB5's own `email.replay_requested` row). */
  EMAIL_REPLAY_REASON: AuditAction.ADMIN_EMAIL_REPLAY_REASON,
} as const;
export type AdminPanelAuditAction = (typeof ADMIN_PANEL_AUDIT_ACTION)[keyof typeof ADMIN_PANEL_AUDIT_ACTION];

/**
 * The Audit tab's allowlist — MUST equal `ADMIN_AUDIT_ACTIONS_1786720100000` + `ADMIN_AUDIT_VIA_ACTIONS_1786720100000`
 * (the SQL function refuses anything else; `admin-panel-audit-actions.spec.ts` asserts the two lists are identical).
 */
export const ADMIN_TIMELINE_ACTIONS: readonly string[] = [
  'platform_admin.granted',
  'platform_admin.revoked',
  'platform_admin.bootstrapped',
  'organisation.suspended',
  'organisation.reactivated',
  'organisation_invitation.sent',
  'organisation_invitation.resent',
  'organisation_invitation.revoked',
  'admin.inspect_started',
  'admin.inspect_ended',
  'admin.inspect_mutation_refused',
  'user.mfa_reset_by_admin',
  'user.mfa_reset_refused',
  'platform_config.smtp_updated',
  'platform_config.maintenance_mode_changed',
  'email.replay_requested',
  ADMIN_PANEL_AUDIT_ACTION.SESSIONS_REVOKED,
  ADMIN_PANEL_AUDIT_ACTION.QUEUE_JOBS_RETRIED,
  ADMIN_PANEL_AUDIT_ACTION.QUEUE_JOBS_DELETED,
  ADMIN_PANEL_AUDIT_ACTION.USER_SEARCHED,
  ADMIN_PANEL_AUDIT_ACTION.USER_VIEWED,
  ADMIN_PANEL_AUDIT_ACTION.ORGANISATION_SEARCHED,
  ADMIN_PANEL_AUDIT_ACTION.TEST_EMAIL_SENT,
  ADMIN_PANEL_AUDIT_ACTION.EMAIL_REPLAY_REASON,
  // Only rows with metadata.via = 'platform_admin' (the CEO-invite resend from the panel); tenant resends are excluded.
  'user.invite_resent',
];

export async function recordAdminPanelAudit(
  audit: AuditService,
  manager: EntityManager,
  ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>,
  action: AdminPanelAuditAction,
  opts: { targetUserId?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await audit.record(manager, ctx, action, opts);
}
