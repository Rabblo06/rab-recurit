import { PermissionFlag } from '@rab/shared';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { bindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { HOLIDAY_PAY_UPDATE_STEP_UP, HolidayPayService } from './holiday-pay.service';

/**
 * Layer 2 of owner decision 4 without a database: who may change the holiday pay setting, the default, and the snapshot
 * maths written at approval. RLS, the insert-only grants and the rounding CHECK are proven in
 * payroll-holiday-pay.integration.spec.ts.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-0000000000c1';
const STAFF_USER = '00000000-0000-4000-8000-0000000000c3';
const ctx = { organisationId: ORG, workspaceId: WS, userId: ME, role: '' } as AuthContext;

function harness(opts: { held?: string[]; venue?: boolean; initial?: boolean; setting?: Record<string, unknown> | null; records?: Array<Record<string, unknown>>; stepUpRefused?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    queryRunner: { isReleased: false, isTransactionActive: true },
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM core\.manager_profile WHERE user_id/.test(sql)) return opts.initial ? [{ '?column?': 1 }] : [];
      if (/FROM core\.organisation_payroll_setting s WHERE/.test(sql)) return opts.setting ? [opts.setting] : [];
      if (/payroll_record\S* pr JOIN/.test(sql)) return opts.records ?? [];
      return [];
    }),
  } as unknown as EntityManager;
  bindBusinessSchema(manager, 'core', WS);
  const held = new Set(opts.held ?? [PermissionFlag.PAYROLL_VIEW, PermissionFlag.PAYROLL_CALCULATE]);
  const run = jest.fn(async (_c: AuthContext, fn: (m: EntityManager) => unknown) => fn(manager));
  const tenantContext = { runInTenantContext: run, runInWorkspaceContext: run };
  const permissions = { userHasPermissionTx: jest.fn(async (_m: unknown, _c: unknown, flag: string) => held.has(flag)) };
  const resourceScope = { resolveTx: jest.fn(async () => (opts.venue ? { kind: 'venue', venueIds: [] } : { kind: 'owner', ownerUserId: ME, delegated: false })) };
  const audit = { record: jest.fn() };
  const stepUp = { assertRecentStepUp: jest.fn(async () => { if (opts.stepUpRefused) throw new ForbiddenException({ code: 'STEP_UP_REQUIRED' }); }) };
  const svc = new HolidayPayService(tenantContext as never, permissions as never, resourceScope as never, audit as never, stepUp as never);
  const writes = () => calls.filter((c) => /^INSERT /.test(c.sql));
  return { svc, manager, calls, writes, audit, stepUp };
}

describe('HolidayPayService: the organisation setting', () => {
  it('no stored row = the A3 default, rolled-up at 12.07% (1207 basis points)', async () => {
    const h = harness();
    await expect(h.svc.getSetting(ctx)).resolves.toMatchObject({ mode: 'rolled_up', rateBps: 1207, isDefault: true, canManage: false });
  });

  it('reading needs payroll.view and is refused to a Venue Manager', async () => {
    await expect(harness({ held: [] }).svc.getSetting(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(harness({ venue: true }).svc.getSetting(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('changing it needs a recent step-up FIRST (before any read), then payroll.calculate and the CURRENT Initial Manager', async () => {
    const stale = harness({ initial: true, stepUpRefused: true });
    await expect(stale.svc.useProvider(ctx)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    expect(stale.stepUp.assertRecentStepUp).toHaveBeenCalledWith(ctx, HOLIDAY_PAY_UPDATE_STEP_UP);
    expect(stale.calls).toEqual([]);
    const notInitial = harness({ initial: false });
    await expect(notInitial.svc.useRolledUpRate(ctx, 1207)).rejects.toBeInstanceOf(ForbiddenException);
    expect(notInitial.writes()).toEqual([]);
    const noFlag = harness({ initial: true, held: [PermissionFlag.PAYROLL_VIEW] });
    await expect(noFlag.svc.useProvider(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(noFlag.writes()).toEqual([]);
    const venue = harness({ initial: true, venue: true });
    await expect(venue.svc.useProvider(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a rate outside 1..10000 basis points or not a whole number is refused before anything else', async () => {
    for (const bad of [0, -1, 10001, 12.07]) {
      const h = harness({ initial: true });
      await expect(h.svc.useRolledUpRate(ctx, bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(h.calls).toEqual([]);
    }
  });

  it('the Initial Manager sets "provider handles it": one upsert naming them, audited with before/after', async () => {
    const h = harness({ initial: true });
    await h.svc.useProvider(ctx);
    const upsert = h.writes()[0]!;
    expect(upsert.sql).toMatch(/^INSERT INTO core\.organisation_payroll_setting .* ON CONFLICT \(organisation_id\) DO UPDATE/);
    expect(upsert.params).toEqual([ORG, 'provider', null, ME]);
    expect(h.audit.record).toHaveBeenCalledWith(h.manager, ctx, 'payroll_setting.holiday_pay_changed', expect.objectContaining({
      metadata: { before: { mode: 'rolled_up', rateBps: 1207, isDefault: true }, after: { mode: 'provider', rateBps: null } },
    }));
  });
});

describe('HolidayPayService.snapshotRecords (at approval, same transaction)', () => {
  const rec = (id: string, amount: string) => ({ id, staff_profile_id: 'sp-' + id, amount_pence: amount, staff_user_id: STAFF_USER });

  it('freezes each record at the CURRENT setting: rolled-up 12.07%, nearest penny half up, per record', async () => {
    const h = harness({ records: [rec('r1', '6000'), rec('r2', '4142'), rec('r3', '0')] });
    expect(await h.svc.snapshotRecords(h.manager, ctx, ['r1', 'r2', 'r3'])).toBe(3);
    const inserts = h.writes().map((w) => w.params);
    expect(inserts.map((p) => [p[2], p[5], p[6], p[7], p[8]])).toEqual([
      ['r1', 'rolled_up', 1207, 6000, 724],
      ['r2', 'rolled_up', 1207, 4142, 500],
      ['r3', 'rolled_up', 1207, 0, 0],
    ]);
    for (const p of inserts) expect([p[0], p[1], p[4], p[9]]).toEqual([ORG, WS, STAFF_USER, ME]);
    expect(h.writes()[0]!.sql).toMatch(/ON CONFLICT \(payroll_record_id\) DO NOTHING$/);
  });

  it('a configured rate is used as stored; "provider handles it" freezes a zero line with no rate', async () => {
    const rate = harness({ setting: { holiday_pay_mode: 'rolled_up', holiday_pay_rate_bps: 1250, updated_at: new Date(), updated_by_name: 'X' }, records: [rec('r1', '4')] });
    await rate.svc.snapshotRecords(rate.manager, ctx, ['r1']);
    expect(rate.writes()[0]!.params.slice(5, 9)).toEqual(['rolled_up', 1250, 4, 1]);
    const provider = harness({ setting: { holiday_pay_mode: 'provider', holiday_pay_rate_bps: null, updated_at: new Date(), updated_by_name: 'X' }, records: [rec('r1', '6000')] });
    await provider.svc.snapshotRecords(provider.manager, ctx, ['r1']);
    expect(provider.writes()[0]!.params.slice(5, 9)).toEqual(['provider', null, 6000, 0]);
  });

  it('reads only approved records of the session workspace that have no snapshot yet; nothing to do = no query', async () => {
    const h = harness({ records: [] });
    expect(await h.svc.snapshotRecords(h.manager, ctx, [])).toBe(0);
    expect(h.calls).toEqual([]);
    await h.svc.snapshotRecords(h.manager, ctx, ['r1']);
    const select = h.calls.find((c) => /pr JOIN/.test(c.sql))!;
    expect(select.sql).toContain("pr.organisation_id = $2 AND pr.workspace_id = $3 AND pr.status IN ('approved', 'processing', 'paid')");
    expect(select.sql).toContain('NOT EXISTS (SELECT 1 FROM core.payroll_record_holiday_pay h WHERE h.payroll_record_id = pr.id)');
    expect(h.writes()).toEqual([]);
  });

  it('a corrupt (unsafe) base fails closed instead of freezing a rounded figure', async () => {
    const h = harness({ records: [rec('r1', '9007199254740993')] });
    await expect(h.svc.snapshotRecords(h.manager, ctx, ['r1'])).rejects.toThrow(RangeError);
    expect(h.writes()).toEqual([]);
  });
});
