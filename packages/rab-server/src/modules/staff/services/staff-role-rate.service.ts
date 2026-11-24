import { PermissionFlag } from '@rab/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import {
  AuditAction,
  AuditService,
} from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { pickFields } from '../../../engine/utils/pick-fields.util';
import { JobRole } from '../../scheduling/entities/job-role.entity';
import { isJobRoleInScope } from '../../scheduling/utils/job-role-scope';
import { CreateStaffRoleRateDto } from '../dto/create-staff-role-rate.dto';
import { UpdateStaffRoleRateDto } from '../dto/update-staff-role-rate.dto';
import { StaffProfile } from '../entities/staff-profile.entity';
import { StaffRoleRate } from '../entities/staff-role-rate.entity';
import { StaffService } from './staff.service';

/** SF-7: the fields `update()` may write (never the staff member, the job role, the author or the tenant columns). */
export const STAFF_ROLE_RATE_UPDATE_FIELDS = [
  'payRatePence',
  'effectiveFrom',
  'effectiveTo',
] as const satisfies readonly (keyof UpdateStaffRoleRateDto &
  keyof StaffRoleRate)[];

/** Read flag: the response carries pay amounts, gated like the staff profile's "Default pay rate" (member-object-registry). */
export const STAFF_ROLE_RATE_READ_FLAG = PermissionFlag.PAYROLL_VIEW;
/** Write flags: editing a staff member (STAFF_EDIT) AND seeing pay (PAYROLL_VIEW) — a writer always sees what they set. */
export const STAFF_ROLE_RATE_WRITE_FLAGS = [
  PermissionFlag.STAFF_EDIT,
  PermissionFlag.PAYROLL_VIEW,
] as const;

export const STAFF_ROLE_RATE_OVERLAP_MESSAGE =
  'This staff member already has a pay rate for this job role that overlaps these dates.';

/** What the API returns: no tenant columns. Money is whole pence. */
export interface StaffRoleRateView {
  id: string;
  staffProfileId: string;
  jobRoleId: string;
  payRatePence: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-staff, per-job-role pay rates (core.staff_role_rate, StaffRoleRateSchema1786722210000; architecture §1 A6). The rate
 * is applied at confirmation by `resolveSeatPayRate` (staff-role-rate-resolution.ts), never here.
 *
 * Five layers on every call (CLAUDE.md):
 *   1. route PermissionGuard (StaffRoleRateController): PAYROLL_VIEW to read, STAFF_EDIT + PAYROLL_VIEW to write;
 *   2. the SAME flags re-checked here, first, inside the tenant transaction — 403 before any id is read (jobs, CLI and
 *      other services never pass the guard);
 *   3. scope: the staff profile through StaffService's own strict write-path rule (the caller created it; RLS hides other
 *      workspaces / organisations) and the job role through `isJobRoleInScope` — both 404, never 403; a rate row is
 *      addressed only together with its staff member (`id` AND `staff_profile_id`) in the session's workspace;
 *   4. RLS tenant predicate (organisation + workspace of the session; workspace_id / organisation_id are read from the
 *      bound session, never from the client);
 *   5. RLS second predicate: a non-venue manager of the workspace; INSERT also created_by = the caller.
 *
 * Orphans (lead condition 3): there is no foreign key to staff_profile / job_role (they live in the workspace schema with HWS
 * on). A rate row is only ever READ by (staff_profile_id, job_role_id) of a live seat (resolveSeatPayRate) or through this
 * service with a staff profile that passes the scope check, so a row whose profile or role no longer exists is never used:
 * staff profiles and job roles are never hard-deleted by the application (archive is a soft state; the only hard delete is
 * the Worker's cleanup of never-activated invited users, whose profile can have no seat), and a new row can never reuse a
 * deleted uuid. Archived staff cannot receive offers (they must be deactivated first), so their rates are never applied while
 * archived and apply again after restore + reactivate; an archived job role keeps its rates for the shifts that still name it,
 * and no new rate can be created for it (the StaffService rule for a newly chosen role).
 * Every write records one `staff_role_rate.*` audit row in the same transaction: staff member, job role and dates — never an
 * amount.
 */
@Injectable()
export class StaffRoleRateService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
    private readonly staffService: StaffService,
  ) {}

  async list(
    ctx: AuthContext,
    staffProfileId: string,
  ): Promise<StaffRoleRateView[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.permissions.assertPermissionTx(
        manager,
        ctx,
        STAFF_ROLE_RATE_READ_FLAG,
        'Viewing pay rates is not permitted.',
      );
      await this.staffInScope(manager, ctx, staffProfileId);
      const { workspaceId } = await boundTenant(manager);
      const rows = await manager.find(StaffRoleRate, {
        where: { staffProfileId, workspaceId },
        order: { jobRoleId: 'ASC', effectiveFrom: 'DESC' },
      });
      return rows.map(toView);
    });
  }

  async create(
    ctx: AuthContext,
    staffProfileId: string,
    dto: CreateStaffRoleRateDto,
  ): Promise<StaffRoleRateView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanWriteTx(manager, ctx);
      const profile = await this.staffInScope(manager, ctx, staffProfileId);
      await this.jobRoleInScope(manager, ctx, dto.jobRoleId);
      const effectiveTo = dto.effectiveTo ?? null;
      assertPeriod(dto.effectiveFrom, effectiveTo);
      const { organisationId, workspaceId } = await boundTenant(manager);
      const rate = manager.create(StaffRoleRate, {
        organisationId,
        workspaceId,
        staffProfileId: profile.id,
        jobRoleId: dto.jobRoleId,
        payRatePence: dto.payRatePence,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo,
        createdBy: ctx.userId,
      });
      const saved = await this.writing(() => manager.save(rate));
      await this.auditService.record(
        manager,
        ctx,
        AuditAction.STAFF_ROLE_RATE_CREATED,
        {
          entityType: 'staff_role_rate',
          entityId: saved.id,
          targetUserId: profile.userId,
          metadata: auditMetadata(saved),
        },
      );
      return toView(saved);
    });
  }

  async update(
    ctx: AuthContext,
    staffProfileId: string,
    rateId: string,
    dto: UpdateStaffRoleRateDto,
  ): Promise<StaffRoleRateView> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanWriteTx(manager, ctx);
      const profile = await this.staffInScope(manager, ctx, staffProfileId);
      const rate = await this.findRate(manager, staffProfileId, rateId);
      // Explicit field map (SF-7). `null` clears only effectiveTo; the other two are NOT NULL columns.
      const fields = pickFields(dto, STAFF_ROLE_RATE_UPDATE_FIELDS);
      if (fields.payRatePence === null || fields.effectiveFrom === null)
        throw new BadRequestException(
          'payRatePence and effectiveFrom cannot be cleared.',
        );
      if (Object.keys(fields).length === 0)
        throw new BadRequestException('Nothing to change.');
      assertPeriod(
        fields.effectiveFrom ?? rate.effectiveFrom,
        fields.effectiveTo === undefined
          ? rate.effectiveTo
          : fields.effectiveTo,
      );
      await this.writing(() =>
        manager.update(StaffRoleRate, { id: rate.id, staffProfileId }, fields),
      );
      const updated = await manager.findOneByOrFail(StaffRoleRate, {
        id: rate.id,
      });
      await this.auditService.record(
        manager,
        ctx,
        AuditAction.STAFF_ROLE_RATE_UPDATED,
        {
          entityType: 'staff_role_rate',
          entityId: rate.id,
          targetUserId: profile.userId,
          metadata: { ...auditMetadata(updated), fields: Object.keys(fields) },
        },
      );
      return toView(updated);
    });
  }

  async remove(
    ctx: AuthContext,
    staffProfileId: string,
    rateId: string,
  ): Promise<void> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      await this.assertCanWriteTx(manager, ctx);
      const profile = await this.staffInScope(manager, ctx, staffProfileId);
      const rate = await this.findRate(manager, staffProfileId, rateId);
      const metadata = auditMetadata(rate);
      await manager.delete(StaffRoleRate, { id: rate.id, staffProfileId });
      await this.auditService.record(
        manager,
        ctx,
        AuditAction.STAFF_ROLE_RATE_DELETED,
        {
          entityType: 'staff_role_rate',
          entityId: rate.id,
          targetUserId: profile.userId,
          metadata,
        },
      );
    });
  }

  /** Layer 2: both write flags, before any id is read (403, a categorical lack). */
  private async assertCanWriteTx(
    manager: EntityManager,
    ctx: AuthContext,
  ): Promise<void> {
    for (const flag of STAFF_ROLE_RATE_WRITE_FLAGS) {
      await this.permissions.assertPermissionTx(
        manager,
        ctx,
        flag,
        'Changing pay rates is not permitted.',
      );
    }
  }

  /** Layer 3: StaffService's strict scope, and the profile must belong to the session's workspace (404 otherwise). */
  private async staffInScope(
    manager: EntityManager,
    ctx: AuthContext,
    staffProfileId: string,
  ): Promise<StaffProfile> {
    const profile = await this.staffService.findOwnedProfileTx(
      manager,
      ctx,
      staffProfileId,
    );
    const { organisationId, workspaceId } = await boundTenant(manager);
    if (
      profile.organisationId !== organisationId ||
      profile.workspaceId !== workspaceId
    )
      throw new NotFoundException('Staff member not found.');
    return profile;
  }

  /** Layer 3: the job role must be visible (RLS), in this organisation and workspace, and in the caller's scope; never archived for a new rate. */
  private async jobRoleInScope(
    manager: EntityManager,
    ctx: AuthContext,
    jobRoleId: string,
  ): Promise<void> {
    const { organisationId, workspaceId } = await boundTenant(manager);
    const role = await manager.findOne(JobRole, {
      where: { id: jobRoleId, organisationId },
    });
    if (!role || (role.workspaceId != null && role.workspaceId !== workspaceId))
      throw new NotFoundException('Job role not found.');
    if (
      !isJobRoleInScope(
        await this.resourceScope.resolveTx(manager, ctx),
        ctx,
        role,
      )
    )
      throw new NotFoundException('Job role not found.');
    if (role.archivedAt)
      throw new ConflictException({
        code: 'JOB_ROLE_ARCHIVED',
        message: 'This job role is archived. Restore it before using it.',
      });
  }

  private async findRate(
    manager: EntityManager,
    staffProfileId: string,
    rateId: string,
  ): Promise<StaffRoleRate> {
    const { workspaceId } = await boundTenant(manager);
    const rate = await manager.findOne(StaffRoleRate, {
      where: { id: rateId, staffProfileId, workspaceId },
    });
    if (!rate) throw new NotFoundException('Pay rate not found.');
    return rate;
  }

  /** The exclusion constraint is the authority on overlaps (two concurrent writes cannot both pass): 409, never a 500. */
  private async writing<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const driver =
        error instanceof QueryFailedError
          ? (
              error as QueryFailedError & {
                driverError?: { code?: string; constraint?: string };
              }
            ).driverError
          : undefined;
      if (
        driver?.code === '23P01' &&
        driver.constraint === 'staff_role_rate_no_overlap'
      ) {
        throw new ConflictException({
          code: 'STAFF_ROLE_RATE_OVERLAP',
          message: STAFF_ROLE_RATE_OVERLAP_MESSAGE,
        });
      }
      throw error;
    }
  }
}

/** The organisation and workspace bound into THIS transaction (what RLS compares against) — never a client value. */
async function boundTenant(
  manager: EntityManager,
): Promise<{ organisationId: string; workspaceId: string }> {
  const [row] = (await manager.query(
    `SELECT core.current_org()::text AS org, core.current_workspace()::text AS ws`,
  )) as Array<{ org: string | null; ws: string | null }>;
  if (!row?.org || !row.ws)
    throw new NotFoundException('Staff member not found.'); // fail closed: no tenant bound
  return { organisationId: row.org, workspaceId: row.ws };
}

/** 400 for an end before the start (the CHECK would refuse it too, as a 500). Dates are `YYYY-MM-DD`, so text order = date order. */
function assertPeriod(
  effectiveFrom: string,
  effectiveTo: string | null | undefined,
): void {
  if (effectiveTo != null && effectiveTo < effectiveFrom)
    throw new BadRequestException(
      'effectiveTo must be on or after effectiveFrom.',
    );
}

function toView(rate: StaffRoleRate): StaffRoleRateView {
  return {
    id: rate.id,
    staffProfileId: rate.staffProfileId,
    jobRoleId: rate.jobRoleId,
    payRatePence: rate.payRatePence,
    effectiveFrom: day(rate.effectiveFrom)!,
    effectiveTo: day(rate.effectiveTo),
    createdBy: rate.createdBy,
    createdAt: rate.createdAt,
    updatedAt: rate.updatedAt,
  };
}

function day(value: unknown): string | null {
  return value == null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value);
}

/** Audit metadata for a staff pay rate change: which rate, never how much (same rule as venue_role_rate.*). */
function auditMetadata(rate: StaffRoleRate): Record<string, unknown> {
  return {
    staffProfileId: rate.staffProfileId,
    jobRoleId: rate.jobRoleId,
    effectiveFrom: day(rate.effectiveFrom),
    effectiveTo: day(rate.effectiveTo),
  };
}
