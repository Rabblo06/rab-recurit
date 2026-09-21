import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { SearchableSelect } from '../../shared/components/SearchableSelect';

interface Venue { id: string; name: string; defaultBreakMinutes: number | null; breakPaid: boolean }
interface JobRole { id: string; name: string }
interface PoolStaff { id: string; firstName: string; lastName: string; email: string }

const empty = { venueId: '', jobRoleId: '', date: '', startTime: '', endTime: '', staffRequired: '1', note: '' };

/**
 * A Venue Manager's shift request (§C) — deliberately not the full "New
 * shift" drawer: no address/pay/break fields, because those come from the
 * assigned Venue the moment it's selected (§B4/C1). The Venue Manager DOES
 * name who they want here, from their authorized "All Users" pool
 * (`GET /staff/venue-directory/pool` — ACTIVE Staff only, server-scoped to
 * this Venue Manager's own assigned-venue workspace, see
 * `StaffService.venueStaffPool`'s doc comment) — this is intent, not an
 * offer: nothing is sent to Staff until an Internal Manager approves
 * (`SchedulingService.submitRequest` re-validates every id server-side
 * before persisting it, never trusting this selection as authorization on
 * its own). The Internal Manager reviews this exact list at approval time
 * in `ShiftApprovalDrawer`, which re-validates ACTIVE status again before
 * any real offer goes out.
 *
 * `GET /venues` is reused as-is for the Venue field's options — for a
 * Venue Manager caller it is already scoped server-side
 * (`VenueService.list`'s `ResourceScopeService` branch) to exactly the
 * venue(s) they're assigned to, so there is nothing further to restrict
 * here; the common case (one assigned venue) auto-selects and shows as a
 * fixed value rather than a real dropdown.
 */
export default function ShiftRequestDrawer() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...empty });
  const [staffIds, setStaffIds] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const handler = () => { setForm({ ...empty }); setStaffIds(new Set()); setSubmitted(false); setOpen(true); };
    document.addEventListener('open-shift-request', handler);
    return () => document.removeEventListener('open-shift-request', handler);
  }, []);

  const { data: venues = [] } = useQuery({
    queryKey: ['venues', 'for-request'],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[] } | Venue[]>('/venues'); return Array.isArray(data) ? data : data.data; },
    enabled: open,
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
    enabled: open,
  });
  const { data: staffPool = [] } = useQuery({
    queryKey: ['staff-pool'],
    queryFn: async () => {
      const { data } = await api.get<{ data: PoolStaff[] }>('/staff/venue-directory/pool', { params: { limit: 100 } });
      return data.data;
    },
    enabled: open,
  });

  useEffect(() => {
    if (venues.length === 1 && !form.venueId) setForm((f) => ({ ...f, venueId: venues[0].id }));
  }, [venues, form.venueId]);

  const selectedVenue = venues.find((v) => v.id === form.venueId);
  const roleOptions = jobRoles.map((r) => ({ id: r.id, label: r.name }));
  const staffOptions = staffPool.map((s) => ({ id: s.id, label: `${s.firstName} ${s.lastName}`, sublabel: s.email }));

  const submit = useMutation({
    mutationFn: () => {
      const startsAt = new Date(`${form.date}T${form.startTime}`).toISOString();
      let endDate = form.date;
      // Overnight shift — end time earlier than start time means it rolls into the next day.
      if (form.endTime && form.startTime && form.endTime <= form.startTime) {
        const d = new Date(`${form.date}T00:00`);
        d.setDate(d.getDate() + 1);
        endDate = d.toISOString().slice(0, 10);
      }
      const endsAt = new Date(`${endDate}T${form.endTime}`).toISOString();
      return api.post('/shifts/request', {
        venueId: form.venueId,
        jobRoleId: form.jobRoleId,
        startsAt,
        endsAt,
        staffRequired: Number(form.staffRequired) || 1,
        staffProfileIds: Array.from(staffIds),
        note: form.note || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setSubmitted(true);
    },
  });

  const f = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: e.target.value });

  const canSubmit = !!form.venueId && !!form.jobRoleId && !!form.date && !!form.startTime && !!form.endTime && Number(form.staffRequired) > 0 && staffIds.size > 0;

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title="Request a shift"
      loading={submit.isPending}
      footer={
        submitted ? (
          <button className="btn btn-dark" onClick={() => setOpen(false)}>Done</button>
        ) : (
          <>
            <button className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-dark" onClick={() => submit.mutate()} disabled={!canSubmit || submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit for Manager Approval'}
            </button>
          </>
        )
      }
    >
      {submitted ? (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Request submitted</p>
          <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>
            Waiting for an Internal Manager to approve it before offers go out.
          </p>
        </div>
      ) : (
        <>
          <div className="field">
            <label>Venue</label>
            {venues.length <= 1 ? (
              <input value={selectedVenue?.name ?? '—'} disabled />
            ) : (
              <SearchableSelect
                options={venues.map((v) => ({ id: v.id, label: v.name }))}
                placeholder="Select venue…"
                value={form.venueId}
                onChange={(venueId) => setForm({ ...form, venueId })}
              />
            )}
          </div>
          <div className="field">
            <label>Role</label>
            <SearchableSelect options={roleOptions} placeholder="Search roles…" value={form.jobRoleId} onChange={(jobRoleId) => setForm({ ...form, jobRoleId })} />
          </div>
          <div className="form-grid-3">
            <div className="field"><label>Date</label><input type="date" value={form.date} onChange={f('date')} /></div>
            <div className="field"><label>Start time</label><input type="time" value={form.startTime} onChange={f('startTime')} /></div>
            <div className="field"><label>End time</label><input type="time" value={form.endTime} onChange={f('endTime')} /></div>
          </div>
          <div className="field">
            <label>Staff required</label>
            <input type="number" min={1} value={form.staffRequired} onChange={f('staffRequired')} />
          </div>
          <div className="field field-full">
            <label>Select staff *</label>
            <SearchableSelect
              mode="multi"
              options={staffOptions}
              placeholder="Search staff…"
              values={staffIds}
              onToggle={(id) => {
                const next = new Set(staffIds);
                if (next.has(id)) next.delete(id); else next.add(id);
                setStaffIds(next);
              }}
              onSelectAll={() => setStaffIds(new Set(staffOptions.map((o) => o.id)))}
              onClearAll={() => setStaffIds(new Set())}
            />
            <p style={{ fontSize: 12, color: 'var(--font-secondary)', margin: '4px 0 0' }}>
              Only active Staff you're authorized to select appear here. Nothing is sent to them yet — your Internal Manager reviews this request first.
            </p>
          </div>
          {selectedVenue && (
            <p style={{ fontSize: 12, color: 'var(--font-secondary)', margin: '-8px 0 12px' }}>
              Break: {selectedVenue.defaultBreakMinutes ?? 0} min{selectedVenue.breakPaid ? ' (paid)' : ' (unpaid)'} · Pay rate: venue/role default, set by your Internal Manager.
            </p>
          )}
          <div className="field field-full">
            <label>Note</label>
            <textarea value={form.note} onChange={f('note') as any} rows={3} placeholder="Anything the approving manager or staff should know" />
          </div>
          {submit.isError && <p className="error">Could not submit this request. Please check the details and try again.</p>}
        </>
      )}
    </Drawer>
  );
}
