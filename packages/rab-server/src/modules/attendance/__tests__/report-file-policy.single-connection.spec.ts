import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { FileAccessRegistry } from '../../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FilesController } from '../../../engine/core-modules/storage/files.controller';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { Shift } from '../../scheduling/entities/shift.entity';
import { ShiftReport } from '../entities/shift-report.entity';
import { ReportFilePolicy } from '../files/report-file.policy';

/**
 * Same pool-deadlock pattern as load-test §4.3 (PR #313; fixed for /auth/refresh in #323): `ReportFilePolicy.canRead` runs
 * inside FilesController's tenant transaction (download/serve: files.controller.ts deliver(); previews) and used to ask
 * `PermissionsService.userHasPermission()`, which opens a SECOND transaction on a second pool connection while the first
 * still holds its connection. Enough concurrent report downloads could then exhaust the pool for every tenant.
 *
 * The fake `runInTenantContext` below is a pool with exactly one connection for this caller: any checkout while a
 * transaction is open throws. `FilesController`, `FileAccessRegistry`, `PermissionsService` and `ReportFilePolicy` are
 * the REAL classes (only I/O is faked), registered exactly as attendance.module.ts registers them.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const WORKSPACE = '00000000-0000-4000-8000-0000000000cc';
const FILE_ID = '00000000-0000-4000-8000-0000000000f1';
const REPORT_ID = '00000000-0000-4000-8000-0000000000e1';
const SHIFT_ID = '00000000-0000-4000-8000-0000000000d1';
const ctx: AuthContext = {
  organisationId: ORG,
  workspaceId: WORKSPACE,
  userId: '00000000-0000-4000-8000-0000000000bb',
  role: '',
};

class SecondConnectionError extends Error {
  constructor() {
    super(
      "asked the pool for a second connection while this request's transaction still holds one (load-test §4.3)",
    );
  }
}

function harness(
  opts: { hasReportView?: boolean; inScope?: boolean; kind?: string } = {},
) {
  let inTransaction = false;
  let transactions = 0;
  const file = {
    id: FILE_ID,
    organisationId: ORG,
    workspaceId: WORKSPACE,
    kind: opts.kind ?? FileKind.FINAL_TIMESHEET_PDF,
    resourceType: 'shift_report',
    resourceId: REPORT_ID,
    status: 'AVAILABLE',
    mimeType: 'application/pdf',
    originalFilename: 'timesheet.pdf',
    sizeBytes: 1000,
  } as unknown as StoredFile;

  // PermissionsService's uncached lookup (no primary DataSource in a unit construction): override, then role count.
  const qb = (result: { effect?: string; count?: number }) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'where', 'andWhere', 'select'])
      chain[m] = () => chain;
    chain.getRawOne = async () =>
      result.effect ? { effect: result.effect } : undefined;
    chain.getCount = async () => result.count ?? 0;
    return chain;
  };
  let qbCalls = 0;
  const manager = {
    queryRunner: undefined,
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === StoredFile) return file;
      if (entity === ShiftReport) return { id: REPORT_ID, shiftId: SHIFT_ID };
      if (entity === Shift)
        return { id: SHIFT_ID, venueId: 'venue-1', createdBy: ctx.userId };
      return null;
    }),
    find: jest.fn(async () => [file]),
    createQueryBuilder: jest.fn(() =>
      qbCalls++ % 2 === 0
        ? qb({})
        : qb({ count: opts.hasReportView === false ? 0 : 1 }),
    ),
  } as unknown as EntityManager;

  const tenantContext = {
    runInTenantContext: jest.fn(
      async <T>(
        _ctx: unknown,
        fn: (m: EntityManager) => Promise<T>,
      ): Promise<T> => {
        if (inTransaction) throw new SecondConnectionError();
        inTransaction = true;
        transactions++;
        try {
          return await fn(manager);
        } finally {
          inTransaction = false;
        }
      },
    ),
  };
  const permissions = new PermissionsService(tenantContext as never);
  const userHasPermission = jest.spyOn(permissions, 'userHasPermission');
  const userHasPermissionTx = jest.spyOn(permissions, 'userHasPermissionTx');
  const shiftReports = {
    canReadShift: jest.fn(async (_m: EntityManager) => opts.inScope ?? true),
  };
  const registry = new FileAccessRegistry();
  registry.register(
    [FileKind.SHIFT_ROSTER_PDF, FileKind.FINAL_TIMESHEET_PDF],
    new ReportFilePolicy(permissions, shiftReports as never),
  );
  const files = {
    findAvailable: jest.fn(async (m: EntityManager) =>
      m.findOne(StoredFile, { where: { id: FILE_ID } } as never),
    ),
    supportsSignedUrls: false,
    readVerified: jest.fn(async () => Buffer.from('%PDF-1.7')),
    signedUrlTtlSeconds: 60,
  };
  const audit = { record: jest.fn(async () => undefined) };
  const controller = new FilesController(
    files as never,
    registry,
    tenantContext as never,
    audit as never,
  );
  const response = {
    setHeader: jest.fn(),
    send: jest.fn(),
    redirect: jest.fn(),
  };
  return {
    controller,
    registry,
    permissions,
    manager,
    userHasPermission,
    userHasPermissionTx,
    shiftReports,
    audit,
    response,
    transactions: () => transactions,
  };
}

describe('report PDF access never asks the pool for a second connection (load-test §4.3 pattern)', () => {
  it('download: report.view is checked on the file transaction itself (same manager), one transaction in total', async () => {
    const h = harness();
    await h.controller.download(ctx, FILE_ID, h.response as never);
    expect(h.response.send).toHaveBeenCalledWith(Buffer.from('%PDF-1.7'));
    expect(h.userHasPermission).not.toHaveBeenCalled();
    expect(h.userHasPermissionTx).toHaveBeenCalledWith(
      h.manager,
      ctx,
      'report.view',
    );
    expect(h.shiftReports.canReadShift.mock.calls[0]![0]).toBe(h.manager);
    expect(h.transactions()).toBe(1);
  });

  it('serve (GET /files/:id) takes the same single-transaction path', async () => {
    const h = harness({ kind: FileKind.SHIFT_ROSTER_PDF });
    await h.controller.serve(ctx, FILE_ID, h.response as never);
    expect(h.response.send).toHaveBeenCalled();
    expect(h.userHasPermission).not.toHaveBeenCalled();
    expect(h.transactions()).toBe(1);
  });

  it('denial unchanged: without report.view the file is "not found" (404, never 403), audited, still one transaction', async () => {
    const h = harness({ hasReportView: false });
    await expect(
      h.controller.download(ctx, FILE_ID, h.response as never),
    ).rejects.toThrow(NotFoundException);
    expect(h.audit.record).toHaveBeenCalledWith(
      h.manager,
      ctx,
      'file.access_denied',
      expect.objectContaining({ entityId: FILE_ID }),
    );
    expect(h.shiftReports.canReadShift).not.toHaveBeenCalled();
    expect(h.response.send).not.toHaveBeenCalled();
    expect(h.userHasPermission).not.toHaveBeenCalled();
    expect(h.transactions()).toBe(1);
  });

  it('denial unchanged: report.view but outside the venue/owner scope is also "not found"', async () => {
    const h = harness({ inScope: false });
    await expect(
      h.controller.download(ctx, FILE_ID, h.response as never),
    ).rejects.toThrow(NotFoundException);
    expect(h.response.send).not.toHaveBeenCalled();
    expect(h.transactions()).toBe(1);
  });

  it('previews: the shared canRead call site stays on one connection even when a report policy is consulted', async () => {
    // Today /files/previews selects PROFILE_IMAGE rows only, so the report policy is not reached there; this pins the call
    // site itself (files.controller.ts previews loop) with the report policy registered for the kind the fake row carries.
    const h = harness({ kind: FileKind.PROFILE_IMAGE });
    h.registry.register(
      [FileKind.PROFILE_IMAGE],
      new ReportFilePolicy(h.permissions, h.shiftReports as never),
    );
    await expect(
      h.controller.previews(ctx, { fileIds: [FILE_ID] } as never),
    ).resolves.toMatchObject({ previews: { [FILE_ID]: expect.any(String) } });
    expect(h.userHasPermission).not.toHaveBeenCalled();
    expect(h.userHasPermissionTx).toHaveBeenCalledWith(
      h.manager,
      ctx,
      'report.view',
    );
    expect(h.transactions()).toBe(1);
  });
});
