import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Shift } from '../../scheduling/entities/shift.entity';
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
 * Expiry (owner decision 0i, 2026-11-14): a QR is valid until the shift's
 * CURRENT `endsAt` + `QR_POST_SHIFT_GRACE_MINUTES`, decided at scan time
 * from the freshly re-read shift row — never from when the QR was signed.
 * A QR printed on the pre-shift report (signed up to
 * `REPORT_AVAILABLE_BEFORE_MINUTES` before the start) therefore lasts the
 * whole shift plus grace, an extended shift extends it and a shortened shift
 * shortens it. The token itself carries no `exp` for that reason (an `exp`
 * fixed at signing time is exactly what made a report QR expire before the
 * shift ended); see `QrTokenService` for why that stays fail-closed.
 */
@Injectable()
export class AttendanceQrService {
  constructor(
    private readonly qrTokenService: QrTokenService,
    private readonly env: EnvironmentService,
  ) {}

  /**
   * Last instant (inclusive) a QR for this shift is accepted: the shift's current end + the post-shift grace — the same
   * `QR_POST_SHIFT_GRACE_MINUTES` bound `AttendanceService.assertClockWindow` closes the clock window with.
   */
  validUntil(shift: Pick<Shift, 'endsAt'>): Date {
    return new Date(shift.endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000);
  }

  /** Sign a fresh QR for this shift — safe to call repeatedly (e.g. on every "show QR" view); verification only cares about the signed `shiftId`/`venueId`/`ver`, not which specific signing produced the token. */
  sign(shift: Pick<Shift, 'id' | 'venueId' | 'qrVersion'>): string {
    return this.qrTokenService.sign({ shiftId: shift.id, venueId: shift.venueId, ver: shift.qrVersion });
  }

  /**
   * Verifies the token itself (signature, algorithm, issuer, audience), that
   * it names THIS shift, that its `venueId` still matches the shift's
   * CURRENT venue (catches a venue reassignment after the QR was printed —
   * the `ver` counter is the belt-and-braces version of the same check), and
   * that now is not past the shift's CURRENT end + grace. Never checks
   * `ShiftAssignment` here — that stays `AttendanceService`'s own,
   * unconditional, always-fresh check, so a QR can never substitute for it.
   * Check order is deliberate: nothing about the shift row is read until the
   * signature has proved the token was issued by us for this `shiftId`.
   */
  async validateQr(manager: EntityManager, shiftId: string, qrToken: string): Promise<void> {
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
    if (payload.venueId !== shift.venueId || payload.ver !== shift.qrVersion) {
      throw new InvalidQrException('venue_mismatch');
    }

    // Fail closed: an unreadable end time (NaN) never compares as "not yet expired".
    const deadline = this.validUntil(shift).getTime();
    if (!Number.isFinite(deadline) || Date.now() > deadline) {
      throw new InvalidQrException('expired');
    }
  }
}
