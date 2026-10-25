import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { IconMail, IconLock, IconShieldCheck } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { hasReauthIntent } from '../security/reauthReturn';
import NotificationsCard from './NotificationsCard';

interface Me {
  isPlatformAdmin: boolean;
  email?: string;
}

export default function AccountPage() {
  const [searchParams] = useSearchParams();
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<Me>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });

  // A Microsoft re-authentication started on Settings → Security returns here (the server's fixed return path); hand it
  // back to the Security page, which resumes the dialog. Without that page's note, `?reauth=` is left alone.
  const reauth = searchParams.get('reauth');
  if ((reauth === 'ok' || reauth === 'failed') && hasReauthIntent()) {
    return <Navigate to={`/settings/security?reauth=${reauth}`} replace />;
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Account Authentication</h3>
        <p>How you sign in to rab.</p>
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconLock size={14} /> Email / Password
          </span>
          <span className="badge badge-active">Active</span>
        </div>
      </div>

      <div className="settings-section">
        <h3>Two-factor authentication</h3>
        <p>
          Two-factor authentication, your password and your current session are
          managed on the Security page.
        </p>
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconShieldCheck size={14} /> Account security
          </span>
          <Link to="/settings/security" className="btn btn-outline">
            Open Security settings
          </Link>
        </div>
      </div>

      <div className="settings-section">
        <h3>Emails</h3>
        <p>Email delivery preferences for your workspace.</p>
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconMail size={14} /> SMTP configuration
          </span>
          {me?.isPlatformAdmin ? (
            <Link to="/settings/admin" className="btn btn-outline">
              Configure in Admin Panel
            </Link>
          ) : (
            <span className="muted">
              Managed by your workspace administrator
            </span>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3>Notifications</h3>
        <p>Manage how and when you receive notifications.</p>
        <NotificationsCard />
      </div>
    </div>
  );
}
