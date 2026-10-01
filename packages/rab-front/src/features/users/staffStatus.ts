/**
 * ONE canonical status derivation for a Staff/Manager record — the Users
 * table and the User detail drawer must both call this and render whatever
 * it returns, never compute their own Active/Pending/etc. label locally.
 * This is what fixes the table-vs-drawer mismatch bug: the drawer used to
 * gate "Active" on `employmentStatus` (a separate HR/compliance field) for
 * staff, while the table correctly gates on `accountStatus` (the real
 * account-activation state) for both staff and managers — a staff member
 * mid-invitation can easily have `employmentStatus === 'active'` by default
 * while their account has never been activated, which is exactly what made
 * the table show "Pending invite (2/3)" while the drawer showed "Active".
 *
 * `tone` only ever takes one of the three values the app's existing status
 * palette already styles consistently everywhere else (`badge-active` green,
 * `badge-pending` blue, `badge-inactive` grey) — deliberately never
 * `badge-cancelled` (red), which the drawer used to reach for "Invitation
 * cancelled"/"Invite expired" while the table used grey for the same
 * states; grey is correct here (a lapsed/cancelled invite isn't a
 * destructive action like a cancelled shift) and is now the only path.
 */

export type InvitationStatus =
  | 'pending'
  | 'cancelled'
  | 'expired'
  | 'queued'
  | 'sending'
  | 'delivery_failed'
  | null;

export interface PendingInvite {
  sendNumber: number;
  maxSendAttempts?: number;
}

export interface UserStatusInput {
  userType: 'staff' | 'manager';
  /** Raw `UserStatus` value from the backend — invited/active/suspended/deactivated/invite_expired. */
  accountStatus: string;
  /** Staff-only HR/compliance status (pending_compliance/active/inactive/suspended). Ignored for managers. */
  employmentStatus?: string | null;
  invitationStatus: InvitationStatus;
  pendingInvite: PendingInvite | null;
}

export interface DisplayStatus {
  /** Stable machine key, for tests/analytics — never rendered directly. */
  key: string;
  label: string;
  tone: 'active' | 'pending' | 'inactive';
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function getStaffDisplayStatus({
  userType,
  accountStatus,
  employmentStatus,
  invitationStatus,
  pendingInvite,
}: UserStatusInput): DisplayStatus {
  // The account is genuinely activated — for staff, what's shown from here
  // is the separate employment/compliance axis; for a manager there is no
  // second axis, so "Active" is the whole story.
  if (accountStatus === 'active') {
    if (userType === 'staff' && employmentStatus) {
      return {
        key: employmentStatus,
        label: employmentStatus.replace(/_/g, ' '),
        tone: employmentStatus === 'active' ? 'active' : 'inactive',
      };
    }
    return { key: 'active', label: 'Active', tone: 'active' };
  }

  // Not yet activated (or no longer activated) — the invitation lifecycle,
  // when one is in flight, is the source of truth; it always wins over a
  // stale/default `employmentStatus`.
  if (invitationStatus === 'cancelled') {
    return { key: 'invitation_cancelled', label: 'Invitation cancelled', tone: 'inactive' };
  }
  if (invitationStatus === 'expired') {
    return {
      key: 'invite_expired',
      label: accountStatus === 'invite_expired' ? 'Expired — cleanup in 7d' : 'Invite expired',
      tone: 'inactive',
    };
  }
  if (invitationStatus === 'queued') {
    return { key: 'invitation_queued', label: 'Invitation queued', tone: 'pending' };
  }
  if (invitationStatus === 'sending') {
    return { key: 'invitation_sending', label: 'Invitation sending…', tone: 'pending' };
  }
  if (invitationStatus === 'delivery_failed') {
    return { key: 'delivery_failed', label: 'Delivery failed', tone: 'inactive' };
  }
  if (invitationStatus === 'pending') {
    const n = pendingInvite?.sendNumber ?? 1;
    return {
      key: 'pending_invite',
      label: n >= 3 ? 'Final invite (3/3)' : `Pending invite (${n}/3)`,
      tone: 'pending',
    };
  }

  // No invitationStatus, but the account genuinely isn't active yet — no
  // AccountInvite row exists at all (creation-time email was skipped
  // because the worker/email service was unavailable). Must still show a
  // real pending state, never fall through to "Suspended" just because no
  // invite happens to be in flight right now.
  if (accountStatus === 'invited' || accountStatus === 'invite_expired') {
    return { key: 'pending_invite_not_sent', label: 'Pending — invite not sent', tone: 'pending' };
  }

  // Genuinely suspended/deactivated, invitation lifecycle long resolved.
  return { key: accountStatus || 'suspended', label: titleCase(accountStatus || 'suspended'), tone: 'inactive' };
}
