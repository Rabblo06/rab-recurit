import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import SettingsSidebar from './SettingsSidebar';
import LogoutDialog from '../LogoutDialog';

interface Me {
  isPlatformAdmin: boolean;
}

const CRUMBS: Record<string, [string, string]> = {
  '/settings/profile': ['User', 'Profile'],
  '/settings/experience': ['User', 'Experience'],
  '/settings/account': ['User', 'Account'],
  '/settings/workspace': ['Workspace', 'General'],
  '/settings/workspace/domains': ['Workspace', 'Domains'],
  '/settings/workspace/roles': ['Workspace', 'Roles'],
  '/settings/admin': ['Other', 'Admin Panel'],
};

export default function SettingsLayout() {
  const location = useLocation();
  const [showLogout, setShowLogout] = useState(false);
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<Me>('/auth/me');
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const crumbKey = Object.keys(CRUMBS).find((k) => location.pathname === k || location.pathname.startsWith(`${k}/`));
  const crumb = crumbKey ? CRUMBS[crumbKey] : undefined;

  return (
    <div className="settings-shell">
      <SettingsSidebar isPlatformAdmin={Boolean(me?.isPlatformAdmin)} onLogoutClick={() => setShowLogout(true)} />
      <div className="settings-shell-content">
        {crumb && (
          <p className="settings-crumb">
            {crumb[0]} / <strong>{crumb[1]}</strong>
          </p>
        )}
        <Outlet />
      </div>
      <LogoutDialog open={showLogout} onClose={() => setShowLogout(false)} />
    </div>
  );
}
