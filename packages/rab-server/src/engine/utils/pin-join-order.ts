import { EntityManager } from 'typeorm';

/**
 * W6-E2E-06 — pins the join order of the REST of the current transaction to the order the SQL is written in
 * (`join_collapse_limit = 1`, transaction-local via `set_config(..., true)`, so it ends with the transaction and never
 * leaks to a pooled connection).
 *
 * Why: every workspace table is filtered by RLS predicates built on `current_setting('rab.…')`. The planner cannot see
 * those values, so it uses default selectivity and can estimate a handful of rows for each dimension table (venue,
 * staff_profile, job_role). With every input "tiny", a cartesian product of dimensions looks cheap: wave 6 lane E2E caught
 * the manager attendance list joining venue × staff_profile (8.5k rows) against shift by venue — 3.6 M intermediate rows
 * for 4.8 k attendance rows, 0.6–1.4 s per request — while the same query took 25 ms on another dataset of equal size.
 *
 * The list queries that call this are written fact-table first (`FROM attendance a JOIN shift s ON … JOIN venue v ON …`,
 * every join along a foreign key), so the pinned order always grows from the fact rows and never multiplies dimensions.
 * The planner still chooses scan and join METHODS (hash / nested loop / merge) and indexes. Same rows, same RLS, same
 * authorisation — only the plan changes. Call it inside the request's own transaction, right before the queries.
 */
export async function pinWrittenJoinOrder(manager: EntityManager): Promise<void> {
  await manager.query(`SELECT set_config('join_collapse_limit', '1', true)`);
}
