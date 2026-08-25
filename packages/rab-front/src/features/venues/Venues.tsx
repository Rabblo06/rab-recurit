import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconArchive, IconPencil, IconMapPin, IconMap, IconBuilding,
  IconBriefcase, IconPlus,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import ViewBar from '../../shared/components/ViewBar';
import TableFooter from '../../shared/components/TableFooter';

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

export default function Venues() {
  const qc = useQueryClient();

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

  return (
    <div className="page">
      <ViewBar label="All Venues" count={active.length}/>

      <div className="table-container">
        {isLoading ? (
          <p className="muted" style={{ padding: 24 }}>Loading…</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 'auto', paddingLeft: 12 }}><span className="th-inner"><IconMapPin size={14}/>Venue</span></th>
                <th><span className="th-inner"><IconMap size={14}/>Address</span></th>
                <th><span className="th-inner"><IconBuilding size={14}/>Client</span></th>
                <th><span className="th-inner"><IconBriefcase size={14}/>Type</span></th>
                <th style={{ width: 40 }}><IconPlus size={14}/></th>
              </tr>
            </thead>
            <tbody>
              {active.map((v) => (
                <tr key={v.id}>
                  <td style={{ paddingLeft: 12, width: 'auto' }}>
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
              {active.length === 0 && (
                <tr><td colSpan={5}><div className="empty-state"><p>No venues yet. Click "+ New Venue" to add one.</p></div></td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <TableFooter count={active.length}/>
    </div>
  );
}
