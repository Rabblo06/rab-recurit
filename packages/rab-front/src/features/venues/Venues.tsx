import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArchive, IconPencil, IconSearch, IconPlus } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';

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

function editVenue(venue: Venue) {
  document.dispatchEvent(new CustomEvent('open-edit-venue', { detail: { venue } }));
}
function openCreateVenue() {
  document.dispatchEvent(new CustomEvent('open-create-venue'));
}

export default function Venues() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const { data: venues = [], isLoading } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<Venue[]>('/venues'); return data; },
  });

  // Venues are archived, never deleted (rab-workforce-architecture.md §13
  // edge cases — shifts and history keep referencing a venue after it stops
  // taking new bookings).
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/venues/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['venues'] }),
  });

  const active = venues.filter((v) => v.status === 'active');
  const filtered = useMemo(() => active.filter((v) => {
    const q = search.toLowerCase();
    return !q
      || v.name.toLowerCase().includes(q)
      || (v.clientName ?? '').toLowerCase().includes(q)
      || v.type.toLowerCase().includes(q);
  }), [active, search]);

  return (
    <div className="page">
      <PageHeader title="Venues" subtitle={`${active.length} venue${active.length === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <span className="tab-link active">All venues</span>
      </div>

      <div className="list-toolbar-row">
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="list-toolbar-actions">
          <button className="btn btn-accent-outline" onClick={openCreateVenue}>
            <IconPlus size={14}/> New venue
          </button>
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {isLoading ? (
          <TableSkeleton columns={5} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 'auto' }}>Venue</th>
                <th>Address</th>
                <th>Client</th>
                <th>Type</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id}>
                  <td style={{ width: 'auto' }}>
                    <span className="record-chip">
                      <span className="mini-avatar" style={{ background: '#fdded9', color: '#d93025' }}>{v.name?.[0]}</span>
                      {v.name}
                    </span>
                  </td>
                  <td className="cell-muted">{[v.address?.line1, v.address?.city, v.address?.postcode].filter(Boolean).join(', ') || '–'}</td>
                  <td className="cell-muted">{v.clientName ?? '–'}</td>
                  <td><span className={`badge badge-active`}>{v.type}</span></td>
                  <td>
                    <div className="row-actions">
                      <button className="btn-icon" title="Edit" onClick={() => editVenue(v)}><IconPencil size={14}/></button>
                      <button className="btn-icon danger" title="Archive" onClick={() => archive.mutate(v.id)}><IconArchive size={14}/></button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5}>
                  <EmptyState
                    variant={search ? 'matches' : undefined}
                    title={search ? 'No venues found' : 'No venues yet'}
                    description={search ? 'Try a different name, client, or type.' : 'Add a venue to begin scheduling shifts.'}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="list-footer">
        <span>Calculate</span>
        <span className="list-footer-divider"/>
        <span>Count all <strong>{filtered.length}</strong></span>
      </div>
    </div>
  );
}
