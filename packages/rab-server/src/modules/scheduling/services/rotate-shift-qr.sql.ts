import { EntityManager } from 'typeorm';

import { businessTables } from '../../../engine/core-modules/tenant/business-tables';

/**
 * The two statements of `SchedulingService.rotateShiftQr` (QR review M1), shared with the regression test that replays
 * them against a concurrently rendering pre-shift report, so the test exercises exactly what the service runs.
 *
 * 1. The lock (`rotateShiftQrLockSql`) takes the shift row FOR UPDATE first. The pre-shift report scheduler holds the same
 *    row FOR SHARE while it stamps the report, so a rotation that collides with it waits here until that commit. It also
 *    returns `not_ended` by the DATABASE clock (owner decision M2, 2026-11-15): a shift whose end has passed is refused
 *    (the report is no longer regenerated after the end, so a rotation would strand staff still inside the grace).
 * 2. The update (`rotateShiftQrUpdateSql`) is a compare-and-set on the (qr_version, status) the service read before the
 *    lock, and writes `updated_at = clock_timestamp()` — the time of the write, after any lock wait — never `now()` (the
 *    transaction's START time, which can be earlier than the report's generation stamp and would leave a revoked QR on a
 *    report the scheduler considers fresh).
 *
 * Part C2: the shift table is schema-qualified. The service takes it from its bound manager (the two functions below
 * declare `const t = businessTables(manager)`); the Worker regression test, which replays the statements on a raw admin
 * connection with no binder, passes the same `"<schema>"."shift"` name to `rotateShiftQrStatements`, so both run the same
 * SQL text.
 */

/** A quoted, schema-qualified shift table, as businessTables() names it: `"core"."shift"` or `"workspace_<32 hex>"."shift"`. */
const QUALIFIED_SHIFT_TABLE = /^"(?:core|workspace_[0-9a-f]{32})"\."shift"$/;

/**
 * TEST / REPLAY ONLY: the statement text for one qualified shift table, exported for the Worker lock-wait regression test
 * (it replays the service's exact SQL on a raw admin connection that no binder has bound). Module code must call
 * `rotateShiftQrLockSql(manager)` / `rotateShiftQrUpdateSql(manager)` instead, so the table always comes from the
 * transaction's own businessTables(manager). Refuses anything that is not a schema-qualified shift table name.
 */
export function rotateShiftQrStatements(shiftTable: string): { lock: string; update: string } {
  if (!QUALIFIED_SHIFT_TABLE.test(shiftTable)) throw new Error('rotateShiftQrStatements: not a schema-qualified shift table');
  // sql-injection-reviewed: the only interpolation is the schema-qualified shift table name validated above; values are bound $n parameters.
  const lock = `SELECT id, (ends_at > now()) AS not_ended FROM ${shiftTable} WHERE id = $1 FOR UPDATE`;
  // sql-injection-reviewed: the only interpolation is the schema-qualified shift table name validated above; values are bound $n parameters.
  const update = `UPDATE ${shiftTable} SET qr_version = qr_version + 1, updated_at = clock_timestamp()
          WHERE id = $1 AND qr_version = $2 AND status = $3 RETURNING qr_version`;
  return { lock, update };
}

/** Step 1, for the manager's bound business schema. */
export function rotateShiftQrLockSql(manager: EntityManager): string {
  const t = businessTables(manager);
  return rotateShiftQrStatements(t.shift).lock;
}

/** Step 2, for the manager's bound business schema. */
export function rotateShiftQrUpdateSql(manager: EntityManager): string {
  const t = businessTables(manager);
  return rotateShiftQrStatements(t.shift).update;
}
