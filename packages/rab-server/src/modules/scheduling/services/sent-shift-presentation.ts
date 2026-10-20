/**
 * Read-only view of canonical shift/offer states; never persisted or used for transitions. `actionExpired` is the
 * server's GENUINE expiry (shift end + SHIFT_ACTION_WINDOW_HOURS passed, or every recipient's latest offer expired with
 * nobody accepted): it removes the shift from the actionable views and labels it "Expired" — the canonical status,
 * assignments and counts are untouched. A request whose staff were all no-shows reads "Staff no-show".
 */
export function sentShiftPresentation(status: string, required: number, counts: Record<string, number>, actionExpired = false) {
  const terminal = ['cancelled', 'completed', 'declined'].includes(status);
  const expired = !terminal && actionExpired;
  const accepted = !terminal && !expired && counts.accepted + counts.confirmed > 0;
  const confirmed = !terminal && required > 0 && counts.confirmed >= required;
  const pending = !terminal && !expired && (status === 'pending_manager_approval' || counts.pending > 0);
  const filters = [
    ...(pending ? ['pending'] : []), ...(accepted ? ['staff_accepted'] : []),
    ...(confirmed ? ['manager_confirmed'] : []),
    ...(status === 'declined' || (!terminal && counts.declined > 0) ? ['declined'] : []),
    ...(status === 'cancelled' || (!terminal && counts.cancelled > 0) ? ['cancelled'] : []),
    ...(status === 'completed' ? ['completed'] : []),
    ...(!terminal && counts.withdrawn > 0 ? ['withdrawn'] : []),
    ...(!terminal && counts.rejected > 0 ? ['manager_rejected'] : []),
    ...(expired ? ['expired'] : []),
  ];
  const noShowOnly = !terminal && !expired && !accepted && (counts.noShow ?? 0) > 0;
  const statusLabel = expired ? 'Expired' : noShowOnly ? 'Staff no-show' : status === 'pending_manager_approval' ? 'Waiting for manager approval'
    : status === 'declined' ? 'Request declined' : status === 'cancelled' ? 'Cancelled'
    : status === 'completed' ? 'Completed' : confirmed ? 'Confirmed'
    : accepted ? 'Staff responses received' : counts.pending > 0 ? 'Offers sent'
    : counts.declined > 0 ? 'Staff declined' : counts.cancelled > 0 ? 'Staff cancelled'
    // Every recipient's latest offer is terminal without acceptance: name the real outcome (never "Expired" unless the
    // request is genuinely expired, which is handled above). A mix with nothing dominant stays "No active offers".
    : counts.sent > 0 && (counts.withdrawn ?? 0) === counts.sent ? 'Offers withdrawn'
    : counts.sent > 0 && (counts.rejected ?? 0) === counts.sent ? 'Offers rejected'
    : counts.sent > 0 ? 'No active offers'
    : 'Approved — awaiting offers';
  return { statusLabel, filters, actionExpired: expired, counters: { sent: counts.sent > 0, accepted, confirmed } };
}
