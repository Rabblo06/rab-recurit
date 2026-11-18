import { PermissionFlag } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../core-modules/permissions/permissions.service';
import { AuthContext } from '../../core-modules/tenant/auth-context.interface';
import { DataModelErrorCode, DataModelPermissionDeniedException, ObjectSystemLockedException } from '../exceptions/data-model.exceptions';
import { DATA_MODEL_LOCKED_TABLES, DataModelAuthorityService } from '../services/data-model-authority.service';
import { NO_CUSTOM_FIELD_TABLES, PAYROLL_ATTENDANCE_SYSTEM_TABLES } from '../standard-objects/standard-object-plan';

/**
 * M2 phase 1, layer 2 (DataModelAuthorityService). Abuse cases, one per denial (CLAUDE.md testing floor). The database half
 * (the flag really comes from role grants / overrides under RLS, and the defaults are exactly ceo + manager) is
 * data-model-permission.integration.spec.ts.
 */
describe('DataModelAuthorityService (M2 phase 1, layer 2)', () => {
  const manager = {} as EntityManager;
  const ctx: AuthContext = {
    organisationId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    role: 'manager',
  };
  const build = (result: boolean | Error) => {
    const userHasPermissionTx = jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const service = new DataModelAuthorityService({ userHasPermissionTx } as unknown as PermissionsService);
    return { service, userHasPermissionTx };
  };

  it('allows a caller who holds data_model.manage, re-read in the caller transaction (never from the JWT)', async () => {
    const { service, userHasPermissionTx } = build(true);
    await expect(service.assertCanManageDataModelTx(manager, ctx)).resolves.toBeUndefined();
    expect(userHasPermissionTx).toHaveBeenCalledTimes(1);
    expect(userHasPermissionTx).toHaveBeenCalledWith(manager, ctx, PermissionFlag.DATA_MODEL_MANAGE);
    expect(PermissionFlag.DATA_MODEL_MANAGE).toBe('data_model.manage');
  });

  it('ABUSE DM-1: a caller without data_model.manage (venue manager, staff, a revoke override) gets 403 PERMISSION_DENIED', async () => {
    const { service } = build(false);
    const error = await service.assertCanManageDataModelTx(manager, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataModelPermissionDeniedException);
    expect((error as DataModelPermissionDeniedException).getStatus()).toBe(403);
    expect((error as DataModelPermissionDeniedException).getResponse()).toMatchObject({ code: DataModelErrorCode.PERMISSION_DENIED });
  });

  it('ABUSE DM-2: a permission lookup that throws refuses the write (fail closed: the error propagates, never an allow)', async () => {
    const { service } = build(new Error('connection lost'));
    await expect(service.assertCanManageDataModelTx(manager, ctx)).rejects.toThrow('connection lost');
  });

  it('ABUSE DM-3: only a literal true allows (a truthy non-boolean from a broken lookup is a denial)', async () => {
    const userHasPermissionTx = jest.fn(async () => 'true' as unknown as boolean);
    const service = new DataModelAuthorityService({ userHasPermissionTx } as unknown as PermissionsService);
    await expect(service.assertCanManageDataModelTx(manager, ctx)).rejects.toBeInstanceOf(DataModelPermissionDeniedException);
  });

  it.each([
    ['no context at all', undefined],
    ['no organisation bound', { ...ctx, organisationId: null }],
    ['no workspace bound', { ...ctx, workspaceId: null }],
    ['no user', { ...ctx, userId: '' }],
    ['an Admin Inspect session (read-only), even when the inspected user holds the flag', { ...ctx, inspectedBy: '44444444-4444-4444-8444-444444444444' }],
    ['a worker context (system scans never change the data model)', { ...ctx, actorType: 'worker' as const }],
  ])('ABUSE DM-4: %s → 403 PERMISSION_DENIED before any permission query', async (_label, context) => {
    const { service, userHasPermissionTx } = build(true);
    await expect(service.assertCanManageDataModelTx(manager, context as AuthContext | undefined)).rejects.toBeInstanceOf(DataModelPermissionDeniedException);
    expect(userHasPermissionTx).not.toHaveBeenCalled();
  });

  describe('locked objects (owner decision 2026-11-18: payroll / attendance locked; M2-PLAN F12 / A6)', () => {
    const { service } = build(true);

    it.each([...PAYROLL_ATTENDANCE_SYSTEM_TABLES])('ABUSE DM-5: payroll / attendance table %s is locked → 403 OBJECT_SYSTEM_LOCKED', (table) => {
      const error = (() => {
        try {
          service.assertObjectNotLocked(table);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(ObjectSystemLockedException);
      expect((error as ObjectSystemLockedException).getStatus()).toBe(403);
      expect((error as ObjectSystemLockedException).getResponse()).toMatchObject({ code: DataModelErrorCode.OBJECT_SYSTEM_LOCKED });
    });

    it.each(['venue_manager_staff', 'manager_venue', 'shift_request_staff', 'venue_role_rate', 'shift_assignment', 'shift_report', 'replacement_request', 'user_note'])(
      'ABUSE DM-6: junction / D1 / D4 table %s is locked',
      (table) => {
        expect(() => service.assertObjectNotLocked(table)).toThrow(ObjectSystemLockedException);
      },
    );

    it.each(['', 'Attendance', 'payroll_record ', '"payroll_record"', 'core.payroll_record', 'payroll_record;--', 'pay​roll_record', 42 as unknown as string, null as unknown as string])(
      'ABUSE DM-7: a target that is not a plain table name (%j) is refused the same way (fail closed)',
      (table) => {
        expect(() => service.assertObjectNotLocked(table)).toThrow(ObjectSystemLockedException);
      },
    );

    it('the six objects that allow custom fields and a custom c_ table are not locked', () => {
      for (const table of ['staff_profile', 'venue', 'job_role', 'shift', 'job_offer', 'shift_staff_review', 'c_0a1b2c3d4e']) {
        expect(() => service.assertObjectNotLocked(table)).not.toThrow();
      }
    });

    it('the lock list is the engine list itself: all seven payroll / attendance tables plus the junctions, D1 and D4 (15)', () => {
      expect([...DATA_MODEL_LOCKED_TABLES].sort()).toEqual([...NO_CUSTOM_FIELD_TABLES].sort());
      for (const t of PAYROLL_ATTENDANCE_SYSTEM_TABLES) expect(DATA_MODEL_LOCKED_TABLES.has(t)).toBe(true);
      expect([...PAYROLL_ATTENDANCE_SYSTEM_TABLES].sort()).toEqual(
        ['attendance', 'attendance_correction', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document'],
      );
      expect(DATA_MODEL_LOCKED_TABLES.size).toBe(15);
    });

    it('locking is checked before, and independently of, the permission (a holder of data_model.manage is still refused)', async () => {
      const { service: holder } = build(true);
      await expect(holder.assertCanManageDataModelTx(manager, ctx)).resolves.toBeUndefined();
      expect(() => holder.assertObjectNotLocked('payroll_run')).toThrow(ObjectSystemLockedException);
    });
  });
});
