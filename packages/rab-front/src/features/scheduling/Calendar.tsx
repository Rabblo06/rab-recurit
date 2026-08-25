import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { api } from '../../shared/api';

interface Shift {
  id: string;
  venueId: string;
  jobRoleId: string;
  startsAt: string;
  endsAt: string;
  requiredCount: number;
  filledCount: number;
  status: string;
}
interface Venue { id: string; name: string }
interface JobRole { id: string; name: string }

const statusColors: Record<string, { bg: string; color: string }> = {
  draft:             { bg: '#f1f1f1', color: '#666666' },
  open:              { bg: '#dbe9fe', color: '#1961ed' },
  offered:           { bg: '#dbe9fe', color: '#1961ed' },
  partially_filled:  { bg: '#fdf2d4', color: '#946c00' },
  fully_filled:      { bg: '#d9f0de', color: '#2a8e44' },
  confirmed:         { bg: '#d9f0de', color: '#2a8e44' },
  in_progress:       { bg: '#f1e6fd', color: '#7d3bc8' },
  completed:         { bg: '#f1e6fd', color: '#7d3bc8' },
  cancelled:         { bg: '#fdded9', color: '#d93025' },
};

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Calendar() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Pad a week either side so the leading/trailing days of the grid (which
  // belong to the adjacent month) still show their shifts.
  const rangeFrom = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth(), 1 - 7), [cursor]);
  const rangeTo = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth() + 1, 7), [cursor]);

  const { data: shifts = [] } = useQuery({
    queryKey: ['shifts', 'calendar', rangeFrom.toISOString(), rangeTo.toISOString()],
    queryFn: async () => {
      const { data } = await api.get<Shift[]>('/shifts', { params: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() } });
      return data;
    },
  });
  const { data: venues = [] } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<Venue[]>('/venues'); return data; },
  });
  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
  });
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '';

  const byDate = useMemo(() => {
    const map: Record<string, Shift[]> = {};
    for (const s of shifts) {
      const key = s.startsAt.slice(0, 10);
      (map[key] ??= []).push(s);
    }
    return map;
  }, [shifts]);

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first offset
    const start = new Date(year, month, 1 - lead);
    const out: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({ date: d, inMonth: d.getMonth() === month });
    }
    return out;
  }, [cursor]);

  const todayKey = new Date().toLocaleDateString('sv-SE');

  return (
    <div className="page">
      <div className="calendar">
        <div className="calendar-head">
          <span className="calendar-month">
            {cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </span>
          <button className="btn-icon" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <IconChevronLeft size={16} />
          </button>
          <button className="btn-icon" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <IconChevronRight size={16} />
          </button>
          <button className="btn btn-outline" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>
            Today
          </button>
        </div>

        <div className="calendar-grid">
          {DOW.map((d) => <div key={d} className="calendar-dow">{d}</div>)}
          {cells.map(({ date, inMonth }) => {
            const key = date.toLocaleDateString('sv-SE');
            const events = byDate[key] ?? [];
            const isToday = key === todayKey;
            return (
              <div key={key} className={`calendar-cell${inMonth ? '' : ' other-month'}`}>
                <span className={`calendar-day-num${isToday ? ' today' : ''}`}>{date.getDate()}</span>
                {events.slice(0, 3).map((s) => {
                  const c = statusColors[s.status] ?? statusColors.draft;
                  return (
                    <div
                      key={s.id}
                      className="calendar-event"
                      style={{ background: c.bg, color: c.color }}
                      title={`${venueName(s.venueId)} · ${roleName(s.jobRoleId)} · ${s.filledCount}/${s.requiredCount} filled · ${s.status.replace(/_/g, ' ')}`}
                    >
                      {new Date(s.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} {venueName(s.venueId)}
                    </div>
                  );
                })}
                {events.length > 3 && (
                  <span style={{ fontSize: 10, color: 'var(--font-tertiary)' }}>+{events.length - 3} more</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
