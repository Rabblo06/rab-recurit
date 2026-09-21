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
 */
@Injectable()
export class AttendanceQrService {
  constructor(
    private readonly qrTokenService: QrTokenService,
    private readonly env: EnvironmentService,
  ) {}

  /** Seconds the token stays valid, covering the whole authorised attendance window for this shift. */
  private expirySeconds(shift: Pick<Shift, 'startsAt' | 'endsAt'>): number {
    const earliestClockIn = shift.startsAt.getTime() - this.env.get('CLOCK_IN_EARLY_MINUTES') * 60_000;
    const latestClockOut = shift.endsAt.getTime() + this.env.get('QR_POST_SHIFT_GRACE_MINUTES') * 60_000;
    return Math.max(1, Math.ceil((latestClockOut - earliestClockIn) / 1000));
  }

  /** Sign a fresh QR for this shift — safe to call repeatedly (e.g. on every "show QR" view); verification only cares about the signed `shiftId`/`venueId`/`ver`, not which specific signing produced the token. */
  sign(shift: Pick<Shift, 'id' | 'venueId' | 'startsAt' | 'endsAt' | 'qrVersion'>): string {
    return this.qrTokenService.sign({ shiftId: shift.id, venueId: shift.venueId, ver: shift.qrVersion }, this.expirySeconds(shift));
  }

  /**
   * Verifies the token itself (signature + expiry), that it names THIS
   * shift, and that its `venueId` still matches the shift's CURRENT venue
   * (catches a venue reassignment after the QR was printed — the `ver`
   * counter is the belt-and-braces version of the same check). Never checks
   * `ShiftAssignment` here — that stays `AttendanceService`'s own,
   * unconditional, always-fresh check, so a QR can never substitute for it.
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
  }
}
