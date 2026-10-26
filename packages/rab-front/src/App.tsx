import { MotionConfig } from 'framer-motion';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider, useQuery, useQueryClient, type Mutation } from '@tanstack/react-query';
import { api, broadcastLogout, withAuthLock } from './shared/api';
import { markUnauthenticated } from './shared/lib/auth-session';
import { useMyWorkspace } from './shared/hooks/useMyWorkspace';
import { SessionBootstrap, useSessionStatus } from './shared/lib/SessionProvider';
import { RealtimeProvider } from './shared/lib/RealtimeProvider';
import Login from './features/auth/Login';
import Layout from './shell/Layout';
import ToastHost from './shell/ToastHost';
import Dashboard from './features/dashboard/Dashboard';
import PlatformAdminRoute from './features/settings/PlatformAdminRoute';
import CeoRoute from './features/settings/CeoRoute';
import AppErrorBoundary from './shared/components/AppErrorBoundary';
import NotFound from './features/errors/NotFound';
import WorkspaceHostGate from './features/workspace-host/WorkspaceHostGate';
import StepUpHost from './features/auth/stepup/StepUpHost';
import { getApiErrorCode } from './shared/lib/apiError';
import { isSilentError, notifyApiError } from './shared/lib/mutationFeedback';

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
const AiChatPage = lazy(() => import('./features/ai/AiChatPage'));
const ResetPassword = lazy(() => import('./features/auth/ResetPassword'));
const ConfirmEmailChange = lazy(() => import('./features/auth/ConfirmEmailChange'));
const ActivateAccount = lazy(() => import('./features/auth/ActivateAccount'));
const AcceptInvitation = lazy(() => import('./features/auth/AcceptInvitation'));
const SetPassword = lazy(() => import('./features/auth/SetPassword'));
const OAuthCallbackComplete = lazy(() => import('./features/auth/OAuthCallbackComplete'));
const LoginHandoffLanding = lazy(() => import('./features/auth/LoginHandoffLanding'));
const CreateWorkspaceScreen = lazy(() => import('./features/onboarding/CreateWorkspaceScreen'));
const CreateProfileScreen = lazy(() => import('./features/onboarding/CreateProfileScreen'));
const WorkspacePreparationScreen = lazy(() => import('./features/onboarding/WorkspacePreparationScreen'));
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
const HelpCenter = lazy(() => import('./features/help/HelpCenter'));
const Support = lazy(() => import('./features/help/Support'));
const SettingsLayout = lazy(() => import('./features/settings/layout/SettingsLayout'));
const ProfilePage = lazy(() => import('./features/settings/profile/ProfilePage'));
const ExperiencePage = lazy(() => import('./features/settings/experience/ExperiencePage'));
const AccountPage = lazy(() => import('./features/settings/account/AccountPage'));
const SecurityPage = lazy(() => import('./features/settings/security/SecurityPage'));
const AiSettingsPage = lazy(() => import('./features/settings/ai/AiSettingsPage'));
const WorkspaceGeneralPage = lazy(() => import('./features/settings/workspace/WorkspaceGeneralPage'));
const SecurityAuthenticationPage = lazy(() => import('./features/settings/workspace/SecurityAuthenticationPage'));
const WorkspaceDomainsPage = lazy(() => import('./features/settings/domains/WorkspaceDomainsPage'));
const MyWorkspaceGeneralPage = lazy(() => import('./features/settings/myworkspace/MyWorkspaceGeneralPage'));
const MyWorkspaceDomainsPage = lazy(() => import('./features/settings/myworkspace/MyWorkspaceDomainsPage'));
const MembersPage = lazy(() => import('./features/settings/members/MembersPage'));
const WorkspaceRolesPage = lazy(() => import('./features/settings/roles/WorkspaceRolesPage'));
const RoleEditorLayout = lazy(() => import('./features/settings/roles/RoleEditorLayout'));
const RoleEditorMain = lazy(() => import('./features/settings/roles/RoleEditorMain'));
const SelectObjectStep = lazy(() => import('./features/settings/roles/RoleObjectSteps').then((m) => ({ default: m.SelectObjectStep })));
const ObjectPermissionsStep = lazy(() => import('./features/settings/roles/RoleObjectSteps').then((m) => ({ default: m.ObjectPermissionsStep })));
const InitialManagerPage = lazy(() => import('./features/settings/workspace/InitialManagerPage'));
const AdminPanelPage = lazy(() => import('./features/settings/admin-panel/AdminPanelPage'));

/**
 * `meta.errorFeedback` for a mutation that shows its own failure WITHOUT a hook-level `onError` (an inline message read
 * from `mutation.error`, or a `mutateAsync` caller's catch): the global fallback below then never adds a toast for it.
 */
export const MUTATION_ERROR_HANDLED = 'handled';

/** What the fallback says when nothing more specific is known. `notifyApiError` still uses safe server text when present. */
export const MUTATION_FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * The global safety net for a failed mutation that nobody can show (FEEDBACK_REPORT §6, App.tsx). It never double-
 * announces: it stays silent when
 *  - the mutation has a hook-level `onError` (every `useFeedbackMutation`, and every hand-written handler);
 *  - `meta.errorFeedback === MUTATION_ERROR_HANDLED` (or `meta.silent`): the call site shows the error itself;
 *  - the error is not a user-facing failure (`isSilentError`: cancelled request, stale-identity response) or is the
 *    step-up refusal (`STEP_UP_REQUIRED`: the "Confirm it's you" dialog was the feedback, and cancelling it is a choice);
 *  - a component that started the mutation is STILL MOUNTED. Many call sites render `mutation.error` inline or catch a
 *    `mutateAsync` rejection without an `onError` (offers, scheduling, users, venues); the component owns that error and
 *    a toast on top would be a second announcement. The fallback is for the failure no one is left to show: the
 *    component unmounted (drawer closed, page left) before the server answered, so its per-call `onError` and its
 *    inline error can no longer appear.
 * Then it raises ONE red toast through the shared `notifyApiError` (safe text only; a 401 gets the persistent
 * "Sign in again").
 */
export function createAppMutationCache(): MutationCache {
  // Which observers (mounted `useMutation` hooks) each mutation currently has. Tracked from the cache's own events.
  const observers = new WeakMap<Mutation<unknown, unknown, unknown, unknown>, Set<unknown>>();
  const cache = new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError) return;
      const meta = mutation.meta as { errorFeedback?: unknown; silent?: unknown } | undefined;
      if (meta?.errorFeedback === MUTATION_ERROR_HANDLED || meta?.silent === true) return;
      if (isSilentError(error) || getApiErrorCode(error) === 'STEP_UP_REQUIRED') return;
      if ((observers.get(mutation as Mutation<unknown, unknown, unknown, unknown>)?.size ?? 0) > 0) return;
      notifyApiError(error, { fallback: MUTATION_FALLBACK_MESSAGE });
    },
  });
  cache.subscribe((event) => {
    if (event.type !== 'observerAdded' && event.type !== 'observerRemoved') return;
    const mutation = event.mutation as Mutation<unknown, unknown, unknown, unknown>;
    const set = observers.get(mutation) ?? new Set<unknown>();
    if (event.type === 'observerAdded') set.add(event.observer);
    else set.delete(event.observer);
    observers.set(mutation, set);
  });
  return cache;
}

const qc = new QueryClient({
  mutationCache: createAppMutationCache(),
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
  if (status === 'unavailable') {
    // Audit F5: the session could not be checked (network or server trouble) — not a logout.
    return (
      <div className="standalone-state-page" role="alert">
        <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
          <h1>Can’t reach Crewflow right now</h1>
          <p>Your session is safe. Check your connection and try again.</p>
          <button type="button" className="btn btn-dark" onClick={() => window.location.reload()}>Try again</button>
        </div>
      </div>
    );
  }
  return status === 'authenticated' ? children : <Navigate to="/login" replace />;
}

// Reversed by the universal-self-service-onboarding checkpoint (docs/HANDOFF.md): CEO now also
// self-services a personal `ManagerWorkspace` after activating, same as an internal Manager — the
// backend change this depends on (`ManagerWorkspaceService.createFor`, gap-review finding) derives
// `bindsOperationalHome` from the profile's own type server-side, so a CEO's workspace is purely
// additive ownership (schema/subdomain) and never touches their real organisation membership —
// confirmed `AuthSecuritySnapshotService.loadSecurityRow` never reads `manager_workspace` at all,
// so owning one cannot change what a CEO is permitted to do. A Venue Manager still only ever has
// MEMBERSHIP in someone else's workspace (via `ManagerProfile.workspaceId`, resolved server-side
// from their venue assignment — see that column's own doc comment), not (yet) a personal workspace
// of their own — gating them through "create your workspace" here left every real Venue Manager
// account permanently redirected to this onboarding screen on every login, unable to reach any
// other route in the console at all — confirmed live, not theoretical, so it stays excluded until
// that's genuinely built. Platform-admin-only accounts are excluded too for now — see this file's
// own `isPlatformAdminOnly` redirect below, which sends them to Admin Panel before this gate is
// ever reached; widening this set to cover them is the next checkpoint.
const WORKSPACE_OWNING_ROLES = new Set(['manager', 'ceo']);

/**
 * First-login redirect for the internal Manager role, which must create its
 * own private workspace before using the console. Every other account type
 * (Staff, Venue Manager, CEO, pure-platform-admin) skips straight through —
 * matching `ManagerWorkspaceService`'s own ownership-only gate. While either
 * query is still loading, render nothing rather than guess — a flashed
 * wrong redirect is worse than a brief blank frame.
 */
function OnboardingGate({ children }: { children: JSX.Element }) {
  const location = useLocation();
  const { data: me, isLoading: meLoading, isError: meErrored } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ roles: string[]; isPlatformAdmin: boolean }>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });
  const mustOwnWorkspace = me?.roles.some((r) => WORKSPACE_OWNING_ROLES.has(r)) ?? false;
  // A pre-existing gap this hid: before `useMyWorkspace` supported `enabled`, this query fired
  // unconditionally for EVERY role on EVERY authenticated page load — Staff, CEO, Venue Manager,
  // and platform-admin-only accounts all paid for a guaranteed 404 against a workspace they can
  // never own. Scoped to the one role that can.
  const { data: workspace, isLoading: workspaceLoading, isError: workspaceErrored } = useMyWorkspace({ enabled: !!me && mustOwnWorkspace });
  // A platform admin with no operational org role (the bootstrap/recovery case — see
  // `rab-workforce-architecture.md`'s own separation of platform/org concerns) has nothing to see
  // on the ordinary staffing console: every one of `Layout`'s nav routes requires an operational
  // permission flag this account was never granted, by design (CLAUDE.md: "Permissions are
  // resolved server-side per request" — this redirect changes nothing about that; it only stops
  // the UI from sending requests already known to fail). `/settings/*` stays reachable — Profile,
  // Account, and Admin Panel are the actual surface this account operates from.
  const isPlatformAdminOnly = Boolean(me?.isPlatformAdmin) && (me?.roles.length ?? 0) === 0;

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
  if (isPlatformAdminOnly && !location.pathname.startsWith('/settings') && location.pathname !== '/chat') {
    return <Navigate to="/settings/admin" replace />;
  }
  if (!mustOwnWorkspace) return children;
  if (workspaceLoading || workspaceErrored) return null;
  if (!workspace) return <Navigate to="/onboarding/workspace" replace />;
  if (!workspace.onboardingCompletedAt) return <Navigate to="/onboarding/profile" replace />;
  return children;
}

/**
 * Wraps the two EDITABLE onboarding-step routes (`/onboarding/workspace`, `/onboarding/profile`)
 * — deliberately NOT `/onboarding/preparing`, which is legitimately visited WHILE
 * `onboardingCompletedAt` is already set (see that route's own comment in the route table).
 * Fixes the browser-Back-after-completed-onboarding issue: once a workspace's server-authoritative
 * `onboardingCompletedAt` is set, the app itself never links to either of these two forms again —
 * `OnboardingGate` above only ever redirects INTO them while `onboardingCompletedAt` is still
 * unset. So the *only* way an authenticated session can land on one of these two routes with
 * onboarding already complete is browser history traversal (Back/Forward) or a stale/typed/
 * bookmarked URL — there is no legitimate in-app path that does it.
 *
 * Browser-history limitation this works around: React Router's `useNavigationType()` reports
 * 'POP' both for actual Back/Forward traversal AND for a fresh page load/typed URL (there is no
 * reliable way to distinguish them from inside the SPA — both start a navigation with no prior
 * in-app transition to compare against). Rather than guess, this guard uses one uniform,
 * server-state-authoritative rule for every arrival mechanism: if onboarding is already complete,
 * sign out and return to Login. This satisfies the owner's explicit requirement for Back
 * specifically (never reopen a stale onboarding form — the strongest possible guarantee) while
 * automatically covering reload/Forward/direct-URL the same way, since they're indistinguishable
 * from Back at this layer and the owner's own brief permits "the strongest reliable scoped
 * behaviour" when a finer distinction can't be guaranteed.
 *
 * Narrow scope, not a general Back-means-logout rule: this guard only ever runs on these three
 * specific routes, and only ever fires when `onboardingCompletedAt` is already set — ordinary
 * Dashboard → Settings → Back navigation never touches an `/onboarding/*` route at all, so it can
 * never trigger this, satisfying the owner's explicit "must stay authenticated" requirement for
 * normal back-navigation elsewhere in the app. No `beforeunload`/`popstate` interception is used —
 * this is a plain server-state check at ordinary React Router render time, the same mechanism
 * `OnboardingGate`/`RequireAuth` already use, not a fragile history trick.
 *
 * Reuses the exact real sign-out sequence `WorkspacePreparationScreen.tsx`'s own `signOut()`
 * already uses (never invented here): the real `/auth/logout` endpoint (revokes the session
 * server-side and clears cookies), `markUnauthenticated()` + `broadcastLogout()` (cross-tab
 * fencing via the existing infrastructure), and `queryClient.clear()` (drops every cached
 * identity/user-scoped query, not just this screen's own). Never claims success if the server
 * call failed — the client-side cleanup and navigation to `/login` still happen either way
 * (best-effort: an unreachable server must not trap the user on a stale form it cannot submit to),
 * but nothing here pretends the server-side revocation succeeded when it didn't.
 *
 * Decides staleness ONCE, from a forced `refetch()`'s own resolved result at mount — never by
 * staying reactively subscribed to the live `['manager-workspace']` query data afterward. Two real
 * bugs were found live by getting this wrong, in order:
 *
 * 1. Acting on merely CACHED data: this query key's default `staleTime` (30s, the app-wide
 *    `QueryClient` default) means a value cached moments earlier — e.g. the SAME account's
 *    previous, now-superseded workspace — was trusted as-is on mount with no network round trip,
 *    and `isLoading` was `false` the instant cached data existed regardless of its age. Fixed by
 *    forcing a real `refetch()` before ever deciding.
 * 2. Staying reactively subscribed to `useMyWorkspace()`'s `data` AFTER that initial decision: the
 *    legitimate completion moment itself writes the now-completed workspace into this exact same
 *    shared `['manager-workspace']` cache entry WHILE THIS GUARD IS STILL MOUNTED on
 *    `/onboarding/profile` — `CreateProfileScreen.submit()` calls
 *    `qc.setQueryData(['manager-workspace'], workspace)` (with `onboardingCompletedAt` now set)
 *    BEFORE its own `nav('/onboarding/preparing', { replace: true })` has had a chance to actually
 *    swap which route is mounted. A guard that kept reading `data` reactively saw that write, as a
 *    STILL-MOUNTED subscriber, and concluded "onboarding just became complete while sitting on
 *    this route" — indistinguishable, from a purely reactive read, from an actual stale/Back visit.
 *    Confirmed live via the server log: `POST .../complete-onboarding` immediately followed by
 *    `POST /auth/logout`, every single time — the legitimate completion itself was triggering the
 *    sign-out meant for a stale revisit. Fixed by reading the refetch's OWN returned result once,
 *    into local state, and never re-deriving the decision from the hook's ongoing subscription —
 *    a later write to the shared cache (from this page's own legitimate action) can no longer
 *    retroactively flip an already-settled "not stale" verdict.
 */
function OnboardingRouteGuard({ children }: { children: JSX.Element }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { refetch } = useMyWorkspace();
  const signingOutRef = useRef(false);
  const [verdict, setVerdict] = useState<'checking' | 'stale' | 'ok'>('checking');

  useEffect(() => {
    let cancelled = false;
    refetch().then((result) => {
      if (cancelled) return;
      setVerdict(result.data?.onboardingCompletedAt ? 'stale' : 'ok');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (verdict !== 'stale' || signingOutRef.current) return;
    signingOutRef.current = true;
    (async () => {
      try {
        await withAuthLock(() => api.post('/auth/logout'));
      } catch {
        // Best-effort: still clear the local session and leave the stale form either way — see
        // this component's own doc comment on why this never claims server-side success it didn't get.
      }
      markUnauthenticated();
      broadcastLogout();
      qc.clear();
      nav('/login', { replace: true });
    })();
  }, [verdict, qc, nav]);

  // Never render the stale onboarding form: not before this mount's own fresh check has resolved
  // (`verdict === 'checking'`), not once confirmed stale, not during the sign-out itself.
  if (verdict !== 'ok' || signingOutRef.current) return null;
  return children;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      {/* App-wide motion policy: with OS "reduce motion", Framer Motion drops transforms everywhere (opacity only). */}
      <MotionConfig reducedMotion="user">
      <AppErrorBoundary>
        {/* Wave 3 lane H: which workspace (if any) this host is, resolved before the session bootstraps. */}
        <WorkspaceHostGate>
        <SessionBootstrap>
        <RealtimeProvider>
        <BrowserRouter>
          {/* fallback={null}: same "render nothing while loading" convention RequireAuth/
              OnboardingGate already use above — a brief blank frame beats a flashed loading
              spinner that wasn't part of this app's design before this change. */}
          <Suspense fallback={null}>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth/callback-complete" element={<OAuthCallbackComplete />} />
          <Route path="/auth/handoff" element={<LoginHandoffLanding />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/confirm-email-change" element={<ConfirmEmailChange />} />
          <Route path="/activate-account" element={<ActivateAccount />} />
          <Route path="/accept-invitation" element={<AcceptInvitation />} />
          <Route path="/set-password" element={<RequireAuth><SetPassword /></RequireAuth>} />
          <Route path="/onboarding/workspace" element={<RequireAuth><OnboardingRouteGuard><CreateWorkspaceScreen /></OnboardingRouteGuard></RequireAuth>} />
          <Route path="/onboarding/profile" element={<RequireAuth><OnboardingRouteGuard><CreateProfileScreen /></OnboardingRouteGuard></RequireAuth>} />
          {/* NOT wrapped in OnboardingRouteGuard: unlike the two routes above, this one is legitimately
              visited WHILE `onboardingCompletedAt` is already set — `CreateProfileScreen` sets it (via
              `complete-onboarding`) immediately before navigating here, so "already complete" can't be
              this route's staleness signal the way it is for the other two. This screen already has its
              own correct handling for a stale/already-READY revisit (shows the welcome fast-path, then
              leaves again) — see its own doc comment. */}
          <Route path="/onboarding/preparing" element={<RequireAuth><WorkspacePreparationScreen /></RequireAuth>} />
          <Route path="/" element={<RequireAuth><OnboardingGate><Layout /></OnboardingGate></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="chat" element={<AiChatPage />} />
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
            <Route path="help" element={<HelpCenter />} />
            <Route path="support" element={<Support />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="experience" element={<ExperiencePage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="security" element={<SecurityPage />} />
              <Route path="my-workspace" element={<MyWorkspaceGeneralPage />} />
              <Route path="my-workspace/domains" element={<MyWorkspaceDomainsPage />} />
              <Route path="workspace" element={<WorkspaceGeneralPage />} />
              <Route path="workspace/security" element={<SecurityAuthenticationPage />} />
              <Route path="workspace/domains" element={<WorkspaceDomainsPage />} />
              <Route path="workspace/members" element={<MembersPage />} />
              <Route path="workspace/roles" element={<WorkspaceRolesPage />} />
              {/* Full-page role editor; the layout owns the unsaved draft shared by its nested steps. */}
              <Route path="workspace/members/roles/:roleId" element={<RoleEditorLayout />}>
                <Route index element={<RoleEditorMain />} />
                <Route path="objects" element={<SelectObjectStep />} />
                <Route path="objects/:objectKey" element={<ObjectPermissionsStep />} />
              </Route>
              <Route path="workspace/team" element={<CeoRoute><InitialManagerPage /></CeoRoute>} />
              {/* AI Phase 1: the organisation's CEO chooses the AI model per tier (server: ai.settings + CEO + step-up). */}
              <Route path="ai" element={<CeoRoute><AiSettingsPage /></CeoRoute>} />
              <Route path="admin" element={<PlatformAdminRoute><AdminPanelPage /></PlatformAdminRoute>} />
            </Route>
          </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          {/* One toast host for every route (auth, onboarding and the console), so a toast survives navigation. */}
          <ToastHost />
          {/* Lane D (M10-2): the one "Confirm it's you" prompt for 403 STEP_UP_REQUIRED (server-enforced step-up). */}
          <StepUpHost />
        </BrowserRouter>
        </RealtimeProvider>
        </SessionBootstrap>
        </WorkspaceHostGate>
      </AppErrorBoundary>
      </MotionConfig>
    </QueryClientProvider>
  );
}
