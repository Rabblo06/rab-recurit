/** `[startsAt, endsAt)` as a Postgres range literal — see SchedulingSchema's migration note on why `period` is denormalised onto `shift_assignment`. */
export function toTstzRange(startsAt: Date, endsAt: Date): string {
  return `[${startsAt.toISOString()},${endsAt.toISOString()})`;
}
