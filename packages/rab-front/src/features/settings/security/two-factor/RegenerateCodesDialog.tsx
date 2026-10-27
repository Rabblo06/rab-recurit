import { useState } from 'react';

import { toast } from '../../../../shared/lib/toast';
import {
  regenerateRecoveryCodes,
  type MfaStatus,
} from '../../../auth/mfa/mfaApi';
import { Notice } from '../../../auth/mfa/ui/primitives';
import RecoveryCodesPanel from '../../../auth/mfa/ui/RecoveryCodesPanel';
import SecurityModal from '../../../auth/mfa/ui/SecurityModal';
import CodeProofField from './CodeProofField';
import ConfirmIdentityFields, {
  type ReauthResult,
} from './ConfirmIdentityFields';
import { useFactorChangeProof } from './useFactorChangeProof';

/**
 * "Get new recovery codes" (design state `regenerate`): identity + a current code → `POST /auth/mfa/recovery-codes`. The
 * server replaces the whole set (every previous code stops working) and answers the new codes, shown once with the same
 * acknowledgement gate as setup. The page's count is refreshed from the server only after it confirmed.
 */
export default function RegenerateCodesDialog({
  status,
  email,
  reauthResult,
  onRegenerated,
  onClose,
  returnFocus,
}: {
  status: MfaStatus;
  email?: string;
  reauthResult?: ReauthResult;
  onRegenerated: () => Promise<unknown> | void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const proof = useFactorChangeProof(
    status,
    'Couldn’t create new recovery codes. Try again.',
  );
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const common = {
    titleId: 'acs-regenerate-title',
    descriptionId: 'acs-regenerate-desc',
    returnFocus,
  } as const;

  async function submit(): Promise<void> {
    const result = await proof.run(regenerateRecoveryCodes);
    if (!result.ok) return;
    setSaved(false);
    setCodes(result.value);
    toast.success(
      'New recovery codes created. Your previous codes no longer work.',
    );
    void onRegenerated();
  }

  if (codes) {
    return (
      <SecurityModal
        {...common}
        open
        icon="key"
        title="Save your new recovery codes"
        description="Each code can be used once if you lose access to your authenticator. You won’t see these codes again."
        footer={
          <button
            type="button"
            className="acs-btn acs-btn--primary"
            disabled={!saved}
            onClick={onClose}
          >
            Done
          </button>
        }
      >
        <RecoveryCodesPanel
          codes={codes}
          accountLabel={email}
          acknowledged={saved}
          onAcknowledgedChange={setSaved}
        />
      </SecurityModal>
    );
  }

  return (
    <SecurityModal
      {...common}
      open
      icon="key"
      title="Get new recovery codes"
      description="Confirm your identity to replace your current recovery codes."
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
            Cancel
          </button>
          <button
            type="submit"
            className="acs-btn acs-btn--primary"
            disabled={!proof.canSubmit}
            aria-busy={proof.busy || undefined}
          >
            {proof.busy ? 'Generating…' : 'Generate new codes'}
          </button>
        </>
      }
    >
      <ConfirmIdentityFields
        status={status}
        intent="regenerate"
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
        errorId="acs-regenerate-code-error"
        disabled={proof.busy}
      />
      {proof.formError && (
        <Notice tone="error" live>
          {proof.formError}
        </Notice>
      )}
      <Notice tone="warning">
        All previous recovery codes will stop working. Save the new set before
        closing this window.
      </Notice>
    </SecurityModal>
  );
}
