import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../../engine/core-modules/permissions/permissions.service';
import { ResourceScope, ResourceScopeService } from '../../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../../engine/core-modules/tenant/auth-context.interface';
import { buildPayrollRunCsv, csvCell, RunView } from '../../../payroll/services/payroll-run.service';
import { FieldPolicyService } from '../field-policy.service';

/**
 * Wave 5 — layer-2 field policy for attendance / payroll read DTOs and exports. Pure unit tests: the permission lookup,
 * the caller's scope and the role_field_permission rows are stubbed; every DENIAL path is asserted.
 */
const ctx = { organisationId: 'org', workspaceId: 'ws', userId: 'u1', role: '' } as unknown as AuthContext;

function service(opts: { held: string[]; scope: ResourceScope; roles?: string[]; fieldRows?: Array<{ role_id: string; field_key: string; can_read: boolean }>; throwOn?: string }) {
  const permissions = {
    userHasPermissionTx: jest.fn(async (_m: unknown, _c: unknown, flag: string) => {
      if (opts.throwOn === flag) throw new Error('lookup failed');
      return opts.held.includes(flag);
    }),
  } as unknown as PermissionsService;
  const resourceScope = { resolveTx: jest.fn(async () => opts.scope) } as unknown as ResourceScopeService;
  const manager = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM core.user_role')) return (opts.roles ?? []).map((id) => ({ id }));
      if (sql.includes('FROM core.role_field_permission')) return opts.fieldRows ?? [];
      throw new Error(`unexpected SQL ${sql}`);
    }),
  } as unknown as EntityManager;
  return { svc: new FieldPolicyService(permissions, resourceScope), manager };
}

const OWNER: ResourceScope = { kind: 'owner', ownerUserId: 'u1', delegated: false };
const MEMBER: ResourceScope = { kind: 'owner', ownerUserId: 'owner', delegated: true };
const VENUE: ResourceScope = { kind: 'venue', venueIds: ['v1'] };

const summary = { id: 'a1', workedMinutes: 240, earnedPence: 4800, payrollApprovedPence: 4800, staffName: 'Ava Staff' };

describe('FieldPolicyService', () => {
  it('a payroll.view holder (owner scope) sees every field', async () => {
    const { svc, manager } = service({ held: [PermissionFlag.PAYROLL_VIEW], scope: OWNER });
    const policy = await svc.resolveTx(manager, ctx, 'attendance');
    expect(policy.hiddenFields.size).toBe(0);
    expect(svc.omit(policy, summary)).toEqual(summary);
  });

  it('without payroll.view, money properties are ABSENT (not null); worked time stays', async () => {
    const { svc, manager } = service({ held: [PermissionFlag.ATTENDANCE_VIEW], scope: OWNER });
    const policy = await svc.resolveTx(manager, ctx, 'attendance');
    expect(svc.isVisible(policy, 'earnings')).toBe(false);
    expect(svc.isVisible(policy, 'workedTime')).toBe(true);
    const out = svc.omit(policy, summary);
    expect(out).not.toHaveProperty('earnedPence');
    expect(out).not.toHaveProperty('payrollApprovedPence');
    expect(out).toMatchObject({ id: 'a1', workedMinutes: 240, staffName: 'Ava Staff' });
  });

  it('a Venue Manager never sees money, even if payroll.view were granted by mistake (venue scope)', async () => {
    const { svc, manager } = service({ held: [PermissionFlag.PAYROLL_VIEW, PermissionFlag.ATTENDANCE_VIEW], scope: VENUE });
    const policy = await svc.resolveTx(manager, ctx, 'attendance');
    expect(svc.isVisible(policy, 'earnings')).toBe(false);
    const payroll = await svc.resolveTx(manager, ctx, 'payroll_record');
    expect(svc.isVisible(payroll, 'amount')).toBe(false);
    expect(svc.isVisible(payroll, 'payRate')).toBe(false);
  });

  it('a custom workspace-member with no custom role sees no field at all (fail closed)', async () => {
    const { svc, manager } = service({ held: [PermissionFlag.PAYROLL_VIEW], scope: MEMBER, roles: [] });
    const policy = await svc.resolveTx(manager, ctx, 'attendance');
    expect([...policy.hiddenFields].sort()).toEqual(['earnings', 'workedTime']);
  });

  it('a member: every role must leave a field visible (role_field_permission deny on ONE role hides it); money defaults hidden', async () => {
    const { svc, manager } = service({
      held: [],
      scope: MEMBER,
      roles: ['r1', 'r2'],
      fieldRows: [{ role_id: 'r2', field_key: 'workedTime', can_read: false }],
    });
    const policy = await svc.resolveTx(manager, ctx, 'attendance');
    expect(svc.isVisible(policy, 'workedTime')).toBe(false);
    expect(svc.isVisible(policy, 'earnings')).toBe(false);
  });

  it('a member: an explicit visible rule on every role keeps a non-money field visible', async () => {
    const { svc, manager } = service({
      held: [],
      scope: MEMBER,
      roles: ['r1'],
      fieldRows: [{ role_id: 'r1', field_key: 'workedTime', can_read: true }],
    });
    expect(svc.isVisible(await svc.resolveTx(manager, ctx, 'attendance'), 'workedTime')).toBe(true);
  });

  it('a permission lookup that throws denies (the request fails, nothing is serialised)', async () => {
    const { svc, manager } = service({ held: [], scope: OWNER, throwOn: PermissionFlag.PAYROLL_VIEW });
    await expect(svc.resolveTx(manager, ctx, 'attendance')).rejects.toThrow('lookup failed');
  });

  it('an unknown object key is refused (fail closed, never "no policy")', async () => {
    const { svc, manager } = service({ held: [PermissionFlag.PAYROLL_VIEW], scope: OWNER });
    await expect(svc.resolveTx(manager, ctx, 'payslip' as never)).rejects.toThrow(/unknown object/);
  });
});

describe('payroll-run CSV export (field policy + formula injection)', () => {
  const view: RunView = {
    id: 'run', status: 'finalised', period: { id: 'p', start: '2026-10-01', end: '2026-10-31', payday: '2026-11-05' } as never,
    preparedAt: '', preparedByName: null, finalisedAt: null, finalisedByName: null,
    totals: { records: 1, staff: 1, minutes: 240, grossPence: 4800, lateCount: 0 },
    staff: [{ staffProfileId: 's', staffName: '=HYPERLINK("http://evil")', staffRef: 'STAFF 1', records: 1, minutes: 240, grossPence: 4800, lateCount: 0, payslip: null }],
  };
  const policy = (hidden: string[]) => ({ object: 'payroll_record' as const, hiddenFields: new Set(hidden), hiddenProperties: new Set<string>() });

  it('all columns for a caller whose policy hides nothing', () => {
    const [header, row] = buildPayrollRunCsv(view, policy([])).split('\n');
    expect(header).toBe('Staff reference,Staff name,Period start,Period end,Payday,Shifts,Hours,Gross (GBP),Late approvals,Run status');
    expect(row).toContain('4.00,48.00');
  });

  it('a hidden field is ABSENT from the header and every row (never an empty column)', () => {
    const csv = buildPayrollRunCsv(view, policy(['amount']));
    const [header, row] = csv.split('\n');
    expect(header).not.toContain('Gross');
    expect(header!.split(',')).toHaveLength(9);
    expect(row!.split(',')).toHaveLength(9);
    expect(csv).not.toContain('48.00');
    const noHours = buildPayrollRunCsv(view, policy(['amount', 'workedTime']));
    expect(noHours).not.toContain('Hours');
    expect(noHours).not.toContain('4.00');
  });

  it('neutralises spreadsheet formula injection in names (=, +, -, @, tab, CR) and still quotes', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('Ava, Staff')).toBe('"Ava, Staff"');
    expect(csvCell('Plain')).toBe('Plain');
    expect(buildPayrollRunCsv(view, policy([])).split('\n')[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});
