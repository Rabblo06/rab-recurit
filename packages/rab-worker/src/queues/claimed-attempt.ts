/**
 * D-Q5b (owner confirmation OC-1, 2026-11-04): the email and push attempt caps are CUMULATIVE across dispatch generations.
 *
 * Every claim of a delivery row (`status → PROCESSING`) adds one to the row's own attempt column in the same CAS UPDATE and
 * returns the new value (`RETURNING`); every later write of that attempt (SENT / ACCEPTED / RETRY / FAILED) records it, and
 * the attempt is final when that count reaches the row's maximum. A row republished under a new generation — a new BullMQ
 * job whose `attemptsMade` starts again at 0 — therefore continues from the count it already carries, and the claim itself
 * refuses a row that is already at its maximum (the dispatcher's exhausted gate then fails it). Before, every write used
 * `job.attemptsMade + 1`, so the cap of 5 applied per generation and a row that kept being republished never reached it.
 */
export interface ClaimedAttempt {
  /** This attempt's number, counted across every generation (1 = the row's first attempt). */
  count: number;
  /** The row's own cap (`max_infrastructure_attempts` / `max_attempts`). */
  max: number;
}

/**
 * Reads the claim's RETURNING row. Fails closed: a claim that does not report a valid count throws INSIDE the claim
 * transaction, which rolls the claim back — nothing is sent and the row is exactly as it was before this attempt.
 */
export function claimedAttemptFrom(
  raw: unknown,
  countColumn: string,
  maxColumn: string,
): ClaimedAttempt {
  const first = Array.isArray(raw)
    ? (raw[0] as Record<string, unknown> | undefined)
    : undefined;
  const count = Number(first?.[countColumn]);
  const max = Number(first?.[maxColumn]);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(max) ||
    max < 1
  ) {
    throw new Error(
      `The claim did not return a valid attempt count (${countColumn}); refusing to send.`,
    );
  }
  return { count, max };
}
