import { EntityManager } from 'typeorm';

/**
 * The rows of an `UPDATE … RETURNING` / `DELETE … RETURNING` run through `EntityManager.query`. TypeORM's Postgres
 * runner returns `[rows, rowCount]` for UPDATE and DELETE (and plain rows for SELECT / INSERT), so `const [row] = await
 * m.query('UPDATE … RETURNING …')` binds the ROWS ARRAY — always truthy — and a compare-and-set that matched nothing
 * would look like a success. Every Phase 2 CAS goes through this instead (Phase 1's `renewLease` / `finalise` too).
 */
export async function returningRows<T>(m: Pick<EntityManager, 'query'>, sql: string, params: unknown[]): Promise<T[]> {
  const result = (await m.query(sql, params)) as unknown;
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return Array.isArray(result) ? (result as T[]) : [];
}
