import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconChevronRight, IconPlus, IconCalendar } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { CalendarSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';

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
interface ScheduledPerson { id: string; shiftId: string; staffName: string; status: string }

function ScheduledStaff({ shiftId, day }: { shiftId: string; day: string }) {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  // The existing offer endpoint treats its upper date as inclusive (+ one UTC day).
  const {data,isLoading,isError} = useQuery({
    queryKey:['offers','calendar-staff',day],
    queryFn:async () => (await api.get<{data:ScheduledPerson[];total:number}>('/offers',{params:{status:'manager_confirmed',shiftDateFrom:start.toISOString(),shiftDateTo:new Date(end.getTime()-86_400_000).toISOString(),limit:500}})).data,
  });
  if (isLoading) return <p>Loading scheduled staff…</p>;
  if (isError) return <p>Staff details are unavailable for this account.</p>;
  const people = data?.data?.filter(person=>person.shiftId===shiftId) ?? [];
  return <><ul className="calendar-staff-list">{people.map(person=><li key={person.id}>{person.staffName}</li>)}</ul>{(data?.total ?? 0)>500 && <p>Showing the first 500 confirmed offers. Open Offers for the full list.</p>}</>;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Calendar() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const openCreate = () => document.dispatchEvent(new CustomEvent('open-create-placement'));

  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Pad a week either side so the leading/trailing days of the grid (which
  // belong to the adjacent month) still show their shifts.
  const rangeFrom = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth(), 1 - 7), [cursor]);
  const rangeTo = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth() + 1, 7), [cursor]);

  const { data: shifts = [], isLoading: shiftsLoading, isError, refetch } = useQuery({
    queryKey: ['shifts', 'calendar', rangeFrom.toISOString(), rangeTo.toISOString()],
    queryFn: async () => {
      const { data } = await api.get<{ data: Shift[] } | Shift[]>('/shifts', { params: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() } });
      return Array.isArray(data) ? data : data.data;
    },
  });
  const { data: venues = [], isLoading: venuesLoading } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get<{ data: Venue[] } | Venue[]>('/venues'); return Array.isArray(data) ? data : data.data; },
  });
  const { data: jobRoles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get<JobRole[]>('/job-roles'); return data; },
  });
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '';

  const byDate = useMemo(() => {
    const map: Record<string, Shift[]> = {};
    for (const s of shifts) {
      const key = new Date(s.startsAt).toLocaleDateString('sv-SE');
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

  const selectedKey = selectedDate.toLocaleDateString('sv-SE');
  const selectedShifts = byDate[selectedKey] ?? [];
  return (
    <div className="page">
      <PageHeader title="Calendar" action={<button className="btn btn-dark" onClick={openCreate}><IconPlus size={14} /> New shift</button>} />
      <div className="calendar walnut-calendar">
        <div className="calendar-head">
          <h2 className="calendar-month">{cursor.toLocaleDateString('en-GB', {month:'long',year:'numeric'})}</h2>
          <button className="btn btn-outline calendar-today" onClick={() => {const d=new Date();setCursor(new Date(d.getFullYear(),d.getMonth(),1));setSelectedDate(d);}}>Today</button>
          <div className="calendar-arrows">
            <button className="btn-icon" aria-label="Previous month" onClick={() => setCursor(new Date(cursor.getFullYear(),cursor.getMonth()-1,1))}><IconChevronLeft size={16} /></button>
            <button className="btn-icon" aria-label="Next month" onClick={() => setCursor(new Date(cursor.getFullYear(),cursor.getMonth()+1,1))}><IconChevronRight size={16} /></button>
          </div>
          <span className="calendar-view-label">Month</span>
        </div>
        {isError && <div className="list-error" role="alert">Could not load the schedule. <button className="btn btn-outline" onClick={() => refetch()}>Retry</button></div>}
        <div className="calendar-body">
          {shiftsLoading || venuesLoading || rolesLoading ? <CalendarSkeleton /> : <div className="calendar-grid" role="group" aria-label="Month calendar">
            {DOW.map(d => <div key={d} className="calendar-dow">{d}</div>)}
            {cells.map(({date,inMonth}) => {
              const key=date.toLocaleDateString('sv-SE');const events=byDate[key] ?? [];
              return <button type="button" key={key} aria-label={`${date.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}, ${events.length} shifts`} aria-pressed={key === selectedKey} onClick={() => setSelectedDate(date)} className={`calendar-cell${inMonth ? '' : ' other-month'}${key === selectedKey ? ' selected-day' : ''}`}>
                <span className={`calendar-day-num${key === todayKey ? ' today' : ''}`}>{date.getDate()}</span>
                {events.slice(0,3).map(shift => <span key={shift.id} className={`calendar-event calendar-status-${shift.status}`} title={`${venueName(shift.venueId)} · ${roleName(shift.jobRoleId)} · ${shift.filledCount}/${shift.requiredCount} filled · ${shift.status.replace(/_/g,' ')}`}>{new Date(shift.startsAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} {venueName(shift.venueId)}</span>)}
                {events.length > 3 && <span className="calendar-more">+{events.length-3} more</span>}
              </button>;
            })}
          </div>}
          <aside className="calendar-detail" aria-label="Selected day">
            <div className="calendar-day-card"><p className="calendar-detail-eyebrow">{selectedDate.toLocaleDateString("en-GB",{weekday:"long"})}</p>
            <h3>{selectedDate.toLocaleDateString('en-GB',{day:'numeric',month:'long'})}</h3>
            <p className="calendar-detail-subtitle">{isError ? 'Schedule could not be loaded' : shiftsLoading ? 'Loading schedule…' : `${selectedShifts.length} shift${selectedShifts.length === 1 ? '' : 's'} scheduled`}</p>
            {selectedShifts.length === 0 ? <div className="calendar-day-empty"><IconCalendar size={26} stroke={1.3} /><strong>{isError ? 'Schedule unavailable' : 'A clear day ahead'}</strong><p>{isError ? 'Retry to check this day’s shifts.' : 'Create a shift to start planning your team’s coverage.'}</p></div> : <div className="calendar-day-events">{selectedShifts.map(shift => <article key={shift.id}><h4>{venueName(shift.venueId)}</h4><p>{roleName(shift.jobRoleId)}</p><p>{new Date(shift.startsAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} – {new Date(shift.endsAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</p><span>{shift.filledCount} / {shift.requiredCount} staff allocated</span><span className={`badge badge-${shift.status}`}>{shift.status.replace(/_/g,' ')}</span><ScheduledStaff shiftId={shift.id} day={selectedKey} /></article>)}</div>}
            <button className="btn btn-dark" onClick={openCreate}><IconPlus size={14} /> Add shift</button></div>
            <div className="calendar-legend"><p>Schedule at a glance</p><span><i className="legend-today" /> Today</span><span><i className="legend-selected" /> Selected day</span>{shifts.length > 0 && <><span><i className="legend-open" /> Open / awaiting staff</span><span><i className="legend-confirmed" /> Confirmed</span><span><i className="legend-completed" /> Completed</span></>}<p className="calendar-timezone">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g," ")}.</p></div>
          </aside>
        </div>
      </div>
    </div>
  );
}
