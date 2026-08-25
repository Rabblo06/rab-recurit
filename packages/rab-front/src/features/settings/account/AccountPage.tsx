import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconMail, IconLock } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import NotificationsCard from './NotificationsCard';

interface Me {
  isPlatformAdmin: boolean;
}

export default function AccountPage() {
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<Me>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Account Authentication</h3>
        <p>How you sign in to rab.</p>
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconLock size={14} /> Email / Password</span>
          <span className="badge badge-active">Active</span>
        </div>
      </div>

      <div className="settings-section">
        <h3>Emails</h3>
        <p>Email delivery preferences for your workspace.</p>
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconMail size={14} /> SMTP configuration</span>
          {me?.isPlatformAdmin ? (
            <Link to="/settings/admin" className="btn btn-outline">Configure in Admin Panel</Link>
          ) : (
            <span className="muted">Managed by your workspace administrator</span>
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
