import type { QueryClient } from '@tanstack/react-query';
import { lazyWithPreload, preloadQuietly } from '../shared/lib/lazyWithPreload';
import { capabilitiesQuery, jobRolesQuery } from '../shared/queries/navQueries';
import { authMeQuery, venuesWithArchivedQuery } from '../features/scheduling/schedulingQueries';
import { payrollPeriodQuery } from '../features/payroll/payrollQueries';
import { currentMonth } from '../features/payroll/payrollModel';
import { sessionsQuery } from '../features/settings/profile/sessionsQuery';
import { preloadPhoneInput } from '../features/users/LazyPhoneInput';

/**
 * Every console page (the routes inside `Layout`), code-split as before, but PRELOADABLE (fast first navigation,
 * 2026-11-11). `App.tsx` routes to these components; the shell preloads them when the browser is idle after sign-in and
 * when a nav link is hovered or focused, so the first click no longer waits for the page's code. Each import also retries
 * once and recovers from a chunk a newer deploy removed (`lazyWithPreload`).
 *
 * Preloading only downloads JavaScript; prefetching only runs the same GET the page itself runs, with the same session.
 * Nothing here decides what a user may see: every route and every API call stays enforced server-side.
 */
export const AiChatPage = lazyWithPreload(() => import('../features/ai/AiChatPage'));
export const Users = lazyWithPreload(() => import('../features/users/Users'));
export const UserProfile = lazyWithPreload(() => import('../features/users/UserProfile'));
export const Shifts = lazyWithPreload(() => import('../features/scheduling/Shifts'));
export const Offers = lazyWithPreload(() => import('../features/offers/Offers'));
export const VenueOffers = lazyWithPreload(() => import('../features/scheduling/VenueOffers'));
export const VenueOfferPipeline = lazyWithPreload(() => import('../features/scheduling/VenueOfferPipeline'));
export const Calendar = lazyWithPreload(() => import('../features/scheduling/Calendar'));
export const Payroll = lazyWithPreload(() => import('../features/payroll/Payroll'));
export const Venues = lazyWithPreload(() => import('../features/venues/Venues'));
export const AuditLog = lazyWithPreload(() => import('../features/audit/AuditLog'));
export const HelpCenter = lazyWithPreload(() => import('../features/help/HelpCenter'));
export const Support = lazyWithPreload(() => import('../features/help/Support'));
export const SettingsLayout = lazyWithPreload(() => import('../features/settings/layout/SettingsLayout'));
export const ProfilePage = lazyWithPreload(() => import('../features/settings/profile/ProfilePage'));
export const ExperiencePage = lazyWithPreload(() => import('../features/settings/experience/ExperiencePage'));
export const AccountPage = lazyWithPreload(() => import('../features/settings/account/AccountPage'));
export const SecurityPage = lazyWithPreload(() => import('../features/settings/security/SecurityPage'));
export const AiSettingsPage = lazyWithPreload(() => import('../features/settings/ai/AiSettingsPage'));
export const WorkspaceGeneralPage = lazyWithPreload(() => import('../features/settings/workspace/WorkspaceGeneralPage'));
export const SecurityAuthenticationPage = lazyWithPreload(() => import('../features/settings/workspace/SecurityAuthenticationPage'));
export const WorkspaceDomainsPage = lazyWithPreload(() => import('../features/settings/domains/WorkspaceDomainsPage'));
export const MyWorkspaceGeneralPage = lazyWithPreload(() => import('../features/settings/myworkspace/MyWorkspaceGeneralPage'));
export const MyWorkspaceDomainsPage = lazyWithPreload(() => import('../features/settings/myworkspace/MyWorkspaceDomainsPage'));
export const MembersPage = lazyWithPreload(() => import('../features/settings/members/MembersPage'));
export const WorkspaceRolesPage = lazyWithPreload(() => import('../features/settings/roles/WorkspaceRolesPage'));
export const RoleEditorLayout = lazyWithPreload(() => import('../features/settings/roles/RoleEditorLayout'));
export const RoleEditorMain = lazyWithPreload(() => import('../features/settings/roles/RoleEditorMain'));
export const SelectObjectStep = lazyWithPreload(() => import('../features/settings/roles/RoleObjectSteps').then((m) => ({ default: m.SelectObjectStep })));
export const ObjectPermissionsStep = lazyWithPreload(() => import('../features/settings/roles/RoleObjectSteps').then((m) => ({ default: m.ObjectPermissionsStep })));
export const InitialManagerPage = lazyWithPreload(() => import('../features/settings/workspace/InitialManagerPage'));
export const AdminPanelPage = lazyWithPreload(() => import('../features/settings/admin-panel/AdminPanelPage'));

type Preloadable = { preload: () => Promise<unknown> };

/** What one nav destination needs: its code (both levels for nested routes) and the data it reads first. */
interface NavTarget {
  pages: Preloadable[];
  /** Only queries whose key does not depend on page state (the list pages' keys come from saved table state). */
  prefetch?: (qc: QueryClient) => void;
}

// qc.prefetchQuery never throws and does nothing while the cached data is still fresh (each query's staleTime).
/** Keyed by the path the nav link points at. Settings needs BOTH levels: its layout and the profile page inside it. */
export const NAV_TARGETS: Record<string, NavTarget> = {
  '/users': { pages: [Users], prefetch: (qc) => void qc.prefetchQuery(jobRolesQuery()) },
  '/shifts': {
    pages: [Shifts],
    prefetch: (qc) => { void qc.prefetchQuery(authMeQuery); void qc.prefetchQuery(venuesWithArchivedQuery()); void qc.prefetchQuery(jobRolesQuery()); },
  },
  '/payroll': {
    pages: [Payroll],
    prefetch: (qc) => { void qc.prefetchQuery(capabilitiesQuery); void qc.prefetchQuery(payrollPeriodQuery(currentMonth())); },
  },
  '/offers': { pages: [Offers] },
  '/calendar': {
    pages: [Calendar],
    prefetch: (qc) => { void qc.prefetchQuery(venuesWithArchivedQuery()); void qc.prefetchQuery(jobRolesQuery()); },
  },
  '/venues': { pages: [Venues] },
  '/venue-offers': { pages: [VenueOffers] },
  '/audit': { pages: [AuditLog] },
  '/help': { pages: [HelpCenter] },
  '/support': { pages: [Support] },
  '/settings/profile': { pages: [SettingsLayout, ProfilePage], prefetch: (qc) => void qc.prefetchQuery(sessionsQuery) },
  '/chat': { pages: [AiChatPage] },
};

/** The pages most people open first: preloaded (code only) when the browser is idle after sign-in. */
const IDLE_PRELOAD_PATHS = ['/users', '/shifts', '/payroll', '/offers', '/calendar', '/venues', '/settings/profile'];

/** Hover/focus on a nav link: the page's code plus its fixed-key data. Unknown paths do nothing. */
export function preloadNavTarget(path: string, qc?: QueryClient): void {
  const target = NAV_TARGETS[path];
  if (!target) return;
  target.pages.forEach(preloadQuietly);
  if (qc) target.prefetch?.(qc);
}

/** Idle preload after sign-in: code only (no API calls), one page after another so it never competes with real work. */
export async function preloadMainPages(): Promise<void> {
  for (const path of IDLE_PRELOAD_PATHS) {
    for (const page of NAV_TARGETS[path].pages) {
      try {
        await page.preload();
      } catch {
        // A failed background preload is ignored; the route retries when it is actually opened.
      }
    }
  }
  // The phone field used by the shell's user drawers (Create staff, user detail), split out of the first-load bundle.
  await preloadPhoneInput();
}

/**
 * Runs `task` once the browser is idle (`requestIdleCallback`, or a short timeout where it does not exist). Skipped when
 * the user asked to save data. Returns a cancel function.
 */
export function whenIdle(task: () => void, timeoutMs = 2_000): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(task, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, 1_500);
  return () => window.clearTimeout(id);
}
