import { InvalidTransitionError, PermissionFlag } from '@rab/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { AuditAction } from '../../../engine/core-modules/audit/audit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { StaffProfile } from '../entities/staff-profile.entity';
import { StaffTimeOff } from '../entities/staff-time-off.entity';
import {
  assertRange,
  StaffTimeOffService,
  TIME_OFF_MANAGER_READ_FLAG,
  TIME_OFF_MANAGER_WRITE_FLAG,
  TIME_OFF_STAFF_FLAG,
} from './staff-time-off.service';

// The real StaffService pulls the whole identity / email graph in; only its scope method is used, and it is faked below.
jest.mock('./staff.service', () => ({ StaffService: class StaffService {} }));

/**
 * StaffTimeOffService without a database (owner decisions 42, 48): the order of the layers (permission BEFORE any read), the
 * scope 404s, the named transitions (409 otherwise), the compare-and-set, maker-checker, the overlap → 409 mapping and the
 * audit metadata (ids and dates, never the note or the reason). The same rules against real PostgreSQL + RLS are in
 * staff-time-off.integration.spec.ts.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const managerCtx: AuthContext = {
  organisationId: ORG,
  workspaceId: WS,
  userId: 'manager-1',
  role: '',
};
const staffCtx: AuthContext = {
  organisationId: ORG,
  workspaceId: WS,
  userId: 'staff-user-1',
  role: '',
};
const profile = {
  id: 'staff-1',
  userId: 'staff-user-1',
  organisationId: ORG,
  workspaceId: WS,
  createdBy: 'manager-1',
};
const TODAY = '2026-11-24';

function row(over: Partial<StaffTimeOff> = {}): StaffTimeOff {
  return {
    id: 'tio-1',
    organisationId: ORG,
    workspaceId: WS,
    staffProfileId: 'staff-1',
    staffUserId: 'staff-user-1',
    startsOn: '2026-12-01',
    endsOn: '2026-12-03',
    status: 'requested',
    note: 'family wedding',
    requestedBy: 'staff-user-1',
    decidedBy: null,
    decidedAt: null,
    declineReason: null,
    cancelledBy: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as StaffTimeOff;
}

function build(
  opts: {
    flags?: string[];
    row?: StaffTimeOff | null;
    after?: Partial<StaffTimeOff>;
    affected?: number;
    saveError?: unknown;
    updateError?: unknown;
    ownProfile?: unknown;
  } = {},
) {
  const granted = new Set(
    opts.flags ?? [
      PermissionFlag.STAFF_VIEW,
      PermissionFlag.STAFF_EDIT,
      PermissionFlag.OFFER_RESPOND,
    ],
  );
  const calls: string[] = [];
  const current = opts.row === undefined ? row() : opts.row;
  const manager = {
    query: jest.fn(async (sql: string) => {
      calls.push('query');
      if (sql.includes('to_char(now()')) return [{ day: TODAY }];
      return [{ org: ORG, ws: WS }];
    }),
    findOne: jest.fn(async (entity: unknown) => {
      calls.push('findOne');
      if (entity === StaffProfile)
        return opts.ownProfile === undefined ? profile : opts.ownProfile;
      if (entity === StaffTimeOff) return current;
      return null;
    }),
    findAndCount: jest.fn(async () => {
      calls.push('findAndCount');
      return [[row()], 1];
    }),
    create: jest.fn((_e: unknown, v: object) => ({ ...v })),
    save: jest.fn(async (v: object) => {
      calls.push('save');
      if (opts.saveError) throw opts.saveError;
      return {
        id: 'tio-new',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...v,
      };
    }),
    update: jest.fn(async () => {
      calls.push('update');
      if (opts.updateError) throw opts.updateError;
      return { affected: opts.affected ?? 1 };
    }),
    findOneByOrFail: jest.fn(async () => ({ ...current, ...opts.after })),
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
      async (_m: unknown, ctx: AuthContext, id: string) => {
        calls.push('staff');
        if (id !== 'staff-1' || ctx.userId !== 'manager-1')
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
  const service = new StaffTimeOffService(
    tenantContext as never,
    permissions as never,
    audit as never,
    staffService as never,
  );
  return {
    service,
    manager: manager as unknown as Record<string, jest.Mock>,
    audit,
    calls,
  };
}

describe('StaffTimeOffService', () => {
  describe('flags (layer 2): the same flag as the route, first, 403 before any read and nothing written', () => {
    it.each([
      [
        'listMine',
        TIME_OFF_STAFF_FLAG,
        (s: StaffTimeOffService) => s.listMine(staffCtx),
      ],
      [
        'request',
        TIME_OFF_STAFF_FLAG,
        (s: StaffTimeOffService) =>
          s.request(staffCtx, { startsOn: '2026-12-01', endsOn: '2026-12-02' }),
      ],
      [
        'cancelMine',
        TIME_OFF_STAFF_FLAG,
        (s: StaffTimeOffService) => s.cancelMine(staffCtx, 'tio-1'),
      ],
      [
        'listWorkspace',
        TIME_OFF_MANAGER_READ_FLAG,
        (s: StaffTimeOffService) => s.listWorkspace(managerCtx),
      ],
      [
        'listForStaff',
        TIME_OFF_MANAGER_READ_FLAG,
        (s: StaffTimeOffService) => s.listForStaff(managerCtx, 'staff-1'),
      ],
      [
        'enter',
        TIME_OFF_MANAGER_WRITE_FLAG,
        (s: StaffTimeOffService) =>
          s.enter(managerCtx, 'staff-1', {
            startsOn: '2026-12-01',
            endsOn: '2026-12-02',
          }),
      ],
      [
        'approve',
        TIME_OFF_MANAGER_WRITE_FLAG,
        (s: StaffTimeOffService) => s.approve(managerCtx, 'tio-1'),
      ],
      [
        'decline',
        TIME_OFF_MANAGER_WRITE_FLAG,
        (s: StaffTimeOffService) =>
          s.decline(managerCtx, 'tio-1', { reason: 'busy' }),
      ],
      [
        'cancel',
        TIME_OFF_MANAGER_WRITE_FLAG,
        (s: StaffTimeOffService) => s.cancel(managerCtx, 'tio-1'),
      ],
    ])('%s needs %s', async (_name, flag, call) => {
      const { service, calls, manager, audit } = build({ flags: [] });
      await expect(call(service)).rejects.toBeInstanceOf(ForbiddenException);
      expect(calls).toEqual([`perm:${flag}`]);
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('the flags are the existing staff.view / staff.edit / offer.respond (no permission migration)', () => {
      expect([
        TIME_OFF_MANAGER_READ_FLAG,
        TIME_OFF_MANAGER_WRITE_FLAG,
        TIME_OFF_STAFF_FLAG,
      ]).toEqual(['staff.view', 'staff.edit', 'offer.respond']);
    });
  });

  describe('staff self-service', () => {
    it('request: a `requested` row for the caller, ids from the session, audited without the note', async () => {
      const { service, manager, audit } = build();
      const view = await service.request(staffCtx, {
        startsOn: '2026-12-01',
        endsOn: '2026-12-03',
        note: '  family wedding ',
      });
      expect(manager.create).toHaveBeenCalledWith(StaffTimeOff, {
        organisationId: ORG,
        workspaceId: WS,
        staffProfileId: 'staff-1',
        staffUserId: 'staff-user-1',
        startsOn: '2026-12-01',
        endsOn: '2026-12-03',
        status: 'requested',
        note: 'family wedding',
        requestedBy: 'staff-user-1',
      });
      expect(view.status).toBe('requested');
      const [, , action, opts] = audit.record.mock.calls[0]!;
      expect(action).toBe(AuditAction.STAFF_TIME_OFF_REQUESTED);
      expect(opts).toEqual({
        entityType: 'staff_time_off',
        entityId: 'tio-new',
        targetUserId: 'staff-user-1',
        metadata: {
          staffProfileId: 'staff-1',
          startsOn: '2026-12-01',
          endsOn: '2026-12-03',
        },
      });
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('wedding');
    });

    it('a caller with no staff profile in the bound workspace gets 404 and writes nothing', async () => {
      for (const ownProfile of [
        null,
        { ...profile, workspaceId: 'another-ws' },
      ]) {
        const { service, manager } = build({ ownProfile });
        await expect(
          service.request(staffCtx, {
            startsOn: '2026-12-01',
            endsOn: '2026-12-01',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(manager.save).not.toHaveBeenCalled();
      }
    });

    it('cancelMine: only a still-requested row, looked up by the caller profile AND user id; compare-and-set', async () => {
      const { service, manager, audit } = build({
        after: { status: 'cancelled', cancelledBy: 'staff-user-1' },
      });
      const view = await service.cancelMine(staffCtx, 'tio-1');
      expect(manager.findOne).toHaveBeenCalledWith(StaffTimeOff, {
        where: {
          id: 'tio-1',
          staffProfileId: 'staff-1',
          staffUserId: 'staff-user-1',
          workspaceId: WS,
        },
      });
      expect(manager.update).toHaveBeenCalledWith(
        StaffTimeOff,
        { id: 'tio-1', status: 'requested' },
        expect.objectContaining({
          status: 'cancelled',
          cancelledBy: 'staff-user-1',
        }),
      );
      expect(view.status).toBe('cancelled');
      expect(audit.record.mock.calls[0]![2]).toBe(
        AuditAction.STAFF_TIME_OFF_CANCELLED,
      );
      expect(
        (
          audit.record.mock.calls[0]![3] as {
            metadata: Record<string, unknown>;
          }
        ).metadata.previousStatus,
      ).toBe('requested');
    });

    it("cancelMine: another staff member's row (not found under the caller's ids) is a 404", async () => {
      const { service, manager } = build({ row: null });
      await expect(
        service.cancelMine(staffCtx, 'tio-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('cancelMine: approved time off is a manager decision (409); declined / cancelled are final (409)', async () => {
      for (const status of ['approved', 'declined', 'cancelled'] as const) {
        const { service, manager } = build({
          row: row({ status, decidedBy: 'm', decidedAt: new Date() }),
        });
        await expect(
          service.cancelMine(staffCtx, 'tio-1'),
        ).rejects.toBeInstanceOf(
          status === 'approved' ? ConflictException : InvalidTransitionError,
        );
        expect(manager.update).not.toHaveBeenCalled();
      }
    });
  });

  describe('managers', () => {
    it('enter: approved at once, requested and decided by the caller, staff user id from the profile', async () => {
      const { service, manager, audit } = build();
      await service.enter(managerCtx, 'staff-1', {
        startsOn: '2026-12-01',
        endsOn: '2026-12-01',
      });
      expect(manager.create).toHaveBeenCalledWith(
        StaffTimeOff,
        expect.objectContaining({
          staffProfileId: 'staff-1',
          staffUserId: 'staff-user-1',
          status: 'approved',
          requestedBy: 'manager-1',
          decidedBy: 'manager-1',
          note: null,
        }),
      );
      expect(audit.record.mock.calls[0]![2]).toBe(
        AuditAction.STAFF_TIME_OFF_ENTERED,
      );
    });

    it('a staff member outside the caller scope is a 404 for list, enter and every decision; nothing written', async () => {
      const { service, manager } = build({
        row: row({ staffProfileId: 'staff-other' }),
      });
      await expect(
        service.listForStaff(managerCtx, 'staff-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.enter(managerCtx, 'staff-other', {
          startsOn: '2026-12-01',
          endsOn: '2026-12-01',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.approve(managerCtx, 'tio-1')).rejects.toThrow(
        'Time off not found.',
      );
      await expect(
        service.decline(managerCtx, 'tio-1', { reason: 'no' }),
      ).rejects.toThrow('Time off not found.');
      await expect(service.cancel(managerCtx, 'tio-1')).rejects.toThrow(
        'Time off not found.',
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('a row whose staff user id no longer matches its profile is never decided (404)', async () => {
      const { service, manager } = build({
        row: row({ staffUserId: 'someone-else' }),
      });
      await expect(service.approve(managerCtx, 'tio-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('approve: requested → approved by the caller, compare-and-set on `requested`, audited', async () => {
      const { service, manager, audit } = build({
        after: { status: 'approved', decidedBy: 'manager-1' },
      });
      await service.approve(managerCtx, 'tio-1');
      expect(manager.update).toHaveBeenCalledWith(
        StaffTimeOff,
        { id: 'tio-1', status: 'requested' },
        expect.objectContaining({
          status: 'approved',
          decidedBy: 'manager-1',
          declineReason: null,
        }),
      );
      expect(audit.record.mock.calls[0]![2]).toBe(
        AuditAction.STAFF_TIME_OFF_APPROVED,
      );
    });

    it('decline: needs a reason; the reason is stored but never audited', async () => {
      const { service, manager, audit } = build({
        after: { status: 'declined' },
      });
      await service.decline(managerCtx, 'tio-1', { reason: ' rota is full ' });
      expect(manager.update).toHaveBeenCalledWith(
        StaffTimeOff,
        { id: 'tio-1', status: 'requested' },
        expect.objectContaining({
          status: 'declined',
          declineReason: 'rota is full',
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('rota');
      const blank = build();
      await expect(
        blank.service.decline(managerCtx, 'tio-1', { reason: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(blank.manager.update).not.toHaveBeenCalled();
    });

    it('approve / decline of anything but a request is an invalid transition (409); nothing written', async () => {
      for (const status of ['approved', 'declined', 'cancelled'] as const) {
        const { service, manager } = build({ row: row({ status }) });
        await expect(
          service.approve(managerCtx, 'tio-1'),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
        await expect(
          service.decline(managerCtx, 'tio-1', { reason: 'x' }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
        expect(manager.update).not.toHaveBeenCalled();
      }
    });

    it('cancel: only approved time off (a request is declined instead, 409); compare-and-set on `approved`', async () => {
      const requested = build();
      await expect(
        requested.service.cancel(managerCtx, 'tio-1'),
      ).rejects.toMatchObject({
        response: { code: 'TIME_OFF_NOT_APPROVED' },
      });
      expect(requested.manager.update).not.toHaveBeenCalled();
      const approved = build({
        row: row({
          status: 'approved',
          decidedBy: 'manager-1',
          decidedAt: new Date(),
        }),
        after: { status: 'cancelled' },
      });
      await approved.service.cancel(managerCtx, 'tio-1');
      expect(approved.manager.update).toHaveBeenCalledWith(
        StaffTimeOff,
        { id: 'tio-1', status: 'approved' },
        expect.objectContaining({
          status: 'cancelled',
          cancelledBy: 'manager-1',
        }),
      );
    });

    it('a concurrent change (compare-and-set hit nothing) is a 409, never a silent success', async () => {
      const { service, audit } = build({ affected: 0 });
      await expect(service.approve(managerCtx, 'tio-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('maker-checker: a manager never enters or decides their own time off (409)', async () => {
      const self: AuthContext = { ...managerCtx, userId: 'staff-user-1' };
      const { service, manager } = build();
      const svc = service as unknown as {
        staffService: { findOwnedProfileTx: jest.Mock };
      };
      svc.staffService.findOwnedProfileTx.mockResolvedValue(profile);
      await expect(
        service.enter(self, 'staff-1', {
          startsOn: '2026-12-01',
          endsOn: '2026-12-01',
        }),
      ).rejects.toMatchObject({
        response: { code: 'TIME_OFF_SELF_DECISION' },
      });
      await expect(service.approve(self, 'tio-1')).rejects.toMatchObject({
        response: { code: 'TIME_OFF_SELF_DECISION' },
      });
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('an overlapping approved range (exclusion constraint) is a coded 409, other errors propagate', async () => {
      const overlap = Object.assign(
        new QueryFailedError('INSERT', [], new Error('exclusion')),
        {
          driverError: {
            code: '23P01',
            constraint: 'staff_time_off_no_overlapping_approved',
          },
        },
      );
      const { service } = build({ saveError: overlap });
      await expect(
        service.enter(managerCtx, 'staff-1', {
          startsOn: '2026-12-01',
          endsOn: '2026-12-01',
        }),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_TIME_OFF_OVERLAP' },
      });
      const approving = build({ updateError: overlap });
      await expect(
        approving.service.approve(managerCtx, 'tio-1'),
      ).rejects.toMatchObject({ response: { code: 'STAFF_TIME_OFF_OVERLAP' } });
      const other = build({ saveError: new Error('boom') });
      await expect(
        other.service.enter(managerCtx, 'staff-1', {
          startsOn: '2026-12-01',
          endsOn: '2026-12-01',
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('assertRange', () => {
    it('both ends inclusive, at most 366 days, never ending in the past (organisation-local today)', () => {
      expect(() =>
        assertRange('2026-12-01', '2026-12-01', TODAY),
      ).not.toThrow();
      expect(() => assertRange('2026-11-01', TODAY, TODAY)).not.toThrow();
      expect(() => assertRange('2026-12-02', '2026-12-01', TODAY)).toThrow(
        BadRequestException,
      );
      expect(() =>
        assertRange('2027-01-01', '2027-12-31', TODAY),
      ).not.toThrow(); // 365 days
      expect(() =>
        assertRange('2028-01-01', '2028-12-31', TODAY),
      ).not.toThrow(); // 366 days (leap year)
      expect(() =>
        assertRange('2027-01-01', '2028-01-01', TODAY),
      ).not.toThrow(); // 366 days inclusive
      expect(() => assertRange('2027-01-01', '2028-01-02', TODAY)).toThrow(
        BadRequestException,
      );
      expect(() => assertRange('2026-11-01', '2026-11-23', TODAY)).toThrow(
        'Time off cannot end in the past.',
      );
    });
  });
});
