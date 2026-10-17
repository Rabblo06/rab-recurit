import { ManagerType, PermissionFlag } from '@rab/shared';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { CreateAdminVenueManagerDto } from '../dto/create-admin-venue-manager.dto';
import { CreateVenueManagerDto } from '../dto/create-venue-manager.dto';
import { ListVenueManagersDto } from '../dto/list-venue-managers.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangeEmailDto } from '../../identity/dto/change-email.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { BulkEmailDto } from '../../staff/dto/bulk-email.dto';
import { AssignVenueTeamStaffDto } from '../dto/assign-venue-team-staff.dto';
import { ManagerProfile } from '../entities/manager-profile.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { ManagerService } from './manager.service';
import { User } from '../../identity/entities';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { EntityManager } from 'typeorm';

/**
 * Two Venue Manager creation flows, kept strictly separate (decision C):
 *
 * 1. NORMAL MANAGER: `createInOwnWorkspace`. Requires VENUE_MANAGER_CREATE (controller) and a workspace in the caller's
 *    server-side context (RequireWorkspaceGuard, and assertHasWorkspace here). When the caller is Manager A, the new Venue
 *    Manager's membership and profile are Workspace A. No request field can change that.
 *
 * 2. CEO / ADMIN: `createForWorkspace`. Requires MANAGER_MANAGE, checked here as well as at the route. The caller may be
 *    workspace-less. An explicit target workspace is accepted only after the caller is authenticated, holds the permission,
 *    the core registry confirms that workspace is active and belongs to the caller's organisation, and an audit row is
 *    written in the same transaction as the creation. A target is never trusted from the request by itself.
 *
 * Both delegate to ManagerService.createWithin, so the user, role, profile, membership and invite rules are written once.
 *
 * `assignVenueInOwnWorkspace` is the normal Manager's counterpart to the CEO-only `ManagerService.assignVenue`: it links a
 * Venue Manager of the caller's own workspace to a Venue of that same workspace, and nothing else.
 */
@Injectable()
export class VenueManagerService {
  @Inject(PermissionsService)
  private readonly permissions!: PermissionsService;

  @Inject(FileService)
  private readonly fileService!: FileService;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly managerService: ManagerService,
    private readonly resourceScope: ResourceScopeService,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async createInOwnWorkspace(ctx: AuthContext, dto: CreateVenueManagerDto) {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) =>
      this.managerService.createWithin(manager, ctx, { ...dto, type: ManagerType.VENUE }),
    );
  }

  /** Normal Manager flow: the Venue Managers of the caller's own workspace (with their venues), nothing else. */
  async listInOwnWorkspace(ctx: AuthContext, dto: ListVenueManagersDto) {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) {
      throw new ForbiddenException('Managing Venue Managers is not permitted.');
    }
    return this.managerService.listVenueManagersInWorkspace(ctx, dto);
  }

  /**
   * The gate every per-record Venue Manager action below passes first (owner decision 2026-10-16: a Manager manages the
   * Venue Managers of their OWN workspace like the CEO manages Managers). Re-checks VENUE_MANAGER_CREATE here (layer 2:
   * jobs and other services never pass the route guard) and requires the target to be a `type: venue` profile of the
   * caller's server-derived workspace; anything else is 404. The delegated ManagerService methods then apply their own
   * existing rules (step-up for delete, deletion safety gates, invitation state machine, audit).
   */
  private async assertOwnWorkspaceVenueManager(ctx: AuthContext, managerProfileId: string): Promise<void> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) {
      throw new ForbiddenException('Managing Venue Managers is not permitted.');
    }
    const found = await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.findOne(ManagerProfile, {
        where: { id: managerProfileId, organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, type: ManagerType.VENUE },
      }),
    );
    if (!found) throw new NotFoundException('Venue Manager not found.');
  }

  async update(ctx: AuthContext, id: string, dto: UpdateManagerDto) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.update(ctx, id, dto);
  }

  async setActive(ctx: AuthContext, id: string, active: boolean) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.setActive(ctx, id, active);
  }

  async resetPassword(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.resetPassword(ctx, id);
  }

  async resendInvite(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.resendInvite(ctx, id);
  }

  async changePendingEmail(ctx: AuthContext, id: string, dto: ChangePendingEmailDto) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.changePendingEmail(ctx, id, dto);
  }

  async cancelInvite(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.cancelInvite(ctx, id);
  }

  async changeEmail(ctx: AuthContext, id: string, dto: ChangeEmailDto) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.changeEmail(ctx, id, dto, PermissionFlag.VENUE_MANAGER_CREATE);
  }

  async getTimeline(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.getTimeline(ctx, id);
  }

  async listNotes(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.listNotes(ctx, id);
  }

  async addNote(ctx: AuthContext, id: string, dto: AddNoteDto) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.addNote(ctx, id, dto);
  }

  async listEmails(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.listEmails(ctx, id);
  }

  async deleteUser(ctx: AuthContext, id: string, currentPassword: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.deleteUser(ctx, id, currentPassword);
  }

  // ------------------------------------------------------------------ Venue Manager teams (owner-assigned Staff)

  /**
   * Layer 2 for team changes: on top of `assertOwnWorkspaceVenueManager`, only the OWNER of the caller's workspace may
   * change who a Venue Manager can see (the RLS owner policy on venue_manager_staff enforces the same in the database).
   */
  private async assertWorkspaceOwner(ctx: AuthContext): Promise<void> {
    const rows = await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.query('SELECT 1 FROM core.manager_workspace WHERE id = $1 AND organisation_id = $2 AND owner_user_id = $3', [
        ctx.workspaceId,
        ctx.organisationId,
        ctx.userId,
      ]),
    );
    if (!rows.length) throw new ForbiddenException('Only the workspace owner can change a Venue Manager\'s staff.');
  }

  /** The Staff a Venue Manager of the caller's workspace can currently see and select. */
  async listTeam(ctx: AuthContext, venueManagerId: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, venueManagerId);
    await this.assertWorkspaceOwner(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, (manager) =>
      manager.query(
        `SELECT sp.id, u.first_name AS "firstName", u.last_name AS "lastName", u.email, u.status AS "accountStatus",
            sp.employment_status AS "employmentStatus", jr.name AS "jobRoleName", t.created_at AS "assignedAt"
         FROM venue_manager_staff t
         JOIN staff_profile sp ON sp.id = t.staff_profile_id AND sp.workspace_id = t.workspace_id
         JOIN core."user" u ON u.id = sp.user_id
         LEFT JOIN job_role jr ON jr.id = sp.job_role_id
         WHERE t.manager_profile_id = $1 AND t.organisation_id = $2 AND t.workspace_id = $3
         ORDER BY u.first_name, u.last_name, sp.id`,
        [venueManagerId, ctx.organisationId, ctx.workspaceId],
      ),
    );
  }

  /**
   * Adds existing Staff of the caller's own workspace to one of their Venue Managers' team. All-or-nothing: an id that is
   * not an assignable Staff member of this workspace (unknown, another workspace's, suspended/deactivated/inactive) fails the whole
   * request with 404 and nothing is written. Already-assigned ids are reported, never duplicated. Creates no account,
   * offer, shift, attendance or venue assignment.
   */
  async assignTeamStaff(ctx: AuthContext, venueManagerId: string, dto: AssignVenueTeamStaffDto) {
    await this.assertOwnWorkspaceVenueManager(ctx, venueManagerId);
    await this.assertWorkspaceOwner(ctx);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const eligible: Array<{ id: string }> = await manager.query(
        `SELECT sp.id FROM staff_profile sp JOIN core."user" u ON u.id = sp.user_id
         WHERE sp.id = ANY($1::uuid[]) AND sp.organisation_id = $2 AND sp.workspace_id = $3
           AND sp.employment_status IN ('active', 'pending_compliance') AND u.status IN ('active', 'invited')`,
        [dto.staffProfileIds, ctx.organisationId, ctx.workspaceId],
      );
      if (eligible.length !== dto.staffProfileIds.length) throw new NotFoundException('Staff member not found.');
      const inserted: Array<{ staff_profile_id: string }> = await manager.query(
        `INSERT INTO venue_manager_staff (organisation_id, workspace_id, manager_profile_id, staff_profile_id)
         SELECT $1, $2, $3, unnest($4::uuid[])
         ON CONFLICT (manager_profile_id, staff_profile_id) DO NOTHING
         RETURNING staff_profile_id`,
        [ctx.organisationId, ctx.workspaceId, venueManagerId, dto.staffProfileIds],
      );
      const added = inserted.map((r) => r.staff_profile_id);
      const alreadyAssigned = dto.staffProfileIds.filter((id) => !added.includes(id));
      if (added.length) {
        await this.auditService.record(manager, ctx, AuditAction.VENUE_TEAM_STAFF_ASSIGNED, {
          entityType: 'manager',
          entityId: venueManagerId,
          metadata: { staffProfileIds: added, workspaceId: ctx.workspaceId },
        });
      }
      return { added, alreadyAssigned };
    });
  }

  /**
   * Removes one Staff member from a Venue Manager's team: takes effect on that Venue Manager's next request (every team
   * read is a live query, nothing cached). Never deletes the Staff account; existing offers/shifts/attendance are kept.
   */
  async removeTeamStaff(ctx: AuthContext, venueManagerId: string, staffProfileId: string): Promise<void> {
    await this.assertOwnWorkspaceVenueManager(ctx, venueManagerId);
    await this.assertWorkspaceOwner(ctx);
    await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const deleted: Array<{ staff_profile_id: string }> = await manager.query(
        `DELETE FROM venue_manager_staff
         WHERE manager_profile_id = $1 AND staff_profile_id = $2 AND organisation_id = $3 AND workspace_id = $4
         RETURNING staff_profile_id`,
        [venueManagerId, staffProfileId, ctx.organisationId, ctx.workspaceId],
      );
      const rows = Array.isArray(deleted[0]) ? (deleted[0] as unknown as Array<{ staff_profile_id: string }>) : deleted;
      if (!rows.length) throw new NotFoundException('Staff member not found.');
      await this.auditService.record(manager, ctx, AuditAction.VENUE_TEAM_STAFF_UNASSIGNED, {
        entityType: 'manager',
        entityId: venueManagerId,
        metadata: { staffProfileId, workspaceId: ctx.workspaceId },
      });
    });
  }

  // ------------------------------------------------------------------ profile photo

  /**
   * The workspace manager sets one of their own Venue Managers' profile photo — the same store-new → swap-pointer →
   * tombstone-old sequence as the Staff avatar (StaffService.uploadAvatar), behind the own-workspace Venue Manager gate.
   */
  async uploadAvatar(ctx: AuthContext, id: string, buffer: Buffer): Promise<{ avatarKey: string }> {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, workspaceId: ctx.workspaceId!, type: ManagerType.VENUE }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Venue Manager not found.');
      const before = profile.user!.avatarFileId;
      const file = await this.fileService.store(manager, {
        kind: FileKind.PROFILE_IMAGE,
        organisationId: ctx.organisationId!,
        workspaceId: ctx.workspaceId ?? null,
        resourceType: 'user',
        resourceId: profile.userId,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(User, profile.userId, { avatarFileId: file.id });
      await this.retireAvatar(manager, before);
      await this.auditService.record(manager, ctx, AuditAction.FILE_UPLOADED, { entityType: 'stored_file', entityId: file.id, metadata: { kind: file.kind, sizeBytes: file.sizeBytes } });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, { targetUserId: profile.userId, metadata: { fields: ['avatar'] } });
      return { avatarKey: file.id };
    });
  }

  async removeAvatar(ctx: AuthContext, id: string): Promise<{ avatarKey: string | null }> {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, workspaceId: ctx.workspaceId!, type: ManagerType.VENUE }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Venue Manager not found.');
      const before = profile.user!.avatarFileId;
      await manager.update(User, profile.userId, { avatarFileId: null });
      await this.retireAvatar(manager, before);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, { targetUserId: profile.userId, metadata: { fields: ['avatar'] } });
      return { avatarKey: null };
    });
  }

  private async retireAvatar(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  /** Only ids that are Venue Managers of the caller's own workspace are emailed; any other id is silently dropped (same as the CEO bulk email). */
  async bulkEmail(ctx: AuthContext, dto: BulkEmailDto) {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) {
      throw new ForbiddenException('Managing Venue Managers is not permitted.');
    }
    const own = await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.find(ManagerProfile, {
        where: { id: In(dto.userIds), organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, type: ManagerType.VENUE },
        select: { id: true },
      }),
    );
    if (own.length === 0) return { queued: 0, skipped: dto.userIds.length };
    const result = await this.managerService.bulkEmail(ctx, { ...dto, userIds: own.map((p) => p.id) });
    return { queued: result.queued, skipped: result.skipped + (dto.userIds.length - own.length) };
  }

  /** Normal Manager flow: one Venue Manager of the caller's own workspace; anything else (other workspace, not a Venue Manager, unknown) is 404. */
  async getInOwnWorkspace(ctx: AuthContext, managerProfileId: string) {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) {
      throw new ForbiddenException('Managing Venue Managers is not permitted.');
    }
    const { data } = await this.managerService.listVenueManagersInWorkspace(ctx, {}, { id: managerProfileId });
    if (!data[0]) throw new NotFoundException('Venue Manager not found.');
    return data[0];
  }

  /**
   * Normal Manager flow: link a Venue Manager to a Venue, both inside the caller's own server-derived workspace.
   * Layer 2 of the five: the permission is re-checked here (jobs and other services never pass the route guard), the
   * profile and venue are looked up with the caller's workspace as an explicit predicate, and RLS on manager_profile,
   * venue and manager_venue (organisation AND workspace) binds the same boundary again in the database.
   * Anything outside that workspace, or a profile that is not a Venue Manager, is 404: no existence oracle.
   */
  async assignVenueInOwnWorkspace(ctx: AuthContext, managerProfileId: string, venueId: string): Promise<void> {
    this.resourceScope.assertHasWorkspace(ctx);
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.VENUE_MANAGER_CREATE))) {
      throw new ForbiddenException('Managing Venue Managers is not permitted.');
    }
    const workspaceId = ctx.workspaceId!;
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, {
        where: { id: managerProfileId, organisationId: ctx.organisationId!, workspaceId, type: ManagerType.VENUE },
      });
      if (!profile) throw new NotFoundException('Venue Manager not found.');
      const venue = await manager.findOne(Venue, { where: { id: venueId, organisationId: ctx.organisationId!, workspaceId } });
      if (!venue) throw new NotFoundException('Venue not found.');

      // Same row shape as ManagerService.assignVenue; workspace_id is the caller's, which both lookups above proved.
      await manager.query(
        `INSERT INTO manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (manager_profile_id, venue_id) DO NOTHING`,
        [ctx.organisationId, profile.id, venue.id, workspaceId],
      );
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_VENUE_ASSIGNED, {
        entityType: 'manager',
        entityId: profile.id,
        targetUserId: profile.userId,
        metadata: { venueId: venue.id, workspaceId, flow: 'workspace_manager' },
      });
    });
  }

  async createForWorkspace(ctx: AuthContext, dto: CreateAdminVenueManagerDto) {
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE))) {
      throw new ForbiddenException('Managing Manager accounts is not permitted.');
    }
    const [{ ok }] = await this.dataSource.query<Array<{ ok: boolean }>>(
      'SELECT core.admin_workspace_in_org($1, $2) AS ok',
      [dto.targetWorkspaceId, ctx.organisationId],
    );
    if (!ok) {
      // 404 for a workspace outside the caller's organisation, or one that does not exist: no existence oracle.
      throw new NotFoundException('Workspace not found.');
    }

    const { targetWorkspaceId, ...person } = dto;
    const targetCtx: AuthContext = { ...ctx, workspaceId: targetWorkspaceId };
    return this.tenantContext.runInWorkspaceContext(targetCtx, async (manager) => {
      const created = await this.managerService.createWithin(manager, targetCtx, { ...person, type: ManagerType.VENUE });
      const [{ user_id: createdUserId }] = await manager.query<Array<{ user_id: string }>>(
        'SELECT user_id FROM core.manager_profile WHERE id = $1',
        [created.id],
      );
      await this.auditService.record(manager, ctx, AuditAction.ADMIN_VENUE_MANAGER_CREATED, {
        entityType: 'user',
        entityId: createdUserId,
        targetUserId: createdUserId,
        // Identifiers and the action only. No email, password, token or other secret is written here.
        metadata: { targetWorkspaceId, action: 'venue_manager.create', actorUserId: ctx.userId },
      });
      return created;
    });
  }
}
