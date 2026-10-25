import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { adminApi, formatDateTime, type WorkspaceRow } from './adminPanelApi';

const STATUS_PILL: Record<string, [string, string]> = {
  READY: ['ap-ok', 'Ready'],
  CREATING: ['ap-info', 'Creating'],
  MIGRATING: ['ap-info', 'Migrating'],
  FAILED: ['ap-bad', 'Failed'],
  SUPERSEDED: ['', 'Superseded'],
};

/**
 * Admin panel → Workspaces (mockup v2). Counts and rows from `core.admin_list_workspace_schemas` /
 * `core.admin_platform_overview`; core migrations from `core.migrations`. No Retry button (owner decision D6): the
 * provisioner retries FAILED workspaces automatically, and the table says so. Data placement follows
 * HWS_RUNTIME_ENABLED (not host routing) — the copy reflects the live switch.
 */
export default function WorkspacesTab() {
  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview, staleTime: 60_000 });
  const migrations = useQuery({ queryKey: ['admin', 'migrations'], queryFn: adminApi.migrations, staleTime: 60_000 });
  const security = useQuery({ queryKey: ['admin', 'security'], queryFn: adminApi.security, staleTime: 60_000 });
  const list = useInfiniteQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: ({ pageParam }) => adminApi.workspaces(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows: WorkspaceRow[] = list.data?.pages.flatMap((p) => p.items ?? []) ?? [];
  const w = overview.data?.workspaces;
  const hws = security.data?.switches?.find((s) => s.variable === 'HWS_RUNTIME_ENABLED')?.state;

  return (
    <>
      <section className="ap-block" aria-label="Workspace summary">
        <div className="ap-grid-4">
          <div className="ap-card ap-stat"><span className="ap-k">Ready</span><span className="ap-v">{w ? w.ready : '—'}</span><span className="ap-d">Schema version 1</span></div>
          <div className="ap-card ap-stat"><span className="ap-k">Creating</span><span className="ap-v">{w ? w.creating : '—'}</span><span className="ap-d">Picked up by the provisioner</span></div>
          <div className="ap-card ap-stat">
            <span className="ap-k">Failed</span>
            <span className="ap-v" style={w && w.failed > 0 ? { color: 'var(--feedback-error)' } : undefined}>{w ? w.failed : '—'}</span>
            <span className="ap-d">The provisioner retries automatically</span>
          </div>
          <div className="ap-card ap-stat">
            <span className="ap-k">Core migrations</span>
            <span className="ap-v">{migrations.data ? migrations.data.applied : '—'}</span>
            <span className="ap-d">{migrations.data?.latest ? `Latest ${migrations.data.latest.replace(/^\D+/, '')}` : 'Not available'}</span>
          </div>
        </div>
      </section>

      <section className="ap-block" aria-label="Workspace schemas">
        <div className="ap-block-head">
          <h2 className="ap-h2">Workspace schemas</h2>
          <p className="ap-sub">
            Per-workspace Postgres schemas from the schema registry.{' '}
            {hws === 'On' ? 'HWS_RUNTIME_ENABLED is on, so business data lives in the workspace schemas.' : hws === 'Off' ? 'HWS_RUNTIME_ENABLED is off, so business data still lives in the core schema.' : ''}
          </p>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Workspace</th><th>Organisation</th><th>Schema</th><th>Status</th><th>Version</th><th>Last change</th><th>Error</th><th aria-label="Retry" /></tr></thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={8} className="ap-empty">Loading…</td></tr>
              ) : list.isError ? (
                <tr><td colSpan={8} className="ap-empty">Workspaces could not be loaded.</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="ap-empty">No workspaces yet.</td></tr>
              ) : (
                rows.map((r) => {
                  const [tone, label] = STATUS_PILL[r.schemaStatus ?? ''] ?? ['', 'Unknown'];
                  return (
                    <tr key={r.workspaceId}>
                      <td>{r.workspaceName || '—'}</td>
                      <td>{r.organisationName ?? '—'}</td>
                      <td className="ap-mono" title={r.schemaName ?? undefined}>{r.schemaName ? `${r.schemaName.slice(0, 14)}…${r.schemaName.slice(-2)}` : '—'}</td>
                      <td><span className={`ap-pill ${tone}`}>{label}</span>{r.driftStatus === 'DRIFTED' || r.driftStatus === 'MISSING' ? <> <span className="ap-pill ap-warn">Drift {r.driftStatus.toLowerCase()}</span></> : null}</td>
                      <td>{r.schemaStatus === 'READY' ? `${r.schemaVersion ?? '–'}${r.moduleVersion !== null ? ` · module ${r.moduleVersion}` : ''}` : '–'}</td>
                      <td>{formatDateTime(r.updatedAt)}</td>
                      <td className="ap-mono">{r.error ?? ''}</td>
                      <td className="ap-muted">{r.schemaStatus === 'FAILED' ? 'Retries automatically' : ''}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {list.hasNextPage && (
          <div className="ap-row"><button type="button" className="ap-btn" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>
        )}
      </section>
    </>
  );
}
