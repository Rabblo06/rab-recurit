/**
 * Pure date maths for the calendar's four views (month, week, day, list).
 * Presentation only: every shift shown still comes from `GET /shifts`; nothing here
 * invents, moves or reschedules a shift. All dates are the viewer's local time, the
 * same convention the month grid has always used (`toLocaleDateString('sv-SE')` keys).
 */

export type CalendarView = 'month' | 'week' | 'day' | 'list';

export const CALENDAR_VIEWS: { id: CalendarView; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'list', label: 'List' },
];

/** `YYYY-MM-DD` in the viewer's local time zone. */
export function dayKey(date: Date): string {
  return date.toLocaleDateString('sv-SE');
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday of the week containing `date` (the grid is Monday-first). */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * The half-open [from, to) window the view fetches. The month grid pads a week either
 * side so the leading/trailing days that belong to the adjacent month still show
 * their shifts; the list view is the calendar month itself.
 */
export function periodRange(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  switch (view) {
    case 'month': {
      const first = startOfMonth(anchor);
      return {
        from: new Date(first.getFullYear(), first.getMonth(), 1 - 7),
        to: new Date(first.getFullYear(), first.getMonth() + 1, 7),
      };
    }
    case 'list': {
      const first = startOfMonth(anchor);
      return { from: first, to: new Date(first.getFullYear(), first.getMonth() + 1, 1) };
    }
    case 'week': {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7) };
    }
    case 'day': {
      const from = startOfDay(anchor);
      return { from, to: addDays(from, 1) };
    }
  }
}

/** The anchor one period earlier (-1) or later (+1). Month steps keep day 1 so a 31st never skips a month. */
export function stepAnchor(view: CalendarView, anchor: Date, step: -1 | 1): Date {
  switch (view) {
    case 'month':
    case 'list':
      return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
    case 'week':
      return addDays(startOfWeek(anchor), 7 * step);
    case 'day':
      return addDays(startOfDay(anchor), step);
  }
}

/** Heading text for the period on screen. */
export function periodTitle(view: CalendarView, anchor: Date): string {
  if (view === 'month' || view === 'list') {
    return anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  if (view === 'day') {
    return anchor.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const from = startOfWeek(anchor);
  const to = addDays(from, 6);
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  const left = from.toLocaleDateString('en-GB', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  const right = to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${left} – ${right}`;
}

/** Accessible names for the previous/next buttons, per view. */
export function stepLabels(view: CalendarView): { previous: string; next: string } {
  const unit = view === 'list' ? 'month' : view;
  return { previous: `Previous ${unit}`, next: `Next ${unit}` };
}

export interface TimedShift {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface PlacedShift<T extends TimedShift> {
  shift: T;
  /** Minutes from local midnight of the column's day, clamped to [0, 1440]. */
  startMinute: number;
  endMinute: number;
  /** True when the shift carries on past midnight (clipped at 24:00 in this column). */
  continuesNextDay: boolean;
  lane: number;
  lanes: number;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Lays out the shifts that START on `day` into side-by-side lanes so overlapping shifts
 * never cover each other. A shift is shown on its start day only (the same rule as the
 * month grid); a shift crossing midnight is clipped at 24:00 and flagged.
 * Greedy interval colouring over each cluster of mutually overlapping shifts.
 */
export function layoutDay<T extends TimedShift>(shifts: T[], day: Date): PlacedShift<T>[] {
  const midnight = startOfDay(day).getTime();
  const key = dayKey(day);
  const items = shifts
    .filter((shift) => dayKey(new Date(shift.startsAt)) === key)
    .map((shift) => {
      const start = Math.max(0, Math.round((new Date(shift.startsAt).getTime() - midnight) / 60_000));
      const rawEnd = Math.round((new Date(shift.endsAt).getTime() - midnight) / 60_000);
      const end = Math.min(MINUTES_PER_DAY, Math.max(rawEnd, start + 1));
      return { shift, startMinute: start, endMinute: end, continuesNextDay: rawEnd > MINUTES_PER_DAY, lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.shift.id.localeCompare(b.shift.id));

  const placed: PlacedShift<T>[] = [];
  let cluster: PlacedShift<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    for (const item of cluster) item.lanes = laneEnds.length;
    placed.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const item of items) {
    if (cluster.length > 0 && item.startMinute >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= item.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMinute);
    } else {
      laneEnds[lane] = item.endMinute;
    }
    item.lane = lane;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMinute);
  }
  if (cluster.length > 0) closeCluster();
  return placed;
}

/** Shifts grouped by local start day, in start-time order, for the list (agenda) view. Empty days are omitted. */
export function groupByDay<T extends TimedShift>(shifts: T[], from: Date, to: Date): { day: Date; shifts: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const shift of shifts) {
    const start = new Date(shift.startsAt);
    if (start < from || start >= to) continue;
    const key = dayKey(start);
    const bucket = groups.get(key) ?? [];
    bucket.push(shift);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => ({
      day: new Date(`${key}T00:00:00`),
      shifts: bucket.sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || a.id.localeCompare(b.id),
      ),
    }));
}
