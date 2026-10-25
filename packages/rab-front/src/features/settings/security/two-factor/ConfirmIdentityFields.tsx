import { useState } from 'react';
import { IconBrandWindows } from '@tabler/icons-react';

import {
  onlyProviders,
  PROVIDER_LABEL,
  type MfaStatus,
} from '../../../auth/mfa/mfaApi';
import { Notice, PasswordField } from '../../../auth/mfa/ui/primitives';
import { startProviderReauth, type ReauthIntent } from '../reauthReturn';

export type ReauthResult = 'ok' | 'failed' | undefined;

/** Whether the account proves itself with a password (absent on an older server → yes; the server decides anyway). */
export function usesPassword(status: Pick<MfaStatus, 'hasPassword'>): boolean {
  return status.hasPassword !== false;
}

function providerNames(status: MfaStatus): string {
  const names = onlyProviders(status.linkedProviders).map(
    (p) => PROVIDER_LABEL[p],
  );
  return names.length ? names.join(' or ') : 'your sign-in provider';
}

/**
 * "Confirm it's you" for the Security dialogs (UI_PLAN §7 #18), following the server's actual answers:
 *  - a password account types its current password (sent inline; a wrong one is shown under the field);
 *  - an account with NO password: when the server lists Microsoft in `ssoReauthProviders`, "Continue with Microsoft"
 *    (a forced fresh Microsoft sign-in, back to this dialog); otherwise (Google-only — Google re-auth is refused, TO-3)
 *    the server accepts the account's own recent sign-in for a few minutes (TO-2), and once that has passed the user is
 *    told to sign out and back in. The dialog's Continue simply asks; the server says yes or `STEP_UP_REQUIRED`.
 */
export default function ConfirmIdentityFields({
  status,
  intent,
  password,
  onPasswordChange,
  passwordError,
  needsReauth,
  reauthResult,
  disabled,
  autoFocus = true,
}: {
  status: MfaStatus;
  intent: ReauthIntent;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordError?: string;
  /** The server answered STEP_UP_REQUIRED for an account without a password. */
  needsReauth: boolean;
  reauthResult: ReauthResult;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  // The page leaves for Microsoft with a full-page form POST; a second click must not post a second re-authentication.
  const [leaving, setLeaving] = useState(false);
  if (usesPassword(status)) {
    return (
      <PasswordField
        value={password}
        onChange={onPasswordChange}
        error={passwordError}
        autoFocus={autoFocus}
        disabled={disabled}
      />
    );
  }
  const canMicrosoft = onlyProviders(status.ssoReauthProviders).includes(
    'microsoft',
  );
  const names = providerNames(status);
  return (
    <>
      {reauthResult === 'ok' && (
        <Notice tone="success" live>
          Confirmed with Microsoft. Continue to finish.
        </Notice>
      )}
      {reauthResult === 'failed' && (
        <Notice tone="error" live>
          We couldn’t confirm it’s you with Microsoft. Try again.
        </Notice>
      )}
      {reauthResult !== 'ok' && (
        <Notice>
          {canMicrosoft
            ? `Your account signs in with ${names}, so there’s no password to enter. Confirm with Microsoft to continue.`
            : `Your account signs in with ${names}, so there’s no password to enter. If you signed in a few minutes ago, you can continue now.`}
        </Notice>
      )}
      {needsReauth && reauthResult !== 'ok' && (
        // The dialog's one announcement for STEP_UP_REQUIRED (no toast): urgent, so it is read when it appears.
        <Notice tone="warning" live urgent>
          {canMicrosoft
            ? 'Confirm with Microsoft first, then continue.'
            : `For your security, sign out and sign back in with ${names}, then try again straight away.`}
        </Notice>
      )}
      {canMicrosoft && reauthResult !== 'ok' && (
        <button
          type="button"
          className="acs-btn acs-btn--secondary acs-btn--full"
          disabled={disabled || leaving}
          aria-busy={leaving || undefined}
          onClick={() => {
            if (leaving) return;
            if (startProviderReauth('microsoft', intent)) setLeaving(true);
          }}
        >
          <IconBrandWindows size={18} aria-hidden="true" />{' '}
          {leaving ? 'Opening Microsoft…' : 'Continue with Microsoft'}
        </button>
      )}
    </>
  );
}
