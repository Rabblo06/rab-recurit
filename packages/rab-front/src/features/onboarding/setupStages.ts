import type { ManagerWorkspaceSchemaStatus } from '../../shared/hooks/useMyWorkspace';

/**
 * Workspace setup stages, derived ONLY from what the server has actually reported — never from a timer.
 *
 * What the server can observe (server-path provisioning, `core.provision_workspace`):
 *   - Validating + Creating workspace: done once `POST /manager-workspaces` has returned a workspace row — the server
 *     validated the request (ownership, subdomain, one workspace per manager) and committed the row.
 *   - Preparing database, Applying FORCE RLS, Verifying workspace: these run inside ONE database transaction (create the
 *     tables, enable + FORCE RLS and policies, verify the structure, mark READY). Nothing inside it is visible to anyone
 *     until it commits, so the server cannot report them separately. They are shown honestly as one group: in progress
 *     together while the workspace is CREATING, complete together on READY, rolled back together on FAILED.
 *   - Ready: the server reports READY.
 */
export const SETUP_STAGES = [
  { key: 'validating', label: 'Validating' },
  { key: 'creating', label: 'Creating workspace' },
  { key: 'database', label: 'Preparing database' },
  { key: 'rls', label: 'Applying FORCE RLS' },
  { key: 'verifying', label: 'Verifying workspace' },
  { key: 'ready', label: 'Ready' },
] as const;

export type SetupStageKey = (typeof SETUP_STAGES)[number]['key'];
export type SetupStageState = 'pending' | 'current' | 'complete' | 'failed';

/** The three stages that share one database transaction and therefore one observable outcome. */
export const TRANSACTIONAL_STAGES: readonly SetupStageKey[] = ['database', 'rls', 'verifying'];

/**
 * `status` is the server's `schemaStatus` for the caller's own workspace; `undefined` means no workspace row has been
 * reported yet (the create request is still in flight or has not been sent).
 */
export function setupStageStates(status: ManagerWorkspaceSchemaStatus | undefined): Record<SetupStageKey, SetupStageState> {
  const all = (state: SetupStageState): Record<SetupStageKey, SetupStageState> =>
    Object.fromEntries(SETUP_STAGES.map((s) => [s.key, state])) as Record<SetupStageKey, SetupStageState>;

  if (status === undefined || status === null) {
    return { ...all('pending'), validating: 'current' };
  }
  const rowCommitted = { validating: 'complete', creating: 'complete' } as const;
  switch (status) {
    case 'READY':
      return all('complete');
    case 'FAILED':
      return { ...all('pending'), ...rowCommitted, database: 'failed', rls: 'failed', verifying: 'failed' };
    case 'CREATING':
    case 'MIGRATING':
      return { ...all('pending'), ...rowCommitted, database: 'current', rls: 'current', verifying: 'current' };
    default:
      // SUPERSEDED or an unknown value: nothing beyond the committed row is claimed.
      return { ...all('pending'), ...rowCommitted };
  }
}
