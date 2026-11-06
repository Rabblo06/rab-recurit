import { DataSource } from 'typeorm';

/**
 * FIXTURE ONLY (owner rule 2026-11-06: a standard offer can be sent, accepted and confirmed only before its approval
 * deadline, assignment start − 30 min). Many suites book a shift that starts "now" (or already started) to test what
 * happens AFTER a confirmed booking exists — clock-in, no-show, reports, payroll. They now book it the only way the
 * product allows: the whole shift (and every seat on it) is moved `delta` into the future so its earliest start is
 * 3 hours ahead, `book()` runs the real send / accept / confirm, and everything is moved back by exactly `delta`.
 * Production code is never bypassed; only the clock-relative fixture times move. `admin` must be the suites' superuser
 * fixture connection (it bypasses RLS, like every other fixture write).
 */
export async function bookBeforeDeadline<T>(admin: DataSource, shiftId: string, book: () => Promise<T>): Promise<T> {
  const [row] = await admin.query<Array<{ secs: number | null }>>(
    `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (now() + interval '3 hours')
              - LEAST(COALESCE(s.default_starts_at, s.starts_at), s.starts_at,
                      COALESCE((SELECT min(lower(sa.period)) FROM core.shift_assignment sa WHERE sa.shift_id = s.id), s.starts_at)))))::int AS secs
       FROM core.shift s WHERE s.id = $1`,
    [shiftId],
  );
  const secs = Number(row?.secs ?? 0);
  if (secs > 0) await moveShift(admin, shiftId, secs);
  try {
    return await book();
  } finally {
    if (secs > 0) await moveShift(admin, shiftId, -secs);
  }
}

async function moveShift(admin: DataSource, shiftId: string, secs: number): Promise<void> {
  await admin.query(
    `UPDATE core.shift SET starts_at = starts_at + make_interval(secs => $2), ends_at = ends_at + make_interval(secs => $2),
            default_starts_at = default_starts_at + make_interval(secs => $2), default_ends_at = default_ends_at + make_interval(secs => $2)
      WHERE id = $1`,
    [shiftId, secs],
  );
  await admin.query(
    `UPDATE core.shift_assignment SET period = tstzrange(lower(period) + make_interval(secs => $2), upper(period) + make_interval(secs => $2), '[)')
      WHERE shift_id = $1 AND period IS NOT NULL`,
    [shiftId, secs],
  );
}
