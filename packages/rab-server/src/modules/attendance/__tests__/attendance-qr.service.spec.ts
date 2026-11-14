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
const ENV: Record<string, unknown> = { APP_SECRET, CLOCK_IN_EARLY_MINUTES: 15, QR_POST_SHIFT_GRACE_MINUTES: GRACE_MINUTES };
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
  const manager = { findOneByOrFail: async (_entity: unknown, where: { id: string }) => (where.id === shift.id ? shift : Promise.reject(new Error('not found'))) } as never;

  const at = (instant: number | Date) => jest.setSystemTime(typeof instant === 'number' ? instant : instant.getTime());
  const accepted = (token: string, shiftId = SHIFT_ID) => expect(qr.validateQr(manager, shiftId, token)).resolves.toBeUndefined();
  const refused = (token: string, reason: string, shiftId = SHIFT_ID) =>
    expect(qr.validateQr(manager, shiftId, token)).rejects.toMatchObject({ response: { code: 'INVALID_QR', reason } });

  /** Signs as the pre-shift report job does, with the clock pinned to the print time. */
  function printQr(when: Date = PRINTED_AT): string {
    at(when);
    return qr.sign(shift);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: PRINTED_AT });
    shift = { id: SHIFT_ID, venueId: VENUE_ID, startsAt: new Date(STARTS_AT), endsAt: new Date(ENDS_AT), qrVersion: 1 } as Shift;
  });
  afterEach(() => jest.useRealTimers());

  it('validUntil is the shift end + QR_POST_SHIFT_GRACE_MINUTES (the same grace assertClockWindow closes with)', () => {
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

  it('a venue reassignment or a bumped qrVersion after printing refuses the QR', async () => {
    const token = printQr();
    at(ENDS_AT.getTime() - 5 * MIN);
    shift.qrVersion = 2;
    await refused(token, 'venue_mismatch');
    shift.qrVersion = 1;
    shift.venueId = '7c1e0b8a-2222-4a5b-9c8d-0000000000ff';
    await refused(token, 'venue_mismatch');
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
    await expect(noGrace.validateQr(manager, SHIFT_ID, token)).rejects.toMatchObject({ response: { code: 'INVALID_QR', reason: 'expired' } });
  });
});
