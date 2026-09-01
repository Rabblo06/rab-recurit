import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconClock, IconBan, IconCheck, IconX, IconUsers, IconSearch,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';

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

const FILTERS: { key: string; label: string; match: (o: Offer) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'pending', label: 'Pending Staff Response', match: (o) => o.status === 'pending' },
  { key: 'staff_accepted', label: 'Awaiting Confirmation', match: (o) => o.status === 'staff_accepted' },
  { key: 'manager_confirmed', label: 'Confirmed', match: (o) => o.status === 'manager_confirmed' },
  { key: 'declined', label: 'Declined', match: (o) => o.status === 'declined' },
  { key: 'manager_rejected', label: 'Rejected', match: (o) => o.status === 'manager_rejected' },
  { key: 'withdrawn', label: 'Withdrawn', match: (o) => o.status === 'withdrawn' },
  { key: 'expired', label: 'Expired', match: (o) => o.status === 'expired' },
];

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
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { data: offers = [], isLoading } = useQuery({
    queryKey: ['offers'],
    queryFn: async () => { const { data } = await api.get<Offer[]>('/offers'); return data; },
  });

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
  // present in the currently-visible staff_accepted rows — a batch is the
  // one thing the endpoint understands, so a mixed view (rare — usually one
  // "send to N staff" action produces one batch) just becomes N sequential
  // calls, still a single user action.
  const [confirmingAllBatches, setConfirmingAllBatches] = useState(false);
  const confirmAllBatch = useMutation({
    mutationFn: (batchId: string) => api.post(`/offers/batches/${batchId}/confirm-all`),
  });

  const visibleOffers = useMemo(() => {
    const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!;
    const q = search.toLowerCase();
    return offers.filter(active.match).filter((o) => !q
      || o.staffName?.toLowerCase().includes(q)
      || o.venueName?.toLowerCase().includes(q)
      || o.roleName?.toLowerCase().includes(q));
  }, [offers, filter, search]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const f of FILTERS) map[f.key] = offers.filter(f.match).length;
    return map;
  }, [offers]);

  // How many offers (any status) share a given batch — used to decide
  // whether a row's "View batch" affordance is worth showing at all.
  const batchSiblingCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of offers) {
      if (!o.offerBatchId) continue;
      map[o.offerBatchId] = (map[o.offerBatchId] ?? 0) + 1;
    }
    return map;
  }, [offers]);

  const acceptedBatchIds = useMemo(
    () => [...new Set(visibleOffers.filter((o) => o.status === 'staff_accepted' && o.offerBatchId).map((o) => o.offerBatchId!))],
    [visibleOffers],
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

  return (
    <div className="page">
      <PageHeader title="Offers" subtitle={`${offers.length} offer${offers.length === 1 ? '' : 's'}`} />
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
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`tab-link ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}{counts[f.key] ? ` (${counts[f.key]})` : ''}
          </button>
        ))}
      </div>

      <div className="list-toolbar-row">
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="list-toolbar-actions">
          {filter === 'staff_accepted' && acceptedBatchIds.length > 0 && (
            <button className="btn btn-dark" disabled={confirmingAllBatches} onClick={handleConfirmAllAccepted}>
              <IconCheck size={14} />
              {confirmingAllBatches ? 'Confirming…' : `Confirm All Accepted (${visibleOffers.length})`}
            </button>
          )}
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {isLoading ? (
          <TableSkeleton columns={8} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Staff</th>
                <th>Venue</th>
                <th>Role</th>
                <th>Shift date</th>
                <th>Time</th>
                <th>Est. pay</th>
                <th>Status</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {visibleOffers.map((o) => {
                const c = getColor(o.staffName);
                return (
                  <tr key={o.id}>
                    <td>
                      <span className="user-cell">
                        <span className="round-avatar" style={{ background: c.bg, color: c.color }}>{o.staffName?.[0]}</span>
                        {o.staffName}
                      </span>
                    </td>
                    <td>
                      <span className="record-chip">
                        <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{o.venueName?.[0]}</span>
                        {o.venueName}
                      </span>
                    </td>
                    <td className="cell-muted">{o.roleName}</td>
                    <td className="cell-muted">{fmtDate(o.startsAt)}</td>
                    <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(o.startsAt)}–{fmtTime(o.endsAt)}</span></td>
                    <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(o.estimatedPayPence)}</td>
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
              {visibleOffers.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState
                    variant={search ? 'matches' : 'inbox'}
                    title={search ? 'No offers found' : 'No offers in this view'}
                    description={search ? 'Try a different staff, venue, or role.' : 'Offers matching this status will appear here.'}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{visibleOffers.length}</strong></span>
      </div>
    </div>
  );
}
