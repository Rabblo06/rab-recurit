import { dayKey, groupByDay, layoutDay, periodRange, periodTitle, startOfWeek, stepAnchor, stepLabels } from './calendarViews';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min);
const shift = (id: string, start: Date, end: Date) => ({ id, startsAt: start.toISOString(), endsAt: end.toISOString() });

describe('periodRange', () => {
  it('month pads a week either side of the calendar month (the grid shows adjacent-month days)', () => {
    const { from, to } = periodRange('month', at(2026, 10, 18));
    expect(dayKey(from)).toBe('2026-10-25');
    expect(dayKey(to)).toBe('2026-12-07');
  });
  it('list is exactly the calendar month, half-open', () => {
    const { from, to } = periodRange('list', at(2026, 10, 18));
    expect(dayKey(from)).toBe('2026-11-01');
    expect(dayKey(to)).toBe('2026-12-01');
  });
  it('week runs Monday to the next Monday, whatever day the anchor is', () => {
    for (const anchor of [at(2026, 10, 16), at(2026, 10, 19, 23, 59), at(2026, 10, 22)]) {
      const { from, to } = periodRange('week', anchor);
      expect(dayKey(from)).toBe('2026-11-16');
      expect(dayKey(to)).toBe('2026-11-23');
    }
  });
  it('day is one local day', () => {
    const { from, to } = periodRange('day', at(2026, 10, 21, 15));
    expect(from).toEqual(at(2026, 10, 21));
    expect(to).toEqual(at(2026, 10, 22));
  });
});

describe('stepAnchor', () => {
  it('month steps from day 1 so 31 January never skips February', () => {
    expect(stepAnchor('month', at(2026, 0, 31), 1)).toEqual(at(2026, 1, 1));
    expect(stepAnchor('list', at(2026, 0, 1), -1)).toEqual(at(2025, 11, 1));
  });
  it('week steps Monday to Monday across a month boundary', () => {
    expect(stepAnchor('week', at(2026, 10, 26), 1)).toEqual(at(2026, 10, 30));
    expect(stepAnchor('week', at(2026, 10, 26), -1)).toEqual(at(2026, 10, 16));
  });
  it('day steps one local day (DST-safe: built from y/m/d, not +86 400 000 ms)', () => {
    expect(stepAnchor('day', at(2026, 2, 29, 12), 1)).toEqual(at(2026, 2, 30));
    expect(stepAnchor('day', at(2026, 9, 25, 12), -1)).toEqual(at(2026, 9, 24));
  });
});

describe('titles and labels', () => {
  it('names each period', () => {
    expect(periodTitle('month', at(2026, 10, 1))).toBe('November 2026');
    expect(periodTitle('week', at(2026, 10, 18))).toBe('16 – 22 Nov 2026');
    expect(periodTitle('week', at(2026, 10, 30))).toBe('30 Nov – 6 Dec 2026');
    expect(periodTitle('day', at(2026, 10, 21))).toBe(at(2026, 10, 21).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  });
  it('keeps the month view’s historical button names and names the unit for the others', () => {
    expect(stepLabels('month')).toEqual({ previous: 'Previous month', next: 'Next month' });
    expect(stepLabels('week').next).toBe('Next week');
    expect(stepLabels('day').previous).toBe('Previous day');
    expect(stepLabels('list').next).toBe('Next month');
  });
  it('startOfWeek is Monday-first (Sunday belongs to the week before)', () => {
    expect(startOfWeek(at(2026, 10, 22))).toEqual(at(2026, 10, 16));
    expect(startOfWeek(at(2026, 10, 23))).toEqual(at(2026, 10, 23));
  });
});

describe('layoutDay', () => {
  const day = at(2026, 10, 21);
  it('places a shift by its real minutes since local midnight', () => {
    const [placed] = layoutDay([shift('a', at(2026, 10, 21, 9, 30), at(2026, 10, 21, 17))], day);
    expect(placed).toMatchObject({ startMinute: 570, endMinute: 1020, lane: 0, lanes: 1, continuesNextDay: false });
  });
  it('puts overlapping shifts side by side and reuses a lane once it is free', () => {
    const placed = layoutDay(
      [
        shift('a', at(2026, 10, 21, 9), at(2026, 10, 21, 13)),
        shift('b', at(2026, 10, 21, 10), at(2026, 10, 21, 12)),
        shift('c', at(2026, 10, 21, 12), at(2026, 10, 21, 14)),
        shift('d', at(2026, 10, 21, 18), at(2026, 10, 21, 22)),
      ],
      day,
    );
    const byId = Object.fromEntries(placed.map((p) => [p.shift.id, p]));
    expect(byId.a).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId.b).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId.c).toMatchObject({ lane: 1, lanes: 2 }); // b ended at 12:00, so c takes its lane
    expect(byId.d).toMatchObject({ lane: 0, lanes: 1 }); // a separate cluster
  });
  it('clips a shift crossing midnight at 24:00, flags it, and never shows it on the next day', () => {
    const night = shift('n', at(2026, 10, 21, 22), at(2026, 10, 22, 6));
    expect(layoutDay([night], day)[0]).toMatchObject({ startMinute: 1320, endMinute: 1440, continuesNextDay: true });
    expect(layoutDay([night], at(2026, 10, 22))).toEqual([]);
  });
});

describe('groupByDay', () => {
  it('groups the period’s shifts by start day, in start order, and skips shifts outside the window', () => {
    const groups = groupByDay(
      [
        shift('late', at(2026, 10, 3, 18), at(2026, 10, 3, 23)),
        shift('early', at(2026, 10, 3, 8), at(2026, 10, 3, 12)),
        shift('other', at(2026, 10, 9, 8), at(2026, 10, 9, 12)),
        shift('outside', at(2026, 11, 1, 8), at(2026, 11, 1, 12)),
      ],
      at(2026, 10, 1),
      at(2026, 11, 1),
    );
    expect(groups.map((g) => [dayKey(g.day), g.shifts.map((s) => s.id)])).toEqual([
      ['2026-11-03', ['early', 'late']],
      ['2026-11-09', ['other']],
    ]);
  });
});
