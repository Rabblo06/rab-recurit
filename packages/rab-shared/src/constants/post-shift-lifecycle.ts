/**
 * PHASE 7.1 — the single source of truth for the post-shift display
 * lifecycle's two milestones: `CLOCKED_OUT -> COMPLETE` at `clockOutAt +
 * POST_SHIFT_COMPLETE_HOURS`, then `COMPLETE -> EXPIRED` at `clockOutAt +
 * POST_SHIFT_EXPIRED_HOURS`. Consumed by `PostShiftLifecycleService`
 * (`rab-server`, the authoritative worker-driven writer of `core.
 * attendance.post_shift_completed_at`/`post_shift_expired_at`) and by
 * `resolveStaffShiftPresentation` (`rab-server`, the read-only projection
 * that also derives a display-only `nextTransitionAt` hint from the same
 * two numbers) — previously two independently hardcoded `2`/`6` literals
 * that had to be kept in sync by hand.
 *
 * IMPORTANT — a THIRD, independent copy of these same two numbers lives at
 * the database level and CANNOT be replaced by this constant: the
 * `attendance_post_shift_order` CHECK constraint (added in
 * `AttendancePostShiftLifecycle1786672700000`, corrected for the 1h/2h
 * thresholds in `PostShiftTimingCorrection1786673600000`) hardcodes
 * `interval '1 hour'`/`interval '2 hours'` directly in SQL — Postgres has
 * no mechanism to import a JS/TS constant into a CHECK expression. Any
 * future change to the values below MUST be paired with a new migration
 * that drops and recreates that constraint with the matching interval
 * literals, or writes will start failing a CHECK violation the moment the
 * application and database values diverge.
 */
export const POST_SHIFT_COMPLETE_HOURS = 1;
export const POST_SHIFT_EXPIRED_HOURS = 2;

export const POST_SHIFT_COMPLETE_MS = POST_SHIFT_COMPLETE_HOURS * 3600000;
export const POST_SHIFT_EXPIRED_MS = POST_SHIFT_EXPIRED_HOURS * 3600000;
