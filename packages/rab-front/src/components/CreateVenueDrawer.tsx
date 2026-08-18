import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import Drawer from './Drawer';

interface Venue {
  id: string;
  name: string;
  clientName: string | null;
  type: string;
  address: { line1?: string; city?: string; postcode?: string };
  instructions: string | null;
  breakPaid: boolean;
  status: string;
}

const VENUE_TYPES = ['hotel', 'restaurant', 'warehouse', 'event', 'other'];

const empty = { name: '', clientName: '', type: 'hotel', line1: '', city: '', postcode: '', instructions: '', breakPaid: false };

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
      };
      return editId ? api.patch(`/venues/${editId}`, payload) : api.post('/venues', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['venues'] });
      setOpen(false);
      setEditId(null);
      setForm({ ...empty });
    },
  });

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
          <button className="btn btn-dark" onClick={() => save.mutate(form)} disabled={save.isPending || !form.name}>
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
      <div className="field"><label>Instructions</label><textarea value={form.instructions} onChange={f('instructions') as any} rows={3} /></div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '8px 0' }}>
        <input type="checkbox" checked={form.breakPaid} onChange={e => setForm({ ...form, breakPaid: e.target.checked })} />
        Breaks are paid at this venue
      </label>
    </Drawer>
  );
}
