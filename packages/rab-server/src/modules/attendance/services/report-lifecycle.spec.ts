import { ACTION_WINDOW_HOURS, LifecycleInput, deliveryState, reportLifecycle } from './report-lifecycle';

const H = 3_600_000;
const start = new Date('2026-10-16T14:45:00Z');
const end = new Date('2026-10-16T21:45:00Z');
const at = (ms: number) => new Date(end.getTime() + ms);
const none = { pending: 0, sent: 0, failed: 0, lastSentAt: null };

const base = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  now: at(0),
  shiftStatus: 'in_progress',
  startsAt: start,
  endsAt: end,
  staffCount: 5,
  openAttendance: 0,
  unresolved: 5,
  anyClockIn: true,
  reportStatus: 'ready',
  finalQueuedAt: null,
  delivery: none,
  ...over,
});

describe('action window (shift end + 5h, server time)', () => {
  it.each([
    ['4h59m', 5 * H - 60_000, false],
    ['exactly 5h', 5 * H, true],
    ['5h + 1s', 5 * H + 1_000, true],
  ])('%s after the scheduled end', (_label, offset, expired) => {
    const l = reportLifecycle(base({ now: at(offset) }));
    expect(l.actionExpired).toBe(expired);
    expect(l.actionExpiresAt).toBe(new Date(end.getTime() + ACTION_WINDOW_HOURS * H).toISOString());
  });

  it('never shows a stale "In progress": the reported 15:45-22:45 shift reads Action expired + needs attendance review', () => {
    // The real record: shift.status=in_progress, 5 x missing_clock_out, report ready, 19h after the end.
    const l = reportLifecycle(base({ now: at(19 * H) }));
    expect(l.displayStatus).toBe('action_expired');
    expect(l.displayLabel).toBe('Action expired');
    expect(l.needsAttendanceReview).toBe(true);
    expect(l.needsAttention).toBe(true);
    expect(l.inHistory).toBe(true);
    expect(l.inCurrent).toBe(true);
  });

  it('before expiry: still clocked in after the end reads Waiting for clock-out, missing clock-out reads Needs review', () => {
    expect(reportLifecycle(base({ now: at(H), openAttendance: 2 })).displayStatus).toBe('waiting_clock_out');
    expect(reportLifecycle(base({ now: at(H) })).displayStatus).toBe('needs_review');
    expect(reportLifecycle(base({ now: at(H), unresolved: 0 })).displayStatus).toBe('ready_to_finalise');
  });

  it('every seat resolved but one attendance review outstanding: Needs review, never Ready to finalise', () => {
    expect(reportLifecycle(base({ now: at(H), unresolved: 0, unreviewed: 1 })).displayStatus).toBe('needs_review');
    expect(reportLifecycle(base({ now: at(H), unresolved: 0, unreviewed: 0 })).displayStatus).toBe('ready_to_finalise');
  });

  it('a staff member still clocked in past the window is flagged, not silently completed', () => {
    const l = reportLifecycle(base({ now: at(6 * H), openAttendance: 1, unresolved: 1 }));
    expect(l.displayStatus).toBe('action_expired');
    expect(l.needsAttendanceReview).toBe(true);
  });

  it('all no-shows past the window: expired, nothing left to review, still an unfinalised obligation', () => {
    const l = reportLifecycle(base({ now: at(6 * H), unresolved: 0, anyClockIn: false, shiftStatus: 'fully_filled' }));
    expect(l.displayStatus).toBe('action_expired');
    expect(l.needsAttendanceReview).toBe(false);
    expect(l.needsAttention).toBe(true);
  });

  it('before the start: Waiting for clock-in with staff, Upcoming without', () => {
    expect(reportLifecycle(base({ now: new Date(start.getTime() - H), anyClockIn: false })).displayStatus).toBe('waiting_clock_in');
    expect(reportLifecycle(base({ now: new Date(start.getTime() - H), staffCount: 0, anyClockIn: false })).displayStatus).toBe('upcoming');
  });

  it('a shift crossing midnight / a DST change is still exactly end + 5h in UTC', () => {
    // 2026-10-25 01:00 Europe/London is the BST -> GMT change; the deadline is pure UTC arithmetic.
    const overnightEnd = new Date('2026-10-25T00:30:00Z');
    const l = reportLifecycle(base({ startsAt: new Date('2026-10-24T18:00:00Z'), endsAt: overnightEnd, now: new Date('2026-10-25T05:29:59Z') }));
    expect(l.actionExpired).toBe(false);
    expect(l.actionExpiresAt).toBe('2026-10-25T05:30:00.000Z');
  });

  it('a moved shift end moves the deadline with it', () => {
    const later = new Date(end.getTime() + 2 * H);
    expect(reportLifecycle(base({ endsAt: later, now: at(6 * H) })).actionExpired).toBe(false);
  });

  it('a cancelled shift is Cancelled, never "needs attention", and leaves current Reports after the window', () => {
    const l = reportLifecycle(base({ shiftStatus: 'cancelled', now: at(6 * H) }));
    expect(l.displayStatus).toBe('cancelled');
    expect(l.needsAttention).toBe(false);
    expect(l.inCurrent).toBe(false);
    expect(l.inHistory).toBe(true);
  });
});

describe('delivery state uses the outbox, not the finalise response', () => {
  it('finalised but PDF not yet generated / queued -> Generating PDF, then Queued for delivery', () => {
    expect(reportLifecycle(base({ reportStatus: 'finalised', unresolved: 0 })).displayStatus).toBe('generating');
    const queued = reportLifecycle(base({ reportStatus: 'finalised', unresolved: 0, finalQueuedAt: at(H), delivery: { ...none, pending: 1 } }));
    expect(queued.displayStatus).toBe('queued');
    expect(queued.sentAt).toBeNull();
  });

  it('a failed delivery is shown and kept in current Reports even inside the window', () => {
    const l = reportLifecycle(base({ now: at(H), reportStatus: 'finalised', unresolved: 0, finalQueuedAt: at(H), delivery: { ...none, failed: 1 } }));
    expect(l.displayStatus).toBe('delivery_failed');
    expect(l.needsAttention).toBe(true);
    expect(l.inCurrent).toBe(true);
  });

  it('a retry in progress (one failed attempt now pending again) is Queued, not Failed', () => {
    expect(deliveryState('finalised', at(H), { pending: 1, sent: 0, failed: 1, lastSentAt: null })).toBe('queued');
  });

  it('finalised with no recipients is never shown as Sent', () => {
    expect(deliveryState('finalised', at(H), none)).toBe('no_recipients');
  });
});

describe('Reports -> History five hours after the authoritative SENT timestamp', () => {
  const sentAt = at(30 * 60_000);
  const sent = (offset: number) =>
    reportLifecycle(base({ now: new Date(sentAt.getTime() + offset), reportStatus: 'finalised', unresolved: 0, finalQueuedAt: at(60_000), delivery: { ...none, sent: 2, lastSentAt: sentAt } }));

  it.each([
    ['4h59m after sending', 5 * H - 60_000, true, false],
    ['exactly 5h after sending', 5 * H, false, true],
    ['5h + 1s after sending', 5 * H + 1_000, false, true],
  ])('%s', (_label, offset, current, history) => {
    const l = sent(offset);
    expect(l.displayStatus).toBe('sent');
    expect(l.inCurrent).toBe(current);
    expect(l.inHistory).toBe(history);
    expect(l.historyAt).toBe(new Date(sentAt.getTime() + 5 * H).toISOString());
  });

  it('a report sent long after the shift stays current for its own five hours (anchor is the send, not the shift)', () => {
    const lateSend = at(20 * H);
    const l = reportLifecycle(base({ now: new Date(lateSend.getTime() + H), reportStatus: 'finalised', unresolved: 0, finalQueuedAt: lateSend, delivery: { ...none, sent: 1, lastSentAt: lateSend } }));
    expect(l.inCurrent).toBe(true);
    expect(l.inHistory).toBe(false);
  });
});
