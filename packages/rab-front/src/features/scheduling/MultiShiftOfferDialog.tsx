import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmploymentStatus, UserStatus } from '@rab/shared';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import ModalFrame from '../../shared/components/ModalFrame';
import { readAvailabilityConflict, useAvailabilityConflictGate, type AvailabilityAcknowledgement } from './AvailabilityConflictDialog';
import './multi-shift-offer.css';

export interface OfferableShift { id: string; startsAt: string; endsAt: string; venueName: string; roleName: string; status: string }
interface StaffRow { id: string; firstName: string; lastName: string; accountStatus: string; employmentStatus: string }
interface RowResult { shiftId: string; staffProfileId: string; ok: boolean; message?: string }

/** Statuses a shift may receive offers in (the server re-checks; this only explains a disabled row up front). */
const OFFERABLE = new Set(['open', 'offered', 'partially_filled']);

/** The server's 409 for a refused multi-shift send: nothing was sent, every row says why. */
export function readBulkOfferRejection(error: unknown): { message: string; results: RowResult[] } | null {
  const response = (error as { response?: { status?: number; data?: { code?: string; message?: string; results?: RowResult[] } } } | null)?.response;
  if (response?.status !== 409 || response.data?.code !== 'BULK_OFFER_REJECTED' || !Array.isArray(response.data.results)) return null;
  return { message: response.data.message ?? 'Nothing was sent.', results: response.data.results };
}

const when = (shift: OfferableShift) =>
  `${new Date(shift.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${new Date(shift.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

/**
 * Offer the same staff to several shifts at once (`POST /offers/send-to-shifts`). All or nothing: if any offer can't be
 * sent, nothing is sent and every shift/person pair is listed with the reason. Offers are pending until the staff member
 * accepts and a manager confirms, exactly like a single send.
 */
export default function MultiShiftOfferDialog({ open, shifts, onClose, onSent }: { open: boolean; shifts: OfferableShift[]; onClose: () => void; onSent: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejection, setRejection] = useState<{ message: string; results: RowResult[] } | null>(null);
  const availability = useAvailabilityConflictGate('Send anyway');

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setRejection(null);
    setSearch('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const staff = useQuery({
    queryKey: ['multi-shift-offer-staff', search],
    enabled: open,
    queryFn: async () =>
      (await api.get<{ data: StaffRow[]; total: number }>('/staff', {
        params: { q: search.trim() || undefined, page: 1, limit: 50, status: EmploymentStatus.ACTIVE, accountStatus: UserStatus.ACTIVE },
      })).data,
  });
  const people = (staff.data?.data ?? []).filter((s) => s.accountStatus === UserStatus.ACTIVE && s.employmentStatus === EmploymentStatus.ACTIVE);
  const nameOf = (id: string) => {
    const person = people.find((p) => p.id === id);
    return person ? `${person.firstName} ${person.lastName}` : 'Selected staff member';
  };
  const offerable = shifts.filter((s) => OFFERABLE.has(s.status));
  const notOfferable = shifts.filter((s) => !OFFERABLE.has(s.status));

  const send = useMutation({
    mutationFn: async (acknowledgedAvailabilityConflicts?: AvailabilityAcknowledgement[]) =>
      (await api.post('/offers/send-to-shifts', {
        items: offerable.map((shift) => ({ shiftId: shift.id, staffProfileIds: [...selected] })),
        ...(acknowledgedAvailabilityConflicts ? { acknowledgedAvailabilityConflicts } : {}),
      })).data,
    onSuccess: async () => {
      const count = offerable.length * selected.size;
      toast.success(`${count} offer${count === 1 ? '' : 's'} sent.`);
      await queryClient.invalidateQueries({ queryKey: ['shifts'] });
      await queryClient.invalidateQueries({ queryKey: ['offers'] });
      onSent();
    },
    onError: (error) => {
      if (availability.intercept(error, (acks) => send.mutate(acks))) return;
      setRejection(readBulkOfferRejection(error));
    },
  });

  const toggle = (id: string) => {
    setRejection(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const shiftOf = (id: string) => shifts.find((s) => s.id === id);
  const total = offerable.length * selected.size;
  const genericError = send.isError && !rejection && !readAvailabilityConflict(send.error);

  return createPortal(
    <>
      <ModalFrame
        open={open}
        overlayProps={{ 'data-rab-portal': '' }}
        dialogClassName="multi-shift-offer"
        onBackdropMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'multi-shift-offer-title' }}
      >
        <h3 id="multi-shift-offer-title">Offer {offerable.length} shift{offerable.length === 1 ? '' : 's'} to staff</h3>
        <p className="multi-shift-offer__intro">Everyone you pick is offered every listed shift. If any offer can’t be sent, nothing is sent and you’ll see why.</p>
        <ul className="multi-shift-offer__shifts" aria-label="Shifts">
          {offerable.map((s) => <li key={s.id}>{when(s)} · {s.venueName} · {s.roleName}</li>)}
          {notOfferable.map((s) => <li key={s.id} className="multi-shift-offer__skip">{when(s)} · {s.venueName}: not open for offers ({s.status.replace(/_/g, ' ')}), left out</li>)}
        </ul>
        <label className="multi-shift-offer__search">Find staff<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or reference" /></label>
        <div className="multi-shift-offer__people" role="group" aria-label="Staff">
          {staff.isLoading && <p>Loading staff…</p>}
          {staff.isError && <p className="feedback-error" role="alert">Staff could not be loaded.</p>}
          {people.map((p) => (
            <label key={p.id}><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />{p.firstName} {p.lastName}</label>
          ))}
          {staff.data && people.length === 0 && <p>No active staff match.</p>}
        </div>
        {rejection && (
          <div className="multi-shift-offer__rejection" role="alert">
            <p className="feedback-error">{rejection.message}</p>
            <table aria-label="Why nothing was sent">
              <thead><tr><th scope="col">Shift</th><th scope="col">Staff</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {rejection.results.map((r) => {
                  const shift = shiftOf(r.shiftId);
                  return <tr key={`${r.shiftId}|${r.staffProfileId}`}><td>{shift ? `${when(shift)} · ${shift.venueName}` : 'Shift'}</td><td>{nameOf(r.staffProfileId)}</td><td>{r.message}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        {genericError && <p className="feedback-error" role="alert">The offers could not be sent. Try again.</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-dark" disabled={total === 0 || send.isPending} onClick={() => send.mutate(undefined)}>
            {send.isPending ? 'Sending…' : `Send ${total} offer${total === 1 ? '' : 's'}`}
          </button>
        </div>
      </ModalFrame>
      {availability.dialog}
    </>,
    document.body,
  );
}
