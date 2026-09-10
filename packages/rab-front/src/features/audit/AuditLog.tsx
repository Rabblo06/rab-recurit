import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

const PAGE_SIZE = 50;

// Real AuditAction values (engine/core-modules/audit/audit.service.ts) —
// never invented. Label derived programmatically (never hand-maintained
// for 58+ entries, which would drift the moment a new action is added).
const AUDIT_ACTIONS = [
  'user.created', 'user.invited', 'password.changed', 'password.reset_requested', 'password.reset_completed',
  'password.admin_reset', 'offer.sent', 'offer.accepted', 'offer.declined', 'offer.confirmed', 'offer.rejected',
  'offer.withdrawn', 'offer.expired', 'user.logout', 'profile.updated', 'workspace.updated',
  'workspace.subdomain_changed', 'role.created', 'role.updated', 'role.permissions_updated',
  'platform_config.smtp_updated', 'platform_config.maintenance_mode_changed', 'manager.venue_assigned',
  'manager.venue_unassigned', 'manager.ceo_created', 'admin.inspect_started', 'admin.inspect_ended',
  'attendance.clocked_in', 'attendance.clocked_out', 'staff.suspension_notice_sent',
  'manager_workspace.created', 'manager_workspace.subdomain_changed', 'manager_workspace.updated',
  'manager_workspace.onboarding_completed', 'auth.refresh_reuse_detected', 'platform_admin.granted',
  'platform_admin.revoked', 'platform_admin.bootstrapped', 'user.invite_failed', 'user.invite_queued',
  'user.invite_resent', 'user.invite_pending_email_changed', 'user.invite_cancelled', 'user.invite_accepted',
  'user.activated', 'user.suspended', 'user.reactivated', 'user.deleted', 'user.invite_expired',
  'user.invite_cleaned_up', 'user.invite_cleanup_skipped', 'email.sent', 'email.delivery_failed',
  'shift.reminder_sent', 'shift_assignment.no_show', 'shift_assignment.missing_clock_out_flagged',
  'offer.expired_by_worker',
];
const actionLabel = (value: string) => value.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Real entityType values actually passed to AuditService.record() across
// the codebase (grepped, never invented) — 'user' also covers entries that
// fall back to it via a bare targetUserId with no explicit entityType.
const CATEGORY_OPTIONS = ['attendance', 'manager', 'manager_workspace', 'offer', 'organisation', 'role', 'user']
  .map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

const AUDIT_LOG_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'audit-log',
  filters: [
    { key: 'action', label: 'Action', type: 'select', options: AUDIT_ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })) },
    { key: 'entityType', label: 'Category', type: 'select', options: CATEGORY_OPTIONS },
    { key: 'createdAt', label: 'Date', type: 'dateRange' },
  ],
  sorts: [
    { key: 'createdAt', label: 'Date', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest first', asc: 'Oldest first' } },
  ],
  columns: [
    { key: 'when', label: 'When', hideable: false },
    { key: 'actor', label: 'Performed by', hideable: true },
    { key: 'action', label: 'Action', hideable: false },
    { key: 'category', label: 'Category', hideable: true },
    { key: 'record', label: 'Record', hideable: true },
  ],
  defaultSort: { key: 'createdAt', direction: 'desc' },
};

const actionColors: Record<string, { bg: string; color: string }> = {
  created: { bg: '#d9f0de', color: '#2a8e44' },
  updated: { bg: '#dbe9fe', color: '#1961ed' },
  deleted: { bg: '#fdded9', color: '#d93025' },
  cancelled: { bg: '#fdded9', color: '#d93025' },
  approved: { bg: '#d9f0de', color: '#2a8e44' },
  accepted: { bg: '#fdf2d4', color: '#946c00' },
  login: { bg: '#f1e6fd', color: '#7d3bc8' },
  logout: { bg: '#f1f1f1', color: '#666666' },
  sent: { bg: '#dbe9fe', color: '#1961ed' },
  confirmed: { bg: '#d9f0de', color: '#2a8e44' },
  rejected: { bg: '#fdded9', color: '#d93025' },
  declined: { bg: '#fdded9', color: '#d93025' },
  withdrawn: { bg: '#f1f1f1', color: '#666666' },
};

function actionColor(action: string) {
  const verb = action?.split('.')[1] ?? '';
  return actionColors[verb] ?? { bg: '#f1f1f1', color: '#666' };
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

interface AuditLogItem {
  id: string;
  action: string;
  actor: { fullName: string } | null;
  metadata: Record<string, unknown>;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
}

export default function AuditLog() {
  const config = AUDIT_LOG_TABLE_CONFIG;
  const { search, filters, sort, page, setSearch, setFilters, setSort, setPage, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);

  // `q` stays a client-side pass over the current page's own rows — the
  // backend has no free-text search across action/actor/metadata (only
  // structured action/entityType/date filters), and this table is already
  // scoped to the caller's own (bounded) activity feed, never org-wide.
  const params = { entityType: filters.entityType, action: filters.action, createdAtFrom: filters.createdAtFrom, createdAtTo: filters.createdAtTo, sort: sort.sort, direction: sort.direction, page, limit: PAGE_SIZE };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['audit-logs', params],
    queryFn: async () => {
      const { data } = await api.get<{ items: AuditLogItem[]; page: number; limit: number; total: number }>('/audit-logs', { params });
      return data;
    },
  });

  const q = search.toLowerCase().trim();
  const items = data?.items ?? [];
  const visible = q
    ? items.filter((log) => `${log.action} ${log.actor?.fullName ?? ''} ${log.metadata?.name ?? ''} ${log.targetType ?? ''}`.toLowerCase().includes(q))
    : items;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title="Audit Log" subtitle={`${total} ${total === 1 ? 'entry' : 'entries'}`} />

      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          <TableViewControls
            config={config}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            activeFilterCount={activeFilterCount}
            columnVisibility={columnVisibility}
          />
        </div>
      </div>

      <div className={`table-container${isFetching ? ' table-loading' : ''}`}>
        {isLoading ? (
          <TableSkeleton columns={5} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('when') && <th style={{ width: 'auto' }}>When</th>}
                {isVisible('actor') && <th>Performed by</th>}
                {isVisible('action') && <th>Action</th>}
                {isVisible('category') && <th>Category</th>}
                {isVisible('record') && <th>Record</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((log) => {
                const c = actionColor(log.action);
                const ac = getColor(log.actor?.fullName || 'A');
                return (
                  <tr key={log.id}>
                    {isVisible('when') && (
                      <td className="cell-muted" style={{ width: 'auto' }} title={new Date(log.createdAt).toLocaleString('en-GB')}>
                        {timeAgo(log.createdAt)}
                      </td>
                    )}
                    {isVisible('actor') && (
                      <td>
                        <span className="user-cell">
                          <span className="round-avatar" style={{ background: ac.bg, color: ac.color }}>
                            {log.actor?.fullName?.[0] ?? '?'}
                          </span>
                          {log.actor?.fullName ?? '–'}
                        </span>
                      </td>
                    )}
                    {isVisible('action') && (
                      <td>
                        <span className="badge" style={{ background: c.bg, color: c.color }}>
                          {log.action?.replace(/[._]/g, ' ')}
                        </span>
                      </td>
                    )}
                    {isVisible('category') && <td className="cell-muted">{log.targetType}</td>}
                    {isVisible('record') && (
                      <td className="cell-muted" style={{ maxWidth: 320 }}>
                        {(log.metadata?.name as string | undefined) ?? (log.targetId ? log.targetId.slice(0, 8) : '–')}
                      </td>
                    )}
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={5}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="timeline" title="No audit entries yet" description="Activity you perform will appear here." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="table-footer">
        <span>{total} {total === 1 ? 'entry' : 'entries'}</span>
        <span style={{ flex: 1 }}/>
        <button className="btn-icon" disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ opacity: page <= 1 ? 0.4 : 1 }}>
          <IconChevronLeft size={14}/>
        </button>
        <span>Page {page} of {pages}</span>
        <button className="btn-icon" disabled={page >= pages} onClick={() => setPage(page + 1)} style={{ opacity: page >= pages ? 0.4 : 1 }}>
          <IconChevronRight size={14}/>
        </button>
      </div>
    </div>
  );
}
