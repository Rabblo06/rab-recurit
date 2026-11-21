import { applyOfflinePunchTime, boundOfflinePunchTime, OfflinePunchClockEvidence, offlinePunchFlags, OfflinePunchTime, OfflinePunchWindow } from './offline-punch-time';

const H = 3_600_000;
const M = 60_000;
const limits = { maxCaptureAgeMs: 16 * H, maxSyncDelayMs: 72 * H };
const T = new Date('2026-11-21T08:00:00Z');
const evidence = (o: Partial<OfflinePunchClockEvidence> = {}): OfflinePunchClockEvidence => ({
  ticketIssuedAt: T,
  ticketBootId: 'boot-1',
  ticketBootMs: 1_000_000,
  punchBootId: 'boot-1',
  punchBootMs: 1_000_000 + 62 * M, // punch at 09:02
  receivedAt: new Date('2026-11-21T18:40:00Z'),
  ...o,
});

describe('boundOfflinePunchTime (DESIGN §4.3)', () => {
  it('anchors the punch at ticket time + boot-clock elapsed', () => {
    expect(boundOfflinePunchTime(evidence(), limits)).toEqual({ kind: 'anchored', claimedAt: new Date('2026-11-21T09:02:00Z') });
  });

  it('C > R (a lie or a broken clock) is untrusted, never accepted with a tolerance', () => {
    expect(boundOfflinePunchTime(evidence({ receivedAt: new Date('2026-11-21T09:01:59.999Z') }), limits)).toEqual({ kind: 'untrusted', reason: 'after_arrival' });
    expect(boundOfflinePunchTime(evidence({ receivedAt: new Date('2026-11-21T09:02:00Z') }), limits).kind).toBe('anchored');
  });

  it('a reboot between ticket and punch, a missing ticket, or a negative elapsed time is untrusted', () => {
    expect(boundOfflinePunchTime(evidence({ punchBootId: 'boot-2' }), limits)).toEqual({ kind: 'untrusted', reason: 'boot_changed' });
    expect(boundOfflinePunchTime(evidence({ ticketBootId: '', punchBootId: '' }), limits)).toEqual({ kind: 'untrusted', reason: 'boot_changed' });
    expect(boundOfflinePunchTime(evidence({ ticketIssuedAt: null }), limits)).toEqual({ kind: 'untrusted', reason: 'no_ticket' });
    expect(boundOfflinePunchTime(evidence({ punchBootMs: 999_999 }), limits)).toEqual({ kind: 'untrusted', reason: 'negative_elapsed' });
  });

  it('a punch captured more than the capture age after the ticket is untrusted', () => {
    expect(boundOfflinePunchTime(evidence({ punchBootMs: 1_000_000 + 16 * H + 1, receivedAt: new Date('2026-11-22T08:00:00Z') }), limits)).toEqual({
      kind: 'untrusted',
      reason: 'capture_too_old',
    });
    expect(boundOfflinePunchTime(evidence({ punchBootMs: 1_000_000 + 16 * H, receivedAt: new Date('2026-11-22T08:00:00Z') }), limits).kind).toBe('anchored');
  });

  it('a sync more than the sync delay after the punch is too_late (SYNC_TOO_LATE), with the claimed time kept', () => {
    const r = boundOfflinePunchTime(evidence({ receivedAt: new Date('2026-11-24T09:02:00.001Z') }), limits);
    expect(r).toEqual({ kind: 'too_late', claimedAt: new Date('2026-11-21T09:02:00Z') });
  });

  it('a sequence going backwards (earlier than the previous anchored punch of the key) is untrusted', () => {
    expect(boundOfflinePunchTime(evidence({ previousAnchoredAt: new Date('2026-11-21T09:02:00.001Z') }), limits)).toEqual({ kind: 'untrusted', reason: 'sequence_backwards' });
    expect(boundOfflinePunchTime(evidence({ previousAnchoredAt: new Date('2026-11-21T09:02:00Z') }), limits).kind).toBe('anchored');
  });

  it('non-integer or non-finite inputs are untrusted (fail closed)', () => {
    expect(boundOfflinePunchTime(evidence({ punchBootMs: Number.NaN }), limits)).toEqual({ kind: 'untrusted', reason: 'invalid_input' });
    expect(boundOfflinePunchTime(evidence({ ticketBootMs: 1.5 }), limits)).toEqual({ kind: 'untrusted', reason: 'invalid_input' });
    expect(boundOfflinePunchTime(evidence({ receivedAt: new Date('x') }), limits)).toEqual({ kind: 'untrusted', reason: 'invalid_input' });
  });
});

describe('applyOfflinePunchTime (DESIGN §4.4, the pay-safe table)', () => {
  // Seat 09:00-17:00; window opens 08:45 (15 min early) and closes 19:00 (2 h grace).
  const w: OfflinePunchWindow = {
    scheduledStart: new Date('2026-11-21T09:00:00Z'),
    scheduledEnd: new Date('2026-11-21T17:00:00Z'),
    opensAt: new Date('2026-11-21T08:45:00Z'),
    closesAt: new Date('2026-11-21T19:00:00Z'),
  };
  const R = new Date('2026-11-21T18:40:00Z');
  const anchored = (iso: string): OfflinePunchTime => ({ kind: 'anchored', claimedAt: new Date(iso) });
  const untrusted: OfflinePunchTime = { kind: 'untrusted', reason: 'boot_changed' };

  it('clock-in 10 min before start is applied at the scheduled start (D3) and flagged; 2 h before is OUTSIDE_WINDOW', () => {
    expect(applyOfflinePunchTime('clock_in', anchored('2026-11-21T08:50:00Z'), w, R)).toEqual({
      outcome: 'apply',
      at: new Date('2026-11-21T09:00:00Z'),
      timeSource: 'offline_anchored',
      clampedToSchedule: true,
      claimedAt: new Date('2026-11-21T08:50:00Z'),
    });
    expect(applyOfflinePunchTime('clock_in', anchored('2026-11-21T07:00:00Z'), w, R)).toEqual({ outcome: 'reject', code: 'OUTSIDE_WINDOW' });
    expect(applyOfflinePunchTime('clock_in', anchored('2026-11-21T09:02:00Z'), w, R)).toMatchObject({ at: new Date('2026-11-21T09:02:00Z'), clampedToSchedule: false });
  });

  it('an untrusted clock-in is applied at the arrival time only inside the window (later = less pay), else refused (D4)', () => {
    const early = new Date('2026-11-21T08:50:00Z');
    expect(applyOfflinePunchTime('clock_in', untrusted, w, early)).toMatchObject({
      outcome: 'apply',
      at: new Date('2026-11-21T09:00:00Z'),
      timeSource: 'offline_untrusted',
      claimedAt: null,
    });
    expect(applyOfflinePunchTime('clock_in', untrusted, w, new Date('2026-11-21T10:00:00Z'))).toMatchObject({ at: new Date('2026-11-21T10:00:00Z') });
    expect(applyOfflinePunchTime('clock_in', untrusted, w, new Date('2026-11-21T19:00:01Z'))).toEqual({ outcome: 'reject', code: 'OUTSIDE_WINDOW' });
  });

  it('clock-out 30 min after the scheduled end (inside grace) is applied at the scheduled end, flagged (D3)', () => {
    const ww = { ...w, clockInAt: new Date('2026-11-21T09:00:00Z') };
    expect(applyOfflinePunchTime('clock_out', anchored('2026-11-21T17:30:00Z'), ww, R)).toMatchObject({ outcome: 'apply', at: new Date('2026-11-21T17:00:00Z'), clampedToSchedule: true });
    expect(applyOfflinePunchTime('clock_out', anchored('2026-11-21T16:00:00Z'), ww, R)).toMatchObject({ at: new Date('2026-11-21T16:00:00Z'), clampedToSchedule: false });
    expect(applyOfflinePunchTime('clock_out', anchored('2026-11-21T19:00:01Z'), ww, R)).toEqual({ outcome: 'reject', code: 'OUTSIDE_WINDOW' });
    expect(applyOfflinePunchTime('clock_out', anchored('2026-11-21T08:59:59Z'), ww, R)).toEqual({ outcome: 'reject', code: 'OUTSIDE_WINDOW' });
  });

  it('a clock-out with no trusted time is never applied (D4), and needs a clock-in', () => {
    expect(applyOfflinePunchTime('clock_out', untrusted, { ...w, clockInAt: w.scheduledStart }, R)).toEqual({ outcome: 'reject', code: 'TIME_UNTRUSTED' });
    expect(applyOfflinePunchTime('clock_out', anchored('2026-11-21T16:00:00Z'), w, R)).toEqual({ outcome: 'reject', code: 'NOT_CLOCKED_IN' });
  });

  it('breaks: stored at the anchored time inside the open attendance; untrusted is refused', () => {
    const ww = { ...w, clockInAt: new Date('2026-11-21T09:00:00Z') };
    expect(applyOfflinePunchTime('break_start', anchored('2026-11-21T12:00:00Z'), ww, R)).toMatchObject({ outcome: 'apply', at: new Date('2026-11-21T12:00:00Z') });
    expect(applyOfflinePunchTime('break_end', anchored('2026-11-21T08:59:00Z'), ww, R)).toEqual({ outcome: 'reject', code: 'OUTSIDE_WINDOW' });
    expect(applyOfflinePunchTime('break_end', untrusted, ww, R)).toEqual({ outcome: 'reject', code: 'TIME_UNTRUSTED' });
  });

  it('check-in: the anchored time inside the window; too_late is SYNC_TOO_LATE for every event', () => {
    expect(applyOfflinePunchTime('check_in', anchored('2026-11-21T08:46:00Z'), w, R)).toMatchObject({ at: new Date('2026-11-21T08:46:00Z'), clampedToSchedule: false });
    for (const e of ['check_in', 'clock_in', 'break_start', 'break_end', 'clock_out'] as const) {
      expect(applyOfflinePunchTime(e, { kind: 'too_late', claimedAt: new Date('2026-11-21T09:00:00Z') }, { ...w, clockInAt: w.scheduledStart }, R)).toEqual({
        outcome: 'reject',
        code: 'SYNC_TOO_LATE',
      });
    }
  });

  it('pay can never grow: for any trusted clock-in / clock-out pair, S <= clockIn <= clockOut <= E', () => {
    let checked = 0;
    for (let inMin = -15; inMin <= 60; inMin += 5) {
      for (let outMin = 420; outMin <= 600; outMin += 15) {
        const cin = applyOfflinePunchTime('clock_in', anchored(new Date(w.scheduledStart.getTime() + inMin * M).toISOString()), w, R);
        if (cin.outcome !== 'apply') continue;
        const cout = applyOfflinePunchTime('clock_out', anchored(new Date(w.scheduledStart.getTime() + outMin * M).toISOString()), { ...w, clockInAt: cin.at }, R);
        if (cout.outcome !== 'apply') continue;
        checked += 1;
        expect(cin.at.getTime()).toBeGreaterThanOrEqual(w.scheduledStart.getTime());
        expect(cout.at.getTime()).toBeGreaterThanOrEqual(cin.at.getTime());
        expect(cout.at.getTime()).toBeLessThanOrEqual(w.scheduledEnd.getTime());
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('offlinePunchFlags (DESIGN §4.5)', () => {
  const claimedAt = new Date('2026-11-21T09:02:00Z');
  it('flags skew, a changed clock, a late sync and a clamp; never anything else', () => {
    expect(
      offlinePunchFlags({
        claimedAt,
        receivedAt: new Date('2026-11-21T22:00:00Z'),
        deviceWallClockAt: new Date('2026-11-21T06:02:00Z'), // the phone clock was moved back 3 h
        ticketDeviceWallClockAt: new Date('2026-11-21T08:00:00Z'),
        elapsedBootMs: 62 * M,
        clampedToSchedule: true,
        skewFlagSeconds: 300,
      }),
    ).toEqual(['clock_skew', 'clock_changed', 'late_sync', 'clamped_to_schedule']);
    expect(offlinePunchFlags({ claimedAt, receivedAt: new Date('2026-11-21T10:00:00Z'), deviceWallClockAt: new Date('2026-11-21T09:04:00Z'), skewFlagSeconds: 300 })).toEqual([]);
    expect(offlinePunchFlags({ claimedAt: null, receivedAt: new Date('2026-11-21T10:00:00Z'), skewFlagSeconds: 300 })).toEqual([]);
  });
});
