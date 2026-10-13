import PageHeader from '../../../shared/components/PageHeader';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';

interface Me {
  isPlatformAdmin: boolean;
  roles: string[];
}

const CRUMBS: Record<string, [string, string]> = {
  '/settings/profile': ['User', 'Profile'],
  '/settings/experience': ['User', 'Experience'],
  '/settings/account': ['User', 'Account'],
  '/settings/my-workspace': ['Workspace', 'General'],
  '/settings/my-workspace/domains': ['Workspace', 'Domains'],
  '/settings/workspace/roles': ['Workspace', 'Roles'],
  '/settings/workspace/team': ['Workspace', 'Team'],
  '/settings/admin': ['Other', 'Admin Panel'],
};

export default function SettingsLayout() {
  const location = useLocation();
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<Me>('/auth/me');
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
  // Mirrors `Layout.tsx`/`OnboardingGate` (App.tsx) — a platform admin with no operational org
  // role has no workspace to configure. Direct/bookmarked navigation into those sub-pages (not
  // just the nav links SettingsSidebar already hides) is caught here too, rather than relying on
  // each workspace settings page to handle "no workspace" gracefully on its own.
  const isPlatformAdminOnly = Boolean(me?.isPlatformAdmin) && (me?.roles.length ?? 0) === 0;

  const crumbKey = Object.keys(CRUMBS).find((k) => location.pathname === k || location.pathname.startsWith(`${k}/`));
  const crumb = crumbKey ? CRUMBS[crumbKey] : undefined;

  if (me && isPlatformAdminOnly && (location.pathname.startsWith('/settings/workspace') || location.pathname.startsWith('/settings/my-workspace'))) {
    return <Navigate to="/settings/admin" replace />;
  }

  return (
    <div className="page settings-frame">
      <PageHeader title="Settings" />
      <div className="settings-shell">
      <div className="settings-shell-content">
        {!location.pathname.includes('/profile') && !location.pathname.includes('/members') && !location.pathname.includes('/roles') && <div className="settings-page-heading"><h2>{crumb?.[1] ?? (location.pathname.endsWith('/security') ? 'Security' : 'Settings')}</h2><p>Manage your {crumb?.[0] === 'User' ? 'personal' : 'workspace'} preferences.</p></div>}
        <Outlet />
      </div>
      </div>
    </div>
  );
}
