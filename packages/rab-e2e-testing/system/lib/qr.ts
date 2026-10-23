import { hkdfSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { stackSecrets } from './env';

/**
 * The Shift QR a staff member scans at the venue. In production it is printed on the pre-shift report (a PDF the worker
 * renders) or shown by the Venue Manager app; a headless test cannot point a phone camera at it, so this produces the
 * byte-identical token the same way `QrTokenService.sign` does (HKDF(APP_SECRET, 'rab-qr-token-v1'), HS256,
 * iss rab-attendance, aud rab-qr) with the DISPOSABLE stack's own secret. Every server-side check (signature, expiry,
 * shift/venue/version match, confirmed seat, check-in-first, clock window, geofence) still runs unchanged.
 */
export function shiftQrToken(shift: { id: string; venueId: string; qrVersion: number }, expiresInSeconds = 24 * 3600): string {
  const appSecret = stackSecrets().E2E_APP_SECRET!;
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(appSecret, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex');
  return jwt.sign({ shiftId: shift.id, venueId: shift.venueId, ver: shift.qrVersion }, key, {
    algorithm: 'HS256',
    issuer: 'rab-attendance',
    audience: 'rab-qr',
    expiresIn: expiresInSeconds,
  });
}
