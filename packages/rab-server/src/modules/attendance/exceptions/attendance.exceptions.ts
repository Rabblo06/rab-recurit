import { ConflictException } from '@nestjs/common';

/**
 * Structured, machine-readable clock/QR/geofence failures — same shape as
 * `UserDeletionBlockedException` (`engine/core-modules/user-deletion/
 * user-deletion.service.ts`): a `code` the client can branch on, plus a
 * human-readable `message` it can show as a fallback. Never leaks internal
 * detail beyond what the client needs to render the right UI (e.g.
 * `ClockInTooEarlyException` gives `shiftStart`/`availableAt` — real values,
 * per Part 18 — but never assignment/venue internals).
 */

export class ClockInTooEarlyException extends ConflictException {
  constructor(
    public readonly shiftStart: string,
    public readonly availableAt: string,
  ) {
    super({
      statusCode: 409,
      code: 'CLOCK_IN_TOO_EARLY',
      message: `Too early to clock in — this shift starts at ${shiftStart}.`,
      shiftStart,
      availableAt,
    });
  }
}

export class ClockWindowClosedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'CLOCK_WINDOW_CLOSED',
      message: "This shift's clock-in/out window has closed.",
    });
  }
}

export class LocationRequiredException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'LOCATION_REQUIRED',
      message: 'Location is required to clock in or out at this venue.',
    });
  }
}

export class LocationAccuracyTooLowException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'LOCATION_ACCURACY_TOO_LOW',
      message: "We couldn't confirm your location accurately enough. Please try again.",
    });
  }
}

export class OutsideVenueException extends ConflictException {
  constructor(public readonly venueName: string) {
    super({
      statusCode: 409,
      code: 'OUTSIDE_VENUE',
      message: `You need to be at ${venueName} to clock in.`,
      venueName,
    });
  }
}

export class InvalidQrException extends ConflictException {
  constructor(reason: 'expired' | 'invalid' | 'shift_mismatch' | 'venue_mismatch') {
    const messages: Record<typeof reason, string> = {
      expired: 'This QR code has expired.',
      invalid: 'Invalid QR code.',
      shift_mismatch: 'This QR code is for a different shift.',
      venue_mismatch: 'This QR code is for a different venue.',
    };
    super({ statusCode: 409, code: 'INVALID_QR', reason, message: messages[reason] });
  }
}
