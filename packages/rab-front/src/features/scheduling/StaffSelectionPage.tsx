import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { EmploymentStatus, UserStatus } from '@rab/shared';
import { api } from '../../shared/api';
import PageHeader from '../../shared/components/PageHeader';
import { TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import './staff-selection.css';

export interface RequestedStaff {
  staffProfileId: string; firstName: string; lastName: string; email: string; stillActive: boolean; available?: boolean; startsAt?: string; endsAt?: string; breakMinutes?: number | null;
}
interface StaffRow {
  id: string; firstName: string; lastName: string; staffRef: string;
  email: string; phone: string | null; defaultPayRatePence: number | null;
  accountStatus: string; employmentStatus: string; createdAt: string; available: boolean;
}
const PAGE_SIZE = 25;

/** Request-scoped draft. Only Confirm persists; approval is a separate action. */
export default function StaffSelectionPage({ shiftId, requiredCount, initialStaff, onCancel, onConfirmed, mode = 'approval' }: {
  shiftId: string; requiredCount: number; initialStaff: RequestedStaff[];
  mode?: 'approval' | 'replacement';
  onCancel: () => void; onConfirmed: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(initialStaff.map((s) => s.staffProfileId)));
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const title = useRef<HTMLDivElement>(null);
  const host = document.querySelector<HTMLElement>('.main-content') ?? document.body;
  useEffect(() => {
    title.current?.focus();
    // Keep the sidebar visible/usable, but never tab into the covered workspace.
    const covered = Array.from(host.children).filter((el) => !el.classList.contains('staff-selection-page')) as HTMLElement[];
    const prior = covered.map((el) => el.inert);
    covered.forEach((el) => { el.inert = true; });
    return () => covered.forEach((el, i) => { el.inert = prior[i]; });
  }, [host]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const staff = useQuery({
    queryKey: ['request-staff-picker', shiftId, query, page],
    queryFn: async () => (await api.get<{ data: StaffRow[]; total: number }>(`/shifts/${shiftId}/selectable-staff`, {
      params: { q: query || undefined, page, limit: PAGE_SIZE },
    })).data,
  });
  // Defense in depth for stale cache/old API responses; the query also filters both fields.
  const rows = (staff.data?.data ?? []).filter((s) => s.accountStatus === UserStatus.ACTIVE && s.employmentStatus === EmploymentStatus.ACTIVE);
  const remaining = Math.max(0, requiredCount - selected.size);
  const save = useMutation({
    mutationFn: async () => {
      if (selected.size > requiredCount) throw new Error('Capacity exceeded');
      if (mode === 'replacement') {
        await api.post(`/shifts/${shiftId}/pipeline/replacements`, { staffProfileIds: [...selected] });
        return;
      }
      await api.put(`/shifts/${shiftId}/requested-staff`, {
        staffProfileIds: [...selected], expectedStaffProfileIds: initialStaff.map((s) => s.staffProfileId),
      });
    },
    onSuccess: onConfirmed,
  });
  const toggle = (id: string) => {
    if (save.isPending) return;
    setSelected((prior) => {
      const next = new Set(prior);
      if (next.has(id)) next.delete(id);
      else if (rows.find((row) => row.id === id)?.available !== true) return prior;
      else if (next.size < requiredCount) next.add(id);
      else { setNotice(`All ${requiredCount} places are selected. Uncheck someone before adding another member of staff.`); return prior; }
      setNotice(''); return next;
    });
  };
  const total = staff.data?.total ?? 0;
  const selectedUnavailable = rows.some((row) => selected.has(row.id) && !row.available);
  return createPortal(
    <section className="staff-selection-page" aria-label="Select staff for shift approval" aria-busy={save.isPending}>
      <div className="staff-selection-topbar">
        <button className="btn btn-outline" disabled={save.isPending} onClick={onCancel}>Cancel</button>
        <button className="btn btn-accent-outline" disabled={(mode === 'replacement' && selected.size === 0) || selectedUnavailable || save.isPending || staff.isPending || staff.isError || rows.length === 0 || selected.size > requiredCount || search.trim() !== query} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving...' : mode === 'replacement' ? 'Send offers' : 'Confirm'}
        </button>
      </div>
      <div ref={title} tabIndex={-1}>
        <PageHeader title="Select Staff" subtitle={<><span>Choose {remaining} staff {remaining === 1 ? 'member' : 'members'}</span><span className="staff-selection-count" role="status">{selected.size} of {requiredCount} selected · {remaining ? `${remaining} remaining` : 'Ready to confirm'}</span></>} />
      </div>
      <div className="staff-selection-tab">Staff <span>Active only</span></div>
      <div className="list-toolbar">
        <div className="toolbar-search"><IconSearch size={14} /><input aria-label="Search staff" placeholder="Search staff..." value={search} onChange={(e) => setSearch(e.target.value)} disabled={save.isPending} /></div>
      </div>
      {selectedUnavailable && <p className="staff-selection-notice" role="status">A selected staff member is unavailable for this shift. Uncheck them and choose a replacement.</p>}
      {notice && <p className="staff-selection-notice" role="status">{notice}</p>}
      {save.isError && <p className="staff-selection-notice error" role="alert">Could not save this selection. Staff eligibility or the request may have changed. Cancel and reopen the request to reload it. Reload the latest saved selection before retrying.</p>}
      <div className="staff-selection-table-wrap">
        {staff.isPending ? <TableSkeleton columns={8} /> : staff.isError ? (
          <div className="staff-selection-empty" role="alert"><h2>Could not load staff</h2><p>Please try again.</p><button className="btn btn-outline" onClick={() => staff.refetch()}>Retry</button></div>
        ) : rows.length === 0 ? (
          <div className="staff-selection-empty"><h2>No active staff available</h2><p>Try adjusting your search or return to the shift request.</p></div>
        ) : <table className="table staff-selection-table">
          <thead><tr><th><span aria-label="Selection" /></th>{['Name', 'Ref', 'Email', 'Phone', 'Rate', 'Status', 'Added'].map((name) => <th scope="col" key={name}>{name}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id} className={selected.has(row.id) ? 'staff-selection-selected' : ''} onClick={() => toggle(row.id)}>
            <td><input type="checkbox" aria-label={`Select ${row.firstName} ${row.lastName}`} checked={selected.has(row.id)} disabled={save.isPending || (!row.available && !selected.has(row.id))} onClick={(e) => e.stopPropagation()} onChange={() => toggle(row.id)} /></td>
            <td><span className="staff-selection-name"><span className="mini-avatar" aria-hidden="true">{row.firstName[0]}</span>{row.firstName} {row.lastName}</span></td>
            <td>{row.staffRef || '—'}</td><td>{row.email}</td><td>{row.phone || '—'}</td>
            <td>{row.defaultPayRatePence == null ? '—' : `£${(row.defaultPayRatePence / 100).toFixed(2)}/hr`}</td>
            <td><span className="badge badge-active">active</span>{!row.available && <span style={{ marginLeft: 8 }}>Unavailable</span>}</td><td>{timeAgo(row.createdAt)}</td>
          </tr>)}</tbody>
        </table>}
      </div>
      <footer className="staff-selection-footer"><span>{selected.size} selected <span aria-hidden="true">·</span> {total} active staff</span><div>
        <button className="btn btn-outline" disabled={page <= 1 || staff.isFetching || save.isPending} onClick={() => setPage((p) => p - 1)}>Previous</button>
        <span>Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
        <button className="btn btn-outline" disabled={page * PAGE_SIZE >= total || staff.isFetching || save.isPending} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div></footer>
    </section>, host,
  );
}
