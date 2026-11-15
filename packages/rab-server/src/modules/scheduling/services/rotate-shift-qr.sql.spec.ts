import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROTATE_SHIFT_QR_LOCK_SQL, ROTATE_SHIFT_QR_UPDATE_SQL } from './rotate-shift-qr.sql';

/**
 * QR review M1 source pin: rotateShiftQr must lock the row first and stamp updated_at with clock_timestamp() (the write
 * time, after any lock wait), never now() (its transaction's start, which can precede the pre-shift report's stamp and
 * leave a revoked QR on a report the scheduler considers fresh). The behaviour itself is pinned by the lock-wait test in
 * rab-worker report-worker-concurrency.integration.spec.ts, which replays these exact statements.
 */
describe('rotateShiftQr SQL (QR review M1)', () => {
  it('the update stamps updated_at with clock_timestamp(), never now()', () => {
    expect(ROTATE_SHIFT_QR_UPDATE_SQL).toMatch(/updated_at\s*=\s*clock_timestamp\(\)/);
    expect(ROTATE_SHIFT_QR_UPDATE_SQL).not.toMatch(/\bnow\(\)|current_timestamp|transaction_timestamp|statement_timestamp/i);
    expect(ROTATE_SHIFT_QR_UPDATE_SQL).toMatch(/qr_version = qr_version \+ 1/);
    expect(ROTATE_SHIFT_QR_UPDATE_SQL).toMatch(/WHERE id = \$1 AND qr_version = \$2 AND status = \$3/);
  });

  it('the lock is a FOR UPDATE row lock on the shift and reads not_ended by the database clock (M2)', () => {
    expect(ROTATE_SHIFT_QR_LOCK_SQL).toMatch(/FROM shift WHERE id = \$1 FOR UPDATE$/);
    expect(ROTATE_SHIFT_QR_LOCK_SQL).toMatch(/\(ends_at > now\(\)\) AS not_ended/);
  });

  it('SchedulingService runs the lock, then the update, from these constants (no inline copy)', () => {
    const source = readFileSync(join(__dirname, 'scheduling.service.ts'), 'utf8');
    const lockAt = source.indexOf('manager.query(ROTATE_SHIFT_QR_LOCK_SQL');
    const updateAt = source.indexOf('manager.query(ROTATE_SHIFT_QR_UPDATE_SQL');
    expect(lockAt).toBeGreaterThan(0);
    expect(updateAt).toBeGreaterThan(lockAt);
    expect(source).not.toMatch(/qr_version = qr_version \+ 1/);
  });
});
