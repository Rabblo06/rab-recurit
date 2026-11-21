import { PermissionFlag } from '@rab/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { StaffRoleRate } from '../entities/staff-role-rate.entity';
import {
  STAFF_ROLE_RATE_UPDATE_FIELDS,
  StaffRoleRateService,
} from './staff-role-rate.service';

// The real StaffService pulls the whole identity / email graph in; only its scope method is used, and it is faked below.
jest.mock('./staff.service', () => ({ StaffService: class StaffService {} }));

/**
 * StaffRoleRateService without a database: the order of the layers (permission BEFORE any read), the explicit field map,
 * the 404s and the overlap → 409 mapping. The same rules against real PostgreSQL + RLS are in
 * staff-role-rate.integration.spec.ts.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const ctx: AuthContext = {
  organisationId: ORG,
  workspaceId: WS,
  userId: 'manager-1',
  role: '',
};
const profile = {
  id: 'staff-1',
  userId: 'staff-user-1',
  organisationId: ORG,
  workspaceId: WS,
  createdBy: 'manager-1',
};
const role = {
  id: 'role-1',
  organisationId: ORG,
  workspaceId: WS,
  createdBy: 'manager-1',
  archivedAt: null,
};

function build(
  opts: {
    flags?: string[];
    rate?: Partial<StaffRoleRate> | null;
    saveError?: unknown;
    jobRole?: unknown;
  } = {},
) {
  const granted = new Set(
    opts.flags ?? [PermissionFlag.STAFF_EDIT, PermissionFlag.PAYROLL_VIEW],
  );
  const calls: string[] = [];
  const manager = {
    query: jest.fn(async () => [{ org: ORG, ws: WS }]),
    findOne: jest.fn(async (entity: unknown) => {
      calls.push('findOne');
      if (entity === StaffRoleRate)
        return opts.rate === undefined
          ? {
              id: 'rate-1',
              staffProfileId: 'staff-1',
              jobRoleId: 'role-1',
              effectiveFrom: '2026-01-01',
              effectiveTo: null,
            }
          : opts.rate;
      return opts.jobRole === undefined ? role : opts.jobRole;
    }),
    find: jest.fn(async () => []),
    create: jest.fn((_e: unknown, v: object) => ({ ...v })),
    save: jest.fn(async (v: object) => {
      if (opts.saveError) throw opts.saveError;
      return {
        id: 'rate-new',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...v,
      };
    }),
    update: jest.fn(async () => ({ affected: 1 })),
    findOneByOrFail: jest.fn(async () => ({
      id: 'rate-1',
      staffProfileId: 'staff-1',
      jobRoleId: 'role-1',
      payRatePence: 2000,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    })),
    delete: jest.fn(async () => ({ affected: 1 })),
  } as unknown as EntityManager;
  const permissions = {
    assertPermissionTx: jest.fn(
      async (_m: unknown, _c: unknown, flag: string, message?: string) => {
        calls.push(`perm:${flag}`);
        if (!granted.has(flag)) throw new ForbiddenException(message);
      },
    ),
  };
  const staffService = {
    findOwnedProfileTx: jest.fn(
      async (_m: unknown, _c: unknown, id: string) => {
        calls.push('staff');
        if (id !== 'staff-1')
          throw new NotFoundException('Staff member not found.');
        return profile;
      },
    ),
  };
  const audit = { record: jest.fn(async (..._args: unknown[]) => undefined) };
  const tenantContext = {
    runInWorkspaceContext: jest.fn(
      (_c: unknown, fn: (m: EntityManager) => unknown) => fn(manager),
    ),
  };
  const resourceScope = {
    resolveTx: jest.fn(async () => ({
      kind: 'owner',
      ownerUserId: 'manager-1',
      delegated: false,
    })),
  };
  const service = new StaffRoleRateService(
    tenantContext as never,
    permissions as never,
    resourceScope as never,
    audit as never,
    staffService as never,
  );
  return {
    service,
    manager: manager as unknown as Record<string, jest.Mock>,
    permissions,
    staffService,
    audit,
    calls,
  };
}

const createDto = {
  jobRoleId: 'role-1',
  payRatePence: 2350,
  effectiveFrom: '2026-01-01',
};

describe('StaffRoleRateService', () => {
  it('layer 2: without payroll.view, list() is a 403 before anything is read', async () => {
    const t = build({ flags: [PermissionFlag.STAFF_EDIT] });
    await expect(t.service.list(ctx, 'staff-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(t.calls).toEqual([`perm:${PermissionFlag.PAYROLL_VIEW}`]);
  });

  it.each([[PermissionFlag.STAFF_EDIT], [PermissionFlag.PAYROLL_VIEW]])(
    'layer 2: a write without %s is a 403 before any read, nothing written',
    async (missing) => {
      const t = build({
        flags: [PermissionFlag.STAFF_EDIT, PermissionFlag.PAYROLL_VIEW].filter(
          (f) => f !== missing,
        ),
      });
      await expect(
        t.service.create(ctx, 'staff-1', createDto as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        t.service.update(ctx, 'staff-1', 'rate-1', {
          payRatePence: 1,
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        t.service.remove(ctx, 'staff-1', 'rate-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.calls.every((c) => c.startsWith('perm:'))).toBe(true);
      expect(t.manager.save).not.toHaveBeenCalled();
      expect(t.manager.update).not.toHaveBeenCalled();
      expect(t.manager.delete).not.toHaveBeenCalled();
    },
  );

  it('a staff member outside the caller scope is a 404 (never 403), nothing written', async () => {
    const t = build();
    await expect(
      t.service.create(ctx, 'staff-other', createDto as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.manager.save).not.toHaveBeenCalled();
  });

  it("a job role that is missing, of another workspace or not the caller's own is a 404; an archived one is a 409", async () => {
    await expect(
      build({ jobRole: null }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ jobRole: { ...role, workspaceId: 'another-ws' } }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ jobRole: { ...role, createdBy: 'someone-else' } }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ jobRole: { ...role, archivedAt: new Date() } }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create writes the session tenant and the caller as author, whatever a direct caller passes; audit carries no amount', async () => {
    const t = build();
    await t.service.create(ctx, 'staff-1', {
      ...createDto,
      organisationId: 'evil-org',
      workspaceId: 'evil-ws',
      createdBy: 'evil',
      staffProfileId: 'other',
    } as never);
    expect(t.manager.create).toHaveBeenCalledWith(StaffRoleRate, {
      organisationId: ORG,
      workspaceId: WS,
      staffProfileId: 'staff-1',
      jobRoleId: 'role-1',
      payRatePence: 2350,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      createdBy: 'manager-1',
    });
    const [, , action, opts] = t.audit.record.mock.calls[0] as unknown as [
      unknown,
      unknown,
      string,
      { metadata: Record<string, unknown>; targetUserId: string },
    ];
    expect(action).toBe(AuditAction.STAFF_ROLE_RATE_CREATED);
    expect(opts.targetUserId).toBe('staff-user-1');
    expect(Object.keys(opts.metadata).sort()).toEqual([
      'effectiveFrom',
      'effectiveTo',
      'jobRoleId',
      'staffProfileId',
    ]);
    expect(JSON.stringify(opts.metadata)).not.toContain('2350');
  });

  it('update maps only the amount and the period (never the staff member, role, author or tenant)', async () => {
    expect([...STAFF_ROLE_RATE_UPDATE_FIELDS]).toEqual([
      'payRatePence',
      'effectiveFrom',
      'effectiveTo',
    ]);
    const t = build();
    await t.service.update(ctx, 'staff-1', 'rate-1', {
      payRatePence: 2400,
      jobRoleId: 'x',
      createdBy: 'evil',
      staffProfileId: 'y',
      organisationId: 'z',
    } as never);
    expect(t.manager.update).toHaveBeenCalledWith(
      StaffRoleRate,
      { id: 'rate-1', staffProfileId: 'staff-1' },
      { payRatePence: 2400 },
    );
  });

  it('update: a rate of another staff member is a 404; clearing a NOT NULL field or an end before the start is a 400', async () => {
    await expect(
      build({ rate: null }).service.update(ctx, 'staff-1', 'rate-x', {
        payRatePence: 1,
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build().service.update(ctx, 'staff-1', 'rate-1', {
        payRatePence: null,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build().service.update(ctx, 'staff-1', 'rate-1', {
        effectiveTo: '2025-12-31',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build().service.update(ctx, 'staff-1', 'rate-1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: an end before the start is a 400 before any write', async () => {
    const t = build();
    await expect(
      t.service.create(ctx, 'staff-1', {
        ...createDto,
        effectiveTo: '2025-06-01',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.manager.save).not.toHaveBeenCalled();
  });

  it('an overlapping period (the exclusion constraint) is a 409 with a clear message; any other database error is rethrown', async () => {
    const overlap = Object.assign(
      new QueryFailedError('INSERT', [], new Error('conflicting key value')),
      {
        driverError: {
          code: '23P01',
          constraint: 'staff_role_rate_no_overlap',
        },
      },
    );
    await expect(
      build({ saveError: overlap }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'STAFF_ROLE_RATE_OVERLAP' },
    });
    const other = Object.assign(
      new QueryFailedError('INSERT', [], new Error('boom')),
      {
        driverError: {
          code: '23514',
          constraint: 'staff_role_rate_pay_rate_check',
        },
      },
    );
    await expect(
      build({ saveError: other }).service.create(
        ctx,
        'staff-1',
        createDto as never,
      ),
    ).rejects.toBe(other);
  });

  it('remove deletes only the addressed row of that staff member and audits it', async () => {
    const t = build();
    await t.service.remove(ctx, 'staff-1', 'rate-1');
    expect(t.manager.delete).toHaveBeenCalledWith(StaffRoleRate, {
      id: 'rate-1',
      staffProfileId: 'staff-1',
    });
    expect(t.audit.record.mock.calls[0]![2]).toBe(
      AuditAction.STAFF_ROLE_RATE_DELETED,
    );
  });
});
