import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntityManager } from 'typeorm';

import { bindBusinessSchema, unbindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { workspaceSchemaName } from '../../../database/typeorm/workspace-schema/provision-workspace-schema';
import { rotateShiftQrLockSql, rotateShiftQrStatements, rotateShiftQrUpdateSql } from './rotate-shift-qr.sql';

/**
 * QR review M1 source pin: rotateShiftQr must lock the row first and stamp updated_at with clock_timestamp() (the write
 * time, after any lock wait), never now() (its transaction's start, which can precede the pre-shift report's stamp and
 * leave a revoked QR on a report the scheduler considers fresh). The behaviour itself is pinned by the lock-wait test in
 * rab-worker report-worker-concurrency.integration.spec.ts, which replays these exact statements.
 */
const WS = 'deadbeef-dead-beef-dead-beefdeadbeef';
const SCHEMA = workspaceSchemaName(WS);
const SHIFT = `"${SCHEMA}"."shift"`;

/** A manager whose (fake) transaction is live, as a binder hands it out (test-only binding). */
function boundManager(schema: string, workspaceId: string | null): EntityManager {
  const m = { queryRunner: { isReleased: false, isTransactionActive: true } } as unknown as EntityManager;
  bindBusinessSchema(m, schema, workspaceId);
  return m;
}

describe('rotateShiftQr SQL (QR review M1)', () => {
  const { lock, update } = rotateShiftQrStatements(SHIFT);

  it('the update stamps updated_at with clock_timestamp(), never now()', () => {
    expect(update).toMatch(/updated_at\s*=\s*clock_timestamp\(\)/);
    expect(update).not.toMatch(/\bnow\(\)|current_timestamp|transaction_timestamp|statement_timestamp/i);
    expect(update).toMatch(/qr_version = qr_version \+ 1/);
    expect(update).toMatch(/WHERE id = \$1 AND qr_version = \$2 AND status = \$3/);
  });

  it('the lock is a FOR UPDATE row lock on the (schema-qualified) shift and reads not_ended by the database clock (M2)', () => {
    expect(lock).toBe(`SELECT id, (ends_at > now()) AS not_ended FROM ${SHIFT} WHERE id = $1 FOR UPDATE`);
    expect(update.startsWith(`UPDATE ${SHIFT} SET `)).toBe(true);
  });

  it('the bound manager variants are the same text, for the workspace schema and for core', () => {
    const ws = boundManager(SCHEMA, WS);
    const core = boundManager('core', null);
    try {
      expect(rotateShiftQrLockSql(ws)).toBe(lock);
      expect(rotateShiftQrUpdateSql(ws)).toBe(update);
      expect(rotateShiftQrLockSql(core)).toBe(rotateShiftQrStatements('"core"."shift"').lock);
      expect(rotateShiftQrUpdateSql(core)).toBe(rotateShiftQrStatements('"core"."shift"').update);
    } finally {
      unbindBusinessSchema(ws);
      unbindBusinessSchema(core);
    }
  });

  it('fails closed: an unbound manager, or a name that is not a qualified shift table, is refused', () => {
    const unbound = { queryRunner: { isReleased: false, isTransactionActive: true } } as unknown as EntityManager;
    expect(() => rotateShiftQrLockSql(unbound)).toThrow();
    expect(() => rotateShiftQrUpdateSql(unbound)).toThrow();
    for (const bad of ['shift', '"core"."attendance"', 'core.shift', `"${SCHEMA}".shift`, `"public"."shift"`, `"${SCHEMA}"."shift"; DROP TABLE x`]) {
      expect(() => rotateShiftQrStatements(bad)).toThrow('not a schema-qualified shift table');
    }
  });

  it('SchedulingService runs the lock, then the update, from these builders with its bound manager (no inline copy)', () => {
    const source = readFileSync(join(__dirname, 'scheduling.service.ts'), 'utf8');
    const lockAt = source.indexOf('manager.query(rotateShiftQrLockSql(manager)');
    const updateAt = source.indexOf('manager.query(rotateShiftQrUpdateSql(manager)');
    expect(lockAt).toBeGreaterThan(0);
    expect(updateAt).toBeGreaterThan(lockAt);
    expect(source).not.toMatch(/qr_version = qr_version \+ 1/);
  });
});
