/** Read-only view of canonical shift/offer states; never persisted or used for transitions. */
export function sentShiftPresentation(status: string, required: number, counts: Record<string, number>) {
  const terminal = ['cancelled', 'completed', 'declined'].includes(status);
  const accepted = !terminal && counts.accepted + counts.confirmed > 0;
  const confirmed = !terminal && required > 0 && counts.confirmed >= required;
  const pending = !terminal && (status === 'pending_manager_approval' || counts.pending > 0);
  const filters = [
    ...(pending ? ['pending'] : []), ...(accepted ? ['staff_accepted'] : []),
    ...(confirmed ? ['manager_confirmed'] : []),
    ...(status === 'declined' || (!terminal && counts.declined > 0) ? ['declined'] : []),
    ...(status === 'cancelled' || (!terminal && counts.cancelled > 0) ? ['cancelled'] : []),
    ...(status === 'completed' ? ['completed'] : []),
    ...(!terminal && counts.expired > 0 ? ['expired'] : []),
    ...(!terminal && counts.withdrawn > 0 ? ['withdrawn'] : []),
    ...(!terminal && counts.rejected > 0 ? ['manager_rejected'] : []),
  ];
  const statusLabel = status === 'pending_manager_approval' ? 'Waiting for manager approval'
    : status === 'declined' ? 'Request declined' : status === 'cancelled' ? 'Cancelled'
    : status === 'completed' ? 'Completed' : confirmed ? 'Confirmed'
    : accepted ? 'Staff responses received' : counts.pending > 0 ? 'Offers sent'
    : counts.declined > 0 ? 'Staff declined' : counts.cancelled > 0 ? 'Staff cancelled' : counts.sent > 0 ? 'No active offers'
    : 'Approved — awaiting offers';
  return { statusLabel, filters, counters: { sent: counts.sent > 0, accepted, confirmed } };
}
