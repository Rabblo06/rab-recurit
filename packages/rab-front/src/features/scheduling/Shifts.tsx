import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconClock, IconSend, IconBan, IconRocket, IconSearch, IconPlus,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';

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

const ACTIVE_STATUSES = ['open', 'offered', 'partially_filled'];

const fmtMoney = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function openSendOffer(shift: Shift) {
  document.dispatchEvent(new CustomEvent('open-send-offer', { detail: { shift } }));
}
function openCancelShift(shiftId: string) {
  document.dispatchEvent(new CustomEvent('open-cancel-shift', { detail: { shiftId } }));
}
function openCreateShift() {
  document.dispatchEvent(new CustomEvent('open-create-placement'));
}

export default function Shifts() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['shifts'],
    queryFn: async () => { const { data } = await api.get<Shift[]>('/shifts'); return data; },
  });
  const { data: venues = [] } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<Venue[]>('/venues'); return data; },
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
  });

  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '–';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '–';

  const filtered = useMemo(() => shifts.filter((s) => {
    const q = search.toLowerCase();
    return !q
      || venueName(s.venueId).toLowerCase().includes(q)
      || roleName(s.jobRoleId).toLowerCase().includes(q)
      || s.status.toLowerCase().includes(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [shifts, search, venues, jobRoles]);

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/shifts/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });

  return (
    <div className="page">
      <PageHeader title="Shifts" subtitle={`${shifts.length} shift${shifts.length === 1 ? '' : 's'}`} />

      <div className="list-tabs-row">
        <span className="tab-link active">All shifts</span>
      </div>

      <div className="list-toolbar-row">
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <div className="list-toolbar-actions">
          <button className="btn btn-accent-outline" onClick={openCreateShift}>
            <IconPlus size={14}/> New shift
          </button>
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {isLoading ? (
          <TableSkeleton columns={8} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Role</th>
                <th>Date</th>
                <th>Time</th>
                <th>Filled</th>
                <th>Rate</th>
                <th>Status</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="record-chip">
                      <span className="mini-avatar" style={{ background: '#d9f0de', color: '#2a8e44' }}>{venueName(s.venueId)[0]}</span>
                      {venueName(s.venueId)}
                    </span>
                  </td>
                  <td className="cell-muted">{roleName(s.jobRoleId)}</td>
                  <td className="cell-muted">{fmtDate(s.startsAt)}</td>
                  <td><span className="cell-icon-text"><IconClock size={13} />{fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}</span></td>
                  <td className="cell-muted">{s.filledCount} / {s.requiredCount}</td>
                  <td style={{ color: 'var(--color-green)', fontWeight: 500 }}>{fmtMoney(s.payRatePence)}/hr</td>
                  <td><span className={`badge badge-${s.status}`}>{s.status.replace(/_/g, ' ')}</span></td>
                  <td>
                    <div className="row-actions action-btns">
                      {s.status === 'draft' && (
                        <button className="btn-icon success" title="Publish" onClick={() => publish.mutate(s.id)}>
                          <IconRocket size={14} />
                        </button>
                      )}
                      {ACTIVE_STATUSES.includes(s.status) && s.filledCount < s.requiredCount && (
                        <button className="btn-icon" title="Send offer" onClick={() => openSendOffer(s)}>
                          <IconSend size={14} />
                        </button>
                      )}
                      {!['cancelled', 'completed'].includes(s.status) && (
                        <button className="btn-icon danger" title="Cancel shift" onClick={() => openCancelShift(s.id)}>
                          <IconBan size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState
                    variant={search ? 'matches' : 'tasks'}
                    title={search ? 'No shifts found' : 'No shifts yet'}
                    description={search ? 'Try a different venue, role, or status.' : 'Schedule a shift to start filling your rota.'}
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
