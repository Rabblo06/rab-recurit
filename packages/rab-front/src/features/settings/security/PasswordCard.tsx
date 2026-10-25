import { Link } from 'react-router-dom';

/**
 * The design's Password card. There is no change-password route and no "password changed" timestamp (UI_PLAN §2, §7
 * #4–5), so "Change password" is "Reset password", which opens the existing email reset flow with the email filled in,
 * and the "Last updated" row is left out. Only shown to accounts that have a password.
 */
export default function PasswordCard({ email }: { email?: string }) {
  return (
    <section className="acs-card" aria-labelledby="acs-password-title">
      <div className="acs-row acs-row--between acs-card-head">
        <div>
          <h3 id="acs-password-title" className="acs-card-subtitle">
            Password
          </h3>
          <p className="acs-muted acs-small">
            Use a unique password to keep your account secure.
          </p>
        </div>
        <Link
          className="acs-btn acs-btn--secondary"
          to={
            email
              ? `/forgot-password?email=${encodeURIComponent(email)}`
              : '/forgot-password'
          }
        >
          Reset password
        </Link>
      </div>
    </section>
  );
}
