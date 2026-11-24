import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Owner decision 39 (DECISIONS-PENDING.md, decided 2026-11-22): a shift whose pay rate resolves to £0 — no explicit rate,
 * no venue role rate in force and no job role default, or any of those set to 0 — is REFUSED, never created or published at
 * £0 ("set a pay rate for this role first"). 409 with a stable `code`, the repo's convention for a request that is valid
 * in shape but refused by the record's state (cf. JOB_ROLE_ARCHIVED, SHIFT_ARCHIVED).
 */
export const PAY_RATE_REQUIRED_CODE = 'PAY_RATE_REQUIRED';
export const PAY_RATE_REQUIRED_MESSAGE = 'Set a pay rate for this role first.';

export class PayRateRequiredException extends ConflictException {
  constructor() {
    super({ statusCode: 409, code: PAY_RATE_REQUIRED_CODE, message: PAY_RATE_REQUIRED_MESSAGE });
  }
}

/** Decision 39: throws PayRateRequiredException unless the rate is a positive whole number of pence. */
export function assertPayRateSet(payRatePence: number | null | undefined): number {
  if (typeof payRatePence !== 'number' || !Number.isSafeInteger(payRatePence) || payRatePence <= 0) throw new PayRateRequiredException();
  return payRatePence;
}

/**
 * Owner decision 40 (DECISIONS-PENDING.md, decided 2026-11-22): a rate period's dates are judged in the ORGANISATION's time
 * zone (core.organisation.timezone) and both ends are inclusive. This returns the calendar date (`YYYY-MM-DD`) of `instant`
 * in the time zone of the organisation bound to this transaction (core.current_org()), computed by PostgreSQL's time-zone
 * database. Every rate lookup compares `effective_from <= day AND (effective_to IS NULL OR effective_to >= day)`, so a rate
 * ending on day D applies to a shift starting at any time on D (organisation-local).
 * Fail closed: when no organisation row is visible (no tenant context bound, or RLS hides it) this THROWS — a rate is never
 * judged in a guessed time zone.
 */
export async function organisationLocalDate(manager: EntityManager, instant: Date | string): Promise<string> {
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) throw new Error('organisationLocalDate: invalid instant');
  const rows = (await manager.query(
    `SELECT to_char($1::timestamptz AT TIME ZONE o.timezone, 'YYYY-MM-DD') AS day FROM core.organisation o WHERE o.id = core.current_org()`,
    [at.toISOString()],
  )) as Array<{ day: string | null }>;
  if (rows.length !== 1 || !rows[0]!.day) throw new Error('organisationLocalDate: no organisation time zone is visible (missing tenant context); refusing to guess');
  return rows[0]!.day;
}
