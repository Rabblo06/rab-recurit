import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IconSend } from '@tabler/icons-react';
import { api } from '../api';
import Drawer from './Drawer';

interface Venue { id: string; name: string; status: string }
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
interface StaffMember { id: string; firstName: string; lastName: string; employmentStatus: string }

const NEW_ROLE = '__new__';
const emptyShift = { venueId: '', jobRoleId: '', date: '', startTime: '', endTime: '', breakMinutes: '0', requiredCount: '1', payRatePence: '', notes: '' };

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Global New Shift / Cancel Shift / Send Offer drawers — mounted once in
 * Layout.tsx, never inside Shifts.tsx. See CreateVenueDrawer's doc comment
 * for why: `RightSidePanel` is a push-layout flex sibling of `.main-content`
 * inside `.app-layout`'s row, and nesting it inside a page's own `.page`
 * column (as these three used to be, inside Shifts.tsx) breaks that layout
 * contract — that's the root cause of the "New Shift" drawer rendering on
 * the left with the rest of the page blanked out.
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
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleRate, setNewRoleRate] = useState('');
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [assignTarget, setAssignTarget] = useState<Shift | null>(null);
  const [assignStaffIds, setAssignStaffIds] = useState<Set<string>>(new Set());
  const [sendResults, setSendResults] = useState<{ name: string; ok: boolean; message?: string }[] | null>(null);

  useEffect(() => {
    const handleCreate = () => { setForm({ ...emptyShift }); setShowCreate(true); };
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
    enabled: !!assignTarget,
  });

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '–';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '–';

  const createJobRole = useMutation({
    mutationFn: (body: { name: string; defaultRatePence?: number }) => api.post<JobRole>('/job-roles', body),
  });

  const createShift = useMutation({
    mutationFn: async (body: typeof form) => {
      let jobRoleId = body.jobRoleId;
      if (jobRoleId === NEW_ROLE) {
        const created = await createJobRole.mutateAsync({
          name: newRoleName,
          defaultRatePence: newRoleRate ? Math.round(parseFloat(newRoleRate) * 100) : undefined,
        });
        jobRoleId = created.data.id;
      }
      return api.post('/shifts', {
        venueId: body.venueId,
        jobRoleId,
        startsAt: new Date(`${body.date}T${body.startTime}`).toISOString(),
        endsAt: new Date(`${body.date}T${body.endTime}`).toISOString(),
        breakMinutes: Number(body.breakMinutes) || 0,
        requiredCount: Number(body.requiredCount) || 1,
        payRatePence: body.payRatePence ? Math.round(parseFloat(body.payRatePence) * 100) : undefined,
        notes: body.notes || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['job-roles'] });
      setShowCreate(false);
      setForm({ ...emptyShift });
      setNewRoleName('');
      setNewRoleRate('');
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

  // Bulk send: each offer is independently valid or invalid (e.g. one
  // staff member already offered shouldn't block the rest), so this reports
  // per-staff results rather than treating the batch as all-or-nothing.
  const sendOffers = useMutation({
    mutationFn: async ({ shiftId, staffProfileIds }: { shiftId: string; staffProfileIds: string[] }) => {
      const targets = staffProfileIds.map((id) => activeStaff.find((s) => s.id === id)!);
      const outcomes = await Promise.allSettled(
        targets.map((s) => api.post(`/shifts/${shiftId}/offers`, { staffProfileId: s.id })),
      );
      return outcomes.map((outcome, i) => ({
        name: `${targets[i]!.firstName} ${targets[i]!.lastName}`,
        ok: outcome.status === 'fulfilled',
        message: outcome.status === 'rejected' ? (outcome.reason?.response?.data?.message ?? 'Failed to send') : undefined,
      }));
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setSendResults(results);
      setAssignStaffIds(new Set());
      if (results.every((r) => r.ok)) setAssignTarget(null);
    },
  });

  const activeStaff = useMemo(() => staff.filter((s) => s.employmentStatus === 'active'), [staff]);
  const f = (key: keyof typeof emptyShift) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const canSubmit = form.venueId && form.jobRoleId && (form.jobRoleId !== NEW_ROLE || newRoleName) && form.date && form.startTime && form.endTime;

  return (
    <>
      <Drawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New shift"
        size="wide"
        loading={createShift.isPending}
        dirty={JSON.stringify(form) !== JSON.stringify(emptyShift) || !!newRoleName || !!newRoleRate}
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn btn-dark" disabled={!canSubmit || createShift.isPending} onClick={() => createShift.mutate(form)}>
              {createShift.isPending ? 'Creating…' : 'Create shift'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <div className="field">
            <label>Venue</label>
            <select value={form.venueId} onChange={f('venueId')}>
              <option value="">— Select venue —</option>
              {venues.filter((v) => v.status === 'active').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Role</label>
            <select value={form.jobRoleId} onChange={f('jobRoleId')}>
              <option value="">— Select role —</option>
              {jobRoles.map((r) => <option key={r.id} value={r.id}>{r.name} ({fmtMoney(r.defaultRatePence)}/hr)</option>)}
              <option value={NEW_ROLE}>+ New role…</option>
            </select>
          </div>
        </div>
        {form.jobRoleId === NEW_ROLE && (
          <div className="form-grid">
            <div className="field"><label>New role name</label><input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} /></div>
            <div className="field"><label>Default rate (£/hr)</label><input type="number" step="0.01" value={newRoleRate} onChange={(e) => setNewRoleRate(e.target.value)} /></div>
          </div>
        )}
        <div className="form-grid">
          <div className="field"><label>Date</label><input type="date" value={form.date} onChange={f('date')} /></div>
          <div className="field"><label>Required staff</label><input type="number" min={1} value={form.requiredCount} onChange={f('requiredCount')} /></div>
        </div>
        <div className="form-grid">
          <div className="field"><label>Start time</label><input type="time" value={form.startTime} onChange={f('startTime')} /></div>
          <div className="field"><label>End time</label><input type="time" value={form.endTime} onChange={f('endTime')} /></div>
        </div>
        <div className="form-grid">
          <div className="field"><label>Break (minutes)</label><input type="number" min={0} value={form.breakMinutes} onChange={f('breakMinutes')} /></div>
          <div className="field"><label>Pay rate override (£/hr)</label><input type="number" step="0.01" placeholder="Use venue/role rate" value={form.payRatePence} onChange={f('payRatePence')} /></div>
        </div>
        <div className="field field-full"><label>Notes</label><textarea value={form.notes} onChange={f('notes')} rows={2} /></div>
        {createShift.isError && (
          <p role="alert" style={{ color: 'var(--color-red)', fontSize: 13, margin: '4px 0' }}>
            Could not create this shift. Check the details and try again.
          </p>
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
              {sendOffers.isPending ? 'Sending…' : `Send offer${assignStaffIds.size > 1 ? `s (${assignStaffIds.size})` : ''}`}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Staff members (select one or more)</label>
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border-medium)', borderRadius: 8 }}>
            {activeStaff.length === 0 && <p className="muted" style={{ padding: 12 }}>No active staff available.</p>}
            {activeStaff.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--border-light)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={assignStaffIds.has(s.id)}
                  onChange={() => {
                    const next = new Set(assignStaffIds);
                    if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                    setAssignStaffIds(next);
                  }}
                />
                {s.firstName} {s.lastName}
              </label>
            ))}
          </div>
        </div>
        {sendResults && (
          <div style={{ margin: '8px 0' }}>
            {sendResults.map((r) => (
              <p key={r.name} role={r.ok ? undefined : 'alert'} style={{ fontSize: 13, margin: '2px 0', color: r.ok ? 'var(--color-green)' : 'var(--color-red)' }}>
                {r.ok ? '✓' : '✗'} {r.name}{!r.ok && r.message ? ` — ${r.message}` : ''}
              </p>
            ))}
          </div>
        )}
      </Drawer>
    </>
  );
}
