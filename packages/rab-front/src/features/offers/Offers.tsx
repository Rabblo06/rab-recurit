import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconClock, IconBan, IconCheck, IconX, IconUsers,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import TableViewControls, { TableSearchInput } from '../../shared/table-toolbar/TableToolbar';
import { useTableQueryState } from '../../shared/table-toolbar/useTableQueryState';
import { useColumnVisibility } from '../../shared/table-toolbar/useColumnVisibility';
import type { TableToolbarConfig } from '../../shared/table-toolbar/types';

interface Offer {
  id: string;
  status: string;
  sentAt: string;
  expiresAt: string;
  respondedAt: string | null;
  declineReason: string | null;
  staffAcceptedAt: string | null;
  managerConfirmedAt: string | null;
  managerRejectedAt: string | null;
  rejectionReason: string | null;
  estimatedPayPence: number;
  offerBatchId: string | null;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  venueName: string;
  roleName: string;
  staffProfileId: string;
  staffName: string;
}

function openBatch(batchId: string) {
  document.dispatchEvent(new CustomEvent('open-offer-batch', { detail: { batchId } }));
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

// Real OfferStatus values (@rab/shared) — never invented.
const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending Staff Response' },
  { key: 'staff_accepted', label: 'Awaiting Confirmation' },
  { key: 'manager_confirmed', label: 'Confirmed' },
  { key: 'declined', label: 'Declined' },
  { key: 'manager_rejected', label: 'Rejected' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'expired', label: 'Expired' },
];

// Real OfferStatus values (@rab/shared) — never invented. `status` is
// primarily driven by the tab row above (a better fit for a small set of
// mutually-exclusive states with counts), but still listed here too so
// `useTableQueryState` tracks/round-trips it via the URL like every other
// filter — the Filter popover offering it as a second, equally-valid way to
// set the exact same `status` param is harmless, not a conflict.
const OFFER_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'staff_accepted', label: 'Staff accepted' },
  { value: 'manager_confirmed', label: 'Manager confirmed' },
  { value: 'manager_rejected', label: 'Manager rejected' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const OFFERS_TABLE_CONFIG: TableToolbarConfig = {
  storageKey: 'offers',
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: OFFER_STATUS_OPTIONS },
    { key: 'shiftDate', label: 'Shift date', type: 'dateRange' },
    { key: 'sentAt', label: 'Sent date', type: 'dateRange' },
  ],
  sorts: [
    { key: 'sentAt', label: 'Sent date', directions: ['desc', 'asc'], directionLabels: { desc: 'Newest', asc: 'Oldest' } },
    { key: 'shiftDate', label: 'Shift date', directions: ['asc', 'desc'] },
    { key: 'staff', label: 'Staff', directions: ['asc', 'desc'] },
    { key: 'venue', label: 'Venue', directions: ['asc', 'desc'] },
    { key: 'status', label: 'Status', directions: ['asc', 'desc'] },
  ],
  columns: [
    { key: 'staff', label: 'Staff', hideable: false },
    { key: 'venue', label: 'Venue', hideable: true },
    { key: 'role', label: 'Role', hideable: true },
    { key: 'shiftDate', label: 'Shift date', hideable: true },
    { key: 'time', label: 'Time', hideable: true },
    { key: 'pay', label: 'Est. pay', hideable: true },
    { key: 'status', label: 'Status', hideable: false },
  ],
  defaultSort: { key: 'sentAt', direction: 'desc' },
};

const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function Offers() {
  const qc = useQueryClient();
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Offer | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Offer | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const config = OFFERS_TABLE_CONFIG;
  const { search, filters, sort, setSearch, setFilters, setSort, activeFilterCount } = useTableQueryState(config);
  const columnVisibility = useColumnVisibility(config.storageKey, config.columns);
  const activeStatus = filters.status ?? '';

  const params = { q: search || undefined, ...filters, sort: sort.sort, direction: sort.direction };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['offers', params],
    queryFn: async () => { const { data } = await api.get<{ data: Offer[]; total: number }>('/offers', { params }); return data; },
  });
  const offers = data?.data ?? [];
  const total = data?.total ?? 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['offers'] });
    qc.invalidateQueries({ queryKey: ['shifts'] });
  };

  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/offers/${id}/withdraw`),
    onSuccess: () => { invalidate(); setWithdrawTarget(null); },
  });

  const confirm = useMutation({
    mutationFn: (id: string) => api.post(`/offers/${id}/confirm`),
    onSuccess: () => { invalidate(); setConfirmTarget(null); },
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/offers/${id}/reject`, { reason: reason || undefined }),
    onSuccess: () => { invalidate(); setRejectTarget(null); setRejectReason(''); },
  });

  // "Confirm All Accepted" fires one confirm-all call per distinct batch
  // present in the currently-visible (server-filtered) staff_accepted rows.
  const [confirmingAllBatches, setConfirmingAllBatches] = useState(false);
  const confirmAllBatch = useMutation({
    mutationFn: (batchId: string) => api.post(`/offers/batches/${batchId}/confirm-all`),
  });

  // Sibling count within the currently-fetched page — matches the general
  // "everything scoped to the current server-filtered view" behavior a
  // paginated list already has everywhere else in this app.
  const batchSiblingCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of offers) {
      if (!o.offerBatchId) continue;
      map[o.offerBatchId] = (map[o.offerBatchId] ?? 0) + 1;
    }
    return map;
  }, [offers]);

  const acceptedBatchIds = useMemo(
    () => [...new Set(offers.filter((o) => o.status === 'staff_accepted' && o.offerBatchId).map((o) => o.offerBatchId!))],
    [offers],
  );

  async function handleConfirmAllAccepted() {
    setConfirmingAllBatches(true);
    try {
      for (const batchId of acceptedBatchIds) {
        await confirmAllBatch.mutateAsync(batchId);
      }
      invalidate();
    } finally {
      setConfirmingAllBatches(false);
    }
  }

  const isVisible = columnVisibility.isVisible;
  const isFiltered = activeFilterCount > 0 || Boolean(search);

  return (
    <div className="page">
      <PageHeader title="Offers" subtitle={`${total} offer${total === 1 ? '' : 's'}`} />
      <Drawer
        open={!!withdrawTarget}
        onClose={() => setWithdrawTarget(null)}
        title="Withdraw offer"
        loading={withdraw.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setWithdrawTarget(null)}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={withdraw.isPending}
              onClick={() => withdrawTarget && withdraw.mutate(withdrawTarget)}
            >
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw offer'}
            </button>
          </>
        }
      >
        <p className="muted">The staff member will no longer be able to accept this offer.</p>
      </Drawer>

      <Drawer
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        title="Confirm shift?"
        loading={confirm.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setConfirmTarget(null)}>Cancel</button>
            <button className="btn btn-dark" disabled={confirm.isPending} onClick={() => confirmTarget && confirm.mutate(confirmTarget.id)}>
              <IconCheck size={14} />{confirm.isPending ? 'Confirming…' : 'Confirm shift'}
            </button>
          </>
        }
      >
        {confirmTarget && (
          <>
            <p className="muted">
              <strong style={{ color: 'var(--font-primary)' }}>{confirmTarget.staffName}</strong> has accepted this offer at{' '}
              <strong style={{ color: 'var(--font-primary)' }}>{confirmTarget.venueName}</strong> on {fmtDate(confirmTarget.startsAt)},{' '}
              {fmtTime(confirmTarget.startsAt)}–{fmtTime(confirmTarget.endsAt)}.
            </p>
            <p className="muted">Confirming will make the shift officially confirmed and visible in the staff member&apos;s upcoming shifts.</p>
          </>
        )}
        {confirm.isError && (
          <p role="alert" style={{ color: 'var(--color-red)', fontSize: 13 }}>
            {(confirm.error as any)?.response?.data?.message ?? 'Could not confirm — the shift may already be full or this offer may have changed status.'}
          </p>
        )}
      </Drawer>

      <Drawer
        open={!!rejectTarget}
        onClose={() => { setRejectTarget(null); setRejectReason(''); }}
        title="Reject accepted offer?"
        dirty={!!rejectReason}
        loading={reject.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => { setRejectTarget(null); setRejectReason(''); }}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason })}
            >
              {reject.isPending ? 'Rejecting…' : 'Reject offer'}
            </button>
          </>
        }
      >
        {rejectTarget && (
          <p className="muted">
            {rejectTarget.staffName} will be notified that their shift at {rejectTarget.venueName} on {fmtDate(rejectTarget.startsAt)} was not confirmed.
          </p>
        )}
        <div className="field">
          <label>Reason (optional)</label>
          <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="e.g. Venue reduced headcount" />
        </div>
        {reject.isError && (
          <p role="alert" style={{ color: 'var(--color-red)', fontSize: 13 }}>
            {(reject.error as any)?.response?.data?.message ?? 'Could not reject this offer. Try again.'}
          </p>
        )}
      </Drawer>

      <div className="list-tabs-row">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-link ${activeStatus === t.key ? 'active' : ''}`}
            onClick={() => setFilters(t.key ? { ...filters, status: t.key } : { ...filters, status: undefined as unknown as string })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="list-toolbar-row">
        <TableSearchInput value={search} onChange={setSearch} />
        <div className="list-toolbar-actions">
          {activeStatus === 'staff_accepted' && acceptedBatchIds.length > 0 && (
            <button className="btn btn-dark" disabled={confirmingAllBatches} onClick={handleConfirmAllAccepted}>
              <IconCheck size={14} />
              {confirmingAllBatches ? 'Confirming…' : `Confirm All Accepted (${offers.length})`}
            </button>
          )}
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
          <TableSkeleton columns={8} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {isVisible('staff') && <th>Staff</th>}
                {isVisible('venue') && <th>Venue</th>}
                {isVisible('role') && <th>Role</th>}
                {isVisible('shiftDate') && <th>Shift date</th>}
                {isVisible('time') && <th>Time</th>}
                {isVisible('pay') && <th>Est. pay</th>}
                {isVisible('status') && <th>Status</th>}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const c = getColor(o.staffName);
                return (
                  <tr key={o.id}>
                    {isVisible('staff') && (
                      <td>
                        <span className="user-cell">
                          <span className="round-avatar" style={{ background: c.bg, color: c.color }}>{o.staffName?.[0]}</span>
                          {o.staffName}
                        </span>
                      </td>
                    )}
                    {isVisible('venue') && (
                      <td>
                        <span className="record-chip">
                          <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{o.venueName?.[0]}</span>
                          {o.venueName}
                        </span>
                      </td>
                    )}
                    {isVisible('role') && <td className="cell-muted">{o.roleName}</td>}
                    {isVisible('shiftDate') && <td className="cell-muted">{fmtDate(o.startsAt)}</td>}
                    {isVisible('time') && <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(o.startsAt)}–{fmtTime(o.endsAt)}</span></td>}
                    {isVisible('pay') && <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(o.estimatedPayPence)}</td>}
                    {isVisible('status') && (
                      <td>
                        <span className={`badge badge-${o.status}`}>{o.status.replace(/_/g, ' ')}</span>
                        {o.status === 'staff_accepted' && o.staffAcceptedAt && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>Staff accepted {timeAgo(o.staffAcceptedAt)}</span>
                        )}
                        {o.status === 'declined' && o.declineReason && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>{o.declineReason}</span>
                        )}
                        {o.status === 'manager_rejected' && o.rejectionReason && (
                          <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>{o.rejectionReason}</span>
                        )}
                      </td>
                    )}
                    <td>
                      <div className="row-actions action-btns">
                        {o.offerBatchId && batchSiblingCount[o.offerBatchId]! >= 2 && (
                          <button className="btn-icon" title={`View batch (${batchSiblingCount[o.offerBatchId]} recipients)`} onClick={() => openBatch(o.offerBatchId!)}>
                            <IconUsers size={14} />
                          </button>
                        )}
                        {o.status === 'pending' && (
                          <button className="btn-icon danger" title="Withdraw offer" onClick={() => setWithdrawTarget(o.id)}>
                            <IconBan size={14} />
                          </button>
                        )}
                        {o.status === 'staff_accepted' && (
                          <>
                            <button className="btn-icon success" title="Confirm shift" onClick={() => setConfirmTarget(o)}>
                              <IconCheck size={14} />
                            </button>
                            <button className="btn-icon danger" title="Reject" onClick={() => setRejectTarget(o)}>
                              <IconX size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {offers.length === 0 && (
                <tr><td colSpan={8}>
                  {isFiltered ? (
                    <EmptyState
                      variant="matches"
                      title="No results match these filters."
                      description="Try different values, or clear filters to see the full list."
                      action={<button className="btn btn-outline" onClick={() => { setSearch(''); setFilters({}); }}>Clear filters</button>}
                    />
                  ) : (
                    <EmptyState variant="inbox" title="No offers in this view" description="Offers matching this status will appear here." />
                  )}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{total}</strong></span>
      </div>
    </div>
  );
}
