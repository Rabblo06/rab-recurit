/**
 * The two statements of `SchedulingService.rotateShiftQr` (QR review M1), shared with the regression test that replays
 * them against a concurrently rendering pre-shift report, so the test exercises exactly what the service runs.
 *
 * 1. `ROTATE_SHIFT_QR_LOCK_SQL` takes the shift row FOR UPDATE first. The pre-shift report scheduler holds the same row
 *    FOR SHARE while it stamps the report, so a rotation that collides with it waits here until that commit. It also
 *    returns `not_ended` by the DATABASE clock (owner decision M2, 2026-11-15): a shift whose end has passed is refused
 *    (the report is no longer regenerated after the end, so a rotation would strand staff still inside the grace).
 * 2. `ROTATE_SHIFT_QR_UPDATE_SQL` is a compare-and-set on the (qr_version, status) the service read before the lock, and
 *    writes `updated_at = clock_timestamp()` — the time of the write, after any lock wait — never `now()` (the transaction's
 *    START time, which can be earlier than the report's generation stamp and would leave a revoked QR on a report the
 *    scheduler considers fresh).
 *
 * Unqualified `shift`: resolved through the tenant session's search_path, like every other runtime query.
 */
export const ROTATE_SHIFT_QR_LOCK_SQL = `SELECT id, (ends_at > now()) AS not_ended FROM shift WHERE id = $1 FOR UPDATE`;

export const ROTATE_SHIFT_QR_UPDATE_SQL = `UPDATE shift SET qr_version = qr_version + 1, updated_at = clock_timestamp()
          WHERE id = $1 AND qr_version = $2 AND status = $3 RETURNING qr_version`;
