import PageHeader from '../../../shared/components/PageHeader';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { useLeadershipCapabilities } from '../members/leadershipCapabilities';

interface Me {
  isPlatformAdmin: boolean;
  roles: string[];
}

const CRUMBS: Record<string, [string, string]> = {
  '/settings/profile': ['User', 'Profile'],
  '/settings/experience': ['User', 'Experience'],
  '/settings/account': ['User', 'Account'],
  '/settings/security': ['User', 'Security'],
  '/settings/my-workspace': ['Workspace', 'General'],
  '/settings/my-workspace/domains': ['Workspace', 'Domains'],
  '/settings/workspace/roles': ['Workspace', 'Roles'],
  '/settings/workspace/team': ['Workspace', 'Team'],
  '/settings/admin': ['Other', 'Admin panel'],
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
  const isMembersPage = location.pathname === '/settings/workspace/members';
  const leadership = useLeadershipCapabilities(isPlatformAdminOnly && isMembersPage);

  const crumbKey = Object.keys(CRUMBS).find((k) => location.pathname === k || location.pathname.startsWith(`${k}/`));
  const crumb = crumbKey ? CRUMBS[crumbKey] : undefined;

  // Members' compact leadership form needs no personal workspace. Explicit capability is required;
  // this exception does not expose General, Domains or the workspace role editor to a platform-only user.
  if (leadership.isLoading) return null;
  if (me && isPlatformAdminOnly && !(isMembersPage && leadership.canAdd) && (location.pathname.startsWith('/settings/workspace') || location.pathname.startsWith('/settings/my-workspace'))) {
    return <Navigate to="/settings/admin" replace />;
  }

  return (
    <div className="page settings-frame">
      {/* Members supplies its own page title; role details supply the global breadcrumb plus their Save/Cancel row. */}
      {!/\/members(?:\/|$)/.test(location.pathname) && <PageHeader title="Settings" />}
      <div className="settings-shell">
      <div className="settings-shell-content">
        {/* The Admin panel draws its own page header ("Admin panel", mockup v2), so the generic heading is skipped there. */}
        {!location.pathname.includes('/profile') && !location.pathname.includes('/members') && !location.pathname.includes('/roles') && !location.pathname.startsWith('/settings/admin') && <div className="settings-page-heading"><h2>{crumb?.[1] ?? (location.pathname.endsWith('/security') ? 'Security' : 'Settings')}</h2><p>{location.pathname === '/settings/security' ? 'Manage how you sign in and keep your account secure.' : `Manage your ${crumb?.[0] === 'User' ? 'personal' : 'workspace'} preferences.`}</p></div>}
        <Outlet />
      </div>
      </div>
    </div>
  );
}
