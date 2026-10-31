import { useQuery, type Query } from '@tanstack/react-query';
import { api } from '../api';
import { lastAnsweredAt, pollingOptions } from '../lib/polling';

/** When the current CREATING wait was first observed, per query (the backoff below is measured from it). */
const creatingSince = new WeakMap<Query<any, any, any, any>, number>();

/** Bounded backoff for a long CREATING: the base interval for a minute, then 5 s, 10 s, and 30 s from five minutes. */
export function creatingInterval(elapsedMs: number, baseMs: number): number {
  if (elapsedMs < 60_000) return baseMs;
  if (elapsedMs < 120_000) return Math.max(baseMs, 5_000);
  if (elapsedMs < 300_000) return Math.max(baseMs, 10_000);
  return Math.max(baseMs, 30_000);
}

/**
 * The real, authoritative backend enum (`core.manager_workspace.schema_status`, CHECK-constrained
 * — see `WorkspaceSchemaProvisioning`/`WorkspaceSchemaSupersededStatus` migrations): a fresh row
 * is written 'CREATING', the isolated Worker flips it to 'READY' or 'FAILED'. A pre-existing row
 * created before this column ever shipped stays `null`, which the Worker never touches and which
 * `OnboardingGate`/`WorkspacePreparationScreen` both treat as "nothing to wait for". 'MIGRATING'
 * is a reserved value no code path writes yet. 'SUPERSEDED' (P2.9 gap review, item 2) is written
 * only on a workspace whose owning Initial Manager invitation was replaced — architecturally
 * unreachable for the CURRENTLY authenticated caller's OWN `/manager-workspaces/me` (replacement
 * requires the account to have never activated, which is precisely the state this screen's own
 * caller can never be in), but handled explicitly anyway rather than relying on that invariant
 * holding forever.
 */
export type ManagerWorkspaceSchemaStatus = 'CREATING' | 'READY' | 'FAILED' | 'SUPERSEDED' | 'MIGRATING' | null;

export interface MyWorkspace {
  id: string;
  name: string;
  subdomain: string;
  logoKey: string | null;
  status: string;
  schemaStatus: ManagerWorkspaceSchemaStatus;
  onboardingCompletedAt: string | null;
  createdAt: string;
  /**
   * Phase B P8 — server-derived NAVIGATION info only (never authorization): true only when the HWS runtime routing applies
   * to this workspace for the current session, i.e. the console cannot work until the schema is READY. `OnboardingGate`
   * sends the owner to the preparation screen only when this is exactly `true` and the status is CREATING or FAILED.
   * Optional: a response from an older server (or a cached create result) may lack it, which means "no redirect".
   */
  schemaRequired?: boolean;
}

/**
 * `GET /manager-workspaces/me` — a 404 is a valid, expected state (this
 * Manager hasn't created a workspace yet), not a query error. Callers that
 * need to distinguish "no workspace" from "still loading" use `isLoading`;
 * `data` is `null` (not undefined-forever) once resolved either way.
 *
 * `opts.pollWhileCreating` (P2.9C): while the resolved workspace's own
 * `schemaStatus === 'CREATING'`, re-fetches on an interval instead of relying
 * on `staleTime`/window-focus — `WorkspacePreparationScreen` needs the REAL,
 * current backend state to decide when to leave, not a cached snapshot from
 * whenever this hook last happened to run. Stops polling the instant the
 * resolved status is anything else (`READY`/`FAILED`/`null`/no workspace) —
 * `refetchInterval`'s callback reads the LATEST query data on every tick, so
 * this never keeps polling past the real terminal state by even one extra
 * request.
 */
export function useMyWorkspace(opts: { pollWhileCreating?: boolean; pollIntervalMs?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['manager-workspace'],
    queryFn: async () => {
      try {
        // `?fresh=1` while actively polling for provisioning completion — bypasses the backend's
        // entity cache for this one call site (see `ManagerWorkspaceService.getMine`'s own doc
        // comment: the isolated workspace provisioner can't invalidate that cache itself when it
        // flips `schema_status`). NOTE: that cache is disabled by default in this environment
        // (`CORE_ENTITY_CACHE_ENABLED=false`) and was confirmed NOT to be the cause of a separate,
        // live "stuck on Preparing" report — kept anyway as a genuine fix for any environment where
        // it is enabled. The actual live cause turned out to be the hidden-tab polling stall (see below).
        const { data } = await api.get<MyWorkspace>(`/manager-workspaces/me${opts.pollWhileCreating ? '?fresh=1' : ''}`);
        return data;
      } catch (err: any) {
        if (err?.response?.status === 404) return null;
        throw err;
      }
    },
    // Defaults to true so every pre-existing caller (WorkspacePreparationScreen, the My Workspace
    // settings pages) is unaffected — callers that know in advance this account can never own a
    // workspace (OnboardingGate, for anyone outside WORKSPACE_OWNING_ROLES) pass `enabled: false`
    // instead of firing a request guaranteed to 404. UX-only: the real enforcement is still the
    // backend's own ownership-only `/manager-workspaces/me` lookup.
    enabled: opts.enabled ?? true,
    // Phase C1 (shared/lib/polling.ts): while CREATING, poll only while the tab is visible and re-read once, at once, the
    // moment it becomes visible again. History: polling used to stall silently once the tab had been hidden (the app's
    // QueryClient disables refetchOnWindowFocus, so returning to the tab did not resume it — the live "stuck on
    // Preparing until I click Check again" report), first fixed by polling while hidden (`refetchIntervalInBackground`);
    // the visible catch-up fixes the same symptom without background traffic. A long CREATING backs off (2.5 s for the
    // first minute, then 5 s, 10 s, and 30 s after five minutes) and never stops on its own; "Check again" stays.
    ...(opts.pollWhileCreating
      ? pollingOptions((query: Query<any, any, any, any>) => {
          if ((query.state.data as MyWorkspace | null | undefined)?.schemaStatus !== 'CREATING') {
            creatingSince.delete(query);
            return false;
          }
          const answeredAt = lastAnsweredAt(query);
          if (!creatingSince.has(query)) creatingSince.set(query, answeredAt);
          return creatingInterval(answeredAt - creatingSince.get(query)!, opts.pollIntervalMs ?? 2500);
        })
      : {}),
  });
}
