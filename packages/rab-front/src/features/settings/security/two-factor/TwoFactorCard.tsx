import type { Ref } from 'react';

import { LOW_RECOVERY_CODES, type MfaStatus } from '../../../auth/mfa/mfaApi';
import { AcsIcon } from '../../../auth/mfa/ui/icons';
import { Emblem, Notice, StatusBadge } from '../../../auth/mfa/ui/primitives';

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatEnabledOn(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE.format(date);
}

function lowCodesMessage(remaining: number): string {
  if (remaining === 0)
    return 'You have no recovery codes left. Save a new set so you can still sign in if you lose access to your phone.';
  return `Only ${remaining} recovery ${remaining === 1 ? 'code' : 'codes'} left. Save a new set so you can still sign in if you lose access to your phone.`;
}

/**
 * The design's two-factor card (states off / on / low). Every value is the server's `GET /auth/mfa`: On/Off, "Enabled
 * on" (`enabledAt`, en-GB), "N of T remaining" (T only when the server sends `recoveryCodesTotal`), the low-codes
 * warning (≤ LOW_RECOVERY_CODES). Enforced accounts (dormant while enforcement is off) get no "Turn off"; a deployment
 * with enrolment disabled gets a disabled "Turn on 2FA" with the reason.
 */
export default function TwoFactorCard({
  status,
  onTurnOn,
  onRegenerate,
  onTurnOff,
  headingRef,
}: {
  status: MfaStatus;
  onTurnOn: () => void;
  onRegenerate: () => void;
  onTurnOff: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const on = status.enabled;
  const low = on && status.recoveryCodesRemaining <= LOW_RECOVERY_CODES;
  const enabledOn = formatEnabledOn(status.enabledAt);
  const total =
    status.recoveryCodesTotal && status.recoveryCodesTotal > 0
      ? status.recoveryCodesTotal
      : null;
  const description = on
    ? `Your account is protected. Enter a code from your authenticator app each time you sign in on web or mobile.${status.enforced ? ' Your organisation requires it for your account.' : ''}`
    : status.enforced
      ? 'Your organisation requires a code from an authenticator app for your account. Turn it on now, or you’ll be asked to set it up at your next sign-in.'
      : 'Add a code from an authenticator app when you sign in. It’s optional, and you can turn it off at any time.';

  return (
    <section
      className="acs-card acs-security-card acs-stack"
      aria-labelledby="acs-two-factor-title"
    >
      <div className="acs-row acs-row--between acs-card-head">
        <div className="acs-row acs-card-head-main">
          <Emblem />
          <div>
            <h2
              id="acs-two-factor-title"
              className="acs-card-title"
              ref={headingRef}
              tabIndex={-1}
            >
              Two-factor authentication
            </h2>
            <p className="acs-muted acs-small">
              An extra layer of protection for your account.
            </p>
          </div>
        </div>
        <StatusBadge on={on} />
      </div>
      <p className="acs-security-description">{description}</p>
      {low && (
        <Notice tone="warning">
          {lowCodesMessage(status.recoveryCodesRemaining)}
        </Notice>
      )}
      {on ? (
        <>
          <dl className="acs-details">
            <div className="acs-details-row">
              <dt className="acs-muted">Authenticator app</dt>
              <dd className="acs-row acs-row--tight">
                <AcsIcon name="check" className="acs-icon--sm" /> Connected
              </dd>
            </div>
            {enabledOn && (
              <div className="acs-details-row">
                <dt className="acs-muted">Enabled on</dt>
                <dd>{enabledOn}</dd>
              </div>
            )}
            <div className="acs-details-row">
              <dt className="acs-muted">Recovery codes</dt>
              <dd>
                <strong>
                  {total
                    ? `${status.recoveryCodesRemaining} of ${total}`
                    : status.recoveryCodesRemaining}
                </strong>{' '}
                remaining
              </dd>
            </div>
          </dl>
          <div className="acs-card-footer">
            <button
              type="button"
              className="acs-btn acs-btn--secondary"
              onClick={onRegenerate}
            >
              Get new recovery codes
            </button>
            {!status.enforced && (
              <button type="button" className="acs-link" onClick={onTurnOff}>
                Turn off two-factor authentication
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="acs-divider" />
          <div className="acs-card-footer">
            <span className="acs-muted acs-small">
              Works with your preferred authenticator app.
            </span>
            <button
              type="button"
              className="acs-btn acs-btn--primary"
              onClick={onTurnOn}
              disabled={!status.enrolmentAvailable}
              aria-describedby={
                status.enrolmentAvailable ? undefined : 'acs-enrol-unavailable'
              }
            >
              Turn on 2FA
            </button>
          </div>
          {!status.enrolmentAvailable && (
            <p id="acs-enrol-unavailable" className="acs-muted acs-small">
              Two-factor setup isn’t available right now. Try again later.
            </p>
          )}
        </>
      )}
    </section>
  );
}
