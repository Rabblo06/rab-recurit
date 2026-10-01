import { hkdfSync } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';

/**
 * One signed QR per Shift, used for both Clock In and Clock Out (Part 31 —
 * the QR never encodes which action; the endpoint called plus the current
 * `Attendance.status` decide that server-side). Payload is deliberately
 * minimal — `shiftId`/`venueId`/`ver` only, no staff identity (identity
 * always comes from the caller's own JWT, never the QR).
 *
 * Signed with a key HKDF-derived from `APP_SECRET`, not `APP_SECRET`
 * itself: a QR is physically printed/displayed, inherently more exposed to
 * leakage/photographing than an access token that only ever lives in
 * memory/secure storage — deriving a distinct key means a leaked QR
 * verification secret can never be replayed against real login tokens.
 * Mirrors `AccessTokenService`'s `sign`/`verify` shape exactly (same
 * `JwtService`, same "pass the secret explicitly per call" convention —
 * see `AuthModule`'s own `JwtModule.register({})` comment), just with its
 * own derived secret and a dynamic, shift-window-based expiry instead of a
 * fixed TTL string.
 */
export interface QrTokenPayload {
  shiftId: string;
  venueId: string;
  /** Rotation counter — bumped (on `Shift`) whenever a change should invalidate an already-printed QR, e.g. a venue reassignment. */
  ver: number;
}

const HKDF_INFO = 'rab-qr-token-v1';
const HKDF_KEY_LENGTH = 32;
// PHASE 10 — explicit hardening, same reasoning as AccessTokenService: pin
// the algorithm and give this token type its OWN issuer/audience, distinct
// from `rab-auth`/`rab-api`. Even though the derived secret already
// prevents a QR token being accepted as an access token (different key
// entirely), a distinct issuer/audience is cheap defense-in-depth against
// any future code path that might accidentally verify the wrong token type
// against the wrong secret/expectation pair.
const ALGORITHM = 'HS256' as const;
const ISSUER = 'rab-attendance';
const AUDIENCE = 'rab-qr';

@Injectable()
export class QrTokenService {
  private derivedSecret: string | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly env: EnvironmentService,
  ) {}

  /** Derived once, cached for the life of the process — `APP_SECRET` never changes at runtime. */
  private secret(): string {
    if (this.derivedSecret) return this.derivedSecret;
    const appSecret = this.env.get('APP_SECRET');
    const derived = hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.alloc(0), HKDF_INFO, HKDF_KEY_LENGTH);
    this.derivedSecret = Buffer.from(derived).toString('hex');
    return this.derivedSecret;
  }

  /**
   * `expiresInSeconds` should cover the whole authorised attendance window
   * for this shift — `(shift.endsAt + QR_POST_SHIFT_GRACE_MINUTES) -
   * (shift.startsAt - CLOCK_IN_EARLY_MINUTES)` — computed by the caller
   * (`AttendanceQrService`/the report-scheduler job), since only they know
   * the shift's actual start/end. The JWT's own `exp` is the outer bound;
   * `AttendanceService.assertClockWindow` enforces the precise inner bound
   * against `now()` on every call — belt and braces, not redundant, since a
   * QR signed early and scanned right at its outer edge would otherwise be
   * technically "not yet JWT-expired" well past the real intended window.
   */
  sign(payload: QrTokenPayload, expiresInSeconds: number): string {
    return this.jwt.sign(payload, { secret: this.secret(), expiresIn: expiresInSeconds, algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE });
  }

  /** Throws (caught by the caller, mapped to a 409 `InvalidQrException`) on a bad signature or expiry — never a 500. */
  verify(token: string): QrTokenPayload {
    return this.jwt.verify<QrTokenPayload>(token, { secret: this.secret(), algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  }
}
