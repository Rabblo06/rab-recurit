import { toast } from '../../../../shared/lib/toast';
import {
  disableTwoFactor,
  onlyProviders,
  PROVIDER_LABEL,
  type MfaStatus,
} from '../../../auth/mfa/mfaApi';
import { Notice } from '../../../auth/mfa/ui/primitives';
import SecurityModal from '../../../auth/mfa/ui/SecurityModal';
import CodeProofField from './CodeProofField';
import ConfirmIdentityFields, {
  usesPassword,
  type ReauthResult,
} from './ConfirmIdentityFields';
import { useFactorChangeProof } from './useFactorChangeProof';

/**
 * "Turn off two-factor authentication?" (design state `disable`): identity + a current code or a recovery code →
 * `POST /auth/mfa/disable`. Only after the server's 204 is the page's status re-read and the dialog closed with a
 * success toast; the server ends the account's other sessions and leaves no secret or recovery code behind.
 */
export default function TurnOffDialog({
  status,
  reauthResult,
  onDisabled,
  onClose,
  returnFocus,
}: {
  status: MfaStatus;
  reauthResult?: ReauthResult;
  /** Re-reads the status; awaited before the dialog closes, so the card already shows the server's answer. */
  onDisabled: () => Promise<unknown> | void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const proof = useFactorChangeProof(
    status,
    'Couldn’t turn off two-factor authentication. Try again.',
  );
  const providers = onlyProviders(status.linkedProviders).map(
    (p) => PROVIDER_LABEL[p],
  );

  async function submit(): Promise<void> {
    const result = await proof.run(disableTwoFactor);
    if (!result.ok) return;
    await onDisabled();
    toast.success('Two-factor authentication is off.');
    onClose();
  }

  return (
    <SecurityModal
      titleId="acs-disable-title"
      descriptionId="acs-disable-desc"
      returnFocus={returnFocus}
      open
      icon="lock"
      title="Turn off two-factor authentication?"
      description={
        usesPassword(status)
          ? 'Your password will be the only step needed to sign in. You can turn 2FA on again at any time.'
          : `Signing in with ${providers.length ? providers.join(' or ') : 'your provider'} will be the only step needed. You can turn 2FA on again at any time.`
      }
      onClose={() => {
        if (!proof.busy) onClose();
      }}
      onSubmit={() => void submit()}
      footer={
        <>
          <button
            type="button"
            className="acs-btn acs-btn--secondary"
            disabled={proof.busy}
            onClick={onClose}
          >
            Keep 2FA on
          </button>
          <button
            type="submit"
            className="acs-btn acs-btn--danger"
            disabled={!proof.canSubmit}
          >
            {proof.busy ? 'Turning off…' : 'Turn off 2FA'}
          </button>
        </>
      }
    >
      <ConfirmIdentityFields
        status={status}
        intent="disable"
        password={proof.password}
        onPasswordChange={proof.setPassword}
        passwordError={proof.passwordError}
        needsReauth={proof.needsReauth}
        reauthResult={reauthResult}
        disabled={proof.busy}
      />
      <CodeProofField
        proof={proof.proof}
        onChange={proof.setProof}
        error={proof.codeError}
        errorId="acs-disable-code-error"
        disabled={proof.busy}
      />
      {proof.formError && (
        <Notice tone="error" live>
          {proof.formError}
        </Notice>
      )}
      <Notice tone="warning">
        Your existing authenticator and recovery codes will stop working.
      </Notice>
    </SecurityModal>
  );
}
