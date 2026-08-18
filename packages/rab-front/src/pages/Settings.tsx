import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { api } from '../api';
import { getTheme, toggleTheme, type Theme } from '../lib/theme';

interface CurrentUser {
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
}

export default function Settings() {
  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<CurrentUser>('/auth/me');
      return data;
    },
  });
  const [theme, setTheme] = useState<Theme>(getTheme());

  return (
    <div className="page">
      <div className="settings-page">
        <div className="settings-section" id="account">
          <h3>Account</h3>
          <p>Your profile information.</p>
          <div className="settings-row"><span>Name</span><span style={{ color: 'var(--font-primary)', fontWeight: 500 }}>{user ? `${user.firstName} ${user.lastName}` : '–'}</span></div>
          <div className="settings-row"><span>Email</span><span style={{ color: 'var(--font-primary)' }}>{user?.email ?? '–'}</span></div>
          <div className="settings-row"><span>Roles</span><span>{user?.roles.length ? user.roles.map(r => <span key={r} className="badge badge-admin" style={{ marginRight: 4 }}>{r.replace(/_/g, ' ')}</span>) : '–'}</span></div>
        </div>

        <div className="settings-section" id="general">
          <h3>General</h3>
          <p>Appearance and workspace preferences.</p>
          <div className="settings-row">
            <span>Theme</span>
            <button className="btn btn-outline" onClick={() => setTheme(toggleTheme())}>
              {theme === 'light' ? <IconMoon size={14}/> : <IconSun size={14}/>}
              {theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            </button>
          </div>
          {/* TODO: import/export tooling — wire to backend endpoints when available */}
          <div className="settings-row"><span>Import data</span><span className="muted">Coming soon</span></div>
          <div className="settings-row"><span>Export view</span><span className="muted">Coming soon</span></div>
        </div>

        <div className="settings-section" id="roles">
          <h3>Roles &amp; Permissions</h3>
          <p>Access levels in rab.</p>
          <div className="settings-row"><span className="badge badge-admin">admin</span><span>Full access — users, payroll, venues, audit log</span></div>
          <div className="settings-row"><span className="badge badge-manager">manager</span><span>Manages own staff, placements and offers</span></div>
          <div className="settings-row"><span className="badge badge-staff">staff</span><span>Mobile app — receives and works offers</span></div>
        </div>
      </div>
    </div>
  );
}
