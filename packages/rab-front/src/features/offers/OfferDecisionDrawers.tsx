import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconCheck } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { getApiErrorMessage } from '../../shared/lib/apiError';
import { useFeedbackMutation } from '../../shared/hooks/useFeedbackMutation';

interface OfferPreview {
  id: string;
  staffName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
}

const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Global Withdraw/Confirm/Reject drawers for a single offer — mounted once
 * in Layout.tsx, same pattern as `BatchOfferDrawer` (a direct flex child of
 * `.app-layout`, not nested inside `Offers.tsx`'s own `.page` div).
 *
 * These three used to be rendered inline inside `Offers.tsx`'s returned
 * JSX, nested inside `<div className="page">` — a `flex-direction: column`
 * container. `Drawer`/`RightSidePanel`'s right-edge docking only works when
 * it's a direct flex child of `.app-layout` (`flex-direction: row`); nested
 * one level deeper inside a column-flex page container, the dock loses that
 * row-flex context and renders in-flow instead, flush against the left edge
 * of whatever box it ends up in — which is exactly what "Confirm shift?
 * opens on the left" was. Moving them here (event-driven, like
 * `open-offer-batch`/`BatchOfferDrawer`) is the same fix `BatchOfferDrawer`'s
 * own doc comment already describes for this exact class of bug.
 *
 * Opened via:
 *   document.dispatchEvent(new CustomEvent('open-offer-withdraw', { detail: { id } }))
 *   document.dispatchEvent(new CustomEvent('open-offer-confirm', { detail: { offer } }))
 *   document.dispatchEvent(new CustomEvent('open-offer-reject', { detail: { offer } }))
 */
export default function OfferDecisionDrawers() {
  const qc = useQueryClient();
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<OfferPreview | null>(null);
  const [rejectTarget, setRejectTarget] = useState<OfferPreview | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    const onWithdraw = (e: Event) => setWithdrawTarget((e as CustomEvent).detail?.id ?? null);
    const onConfirm = (e: Event) => setConfirmTarget((e as CustomEvent).detail?.offer ?? null);
    const onReject = (e: Event) => { setRejectTarget((e as CustomEvent).detail?.offer ?? null); setRejectReason(''); };
    document.addEventListener('open-offer-withdraw', onWithdraw);
    document.addEventListener('open-offer-confirm', onConfirm);
    document.addEventListener('open-offer-reject', onReject);
    return () => {
      document.removeEventListener('open-offer-withdraw', onWithdraw);
      document.removeEventListener('open-offer-confirm', onConfirm);
      document.removeEventListener('open-offer-reject', onReject);
    };
  }, []);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['offers'] });
    qc.invalidateQueries({ queryKey: ['shifts'] });
  };

  // Each decision: one request per click (submit guard), success toast once the server confirms, the server's reason
  // inline in the drawer on failure (errorFeedback false: one announcement, not an inline alert AND a toast). An error
  // is only shown for the offer it belongs to, so it never carries over to the next offer opened.
  const withdraw = useFeedbackMutation<unknown, string>({
    mutationFn: (id) => api.post(`/offers/${id}/withdraw`),
    successMessage: 'Offer withdrawn.',
    errorFeedback: false,
    onSuccess: () => { invalidate(); setWithdrawTarget(null); },
  });

  const confirm = useFeedbackMutation<unknown, string>({
    mutationFn: (id) => api.post(`/offers/${id}/confirm`),
    successMessage: 'Shift confirmed.',
    errorFeedback: false,
    onSuccess: () => { invalidate(); setConfirmTarget(null); },
  });

  const reject = useFeedbackMutation<unknown, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/offers/${id}/reject`, { reason: reason || undefined }),
    successMessage: 'Offer rejected.',
    errorFeedback: false,
    onSuccess: () => { invalidate(); setRejectTarget(null); setRejectReason(''); },
  });

  return (
    <>
      <Drawer
        open={!!withdrawTarget}
        onClose={() => setWithdrawTarget(null)}
        title="Withdraw offer"
        loading={withdraw.busy}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setWithdrawTarget(null)}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={withdraw.busy}
              onClick={() => withdrawTarget && withdraw.submit(withdrawTarget)}
            >
              {withdraw.busy ? 'Withdrawing…' : 'Withdraw offer'}
            </button>
          </>
        }
      >
        <p className="muted">The staff member will no longer be able to accept this offer.</p>
        {withdraw.isError && withdraw.variables === withdrawTarget && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13 }}>
            {getApiErrorMessage(withdraw.error, 'Could not withdraw this offer. It may already have been answered.')}
          </p>
        )}
      </Drawer>

      <Drawer
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        title="Confirm shift?"
        loading={confirm.busy}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setConfirmTarget(null)}>Cancel</button>
            <button className="btn btn-dark" disabled={confirm.busy} onClick={() => confirmTarget && confirm.submit(confirmTarget.id)}>
              <IconCheck size={14} />{confirm.busy ? 'Confirming…' : 'Confirm shift'}
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
        {confirm.isError && confirm.variables === confirmTarget?.id && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13 }}>
            {getApiErrorMessage(confirm.error, 'Could not confirm — the shift may already be full or this offer may have changed status.')}
          </p>
        )}
      </Drawer>

      <Drawer
        open={!!rejectTarget}
        onClose={() => { setRejectTarget(null); setRejectReason(''); }}
        title="Reject accepted offer?"
        dirty={!!rejectReason}
        loading={reject.busy}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => { setRejectTarget(null); setRejectReason(''); }}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={reject.busy}
              onClick={() => rejectTarget && reject.submit({ id: rejectTarget.id, reason: rejectReason })}
            >
              {reject.busy ? 'Rejecting…' : 'Reject offer'}
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
        {reject.isError && reject.variables?.id === rejectTarget?.id && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13 }}>
            {getApiErrorMessage(reject.error, 'Could not reject this offer. Try again.')}
          </p>
        )}
      </Drawer>
    </>
  );
}
