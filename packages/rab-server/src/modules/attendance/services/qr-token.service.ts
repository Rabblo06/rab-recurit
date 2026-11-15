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
 * own derived secret and NO `exp` claim: a QR's lifetime is not a property
 * of the token but of the shift it names (owner decision 0i, 2026-11-14) —
 * `AttendanceQrService.validateQr` refuses it once now is past that shift's
 * CURRENT `endsAt` + `QR_POST_SHIFT_GRACE_MINUTES`, read fresh on every scan.
 *
 * A hard ceiling still applies: `verify()` refuses any token whose `iat` is older than `QR_MAX_AGE_DAYS` (default 14),
 * whatever the shift's end (owner decision 2026-11-14).
 *
 * Why no `exp` is still fail-closed: `verify()` below only establishes that
 * WE issued the token for a given shift/venue/ver — it is never, on its own,
 * an "accept" decision. The only consumer is `AttendanceQrService.validateQr`,
 * which always loads the shift and applies the time bound after it. A token
 * minted before this change still carries its own `exp`, and `verify()`
 * still enforces any `exp` that is present (both bounds must pass), so no
 * already-printed QR gains a single second of validity from this change.
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
   * Signs a QR for one shift. Deliberately no `expiresIn` — see the class comment: the shift row, not the token, decides
   * how long a QR is accepted, so a QR printed hours before the shift (pre-shift report) or a shift extended after
   * printing is judged against the shift's current end at scan time.
   */
  sign(payload: QrTokenPayload): string {
    return this.jwt.sign(payload, { secret: this.secret(), algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE });
  }

  /**
   * Signature/algorithm/issuer/audience, the `QR_MAX_AGE_DAYS` age ceiling (and a legacy token's own `exp`, if it has one) only. Throws (caught by the
   * caller, mapped to a 409 `InvalidQrException`) — never a 500. NOT a complete validity check: the shift-based expiry
   * lives in `AttendanceQrService.validateQr`, the only caller allowed to turn this into an accept.
   */
  verify(token: string): QrTokenPayload {
    return this.jwt.verify<QrTokenPayload>(token, { secret: this.secret(), algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE, maxAge: this.maxAge() });
  }

  /**
   * Hard age ceiling (owner decision 2026-11-14): `QR_MAX_AGE_DAYS` (default 14) measured from `iat`, enforced by
   * jsonwebtoken's `maxAge` on top of the shift-based expiry. A token older than that fails as TokenExpiredError (mapped to
   * `expired`); a token with no `iat` fails outright ("iat required when maxAge is specified", mapped to `invalid`).
   * Fail closed: a missing or non-positive setting throws here rather than verifying without a ceiling.
   */
  private maxAge(): string {
    const days = this.env.get('QR_MAX_AGE_DAYS');
    if (!Number.isInteger(days) || days < 1) throw new Error('QR_MAX_AGE_DAYS must be a positive integer.');
    return `${days}d`;
  }
}
