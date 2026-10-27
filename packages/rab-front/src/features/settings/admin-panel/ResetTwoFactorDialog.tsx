import { useQueryClient } from '@tanstack/react-query';

import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { patchCachedAdminUser, RESET_2FA_ERROR_TEXT, resetTwoFactor } from './adminPanelApi';

/**
 * "Reset 2FA for <name>?" — the owner's account-security design (docs/design/crewflow-account-security.html, resetModal()),
 * built on the Admin panel's shared reason + step-up dialog. Contract (account-security step 1, 2026-10-24):
 * `POST /admin/users/:userId/mfa/reset { reason, currentPassword?, code? }` → `{ reset: true, revokedSessions }`.
 * The password (and the admin's OWN code, only when the admin is enrolled) go inline when typed; with an empty password
 * only the reason is sent and the shared StepUpHost handles STEP_UP_REQUIRED. Every rule is server-side: never on
 * oneself, never on another platform admin (409 MFA_RESET_REQUIRES_SECOND_ADMIN), 5 per hour per admin.
 */
export default function ResetTwoFactorDialog({
  userId,
  userLabel,
  onClose,
  onDone,
}: {
  userId: string;
  userLabel: string;
  onClose: () => void;
  /** Called after the 200 only, with the server's real count of ended sessions. */
  onDone?: (result: { revokedSessions: number }) => void;
}) {
  const qc = useQueryClient();
  return (
    <AdminActionDialog
      title={`Reset 2FA for ${userLabel}?`}
      body="Confirm your identity before helping this user regain access."
      notice="This removes their authenticator and recovery codes, and signs them out on all devices."
      confirmLabel="Reset two-factor authentication"
      tone="danger"
      dangerOutline
      stacked
      labels={{
        password: 'Your current password',
        code: 'Your 2FA code',
        codeHint: 'Enter your own authenticator code if 2FA is enabled on your account.',
        reason: 'Reason for reset',
        reasonPlaceholder: 'User lost access to their authenticator and recovery codes',
      }}
      errorText={RESET_2FA_ERROR_TEXT}
      onConfirm={async ({ reason, currentPassword, code }) => {
        const result = await resetTwoFactor(userId, { reason, currentPassword, code });
        // The server confirmed the reset: every cached row for this user shows 2FA off at once (so "Reset 2FA" can't be
        // pressed again on a stale card, which would answer MFA_NOT_ENABLED), then the lists refetch in the background.
        patchCachedAdminUser(qc, userId, { twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, recoveryCodesTotal: 0 } });
        toast.success(`Two-factor authentication was reset for ${userLabel}.`);
        onDone?.({ revokedSessions: result.revokedSessions });
        onClose();
        void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      }}
      onClose={onClose}
    />
  );
}
