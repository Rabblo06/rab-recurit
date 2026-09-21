import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { buildGeofencePayload, parseCoordinatePair, validateGeofence } from './venueGeofence';

interface Venue {
  id: string;
  name: string;
  clientName: string | null;
  type: string;
  address: { line1?: string; city?: string; postcode?: string };
  instructions: string | null;
  breakPaid: boolean;
  defaultBreakMinutes: number | null;
  lat: number | null;
  lng: number | null;
  geofenceRadiusM: number;
  enforceGeofence: boolean;
  status: string;
}

interface JobRole { id: string; name: string }
interface VenueRoleRate { id: string; jobRoleId: string; payRatePence: number }

const VENUE_TYPES = ['hotel', 'restaurant', 'warehouse', 'event', 'other'];

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;

const empty = {
  name: '',
  clientName: '',
  type: 'hotel',
  line1: '',
  city: '',
  postcode: '',
  instructions: '',
  breakPaid: false,
  defaultBreakMinutes: '',
  lat: '',
  lng: '',
  // The server's own default for a venue that has never set one.
  geofenceRadiusM: '200',
  enforceGeofence: false,
};

/**
 * Global create/edit-venue drawer — mounted once in Layout.tsx (never inside
 * Venues.tsx itself), same pattern as CreateUserModal/UserDetailPanel.
 * That placement isn't cosmetic: `RightSidePanel` is a push-layout flex
 * sibling of `.main-content` inside `.app-layout`'s row — nesting it inside
 * a page's own `.page` column instead (which is how this used to render,
 * along with the New Shift/Cancel Shift/Send Offer drawers) breaks that
 * layout contract and is why those drawers rendered on the left with the
 * rest of the page blanked out.
 *
 * Opened globally via:
 *   document.dispatchEvent(new CustomEvent('open-create-venue'))
 *   document.dispatchEvent(new CustomEvent('open-edit-venue', { detail: { venue } }))
 */
export default function CreateVenueDrawer() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [initialForm, setInitialForm] = useState({ ...empty });

  useEffect(() => {
    const handleCreate = () => {
      setEditId(null);
      setForm({ ...empty });
      setInitialForm({ ...empty });
      setOpen(true);
    };
    const handleEdit = (e: Event) => {
      const venue = (e as CustomEvent).detail?.venue as Venue | undefined;
      if (!venue) return;
      const loaded = {
        name: venue.name,
        clientName: venue.clientName ?? '',
        type: venue.type,
        line1: venue.address?.line1 ?? '',
        city: venue.address?.city ?? '',
        postcode: venue.address?.postcode ?? '',
        instructions: venue.instructions ?? '',
        breakPaid: venue.breakPaid,
        defaultBreakMinutes: venue.defaultBreakMinutes != null ? String(venue.defaultBreakMinutes) : '',
        // Real stored values, never silently replaced with defaults on edit.
        lat: venue.lat != null ? String(venue.lat) : '',
        lng: venue.lng != null ? String(venue.lng) : '',
        geofenceRadiusM: venue.geofenceRadiusM != null ? String(venue.geofenceRadiusM) : '',
        enforceGeofence: venue.enforceGeofence === true,
      };
      setEditId(venue.id);
      setForm(loaded);
      setInitialForm(loaded);
      setOpen(true);
    };
    document.addEventListener('open-create-venue', handleCreate);
    document.addEventListener('open-edit-venue', handleEdit);
    return () => {
      document.removeEventListener('open-create-venue', handleCreate);
      document.removeEventListener('open-edit-venue', handleEdit);
    };
  }, []);

  const save = useMutation({
    mutationFn: (body: typeof form) => {
      const payload = {
        name: body.name,
        clientName: body.clientName || undefined,
        type: body.type,
        address: { line1: body.line1, city: body.city, postcode: body.postcode },
        instructions: body.instructions || undefined,
        breakPaid: body.breakPaid,
        defaultBreakMinutes: body.defaultBreakMinutes ? Number(body.defaultBreakMinutes) : undefined,
        ...buildGeofencePayload(body, !!editId),
      };
      return editId
        ? api.patch<Venue>(`/venues/${editId}`, payload)
        : api.post<Venue>('/venues', payload);
    },
    onSuccess: ({ data }, variables) => {
      qc.invalidateQueries({ queryKey: ['venues'] });
      // Pay Details needs a real venueId to attach rates to — once a brand
      // new venue is created, drop straight into editing it (same drawer,
      // same open state) instead of closing, so the manager can add rates
      // immediately without a second "New venue" round-trip.
      if (!editId) {
        setEditId(data.id);
        setInitialForm(variables);
      } else {
        setOpen(false);
        setEditId(null);
        setForm({ ...empty });
      }
    },
  });

  // A previous save's server error must not greet the next open of the drawer.
  useEffect(() => { if (open) save.reset(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const jobRoles = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
    enabled: open,
  });
  const roleRates = useQuery({
    queryKey: ['venue-role-rates', editId],
    queryFn: async () => { const { data } = await api.get<VenueRoleRate[]>(`/venues/${editId}/role-rates`); return data; },
    enabled: open && !!editId,
  });
  const [newRateRole, setNewRateRole] = useState('');
  const [newRateAmount, setNewRateAmount] = useState('');
  const addRoleRate = useMutation({
    mutationFn: () =>
      api.post(`/venues/${editId}/role-rates`, {
        jobRoleId: newRateRole,
        payRatePence: Math.round(parseFloat(newRateAmount) * 100),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['venue-role-rates', editId] });
      setNewRateRole('');
      setNewRateAmount('');
    },
  });
  const removeRoleRate = useMutation({
    mutationFn: (rateId: string) => api.delete(`/venues/${editId}/role-rates/${rateId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venue-role-rates', editId] }),
  });

  const geofenceErrors = validateGeofence(form);
  const hasGeofenceErrors = Object.keys(geofenceErrors).length > 0;
  const saveError = save.isError
    ? (() => {
        const message = (save.error as any)?.response?.data?.message;
        return Array.isArray(message) ? message.join(' ') : message ?? 'Could not save this venue. Please try again.';
      })()
    : null;
  // Google Maps' "copy coordinates" gives "51.5074, -0.1278" — split it across both fields.
  const onLatPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pair = parseCoordinatePair(e.clipboardData.getData('text'));
    if (!pair) return;
    e.preventDefault();
    setForm({ ...form, ...pair });
  };

  const f = (key: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title={editId ? 'Edit venue' : 'Create venue'}
      loading={save.isPending}
      dirty={JSON.stringify(form) !== JSON.stringify(initialForm)}
      footer={
        <>
          <button className="btn btn-outline" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-dark" onClick={() => save.mutate(form)} disabled={save.isPending || !form.name || hasGeofenceErrors}>
            {save.isPending ? 'Saving…' : editId ? 'Save changes' : 'Create venue'}
          </button>
        </>
      }
    >
      <div className="field"><label>Venue name</label><input value={form.name} onChange={f('name')} /></div>
      <div className="form-grid">
        <div className="field"><label>Client name</label><input value={form.clientName} onChange={f('clientName')} /></div>
        <div className="field">
          <label>Type</label>
          <select value={form.type} onChange={f('type') as any}>
            {VENUE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label>Address</label><input value={form.line1} onChange={f('line1')} /></div>
      <div className="form-grid">
        <div className="field"><label>City</label><input value={form.city} onChange={f('city')} /></div>
        <div className="field"><label>Postcode</label><input value={form.postcode} onChange={f('postcode')} /></div>
      </div>
      <div className="field"><label>Note</label><textarea value={form.instructions} onChange={f('instructions') as any} rows={3} placeholder="Entrance instructions, security access, meeting point, dress expectations…" /></div>

      <h4 style={{ margin: '16px 0 8px', fontSize: 13, fontWeight: 600 }}>Location &amp; Geofence</h4>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="venue-lat">Latitude</label>
          <input
            id="venue-lat"
            inputMode="decimal"
            value={form.lat}
            onChange={f('lat')}
            onPaste={onLatPaste}
            placeholder="e.g. 51.5074"
            aria-invalid={!!geofenceErrors.lat}
          />
          {geofenceErrors.lat && <p className="field-hint" role="alert" style={{ color: 'var(--color-red)' }}>{geofenceErrors.lat}</p>}
        </div>
        <div className="field">
          <label htmlFor="venue-lng">Longitude</label>
          <input
            id="venue-lng"
            inputMode="decimal"
            value={form.lng}
            onChange={f('lng')}
            placeholder="e.g. -0.1278"
            aria-invalid={!!geofenceErrors.lng}
          />
          {geofenceErrors.lng && <p className="field-hint" role="alert" style={{ color: 'var(--color-red)' }}>{geofenceErrors.lng}</p>}
        </div>
      </div>
      <p className="field-hint" style={{ margin: '-6px 0 12px' }}>
        Right-click the venue location in Google Maps and copy the latitude and longitude. Pasting both numbers into Latitude fills both fields.
      </p>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor="venue-radius">Geofence radius</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="venue-radius"
            inputMode="numeric"
            value={form.geofenceRadiusM}
            onChange={f('geofenceRadiusM')}
            placeholder="e.g. 100"
            aria-invalid={!!geofenceErrors.radius}
          />
          <span style={{ fontSize: 12, color: 'var(--font-secondary)' }}>metres</span>
        </div>
        {geofenceErrors.radius && <p className="field-hint" role="alert" style={{ color: 'var(--color-red)' }}>{geofenceErrors.radius}</p>}
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--font-primary)', marginBottom: 0 }}>
          <input
            type="checkbox"
            role="switch"
            style={{ width: 'auto', height: 'auto' }}
            checked={form.enforceGeofence}
            onChange={(e) => setForm({ ...form, enforceGeofence: e.target.checked })}
          />
          Enforce geofence
        </label>
        <p className="field-hint">When on, Staff can only clock in or out inside the radius. Off by default.</p>
        {geofenceErrors.enforce && <p className="field-hint" role="alert" style={{ color: 'var(--color-red)' }}>{geofenceErrors.enforce}</p>}
      </div>

      <h4 style={{ margin: '16px 0 8px', fontSize: 13, fontWeight: 600 }}>Break Settings</h4>
      <div className="form-grid">
        <div className="field">
          <label>Default break minutes</label>
          <input type="number" min={0} step={5} value={form.defaultBreakMinutes} onChange={f('defaultBreakMinutes')} placeholder="e.g. 30" />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, alignSelf: 'end', marginBottom: 8 }}>
          <input type="checkbox" checked={form.breakPaid} onChange={e => setForm({ ...form, breakPaid: e.target.checked })} />
          Paid
        </label>
      </div>

      {saveError && <p className="field-hint" role="alert" style={{ color: 'var(--color-red)', fontSize: 12 }}>{saveError}</p>}

      <h4 style={{ margin: '16px 0 8px', fontSize: 13, fontWeight: 600 }}>Pay Details</h4>
      {!editId ? (
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary, #6b7280)' }}>
          Save the venue first to add role pay rates.
        </p>
      ) : (
        <>
          {roleRates.data?.map((rate) => {
            const role = jobRoles.data?.find((r) => r.id === rate.jobRoleId);
            return (
              <div key={rate.id} className="form-grid" style={{ alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13 }}>{role?.name ?? 'Unknown role'}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>{fmtMoney(rate.payRatePence)}/h</span>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ padding: '2px 8px' }}
                    onClick={() => removeRoleRate.mutate(rate.id)}
                    disabled={removeRoleRate.isPending}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
          <div className="form-grid" style={{ alignItems: 'end' }}>
            <div className="field">
              <label>Role</label>
              <select value={newRateRole} onChange={(e) => setNewRateRole(e.target.value)}>
                <option value="">Select role…</option>
                {jobRoles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Hourly rate (£)</label>
              <input type="number" step="0.01" min={0} value={newRateAmount} onChange={(e) => setNewRateAmount(e.target.value)} />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-outline"
            style={{ marginTop: 8 }}
            onClick={() => addRoleRate.mutate()}
            disabled={!newRateRole || !newRateAmount || addRoleRate.isPending}
          >
            + Add another role rate
          </button>
        </>
      )}
    </Drawer>
  );
}
