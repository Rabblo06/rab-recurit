import { useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { contentSwap, period } from '../../shared/motion';
import { useQuery } from '@tanstack/react-query';
import { IconChevronLeft, IconChevronRight, IconPlus, IconCalendar } from '@tabler/icons-react';
import { fetchAllPages } from '../../shared/table-toolbar/pagination';
import { jobRolesQuery } from '../../shared/queries/navQueries';
import { venuesWithArchivedQuery } from './schedulingQueries';
import { CalendarSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';
import {
  CALENDAR_VIEWS,
  type CalendarView,
  addDays,
  dayKey,
  groupByDay,
  layoutDay,
  periodRange,
  periodTitle,
  startOfMonth,
  startOfWeek,
  stepAnchor,
  stepLabels,
} from './calendarViews';
import './calendar-views.css';
import CopyWeekDialog from './CopyWeekDialog';
import ShiftPatternDialog from './ShiftPatternDialog';

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
  // Every confirmed offer of the day, in pages of 200 (Phase C1: was one request capped at 500).
  const {data,isLoading,isError} = useQuery({
    queryKey:['offers','calendar-staff',day],
    queryFn:() => fetchAllPages<ScheduledPerson>('/offers',{status:'manager_confirmed',shiftDateFrom:start.toISOString(),shiftDateTo:new Date(end.getTime()-86_400_000).toISOString()}),
  });
  if (isLoading) return <p>Loading scheduled staff…</p>;
  if (isError) return <p className="feedback-error" role="alert">Staff details are unavailable for this account.</p>;
  const people = data?.filter(person=>person.shiftId===shiftId) ?? [];
  return <ul className="calendar-staff-list">{people.map(person=><li key={person.id}>{person.staffName}</li>)}</ul>;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const statusText = (status: string) => status.replace(/_/g, ' ');
const longDay = (date: Date) => date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

interface NameLookups {
  venueName: (id: string) => string;
  roleName: (id: string) => string;
}

/**
 * Week and day views: one timeline column per day, 00:00–24:00, shifts placed by their real
 * start/end and side by side when they overlap. A shift appears on its start day (as in the
 * month grid); one that runs past midnight is clipped at 24:00 and marked "(next day)".
 */
function TimeGrid({ days, shifts, selectedKey, todayKey, onSelect, venueName, roleName, label }: NameLookups & {
  days: Date[];
  shifts: Shift[];
  selectedKey: string;
  todayKey: string;
  onSelect: (day: Date) => void;
  label: string;
}) {
  return (
    <div className={`calendar-timegrid calendar-timegrid-${days.length === 1 ? 'day' : 'week'}`} role="group" aria-label={label} style={{ ['--calendar-columns' as string]: days.length }}>
      <div className="calendar-timegrid-head">
        <span className="calendar-timegrid-corner" aria-hidden="true" />
        {days.map((day) => {
          const key = dayKey(day);
          const count = shifts.filter((shift) => dayKey(new Date(shift.startsAt)) === key).length;
          return (
            <button type="button" key={key} className={`calendar-timegrid-dayhead${key === selectedKey ? ' selected-day' : ''}`} aria-pressed={key === selectedKey} aria-label={`${longDay(day)}, ${count} shifts`} onClick={() => onSelect(day)}>
              <span>{day.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
              <span className={`calendar-day-num${key === todayKey ? ' today' : ''}`}>{day.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className="calendar-timegrid-scroll">
        <div className="calendar-timegrid-body">
          <div className="calendar-timegrid-gutter" aria-hidden="true">
            {HOURS.map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}
          </div>
          {days.map((day) => {
            const key = dayKey(day);
            const placed = layoutDay(shifts, day);
            return (
              <ol key={key} className={`calendar-timegrid-column${key === todayKey ? ' today' : ''}`} aria-label={`Shifts on ${longDay(day)}`}>
                {placed.map(({ shift, startMinute, endMinute, continuesNextDay, lane, lanes }) => (
                  <li
                    key={shift.id}
                    className={`calendar-block calendar-status-${shift.status}`}
                    style={{
                      top: `${(startMinute / 1440) * 100}%`,
                      height: `${((endMinute - startMinute) / 1440) * 100}%`,
                      left: `${(lane / lanes) * 100}%`,
                      width: `${100 / lanes}%`,
                    }}
                    title={`${venueName(shift.venueId)} · ${roleName(shift.jobRoleId)} · ${shift.filledCount}/${shift.requiredCount} filled · ${statusText(shift.status)}`}
                  >
                    <button type="button" onClick={() => onSelect(day)}>
                      <strong>{time(shift.startsAt)}–{time(shift.endsAt)}{continuesNextDay ? ' (next day)' : ''}</strong>
                      <span>{venueName(shift.venueId)}</span>
                      <span>{roleName(shift.jobRoleId)} · {shift.filledCount}/{shift.requiredCount}</span>
                    </button>
                  </li>
                ))}
              </ol>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** List (agenda) view: the month's shifts grouped by day in start order; days with no shifts are skipped. */
function AgendaList({ shifts, from, to, selectedKey, onSelect, venueName, roleName }: NameLookups & {
  shifts: Shift[];
  from: Date;
  to: Date;
  selectedKey: string;
  onSelect: (day: Date) => void;
}) {
  const groups = groupByDay(shifts, from, to);
  if (groups.length === 0) {
    return <div className="calendar-agenda calendar-agenda-empty" role="group" aria-label="Shift list"><IconCalendar size={26} stroke={1.3} /><strong>No shifts this month</strong><p>Create a shift to start planning your team’s coverage.</p></div>;
  }
  return (
    <div className="calendar-agenda" role="group" aria-label="Shift list">
      <table className="calendar-agenda-table">
        <thead>
          <tr><th scope="col">Time</th><th scope="col">Venue</th><th scope="col">Role</th><th scope="col">Staff</th><th scope="col">Status</th></tr>
        </thead>
        {groups.map(({ day, shifts: dayShifts }) => {
          const key = dayKey(day);
          return (
            <tbody key={key}>
              <tr className={`calendar-agenda-day${key === selectedKey ? ' selected-day' : ''}`}>
                <th colSpan={5} scope="rowgroup">
                  <button type="button" aria-pressed={key === selectedKey} onClick={() => onSelect(day)}>
                    {day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    <span>{dayShifts.length} shift{dayShifts.length === 1 ? '' : 's'}</span>
                  </button>
                </th>
              </tr>
              {dayShifts.map((shift) => (
                <tr key={shift.id}>
                  <td>{time(shift.startsAt)} – {time(shift.endsAt)}</td>
                  <td>{venueName(shift.venueId)}</td>
                  <td>{roleName(shift.jobRoleId)}</td>
                  <td>{shift.filledCount} / {shift.requiredCount}</td>
                  <td><span className={`badge badge-${shift.status}`}>{statusText(shift.status)}</span></td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** The anchor that opens `view` on the period containing `date`. */
function anchorFor(view: CalendarView, date: Date): Date {
  if (view === 'month' || view === 'list') return startOfMonth(date);
  if (view === 'week') return startOfWeek(date);
  return date;
}

export default function Calendar() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const openCreate = () => document.dispatchEvent(new CustomEvent('open-create-placement'));

  const [view, setView] = useState<CalendarView>('month');
  const [copyOpen, setCopyOpen] = useState(false);
  const [patternOpen, setPatternOpen] = useState(false);
  // A date inside the period on screen (month/list: day 1 of the month; week: its Monday; day: that day).
  const [anchor, setAnchor] = useState(() => startOfMonth(new Date()));
  // Direction of the last period change (+1 next / -1 previous): the new period slides in from that side.
  const [direction, setDirection] = useState(1);
  const goTo = (target: Date) => {
    setDirection(target.getTime() >= anchor.getTime() ? 1 : -1);
    setAnchor(target);
    // Week and day views carry the selected day along with the period; the month grid and the
    // list keep the user's selection (as the month grid always has).
    if (view === 'week' || view === 'day') setSelectedDate(target);
  };
  const changeView = (next: CalendarView) => {
    if (next === view) return;
    setView(next);
    setAnchor(anchorFor(next, selectedDate));
  };
  const selectDay = (day: Date) => {
    setSelectedDate(day);
    if (view === 'day') setAnchor(day);
  };
  const goToday = () => {
    const today = new Date();
    goTo(anchorFor(view, today));
    setSelectedDate(today);
  };

  const { from: rangeFrom, to: rangeTo } = useMemo(() => periodRange(view, anchor), [view, anchor]);

  const { data: shifts = [], isLoading: shiftsLoading, isPlaceholderData: switchingPeriod, isError, refetch } = useQuery({
    queryKey: ['shifts', 'calendar', rangeFrom.toISOString(), rangeTo.toISOString()],
    // Every shift in the range, in pages of 200 (Phase C1: the server's default page is now 50).
    queryFn: () => fetchAllPages<Shift>('/shifts', { from: rangeFrom.toISOString(), to: rangeTo.toISOString() }),
    // Keep the previous range on screen while the next period loads, so the view slides instead of flashing a
    // skeleton; the detail line says "Loading schedule…" until the real data for the new range arrives.
    placeholderData: (previous) => previous,
  });
  // Name resolution for historical shifts: archived venues included (wave 5 excludes them from the plain list).
  const { data: venues = [], isLoading: venuesLoading } = useQuery(venuesWithArchivedQuery<Venue>());
  const { data: jobRoles = [], isLoading: rolesLoading } = useQuery(jobRolesQuery<JobRole>());
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '';
  const roleName = (id: string) => jobRoles.find((r) => r.id === id)?.name ?? '';

  const byDate = useMemo(() => {
    const map: Record<string, Shift[]> = {};
    for (const s of shifts) {
      const key = dayKey(new Date(s.startsAt));
      (map[key] ??= []).push(s);
    }
    return map;
  }, [shifts]);

  const cells = useMemo(() => {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first offset
    const start = new Date(year, month, 1 - lead);
    const out: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push({ date: d, inMonth: d.getMonth() === month });
    }
    return out;
  }, [anchor]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)), [anchor]);

  const todayKey = dayKey(new Date());
  const selectedKey = dayKey(selectedDate);
  const selectedShifts = byDate[selectedKey] ?? [];
  const labels = stepLabels(view);

  let body;
  if (view === 'week' || view === 'day') {
    body = <TimeGrid days={view === 'week' ? weekDays : [anchor]} shifts={shifts} selectedKey={selectedKey} todayKey={todayKey} onSelect={selectDay} venueName={venueName} roleName={roleName} label={view === 'week' ? 'Week calendar' : 'Day calendar'} />;
  } else if (view === 'list') {
    body = <AgendaList shifts={shifts} from={rangeFrom} to={rangeTo} selectedKey={selectedKey} onSelect={selectDay} venueName={venueName} roleName={roleName} />;
  } else {
    // The month grid is the animated element itself (the motion e2e samples `.calendar-grid`'s transform).
    body = (
      <>
        {DOW.map(d => <div key={d} className="calendar-dow">{d}</div>)}
        {cells.map(({date,inMonth}) => {
          const key=dayKey(date);const events=byDate[key] ?? [];
          return <button type="button" key={key} aria-label={`${longDay(date)}, ${events.length} shifts`} aria-pressed={key === selectedKey} onClick={() => setSelectedDate(date)} className={`calendar-cell${inMonth ? '' : ' other-month'}${key === selectedKey ? ' selected-day' : ''}`}>
            <span className={`calendar-day-num${key === todayKey ? ' today' : ''}`}>{date.getDate()}</span>
            {events.slice(0,3).map(shift => <span key={shift.id} className={`calendar-event calendar-status-${shift.status}`} title={`${venueName(shift.venueId)} · ${roleName(shift.jobRoleId)} · ${shift.filledCount}/${shift.requiredCount} filled · ${statusText(shift.status)}`}>{time(shift.startsAt)} {venueName(shift.venueId)}</span>)}
            {events.length > 3 && <span className="calendar-more">+{events.length-3} more</span>}
          </button>;
        })}
      </>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Calendar" action={<button className="btn btn-dark" onClick={openCreate}><IconPlus size={14} /> New shift</button>} />
      <div className="calendar walnut-calendar">
        <div className="calendar-head">
          <h2 className="calendar-month">{periodTitle(view, anchor)}</h2>
          <button className="btn btn-outline calendar-today" onClick={goToday}>Today</button>
          <div className="calendar-arrows">
            <button className="btn-icon" aria-label={labels.previous} onClick={() => goTo(stepAnchor(view, anchor, -1))}><IconChevronLeft size={16} /></button>
            <button className="btn-icon" aria-label={labels.next} onClick={() => goTo(stepAnchor(view, anchor, 1))}><IconChevronRight size={16} /></button>
          </div>
          <button className="btn btn-outline calendar-copy-week" onClick={() => setCopyOpen(true)}>Copy previous week</button>
          <button className="btn btn-outline calendar-pattern" onClick={() => setPatternOpen(true)}>Repeating shifts</button>
          <div className="calendar-view-switch" role="group" aria-label="Calendar view">
            {CALENDAR_VIEWS.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={view === id} className={view === id ? 'active' : undefined} onClick={() => changeView(id)}>{label}</button>
            ))}
          </div>
        </div>
        {isError && <div className="list-error" role="alert"><span className="feedback-error">Could not load the schedule.</span> <button className="btn btn-outline" onClick={() => refetch()}>Retry</button></div>}
        <div className="calendar-body">
          {shiftsLoading || venuesLoading || rolesLoading ? <CalendarSkeleton /> : <AnimatePresence mode="wait" initial={false} custom={direction}><motion.div key={`${view}:${rangeFrom.toISOString()}`} custom={direction} variants={period} initial="enter" animate="center" exit="exit" className={view === 'month' ? 'calendar-grid' : 'calendar-view-frame'} role={view === 'month' ? 'group' : undefined} aria-label={view === 'month' ? 'Month calendar' : undefined} aria-busy={switchingPeriod || undefined}>
            {body}
          </motion.div></AnimatePresence>}
          <aside className="calendar-detail" aria-label="Selected day">
            <div className="calendar-day-card"><p className="calendar-detail-eyebrow">{selectedDate.toLocaleDateString("en-GB",{weekday:"long"})}</p>
            <h3>{selectedDate.toLocaleDateString('en-GB',{day:'numeric',month:'long'})}</h3>
            <p className={`calendar-detail-subtitle${isError ? ' feedback-error' : ''}`}>{isError ? 'Schedule could not be loaded' : shiftsLoading || switchingPeriod ? 'Loading schedule…' : `${selectedShifts.length} shift${selectedShifts.length === 1 ? '' : 's'} scheduled`}</p>
            <AnimatePresence mode="wait" initial={false}><motion.div key={selectedKey} variants={contentSwap} initial="hidden" animate="visible" exit="exit">{selectedShifts.length === 0 ? <div className="calendar-day-empty"><IconCalendar size={26} stroke={1.3} /><strong>{isError ? 'Schedule unavailable' : 'A clear day ahead'}</strong><p className={isError ? 'feedback-error' : undefined}>{isError ? 'Retry to check this day’s shifts.' : 'Create a shift to start planning your team’s coverage.'}</p></div> : <div className="calendar-day-events">{selectedShifts.map(shift => <article key={shift.id}><h4>{venueName(shift.venueId)}</h4><p>{roleName(shift.jobRoleId)}</p><p>{time(shift.startsAt)} – {time(shift.endsAt)}</p><span>{shift.filledCount} / {shift.requiredCount} staff allocated</span><span className={`badge badge-${shift.status}`}>{statusText(shift.status)}</span><ScheduledStaff shiftId={shift.id} day={selectedKey} /></article>)}</div>}</motion.div></AnimatePresence>
            <button className="btn btn-dark" onClick={openCreate}><IconPlus size={14} /> Add shift</button></div>
            <div className="calendar-legend"><p>Schedule at a glance</p><span><i className="legend-today" /> Today</span><span><i className="legend-selected" /> Selected day</span>{shifts.length > 0 && <><span><i className="legend-open" /> Open / awaiting staff</span><span><i className="legend-confirmed" /> Confirmed</span><span><i className="legend-completed" /> Completed</span></>}<p className="calendar-timezone">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g," ")}.</p></div>
          </aside>
        </div>
      </div>
      {/* The target week is the week on screen (week view) or the week of the selected day. */}
      <CopyWeekDialog open={copyOpen} weekStart={dayKey(startOfWeek(view === 'week' ? anchor : selectedDate))} onClose={() => setCopyOpen(false)} />
      <ShiftPatternDialog open={patternOpen} defaultStartDate={selectedKey} onClose={() => setPatternOpen(false)} />
    </div>
  );
}
