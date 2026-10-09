import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api } from './shared/api';
import { useMyWorkspace } from './shared/hooks/useMyWorkspace';
import { SessionBootstrap, useSessionStatus } from './shared/lib/SessionProvider';
import Login from './features/auth/Login';
import Layout from './shell/Layout';
import Dashboard from './features/dashboard/Dashboard';
import PlatformAdminRoute from './features/settings/PlatformAdminRoute';
import AppErrorBoundary from './shared/components/AppErrorBoundary';
import NotFound from './features/errors/NotFound';

// P2.0 (bundle-size finding: a single 1.3MB production chunk, `vite build`'s own warning) — every
// route below this point is reachable only after a route change, never on first paint, so there is
// no reason its code needs to be IN the first paint's bundle. `Login`, `Layout`, `Dashboard` stay
// eager above: they're what the very first screen (unauthenticated or freshly authenticated) always
// renders, so lazy-loading them would only move the same unavoidable fetch to a later waterfall
// step and add a visible Suspense flicker for no benefit — exactly what made this a "focused
// improvement", not a blanket one. Same reasoning excludes `PlatformAdminRoute` (a guard wrapper,
// not a page — splitting it would only add a chunk boundary with no payload worth deferring) and
// `NotFound` (already tiny). See the measured before/after at this change's own commit for the
// actual chunk-size result; this comment does not claim a number so it can't drift from one.
const ForgotPassword = lazy(() => import('./features/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./features/auth/ResetPassword'));
const ActivateAccount = lazy(() => import('./features/auth/ActivateAccount'));
const SetPassword = lazy(() => import('./features/auth/SetPassword'));
const OAuthCallbackComplete = lazy(() => import('./features/auth/OAuthCallbackComplete'));
const CreateWorkspaceScreen = lazy(() => import('./features/onboarding/CreateWorkspaceScreen'));
const CreateProfileScreen = lazy(() => import('./features/onboarding/CreateProfileScreen'));
const Users = lazy(() => import('./features/users/Users'));
const UserProfile = lazy(() => import('./features/users/UserProfile'));
const Shifts = lazy(() => import('./features/scheduling/Shifts'));
const Offers = lazy(() => import('./features/offers/Offers'));
const VenueOffers = lazy(() => import('./features/scheduling/VenueOffers'));
const VenueOfferPipeline = lazy(() => import('./features/scheduling/VenueOfferPipeline'));
const Calendar = lazy(() => import('./features/scheduling/Calendar'));
const Payroll = lazy(() => import('./features/payroll/Payroll'));
const Venues = lazy(() => import('./features/venues/Venues'));
const AuditLog = lazy(() => import('./features/audit/AuditLog'));
const SettingsLayout = lazy(() => import('./features/settings/layout/SettingsLayout'));
const ProfilePage = lazy(() => import('./features/settings/profile/ProfilePage'));
const ExperiencePage = lazy(() => import('./features/settings/experience/ExperiencePage'));
const AccountPage = lazy(() => import('./features/settings/account/AccountPage'));
const WorkspaceGeneralPage = lazy(() => import('./features/settings/workspace/WorkspaceGeneralPage'));
const SecurityAuthenticationPage = lazy(() => import('./features/settings/workspace/SecurityAuthenticationPage'));
const WorkspaceDomainsPage = lazy(() => import('./features/settings/domains/WorkspaceDomainsPage'));
const MyWorkspaceGeneralPage = lazy(() => import('./features/settings/myworkspace/MyWorkspaceGeneralPage'));
const MyWorkspaceDomainsPage = lazy(() => import('./features/settings/myworkspace/MyWorkspaceDomainsPage'));
const WorkspaceRolesPage = lazy(() => import('./features/settings/roles/WorkspaceRolesPage'));
const AdminPanelPage = lazy(() => import('./features/settings/admin-panel/AdminPanelPage'));

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // Default (0) means every remount and every window-focus refetches —
      // real cost under the guard-chain's per-request round-trip tax. 30s
      // is a debounce, not long-term caching: still near-real-time, but a
      // route revisit or tab-refocus inside that window reuses the cache
      // instead of re-paying a full request. Individual queries override
      // this where business semantics call for something else (e.g. /me at
      // 5 min, already set at its own call site).
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Default retry: 3 with exponential backoff (1s/2s/4s) means one
      // flaky request holds a loading state for ~7s extra on top of its
      // own latency. One retry is enough to smooth a genuine transient
      // blip without compounding an already-slow request — but only for a
      // genuinely transient failure. A 4xx (confirmed live via the P1G
      // waterfall audit: an account with no onboarded workspace yet gets a
      // real, deterministic 404 from /staff and /offers) is never going to
      // succeed on retry; retrying it is a pure duplicate network request
      // that only delays the empty state the first response already gave.
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

/**
 * Gates on the shared session store (`auth-session.ts`/`SessionBootstrap`),
 * never a synchronous localStorage read — the access token only ever lives
 * in memory now, so on a hard reload it starts empty and the real answer
 * ("is the HttpOnly refresh cookie still valid?") isn't known until
 * `bootstrapSession()` resolves. Renders nothing while that's in flight,
 * same "don't guess" convention `OnboardingGate` below already uses — a
 * brief blank frame beats a flashed wrong redirect.
 */
function RequireAuth({ children }: { children: JSX.Element }) {
  const status = useSessionStatus();
  if (status === 'loading') return null;
  return status === 'authenticated' ? children : <Navigate to="/login" replace />;
}

// Only an internal Manager independently OWNS a private `ManagerWorkspace`
// (`ManagerWorkspaceService.getMine` / `/manager-workspaces/me` is an
// ownership-only lookup — `owner_user_id = ctx.userId`). A Venue Manager or
// CEO account only ever has MEMBERSHIP in someone else's workspace (via
// `ManagerProfile.workspaceId`, resolved server-side from their venue
// assignment — see that column's own doc comment), never one of their own
// to create. Gating them through "create your workspace" here (the
// original set below treated all three roles identically) left every real
// Venue Manager/CEO account permanently redirected to this onboarding
// screen on every login, unable to reach any other route in the console at
// all — confirmed live, not theoretical.
const WORKSPACE_OWNING_ROLES = new Set(['manager']);

/**
 * First-login redirect for the internal Manager role, which must create its
 * own private workspace before using the console. Every other account type
 * (Staff, Venue Manager, CEO, pure-platform-admin) skips straight through —
 * matching `ManagerWorkspaceService`'s own ownership-only gate. While either
 * query is still loading, render nothing rather than guess — a flashed
 * wrong redirect is worse than a brief blank frame.
 */
function OnboardingGate({ children }: { children: JSX.Element }) {
  const { data: me, isLoading: meLoading, isError: meErrored } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ roles: string[] }>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });
  const mustOwnWorkspace = me?.roles.some((r) => WORKSPACE_OWNING_ROLES.has(r)) ?? false;
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
  if (!mustOwnWorkspace) return children;
  if (workspaceLoading || workspaceErrored) return null;
  if (!workspace) return <Navigate to="/onboarding/workspace" replace />;
  if (!workspace.onboardingCompletedAt) return <Navigate to="/onboarding/profile" replace />;
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AppErrorBoundary>
        <SessionBootstrap>
        <BrowserRouter>
          {/* fallback={null}: same "render nothing while loading" convention RequireAuth/
              OnboardingGate already use above — a brief blank frame beats a flashed loading
              spinner that wasn't part of this app's design before this change. */}
          <Suspense fallback={null}>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth/callback-complete" element={<OAuthCallbackComplete />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/activate-account" element={<ActivateAccount />} />
          <Route path="/set-password" element={<RequireAuth><SetPassword /></RequireAuth>} />
          <Route path="/onboarding/workspace" element={<RequireAuth><CreateWorkspaceScreen /></RequireAuth>} />
          <Route path="/onboarding/profile" element={<RequireAuth><CreateProfileScreen /></RequireAuth>} />
          <Route path="/" element={<RequireAuth><OnboardingGate><Layout /></OnboardingGate></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:id" element={<UserProfile />} />
            <Route path="shifts" element={<Shifts />} />
            <Route path="offers" element={<Offers />} />
            <Route path="venue-offers" element={<VenueOffers />} />
            <Route path="venue-offers/:shiftId" element={<VenueOfferPipeline />} />
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
              <Route path="workspace/security" element={<SecurityAuthenticationPage />} />
              <Route path="workspace/domains" element={<WorkspaceDomainsPage />} />
              <Route path="workspace/roles" element={<WorkspaceRolesPage />} />
              <Route path="admin" element={<PlatformAdminRoute><AdminPanelPage /></PlatformAdminRoute>} />
            </Route>
          </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
        </SessionBootstrap>
      </AppErrorBoundary>
    </QueryClientProvider>
  );
}
