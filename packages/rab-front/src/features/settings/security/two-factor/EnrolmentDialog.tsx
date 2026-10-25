import { useRef, useState } from 'react';

import { toast } from '../../../../shared/lib/toast';
import {
  confirmSettingsEnrolment,
  mfaErrorCode,
  mfaErrorMessage,
  proofFailureOf,
  startSettingsEnrolment,
  type EnrolmentMaterial,
  type MfaStatus,
} from '../../../auth/mfa/mfaApi';
import OtpInput, { OTP_LENGTH } from '../../../auth/mfa/ui/OtpInput';
import { Notice } from '../../../auth/mfa/ui/primitives';
import RecoveryCodesPanel from '../../../auth/mfa/ui/RecoveryCodesPanel';
import ScanBlock from '../../../auth/mfa/ui/ScanBlock';
import SecurityModal from '../../../auth/mfa/ui/SecurityModal';
import StepIndicator from '../../../auth/mfa/ui/StepIndicator';
import ConfirmIdentityFields, {
  usesPassword,
  type ReauthResult,
} from './ConfirmIdentityFields';
import { reportExpiredSession } from './useFactorChangeProof';

type Step =
  | { kind: 'identity' }
  | { kind: 'scan'; material: EnrolmentMaterial }
  | { kind: 'codes'; codes: string[] };

const WRONG_PASSWORD = 'That password didn’t work. Check it and try again.';

/**
 * Turn on 2FA (design states "01 Confirm password", "02 Connect authenticator", "03 Save recovery codes"):
 *  1. identity proof → `POST /auth/mfa/enrolment` (the server stages a secret and answers the QR + key);
 *  2. the first code → `POST /auth/mfa/enrolment/confirm` (2FA is on only now; the server answers ten recovery codes);
 *  3. the codes, shown once; Done stays disabled until the user confirms they saved them, and this step can't be closed
 *     with Escape or the (hidden) close button. Success is announced only after step 2's server answer.
 */
export default function EnrolmentDialog({
  status,
  email,
  reauthResult,
  onEnabled,
  onClose,
  returnFocus,
}: {
  status: MfaStatus;
  email?: string;
  reauthResult?: ReauthResult;
  /** Called once the server has confirmed the factor (refreshes the page's status). */
  onEnabled: () => Promise<unknown> | void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [step, setStep] = useState<Step>({ kind: 'identity' });
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [needsReauth, setNeedsReauth] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Synchronous twin of `busy` (which re-renders a tick late): one request at a time, however fast the clicks. */
  const inFlight = useRef(false);
  const [saved, setSaved] = useState(false);
  const withPassword = usesPassword(status);
  const closeIfIdle = () => {
    if (!busy) onClose();
  };

  function release(): void {
    inFlight.current = false;
    setBusy(false);
  }

  // Every failure is shown ONCE, inside the dialog (under its field or as the dialog's alert); no toast on top of it.
  // Only an expired session gets the persistent "Sign in again" toast instead.
  async function start(): Promise<void> {
    if (inFlight.current || (withPassword && !password)) return;
    inFlight.current = true;
    setBusy(true);
    setPasswordError(undefined);
    setFormError(undefined);
    try {
      const material = await startSettingsEnrolment({
        currentPassword: withPassword ? password : undefined,
      });
      setCode('');
      setCodeError(undefined);
      setStep({ kind: 'scan', material });
    } catch (err) {
      const failure = proofFailureOf(err);
      const fallback = 'Couldn’t start the setup. Try again.';
      if (failure.kind === 'wrong-password') setPasswordError(WRONG_PASSWORD);
      else if (failure.kind === 'needs-reauth') setNeedsReauth(true);
      else if (failure.kind === 'bad-code') setFormError(failure.message);
      else if (!reportExpiredSession(err, fallback))
        setFormError(mfaErrorMessage(err, fallback));
    } finally {
      release();
    }
  }

  async function confirm(): Promise<void> {
    if (inFlight.current || code.length < OTP_LENGTH) return;
    inFlight.current = true;
    setBusy(true);
    setCodeError(undefined);
    setFormError(undefined);
    try {
      const { recoveryCodes } = await confirmSettingsEnrolment(code);
      setCode('');
      setSaved(false);
      setStep({ kind: 'codes', codes: recoveryCodes });
      toast.success('Two-factor authentication is on.');
      void onEnabled();
    } catch (err) {
      const fallback = 'Couldn’t turn on two-factor authentication. Try again.';
      const message = mfaErrorMessage(err, fallback);
      if (
        mfaErrorCode(err) === 'MFA_CODE_INVALID' ||
        mfaErrorCode(err) === 'MFA_RATE_LIMITED'
      ) {
        setCodeError(
          mfaErrorCode(err) === 'MFA_CODE_INVALID'
            ? 'That code didn’t work. Check your app and try again.'
            : message,
        );
      } else if (!reportExpiredSession(err, fallback)) {
        setFormError(message);
      }
    } finally {
      release();
    }
  }

  const common = {
    titleId: 'acs-enrol-title',
    descriptionId: 'acs-enrol-desc',
    returnFocus,
  } as const;
  const formNotice = formError && (
    <Notice tone="error" live>
      {formError}
    </Notice>
  );

  if (step.kind === 'codes') {
    return (
      <SecurityModal
        {...common}
        open
        icon="key"
        title="Save your recovery codes"
        description="Each code can be used once if you lose access to your authenticator. You won’t see these codes again."
        footer={
          <button
            type="button"
            className="acs-btn acs-btn--primary"
            disabled={!saved}
            onClick={onClose}
            aria-describedby={saved ? undefined : 'acs-done-reason'}
          >
            Done
          </button>
        }
      >
        <StepIndicator current={3} />
        <RecoveryCodesPanel
          codes={step.codes}
          accountLabel={email}
          acknowledged={saved}
          onAcknowledgedChange={setSaved}
        />
        {!saved && (
          <span id="acs-done-reason" className="acs-visually-hidden">
            Confirm you’ve saved your recovery codes to finish.
          </span>
        )}
      </SecurityModal>
    );
  }

  if (step.kind === 'scan') {
    return (
      <SecurityModal
        {...common}
        open
        title="Connect your authenticator"
        description="Scan the QR code with your authenticator app, then enter the 6-digit code."
        onClose={closeIfIdle}
        onSubmit={() => void confirm()}
        footer={
          <>
            <button
              type="button"
              className="acs-btn acs-btn--secondary"
              disabled={busy}
              onClick={() => {
                setStep({ kind: 'identity' });
                setCodeError(undefined);
                setFormError(undefined);
              }}
            >
              Back
            </button>
            <button
              type="submit"
              className="acs-btn acs-btn--primary"
              disabled={busy || code.length < OTP_LENGTH}
              aria-busy={busy || undefined}
            >
              {busy ? 'Checking…' : 'Confirm code'}
            </button>
          </>
        }
      >
        <StepIndicator current={2} />
        <ScanBlock material={step.material} />
        <OtpInput
          value={code}
          onChange={(v) => {
            setCode(v);
            setCodeError(undefined);
          }}
          invalid={Boolean(codeError)}
          describedBy={codeError ? 'acs-enrol-code-error' : undefined}
          disabled={busy}
          autoFocus
        />
        {codeError && (
          <Notice tone="error" live id="acs-enrol-code-error">
            {codeError}
          </Notice>
        )}
        {formNotice}
      </SecurityModal>
    );
  }

  return (
    <SecurityModal
      {...common}
      open
      title="Confirm it’s you"
      description={
        withPassword
          ? 'Enter your current password before setting up two-factor authentication.'
          : 'Confirm your identity before setting up two-factor authentication.'
      }
      onClose={closeIfIdle}
      onSubmit={() => void start()}
      footer={
        <>
          <button
            type="button"
            className="acs-btn acs-btn--secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="acs-btn acs-btn--primary"
            disabled={busy || (withPassword && !password)}
            aria-busy={busy || undefined}
          >
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </>
      }
    >
      <StepIndicator current={1} />
      <ConfirmIdentityFields
        status={status}
        intent="enrol"
        password={password}
        onPasswordChange={(v) => {
          setPassword(v);
          setPasswordError(undefined);
        }}
        passwordError={passwordError}
        needsReauth={needsReauth}
        reauthResult={reauthResult}
        disabled={busy}
      />
      {formNotice}
      <Notice>
        Your authenticator app will be used at every sign-in, on web and mobile.
      </Notice>
    </SecurityModal>
  );
}
