import { assertSafePence } from '@rab/shared';

/**
 * Postgres `bigint` round-trips through pg/TypeORM as a string by default
 * (avoids silent precision loss above Number.MAX_SAFE_INTEGER). Every
 * money column in this schema is pence, which never approaches that —
 * apply this transformer so entities expose plain numbers, matching
 * @rab/shared's money.ts.
 *
 * Wave 2 lane S2 (C1/C2): "never approaches that" is now enforced, not assumed. A value outside
 * ±Number.MAX_SAFE_INTEGER (or a non-integer) is refused in BOTH directions with a RangeError instead
 * of being silently rounded to a neighbouring number, so a corrupted or hostile bigint can never become
 * a different, plausible-looking amount. Inside the safe range `Number(string)` is exact.
 * null/undefined and non-number write values (TypeORM FindOperator wrappers) keep their exact previous
 * behaviour — including the pre-existing `Number(null) === 0` read of a NULL column, which is left
 * unchanged on purpose (see WAVE2_LANE_S2_REPORT.md: changing it alters API output, a domain decision).
 */
export const bigintAsNumber = {
  to: (value: number) => (typeof value === 'number' ? assertSafePence(value, 'bigint column value') : value),
  from: (value: string) => {
    if (value === null || value === undefined) return Number(value);
    return assertSafePence(Number(value), 'bigint column value');
  },
};
