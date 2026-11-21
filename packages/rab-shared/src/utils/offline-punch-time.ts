/**
 * M4 offline attendance (docs/plans/m4-offline/DESIGN.md §4, owner decisions D2 / D3 / D4 / D5, 2026-11-21): which time an
 * attendance punch recorded on a phone WITHOUT a connection gets, decided by the server from server-observed evidence. The
 * phone's wall clock is never an input to pay; it only raises flags.
 *
 * Pure functions (no I/O, no Date.now()): the server's sync service is the authority; the apps may reuse them for UX only.
 *
 * HARD RULE (owner, 2026-11-21): offline mode stays OFF everywhere until M5 payroll adjustments exist and /me/sync has been
 * pen-tested (DESIGN.md, ROLLOUT-CHECKLIST.md). Nothing here turns it on.
 *
 * 1. boundOfflinePunchTime (§4.3): from the server-signed ticket's issue time T (server clock), the phone's boot-clock reading
 *    when it received the ticket and when the button was pressed (same boot session), and the sync arrival time R (server):
 *    the anchored punch time C = T + (punchBootMs − ticketBootMs). Trusted only when the elapsed time is non-negative and
 *    within the capture age, C ≤ R (the phone received the ticket after T, so the true punch time is ≥ C, and it is ≤ R; C > R
 *    can only come from a lie or a broken clock), and C is not earlier than the previous anchored punch of the same key.
 *    R − C beyond the sync delay is `too_late` (SYNC_TOO_LATE). Anything else is `untrusted`.
 * 2. applyOfflinePunchTime (§4.4, the pay-safe table): never more pay than the schedule.
 *    - check_in   trusted: C in [O, X] -> C;              untrusted: R in [O, X] -> R;            else OUTSIDE_WINDOW
 *    - clock_in   trusted: C in [O, X] -> max(C, S) (D3); untrusted: R in [O, X] -> max(R, S) (D4); else OUTSIDE_WINDOW
 *    - break_*    trusted: C in [clockInAt, R] -> C;      untrusted: TIME_UNTRUSTED
 *    - clock_out  trusted: C in [clockInAt, X] -> min(C, E) (D3); untrusted: TIME_UNTRUSTED (never applied, D4)
 *    where [S, E] is the seat's scheduled window and [O, X] the attendance window (S − early allowance, E + grace).
 *    ASSUMPTION (flagged for the owner): an UNTRUSTED clock-in is also raised to S. §4.4 says "R if R is in [O, X]"; raising
 *    it to the scheduled start keeps D3's "an offline clock-in is never earlier than the scheduled start" for both trust
 *    levels and can only lower pay.
 * 3. offlinePunchFlags (§4.5): clock_skew, clock_changed, late_sync, clamped_to_schedule. Flags never change the time.
 */

export type OfflinePunchEvent = 'check_in' | 'clock_in' | 'break_start' | 'break_end' | 'clock_out';

export interface OfflinePunchClockEvidence {
  /** Server time the offline ticket was issued (from the verified ticket, never from the phone). null: no valid ticket. */
  ticketIssuedAt: Date | null;
  /** Boot session id and boot-clock reading (ms, counts deep sleep) when the phone received the ticket. */
  ticketBootId: string;
  ticketBootMs: number;
  /** Boot session id and boot-clock reading at the button press. */
  punchBootId: string;
  punchBootMs: number;
  /** Server time the sync request arrived. */
  receivedAt: Date;
  /** The anchored time of the previous entry from the same device key (clientSeq order), if any. */
  previousAnchoredAt?: Date | null;
}

export interface OfflinePunchLimits {
  /** OFFLINE_MAX_CAPTURE_AGE_HOURS in ms (D5: 16 h): the longest a punch may be captured after the ticket. */
  maxCaptureAgeMs: number;
  /** OFFLINE_SYNC_MAX_DELAY_HOURS in ms (D5: 72 h): the longest a punch may wait before it is synced. */
  maxSyncDelayMs: number;
}

export type OfflineUntrustedReason = 'no_ticket' | 'boot_changed' | 'negative_elapsed' | 'capture_too_old' | 'after_arrival' | 'sequence_backwards' | 'invalid_input';

export type OfflinePunchTime =
  | { kind: 'anchored'; claimedAt: Date }
  | { kind: 'too_late'; claimedAt: Date }
  | { kind: 'untrusted'; reason: OfflineUntrustedReason };

const isMs = (n: number) => Number.isFinite(n) && Number.isInteger(n);
const valid = (d: Date | null | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

export function boundOfflinePunchTime(e: OfflinePunchClockEvidence, limits: OfflinePunchLimits): OfflinePunchTime {
  if (!valid(e.receivedAt) || !isMs(e.ticketBootMs) || !isMs(e.punchBootMs) || !isMs(limits.maxCaptureAgeMs) || !isMs(limits.maxSyncDelayMs)) {
    return { kind: 'untrusted', reason: 'invalid_input' };
  }
  if (!valid(e.ticketIssuedAt)) return { kind: 'untrusted', reason: 'no_ticket' };
  if (!e.ticketBootId || e.ticketBootId !== e.punchBootId) return { kind: 'untrusted', reason: 'boot_changed' };
  const elapsed = e.punchBootMs - e.ticketBootMs;
  if (elapsed < 0) return { kind: 'untrusted', reason: 'negative_elapsed' };
  if (elapsed > limits.maxCaptureAgeMs) return { kind: 'untrusted', reason: 'capture_too_old' };
  const claimed = e.ticketIssuedAt.getTime() + elapsed;
  if (claimed > e.receivedAt.getTime()) return { kind: 'untrusted', reason: 'after_arrival' };
  if (e.previousAnchoredAt != null) {
    if (!valid(e.previousAnchoredAt)) return { kind: 'untrusted', reason: 'invalid_input' };
    if (claimed < e.previousAnchoredAt.getTime()) return { kind: 'untrusted', reason: 'sequence_backwards' };
  }
  const claimedAt = new Date(claimed);
  if (e.receivedAt.getTime() - claimed > limits.maxSyncDelayMs) return { kind: 'too_late', claimedAt };
  return { kind: 'anchored', claimedAt };
}

export interface OfflinePunchWindow {
  /** The seat's scheduled start / end (S, E). */
  scheduledStart: Date;
  scheduledEnd: Date;
  /** The attendance window (O = S − early allowance, X = E + grace), as online. */
  opensAt: Date;
  closesAt: Date;
  /** The open attendance's clock-in (break and clock-out events), if any. */
  clockInAt?: Date | null;
}

export type OfflinePunchRejection = 'OUTSIDE_WINDOW' | 'TIME_UNTRUSTED' | 'SYNC_TOO_LATE' | 'NOT_CLOCKED_IN';

export type OfflinePunchDecision =
  | { outcome: 'apply'; at: Date; timeSource: 'offline_anchored' | 'offline_untrusted'; clampedToSchedule: boolean; claimedAt: Date | null }
  | { outcome: 'reject'; code: OfflinePunchRejection };

const within = (t: number, from: Date, to: Date) => t >= from.getTime() && t <= to.getTime();

export function applyOfflinePunchTime(event: OfflinePunchEvent, time: OfflinePunchTime, w: OfflinePunchWindow, receivedAt: Date): OfflinePunchDecision {
  if (time.kind === 'too_late') return { outcome: 'reject', code: 'SYNC_TOO_LATE' };
  const S = w.scheduledStart.getTime();
  const E = w.scheduledEnd.getTime();
  const trusted = time.kind === 'anchored';
  const source = trusted ? 'offline_anchored' : 'offline_untrusted';
  const claimedAt = trusted ? time.claimedAt : null;
  const t = trusted ? time.claimedAt.getTime() : receivedAt.getTime();

  switch (event) {
    case 'check_in':
      if (!within(t, w.opensAt, w.closesAt)) return { outcome: 'reject', code: 'OUTSIDE_WINDOW' };
      return { outcome: 'apply', at: new Date(t), timeSource: source, clampedToSchedule: false, claimedAt };
    case 'clock_in': {
      if (!within(t, w.opensAt, w.closesAt)) return { outcome: 'reject', code: 'OUTSIDE_WINDOW' };
      const at = Math.max(t, S);
      return { outcome: 'apply', at: new Date(at), timeSource: source, clampedToSchedule: at !== t, claimedAt };
    }
    case 'break_start':
    case 'break_end':
      if (!trusted) return { outcome: 'reject', code: 'TIME_UNTRUSTED' };
      if (!w.clockInAt) return { outcome: 'reject', code: 'NOT_CLOCKED_IN' };
      if (!within(t, w.clockInAt, receivedAt)) return { outcome: 'reject', code: 'OUTSIDE_WINDOW' };
      return { outcome: 'apply', at: new Date(t), timeSource: source, clampedToSchedule: false, claimedAt };
    case 'clock_out': {
      if (!trusted) return { outcome: 'reject', code: 'TIME_UNTRUSTED' };
      if (!w.clockInAt) return { outcome: 'reject', code: 'NOT_CLOCKED_IN' };
      if (!within(t, w.clockInAt, w.closesAt)) return { outcome: 'reject', code: 'OUTSIDE_WINDOW' };
      // Never later than the scheduled end (D3), never before the clock-in it closes.
      const at = Math.max(Math.min(t, E), w.clockInAt.getTime());
      return { outcome: 'apply', at: new Date(at), timeSource: source, clampedToSchedule: at !== t, claimedAt };
    }
    default:
      return { outcome: 'reject', code: 'TIME_UNTRUSTED' };
  }
}

export type OfflinePunchFlag = 'clock_skew' | 'clock_changed' | 'late_sync' | 'clamped_to_schedule';

export interface OfflinePunchFlagInput {
  claimedAt: Date | null;
  receivedAt: Date;
  /** The phone's wall clock at the punch and when it received the ticket (diagnostics only). */
  deviceWallClockAt?: Date | null;
  ticketDeviceWallClockAt?: Date | null;
  /** Boot-clock elapsed between ticket and punch (ms), when known. */
  elapsedBootMs?: number | null;
  clampedToSchedule?: boolean;
  /** OFFLINE_CLOCK_SKEW_FLAG_SECONDS (300). */
  skewFlagSeconds: number;
}

/** §4.5: flags stored on the receipt and shown in manager review. They never change the applied time. */
export function offlinePunchFlags(i: OfflinePunchFlagInput): OfflinePunchFlag[] {
  const flags: OfflinePunchFlag[] = [];
  if (valid(i.claimedAt)) {
    if (valid(i.deviceWallClockAt) && Math.abs(i.deviceWallClockAt.getTime() - i.claimedAt.getTime()) > i.skewFlagSeconds * 1000) flags.push('clock_skew');
    if (valid(i.deviceWallClockAt) && valid(i.ticketDeviceWallClockAt) && typeof i.elapsedBootMs === 'number' && Number.isFinite(i.elapsedBootMs)) {
      const wallElapsed = i.deviceWallClockAt.getTime() - i.ticketDeviceWallClockAt.getTime();
      if (Math.abs(wallElapsed - i.elapsedBootMs) > 60_000) flags.push('clock_changed');
    }
    if (i.receivedAt.getTime() - i.claimedAt.getTime() > 12 * 3_600_000) flags.push('late_sync');
  }
  if (i.clampedToSchedule) flags.push('clamped_to_schedule');
  return flags;
}
