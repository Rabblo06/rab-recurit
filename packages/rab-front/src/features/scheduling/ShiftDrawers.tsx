import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconSend } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { SearchableSelect } from '../../shared/components/SearchableSelect';

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
type SendResult = { name: string; ok: boolean; message?: string };

const NEW_ROLE = '__new__';
const emptyShift = { venueId: '', jobRoleId: '', address: '', date: '', startTime: '', endTime: '', breakMinutes: '0', payRatePence: '', notes: '' };

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const formatVenueAddress = (v?: Venue) =>
  v?.address ? [v.address.line1, [v.address.city, v.address.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';

/** Shared by both drawers' post-send summary — one ✓/✗ list, not two copies. */
function SendResultsList({ results }: { results: SendResult[] }) {
  return (
    <div style={{ margin: '8px 0' }}>
      {results.map((r) => (
        <p key={r.name} role={r.ok ? undefined : 'alert'} style={{ fontSize: 13, margin: '2px 0', color: r.ok ? 'var(--color-green)' : 'var(--color-red)' }}>
          {r.ok ? '✓' : '✗'} {r.name}{!r.ok && r.message ? ` — ${r.message}` : ''}
        </p>
      ))}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" style={{ color: 'var(--color-red)', fontSize: 11, margin: '4px 0 0' }}>{message}</p>;
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

  useEffect(() => {
    const handleCreate = () => {
      setForm({ ...emptyShift });
      setAddressTouched(false);
      setCreateStaffIds(new Set());
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
      const shift = (e as CustomEvent).detail?.shift as Shift | undefined;
      if (!shift) return;
      setAssignTarget(shift);
      setAssignStaffIds(new Set());
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
    queryFn: async () => { const { data } = await api.get<Venue[]>('/venues'); return data; },
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
  });
  const { data: staff = [] } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get<StaffMember[]>('/staff'); return data; },
    enabled: showCreate || !!assignTarget,
  });

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '–';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '–';
  const activeStaff = useMemo(() => staff.filter((s) => s.employmentStatus === 'active'), [staff]);
  const staffOptions = useMemo(
    () => activeStaff.map((s) => ({ id: s.id, label: `${s.firstName} ${s.lastName}`, sublabel: s.email })),
    [activeStaff],
  );
  const venueOptions = useMemo(
    () => venues.filter((v) => v.status === 'active').map((v) => ({ id: v.id, label: v.name })),
    [venues],
  );
  const roleOptions = useMemo(
    () => jobRoles.map((r) => ({ id: r.id, label: r.name, sublabel: `${fmtMoney(r.defaultRatePence)}/hr` })),
    [jobRoles],
  );

  const createJobRole = useMutation({
    mutationFn: (body: { name: string; defaultRatePence?: number }) => api.post<JobRole>('/job-roles', body),
  });

  const createShiftAndSend = useMutation({
    mutationFn: async (body: typeof form) => {
      let jobRoleId = body.jobRoleId;
      if (jobRoleId === NEW_ROLE) {
        const created = await createJobRole.mutateAsync({
          name: newRoleName,
          defaultRatePence: newRoleRate ? Math.round(parseFloat(newRoleRate) * 100) : undefined,
        });
        jobRoleId = created.data.id;
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
        },
      );
      return data.results.map((r) => {
        const s = activeStaff.find((s) => s.id === r.staffProfileId);
        return { name: s ? `${s.firstName} ${s.lastName}` : r.staffProfileId, ok: r.ok, message: r.message };
      });
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['job-roles'] });
      qc.invalidateQueries({ queryKey: ['offers'] });
      setCreateResults(results);
      if (results.every((r) => r.ok)) setShowCreate(false);
    },
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/shifts/${id}/cancel`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setCancelTarget(null);
      setCancelReason('');
    },
  });

  // One send action, 1 or 100 recipients — the server does the per-recipient
  // fan-out (each independently valid/invalid, e.g. one staff member already
  // offered shouldn't block the rest) and returns per-staff results, tagged
  // with a shared offerBatchId. Same UX as before, one network round trip
  // instead of N.
  const sendOffers = useMutation({
    mutationFn: async ({ shiftId, staffProfileIds }: { shiftId: string; staffProfileIds: string[] }) => {
      const { data } = await api.post<{ batchId: string; results: { staffProfileId: string; ok: boolean; message?: string }[] }>(
        `/shifts/${shiftId}/offers/bulk`,
        { staffProfileIds },
      );
      return data.results.map((r) => {
        const s = activeStaff.find((s) => s.id === r.staffProfileId);
        return { name: s ? `${s.firstName} ${s.lastName}` : r.staffProfileId, ok: r.ok, message: r.message };
      });
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setSendResults(results);
      setAssignStaffIds(new Set());
      if (results.every((r) => r.ok)) setAssignTarget(null);
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
      <Drawer
        open={showCreate}
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
              disabled={createShiftAndSend.isPending || (attemptedCreate && !canSubmit)}
              onClick={() => {
                setAttemptedCreate(true);
                if (!canSubmit) return;
                setCreateResults(null);
                createShiftAndSend.mutate(form);
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

        <div className="field field-full">
          <label>Staff members (select one or more)</label>
          <SearchableSelect
            mode="multi"
            options={staffOptions}
            placeholder="Search staff…"
            values={createStaffIds}
            onToggle={(id) => {
              const next = new Set(createStaffIds);
              if (next.has(id)) next.delete(id); else next.add(id);
              setCreateStaffIds(next);
            }}
            onSelectAll={() => setCreateStaffIds(new Set(activeStaff.map((s) => s.id)))}
            onClearAll={() => setCreateStaffIds(new Set())}
          />
          {attemptedCreate && <FieldError message={errors.staff} />}
        </div>

        {createShiftAndSend.isError && !createResults && (
          <p role="alert" style={{ color: 'var(--color-red)', fontSize: 13, margin: '4px 0' }}>
            Could not create this shift. Check the details and try again.
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
        onClose={() => setCancelTarget(null)}
        title="Cancel shift"
        dirty={!!cancelReason}
        loading={cancel.isPending}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setCancelTarget(null)}>Back</button>
            <button
              className="btn btn-dark"
              style={{ background: 'var(--color-red)', borderColor: 'var(--color-red)' }}
              disabled={cancel.isPending}
              onClick={() => cancelTarget && cancel.mutate({ id: cancelTarget, reason: cancelReason })}
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
      </Drawer>

      <Drawer
        open={!!assignTarget}
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
              onClick={() => { setSendResults(null); assignTarget && sendOffers.mutate({ shiftId: assignTarget.id, staffProfileIds: [...assignStaffIds] }); }}
            >
              <IconSend size={14} />
              {sendOffers.isPending ? 'Sending offers…' : `Send offer${assignStaffIds.size > 1 ? `s (${assignStaffIds.size})` : ''}`}
            </button>
          </>
        }
      >
        <div className="field field-full">
          <label>Staff members (select one or more)</label>
          <SearchableSelect
            mode="multi"
            options={staffOptions}
            placeholder="Search staff…"
            values={assignStaffIds}
            onToggle={(id) => {
              const next = new Set(assignStaffIds);
              if (next.has(id)) next.delete(id); else next.add(id);
              setAssignStaffIds(next);
            }}
            onSelectAll={() => setAssignStaffIds(new Set(activeStaff.map((s) => s.id)))}
            onClearAll={() => setAssignStaffIds(new Set())}
          />
        </div>
        {sendResults && <SendResultsList results={sendResults} />}
      </Drawer>
    </>
  );
}
