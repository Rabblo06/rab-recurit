import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../../shared/api';
import PageHeader from '../../shared/components/PageHeader';
import { TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import { notifyApiError } from '../../shared/lib/mutationFeedback';
import './venue-manager-staff-picker.css';

interface StaffRow {
  id: string; firstName: string; lastName: string; staffRef: string; email: string; phone: string | null;
  employmentStatus: string; accountStatus: string; createdAt: string;
}
const PAGE_SIZE = 25;
const ASSIGNABLE_EMPLOYMENT = new Set(['active', 'pending_compliance']);
const ASSIGNABLE_ACCOUNT = new Set(['active', 'invited']);

/**
 * Full-page "Select Staff" for a Venue Manager's team (same pattern as the shift staff picker). Lists the caller's own
 * workspace staff (GET /staff); people already on the team are shown checked and locked. Confirm assigns only the newly
 * ticked staff (POST /venue-managers/:id/staff, owner-only and re-validated on the server). Cancel changes nothing.
 */
export default function VenueManagerStaffPicker({ venueManagerId, venueManagerName, assignedIds, onCancel, onConfirmed }: {
  venueManagerId: string; venueManagerName: string; assignedIds: Set<string>;
  onCancel: () => void; onConfirmed: (added: number) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const title = useRef<HTMLDivElement>(null);
  const host = document.querySelector<HTMLElement>('.main-content') ?? document.body;

  useEffect(() => {
    title.current?.focus();
    const covered = Array.from(host.children).filter((el) => !el.classList.contains('vm-staff-picker')) as HTMLElement[];
    const prior = covered.map((el) => el.inert);
    covered.forEach((el) => { el.inert = true; });
    return () => covered.forEach((el, i) => { el.inert = prior[i]!; });
  }, [host]);
  useEffect(() => {
    const t = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const staff = useQuery({
    queryKey: ['staff', 'vm-team-picker', query, page],
    queryFn: async () => (await api.get<{ data: StaffRow[]; total: number }>('/staff', { params: { q: query || undefined, page, limit: PAGE_SIZE } })).data,
  });
  const rows = (staff.data?.data ?? []).filter((s) => ASSIGNABLE_EMPLOYMENT.has(s.employmentStatus) && ASSIGNABLE_ACCOUNT.has(s.accountStatus));
  const total = staff.data?.total ?? 0;
  const assign = useMutation({
    mutationFn: async () => (await api.post<{ added: string[] }>(`/venue-managers/${venueManagerId}/staff`, { staffProfileIds: [...selected] })).data,
    onSuccess: (r) => onConfirmed(r.added.length),
    // Was silent: a refused or failed assignment now says so, and the selection stays for another try.
    onError: (e) => { notifyApiError(e, { fallback: 'Could not add these staff members. Please try again.' }); },
  });
  const toggle = (id: string) => {
    if (assign.isPending || assignedIds.has(id)) return;
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  return createPortal(
    // Portaled outside the detail panel: `data-rab-portal` stops RightSidePanel's outside-click from closing the panel
    // (and unmounting this picker) on every row click; Escape cancels the picker only, not the panel underneath.
    <section className="vm-staff-picker" data-rab-portal="true" aria-label={`Select staff for ${venueManagerName}`} aria-busy={assign.isPending}
      onKeyDown={(e) => { if (e.key === 'Escape' && !assign.isPending) { e.preventDefault(); onCancel(); } }}>
      <div className="vm-staff-picker-topbar">
        <button className="btn btn-outline" disabled={assign.isPending} onClick={onCancel}>Cancel</button>
        <button className="btn btn-accent-outline" disabled={selected.size === 0 || assign.isPending} onClick={() => assign.mutate()}>
          {assign.isPending ? 'Saving...' : 'Confirm'}
        </button>
      </div>
      <div ref={title} tabIndex={-1}>
        <PageHeader inline title="Select Staff" subtitle={<><span>Choose the staff {venueManagerName} can see and select</span><span className="vm-staff-picker-count" role="status">{selected.size} selected · {assignedIds.size} already assigned</span></>} />
      </div>
      <div className="vm-staff-picker-tab">Staff <span>Your workspace</span></div>
      <div className="list-toolbar vm-staff-picker-toolbar">
        <div className="toolbar-search"><IconSearch size={14} /><input aria-label="Search staff" placeholder="Search staff..." value={search} onChange={(e) => setSearch(e.target.value)} disabled={assign.isPending} /></div>
      </div>
      {assign.isError && <p className="vm-staff-picker-notice error" role="alert">Could not assign the selected staff. Their status may have changed — Cancel and try again.</p>}
      <div className="vm-staff-picker-table-wrap">
        {staff.isPending ? <TableSkeleton columns={7} /> : staff.isError ? (
          <div className="vm-staff-picker-empty" role="alert"><h2>Could not load staff</h2><button className="btn btn-outline" onClick={() => staff.refetch()}>Retry</button></div>
        ) : rows.length === 0 ? (
          <div className="vm-staff-picker-empty"><h2>No assignable staff</h2><p>{query ? 'Try a different search.' : 'Create staff in Users first.'}</p></div>
        ) : (
          <table className="table vm-staff-picker-table">
            <thead><tr><th><span aria-label="Selection" /></th>{['Name', 'Ref', 'Email', 'Phone', 'Status', 'Added'].map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((row) => {
              const already = assignedIds.has(row.id);
              const checked = already || selected.has(row.id);
              return (
                <tr key={row.id} className={checked ? 'vm-staff-picker-selected' : ''} onClick={() => toggle(row.id)}>
                  <td><input type="checkbox" aria-label={`Select ${row.firstName} ${row.lastName}`} checked={checked} disabled={already || assign.isPending}
                    onClick={(e) => e.stopPropagation()} onChange={() => toggle(row.id)} /></td>
                  <td><span className="vm-staff-picker-name"><span className="mini-avatar" aria-hidden="true">{row.firstName[0]}</span>{row.firstName} {row.lastName}</span></td>
                  <td>{row.staffRef || '—'}</td><td>{row.email}</td><td>{row.phone || '—'}</td>
                  <td>{already ? <span className="badge badge-active">Assigned</span> : <span className={`badge ${row.accountStatus === 'active' ? 'badge-active' : 'badge-pending'}`}>{row.accountStatus === 'active' ? 'active' : 'invited'}</span>}</td>
                  <td>{timeAgo(row.createdAt)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      <footer className="vm-staff-picker-footer"><span>{selected.size} selected <span aria-hidden="true">·</span> {total} staff</span><div>
        <button className="btn btn-outline" disabled={page <= 1 || staff.isFetching} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span>Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
        <button className="btn btn-outline" disabled={page * PAGE_SIZE >= total || staff.isFetching} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div></footer>
    </section>,
    host,
  );
}
