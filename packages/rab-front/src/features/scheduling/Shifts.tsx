import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconBuildingSkyscraper, IconBriefcase, IconCalendar, IconClock,
  IconCurrencyPound, IconUsers, IconCircleCheck, IconPlus,
  IconSend, IconBan, IconRocket,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import ViewBar from '../../shared/components/ViewBar';
import TableFooter from '../../shared/components/TableFooter';

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

export default function Shifts() {
  const qc = useQueryClient();

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

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/shifts/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shifts'] }),
  });

  return (
    <div className="page">
      <ViewBar label="All Shifts" count={shifts.length} />

      <div className="table-container">
        {isLoading ? (
          <p className="muted" style={{ padding: 24 }}>Loading…</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th><span className="th-inner"><IconBuildingSkyscraper size={14} />Venue</span></th>
                <th><span className="th-inner"><IconBriefcase size={14} />Role</span></th>
                <th><span className="th-inner"><IconCalendar size={14} />Date</span></th>
                <th><span className="th-inner"><IconClock size={14} />Time</span></th>
                <th><span className="th-inner"><IconUsers size={14} />Filled</span></th>
                <th><span className="th-inner"><IconCurrencyPound size={14} />Rate</span></th>
                <th><span className="th-inner"><IconCircleCheck size={14} />Status</span></th>
                <th style={{ width: 120 }}><IconPlus size={14} /></th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
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
              {shifts.length === 0 && (
                <tr><td colSpan={8}><div className="empty-state"><p>No shifts yet. Click "+ New Shift" to schedule one.</p></div></td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <TableFooter count={shifts.length} />
    </div>
  );
}
