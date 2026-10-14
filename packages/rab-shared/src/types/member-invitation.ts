import { PermissionFlag, PermissionFlagType } from '../constants/permission-flags';

/**
 * Email-first workspace invitations (Settings → Members → Invite). The administrator supplies only email
 * addresses and the id of a CUSTOM workspace-member role (created in Settings → Members → Roles); the
 * recipient supplies their own name and password when they accept and joins the inviter's own workspace.
 *
 * Recruitment Staff and Venue Managers are never invited here (they keep their Users-page flows), and neither
 * are leadership roles (CEO, Initial Manager, Platform Admin — `OrganisationOnboardingService`). The server
 * decides which roles a caller may assign; a role id from a client is a request, never an authority.
 */

/**
 * Every custom workspace-member role's key starts with this prefix, and no system role's ever does (enforced by
 * the `role_member_key` CHECK). Authentication treats a role as a workspace-member role ONLY by this prefix,
 * which is therefore unforgeable: a custom role can never take a privileged system key such as `manager`.
 */
export const CUSTOM_ROLE_KEY_PREFIX = 'custom_';

export function isCustomRoleKey(key: string): boolean {
  return key.startsWith(CUSTOM_ROLE_KEY_PREFIX);
}

/**
 * The only permissions a custom workspace-member role may hold. Deliberately read-only for now: members see the
 * workspace owner's Staff, Venues and Shifts through the owner's own creator-based record scope, and cannot
 * create records (which would raise an unresolved ownership question). Also mirrored by the
 * `role_permission_member_allowlist` trigger in the database. Never includes leadership, role-management, user-
 * management or recruitment-Staff self-service flags.
 */
export const MEMBER_ROLE_ALLOWED_PERMISSIONS: readonly PermissionFlagType[] = [
  PermissionFlag.STAFF_VIEW,
  PermissionFlag.VENUE_VIEW,
  PermissionFlag.SCHEDULE_VIEW,
];

/**
 * Invitation state as shown to administrators. Derived server-side from the invitation row and its
 * latest email-outbox row — never stored, never client-asserted, and never confused with account state.
 * `sent` means the email provider confirmed acceptance of the message, not merely that it was queued.
 */
export const MemberInvitationStatus = {
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERY_FAILED: 'delivery_failed',
  ACCEPTED: 'accepted',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  SUPERSEDED: 'superseded',
} as const;
export type MemberInvitationStatusType = (typeof MemberInvitationStatus)[keyof typeof MemberInvitationStatus];

/** Per-recipient result of a (possibly multi-email) send. */
export const MemberInvitationOutcome = {
  INVITED: 'invited',
  ALREADY_INVITED: 'already_invited',
  ALREADY_MEMBER: 'already_member',
  INVALID_EMAIL: 'invalid_email',
  /** A conflict the caller is not allowed to see the details of (for example an invitation in another Manager's workspace). */
  UNAVAILABLE: 'unavailable',
} as const;
export type MemberInvitationOutcomeType = (typeof MemberInvitationOutcome)[keyof typeof MemberInvitationOutcome];

/** Same policy as account invitations: 24 hours per link, at most three sends per invitation. */
export const MEMBER_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MEMBER_INVITATION_MAX_SENDS = 3;
/** Upper bound on emails per send request. */
export const MEMBER_INVITATION_MAX_EMAILS_PER_REQUEST = 20;
