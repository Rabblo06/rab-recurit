/**
 * Postgres `numeric`/`decimal` columns round-trip through pg/TypeORM as
 * strings by default (same reasoning as `bigint-transformer.ts` — avoids
 * silent precision loss for values that could exceed float precision).
 * `Venue.lat`/`lng` (`numeric(9,6)`) are coordinates, never anywhere near
 * that range, so exposing plain numbers is safe and is what every
 * distance/geofence calculation (`@rab/shared`'s `haversineDistanceMeters`)
 * requires — without this, `venue.lat` arrives as the string `"51.508000"`,
 * which fails `Number.isFinite()` and crashes the geofence check.
 */
export const numericAsNumber = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
