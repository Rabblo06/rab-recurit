import { BadRequestException, ConflictException } from '@nestjs/common';
import type { LocationEvidenceErrorCode } from '@rab/shared';

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
      message: 'Location is required to check in, clock in or clock out at this venue. Turn on location and try again.',
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
      code: 'OUTSIDE_GEOFENCE',
      message: "You're outside the venue's permitted check-in area.",
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

export class LocationStaleException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'LOCATION_STALE',
      message: 'Your location reading is out of date. Refresh your location and try again.',
    });
  }
}

/** The venue enforces its geofence but has no usable coordinates/radius: refused, never silently allowed (strict policy). */
export class GeofenceMisconfiguredException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'GEOFENCE_MISCONFIGURED',
      message: "This venue's location check is not set up correctly. Ask your manager to update the venue's location settings.",
    });
  }
}

export function locationEvidenceException(code: LocationEvidenceErrorCode, venueName: string): ConflictException {
  switch (code) {
    case 'LOCATION_REQUIRED':
      return new LocationRequiredException();
    case 'LOCATION_STALE':
      return new LocationStaleException();
    case 'LOCATION_ACCURACY_TOO_LOW':
      return new LocationAccuracyTooLowException();
    case 'OUTSIDE_GEOFENCE':
      return new OutsideVenueException(venueName);
    case 'GEOFENCE_MISCONFIGURED':
      return new GeofenceMisconfiguredException();
  }
}

export class CheckInRequiredException extends ConflictException {
  constructor() {
    super({ statusCode: 409, code: 'CHECK_IN_REQUIRED', message: 'Check in at the venue before you clock in.' });
  }
}

export class CheckInTooEarlyException extends ConflictException {
  constructor(
    public readonly shiftStart: string,
    public readonly availableAt: string,
  ) {
    super({
      statusCode: 409,
      code: 'CHECK_IN_TOO_EARLY',
      message: `Too early to check in — this shift starts at ${shiftStart}.`,
      shiftStart,
      availableAt,
    });
  }
}

export class CheckInWindowClosedException extends ConflictException {
  constructor() {
    super({ statusCode: 409, code: 'CHECK_IN_WINDOW_CLOSED', message: "This shift's check-in window has closed." });
  }
}

/** The shift monitor flagged this booking's attendance as missing (provisional no-show): only a manager can record it now. */
export class AttendanceFlaggedMissingException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'ATTENDANCE_FLAGGED_MISSING',
      message: 'Your attendance for this shift was flagged as missing. Ask the venue manager to record your attendance.',
    });
  }
}

export class AlreadyClockedInException extends ConflictException {
  constructor(message = 'Already clocked in for this shift.') {
    super({ statusCode: 409, code: 'ALREADY_CLOCKED_IN', message });
  }
}

export class NotClockedInException extends ConflictException {
  constructor(message = "This staff member hasn't clocked in.") {
    super({ statusCode: 409, code: 'NOT_CLOCKED_IN', message });
  }
}

/** Venue Manager clock-in on behalf: the staff member's own Check In is the presence proof, and there is none yet. */
export class StaffNotCheckedInException extends ConflictException {
  constructor(firstName: string) {
    super({
      statusCode: 409,
      code: 'STAFF_NOT_CHECKED_IN',
      message: `Staff hasn't checked in yet. ${firstName} must check in before you can clock them in.`,
    });
  }
}

/** Geofence enforced, but the staff member's Check In did not pass a geofence check — the manager's phone proves nothing. */
export class PresenceNotVerifiedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRESENCE_NOT_VERIFIED',
      message:
        "This venue requires location, and the staff member's check-in was not location-verified. Ask them to clock in on their phone, or record their attendance in the shift report.",
    });
  }
}

/** Geofence enforced: a manager cannot attest the staff member's location at clock-out. */
export class PresenceEvidenceRequiredException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'PRESENCE_EVIDENCE_REQUIRED',
      message:
        'This venue requires location for clock-out, which a manager cannot provide. Ask the staff member to clock out on their phone, or record the clock-out time in the shift report (Review staff report → Record attendance) once the shift has ended.',
    });
  }
}

export class ReasonTooShortException extends BadRequestException {
  constructor(minWords: number) {
    super({ statusCode: 400, code: 'REASON_TOO_SHORT', message: `Add a reason of at least ${minWords} words.` });
  }
}
