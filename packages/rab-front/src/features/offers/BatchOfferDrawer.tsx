import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconX, IconHistory, IconUsers } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { toast } from '../../shared/lib/toast';
import { useFeedbackMutation } from '../../shared/hooks/useFeedbackMutation';
import { confirmAllSummary, type ConfirmAllResult } from './confirm-all-summary';
import { DetailSkeleton, ListSkeleton } from '../../shared/components/LoadingState';
import {
  confirmByLabel,
  isWithdrawnAtDeadline,
  mayDecideAcceptedOffer,
  NOT_CONFIRMED_IN_TIME,
  WITHDRAWN_AT_DEADLINE_DETAIL,
  type OfferConfirmationFields,
} from '../../shared/lib/offerConfirmation';

interface BatchRecipient extends OfferConfirmationFields {
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

/** Withdrawn-at-deadline key for the count chips (display only; the server's counts are by persisted status). */
const DEADLINE_KEY = 'not_confirmed_in_time';

/**
 * The server's per-status counts, with the recipients the server reports as withdrawn at the approval deadline moved
 * out of their status (`manager_rejected`, or `staff_accepted` before the Worker has run) into their own chip, so they
 * are neither called "Rejected" nor "Awaiting Confirmation". Nothing is counted that the server did not send.
 */
export function batchStatusCounts(counts: Record<string, number>, recipients: BatchRecipient[]): Array<[string, number]> {
  const out: Record<string, number> = { ...counts };
  const emptied = new Set<string>();
  let withdrawn = 0;
  for (const r of recipients) {
    if (!isWithdrawnAtDeadline(r)) continue;
    withdrawn += 1;
    if ((out[r.status] ?? 0) > 0) {
      out[r.status] -= 1;
      if (out[r.status] === 0) emptied.add(r.status);
    }
  }
  if (withdrawn > 0) out[DEADLINE_KEY] = withdrawn;
  // A chip emptied only by that move disappears ("Rejected: 0" would be noise); every other server count is kept.
  return Object.entries(out).filter(([status]) => !emptied.has(status));
}

/**
 * Audit actions whose raw name would mislead. `offer.rejected_by_worker` is written by the background Worker (never by a
 * staff member, never by a manager) when it closes an acceptance, e.g. one not confirmed before its approval deadline.
 */
const ACTIVITY_LABEL: Record<string, string> = {
  'offer.rejected_by_worker': 'Withdrawn by the system',
};

function OfferActivity({ offerId }: { offerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', 'offer', offerId],
    queryFn: async () => {
      const { data } = await api.get('/audit-logs', { params: { entityType: 'offer', entityId: offerId } });
      return data.items as ActivityLogItem[];
    },
  });

  if (isLoading) return <ListSkeleton rows={2} />;
  if (!data || data.length === 0) return <p className="muted" style={{ fontSize: 12, padding: '4px 0' }}>No activity yet.</p>;

  return (
    <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px', fontSize: 12, color: 'var(--font-secondary)' }}>
      {data.map((item) => (
        <li key={item.id} style={{ marginBottom: 2 }}>
          {ACTIVITY_LABEL[item.action] ?? item.action.replace(/[._]/g, ' ')}
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

  // Every action reports its outcome: a toast after the server confirms, the server's reason when it refuses, and the
  // batch is refreshed either way so the badges never show a stale status.
  const confirmOne = useFeedbackMutation<unknown, string>({
    mutationFn: (offerId) => api.post(`/offers/${offerId}/confirm`),
    successMessage: 'Shift confirmed.',
    errorFeedback: { fallback: 'Could not confirm this offer. The shift may be full or the offer may have changed.' },
    onSettled: invalidate,
  });
  const rejectOne = useFeedbackMutation<unknown, string>({
    mutationFn: (offerId) => api.post(`/offers/${offerId}/reject`),
    successMessage: 'Offer rejected.',
    errorFeedback: { fallback: 'Could not reject this offer. It may have changed.' },
    onSettled: invalidate,
  });
  const confirmAll = useFeedbackMutation<ConfirmAllResult>({
    mutationFn: async () => (await api.post<ConfirmAllResult>(`/offers/batches/${batchId}/confirm-all`)).data,
    errorFeedback: { fallback: 'Could not confirm the accepted offers. Please try again.' },
    onSuccess: (data) => {
      const summary = confirmAllSummary(data?.results ?? []);
      if (summary.partial) toast.warning(summary.text, { persistent: true });
      else toast.success(summary.text);
    },
    onSettled: invalidate,
  });

  // Only the acceptances the server still lets this manager confirm (before the deadline, their own offers).
  const acceptedCount = (batch?.recipients ?? []).filter(mayDecideAcceptedOffer).length;

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
          <button className="btn btn-dark" style={{ marginLeft: 'auto' }} disabled={confirmAll.busy} onClick={() => confirmAll.submit()}>
            <IconCheck size={14} />
            {confirmAll.busy ? 'Confirming…' : `Confirm All Accepted (${acceptedCount})`}
          </button>
        )
      }
    >
      {!batch ? (
        isLoading ? <DetailSkeleton /> : <p className="feedback-error" role="alert" style={{ padding: 16 }}>Batch not found.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {batchStatusCounts(batch.counts, batch.recipients).map(([status, count]) => (
              status === DEADLINE_KEY
                ? <span key={status} className="badge badge-withdrawn">{NOT_CONFIRMED_IN_TIME}: {count}</span>
                : <span key={status} className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}: {count}</span>
            ))}
          </div>

          <div className="field-section-title">Recipients ({batch.recipients.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {batch.recipients.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{r.staffName}</span>
                  {isWithdrawnAtDeadline(r)
                    ? <span className="badge badge-withdrawn">{NOT_CONFIRMED_IN_TIME}</span>
                    : <span className={`badge badge-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>}
                  {mayDecideAcceptedOffer(r) && (
                    <>
                      <button className="btn-icon success" title="Confirm" aria-label={`Confirm ${r.staffName}`} disabled={confirmOne.busy || rejectOne.busy} aria-busy={(confirmOne.busy && confirmOne.variables === r.id) || undefined} onClick={() => confirmOne.submit(r.id)}>
                        <IconCheck size={14} />
                      </button>
                      <button className="btn-icon danger" title="Reject" aria-label={`Reject ${r.staffName}`} disabled={confirmOne.busy || rejectOne.busy} aria-busy={(rejectOne.busy && rejectOne.variables === r.id) || undefined} onClick={() => rejectOne.submit(r.id)}>
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
                {isWithdrawnAtDeadline(r) ? (
                  <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{WITHDRAWN_AT_DEADLINE_DETAIL}</p>
                ) : (r.declineReason || r.rejectionReason) ? (
                  <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{r.declineReason ?? r.rejectionReason}</p>
                ) : null}
                {r.status === 'staff_accepted' && !isWithdrawnAtDeadline(r) && confirmByLabel(r.approvalDeadlineAt) && (
                  <p className="muted offer-confirm-by" style={{ fontSize: 12, margin: '4px 0 0' }}>{confirmByLabel(r.approvalDeadlineAt)}</p>
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
