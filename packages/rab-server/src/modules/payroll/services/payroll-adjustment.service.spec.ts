import { InvalidTransitionError, PermissionFlag } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { bindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { adjustmentTotals, PAYROLL_ADJUSTMENT_APPROVE_STEP_UP, PayrollAdjustmentService } from './payroll-adjustment.service';

/**
 * Layer 2 of owner decision 3, without a database: every refusal happens in the SERVICE (a job, command or other service
 * calling it directly gets the same answer as the route), before any write. The database layers (RLS, CHECKs, the guard
 * trigger) are proven in payroll-adjustments.integration.spec.ts.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000b1';
const ME = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const STAFF_USER = '00000000-0000-4000-8000-0000000000c3';
const STAFF = '00000000-0000-4000-8000-0000000000d1';
const RECORD = '00000000-0000-4000-8000-0000000000e1';
const ADJ = '00000000-0000-4000-8000-0000000000f1';
const ctx = { organisationId: ORG, workspaceId: WS, userId: ME, role: '' } as AuthContext;

type Responder = (sql: string, params: unknown[]) => unknown;

function harness(opts: { held?: string[]; venue?: boolean; respond?: Responder; stepUpRefused?: boolean } = {}) {
  const queries: string[] = [];
  const manager = {
    queryRunner: { isReleased: false, isTransactionActive: true },
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/^INSERT INTO core\.payroll_adjustment/.test(sql.trim())) return [{ id: ADJ }];
      if (/^\s*UPDATE core\.payroll_adjustment/.test(sql)) return [[], 1];
      return (opts.respond?.(sql, params) as unknown[]) ?? [];
    }),
  } as unknown as EntityManager;
  bindBusinessSchema(manager, 'core', WS);
  const held = new Set(opts.held ?? [PermissionFlag.PAYROLL_VIEW, PermissionFlag.PAYROLL_CALCULATE, PermissionFlag.PAYROLL_APPROVE]);
  const tenantContext = { runInWorkspaceContext: jest.fn(async (_c: AuthContext, fn: (m: EntityManager) => unknown) => fn(manager)) };
  const permissions = { userHasPermissionTx: jest.fn(async (_m: unknown, _c: unknown, flag: string) => held.has(flag)) };
  const resourceScope = { assertHasWorkspace: jest.fn(), resolveTx: jest.fn(async () => (opts.venue ? { kind: 'venue', venueIds: [] } : { kind: 'owner', ownerUserId: ME, delegated: false })) };
  const audit = { record: jest.fn() };
  const stepUp = {
    assertRecentStepUp: jest.fn(async () => {
      if (opts.stepUpRefused) throw new ForbiddenException({ code: 'STEP_UP_REQUIRED' });
    }),
  };
  const svc = new PayrollAdjustmentService(tenantContext as never, permissions as never, resourceScope as never, audit as never, stepUp as never);
  // Property-injected in Nest; here a policy that hides nothing (the deep omit itself is tested in field-policy.service.spec).
  Object.assign(svc, { fieldPolicy: { resolveTx: async () => ({ object: 'payroll_record', hiddenFields: new Set(), hiddenProperties: new Set() }), omitDeep: (_p: unknown, v: unknown) => v } });
  const writes = () => queries.filter((q) => /^(INSERT|UPDATE) /.test(q));
  return { svc, manager, queries, writes, audit, stepUp };
}

const adjustmentRow = (over: Record<string, unknown> = {}) => ({
  id: ADJ, kind: 'bonus', status: 'pending_approval', staff_profile_id: STAFF, staff_user_id: STAFF_USER, amount_pence: '2500',
  reason: 'Covered a late shift', corrects_payroll_record_id: null, created_by: OTHER, created_at: new Date(), decided_at: null,
  rejection_reason: null, run_id: null, locked_at: null, ...over,
});

/** Answers the adjustment SELECT with `row`; everything else empty. */
const withAdjustment = (row: Record<string, unknown>): Responder => (sql) => (/FROM core\.payroll_adjustment a WHERE a\.id = \$1/.test(sql) ? [row] : []);

describe('PayrollAdjustmentService: who may add', () => {
  it('without payroll.calculate: 403 before any read or write', async () => {
    const h = harness({ held: [PermissionFlag.PAYROLL_VIEW] });
    await expect(h.svc.addBonus(ctx, { staffProfileId: STAFF, amountPence: 100, reason: 'Bonus' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.queries).toEqual([]);
  });

  it('a Venue Manager is refused even when holding the flag', async () => {
    const h = harness({ venue: true });
    await expect(h.svc.addExpense(ctx, { staffProfileId: STAFF, amountPence: 100, reason: 'Taxi' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.writes()).toEqual([]);
  });

  it('a staff member outside the caller workspace is a 404 (no disclosure), nothing written', async () => {
    const h = harness();
    await expect(h.svc.addBonus(ctx, { staffProfileId: STAFF, amountPence: 100, reason: 'Bonus' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.queries.some((q) => q.includes('sp.organisation_id = $2 AND sp.workspace_id = $3'))).toBe(true);
    expect(h.writes()).toEqual([]);
  });

  it('nobody adds a bonus or expense to their OWN pay', async () => {
    const h = harness({ respond: (sql) => (/staff_profile\S* sp WHERE sp\.id/.test(sql) ? [{ id: STAFF, user_id: ME }] : []) });
    await expect(h.svc.addBonus(ctx, { staffProfileId: STAFF, amountPence: 100, reason: 'Bonus' })).rejects.toMatchObject({ response: { code: 'PAYROLL_ADJUSTMENT_OWN_PAY' } });
    expect(h.writes()).toEqual([]);
  });

  it('a zero or negative bonus is refused by the service itself (direct callers skip the DTO)', async () => {
    for (const amountPence of [0, -1, 1.5]) {
      const h = harness();
      await expect(h.svc.addBonus(ctx, { staffProfileId: STAFF, amountPence, reason: 'Bonus' })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.writes()).toEqual([]);
    }
  });

  it('a valid bonus: INSERT with the session org, workspace, creator and the staff user id read from the database; audited', async () => {
    const h = harness({
      respond: (sql) => {
        if (/staff_profile\S* sp WHERE sp\.id/.test(sql)) return [{ id: STAFF, user_id: STAFF_USER }];
        if (/a\.id = ANY/.test(sql)) return [adjustmentRow({ created_by: ME })];
        return [];
      },
    });
    await h.svc.addBonus(ctx, { staffProfileId: STAFF, amountPence: 2500, reason: 'Covered a late shift' });
    const insert = (h.manager.query as jest.Mock).mock.calls.find(([sql]) => /^\s*INSERT INTO core\.payroll_adjustment/.test(sql));
    expect(insert![1]).toEqual([ORG, WS, STAFF, STAFF_USER, 'bonus', 2500, 'Covered a late shift', null, ME]);
    expect(h.audit.record).toHaveBeenCalledWith(h.manager, ctx, 'payroll_adjustment.created', expect.objectContaining({ entityId: ADJ, targetUserId: STAFF_USER }));
  });
});

describe('PayrollAdjustmentService: corrections', () => {
  const record = (over: Record<string, unknown> = {}) => ({ id: RECORD, status: 'approved', staff_profile_id: STAFF, amount_pence: '4800', staff_user_id: STAFF_USER, ...over });
  const respond = (rec: Record<string, unknown> | null, taken = '0'): Responder => (sql) => {
    if (/payroll_record\S* pr JOIN/.test(sql)) return rec ? [rec] : [];
    if (/AS taken/.test(sql)) return [{ taken }];
    if (/a\.id = ANY/.test(sql)) return [adjustmentRow({ kind: 'correction', created_by: ME })];
    return [];
  };

  it('a record of another workspace is a 404', async () => {
    const h = harness({ respond: respond(null) });
    await expect(h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: 100, reason: 'Missed 10 minutes' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.writes()).toEqual([]);
  });

  it('only approved pay can be corrected (pending, rejected, draft refused with 409)', async () => {
    for (const status of ['pending_approval', 'rejected', 'draft']) {
      const h = harness({ respond: respond(record({ status })) });
      await expect(h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: 100, reason: 'Missed 10 minutes' })).rejects.toBeInstanceOf(ConflictException);
      expect(h.writes()).toEqual([]);
    }
  });

  it('a correction of the caller\'s own hours is refused', async () => {
    const h = harness({ respond: respond(record({ staff_user_id: ME })) });
    await expect(h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: -100, reason: 'Overpaid' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.writes()).toEqual([]);
  });

  it('a reduction can never exceed what the original shift paid (pending and approved reductions counted together)', async () => {
    const h = harness({ respond: respond(record(), '-4000') });
    await expect(h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: -801, reason: 'Overpaid' })).rejects.toMatchObject({ response: { code: 'PAYROLL_CORRECTION_EXCEEDS_ORIGINAL' } });
    expect(h.writes()).toEqual([]);
    const ok = harness({ respond: respond(record(), '-4000') });
    await ok.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: -800, reason: 'Overpaid' });
    expect(ok.writes()).toHaveLength(1);
  });

  it('a zero correction is refused', async () => {
    const h = harness({ respond: respond(record()) });
    await expect(h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: 0, reason: 'Nothing' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the staff member comes from the original record, never the caller', async () => {
    const h = harness({ respond: respond(record()) });
    await h.svc.addCorrection(ctx, { payrollRecordId: RECORD, amountPence: 150, reason: 'Missed 10 minutes' });
    const insert = (h.manager.query as jest.Mock).mock.calls.find(([sql]) => /^\s*INSERT INTO core\.payroll_adjustment/.test(sql));
    expect(insert![1]).toEqual([ORG, WS, STAFF, STAFF_USER, 'correction', 150, 'Missed 10 minutes', RECORD, ME]);
  });
});

describe('PayrollAdjustmentService: approve and reject (decision 5 rule)', () => {
  it('without payroll.approve: 403, nothing written', async () => {
    const h = harness({ held: [PermissionFlag.PAYROLL_VIEW, PermissionFlag.PAYROLL_CALCULATE], respond: withAdjustment(adjustmentRow()) });
    await expect(h.svc.approve(ctx, ADJ)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.svc.reject(ctx, ADJ, 'No')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.writes()).toEqual([]);
  });

  it('the creator can never approve or reject their own adjustment', async () => {
    const h = harness({ respond: withAdjustment(adjustmentRow({ created_by: ME })) });
    await expect(h.svc.approve(ctx, ADJ)).rejects.toMatchObject({ response: { code: 'PAYROLL_ADJUSTMENT_SAME_PERSON' } });
    await expect(h.svc.reject(ctx, ADJ, 'No')).rejects.toMatchObject({ response: { code: 'PAYROLL_ADJUSTMENT_SAME_PERSON' } });
    expect(h.writes()).toEqual([]);
  });

  it('the paid staff member can never approve or reject their own adjustment', async () => {
    const h = harness({ respond: withAdjustment(adjustmentRow({ staff_user_id: ME })) });
    await expect(h.svc.approve(ctx, ADJ)).rejects.toMatchObject({ response: { code: 'PAYROLL_ADJUSTMENT_OWN_PAY' } });
    await expect(h.svc.reject(ctx, ADJ, 'No')).rejects.toMatchObject({ response: { code: 'PAYROLL_ADJUSTMENT_OWN_PAY' } });
    expect(h.writes()).toEqual([]);
  });

  it('an unknown or other-workspace id is a 404', async () => {
    const h = harness();
    await expect(h.svc.approve(ctx, ADJ)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.svc.reject(ctx, ADJ, 'No')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an already decided adjustment cannot be decided again (409, state machine)', async () => {
    for (const status of ['approved', 'rejected']) {
      const h = harness({ respond: withAdjustment(adjustmentRow({ status })) });
      await expect(h.svc.approve(ctx, ADJ)).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(h.svc.reject(ctx, ADJ, 'No')).rejects.toBeInstanceOf(InvalidTransitionError);
      expect(h.writes()).toEqual([]);
    }
  });

  it('approve needs a recent step-up of this session, checked before any read: refused => nothing read or written', async () => {
    const h = harness({ stepUpRefused: true, respond: withAdjustment(adjustmentRow()) });
    await expect(h.svc.approve(ctx, ADJ)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    expect(h.stepUp.assertRecentStepUp).toHaveBeenCalledWith(ctx, PAYROLL_ADJUSTMENT_APPROVE_STEP_UP);
    expect(h.queries).toEqual([]);
  });

  it('a second person with a fresh step-up approves: one UPDATE naming the session user, audited', async () => {
    const h = harness({ respond: (sql) => (/a\.id = \$1|a\.id = ANY/.test(sql) ? [adjustmentRow()] : []) });
    await h.svc.approve(ctx, ADJ);
    expect(h.writes()).toHaveLength(1);
    const update = (h.manager.query as jest.Mock).mock.calls.find(([sql]) => /^\s*UPDATE core\.payroll_adjustment/.test(sql));
    expect(update![0]).toMatch(/SET status = 'approved', decided_by = \$2/);
    expect(update![1]).toEqual([ADJ, ME]);
    expect(h.audit.record).toHaveBeenCalledWith(h.manager, ctx, 'payroll_adjustment.approved', expect.objectContaining({ entityId: ADJ }));
  });

  it('reject records the reason; no step-up (no money moves)', async () => {
    const h = harness({ respond: (sql) => (/a\.id = \$1|a\.id = ANY/.test(sql) ? [adjustmentRow()] : []) });
    await h.svc.reject(ctx, ADJ, 'Duplicate of last week');
    expect(h.stepUp.assertRecentStepUp).not.toHaveBeenCalled();
    const update = (h.manager.query as jest.Mock).mock.calls.find(([sql]) => /^\s*UPDATE core\.payroll_adjustment/.test(sql));
    expect(update![1]).toEqual([ADJ, ME, 'Duplicate of last week']);
  });
});

describe('adjustmentTotals', () => {
  it('sums per kind in integer pence; corrections may be negative', () => {
    expect(adjustmentTotals([
      { kind: 'correction', amountPence: -150 },
      { kind: 'correction', amountPence: 300 },
      { kind: 'bonus', amountPence: 2000 },
      { kind: 'expense', amountPence: 1234 },
    ])).toEqual({ correctionsPence: 150, bonusesPence: 2000, expensesPence: 1234, adjustmentsPence: 3384 });
    expect(adjustmentTotals([])).toEqual({ correctionsPence: 0, bonusesPence: 0, expensesPence: 0, adjustmentsPence: 0 });
  });

  it('refuses an unknown kind and a non-integer amount (fail closed)', () => {
    expect(() => adjustmentTotals([{ kind: 'deduction' as never, amountPence: -100 }])).toThrow(RangeError);
    expect(() => adjustmentTotals([{ kind: 'bonus', amountPence: 1.5 }])).toThrow(RangeError);
  });
});
