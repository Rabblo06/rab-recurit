import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api } from './shared/api';
import { useMyWorkspace } from './shared/hooks/useMyWorkspace';
import Login from './features/auth/Login';
import ForgotPassword from './features/auth/ForgotPassword';
import ResetPassword from './features/auth/ResetPassword';
import SetPassword from './features/auth/SetPassword';
import CreateWorkspaceScreen from './features/onboarding/CreateWorkspaceScreen';
import CreateProfileScreen from './features/onboarding/CreateProfileScreen';
import Layout from './shell/Layout';
import Dashboard from './features/dashboard/Dashboard';
import Users from './features/users/Users';
import Shifts from './features/scheduling/Shifts';
import Offers from './features/offers/Offers';
import Calendar from './features/scheduling/Calendar';
import Payroll from './features/payroll/Payroll';
import Venues from './features/venues/Venues';
import AuditLog from './features/audit/AuditLog';
import UserProfile from './features/users/UserProfile';
import SettingsLayout from './features/settings/layout/SettingsLayout';
import PlatformAdminRoute from './features/settings/PlatformAdminRoute';
import ProfilePage from './features/settings/profile/ProfilePage';
import ExperiencePage from './features/settings/experience/ExperiencePage';
import AccountPage from './features/settings/account/AccountPage';
import WorkspaceGeneralPage from './features/settings/workspace/WorkspaceGeneralPage';
import WorkspaceDomainsPage from './features/settings/domains/WorkspaceDomainsPage';
import MyWorkspaceGeneralPage from './features/settings/myworkspace/MyWorkspaceGeneralPage';
import MyWorkspaceDomainsPage from './features/settings/myworkspace/MyWorkspaceDomainsPage';
import WorkspaceRolesPage from './features/settings/roles/WorkspaceRolesPage';
import AdminPanelPage from './features/settings/admin-panel/AdminPanelPage';
import AppErrorBoundary from './shared/components/AppErrorBoundary';
import NotFound from './features/errors/NotFound';

const qc = new QueryClient();

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('accessToken');
  return token ? children : <Navigate to="/login" replace />;
}

const MANAGER_SHAPED_ROLES = new Set(['manager', 'venue_manager', 'ceo']);

/**
 * First-login redirect. Only Manager-shaped accounts (internal/venue/ceo)
 * are ever routed into onboarding — Staff and pure-platform-admin accounts
 * are unaffected, matching `ManagerWorkspaceService`'s own gate
 * (`ownManagerProfile`, 404 for anyone without a `ManagerProfile`). While
 * either query is still loading, render nothing rather than guess — a
 * flashed wrong redirect is worse than a brief blank frame.
 */
function OnboardingGate({ children }: { children: JSX.Element }) {
  const { data: me, isLoading: meLoading, isError: meErrored } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });
  const isManagerShaped = me?.roles.some((r) => MANAGER_SHAPED_ROLES.has(r)) ?? false;
  const { data: workspace, isLoading: workspaceLoading, isError: workspaceErrored } = useMyWorkspace();

  // Deliberately gates on `isLoading` (no cached data at all yet), not
  // `isFetching` (any background refetch, including ones other mounted
  // components trigger on their own). Gating on `isFetching` here caused a
  // real, confirmed infinite loop: any child under `children` that also
  // reads `['manager-workspace']` (e.g. the Settings page for it) refetches
  // on its own mount; this gate would see that refetch, unmount `children`
  // to render null, which unmounts that child, which remounts on the next
  // render, triggering another mount-refetch, forever. `CreateProfileScreen`
  // writes the fresh workspace/profile straight into the cache before
  // navigating here (`qc.setQueryData`), so by the time this gate's very
  // first mount reads the cache, it's already correct — no stale-`null`
  // race to guard against, and no need to distrust background refetches.
  if (meLoading || meErrored) return null;
  if (!isManagerShaped) return children;
  if (workspaceLoading || workspaceErrored) return null;
  if (!workspace) return <Navigate to="/onboarding/workspace" replace />;
  if (!workspace.onboardingCompletedAt) return <Navigate to="/onboarding/profile" replace />;
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AppErrorBoundary>
        <BrowserRouter>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/set-password" element={<RequireAuth><SetPassword /></RequireAuth>} />
          <Route path="/onboarding/workspace" element={<RequireAuth><CreateWorkspaceScreen /></RequireAuth>} />
          <Route path="/onboarding/profile" element={<RequireAuth><CreateProfileScreen /></RequireAuth>} />
          <Route path="/" element={<RequireAuth><OnboardingGate><Layout /></OnboardingGate></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:id" element={<UserProfile />} />
            <Route path="shifts" element={<Shifts />} />
            <Route path="offers" element={<Offers />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="payroll" element={<Payroll />} />
            <Route path="venues" element={<Venues />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="experience" element={<ExperiencePage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="my-workspace" element={<MyWorkspaceGeneralPage />} />
              <Route path="my-workspace/domains" element={<MyWorkspaceDomainsPage />} />
              <Route path="workspace" element={<WorkspaceGeneralPage />} />
              <Route path="workspace/domains" element={<WorkspaceDomainsPage />} />
              <Route path="workspace/roles" element={<WorkspaceRolesPage />} />
              <Route path="admin" element={<PlatformAdminRoute><AdminPanelPage /></PlatformAdminRoute>} />
            </Route>
          </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AppErrorBoundary>
    </QueryClientProvider>
  );
}
