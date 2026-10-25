import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditLog } from '../../../modules/identity/entities';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * Values are `subject.verb`, dot-separated — this is the contract
 * `TimelinePanel.tsx`/`AuditLog.tsx` were already built against
 * (`action.split('.')` to derive a subject/verb pair) before either had a
 * real backend route. Keep new actions in this shape; don't reintroduce
 * uppercase-underscore names.
 */
export const AuditAction = {
  APPLICATION_ACCESS_DENIED: 'auth.application_access_denied',
  USER_LOGIN: 'auth.login',
  USER_CREATED: 'user.created',
  INVITE_EMAIL_SENT: 'user.invited',
  PASSWORD_CHANGED: 'password.changed',
  PASSWORD_RESET_REQUESTED: 'password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'password.reset_completed',
  ADMIN_PASSWORD_RESET: 'password.admin_reset',
  OFFER_SENT: 'offer.sent',
  /** "Send anyway": an offer dispatched to staff outside their declared weekday availability, with the exact dates acknowledged. */
  OFFER_AVAILABILITY_CONFLICT_ACKNOWLEDGED: 'offer.availability_conflict_acknowledged',
  SHIFT_REQUEST_AVAILABILITY_CONFLICT_ACKNOWLEDGED: 'shift.request_availability_conflict_acknowledged',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_DECLINED: 'offer.declined',
  OFFER_CONFIRMED: 'offer.confirmed',
  OFFER_REJECTED: 'offer.rejected',
  OFFER_WITHDRAWN: 'offer.withdrawn',
  OFFER_EXPIRED: 'offer.expired',
  USER_LOGOUT: 'user.logout',
  PROFILE_UPDATED: 'profile.updated',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_SUBDOMAIN_CHANGED: 'workspace.subdomain_changed',
  /** P1C.1B — organisation-level password/Google/Microsoft toggle change. One action for all three providers; `metadata` carries which field(s) changed and the resulting effective state. */
  ORGANISATION_AUTH_PROVIDERS_UPDATED: 'organisation.auth_providers_updated',
  /** Wave 1 lane A (D-A2, owner decision "log them out"): password sign-in was turned off and the organisation's live password sessions were revoked in the same transaction. `metadata`: revoked/exempt counts. */
  ORGANISATION_PASSWORD_SESSIONS_REVOKED: 'organisation.password_sessions_revoked',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_PERMISSIONS_UPDATED: 'role.permissions_updated',
  ROLE_DELETED: 'role.deleted',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_SUSPENDED: 'member.suspended',
  MEMBER_REINSTATED: 'member.reinstated',
  PLATFORM_CONFIG_SMTP_UPDATED: 'platform_config.smtp_updated',
  PLATFORM_CONFIG_MAINTENANCE_MODE_CHANGED: 'platform_config.maintenance_mode_changed',
  MANAGER_VENUE_ASSIGNED: 'manager.venue_assigned',
  MANAGER_VENUE_UNASSIGNED: 'manager.venue_unassigned',
  /** The workspace owner gave one of their Venue Managers visibility of (a) Staff member(s); `metadata.staffProfileIds`. */
  VENUE_TEAM_STAFF_ASSIGNED: 'venue_team.staff_assigned',
  /** The workspace owner removed a Staff member from one of their Venue Managers' team; no account or history is touched. */
  VENUE_TEAM_STAFF_UNASSIGNED: 'venue_team.staff_unassigned',
  CEO_CREATED: 'manager.ceo_created',
  /** P2.9B — Platform-Super-Admin-only organisation creation, distinct from CEO_CREATED (the org itself, not its first user). */
  ORGANISATION_CREATED: 'organisation.created',
  /** P2.9 gap review, item 2 — a never-activated, genuinely stuck Initial Manager invitation was replaced (never deleted). `metadata` carries the superseded profile/email and the new one. */
  INITIAL_MANAGER_REPLACED: 'manager.initial_manager_replaced',
  /** CEO/admin flow: a Venue Manager created for an EXPLICITLY chosen target workspace (never the caller's). */
  ADMIN_VENUE_MANAGER_CREATED: 'admin.venue_manager_created',
  ADMIN_INSPECT_STARTED: 'admin.inspect_started',
  ADMIN_INSPECT_ENDED: 'admin.inspect_ended',
  ADMIN_INSPECT_MUTATION_REFUSED: 'admin.inspect_mutation_refused',
  /** Platform Admin Panel operations (`platform-admin/admin-panel-audit-actions.ts`); values are filtered on by `core.admin_list_audit_events`. */
  ADMIN_SESSIONS_REVOKED: 'admin.sessions_revoked',
  ADMIN_QUEUE_JOBS_RETRIED: 'admin.queue_jobs_retried',
  ADMIN_QUEUE_JOBS_DELETED: 'admin.queue_jobs_deleted',
  ADMIN_USER_SEARCHED: 'admin.user_searched',
  ADMIN_USER_VIEWED: 'admin.user_viewed',
  ADMIN_ORGANISATION_SEARCHED: 'admin.organisation_searched',
  ADMIN_TEST_EMAIL_SENT: 'admin.test_email_sent',
  ADMIN_EMAIL_REPLAY_REASON: 'admin.email_replay_reason',
  PASSWORD_SIGN_IN_PROVIDER_DISABLED: 'auth.password_sign_in_provider_disabled',
  EMAIL_CHANGE_REQUESTED: 'user.email_change_requested',
  EMAIL_CHANGE_CONFIRMED: 'user.email_change_confirmed',
  STAFF_CLOCKED_IN: 'attendance.clocked_in',
  STAFF_CLOCKED_OUT: 'attendance.clocked_out',
  ATTENDANCE_POST_SHIFT_COMPLETED: 'attendance.post_shift_completed',
  ATTENDANCE_POST_SHIFT_EXPIRED: 'attendance.post_shift_expired',
  STAFF_AUTO_CLOCKED_OUT_GEOFENCE: 'attendance.auto_clocked_out_geofence',
  ATTENDANCE_CORRECTED: 'attendance.corrected',
  ATTENDANCE_REVIEWED: 'attendance.reviewed',
  /** A manager entered attendance for a seat with none (staff never clocked in via the app); before/after + reason in metadata. */
  ATTENDANCE_MANAGER_RECORDED: 'attendance.manager_recorded',
  /** A manager confirmed a seat's no-show (explicit review; the worker's mark alone is provisional). */
  ATTENDANCE_NO_SHOW_CONFIRMED: 'attendance.no_show_confirmed',
  /** A manager reopened a confirmed no-show (back to provisional), with the reason. */
  ATTENDANCE_NO_SHOW_REOPENED: 'attendance.no_show_reopened',
  /** Staff Check In (arrival evidence, not worked time): source, location-verified flag, rounded distance/accuracy. No coordinates. */
  STAFF_CHECKED_IN: 'attendance.checked_in',
  /** A Venue Manager clocked a checked-in staff member in on their behalf (server time; reason + manager in metadata and on the row). */
  ATTENDANCE_CLOCKED_IN_ON_BEHALF: 'attendance.clocked_in_on_behalf',
  /** A Venue Manager clocked a staff member out on their behalf (server time; reason + manager in metadata and on the row). */
  ATTENDANCE_CLOCKED_OUT_ON_BEHALF: 'attendance.clocked_out_on_behalf',
  ATTENDANCE_REPORT_FINALISED: 'attendance.report_finalised',
  /** A workspace manager with payroll.approve approved one finalised shift's gross pay (per record; `bulk` in metadata). */
  PAYROLL_RECORD_APPROVED: 'payroll_record.approved',
  /** ...or rejected it, with the reason in metadata. */
  PAYROLL_RECORD_REJECTED: 'payroll_record.rejected',
  /** The worker stored the record's Approved Shift Statement PDF (metadata: file id, notified or not). Actor-less. */
  SHIFT_STATEMENT_GENERATED: 'payroll_record.shift_statement_generated',
  /** An Approved Shift Statement attempt failed (safe code only); retried up to the attempt limit. Actor-less. */
  SHIFT_STATEMENT_FAILED: 'payroll_record.shift_statement_failed',
  /** A manager re-queued a failed Approved Shift Statement (same durable outbox path). */
  SHIFT_STATEMENT_RETRY_REQUESTED: 'payroll_record.shift_statement_retry_requested',
  PAYROLL_CALENDAR_IMPORTED: 'payroll_calendar.imported',
  PAYROLL_RUN_PREPARED: 'payroll_run.prepared',
  PAYROLL_RUN_FINALISED: 'payroll_run.finalised',
  /** A late-approved record was carried into a later period's run (original work date + period in metadata). */
  PAYROLL_LATE_CARRIED_FORWARD: 'payroll_run.late_carried_forward',
  PAYROLL_RUN_EXPORTED: 'payroll_run.exported',
  PAYSLIP_UPLOADED: 'payslip.uploaded',
  PAYSLIP_NET_RECORDED: 'payslip.net_recorded',
  PAYSLIP_MARKED_PAID: 'payslip.marked_paid',
  STAFF_REVIEW_SAVED: 'shift_review.saved',
  // Wave 5 (lane DATA) — named archive/restore actions. `entityType`/`entityId` = the archived record; staff and
  // manager rows also carry `targetUserId` so the person's timeline shows them. Metadata never carries pay or email.
  VENUE_ARCHIVED: 'venue.archived',
  VENUE_RESTORED: 'venue.restored',
  JOB_ROLE_ARCHIVED: 'job_role.archived',
  JOB_ROLE_RESTORED: 'job_role.restored',
  STAFF_ARCHIVED: 'staff.archived',
  STAFF_RESTORED: 'staff.restored',
  /**
   * A manager added a note to a staff member's record (`StaffService.addNote`). Metadata: `noteId` and `length` only —
   * never the note text (it can carry personal detail, and audit rows are kept, insert-only).
   */
  STAFF_NOTE_ADDED: 'staff.note_added',
  MANAGER_ARCHIVED: 'manager.archived',
  MANAGER_RESTORED: 'manager.restored',
  SHIFT_ARCHIVED: 'shift.archived',
  SHIFT_RESTORED: 'shift.restored',
  /** Wave 5: the shift lifecycle's first two steps, recorded by SchedulingService.create / publish (timeline read model). */
  SHIFT_CREATED: 'shift.created',
  SHIFT_PUBLISHED: 'shift.published',
  VENUE_GEOFENCE_UPDATED: 'venue.geofence_updated',
  VENUE_PHOTO_UPDATED: 'venue.photo_updated',
  FILE_UPLOADED: 'file.uploaded',
  FILE_DOWNLOAD_AUTHORIZED: 'file.download_authorized',
  FILE_ACCESS_DENIED: 'file.access_denied',
  FILE_DELETED: 'file.deleted',
  FILE_MIGRATION_COMPLETED: 'file.migration_completed',
  REPORT_STORED: 'report.stored',
  REPORT_INTEGRITY_FAILED: 'report.integrity_failed',
  STAFF_SUSPENSION_NOTICE_SENT: 'staff.suspension_notice_sent',
  MANAGER_WORKSPACE_CREATED: 'manager_workspace.created',
  MANAGER_WORKSPACE_SUBDOMAIN_CHANGED: 'manager_workspace.subdomain_changed',
  MANAGER_WORKSPACE_UPDATED: 'manager_workspace.updated',
  MANAGER_WORKSPACE_ONBOARDING_COMPLETED: 'manager_workspace.onboarding_completed',
  /** Server-path provisioning (1786719500000): `core.provision_workspace` built and verified the workspace schema; READY once. */
  MANAGER_WORKSPACE_PROVISIONED: 'manager_workspace.provisioned',
  /** Server-path provisioning: the attempt rolled back and FAILED was recorded. `metadata.safeError` is a fixed label or SQLSTATE only. */
  MANAGER_WORKSPACE_PROVISIONING_FAILED: 'manager_workspace.provisioning_failed',
  REFRESH_TOKEN_REUSE_DETECTED: 'auth.refresh_reuse_detected',
  /** P0.2: an authenticated caller presented a refresh token belonging to a DIFFERENT user at logout. The call is rejected (never revokes), this event records the attempt. See refresh-token.service.ts's revokeByToken doc comment. */
  LOGOUT_TOKEN_OWNERSHIP_MISMATCH: 'auth.logout_token_ownership_mismatch',
  PLATFORM_ADMIN_GRANTED: 'platform_admin.granted',
  PLATFORM_ADMIN_REVOKED: 'platform_admin.revoked',
  PLATFORM_ADMIN_BOOTSTRAPPED: 'platform_admin.bootstrapped',
  /** P2.8 — reversible, platform-admin-controlled. `metadata.reason` carries the suspension reason text. */
  ORGANISATION_SUSPENDED: 'organisation.suspended',
  ORGANISATION_REACTIVATED: 'organisation.reactivated',
  INVITE_EMAIL_FAILED: 'user.invite_failed',
  INVITE_EMAIL_QUEUED: 'user.invite_queued',
  INVITE_RESENT: 'user.invite_resent',
  INVITE_PENDING_EMAIL_CHANGED: 'user.invite_pending_email_changed',
  INVITE_CANCELLED: 'user.invite_cancelled',
  // Password set via /auth/activate-account — distinct from ACCOUNT_ACTIVATED
  // (which now fires at first successful login, not at password-set time).
  INVITE_ACCEPTED: 'user.invite_accepted',
  ACCOUNT_ACTIVATED: 'user.activated',
  ACCOUNT_SUSPENDED: 'user.suspended',
  ACCOUNT_REACTIVATED: 'user.reactivated',
  USER_DELETED: 'user.deleted',
  ACCOUNT_INVITE_EXPIRED: 'user.invite_expired',
  ACCOUNT_INVITE_CLEANED_UP: 'user.invite_cleaned_up',
  ACCOUNT_INVITE_CLEANUP_SKIPPED: 'user.invite_cleanup_skipped',
  // Email-first member invitations (MemberInvitationService). `entityType` = 'member_invitation'; metadata never
  // carries the token or its hash. Delivery outcomes use the generic EMAIL_SENT / EMAIL_DELIVERY_FAILED pair with
  // `metadata.jobType = 'MEMBER_INVITATION'`.
  MEMBER_INVITATION_SENT: 'member_invitation.sent',
  MEMBER_INVITATION_RESENT: 'member_invitation.resent',
  MEMBER_INVITATION_REVOKED: 'member_invitation.revoked',
  MEMBER_INVITATION_ACCEPTED: 'member_invitation.accepted',
  /** Owner correction 2026-10-23: a platform administrator's email-only CEO invitation (Settings → Members → Add). */
  ORGANISATION_INVITATION_SENT: 'organisation_invitation.sent',
  ORGANISATION_INVITATION_RESENT: 'organisation_invitation.resent',
  ORGANISATION_INVITATION_REVOKED: 'organisation_invitation.revoked',
  ORGANISATION_INVITATION_ACCEPTED: 'organisation_invitation.accepted',
  MEMBER_INVITATION_SUPERSEDED: 'member_invitation.superseded',
  // Generic email-delivery outcome — every EmailOutboxJobType EXCEPT
  // ACCOUNT_INVITATION (which keeps its own INVITE_EMAIL_SENT/_FAILED
  // action for backward-compatible audit-log semantics and existing test
  // assertions) resolves through this pair; `metadata.jobType` disambiguates.
  EMAIL_SENT: 'email.sent',
  EMAIL_DELIVERY_FAILED: 'email.delivery_failed',
  SHIFT_REMINDER_SENT: 'shift.reminder_sent',
  SHIFT_ASSIGNMENT_NO_SHOW: 'shift_assignment.no_show',
  SHIFT_ASSIGNMENT_MISSING_CLOCK_OUT_FLAGGED: 'shift_assignment.missing_clock_out_flagged',
  OFFER_EXPIRED_BY_WORKER: 'offer.expired_by_worker',
  SHIFT_REQUEST_SUBMITTED: 'shift.request_submitted',
  SHIFT_REQUEST_APPROVED: 'shift.request_approved',
  SHIFT_REQUEST_DECLINED: 'shift.request_declined',
  SHIFT_REQUEST_STAFF_REMOVED: 'shift.request_staff_removed',
  SHIFT_REQUEST_STAFF_ADDED: 'shift.request_staff_added',
  /** PHASE 5 — the synchronous, manager-initiated cancellation itself (`SchedulingService.cancel()`); previously entirely unaudited. Distinct from `SHIFT_ASSIGNMENT_CANCELLED_BY_WORKER` below, which is the async follow-up job closing out each individual affected assignment/offer. */
  SHIFT_CANCELLED: 'shift.cancelled',
  // rab-worker package migration — late clock-in / cancellation follow-up /
  // replacement automation / manager-confirmation-timeout / storage cleanup.
  LATE_CLOCK_IN_FLAGGED: 'shift_assignment.late_clock_in_flagged',
  SHIFT_ASSIGNMENT_CANCELLED_BY_WORKER: 'shift_assignment.cancelled_by_worker',
  OFFER_WITHDRAWN_BY_WORKER: 'offer.withdrawn_by_worker',
  OFFER_REJECTED_BY_WORKER: 'offer.rejected_by_worker',
  REPLACEMENT_REQUEST_CREATED: 'replacement_request.created',
  REPLACEMENT_REQUEST_APPROVED: 'replacement_request.approved',
  REPLACEMENT_REQUEST_REJECTED: 'replacement_request.rejected',
  /** PHASE 4 — the shift was cancelled, fully staffed, or otherwise no longer needed at approval time; the approval attempt itself is what discovered this, not the worker's own cancellation-followup sweep. */
  REPLACEMENT_REQUEST_CANCELLED_AT_APPROVAL: 'replacement_request.cancelled_at_approval',
  MANAGER_CONFIRMATION_TIMEOUT_FLAGGED: 'offer.manager_confirmation_timeout_flagged',
  STORAGE_CLEANUP_RUN: 'storage.cleanup_run',
  /** P1B: a user revoked one of their OWN other sessions/devices (never the current one — that's USER_LOGOUT). Metadata carries the revoked session id, never any token material. */
  SESSION_REVOKED: 'auth.session_revoked',
  /** A user saved their OWN navigation layout (personal scope). Metadata: revision and counts only — never labels, links or record ids. */
  NAVIGATION_LAYOUT_SAVED: 'navigation_layout.saved',
  // Wave 4 lane MFA. `metadata` never carries a code, a secret, a provisioning URI, a recovery code or any hash of one —
  // only the method ('totp' | 'recovery_code'), counts, the requirement and the transport.
  /** A sign-in proved the first factor and now waits for the second (`metadata.requirement`: verify | enroll). */
  MFA_CHALLENGE_ISSUED: 'user.mfa_challenge_issued',
  MFA_CHALLENGE_SUCCEEDED: 'user.mfa_challenge_succeeded',
  MFA_CHALLENGE_FAILED: 'user.mfa_challenge_failed',
  MFA_ENROLMENT_STARTED: 'user.mfa_enrolment_started',
  MFA_ENABLED: 'user.mfa_enabled',
  MFA_DISABLED: 'user.mfa_disabled',
  /** A platform administrator cleared another user's second factor (row in the admin's org AND in the target's org). */
  MFA_RESET_BY_ADMIN: 'user.mfa_reset_by_admin',
  MFA_RECOVERY_CODES_REGENERATED: 'user.mfa_recovery_codes_regenerated',
  MFA_RECOVERY_CODE_USED: 'user.mfa_recovery_code_used',
  /** Account security step 1 (P3): a mobile sign-in needed the factor but its client cannot enter it — refused, nothing issued. */
  MFA_CLIENT_UPDATE_REQUIRED: 'user.mfa_client_update_required',
  /** Step 1 (P4): an admin reset of another account's factor was refused (metadata.reason; e.g. the target is a platform admin). */
  MFA_RESET_REFUSED: 'user.mfa_reset_refused',
  /** Step 1 (P6): a provider re-authentication (step-up for SSO accounts) was refused (metadata.reason, provider). */
  SSO_REAUTH_FAILED: 'auth.sso_reauth_failed',
  STEP_UP_SUCCEEDED: 'auth.step_up_succeeded',
  STEP_UP_FAILED: 'auth.step_up_failed',
  /** Cross-host login handoff created on the source host / exchanged for a host-only session on the workspace host. */
  LOGIN_HANDOFF_CREATED: 'auth.login_handoff_created',
  LOGIN_HANDOFF_EXCHANGED: 'auth.login_handoff_exchanged',
  // AI Phase 1 (docs/ai/PHASE1_PLAN.md, modules/ai). METADATA ONLY: ids, tool names, outcomes, counts, token totals and
  // error codes. Never a prompt, a reply, a tool argument or result, a record value or a provider key.
  AI_CONVERSATION_CREATED: 'ai.conversation_created',
  AI_CONVERSATION_DELETED: 'ai.conversation_deleted',
  AI_TURN_STARTED: 'ai.turn_started',
  AI_TURN_COMPLETED: 'ai.turn_completed',
  AI_TURN_FAILED: 'ai.turn_failed',
  AI_TURN_CANCELLED: 'ai.turn_cancelled',
  /** A submitted question refused before queueing or at Worker start (metadata.reason: access / rate / budget / busy …). */
  AI_TURN_REFUSED: 'ai.turn_refused',
  AI_TOOL_CALLED: 'ai.tool_called',
  /** The model asked for a tool the user may not use, or with invalid input (never executed). */
  AI_TOOL_DENIED: 'ai.tool_denied',
  /** A platform administrator turned an organisation's AI switch on or off (row in the TARGET organisation). */
  AI_ORGANISATION_SETTING_CHANGED: 'ai.organisation_setting_changed',
  AI_RETENTION_PURGED: 'ai.retention_purged',
  /** Development only: `seed-ai-demo` marked a fully synthetic organisation (`synthetic_data`) for the real-provider gate. */
  AI_SYNTHETIC_DATA_MARKED: 'ai.synthetic_data_marked',
  /**
   * The organisation's CEO pinned (or cleared — "Choose automatically") the model of one tier in Settings → AI
   * (security 12.2, PHASE1_TWENTY_PLAN D7). Metadata: tier, from, to (catalogue ids or null), reason.
   */
  AI_DEFAULT_CHANGED: 'ai.default_changed',
  /** AI Phase 2 (P2-C9): the Worker wrote a model-generated thread title (billed call). Metadata: { model, tokens } only. */
  AI_TITLE_GENERATED: 'ai.title_generated',
} as const;
export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditLogListItem {
  id: string;
  action: string;
  actor: { fullName: string } | null;
  metadata: Record<string, unknown>;
  targetType: string | null;
  targetId: string | null;
  createdAt: Date;
}

/**
 * `record()` takes an already-open, tenant-bound `EntityManager` rather
 * than opening its own transaction (mirrors `RefreshTokenService`'s shape)
 * — every current call site already runs inside `runInTenantContext` for
 * the business-logic write it's auditing (e.g. `staff.service.ts`'s
 * `create()`), so the audit row lands in the same transaction and either
 * both commit or neither does. `audit_log` is FORCEd RLS and insert-only
 * at the DB grant level (CLAUDE.md) — this is the only write path for it
 * in the app.
 *
 * Never pass a password, token, or token hash in `metadata`.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async record(
    manager: EntityManager,
    ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>,
    action: AuditActionType,
    opts: {
      targetUserId?: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
      /**
       * Overrides the ctx-derived actor entirely — `null` records a
       * deliberately actor-less entry (the platform-admin bootstrap CLI has
       * no authenticated human to attribute to; see
       * `grant-platform-admin.command.ts`). Omit for every ordinary
       * request-driven call, which keeps the existing
       * `ctx.inspectedBy ?? ctx.userId` behaviour unchanged.
       */
      actorUserId?: string | null;
    } = {},
  ): Promise<void> {
    // While an admin is inspecting another user, `ctx.userId` is the target
    // (so scoped reads look right) but the ACTOR of record must stay the
    // real human — `inspectedBy` is only ever set by JwtAuthGuard from an
    // already-re-verified session, never client-supplied on its own.
    const actorUserId = opts.actorUserId !== undefined ? opts.actorUserId : (ctx.inspectedBy ?? ctx.userId);
    const metadata = ctx.inspectedBy ? { ...(opts.metadata ?? {}), inspectedTargetUserId: ctx.userId } : (opts.metadata ?? {});
    await this.assertRecordedIdentitiesExist(manager, action, actorUserId, opts.targetUserId);
    const entry = manager.create(AuditLog, {
      organisationId: ctx.organisationId!,
      actorUserId: actorUserId ?? undefined,
      targetUserId: opts.targetUserId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action,
      metadata,
    });
    await manager.save(entry);
  }

  /**
   * `actorUserId`/`targetUserId` stopped being a live FK
   * (`AuditLogImmutableHistoricalIdentifiers1786692000000` — see that
   * migration and `AuditLog`'s own doc comment for why: the FK's `ON
   * DELETE SET NULL` action needed an owner privilege this table's
   * insert-only lockdown deliberately revokes, so it 500'd every user
   * deletion that touched it instead of nulling anything). Enforced once,
   * at the moment the event is recorded — never re-validated afterward,
   * same as the FK never re-validated existing rows either. Skipped for a
   * `null`/`undefined` id (the deliberate actor-less bootstrap case). Runs
   * on the same manager/transaction as the eventual insert, so a user
   * created earlier in that same transaction is already visible.
   *
   * Foundation fix P1 (2026-10-22): the rule is "a real user OF THIS
   * ENTRY'S ORGANISATION", not "a real user anywhere" — the previous
   * existence-only check (`core.audit_existing_user_ids`) let org A record
   * org B's user. The only cross-organisation shape allowed is an ACTIVE
   * platform-admin actor (grant/revoke, suspension, organisation creation,
   * Admin Inspect). The rule lives in ONE place, the database
   * (`AuditLogRecordedIdentityOrganisationCheck1786719610000`): this is the
   * service-layer pre-check (`core.audit_identity_violations`, evaluated
   * against the transaction's bound organisation), and a BEFORE INSERT
   * trigger on `core.audit_log` enforces the same function for every
   * writer, including the Worker's direct inserts and the table owner.
   */
  private async assertRecordedIdentitiesExist(
    manager: EntityManager,
    action: AuditActionType,
    actorUserId: string | null | undefined,
    targetUserId: string | undefined,
  ): Promise<void> {
    const actor = typeof actorUserId === 'string' && actorUserId.length > 0 ? actorUserId : null;
    const target = typeof targetUserId === 'string' && targetUserId.length > 0 ? targetUserId : null;
    if (actor === null && target === null) return;
    const violations = await manager.query<Array<{ user_id: string; reason: string }>>(
      `SELECT user_id, reason FROM core.audit_identity_violations($1::uuid, $2::uuid)`,
      [actor, target],
    );
    if (violations.length > 0) {
      // Reasons only (never another organisation's ids or details): unknown_user | other_organisation | no_organisation.
      const reasons = [...new Set(violations.map((v) => v.reason))].sort().join(', ');
      throw new Error(
        `AuditService.record: ${violations.length} actor/target id(s) passed to action "${action}" do not resolve to an existing core.user row in this entry's organisation (${reasons}) — refusing to record an audit event with a fabricated or out-of-tenant identity.`,
      );
    }
  }

  /**
   * Backs `GET /audit-logs` — the read side `TimelinePanel.tsx`/`AuditLog.tsx`
   * were already built against. `entityType`/`entityId` together scope this
   * to one entity's activity (e.g. one offer). `AUDIT_VIEW` is held by the
   * default `manager` role, so without actor-scoping any manager could read
   * every other manager's actions org-wide — a side channel around the
   * per-manager ownership model (staff.service.ts's `assertOwnedOrAdmin`
   * and friends). Every caller only ever sees entries where they are the
   * actor — Stage 2A Phase 2 retired the platform-admin org-wide bypass
   * this used to have; cross-actor visibility is available only through the
   * audited Admin Inspect mechanism (`AuthContext.inspectedBy` rebinds
   * `ctx.userId` to the inspected target, so this same actor-scoped query
   * naturally returns the target's own feed while inspecting — no separate
   * branch needed). `targetType`/`targetId` in the response fall back to
   * `'user'`/`targetUserId` for the account-lifecycle actions that predate
   * the polymorphic columns.
   */
  async list(
    ctx: AuthContext,
    opts: {
      page?: number;
      limit?: number;
      entityType?: string;
      entityId?: string;
      action?: string;
      createdAtFrom?: string;
      createdAtTo?: string;
      direction?: 'asc' | 'desc';
    } = {},
  ): Promise<{ items: AuditLogListItem[]; page: number; limit: number; total: number }> {
    const page = Math.max(1, opts.page ?? 1);
    // 500 matches AuditLog.tsx's full-page browse request; TimelinePanel.tsx's
    // side-drawer feed asks for the smaller default (100).
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = (page - 1) * limit;

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // `al.actor_user_id = $1` is not a filter a caller can widen or
      // remove — see this method's own doc comment. Every condition below
      // is ANDed onto it, only ever narrowing within the caller's own feed.
      const conditions: string[] = [`al.actor_user_id = $1`];
      const params: unknown[] = [ctx.userId];
      if (opts.entityType) {
        params.push(opts.entityType);
        conditions.push(`al.entity_type = $${params.length}`);
      }
      if (opts.entityId) {
        params.push(opts.entityId);
        conditions.push(`al.entity_id = $${params.length}`);
      }
      if (opts.action) {
        params.push(opts.action);
        conditions.push(`al.action = $${params.length}`);
      }
      if (opts.createdAtFrom) {
        params.push(new Date(opts.createdAtFrom));
        conditions.push(`al.created_at >= $${params.length}`);
      }
      if (opts.createdAtTo) {
        const exclusive = new Date(opts.createdAtTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        params.push(exclusive);
        conditions.push(`al.created_at < $${params.length}`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const direction = opts.direction === 'asc' ? 'ASC' : 'DESC';

      const [{ count }] = await manager.query(`SELECT count(*)::int AS count FROM core.audit_log al ${where}`, params);

      params.push(limit, offset);
      const rows = await manager.query(
        `
          SELECT al.id, al.action, al.metadata, al.entity_type, al.entity_id, al.target_user_id, al.created_at,
                 u.first_name AS actor_first_name, u.last_name AS actor_last_name
          FROM core.audit_log al
          LEFT JOIN core."user" u ON u.id = al.actor_user_id
          ${where}
          ORDER BY al.created_at ${direction}
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params,
      );

      const items: AuditLogListItem[] = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        action: r.action as string,
        actor: r.actor_first_name ? { fullName: `${r.actor_first_name} ${r.actor_last_name}` } : null,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        targetType: (r.entity_type as string) ?? (r.target_user_id ? 'user' : null),
        targetId: (r.entity_id as string) ?? (r.target_user_id as string) ?? null,
        createdAt: r.created_at as Date,
      }));

      return { items, page, limit, total: count };
    });
  }

  /**
   * Backs the Staff/Manager detail panel's "Timeline" tab — activity
   * ABOUT one person (both what a manager did to their account, via
   * `target_user_id`, and what the person did themselves, e.g. accepting
   * an offer or clocking in, via `actor_user_id`), unlike `list()` above
   * which is deliberately actor-scoped for the general Audit Log page.
   * Safe to be broader here because the caller has already authorized
   * access to `subjectUserId` itself (`StaffService.assertOwned` / a
   * Manager's org-wide visibility) before ever reaching this method —
   * visibility to this person's record already implies visibility to
   * their own activity feed.
   */
  async listForUser(ctx: AuthContext, subjectUserId: string, limit = 100): Promise<AuditLogListItem[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager.query(
        `
          SELECT al.id, al.action, al.metadata, al.entity_type, al.entity_id, al.target_user_id, al.created_at,
                 u.first_name AS actor_first_name, u.last_name AS actor_last_name
          FROM core.audit_log al
          LEFT JOIN core."user" u ON u.id = al.actor_user_id
          WHERE al.target_user_id = $1 OR al.actor_user_id = $1
          ORDER BY al.created_at DESC
          LIMIT $2
        `,
        [subjectUserId, limit],
      );

      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        action: r.action as string,
        actor: r.actor_first_name ? { fullName: `${r.actor_first_name} ${r.actor_last_name}` } : null,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        targetType: (r.entity_type as string) ?? (r.target_user_id ? 'user' : null),
        targetId: (r.entity_id as string) ?? (r.target_user_id as string) ?? null,
        createdAt: r.created_at as Date,
      }));
    });
  }
}
