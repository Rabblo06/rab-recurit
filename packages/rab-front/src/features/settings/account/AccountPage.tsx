import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  IconMail,
  IconCalendar,
  IconChevronRight,
  IconDeviceFloppy,
} from '@tabler/icons-react';
import { hasReauthIntent } from '../security/reauthReturn';
import SettingsHeaderActions from '../layout/SettingsHeaderActions';
import NotificationsCard from './NotificationsCard';

const unavailable =
  'Preview only — personal mailbox and calendar connections are not available in Crewflow yet.';
function PreviewNotice() {
  return (
    <p className="settings-preview-notice" role="note">
      {unavailable}
    </p>
  );
}
function PreviewSave() {
  return (
    <SettingsHeaderActions>
      <Link className="btn btn-outline" to="/settings/account">
        Cancel
      </Link>
      <button
        className="btn btn-dark"
        disabled
        title="This preview cannot be saved"
      >
        <IconDeviceFloppy size={14} /> Save
      </button>
    </SettingsHeaderActions>
  );
}
function Providers() {
  return (
    <div className="settings-provider-list">
      {['Google', 'Microsoft 365'].map((name, i) => (
        <button
          type="button"
          className="settings-provider-row"
          key={name}
          disabled
        >
          <span className={`provider-symbol provider-${i}`} aria-hidden="true">
            {i === 0 ? 'G' : i === 1 ? '▦' : '@'}
          </span>
          <span>Connect with {name}</span>
          <IconChevronRight size={16} />
        </button>
      ))}
      <Link className="settings-provider-row" to="/settings/account/new" style={{ textDecoration: 'none' }}><span className="provider-symbol" aria-hidden="true">@</span><span>Connect with SMTP</span><IconChevronRight size={16} /></Link>
    </div>
  );
}
function ChoicePreview({
  title,
  description,
  options,
}: {
  title: string;
  description: string;
  options: string[];
}) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <p>{description}</p>
      <fieldset className="settings-choice-list" disabled>
        <legend className="visually-hidden">{title}</legend>
        {options.map((option) => (
          <label key={option}>
            <IconMail size={22} />
            <span>{option}</span>
            <input type="radio" name={title} />
          </label>
        ))}
      </fieldset>
    </section>
  );
}
export default function AccountPage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const reauth = params.get('reauth');
  if ((reauth === 'ok' || reauth === 'failed') && hasReauthIntent())
    return <Navigate to={`/settings/profile?reauth=${reauth}`} replace />;
  const view = location.pathname.split('/')[3];
  if (view === 'new')
    return (
      <div className="settings-page">
        <PreviewSave />
        <PreviewNotice />
        <section className="settings-section">
          <h3>New account</h3>
          <Providers />
        </section>
        <section className="settings-section">
          <h3>Mail account</h3>
          <p>
            Connection settings preview. No credentials can be entered or saved.
          </p>
          <div className="field">
            <label>Email address</label>
            <input disabled placeholder="name@example.com" />
          </div>
        </section>
        {['IMAP', 'SMTP', 'CalDAV'].map((protocol) => (
          <section className="settings-section" key={protocol}>
            <h3>{protocol} configuration</h3>
            <fieldset className="settings-preview-fields" disabled>
              <div className="field">
                <label>{protocol} server</label>
                <input placeholder={`${protocol.toLowerCase()}.example.com`} />
              </div>
              <div className="field">
                <label>{protocol} password</label>
                <input type="password" placeholder="Not available" />
              </div>
              {protocol !== 'CalDAV' && (
                <div className="form-grid">
                  <div className="field">
                    <label>{protocol} port</label>
                    <input placeholder={protocol === 'IMAP' ? '993' : '587'} />
                  </div>
                  <div className="field">
                    <label>Encryption</label>
                    <select defaultValue="tls">
                      <option value="tls">SSL / TLS</option>
                    </select>
                  </div>
                </div>
              )}
            </fieldset>
          </section>
        ))}
      </div>
    );
  if (view === 'emails' || view === 'calendar')
    return (
      <div className="settings-page">
        <PreviewSave />
        <PreviewNotice />
        <ChoicePreview
          title={view === 'emails' ? 'Visibility' : 'Event visibility'}
          description="Choose what would be shared with your workspace."
          options={
            view === 'emails'
              ? ['Everything', 'Subject and metadata', 'Metadata']
              : ['Everything', 'Metadata']
          }
        />
        <ChoicePreview
          title="Contact auto-creation"
          description="Automatic contact creation is not supported in Crewflow."
          options={
            view === 'emails'
              ? ['Sent and received', 'Sent', 'None']
              : ['Auto-creation']
          }
        />
      </div>
    );
  return (
    <div className="settings-page account-settings">
      {/* Kept from main: notification preferences (GET/PATCH /profile/notification-preferences). */}
      <section className="settings-section">
        <h3>Notifications</h3>
        <p>Manage how and when you receive notifications.</p>
        <NotificationsCard />
      </section>
      <section className="settings-section">
        <h3>Connected accounts</h3>
        <p>Manage your email and calendar accounts.</p>
        <PreviewNotice />
        <Providers />
      </section>
      <section className="settings-section">
        <h3>Blocklist</h3>
        <p>Email sync exclusions are not currently available.</p>
        <input
          className="settings-preview-search"
          placeholder="Search email or domain…"
          disabled
        />
        <div className="settings-empty-row">No email sync connections</div>
      </section>
      <section className="settings-section">
        <h3>Settings</h3>
        <p>Email and calendar preferences.</p>
        <div className="settings-link-grid">
          <Link to="/settings/account/emails">
            <IconMail size={18} />
            <span>
              Emails<small>Visibility and contact preferences</small>
            </span>
            <IconChevronRight size={15} />
          </Link>
          <Link to="/settings/account/calendar">
            <IconCalendar size={18} />
            <span>
              Calendar<small>Event visibility preferences</small>
            </span>
            <IconChevronRight size={15} />
          </Link>
        </div>
      </section>
    </div>
  );
}
