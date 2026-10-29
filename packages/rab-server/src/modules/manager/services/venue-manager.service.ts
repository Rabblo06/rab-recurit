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
import { ListVenueTeamCandidatesDto } from '../dto/list-venue-team-candidates.dto';
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
    // Layer 2 for this route's own flag (never the /managers route's MANAGER_MANAGE): see ManagerService.addNote.
    return this.managerService.addNote(ctx, id, dto, PermissionFlag.VENUE_MANAGER_CREATE);
  }

  async listEmails(ctx: AuthContext, id: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.listEmails(ctx, id);
  }

  async deleteUser(ctx: AuthContext, id: string, currentPassword: string) {
    await this.assertOwnWorkspaceVenueManager(ctx, id);
    return this.managerService.deleteUser(ctx, id, currentPassword);
  }

  // ------------------------------------------------------------------ Venue Manager teams (Assigned Staff)
  //
  // ONE implementation (`*Within` below) serves two authorised entry points, so the team SQL, the all-or-nothing
  // eligibility rules and the audit rows are written once:
  //   - workspace owner (Initial Manager or any other owner): `listTeam` / `assignTeamStaff` / `removeTeamStaff`, scoped
  //     to the caller's own workspace, exactly as before;
  //   - organisation administrator (owner decision 2026-10-28; effective `manager.manage`, overrides honoured — the CEO
  //     by default, a platform admin only in their own organisation): `*AsOrgAdmin`, scoped to the Venue Manager's own
  //     workspace, derived server-side from the Venue Manager record. Admin Inspect stays read-only (CF-02).
  // Each entry point returns the AuthContext the shared implementation runs under; the client never names a workspace.

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

  /** Workspace-owner entry point: the caller's own workspace, unchanged rules. */
  private async ownerTeamScope(ctx: AuthContext, venueManagerId: string): Promise<TeamScope> {
    await this.assertOwnWorkspaceVenueManager(ctx, venueManagerId);
    await this.assertWorkspaceOwner(ctx);
    return { ctx, flow: 'workspace_owner' };
  }

  /**
   * Organisation-administrator entry point (layer 2; the route's PermissionGuard is layer 1). Re-checks `manager.manage`
   * through PermissionsService, which honours per-user grant and revoke overrides, then derives the workspace from the
   * Venue Manager record of the caller's own organisation and confirms it is an active workspace of that organisation.
   * A Venue Manager outside the organisation, or with no workspace, reads as not found (404, no existence oracle).
   */
  private async orgAdminTeamScope(ctx: AuthContext, venueManagerId: string): Promise<TeamScope> {
    if (!ctx.organisationId) throw new NotFoundException('Venue Manager not found.');
    if (!(await this.permissions.userHasPermission(ctx, PermissionFlag.MANAGER_MANAGE))) {
      throw new ForbiddenException('Managing Manager accounts is not permitted.');
    }
    const profile = await this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager.findOne(ManagerProfile, { where: { id: venueManagerId, organisationId: ctx.organisationId!, type: ManagerType.VENUE } }),
    );
    if (!profile?.workspaceId) throw new NotFoundException('Venue Manager not found.');
    const [{ ok }] = await this.dataSource.query<Array<{ ok: boolean }>>('SELECT core.admin_workspace_in_org($1, $2) AS ok', [
      profile.workspaceId,
      ctx.organisationId,
    ]);
    if (!ok) throw new NotFoundException('Venue Manager not found.');
    return { ctx: { ...ctx, workspaceId: profile.workspaceId }, flow: 'org_admin' };
  }

  /**
   * Opens the workspace transaction for a resolved scope. The org-admin flow binds `rab.admin_scope = 'venue_team'`, which
   * the module-18 policies (venue_manager_staff_org_admin, staff_profile_org_admin_picker) require; the owner flow binds
   * nothing new and keeps exactly its previous database visibility.
   */
  private runInTeamScope<T>(scope: TeamScope, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInWorkspaceContext(scope.ctx, async (manager) => {
      if (scope.flow === 'org_admin') await manager.query(`SELECT set_config('rab.admin_scope', 'venue_team', true)`);
      return fn(manager);
    });
  }

  /** The Staff a Venue Manager of the caller's workspace can currently see and select. */
  async listTeam(ctx: AuthContext, venueManagerId: string) {
    return this.listTeamWithin(await this.ownerTeamScope(ctx, venueManagerId), venueManagerId);
  }

  async listTeamAsOrgAdmin(ctx: AuthContext, venueManagerId: string) {
    return this.listTeamWithin(await this.orgAdminTeamScope(ctx, venueManagerId), venueManagerId);
  }

  private async listTeamWithin(scope: TeamScope, venueManagerId: string) {
    const ctx = scope.ctx;
    return this.runInTeamScope(scope, (manager) =>
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
   * not an assignable Staff member of this workspace (unknown, another workspace's, archived, suspended/deactivated/inactive)
   * fails the whole request with 404 and nothing is written. Already-assigned ids are reported, never duplicated. Creates
   * no account, offer, shift, attendance or venue assignment.
   */
  async assignTeamStaff(ctx: AuthContext, venueManagerId: string, dto: AssignVenueTeamStaffDto) {
    return this.assignTeamStaffWithin(await this.ownerTeamScope(ctx, venueManagerId), venueManagerId, dto);
  }

  async assignTeamStaffAsOrgAdmin(ctx: AuthContext, venueManagerId: string, dto: AssignVenueTeamStaffDto) {
    return this.assignTeamStaffWithin(await this.orgAdminTeamScope(ctx, venueManagerId), venueManagerId, dto);
  }

  private async assignTeamStaffWithin(scope: TeamScope, venueManagerId: string, dto: AssignVenueTeamStaffDto) {
    const ctx = scope.ctx;
    return this.runInTeamScope(scope, async (manager) => {
      // `sp.archived_at IS NULL` (2026-10-29, security review): the same rule as the org-admin picker
      // (listAssignableStaffAsOrgAdmin). It applies to the workspace-owner path too: an archived Staff member, previously
      // assignable there by a direct POST, is now 404 like any other ineligible id.
      const eligible: Array<{ id: string }> = await manager.query(
        `SELECT sp.id FROM staff_profile sp JOIN core."user" u ON u.id = sp.user_id
         WHERE sp.id = ANY($1::uuid[]) AND sp.organisation_id = $2 AND sp.workspace_id = $3 AND sp.archived_at IS NULL
           AND sp.employment_status IN ('active', 'pending_compliance') AND u.status IN ('active', 'invited')`,
        [dto.staffProfileIds, ctx.organisationId, ctx.workspaceId],
      );
      if (eligible.length !== dto.staffProfileIds.length) throw new NotFoundException('Staff member not found.');
      // The target is re-checked in the WRITE statement itself (one snapshot with the insert): the Venue Manager must still
      // be a `venue` profile of this organisation and workspace (a moved one gets no row). The org-admin flow resolved its
      // workspace in an earlier transaction, so it also requires, at write time, that the Venue Manager is still active or
      // invited (not suspended / deactivated / invite-expired) and the workspace still active (core.admin_workspace_in_org,
      // the same lookup orgAdminTeamScope used). The owner flow keeps its previous rules (owner decision: no change).
      // No live target = nothing written, 404 as for any target outside scope.
      const [result]: Array<{ live: boolean; added: string[] }> = await manager.query(
        `WITH target AS (
           SELECT mp.id FROM core.manager_profile mp JOIN core."user" mu ON mu.id = mp.user_id
            WHERE mp.id = $3 AND mp.organisation_id = $1 AND mp.workspace_id = $2 AND mp.type = 'venue'
              AND (NOT $5::boolean OR (mu.status IN ('active', 'invited') AND core.admin_workspace_in_org($2, $1)))
         ), inserted AS (
           INSERT INTO venue_manager_staff (organisation_id, workspace_id, manager_profile_id, staff_profile_id)
           SELECT $1, $2, target.id, s.id FROM target CROSS JOIN unnest($4::uuid[]) AS s(id)
           ON CONFLICT (manager_profile_id, staff_profile_id) DO NOTHING
           RETURNING staff_profile_id
         )
         SELECT EXISTS (SELECT 1 FROM target) AS live, ARRAY(SELECT staff_profile_id::text FROM inserted) AS added`,
        [ctx.organisationId, ctx.workspaceId, venueManagerId, dto.staffProfileIds, scope.flow === 'org_admin'],
      );
      if (!result?.live) throw new NotFoundException('Venue Manager not found.');
      const added = result.added;
      const alreadyAssigned = dto.staffProfileIds.filter((id) => !added.includes(id));
      if (added.length) {
        await this.auditService.record(manager, ctx, AuditAction.VENUE_TEAM_STAFF_ASSIGNED, {
          entityType: 'manager',
          entityId: venueManagerId,
          metadata: { staffProfileIds: added, workspaceId: ctx.workspaceId, ...flowMetadata(scope) },
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
    await this.removeTeamStaffWithin(await this.ownerTeamScope(ctx, venueManagerId), venueManagerId, staffProfileId);
  }

  async removeTeamStaffAsOrgAdmin(ctx: AuthContext, venueManagerId: string, staffProfileId: string): Promise<void> {
    await this.removeTeamStaffWithin(await this.orgAdminTeamScope(ctx, venueManagerId), venueManagerId, staffProfileId);
  }

  /**
   * Org-admin "Select Staff" list ("picker only"): the assignable Staff of the Venue Manager's own workspace, in the row
   * shape the existing VenueManagerStaffPicker already reads from GET /staff. The workspace owner's picker keeps using
   * GET /staff (their own creator-scoped list), which an organisation administrator cannot use for another workspace by
   * design. Same eligibility as assignTeamStaffWithin, so nothing listed here is refused on Confirm for status reasons.
   */
  async listAssignableStaffAsOrgAdmin(ctx: AuthContext, venueManagerId: string, dto: ListVenueTeamCandidatesDto) {
    const scope = await this.orgAdminTeamScope(ctx, venueManagerId);
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 25;
    const q = dto.q?.trim() ? `%${dto.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return this.runInTeamScope(scope, async (manager) => {
      const rows: Array<{ total: number } & Record<string, unknown>> = await manager.query(
        `SELECT sp.id, u.first_name AS "firstName", u.last_name AS "lastName", sp.staff_ref AS "staffRef", u.email, u.phone,
                sp.employment_status AS "employmentStatus", u.status AS "accountStatus", sp.created_at AS "createdAt",
                count(*) OVER ()::int AS total
           FROM staff_profile sp JOIN core."user" u ON u.id = sp.user_id
          WHERE sp.organisation_id = $1 AND sp.workspace_id = $2 AND sp.archived_at IS NULL
            AND sp.employment_status IN ('active', 'pending_compliance') AND u.status IN ('active', 'invited')
            AND ($3::text IS NULL OR u.first_name ILIKE $3 OR u.last_name ILIKE $3 OR sp.staff_ref ILIKE $3)
          ORDER BY u.first_name, u.last_name, sp.id
          LIMIT $4 OFFSET $5`,
        [scope.ctx.organisationId, scope.ctx.workspaceId, q, limit, (page - 1) * limit],
      );
      return { data: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 };
    });
  }

  private async removeTeamStaffWithin(scope: TeamScope, venueManagerId: string, staffProfileId: string): Promise<void> {
    const ctx = scope.ctx;
    await this.runInTeamScope(scope, async (manager) => {
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
        metadata: { staffProfileId, workspaceId: ctx.workspaceId, ...flowMetadata(scope) },
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

/** An authorised Assigned Staff scope: the context the shared implementation runs under, and which entry point produced it. */
interface TeamScope {
  ctx: AuthContext;
  flow: 'workspace_owner' | 'org_admin';
}

/** Audit metadata for the entry point: owner rows stay exactly as before; org-admin rows say so. */
function flowMetadata(scope: TeamScope): { flow?: 'org_admin' } {
  return scope.flow === 'org_admin' ? { flow: 'org_admin' } : {};
}
