import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';

import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import { adminApi, AUDIT_ACTION_LABELS, formatDateTime, fullName, shortId, type AuditItem } from './adminPanelApi';

function targetText(item: AuditItem): string {
  const org = item.organisationName ? ` · ${item.organisationName}` : '';
  // A user target is shown by name only: the row's organisation is where the event was RECORDED (often the admin's own).
  if (item.target) return item.target.name || shortId(item.target.userId);
  if (item.detail.queue) return `${item.detail.queue}${typeof item.detail.count === 'number' ? ` · ${item.detail.count} job${item.detail.count === 1 ? '' : 's'}` : ''}`;
  if (item.entity) return `${item.entity.type} ${shortId(item.entity.id)}${org}`;
  if (typeof item.detail.resultCount === 'number') return `${item.detail.resultCount} result${item.detail.resultCount === 1 ? '' : 's'}`;
  return item.organisationName ?? '—';
}

/**
 * Admin panel → Audit (mockup v2): every platform-admin action, from `GET /admin/audit` (fixed allowlist, keyset pages
 * of 50). "Filter by admin or target" resolves the typed email/name to ONE user through the (audited) user search, then
 * filters by that user id — the timeline itself never does free-text search. The log cannot be edited or deleted.
 */
export default function AuditTab() {
  const [action, setAction] = useState('');
  const [who, setWho] = useState('');
  const [user, setUser] = useState<{ id: string; label: string } | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['admin', 'audit', action, user?.id ?? ''],
    queryFn: ({ pageParam }) => adminApi.audit({ action: action || undefined, user: user?.id, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items ?? []) ?? [];

  async function applyWho(e: React.FormEvent) {
    e.preventDefault();
    const q = who.trim();
    if (!q) {
      setUser(null);
      return;
    }
    if (q.length < 3) {
      toast.info('Type at least 3 characters.');
      return;
    }
    try {
      const found = await adminApi.searchUsers(q, undefined, 2);
      if (found.length === 0) toast.info('No user matches that name or email.');
      else if (found.length > 1 && found[0]!.email.toLowerCase() !== q.toLowerCase()) toast.info('More than one user matches. Type the full email address.');
      else setUser({ id: found[0]!.id, label: fullName(found[0]!) });
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'The user could not be looked up.'));
    }
  }

  return (
    <section className="ap-block" aria-label="Admin activity">
      <div className="ap-block-head">
        <h2 className="ap-h2">Admin activity</h2>
        <p className="ap-sub">Every action taken from this panel. The log cannot be edited or deleted.</p>
      </div>
      <form className="ap-row" onSubmit={(e) => void applyWho(e)}>
        <select className="ap-input" aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input className="ap-input ap-grow" type="search" placeholder="Filter by admin or target (email or name)" aria-label="Filter audit log" value={who} onChange={(e) => setWho(e.target.value)} />
        <button type="submit" className="ap-btn">Filter</button>
        {user && (
          <button type="button" className="ap-btn ap-sm" onClick={() => { setUser(null); setWho(''); }} aria-label={`Clear filter ${user.label}`}>
            {user.label} ✕
          </button>
        )}
      </form>
      <div className="ap-tablewrap">
        <table className="ap-table">
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
          <tbody>
            {list.isLoading ? (
              <tr><td colSpan={5} className="ap-empty">Loading…</td></tr>
            ) : list.isError ? (
              <tr><td colSpan={5} className="ap-empty">The audit log could not be loaded.</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="ap-empty">No admin activity matches these filters.</td></tr>
            ) : (
              items.map((i) => (
                <tr key={i.id}>
                  <td>{formatDateTime(i.createdAt)}</td>
                  <td>{i.actor ? i.actor.name || shortId(i.actor.userId) : 'System'}</td>
                  <td>{AUDIT_ACTION_LABELS[i.action] ?? i.action}</td>
                  <td>{targetText(i)}</td>
                  <td className="ap-muted">{i.reason ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {list.hasNextPage && (
        <div className="ap-row"><button type="button" className="ap-btn" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>
      )}
    </section>
  );
}
