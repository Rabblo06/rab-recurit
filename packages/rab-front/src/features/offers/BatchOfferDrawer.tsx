import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconX, IconHistory, IconUsers } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';

interface BatchRecipient {
  id: string;
  status: string;
  staffName: string;
  staffProfileId: string;
  rejectionReason: string | null;
  declineReason: string | null;
}

interface BatchSummary {
  batchId: string;
  shift: { id: string; startsAt: string; endsAt: string; venueName: string; roleName: string } | null;
  counts: Record<string, number>;
  recipients: BatchRecipient[];
}

interface ActivityLogItem {
  id: string;
  action: string;
  actor: { fullName: string } | null;
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  staff_accepted: 'Awaiting Confirmation',
  manager_confirmed: 'Confirmed',
  manager_rejected: 'Rejected',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
};

const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function OfferActivity({ offerId }: { offerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', 'offer', offerId],
    queryFn: async () => {
      const { data } = await api.get('/audit-logs', { params: { entityType: 'offer', entityId: offerId } });
      return data.items as ActivityLogItem[];
    },
  });

  if (isLoading) return <p className="muted" style={{ fontSize: 12, padding: '4px 0' }}>Loading…</p>;
  if (!data || data.length === 0) return <p className="muted" style={{ fontSize: 12, padding: '4px 0' }}>No activity yet.</p>;

  return (
    <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px', fontSize: 12, color: 'var(--font-secondary)' }}>
      {data.map((item) => (
        <li key={item.id} style={{ marginBottom: 2 }}>
          {item.action.replace(/[._]/g, ' ')}
          {item.actor ? ` — ${item.actor.fullName}` : ''}
          {' · '}
          {new Date(item.createdAt).toLocaleString('en-GB')}
        </li>
      ))}
    </ul>
  );
}

/**
 * Global batch-summary drawer — mounted once in Layout.tsx, same pattern as
 * CreateVenueDrawer/ShiftDrawers (a direct flex child of `.app-layout`, not
 * nested inside Offers.tsx/Shifts.tsx). Opened via:
 *   document.dispatchEvent(new CustomEvent('open-offer-batch', { detail: { batchId } }))
 */
export default function BatchOfferDrawer() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [expandedOfferId, setExpandedOfferId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.batchId as string | undefined;
      if (!id) return;
      setBatchId(id);
      setExpandedOfferId(null);
      setOpen(true);
    };
    document.addEventListener('open-offer-batch', handler);
    return () => document.removeEventListener('open-offer-batch', handler);
  }, []);

  const { data: batch, isLoading } = useQuery({
    queryKey: ['offer-batch', batchId],
    queryFn: async () => { const { data } = await api.get<BatchSummary>(`/offers/batches/${batchId}`); return data; },
    enabled: !!batchId && open,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['offer-batch', batchId] });
    qc.invalidateQueries({ queryKey: ['offers'] });
    qc.invalidateQueries({ queryKey: ['shifts'] });
  };

  const confirmOne = useMutation({
    mutationFn: (offerId: string) => api.post(`/offers/${offerId}/confirm`),
    onSuccess: invalidate,
  });
  const rejectOne = useMutation({
    mutationFn: (offerId: string) => api.post(`/offers/${offerId}/reject`),
    onSuccess: invalidate,
  });
  const confirmAll = useMutation({
    mutationFn: () => api.post(`/offers/batches/${batchId}/confirm-all`),
    onSuccess: invalidate,
  });

  const acceptedCount = batch?.counts.staff_accepted ?? 0;

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title={batch?.shift ? `${batch.shift.venueName} · ${batch.shift.roleName}` : 'Offer batch'}
      description={batch?.shift ? `${fmtDate(batch.shift.startsAt)}, ${fmtTime(batch.shift.startsAt)}–${fmtTime(batch.shift.endsAt)}` : undefined}
      icon={<IconUsers size={16} color="var(--font-tertiary)" />}
      loading={isLoading}
      footer={
        acceptedCount > 0 && (
          <button className="btn btn-dark" style={{ marginLeft: 'auto' }} disabled={confirmAll.isPending} onClick={() => confirmAll.mutate()}>
            <IconCheck size={14} />
            {confirmAll.isPending ? 'Confirming…' : `Confirm All Accepted (${acceptedCount})`}
          </button>
        )
      }
    >
      {!batch ? (
        <p className="muted" style={{ padding: 16 }}>{isLoading ? 'Loading…' : 'Batch not found.'}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(batch.counts).map(([status, count]) => (
              <span key={status} className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}: {count}</span>
            ))}
          </div>

          <div className="field-section-title">Recipients ({batch.recipients.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {batch.recipients.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{r.staffName}</span>
                  <span className={`badge badge-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.status === 'staff_accepted' && (
                    <>
                      <button className="btn-icon success" title="Confirm" disabled={confirmOne.isPending} onClick={() => confirmOne.mutate(r.id)}>
                        <IconCheck size={14} />
                      </button>
                      <button className="btn-icon danger" title="Reject" disabled={rejectOne.isPending} onClick={() => rejectOne.mutate(r.id)}>
                        <IconX size={14} />
                      </button>
                    </>
                  )}
                  <button
                    className="btn-icon"
                    title="View activity"
                    onClick={() => setExpandedOfferId((cur) => (cur === r.id ? null : r.id))}
                  >
                    <IconHistory size={14} />
                  </button>
                </div>
                {(r.declineReason || r.rejectionReason) && (
                  <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{r.declineReason ?? r.rejectionReason}</p>
                )}
                {expandedOfferId === r.id && <OfferActivity offerId={r.id} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}
