import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
import { effectiveAssignmentTime, ScheduledWindow } from '../../scheduling/utils/assignment-time';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { InvalidQrException } from '../exceptions/attendance.exceptions';
import { QrTokenService } from './qr-token.service';

/**
 * The one place a QR is signed and validated — reused identically by
 * `AttendanceService.clockIn` and `.clockOut` (Part 31/54: one shared
 * validation, never duplicated logic, and a valid QR is always strictly
 * ADDITIONAL to the existing `ShiftAssignment.status === CONFIRMED` check,
 * never a replacement for it).
 *
 * Expiry (owner decisions 0i and the follow-ups, 2026-11-14): a QR is valid
 * until the scanning staff member's OWN scheduled end (their seat's period,
 * `effectiveAssignmentTime`, falling back to the shift's) +
 * `QR_POST_SHIFT_GRACE_MINUTES`, decided at scan time from the freshly
 * re-read shift row — never from when the QR was signed. A QR printed on the
 * pre-shift report (signed up to `REPORT_AVAILABLE_BEFORE_MINUTES` before the
 * start) therefore lasts the seat plus grace; a seat that ends earlier than
 * the shift closes earlier for that staff member. On top of that,
 * `QrTokenService.verify` refuses any token older than `QR_MAX_AGE_DAYS`
 * (default 14), and a manager can revoke every printed QR for a shift by
 * rotating it (`SchedulingService.rotateShiftQr` bumps `Shift.qrVersion`;
 * an older token is then refused `revoked`).
 */
@Injectable()
export class AttendanceQrService {
  constructor(
    private readonly qrTokenService: QrTokenService,
    private readonly env: EnvironmentService,
  ) {}

  /**
   * Last instant (inclusive) a QR is accepted for one staff member: their own scheduled end + the post-shift grace — the
   * same `QR_POST_SHIFT_GRACE_MINUTES` bound `AttendanceService.assertClockWindow` closes the clock window with, from the
   * same window (`effectiveAssignmentTime(assignment, shift)`).
   */
  validUntil(seatWindow: Pick<ScheduledWindow, 'endsAt'>): Date {
    return new Date(seatWindow.endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000);
  }

  /** Sign a fresh QR for this shift — safe to call repeatedly (e.g. on every "show QR" view); verification only cares about the signed `shiftId`/`venueId`/`ver`, not which specific signing produced the token. */
  sign(shift: Pick<Shift, 'id' | 'venueId' | 'qrVersion'>): string {
    return this.qrTokenService.sign({ shiftId: shift.id, venueId: shift.venueId, ver: shift.qrVersion });
  }

  /**
   * Verifies the token itself (signature, algorithm, issuer, audience, the
   * `QR_MAX_AGE_DAYS` ceiling), that it names THIS shift, that its `venueId`
   * still matches the shift's CURRENT venue, that its `ver` is the shift's
   * current QR version (a rotation revokes older codes: `revoked`), and that
   * now is not past the scanning staff member's own end + grace. `seat` is
   * that staff member's booking (its `period`; null/absent falls back to the
   * shift's times) — required, so no caller can validate against the
   * shift's overall end by omission. Never checks `ShiftAssignment` status
   * here — that stays `AttendanceService`'s own, unconditional, always-fresh
   * check, so a QR can never substitute for it. Check order is deliberate:
   * nothing about the shift row is read until the signature has proved the
   * token was issued by us for this `shiftId`.
   */
  async validateQr(manager: EntityManager, shiftId: string, qrToken: string, seat: { period?: string | null }): Promise<void> {
    let payload;
    try {
      payload = this.qrTokenService.verify(qrToken);
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      throw new InvalidQrException(name === 'TokenExpiredError' ? 'expired' : 'invalid');
    }

    if (payload.shiftId !== shiftId) {
      throw new InvalidQrException('shift_mismatch');
    }

    const shift = await manager.findOneByOrFail(Shift, { id: shiftId });
    if (payload.venueId !== shift.venueId) {
      throw new InvalidQrException('venue_mismatch');
    }
    if (payload.ver !== shift.qrVersion) {
      throw new InvalidQrException('revoked');
    }

    // Fail closed: an unreadable end time (NaN) never compares as "not yet expired".
    const deadline = this.validUntil(effectiveAssignmentTime(seat, shift)).getTime();
    if (!Number.isFinite(deadline) || Date.now() > deadline) {
      throw new InvalidQrException('expired');
    }
  }
}
