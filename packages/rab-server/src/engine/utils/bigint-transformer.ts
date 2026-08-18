/**
 * Postgres `bigint` round-trips through pg/TypeORM as a string by default
 * (avoids silent precision loss above Number.MAX_SAFE_INTEGER). Every
 * money column in this schema is pence, which never approaches that —
 * apply this transformer so entities expose plain numbers, matching
 * @rab/shared's money.ts.
 */
export const bigintAsNumber = {
  to: (value: number) => value,
  from: (value: string) => Number(value),
};
