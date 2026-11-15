import { ConflictException } from '@nestjs/common';

import { bindBusinessSchema, unbindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { SchedulingService } from './scheduling.service';
import { rotateShiftQrStatements } from './rotate-shift-qr.sql';

/** The statements rotateShiftQr builds for a manager bound to the core business schema. */
const { lock: LOCK_SQL, update: UPDATE_SQL } = rotateShiftQrStatements('"core"."shift"');

/**
 * QR review M2 fail-closed (owner decision 2026-11-15): rotateShiftQr refuses SHIFT_ENDED unless the locked row says
 * not_ended === true. A missing row ([]) or an unreadable end (not_ended: null) must refuse, never fall through to the
 * compare-and-set or the audit. Unit level: only the collaborators rotateShiftQr uses, everything else absent.
 */
describe('SchedulingService.rotateShiftQr — M2 fails closed', () => {
  const ctx = { organisationId: 'org-1', workspaceId: 'ws-1', userId: 'owner-1', role: '' };
  const shift = { id: 'shift-1', createdBy: 'owner-1', venueId: 'venue-1', status: 'open', qrVersion: 1 };

  const bound: object[] = [];
  afterEach(() => {
    for (const m of bound.splice(0)) unbindBusinessSchema(m as never);
  });

  function serviceWithLockResult(lockRows: unknown[]) {
    const queries: string[] = [];
    const manager = {
      // A live (fake) transaction, bound to core as a binder would bind it (C2 businessTables(manager)).
      queryRunner: { isReleased: false, isTransactionActive: true },
      findOne: jest.fn(async () => ({ ...shift })),
      findOneByOrFail: jest.fn(async () => ({ ...shift })),
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql === LOCK_SQL) return lockRows;
        if (sql === UPDATE_SQL) return [[{ qr_version: 2 }], 1];
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    bindBusinessSchema(manager as never, 'core', null);
    bound.push(manager);
    const audit = { record: jest.fn() };
    const service = Object.create(SchedulingService.prototype) as SchedulingService;
    Object.assign(service, {
      permissions: { userHasPermissionTx: jest.fn(async () => true) },
      resourceScope: { resolveTx: jest.fn(async () => ({ kind: 'owner', ownerUserId: 'owner-1', delegated: false })) },
      tenantContext: { runInWorkspaceContext: jest.fn(async (_ctx: unknown, fn: (m: unknown) => unknown) => fn(manager)) },
      auditService: audit,
    });
    return { service, queries, audit };
  }

  it.each([
    ['no locked row ([])', []],
    ['an unreadable end ([{ not_ended: null }])', [{ id: 'shift-1', not_ended: null }]],
    ['an ended shift ([{ not_ended: false }])', [{ id: 'shift-1', not_ended: false }]],
  ])('%s → 409 SHIFT_ENDED, no compare-and-set, no audit', async (_label, lockRows) => {
    const { service, queries, audit } = serviceWithLockResult(lockRows);
    const refusal = service.rotateShiftQr(ctx, shift.id);
    await expect(refusal).rejects.toBeInstanceOf(ConflictException);
    await expect(refusal).rejects.toMatchObject({ response: { code: 'SHIFT_ENDED' } });
    expect(queries).toEqual([LOCK_SQL]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('control: not_ended === true proceeds to the compare-and-set and the audit', async () => {
    const { service, queries, audit } = serviceWithLockResult([{ id: 'shift-1', not_ended: true }]);
    await service.rotateShiftQr(ctx, shift.id);
    expect(queries).toEqual([LOCK_SQL, UPDATE_SQL]);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
