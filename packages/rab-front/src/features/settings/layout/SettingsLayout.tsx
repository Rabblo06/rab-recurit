import { Suspense } from 'react';
import './settings-refined.css';
import PageHeader from '../../../shared/components/PageHeader';
import { DelayedFallback, SettingsPageSkeleton } from '../../../shared/components/RouteFallback';
import { settingsContentKey } from './settingsContentKey';
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
  '/settings/account': ['User', 'Accounts'],
  '/settings/account/emails': ['Accounts', 'Emails'],
  '/settings/account/calendar': ['Accounts', 'Calendar'],
  '/settings/account/new': ['Accounts', 'New account'],
  '/settings/security': ['User', 'Profile'],
  '/settings/my-workspace': ['Workspace', 'General'],
  '/settings/my-workspace/domains': ['Workspace / General', 'Subdomain'],
  '/settings/workspace/roles': ['Workspace', 'Roles'],
  '/settings/workspace/team': ['Workspace', 'Team'],
  '/settings/ai': ['Workspace', 'AI'],
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

  const crumbKey = Object.keys(CRUMBS).sort((a,b)=>b.length-a.length).find((k) => location.pathname === k || location.pathname.startsWith(`${k}/`));
  const crumb = crumbKey ? CRUMBS[crumbKey] : undefined;

  // Members' compact leadership form needs no personal workspace. Explicit capability is required;
  // this exception does not expose General, Domains or the workspace role editor to a platform-only user.
  if (leadership.isLoading) return null;
  if (me && isPlatformAdminOnly && !(isMembersPage && leadership.canAdd) && (location.pathname.startsWith('/settings/workspace') || location.pathname.startsWith('/settings/my-workspace'))) {
    return <Navigate to="/settings/admin" replace />;
  }

  return (
    <div className="page settings-frame settings-refined">
      {/* Members supplies its own page title; role details supply the global breadcrumb plus their Save/Cancel row. */}
      {!location.pathname.includes('/members') && !location.pathname.startsWith('/settings/admin') ? <header className="settings-reference-header"><div className="settings-reference-crumb">{crumb?.[0] ?? 'Settings'} <span>/</span> <strong>{crumb?.[1] ?? 'Settings'}</strong></div><h1>{crumb?.[1] ?? 'Settings'}</h1><div data-settings-actions /></header> : !location.pathname.includes('/members') && <PageHeader title="Settings" />}
      <div className="settings-shell">
      <div className="settings-shell-content">
        <Suspense key={settingsContentKey(location.pathname)} fallback={<DelayedFallback><SettingsPageSkeleton /></DelayedFallback>}>
          <Outlet />
        </Suspense>
      </div>
      </div>
    </div>
  );
}
