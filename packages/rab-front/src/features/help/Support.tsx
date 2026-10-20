import { Link } from 'react-router-dom';
import { IconBook2, IconHeadset, IconMail, IconExternalLink } from '@tabler/icons-react';
import PageHeader from '../../shared/components/PageHeader';
import { supportChannels } from './support-channels';
import './help.css';

/** Support: the configured official channel (see support-channels.ts), or an honest "not set up" state. */
export default function Support() {
  const { email, url } = supportChannels(import.meta.env as { VITE_SUPPORT_EMAIL?: string; VITE_SUPPORT_URL?: string });
  const configured = Boolean(email || url);
  return (
    <div className="page help-page">
      <PageHeader title="Support" />
      <div className="page-scroll help-scroll">
        <div className="help-intro">
          <h2>Get support</h2>
          <p>Most questions are answered in the <Link to="/help">Help Center</Link>.</p>
        </div>
        <div className="help-grid">
          <article className="help-card">
            <IconBook2 size={20} stroke={1.5} aria-hidden="true" className="help-card-icon" />
            <h4>Help Center</h4>
            <p>Guides for people, shifts and offers, attendance, timesheets and your account.</p>
            <Link className="help-link" to="/help">Browse help</Link>
          </article>
          <article className="help-card" aria-live="polite">
            <IconHeadset size={20} stroke={1.5} aria-hidden="true" className="help-card-icon" />
            <h4>Contact support</h4>
            {configured ? (
              <>
                <p>Contact the Crewflow support team. Describe what you were doing; never send passwords or sign-in links.</p>
                <div className="help-actions">
                  {email && <a className="btn btn-dark" href={`mailto:${email}`}><IconMail size={14} aria-hidden="true" /> Email {email}</a>}
                  {url && <a className="btn btn-outline" href={url} target="_blank" rel="noopener noreferrer">Open support site <IconExternalLink size={13} aria-hidden="true" /></a>}
                </div>
              </>
            ) : (
              <p className="help-unavailable" role="status">
                A support contact has not been set up for this workspace yet. Please contact your Crewflow administrator.
              </p>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
