import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconSend } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { fetchAllPages } from '../../shared/table-toolbar/pagination';
import Drawer from '../../shared/components/Drawer';
import { SearchableSelect } from '../../shared/components/SearchableSelect';
import StaffSelectionPage, { type RequestedStaff } from './StaffSelectionPage';
import SelectedStaffField from './SelectedStaffField';
import './staff-selection.css';
import { AvailabilityAcknowledgement, readAvailabilityConflict, useAvailabilityConflictGate } from './AvailabilityConflictDialog';
import { getApiErrorMessage, isSafeServerMessage } from '../../shared/lib/apiError';
import { toast } from '../../shared/lib/toast';

interface Venue { id: string; name: string; status: string; address?: { line1?: string; city?: string; postcode?: string } }
interface JobRole { id: string; name: string; defaultRatePence: number }
interface Shift {
  id: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  requiredCount: number;
  filledCount: number;
  payRatePence: number;
  status: string;
  notes?: string;
}
interface StaffMember { id: string; firstName: string; lastName: string; email: string; employmentStatus: string }
type SendResult = { name: string; ok: boolean; message?: string; staffProfileId?: string };

/** "2 of 3 offers sent" style summary used by the toasts below. */
const offersSentLine = (results: SendResult[]) => {
  const sent = results.filter((r) => r.ok).length;
  return `${sent} of ${results.length} offer${results.length === 1 ? '' : 's'} sent`;
};
/** `GET /shifts/:id/replacement-context` — every value is the ORIGINAL shift's, read-only in the form. */
export interface ReplacementContext {
  shift: {
    id: string; venueId: string; jobRoleId: string; venueName: string; roleName: string; address: string | null;
    startsAt: string; endsAt: string; breakMinutes: number; payRatePence: number; notes: string | null; status: string;
  };
  vacancy: { requiredCount: number; occupied: number; confirmedNoShows: number; provisionalNoShows: number; vacancy: number };
  offerKind: 'replacement' | 'standby';
  canSend: boolean;
  blockedReason: string | null;
}

const NEW_ROLE = '__new__';
const emptyShift = { venueId: '', jobRoleId: '', address: '', date: '', startTime: '', endTime: '', breakMinutes: '0', payRatePence: '', notes: '' };

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDayMonth = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
const fmtDateInput = (d: string) => new Date(d).toLocaleDateString('en-CA');
/** "<k> position(s) require replacement" — from the server's live vacancy, never a client count. */
export const positionsLine = (k: number) =>
  k === 0 ? 'No position is vacant — offers will be sent as standby' : `${k} position${k === 1 ? ' requires' : 's require'} replacement`;
const formatVenueAddress = (v?: Venue) =>
  v?.address ? [v.address.line1, [v.address.city, v.address.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';

/** Shared by both drawers' post-send summary — one ✓/✗ list, not two copies. */
function SendResultsList({ results }: { results: SendResult[] }) {
  return (
    <div style={{ margin: '8px 0' }}>
      {results.map((r) => (
        <p key={r.name} role={r.ok ? undefined : 'alert'} style={{ fontSize: 13, margin: '2px 0', color: r.ok ? 'var(--feedback-success)' : 'var(--feedback-error)' }}>
          {r.ok ? '✓' : '✗'} {r.name}{!r.ok ? ` — ${isSafeServerMessage(r.message) ? r.message : 'Could not be sent.'}` : ''}
        </p>
      ))}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 11, margin: '4px 0 0' }}>{message}</p>;
}

/**
 * Global New Shift / Cancel Shift / Send Offer drawers — mounted once in
 * Layout.tsx, never inside Shifts.tsx. See CreateVenueDrawer's doc comment
 * for why: `RightSidePanel` is a push-layout flex sibling of `.main-content`
 * inside `.app-layout`'s row, and nesting it inside a page's own `.page`
 * column (as these three used to be, inside Shifts.tsx) breaks that layout
 * contract — that's the root cause of the "New Shift" drawer rendering on
 * the left with the rest of the page blanked out.
 *
 * "New shift" creates the shift AND sends every selected staff member their
 * offer in one action (`POST /shifts/with-offers`) — no separate create →
 * publish → send-offer round trip. The old three-step path (create in DRAFT,
 * publish, then send offers to an already-existing shift) still exists
 * unchanged for its own purpose: adding more staff to a shift that's already
 * live. That's the "Send offer" drawer below, opened from the shift table's
 * send icon.
 *
 * Opened globally via:
 *   document.dispatchEvent(new CustomEvent('open-create-placement'))
 *   document.dispatchEvent(new CustomEvent('open-cancel-shift', { detail: { shiftId } }))
 *   document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift } }))
 *   document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shiftId, mode: 'replacement', shift? } }))
 *
 * `mode: 'replacement'` (the pipeline's "+ Send offer") opens the same Send offers drawer as "Send replacement offer":
 * the ORIGINAL shift's details are loaded from `GET /shifts/:id/replacement-context` and shown read-only, only the staff
 * selection is editable, and Send calls the SAME existing-shift endpoint (`POST /shifts/:id/offers/bulk`, with
 * `mode: 'replacement'`) — never shift creation. On success it dispatches `offers-sent` `{ shiftId }`.
 */
export default function ShiftDrawers() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ ...emptyShift });
  const [addressTouched, setAddressTouched] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleRate, setNewRoleRate] = useState('');
  const [createStaffIds, setCreateStaffIds] = useState<Set<string>>(new Set());
  const [createResults, setCreateResults] = useState<SendResult[] | null>(null);
  const [attemptedCreate, setAttemptedCreate] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [assignTarget, setAssignTarget] = useState<Shift | null>(null);
  const [assignStaffIds, setAssignStaffIds] = useState<Set<string>>(new Set());
  const [sendResults, setSendResults] = useState<SendResult[] | null>(null);
  // The full-page picker (StaffSelectionPage, draft mode) for whichever drawer opened it; the drawer hides meanwhile.
  const [picker, setPicker] = useState<'create' | 'assign' | 'replacement' | null>(null);
  // Rows chosen in the picker, kept so the drawer can show names; the Set state above stays the source of truth for sends.
  const [chosen, setChosen] = useState<{ create: RequestedStaff[]; assign: RequestedStaff[]; replacement: RequestedStaff[] }>({ create: [], assign: [], replacement: [] });
  // Replacement mode of the Send offers drawer: the existing shift being replaced on (by id only — details are loaded).
  const [replacementShiftId, setReplacementShiftId] = useState<string | null>(null);
  const [replacementResults, setReplacementResults] = useState<SendResult[] | null>(null);
  const availabilityGate = useAvailabilityConflictGate();
  // A "+ New role…" created on an attempt the server then refused (availability warning) is reused by "Send anyway" —
  // never created twice.
  const createdJobRoleId = useRef<string | null>(null);
  // Synchronous duplicate guards: `isPending` only re-renders on the next tick, so a fast double-click could otherwise
  // create two shifts (or send two batches of offers) before the button disables.
  const createInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const sendInFlight = useRef(false);

  useEffect(() => {
    const handleCreate = () => {
      createdJobRoleId.current = null;
      setForm({ ...emptyShift });
      setAddressTouched(false);
      setCreateStaffIds(new Set());
      setChosen((c) => ({ ...c, create: [] }));
      setCreateResults(null);
      setAttemptedCreate(false);
      setShowCreate(true);
    };
    const handleCancel = (e: Event) => {
      const shiftId = (e as CustomEvent).detail?.shiftId as string | undefined;
      if (!shiftId) return;
      setCancelTarget(shiftId);
      setCancelReason('');
    };
    const handleSend = (e: Event) => {
      const detail = (e as CustomEvent).detail as { shift?: Shift; shiftId?: string; mode?: string } | undefined;
      if (detail?.mode === 'replacement') {
        const id = detail.shiftId ?? detail.shift?.id;
        if (!id) return;
        setReplacementShiftId(id);
        setChosen((c) => ({ ...c, replacement: [] }));
        setReplacementResults(null);
        return;
      }
      const shift = detail?.shift;
      if (!shift) return;
      setAssignTarget(shift);
      setAssignStaffIds(new Set());
      setChosen((c) => ({ ...c, assign: [] }));
      setSendResults(null);
    };
    document.addEventListener('open-create-placement', handleCreate);
    document.addEventListener('open-cancel-shift', handleCancel);
    document.addEventListener('open-send-offer', handleSend);
    return () => {
      document.removeEventListener('open-create-placement', handleCreate);
      document.removeEventListener('open-cancel-shift', handleCancel);
      document.removeEventListener('open-send-offer', handleSend);
    };
  }, []);

  const { data: venues = [] } = useQuery({
    queryKey: ['venues'],
    // Every page (Phase C1: the server's default page is now 50), so no venue silently drops out of the picker.
    queryFn: () => fetchAllPages<Venue>('/venues'),
    enabled: showCreate || !!assignTarget,
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
    enabled: showCreate || !!assignTarget,
  });
  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: () => fetchAllPages<StaffMember>('/staff'),
    enabled: showCreate || !!assignTarget,
  });
  const replacementContext = useQuery({
    queryKey: ['replacement-context', replacementShiftId],
    queryFn: async () => (await api.get<ReplacementContext>(`/shifts/${replacementShiftId}/replacement-context`)).data,
    enabled: !!replacementShiftId,
    staleTime: 0,
  });

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '–';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '–';
  const activeStaff = useMemo(() => staff.filter((s) => s.employmentStatus === 'active'), [staff]);
  const venueOptions = useMemo(
    () => venues.filter((v) => v.status === 'active').map((v) => ({ id: v.id, label: v.name })),
    [venues],
  );
  const roleOptions = useMemo(
    // Wave 5: archived job roles stay resolvable by name (history) but are never offered for new work.
    () => jobRoles.filter((r) => !(r as { archivedAt?: string | null }).archivedAt).map((r) => ({ id: r.id, label: r.name, sublabel: `${fmtMoney(r.defaultRatePence)}/hr` })),
    [jobRoles],
  );

  const createJobRole = useMutation({
    mutationFn: (body: { name: string; defaultRatePence?: number }) => api.post<JobRole>('/job-roles', body),
  });

  const createShiftAndSend = useMutation({
    mutationFn: async ({ body, acknowledgedAvailabilityConflicts }: { body: typeof form; acknowledgedAvailabilityConflicts?: AvailabilityAcknowledgement[] }) => {
      let jobRoleId = body.jobRoleId;
      if (jobRoleId === NEW_ROLE && createdJobRoleId.current) {
        jobRoleId = createdJobRoleId.current;
      } else if (jobRoleId === NEW_ROLE) {
        const created = await createJobRole.mutateAsync({
          name: newRoleName,
          defaultRatePence: newRoleRate ? Math.round(parseFloat(newRoleRate) * 100) : undefined,
        });
        jobRoleId = created.data.id;
        createdJobRoleId.current = jobRoleId;
      }
      const { data } = await api.post<{ batchId: string; shiftId: string; results: { staffProfileId: string; ok: boolean; message?: string }[] }>(
        '/shifts/with-offers',
        {
          venueId: body.venueId,
          jobRoleId,
          address: body.address || undefined,
          startsAt: new Date(`${body.date}T${body.startTime}`).toISOString(),
          endsAt: new Date(`${body.date}T${body.endTime}`).toISOString(),
          breakMinutes: Number(body.breakMinutes) || 0,
          payRatePence: body.payRatePence ? Math.round(parseFloat(body.payRatePence) * 100) : undefined,
          notes: body.notes || undefined,
          staffProfileIds: [...createStaffIds],
          acknowledgedAvailabilityConflicts,
        },
      );
      return data.results.map((r) => {
        const s = activeStaff.find((s) => s.id === r.staffProfileId);
        return { name: s ? `${s.firstName} ${s.lastName}` : r.staffProfileId, ok: r.ok, message: r.message };
      });
    },
    onError: (error, variables) => {
      availabilityGate.intercept(error, (acks) => createShiftAndSend.mutate({ ...variables, acknowledgedAvailabilityConflicts: acks }));
    },
    onSuccess: (results) => {
      createdJobRoleId.current = null;
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['job-roles'] });
      qc.invalidateQueries({ queryKey: ['offers'] });
      setCreateResults(results);
      if (results.every((r) => r.ok)) {
        setShowCreate(false);
        toast.success(`Shift created. ${offersSentLine(results)}.`);
      } else {
        // The shift EXISTS now: say so, keep the drawer open on the per-staff list, and never offer "Send" again (it
        // would create a second shift). Failed staff can be offered from the shift's own Send offers action.
        toast.warning(`Shift created, but not every offer was sent: ${offersSentLine(results)}. See the list in the drawer.`, { persistent: true });
      }
    },
    onSettled: () => {
      createInFlight.current = false;
    },
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/shifts/${id}/cancel`, { reason }),
    onSuccess: (_r, { id }) => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      // An open staffing board / Venue Offers list shows the cancellation at once, not on its next poll.
      qc.invalidateQueries({ queryKey: ['venue-pipeline', id] });
      qc.invalidateQueries({ queryKey: ['venue-offers'] });
      setCancelTarget(null);
      setCancelReason('');
      toast.success('Shift cancelled.');
    },
    // A refusal (e.g. the shift already started) is shown in the drawer and the typed reason is kept.
    onSettled: () => {
      cancelInFlight.current = false;
    },
  });

  // One send action, 1 or 100 recipients — the server does the per-recipient
  // fan-out (each independently valid/invalid, e.g. one staff member already
  // offered shouldn't block the rest) and returns per-staff results, tagged
  // with a shared offerBatchId. Same UX as before, one network round trip
  // instead of N.
  const sendOffers = useMutation({
    mutationFn: async ({ shiftId, staffProfileIds, acknowledgedAvailabilityConflicts }: { shiftId: string; staffProfileIds: string[]; acknowledgedAvailabilityConflicts?: AvailabilityAcknowledgement[] }) => {
      const { data } = await api.post<{ batchId: string; results: { staffProfileId: string; ok: boolean; message?: string }[] }>(
        `/shifts/${shiftId}/offers/bulk`,
        { staffProfileIds, acknowledgedAvailabilityConflicts },
      );
      return data.results.map((r) => {
        const s = activeStaff.find((s) => s.id === r.staffProfileId);
        return { name: s ? `${s.firstName} ${s.lastName}` : r.staffProfileId, ok: r.ok, message: r.message, staffProfileId: r.staffProfileId };
      });
    },
    onError: (error, variables) => {
      availabilityGate.intercept(error, (acks) => sendOffers.mutate({ ...variables, acknowledgedAvailabilityConflicts: acks }));
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setSendResults(results);
      if (results.every((r) => r.ok)) {
        setAssignStaffIds(new Set());
        setAssignTarget(null);
        toast.success(results.length === 1 ? 'Offer sent.' : `${results.length} offers sent.`);
        return;
      }
      // Partial: only the staff who did NOT get an offer stay selected, so "Send" retries exactly those.
      const failed = new Set(results.filter((r) => !r.ok && r.staffProfileId).map((r) => r.staffProfileId as string));
      setAssignStaffIds(failed);
      setChosen((c) => ({ ...c, assign: c.assign.filter((x) => failed.has(x.staffProfileId)) }));
      toast.warning(`Not every offer was sent: ${offersSentLine(results)}. See the list in the drawer.`, { persistent: true });
    },
    onSettled: () => {
      sendInFlight.current = false;
    },
  });

  const closeReplacement = () => { setReplacementShiftId(null); setReplacementResults(null); };
  // Replacement offers go to the EXISTING shift (same id) through the existing bulk-send endpoint — never shift creation.
  const sendReplacement = useMutation({
    mutationFn: async ({ shiftId, staffProfileIds, acknowledgedAvailabilityConflicts }: { shiftId: string; staffProfileIds: string[]; acknowledgedAvailabilityConflicts?: AvailabilityAcknowledgement[] }) => {
      const { data } = await api.post<{ batchId: string; shiftId: string; offerKind: string; results: { staffProfileId: string; ok: boolean; message?: string }[] }>(
        `/shifts/${shiftId}/offers/bulk`,
        { staffProfileIds, mode: 'replacement', acknowledgedAvailabilityConflicts },
      );
      return data.results.map((r) => {
        const s = chosen.replacement.find((c) => c.staffProfileId === r.staffProfileId);
        return { name: s ? `${s.firstName} ${s.lastName}` : r.staffProfileId, ok: r.ok, message: r.message };
      });
    },
    onError: (error, variables) => {
      if (readAvailabilityConflict(error)) {
        availabilityGate.intercept(error, (acks) => sendReplacement.mutate({ ...variables, acknowledgedAvailabilityConflicts: acks }));
        return;
      }
      toast.error(getApiErrorMessage(error, 'Could not send the replacement offer. Try again.'));
    },
    onSuccess: (results, variables) => {
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['replacement-context', variables.shiftId] });
      const sent = results.filter((r) => r.ok).length;
      if (sent === 0) {
        setReplacementResults(results);
        const reason = results.find((r) => isSafeServerMessage(r.message))?.message;
        toast.error(reason ?? 'No replacement offer could be sent.');
        return;
      }
      if (sent === results.length) toast.success('Replacement offer sent successfully.');
      else toast.warning(`Not every replacement offer was sent: ${offersSentLine(results)}. See the list in the drawer.`, { persistent: true });
      document.dispatchEvent(new CustomEvent('offers-sent', { detail: { shiftId: variables.shiftId } }));
      if (sent === results.length) closeReplacement();
      else setReplacementResults(results);
    },
  });

  const f = (key: keyof typeof emptyShift) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const handleVenueChange = (venueId: string) => {
    setForm((prev) => {
      const shouldAutofill = !addressTouched;
      const nextAddress = shouldAutofill ? formatVenueAddress(venues.find((v) => v.id === venueId)) : prev.address;
      return { ...prev, venueId, address: nextAddress };
    });
  };

  const durationValid = form.startTime && form.endTime ? form.startTime < form.endTime : true;
  const errors = {
    venueId: !form.venueId ? 'Select a venue.' : undefined,
    jobRoleId: !form.jobRoleId || (form.jobRoleId === NEW_ROLE && !newRoleName) ? 'Select or create a role.' : undefined,
    address: !form.address ? 'Enter an address for this shift.' : undefined,
    date: !form.date ? 'Select a date.' : undefined,
    startTime: !form.startTime ? 'Select a start time.' : undefined,
    endTime: !form.endTime ? 'Select an end time.' : !durationValid ? 'End time must be after start time.' : undefined,
    staff: createStaffIds.size === 0 ? 'Select at least one staff member.' : undefined,
  };
  const canSubmit = !Object.values(errors).some(Boolean);

  return (
    <>
      {picker && (
        <StaffSelectionPage
          mode="draft"
          initialStaff={chosen[picker]}
          onCancel={() => setPicker(null)}
          onDraftConfirmed={(staff) => {
            setChosen((c) => ({ ...c, [picker]: staff }));
            const ids = new Set(staff.map((s) => s.staffProfileId));
            if (picker === 'create') setCreateStaffIds(ids); else if (picker === 'assign') setAssignStaffIds(ids);
            setPicker(null);
          }}
        />
      )}
      <Drawer
        open={showCreate && picker !== 'create'}
        onClose={() => setShowCreate(false)}
        title="New shift"
        size="wide"
        loading={createShiftAndSend.isPending}
        dirty={JSON.stringify(form) !== JSON.stringify(emptyShift) || createStaffIds.size > 0}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
            <button
              className="btn btn-dark"
              disabled={createShiftAndSend.isPending || (attemptedCreate && !canSubmit) || !!createResults}
              onClick={() => {
                setAttemptedCreate(true);
                if (!canSubmit || createInFlight.current || createResults) return;
                createInFlight.current = true;
                createShiftAndSend.mutate({ body: form });
              }}
            >
              <IconSend size={14} />
              {createShiftAndSend.isPending ? 'Sending offers…' : `Send Offer${createStaffIds.size > 1 ? ` (${createStaffIds.size})` : ''}`}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <div className="field">
            <label>Venue</label>
            <SearchableSelect options={venueOptions} placeholder="Search venues…" value={form.venueId} onChange={handleVenueChange} />
            {attemptedCreate && <FieldError message={errors.venueId} />}
          </div>
          <div className="field">
            <label>Role</label>
            <SearchableSelect
              options={[...roleOptions, { id: NEW_ROLE, label: '+ New role…' }]}
              placeholder="Search roles…"
              value={form.jobRoleId}
              onChange={(jobRoleId) => setForm({ ...form, jobRoleId })}
            />
            {attemptedCreate && <FieldError message={errors.jobRoleId} />}
          </div>
        </div>
        {form.jobRoleId === NEW_ROLE && (
          <div className="form-grid">
            <div className="field"><label>New role name</label><input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} /></div>
            <div className="field"><label>Default rate (£/hr)</label><input type="number" step="0.01" value={newRoleRate} onChange={(e) => setNewRoleRate(e.target.value)} /></div>
          </div>
        )}
        <div className="field field-full">
          <label>Address</label>
          <input
            value={form.address}
            onChange={(e) => { setAddressTouched(true); setForm({ ...form, address: e.target.value }); }}
            placeholder="123 Oxford Street, London W1D 2JE, United Kingdom"
          />
          {attemptedCreate && <FieldError message={errors.address} />}
        </div>
        <div className="form-grid-3">
          <div className="field"><label>Date</label><input type="date" value={form.date} onChange={f('date')} />{attemptedCreate && <FieldError message={errors.date} />}</div>
          <div className="field"><label>Start time</label><input type="time" value={form.startTime} onChange={f('startTime')} />{attemptedCreate && <FieldError message={errors.startTime} />}</div>
          <div className="field"><label>End time</label><input type="time" value={form.endTime} onChange={f('endTime')} />{attemptedCreate && <FieldError message={errors.endTime} />}</div>
        </div>
        <div className="form-grid">
          <div className="field"><label>Break (minutes)</label><input type="number" min={0} value={form.breakMinutes} onChange={f('breakMinutes')} /></div>
          <div className="field"><label>Pay rate override (£/hr)</label><input type="number" step="0.01" placeholder="Use venue/role rate" value={form.payRatePence} onChange={f('payRatePence')} /></div>
        </div>
        <div className="field field-full"><label>Notes</label><textarea value={form.notes} onChange={f('notes')} rows={2} /></div>

        <SelectedStaffField
          staff={chosen.create}
          onOpenPicker={() => setPicker('create')}
          onChange={(staff) => { setChosen((c) => ({ ...c, create: staff })); setCreateStaffIds(new Set(staff.map((s) => s.staffProfileId))); }}
          error={attemptedCreate && <FieldError message={errors.staff} />}
        />

        {createShiftAndSend.isError && !createResults && !readAvailabilityConflict(createShiftAndSend.error) && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13, margin: '4px 0' }}>
            {createdJobRoleId.current ? `The new role "${newRoleName}" was created, but the shift was not. ` : ''}
            {getApiErrorMessage(createShiftAndSend.error, 'Could not create this shift. Check the details and try again.')}
          </p>
        )}
        {createResults && (
          <>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 4px' }}>
              Shift created ✓ — {createResults.filter((r) => r.ok).length} of {createResults.length} offers sent
            </p>
            <SendResultsList results={createResults} />
          </>
        )}
      </Drawer>

      <Drawer
        open={!!cancelTarget}
        onClose={() => { setCancelTarget(null); cancel.reset(); }}
        title="Cancel shift"
        dirty={!!cancelReason}
        loading={cancel.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => { setCancelTarget(null); cancel.reset(); }} disabled={cancel.isPending}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={cancel.isPending}
              onClick={() => {
                if (!cancelTarget || cancelInFlight.current) return;
                cancelInFlight.current = true;
                cancel.mutate({ id: cancelTarget, reason: cancelReason });
              }}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel shift'}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Reason for cancellation</label>
          <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} placeholder="e.g. Venue cancelled the booking" />
        </div>
        {cancel.isError && cancel.variables?.id === cancelTarget && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13, margin: '4px 0' }}>
            {getApiErrorMessage(cancel.error, 'Could not cancel this shift. Please try again.')}
          </p>
        )}
      </Drawer>

      <Drawer
        open={!!assignTarget && picker !== 'assign'}
        onClose={() => { setAssignTarget(null); setSendResults(null); }}
        title={`Send offer${assignStaffIds.size > 1 ? 's' : ''}`}
        description={assignTarget ? `${venueName(assignTarget.venueId)} · ${roleName(assignTarget.jobRoleId)} · ${fmtDate(assignTarget.startsAt)}, ${fmtTime(assignTarget.startsAt)}–${fmtTime(assignTarget.endsAt)} · ${assignTarget.requiredCount - assignTarget.filledCount} seat${assignTarget.requiredCount - assignTarget.filledCount === 1 ? '' : 's'} open` : undefined}
        dirty={assignStaffIds.size > 0 && !sendResults}
        loading={sendOffers.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => { setAssignTarget(null); setSendResults(null); }}>
              {sendResults ? 'Done' : 'Cancel'}
            </button>
            <button
              className="btn btn-dark"
              disabled={assignStaffIds.size === 0 || sendOffers.isPending || !assignTarget}
              onClick={() => {
                if (!assignTarget || sendInFlight.current) return;
                sendInFlight.current = true;
                setSendResults(null);
                sendOffers.mutate({ shiftId: assignTarget.id, staffProfileIds: [...assignStaffIds] });
              }}
            >
              <IconSend size={14} />
              {sendOffers.isPending ? 'Sending offers…' : `Send offer${assignStaffIds.size > 1 ? `s (${assignStaffIds.size})` : ''}`}
            </button>
          </>
        }
      >
        <SelectedStaffField
          staff={chosen.assign}
          onOpenPicker={() => setPicker('assign')}
          onChange={(staff) => { setChosen((c) => ({ ...c, assign: staff })); setAssignStaffIds(new Set(staff.map((s) => s.staffProfileId))); }}
        />
        {sendOffers.isError && !sendResults && !readAvailabilityConflict(sendOffers.error) && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13, margin: '4px 0' }}>
            {getApiErrorMessage(sendOffers.error, 'Could not send these offers. Try again.')}
          </p>
        )}
        {sendResults && <SendResultsList results={sendResults} />}
      </Drawer>

      <Drawer
        open={!!replacementShiftId && picker !== 'replacement'}
        onClose={closeReplacement}
        title="Send replacement offer"
        size="wide"
        dirty={chosen.replacement.length > 0 && !replacementResults}
        loading={sendReplacement.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={closeReplacement}>{replacementResults ? 'Done' : 'Cancel'}</button>
            <button
              className="btn btn-dark"
              disabled={!replacementShiftId || !replacementContext.data?.canSend || chosen.replacement.length === 0 || sendReplacement.isPending}
              onClick={() => {
                if (!replacementShiftId) return;
                setReplacementResults(null);
                sendReplacement.mutate({ shiftId: replacementShiftId, staffProfileIds: chosen.replacement.map((s) => s.staffProfileId) });
              }}
            >
              <IconSend size={14} />
              {sendReplacement.isPending ? 'Sending…' : 'Send offer'}
            </button>
          </>
        }
      >
        {replacementContext.isPending ? (
          <p role="status">Loading shift…</p>
        ) : replacementContext.isError || !replacementContext.data ? (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13 }}>
            {getApiErrorMessage(replacementContext.error, 'This shift could not be loaded.')}
          </p>
        ) : (
          <ReplacementShiftDetails context={replacementContext.data} />
        )}
        {replacementContext.data && !replacementContext.data.canSend && replacementContext.data.blockedReason && (
          <p role="alert" style={{ color: 'var(--feedback-error)', fontSize: 13, margin: '4px 0' }}>{replacementContext.data.blockedReason}</p>
        )}
        <SelectedStaffField
          staff={chosen.replacement}
          onOpenPicker={() => setPicker('replacement')}
          onChange={(staff) => setChosen((c) => ({ ...c, replacement: staff }))}
        />
        {replacementResults && <SendResultsList results={replacementResults} />}
      </Drawer>
      {availabilityGate.dialog}
    </>
  );
}

/**
 * The ORIGINAL shift, read-only: inherited fields never modify the shift (the send carries only the staff selection).
 * Context lines come from the server's live data (`GET /shifts/:id/replacement-context`).
 */
function ReplacementShiftDetails({ context }: { context: ReplacementContext }) {
  const { shift, vacancy } = context;
  const ro = { readOnly: true, 'aria-readonly': true } as const;
  return (
    <>
      <div className="replacement-context" aria-label="Replacement context" style={{ margin: '0 0 12px', fontSize: 13 }}>
        <p style={{ margin: '2px 0', fontWeight: 600 }}>Replacement for {shift.venueName}</p>
        <p style={{ margin: '2px 0' }}>{positionsLine(vacancy.vacancy)}</p>
        <p style={{ margin: '2px 0', color: 'var(--font-secondary)' }}>
          Original shift: {fmtDayMonth(shift.startsAt)} · {fmtTime(shift.startsAt)}–{fmtTime(shift.endsAt)}
        </p>
      </div>
      <div className="form-grid">
        <div className="field"><label htmlFor="repl-venue">Venue</label><input id="repl-venue" value={shift.venueName} {...ro} /></div>
        <div className="field"><label htmlFor="repl-role">Role</label><input id="repl-role" value={shift.roleName} {...ro} /></div>
      </div>
      <div className="field field-full"><label htmlFor="repl-address">Address</label><input id="repl-address" value={shift.address ?? ''} {...ro} /></div>
      <div className="form-grid-3">
        <div className="field"><label htmlFor="repl-date">Date</label><input id="repl-date" type="date" value={fmtDateInput(shift.startsAt)} {...ro} /></div>
        <div className="field"><label htmlFor="repl-start">Start time</label><input id="repl-start" value={fmtTime(shift.startsAt)} {...ro} /></div>
        <div className="field"><label htmlFor="repl-end">End time</label><input id="repl-end" value={fmtTime(shift.endsAt)} {...ro} /></div>
      </div>
      <div className="form-grid">
        <div className="field"><label htmlFor="repl-break">Break (minutes)</label><input id="repl-break" value={String(shift.breakMinutes)} {...ro} /></div>
        <div className="field"><label htmlFor="repl-rate">Pay rate (£/hr)</label><input id="repl-rate" value={fmtMoney(shift.payRatePence)} {...ro} /></div>
      </div>
      <div className="field field-full"><label htmlFor="repl-notes">Notes</label><textarea id="repl-notes" value={shift.notes ?? ''} rows={2} {...ro} /></div>
    </>
  );
}
