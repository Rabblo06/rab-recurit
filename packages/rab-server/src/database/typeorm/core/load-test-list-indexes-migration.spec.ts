import { QueryRunner } from 'typeorm';

import { LoadTestListIndexes1786722700000 } from './migrations/1786722700000-LoadTestListIndexes';

/**
 * LoadTestListIndexes1786722700000 builds its indexes CONCURRENTLY only. Inside a forced transaction (a CLI run with
 * `-t all`) a plain CREATE INDEX would hold a SHARE lock on core.attendance for the whole build and block every clock-in /
 * clock-out, so up() must refuse there before it sends a single statement; down() keeps the plain DROP for
 * migration:revert. Unit test with a recording QueryRunner (no database).
 */
function runner(isTransactionActive: boolean, indexState: 'ABSENT' | 'VALID' = 'ABSENT') {
  const sql: string[] = [];
  const built = new Set<string>();
  const query = jest.fn(async (text: string, params: unknown[] = []) => {
    sql.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('pg_has_role')) return [{ ok: true }];
    if (text.includes('FROM pg_index')) return indexState === 'VALID' || built.has(String(params[0])) ? [{ valid: true, ready: true }] : [];
    const created = /^CREATE INDEX (?:CONCURRENTLY )?IF NOT EXISTS (\w+)/.exec(text);
    if (created) built.add(created[1]!);
    return [];
  });
  return { qr: { isTransactionActive, query } as unknown as QueryRunner, sql };
}

describe('LoadTestListIndexes1786722700000', () => {
  const migration = new LoadTestListIndexes1786722700000();

  it('is a transaction = false migration', () => {
    expect(migration.transaction).toBe(false);
  });

  it('up() refuses inside a transaction and sends no statement (no plain CREATE INDEX on core.attendance)', async () => {
    const { qr, sql } = runner(true);
    await expect(migration.up(qr)).rejects.toThrow(/must run outside a transaction/);
    expect(sql).toEqual([]);
  });

  it('up() outside a transaction builds both indexes CONCURRENTLY and never in the locking form', async () => {
    const { qr, sql } = runner(false);
    await migration.up(qr);
    const creates = sql.filter((s) => s.startsWith('CREATE INDEX'));
    expect(creates).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS attendance_workspace_clock_in_idx ON core.attendance (workspace_id, clock_in_at DESC, id DESC)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS email_outbox_attachment_file_idx ON core.email_outbox (attachment_file_id) WHERE attachment_file_id IS NOT NULL',
    ]);
    expect(sql.some((s) => /^CREATE INDEX (?!CONCURRENTLY)/.test(s))).toBe(false);
    expect(sql).toContain("SET lock_timeout = '60s'");
    expect(sql[sql.length - 1]).toBe('RESET lock_timeout');
  });

  it('down() inside a forced transaction (migration:revert) drops with the plain form; outside, CONCURRENTLY', async () => {
    const inTx = runner(true, 'VALID');
    await migration.down(inTx.qr);
    expect(inTx.sql.filter((s) => s.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX IF EXISTS core.email_outbox_attachment_file_idx',
      'DROP INDEX IF EXISTS core.attendance_workspace_clock_in_idx',
    ]);
    const outside = runner(false, 'VALID');
    await migration.down(outside.qr);
    expect(outside.sql.filter((s) => s.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS core.email_outbox_attachment_file_idx',
      'DROP INDEX CONCURRENTLY IF EXISTS core.attendance_workspace_clock_in_idx',
    ]);
  });
});
