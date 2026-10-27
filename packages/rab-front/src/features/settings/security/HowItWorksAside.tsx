import {
  onlyProviders,
  PROVIDER_LABEL,
  type MfaStatus,
} from '../../auth/mfa/mfaApi';
import { AcsIcon } from '../../auth/mfa/ui/icons';

/** The design's "How it works" aside and footnote (static explanatory copy; the first step follows how the account signs in). */
export default function HowItWorksAside({ status }: { status?: MfaStatus }) {
  const sso = status?.hasPassword === false;
  const providers = onlyProviders(status?.linkedProviders).map(
    (p) => PROVIDER_LABEL[p],
  );
  return (
    <aside
      className="acs-stack acs-security-aside"
      aria-label="How two-factor authentication works"
    >
      <section className="acs-card acs-stack">
        <h3 className="acs-card-subtitle">How it works</h3>
        <div className="acs-aside-item">
          <AcsIcon name="lock" />
          <div>
            <strong className="acs-small">
              {sso
                ? `Sign in with ${providers.length ? providers.join(' or ') : 'your provider'}`
                : 'Sign in with your password'}
            </strong>
            <p className="acs-aside-text">
              {sso
                ? 'Keep signing in the way you do today.'
                : 'Keep using your usual email and password.'}
            </p>
          </div>
        </div>
        <div className="acs-aside-item">
          <AcsIcon name="phone" />
          <div>
            <strong className="acs-small">Enter a one-time code</strong>
            <p className="acs-aside-text">
              Your authenticator app generates a fresh 6-digit code.
            </p>
          </div>
        </div>
        <div className="acs-aside-item">
          <AcsIcon name="key" />
          <div>
            <strong className="acs-small">Keep a backup</strong>
            <p className="acs-aside-text">
              Recovery codes help you sign in if you lose your phone.
            </p>
          </div>
        </div>
      </section>
      <p className="acs-footnote">
        <AcsIcon name="shield" />
        Optional for every role. Required at each sign-in once enabled.
      </p>
    </aside>
  );
}
