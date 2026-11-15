import { JwtService } from '@nestjs/jwt';
import { hkdfSync } from 'node:crypto';

import { Shift } from '../../scheduling/entities/shift.entity';
import { AttendanceQrService } from '../services/attendance-qr.service';
import { QrTokenService } from '../services/qr-token.service';

/**
 * QR expiry follows the shift, not the signing time (owner decision 0i, 2026-11-14): a QR is accepted until the
 * shift's CURRENT end + QR_POST_SHIFT_GRACE_MINUTES, re-read on every scan. Real QrTokenService/JwtService (HS256,
 * HKDF-derived key), a fake manager that returns the shift row as it is "now", and jest fake timers for the clock
 * (they cover Date.now and new Date, including jsonwebtoken's own clock reads).
 */
const APP_SECRET = 'attendance-qr-spec-app-secret-NOT-A-REAL-SECRET-000000000000';
const GRACE_MINUTES = 120;
const ENV: Record<string, unknown> = { APP_SECRET, CLOCK_IN_EARLY_MINUTES: 15, QR_POST_SHIFT_GRACE_MINUTES: GRACE_MINUTES, QR_MAX_AGE_DAYS: 14 };
const env = { get: (key: string) => ENV[key] } as never;

const MIN = 60_000;
const HOUR = 60 * MIN;
const SHIFT_ID = '7c1e0b8a-1111-4a5b-9c8d-000000000001';
const OTHER_SHIFT_ID = '7c1e0b8a-1111-4a5b-9c8d-000000000002';
const VENUE_ID = '7c1e0b8a-2222-4a5b-9c8d-000000000002';
const STARTS_AT = new Date('2026-11-20T18:00:00.000Z');
const ENDS_AT = new Date('2026-11-21T02:00:00.000Z'); // 8 h, overnight
/** The pre-shift report is generated up to REPORT_AVAILABLE_BEFORE_MINUTES (180) before the start. */
const PRINTED_AT = new Date(STARTS_AT.getTime() - 3 * HOUR);

describe('AttendanceQrService — expiry from the shift’s current end + grace', () => {
  const tokens = new QrTokenService(new JwtService(), env);
  const qr = new AttendanceQrService(tokens, env);
  let shift: Shift;
  /** The scanning staff member's booking: no own period → the shift's times (effectiveAssignmentTime). */
  let seat: { period: string | null };
  const manager = { findOneByOrFail: async (_entity: unknown, where: { id: string }) => (where.id === shift.id ? shift : Promise.reject(new Error('not found'))) } as never;

  const at = (instant: number | Date) => jest.setSystemTime(typeof instant === 'number' ? instant : instant.getTime());
  const accepted = (token: string, shiftId = SHIFT_ID) => expect(qr.validateQr(manager, shiftId, token, seat)).resolves.toBeUndefined();
  const refused = (token: string, reason: string, shiftId = SHIFT_ID) =>
    expect(qr.validateQr(manager, shiftId, token, seat)).rejects.toMatchObject({ response: { code: 'INVALID_QR', reason } });

  /** Signs as the pre-shift report job does, with the clock pinned to the print time. */
  function printQr(when: Date = PRINTED_AT): string {
    at(when);
    return qr.sign(shift);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: PRINTED_AT });
    shift = { id: SHIFT_ID, venueId: VENUE_ID, startsAt: new Date(STARTS_AT), endsAt: new Date(ENDS_AT), qrVersion: 1 } as Shift;
    seat = { period: null };
  });
  afterEach(() => jest.useRealTimers());

  it('validUntil is the given (seat) end + QR_POST_SHIFT_GRACE_MINUTES (the same grace assertClockWindow closes with)', () => {
    expect(qr.validUntil(shift).toISOString()).toBe(new Date(ENDS_AT.getTime() + GRACE_MINUTES * MIN).toISOString());
  });

  it('a newly signed QR carries no exp: its lifetime is the shift’s, not the token’s', () => {
    const claims = new JwtService().decode<Record<string, unknown>>(printQr());
    expect(claims).toMatchObject({ shiftId: SHIFT_ID, venueId: VENUE_ID, ver: 1, iss: 'rab-attendance', aud: 'rab-qr' });
    expect(claims.exp).toBeUndefined();
  });

  it('a QR printed 3 h before the shift is accepted in the shift’s last minutes and through the grace, refused 1 s after end + grace', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN); // last minutes of the shift (the old signing-relative exp had lapsed ~45 min before the end)
    await accepted(token);
    at(ENDS_AT.getTime() - 1);
    await accepted(token);
    at(ENDS_AT.getTime() + 60 * MIN); // during the grace
    await accepted(token);
    at(ENDS_AT.getTime() + GRACE_MINUTES * MIN); // the last accepted instant
    await accepted(token);
    at(ENDS_AT.getTime() + GRACE_MINUTES * MIN + 1000);
    await refused(token, 'expired');
    at(ENDS_AT.getTime() + 24 * HOUR); // and stays refused
    await refused(token, 'expired');
  });

  it('an extended shift (end moved later after the QR was printed) accepts the QR until the NEW end + grace', async () => {
    const token = printQr();
    const newEnd = ENDS_AT.getTime() + 3 * HOUR;
    // Before the extension, the original end + grace has already closed the QR.
    at(ENDS_AT.getTime() + GRACE_MINUTES * MIN + 1000);
    await refused(token, 'expired');
    shift.endsAt = new Date(newEnd); // manager extends the shift; the next scan re-reads the row
    await accepted(token);
    at(newEnd + GRACE_MINUTES * MIN);
    await accepted(token);
    at(newEnd + GRACE_MINUTES * MIN + 1000);
    await refused(token, 'expired');
  });

  it('a shortened shift refuses the QR after the NEW end + grace (the original end no longer counts)', async () => {
    const token = printQr();
    const newEnd = ENDS_AT.getTime() - 4 * HOUR;
    shift.endsAt = new Date(newEnd);
    at(newEnd + GRACE_MINUTES * MIN);
    await accepted(token);
    at(newEnd + GRACE_MINUTES * MIN + 1000);
    await refused(token, 'expired'); // well before the ORIGINAL end + grace
    expect(Date.now()).toBeLessThan(ENDS_AT.getTime() + GRACE_MINUTES * MIN);
  });

  it('a QR for one shift is never accepted for another, inside its own validity', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    await refused(token, 'shift_mismatch', OTHER_SHIFT_ID);
  });

  it('a tampered signature, a forged key and a malformed string are refused as invalid', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    const tampered = `${token.slice(0, -4)}${token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    await refused(tampered, 'invalid');
    // Same claims, signed without the derived key (e.g. with APP_SECRET itself): refused, so the missing exp is not a forgery path.
    const forged = new JwtService().sign({ shiftId: SHIFT_ID, venueId: VENUE_ID, ver: 1 }, { secret: APP_SECRET, algorithm: 'HS256', issuer: 'rab-attendance', audience: 'rab-qr' });
    await refused(forged, 'invalid');
    await refused('not-a-jwt-at-all', 'invalid');
  });

  it('a token signed with the derived key but the wrong issuer, the wrong audience or an unpinned algorithm is refused', async () => {
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex');
    const claims = { shiftId: SHIFT_ID, venueId: VENUE_ID, ver: 1 };
    const jwt = new JwtService();
    at(ENDS_AT.getTime() - 5 * MIN);
    // Control: the same key, issuer, audience and algorithm as production is accepted, so each refusal below is the one difference.
    await accepted(jwt.sign(claims, { secret: key, algorithm: 'HS256', issuer: 'rab-attendance', audience: 'rab-qr' }));
    await refused(jwt.sign(claims, { secret: key, algorithm: 'HS256', issuer: 'rab-auth', audience: 'rab-qr' }), 'invalid');
    await refused(jwt.sign(claims, { secret: key, algorithm: 'HS256', issuer: 'rab-attendance', audience: 'rab-api' }), 'invalid');
    await refused(jwt.sign(claims, { secret: key, algorithm: 'HS256', audience: 'rab-qr' }), 'invalid'); // no issuer
    await refused(jwt.sign(claims, { secret: key, algorithm: 'HS256', issuer: 'rab-attendance' }), 'invalid'); // no audience
    await refused(jwt.sign(claims, { secret: key, algorithm: 'HS512', issuer: 'rab-attendance', audience: 'rab-qr' }), 'invalid'); // HS256 is pinned
    // alg:none — unsigned, hand-built (jsonwebtoken will not sign it): header.payload. with an empty signature.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iat: Math.floor(Date.now() / 1000), iss: 'rab-attendance', aud: 'rab-qr' })}.`;
    await refused(unsigned, 'invalid');
  });

  it('a rotated QR (qrVersion bumped after printing) is refused as revoked; the new QR is accepted; a venue change is venue_mismatch', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    shift.qrVersion = 2; // SchedulingService.rotateShiftQr
    await refused(token, 'revoked');
    await accepted(qr.sign(shift)); // the regenerated report's QR
    shift.qrVersion = 1;
    shift.venueId = '7c1e0b8a-2222-4a5b-9c8d-0000000000ff';
    await refused(token, 'venue_mismatch');
  });

  it('14-day ceiling: signed at T for a shift ending T+20d, refused at T+14d+1s (expired), accepted at T+14d-1s', async () => {
    const T = PRINTED_AT.getTime();
    shift.startsAt = new Date(T + 60 * MIN);
    shift.endsAt = new Date(T + 20 * 24 * HOUR);
    const token = printQr(new Date(T));
    at(T + 14 * 24 * HOUR - 1000); // the shift is still open, the token is just under 14 days old
    await accepted(token);
    at(T + 14 * 24 * HOUR + 1000);
    await refused(token, 'expired');
    expect(Date.now()).toBeLessThan(qr.validUntil(shift).getTime()); // refused by the ceiling, not by the shift end
  });

  it('the ceiling follows QR_MAX_AGE_DAYS, and a token with no iat is refused when a ceiling applies', async () => {
    const shortEnv = { get: (key: string) => (key === 'QR_MAX_AGE_DAYS' ? 2 : ENV[key]) } as never;
    const shortQr = new AttendanceQrService(new QrTokenService(new JwtService(), shortEnv), shortEnv);
    const token = printQr();
    at(PRINTED_AT.getTime() + 2 * 24 * HOUR + 1000);
    shift.endsAt = new Date(PRINTED_AT.getTime() + 10 * 24 * HOUR);
    await expect(shortQr.validateQr(manager, SHIFT_ID, token, seat)).rejects.toMatchObject({ response: { reason: 'expired' } });
    await accepted(token); // 14 days by default
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex');
    const noIat = new JwtService().sign({ shiftId: SHIFT_ID, venueId: VENUE_ID, ver: 1 }, { secret: key, algorithm: 'HS256', issuer: 'rab-attendance', audience: 'rab-qr', noTimestamp: true });
    await refused(noIat, 'invalid');
  });

  it('a missing ceiling setting refuses instead of verifying without one', async () => {
    const noCeiling = { get: (key: string) => (key === 'QR_MAX_AGE_DAYS' ? undefined : ENV[key]) } as never;
    const q = new AttendanceQrService(new QrTokenService(new JwtService(), noCeiling), noCeiling);
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    await expect(q.validateQr(manager, SHIFT_ID, token, seat)).rejects.toMatchObject({ response: { code: 'INVALID_QR', reason: 'invalid' } });
  });

  it('per-seat grace: a seat ending earlier than the shift closes at ITS end + grace, while a later seat is still accepted', async () => {
    const token = printQr();
    const seatAEnd = ENDS_AT.getTime() - 3 * HOUR;
    const seatA = { period: `["${STARTS_AT.toISOString()}","${new Date(seatAEnd).toISOString()}")` };
    const seatB = { period: `["${STARTS_AT.toISOString()}","${ENDS_AT.toISOString()}")` };
    at(seatAEnd + GRACE_MINUTES * MIN);
    await expect(qr.validateQr(manager, SHIFT_ID, token, seatA)).resolves.toBeUndefined();
    at(seatAEnd + GRACE_MINUTES * MIN + 1000);
    await expect(qr.validateQr(manager, SHIFT_ID, token, seatA)).rejects.toMatchObject({ response: { reason: 'expired' } });
    await expect(qr.validateQr(manager, SHIFT_ID, token, seatB)).resolves.toBeUndefined();
    at(ENDS_AT.getTime() + GRACE_MINUTES * MIN + 1000);
    await expect(qr.validateQr(manager, SHIFT_ID, token, seatB)).rejects.toMatchObject({ response: { reason: 'expired' } });
  });

  it('a token signed before this change keeps its own exp: both bounds must pass (no printed QR gains validity)', async () => {
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex');
    at(PRINTED_AT);
    const legacy = new JwtService().sign({ shiftId: SHIFT_ID, venueId: VENUE_ID, ver: 1 }, { secret: key, algorithm: 'HS256', issuer: 'rab-attendance', audience: 'rab-qr', expiresIn: 3600 });
    at(PRINTED_AT.getTime() + 3600_000 - 1000);
    await accepted(legacy);
    at(PRINTED_AT.getTime() + 3600_000 + 1000); // its exp lapsed, though the shift has not even started
    await refused(legacy, 'expired');
  });

  it('fails closed on an unreadable end time or a missing grace setting', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    shift.endsAt = new Date(Number.NaN);
    await refused(token, 'expired');
    shift.endsAt = new Date(ENDS_AT);
    const noGrace = new AttendanceQrService(tokens, { get: (key: string) => (key === 'QR_POST_SHIFT_GRACE_MINUTES' ? undefined : ENV[key]) } as never);
    await expect(noGrace.validateQr(manager, SHIFT_ID, token, seat)).rejects.toMatchObject({ response: { code: 'INVALID_QR', reason: 'expired' } });
  });
});
