import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatWeekdayList } from '@rab/shared';
import './availability-conflict.css';

/**
 * The server's `STAFF_AVAILABILITY_CONFLICT` (409) body: one or more recipients fall outside their declared weekday
 * availability. Nothing was dispatched. "Send anyway" re-sends the same request with those exact dates acknowledged; the
 * server recomputes at dispatch, so a stale acknowledgement (shift moved) simply produces a fresh warning.
 */
export interface AvailabilityConflict {
  code: 'STAFF_AVAILABILITY_CONFLICT';
  message: string;
  totalRecipients: number;
  conflicts: { staffProfileId: string; staffName: string; availableDays: string[]; conflictDates: { date: string; weekday: string }[] }[];
  unknownAvailability: { staffProfileId: string; staffName: string }[];
}

export type AvailabilityAcknowledgement = { staffProfileId: string; dates: string[] };

export function readAvailabilityConflict(error: unknown): AvailabilityConflict | null {
  const response = (error as { response?: { status?: number; data?: Partial<AvailabilityConflict> } } | null)?.response;
  const data = response?.data;
  if (response?.status !== 409 || data?.code !== 'STAFF_AVAILABILITY_CONFLICT' || !Array.isArray(data.conflicts)) return null;
  return { unknownAvailability: [], totalRecipients: data.conflicts.length, ...data } as AvailabilityConflict;
}

export function availabilityAcknowledgements(conflict: AvailabilityConflict): AvailabilityAcknowledgement[] {
  return conflict.conflicts.map((c) => ({ staffProfileId: c.staffProfileId, dates: c.conflictDates.map((d) => d.date) }));
}

/** "Monday 19 October" — the date is a London calendar day (YYYY-MM-DD); noon UTC keeps it on that day everywhere. */
function formatConflictDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`));
}

export function AvailabilityConflictDialog({
  conflict,
  confirmLabel = 'Send anyway',
  onCancel,
  onConfirm,
}: {
  conflict: AvailabilityConflict | null;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!conflict) return;
    // Capture phase + preventDefault: Escape cancels this dialog only, never also the drawer underneath it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [conflict, onCancel]);

  if (!conflict) return null;
  const single = conflict.totalRecipients === 1 && conflict.conflicts.length === 1 ? conflict.conflicts[0] : null;

  // Portalled to <body>, above the right-side drawer it is raised from (the drawer dock stacks above a plain .modal-overlay).
  return createPortal(
    <div className="modal-overlay availability-conflict-overlay" data-rab-portal="" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal availability-conflict" role="alertdialog" aria-modal="true" aria-labelledby="availability-conflict-title" aria-describedby="availability-conflict-body">
        <h3 id="availability-conflict-title">Staff availability warning</h3>
        <div id="availability-conflict-body" className="availability-conflict__body">
          {single ? (
            <>
              <p>
                {single.staffName} has marked themselves as unavailable on {formatWeekdayList([...new Set(single.conflictDates.map((d) => d.weekday))])}.
              </p>
              <p>Available days: {formatWeekdayList(single.availableDays)}.</p>
            </>
          ) : (
            <>
              <p className="availability-conflict__summary">
                {conflict.conflicts.length} of {conflict.totalRecipients} selected Staff have availability conflicts.
              </p>
              <ul className="availability-conflict__list" aria-label="Staff with availability conflicts">
                {conflict.conflicts.map((c) => (
                  <li key={c.staffProfileId}>
                    <strong>{c.staffName}</strong>
                    <span>Unavailable on {c.conflictDates.map((d) => formatConflictDate(d.date)).join(', ')}</span>
                    <span>Available days: {formatWeekdayList(c.availableDays)}</span>
                  </li>
                ))}
              </ul>
              {conflict.unknownAvailability.length > 0 && (
                <p className="availability-conflict__note">
                  {conflict.unknownAvailability.length} selected {conflict.unknownAvailability.length === 1 ? 'person has' : 'people have'} not provided
                  availability — that is not treated as unavailable.
                </p>
              )}
            </>
          )}
          <p>You can cancel or choose to {confirmLabel === 'Send anyway' ? 'send the offer anyway' : confirmLabel.toLowerCase()}.</p>
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onCancel} autoFocus>Cancel</button>
          <button className="btn btn-dark" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Wires the warning into a mutation: `intercept(error, resend)` in `onError` returns true (and opens the dialog) when the
 * error is an availability conflict; "Send anyway" calls `resend(acknowledgements)` — the same request again, through the
 * same authorised endpoint. Cancel closes it; nothing was dispatched.
 */
export function useAvailabilityConflictGate(confirmLabel?: string) {
  const [pending, setPending] = useState<{ conflict: AvailabilityConflict; resend: (acks: AvailabilityAcknowledgement[]) => void } | null>(null);
  const intercept = (error: unknown, resend: (acks: AvailabilityAcknowledgement[]) => void): boolean => {
    const conflict = readAvailabilityConflict(error);
    if (!conflict) return false;
    setPending({ conflict, resend });
    return true;
  };
  const dialog = (
    <AvailabilityConflictDialog
      conflict={pending?.conflict ?? null}
      confirmLabel={confirmLabel}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        if (!pending) return;
        const { conflict, resend } = pending;
        setPending(null);
        resend(availabilityAcknowledgements(conflict));
      }}
    />
  );
  return { intercept, dialog };
}
