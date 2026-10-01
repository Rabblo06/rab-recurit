import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconCheck } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';

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

  return (
    <>
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
    </>
  );
}
