import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ManagerType, normalizeSubdomain } from '@rab/shared';
import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../../engine/core-modules/tenant/workspace-membership.service';
import { WorkspaceHostResolverService } from '../../../engine/core-modules/workspace-host/workspace-host-resolver.service';
import { CreateManagerWorkspaceDto } from '../dto/create-manager-workspace.dto';
import { UpdateManagerWorkspaceNameDto } from '../dto/update-manager-workspace-name.dto';
import { UpdateManagerWorkspaceSubdomainDto } from '../dto/update-manager-workspace-subdomain.dto';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';
import { SubdomainAvailability, SubdomainService } from './subdomain.service';
import { assertCallerMayProvision, WorkspaceProvisioningService } from './workspace-provisioning.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Wave 3 lane H — lane S2's write-time host-label enforcement (CONTRACT.md section 3), mapped to the same responses the
 * service's own pre-check gives. Throws for a recognised label violation; returns for anything else (caller rethrows).
 *   23505 (subdomain unique key, or `host_label_unavailable`: another organisation / a quarantine) -> 409 taken
 *   23P01 `host_label_claim_one_organisation` (EXCLUDE race backstop)                              -> 409 taken
 *   23514 `host_label_reserved`                                                                    -> 409 reserved
 *   23514 `host_label_shape`                                                                       -> 400
 */
function throwIfHostLabelViolation(error: unknown): void {
  if (typeof error !== 'object' || error === null) return;
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === POSTGRES_UNIQUE_VIOLATION || code === '23P01') throw new ConflictException('That subdomain was just taken.');
  if (code === '23514' && constraint === 'host_label_reserved') throw new ConflictException('This subdomain cannot be used.');
  if (code === '23514' && constraint === 'host_label_shape') throw new BadRequestException('Use 3-63 lowercase letters, numbers or hyphens.');
}

export interface ManagerWorkspaceResponse {
  id: string;
  name: string;
  subdomain: string;
  logoKey: string | null;
  status: string;
  /** P2.9C — the physical workspace-schema lifecycle (`core.manager_workspace.schema_status`): `'CREATING' | 'READY' | 'FAILED' | null`. Previously never exposed on this response at all — the Initial Manager invitation's "wait for READY" requirement (and any self-service caller polling after `create()`) needs it. Additive; every existing field is unchanged. */
  schemaStatus: string | null;
  onboardingCompletedAt: string | null;
  createdAt: Date;
  /**
   * Phase B P8 - NAVIGATION INFO ONLY, never an authorization input (every endpoint re-derives its own access server-side).
   * True only when the HWS runtime routing applies to THIS workspace for the calling session: `HWS_RUNTIME_ENABLED` is on
   * AND the session's server-resolved operational workspace (`ctx.workspaceId`, from `core.workspace_membership` via
   * `resolve_membership_for_session` - exactly what `TenantContextService` routes on) is this workspace. Then every
   * workspace-scoped request is refused until the schema is READY, so the web gate sends the owner to the preparation
   * screen. False with HWS off (requests run against core) and for a purely additive personal workspace (a Venue Manager's,
   * or a CEO's whose operational home is elsewhere), which no request ever routes through.
   */
  schemaRequired: boolean;
}

function toResponse(workspace: ManagerWorkspace, schemaRequired = false): ManagerWorkspaceResponse {
  return {
    id: workspace.id,
    name: workspace.name,
    subdomain: workspace.subdomain,
    logoKey: workspace.logoFileId ?? null, // opaque FILE ID (name kept for client compatibility)
    status: workspace.status,
    schemaStatus: workspace.schemaStatus ?? null,
    onboardingCompletedAt: workspace.onboardingCompletedAt?.toISOString() ?? null,
    createdAt: workspace.createdAt,
    schemaRequired,
  };
}

/**
 * Phase B P8 (inv-p8 finding 4): the caller's own `manager_workspace` row and its lifecycle are CORE-only data. Under
 * HWS_RUNTIME_ENABLED=true a session whose membership already points at its own not-yet-READY workspace would otherwise be
 * routed into that schema, which `SchemaResolverService` refuses (404) - so the preparation screen's poll and its resume
 * re-POST could never succeed. Same rule `WorkspaceProvisioningService.provisionOwnWorkspace` already applies. Only the
 * transaction's routing changes: the organisation and user stay bound from the verified session, never from the client.
 */
const coreOnly = (ctx: AuthContext): AuthContext => ({ ...ctx, workspaceId: null });

/**
 * `ManagerWorkspace` — a private, individually-owned workspace per Manager.
 * Not the same concept as `WorkspaceService`/`WorkspaceController`
 * (`modules/identity/`), which edits the shared Organisation's own
 * settings — see the entity's own doc comment for the naming rationale.
 */
@Injectable()
export class ManagerWorkspaceService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly workspaceMembership: WorkspaceMembershipService,
    private readonly auditService: AuditService,
    private readonly subdomainService: SubdomainService,
    private readonly fileService: FileService,
    private readonly entityCache: CoreEntityCacheService,
    private readonly provisioning: WorkspaceProvisioningService,
    private readonly hostResolver?: WorkspaceHostResolverService,
    private readonly environment?: EnvironmentService,
  ) {}

  /** See `ManagerWorkspaceResponse.schemaRequired`. `alsoRoutedHere`: this request itself just bound the workspace as the
   *  caller's operational home (create), so the session's next request routes through it although `ctx` predates that. */
  private schemaRequired(ctx: AuthContext, workspaceId: string, alsoRoutedHere = false): boolean {
    if (this.environment?.get('HWS_RUNTIME_ENABLED') !== true) return false;
    return ctx.workspaceId === workspaceId || alsoRoutedHere;
  }

  private withNavigation(ctx: AuthContext, response: ManagerWorkspaceResponse, alsoRoutedHere = false): ManagerWorkspaceResponse {
    return { ...response, schemaRequired: this.schemaRequired(ctx, response.id, alsoRoutedHere) };
  }

  private async ownManagerProfile(manager: EntityManager, ctx: AuthContext): Promise<ManagerProfile> {
    const profile = await manager.findOne(ManagerProfile, { where: { userId: ctx.userId } });
    // 404, not 403 — a Staff account (or anything else without a ManagerProfile)
    // must find this indistinguishable from a route that doesn't exist for them.
    if (!profile) throw new NotFoundException('Manager profile not found.');
    return profile;
  }

  private async ownWorkspace(manager: EntityManager, ctx: AuthContext): Promise<ManagerWorkspace> {
    const workspace = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
    if (!workspace) throw new NotFoundException('Workspace not found.');
    return workspace;
  }

  /**
   * Caller's own workspace, or 404 — never "first workspace" or any other fallback.
   *
   * Redis checkpoint — Core Entity Cache: the one read-only call site in this file that benefits
   * from caching — hit on most authenticated page loads for a manager's own app shell/branding,
   * rarely-changing fields. Deliberately NOT used by `ownWorkspace()` below, which every mutator in
   * this file also calls to compute a diff against the CURRENT row (e.g. which logo file to retire)
   * — those call sites need the uncached, definitely-fresh row, never a cached one.
   *
   * `opts.skipCache` (confirmed live finding, not theoretical): `provision-workspace-schema.ts`'s
   * isolated provisioner process writes `schema_status` directly via a raw `pg` connection, with no
   * NestJS DI and deliberately no Redis access (privilege separation — see that file's own doc
   * comment), so it has no way to invalidate THIS cache entry when a workspace goes CREATING →
   * READY. Without this bypass, `WorkspacePreparationScreen`'s active poll could keep observing a
   * cached CREATING snapshot for up to this cache's 5-minute TTL after the workspace is genuinely
   * READY — confirmed via the real request log (the DB row flipped to READY; the API kept returning
   * CREATING until the next cold cache miss). The controller passes this only for that one active
   * polling call site (`?fresh=1`); every ordinary caller of this route is unaffected.
   *
   * Implemented as a real `invalidate()` (the SAME epoch-bump every mutator in this file already
   * calls via `invalidateWorkspaceCache`), not merely skipping the cache READ for this one call: a
   * plain skip-the-read would leave the stale epoch's data in place for the NEXT ordinary (cached)
   * caller, e.g. a Settings tab open in another window polling the same account concurrently.
   * Invalidating first forces a genuine miss, so this call both reads AND repopulates the cache
   * under a fresh epoch — correct for every subsequent caller, not just this one.
   */
  async getMine(ctx: AuthContext, opts: { skipCache?: boolean } = {}): Promise<ManagerWorkspaceResponse> {
    const response = await this.tenantContext.runInTenantContext(coreOnly(ctx), async (manager): Promise<ManagerWorkspaceResponse> => {
      if (opts.skipCache) await this.entityCache.invalidate('manager_workspace_by_owner', ctx.userId);
      const cached = await this.entityCache.getManagerWorkspaceByOwner(manager, ctx.userId);
      if (cached) {
        return {
          id: cached.id,
          name: cached.name,
          subdomain: cached.subdomain,
          logoKey: cached.logoFileId,
          status: cached.status,
          schemaStatus: cached.schemaStatus,
          onboardingCompletedAt: cached.onboardingCompletedAt,
          createdAt: new Date(cached.createdAt),
          schemaRequired: false,
        };
      }
      const workspace = await this.ownWorkspace(manager, ctx);
      return toResponse(workspace);
    });
    // Session-dependent, so never cached: computed per request from this session's own routing.
    return this.withNavigation(ctx, response);
  }

  /**
   * Same shape as `WorkspaceService.update` — name is independent of subdomain, changing it never touches the live URL.
   *
   * Redis checkpoint — Core Entity Cache: invalidation runs AFTER `runInTenantContext`'s own
   * transaction has committed (see `CoreEntityCacheService`'s own doc comment for why ordering
   * matters for the "concurrent fill can't restore stale data" guarantee) — never inside the
   * callback, where a later statement in the same transaction could still roll everything back.
   */
  async updateName(ctx: AuthContext, dto: UpdateManagerWorkspaceNameDto): Promise<ManagerWorkspaceResponse> {
    const result = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.update(ManagerWorkspace, workspace.id, { name: dto.name.trim() });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
        metadata: { fields: ['name'] },
      });
      return toResponse(updated);
    });
    await this.invalidateWorkspaceCache(result.id, ctx.userId);
    return this.withNavigation(ctx, result);
  }

  async uploadLogo(ctx: AuthContext, buffer: Buffer): Promise<ManagerWorkspaceResponse> {
    const result = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      // Defensive invariant, not a client-reachable authorization branch: `stored_file`'s
      // RLS WITH CHECK validates workspace_id against core.current_workspace(), which is
      // bound from ctx.workspaceId (TenantContextService), not from this row lookup. If a
      // session's resolved workspace ever diverged from the workspace it actually owns,
      // failing here — before fileService.store's putObject — avoids writing an R2 object
      // that the immediately-following DB insert would then have RLS reject, orphaning it.
      if (ctx.workspaceId !== workspace.id) {
        throw new InternalServerErrorException('Session workspace context does not match the owned workspace.');
      }
      const file = await this.fileService.store(manager, {
        kind: FileKind.WORKSPACE_LOGO,
        organisationId: ctx.organisationId!,
        workspaceId: workspace.id,
        resourceType: 'manager_workspace',
        resourceId: workspace.id,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(ManagerWorkspace, workspace.id, { logoFileId: file.id });
      await this.retireLogo(manager, workspace.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: workspace.id,
        metadata: { fields: ['logo'] },
      });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      return toResponse(updated);
    });
    await this.invalidateWorkspaceCache(result.id, ctx.userId);
    return this.withNavigation(ctx, result);
  }

  /** Best-effort, never throws — see `CoreEntityCacheService.invalidate()`'s own contract. */
  private async invalidateWorkspaceCache(workspaceId: string, ownerUserId: string): Promise<void> {
    await this.entityCache.invalidate('manager_workspace', workspaceId);
    await this.entityCache.invalidate('manager_workspace_by_owner', ownerUserId);
  }

  /** Tombstones the replaced file (row kept as `DELETED`); its object is purged later by `storage:reconcile`, so a rolled-back transaction can never leave an AVAILABLE row whose object is already gone. */
  private async retireLogo(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  async deleteLogo(ctx: AuthContext): Promise<ManagerWorkspaceResponse> {
    const result = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.query(`UPDATE core.manager_workspace SET logo_file_id = NULL, logo_key = NULL, updated_at = now() WHERE id = $1`, [workspace.id]);
      await this.retireLogo(manager, workspace.logoFileId);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_UPDATED, {
        entityType: 'manager_workspace',
        entityId: workspace.id,
        metadata: { fields: ['logo'] },
      });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      return toResponse(updated);
    });
    await this.invalidateWorkspaceCache(result.id, ctx.userId);
    return this.withNavigation(ctx, result);
  }

  /**
   * The one and only place `onboardingCompletedAt` is ever written — called
   * by the web Create Profile step once the second onboarding step
   * finishes. Idempotent: calling it again just re-stamps the timestamp,
   * never errors — a double-submit or a retried request must not fail.
   */
  async completeOnboarding(ctx: AuthContext): Promise<ManagerWorkspaceResponse> {
    // Core-only (see `coreOnly`): the profile step completes before the schema may be READY (a DEFERRED or FAILED create).
    const result = await this.tenantContext.runInTenantContext(coreOnly(ctx), async (manager) => {
      const workspace = await this.ownWorkspace(manager, ctx);
      await manager.update(ManagerWorkspace, workspace.id, { onboardingCompletedAt: new Date() });
      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_ONBOARDING_COMPLETED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
      });
      return toResponse(updated);
    });
    await this.invalidateWorkspaceCache(result.id, ctx.userId);
    return this.withNavigation(ctx, result);
  }

  /**
   * Atomic: verify caller is a Manager -> verify they don't already own a
   * workspace -> normalize/validate/check the requested subdomain -> insert
   * -> audit. `ownerUserId`/`organisationId` are always derived from `ctx`,
   * never the request body (`CreateManagerWorkspaceDto` whitelists only
   * `name`/`subdomain`). The DB's own `UNIQUE(subdomain)` constraint is the
   * real race-condition backstop — `SubdomainService`'s own check just
   * gives a clean 409-with-suggestions instead of a raw constraint error in
   * the (rare) case two requests for the same subdomain land concurrently.
   */
  async create(ctx: AuthContext, dto: CreateManagerWorkspaceDto): Promise<ManagerWorkspaceResponse> {
    // Phase B P8 (inv-p8 finding 4): every step below is core-only - never routed through the caller's own not-yet-READY
    // workspace schema, which HWS_RUNTIME_ENABLED=true would refuse (404) on the owner's resume / retry re-POST.
    const core = coreOnly(ctx);
    // 1. Create (or recognise a replay of) the workspace row — one committed transaction, exactly as before.
    let created: ManagerWorkspaceResponse;
    try {
      created = await this.tenantContext.runInTenantContext(core, async (manager) => {
        // Layer 2 (CLAUDE.md five-layer rule, inv-security F3): a suspended organisation or an account that is not active
        // never creates or resumes a workspace, even when this service is reached without the HTTP guard chain.
        await assertCallerMayProvision(manager, core);
        const replay = await this.findReplay(manager, core, dto);
        if (replay) return toResponse(replay);
        return this.createFor(manager, core, { ownerUserId: ctx.userId, name: dto.name, subdomain: dto.subdomain });
      });
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      // A concurrent IDENTICAL request (double click, client retry after a lost response) committed first and this one
      // lost the owner/subdomain unique race. That is a replay, not a conflict: answer with the same workspace.
      const replay = await this.tenantContext.runInTenantContext(core, (manager) => this.findReplay(manager, core, dto));
      if (!replay) throw error;
      created = toResponse(replay);
    }

    // 2. Server-path provisioning (Twenty-style), on this request, over the same restricted connection. A first attempt,
    //    a duplicate, a second replica and a retry after FAILED/stranded CREATING all converge here; the database function
    //    serialises them and READY happens exactly once. Expected races and infrastructure failures never become a 500:
    //    the response reports the workspace's real lifecycle state, which the client polls.
    const outcome = await this.provisioning.provisionOwnWorkspace(ctx, created.id);
    let final = created;
    let routedHere = false;
    try {
      ({ final, routedHere } = await this.tenantContext.runInTenantContext(core, async (manager) => {
        const workspace = outcome === 'DEFERRED' ? null : await manager.findOneByOrFail(ManagerWorkspace, { id: created.id });
        // Navigation only: the owner's profile bound to this workspace = the session's operational home from its next
        // request on (createFor binds profile and membership together), although this request's ctx predates it.
        const profile = await manager.findOne(ManagerProfile, { where: { userId: ctx.userId } });
        return { final: workspace ? toResponse(workspace) : created, routedHere: profile?.workspaceId === created.id };
      }));
    } catch {
      // Best-effort re-read: the committed lifecycle is unchanged and the client polls.
    }
    return this.withNavigation(ctx, final, routedHere);
  }

  /**
   * The caller's own workspace when this request repeats the one that created it (same name, same normalised subdomain),
   * so a retried or double-submitted create is idempotent. Owning a workspace and asking for a DIFFERENT one is still the
   * original 409. `ownerUserId` is always the authenticated caller, never a request field.
   */
  private async findReplay(manager: EntityManager, ctx: AuthContext, dto: CreateManagerWorkspaceDto): Promise<ManagerWorkspace | null> {
    const owned = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
    if (!owned) return null;
    if (owned.name !== dto.name.trim() || owned.subdomain !== normalizeSubdomain(dto.subdomain)) {
      throw new ConflictException('This manager already has a workspace.');
    }
    return owned;
  }

  /**
   * P2.9C — the actual creation steps, factored out of `create()` so `OrganisationOnboardingService
   * .inviteInitialManager()` can reuse them with an OWNER different from the acting caller
   * (a CEO/Platform Admin inviting someone else, not self-service). `ctx.organisationId` is the
   * target org to bind (ALWAYS required); `ctx.userId` is used ONLY for audit attribution — it is
   * the ACTOR, which for self-service `create()` happens to equal `params.ownerUserId`, and for an
   * invite-time call does not. The actual workspace membership/profile binding always uses
   * `params.ownerUserId`, never `ctx.userId`.
   *
   * Gap-review finding (universal self-service workspace checkpoint): this method used to
   * unconditionally overwrite `ownProfile.workspaceId` and insert a `workspace_membership` row for
   * EVERY caller. That's correct for `type: 'internal'` — a Manager's personal workspace IS their
   * operational home, the one `JwtAuthGuard` resolves through. It is WRONG for `type: 'ceo'`/
   * `'venue'` — for those types `ManagerProfile.workspaceId` means operational MEMBERSHIP in
   * someone else's workspace (see that column's own doc comment), a completely different concept
   * from "I personally own this workspace row". Blindly overwriting it would have corrupted an
   * existing operational assignment; `workspace_membership`'s own `..._one_active_per_target`
   * unique index would have outright rejected the insert for anyone who already has one. Deriving
   * `bindsOperationalHome` from the profile's own `type` (never a caller-supplied parameter — this
   * is authorization-relevant, so it is never trusted from outside) means a CEO/Super-Admin/Venue
   * Manager's personal workspace is purely additive: owned (`manager_workspace.owner_user_id`),
   * schema-provisioned, subdomain-routable — and otherwise completely inert. Confirmed safe by a
   * second, independent fact: `AuthSecuritySnapshotService.loadSecurityRow` (the actual permission
   * resolver) never references `manager_workspace` at all — owning one grants no permission
   * anywhere in this codebase today.
   */
  async createFor(
    manager: EntityManager,
    ctx: AuthContext,
    params: { ownerUserId: string; name: string; subdomain: string },
  ): Promise<ManagerWorkspaceResponse> {
    const ownProfile = await manager.findOne(ManagerProfile, { where: { userId: params.ownerUserId } });
    if (!ownProfile) throw new NotFoundException('Manager profile not found.');
    const bindsOperationalHome =
      ownProfile.type === ManagerType.INTERNAL || (await this.ceoClaimsOwnWorkspaceAsHome(manager, ctx, params.ownerUserId, ownProfile));

    const alreadyOwned = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: params.ownerUserId } });
    if (alreadyOwned) throw new ConflictException('This manager already has a workspace.');

    // Re-checked INSIDE the write transaction (wave 3 lane H); the database's own constraints remain the race backstop.
    const availability = await this.subdomainService.checkAvailability(params.subdomain, null, manager);
    if (!availability.available) {
      throw new ConflictException({
        message: availability.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.',
        normalized: availability.normalized,
        suggested: availability.suggested,
        alternatives: availability.alternatives,
      });
    }

    const workspace = manager.create(ManagerWorkspace, {
      organisationId: ctx.organisationId!,
      ownerUserId: params.ownerUserId,
      name: params.name.trim(),
      subdomain: availability.normalized,
      status: 'active',
      // Explicit, non-routable initial schema lifecycle (core.workspace_schema_routable()). `create()` drives it to READY
      // (or FAILED) right after this transaction commits, through WorkspaceProvisioningService -> the narrow SECURITY
      // DEFINER core.provision_workspace(uuid) (migration 1786719500000). This method itself never runs DDL.
      schemaStatus: 'CREATING',
    });
    try {
      await manager.save(workspace);
    } catch (error) {
      throwIfHostLabelViolation(error);
      throw error;
    }

    // This Manager now owns a real Workspace. Membership is written just
    // below (assignOwnWorkspace), which is what every subsequent request's
    // JwtAuthGuard resolves through. Stamping the
    // profile's own workspace_id too keeps manager_profile self-consistent
    // for any code that reads it directly rather than re-resolving.
    // A profile is bound to exactly one workspace. Only an UNBOUND profile (NULL) takes the server-created workspace; an already-bound
    // profile is never rebound from here. The value comes from the workspace the server just created, never from the request.
    //
    // ONLY for type: 'internal', or a self-service CEO with no operational home yet (see
    // `ceoClaimsOwnWorkspaceAsHome`). Venue Managers, and any CEO who already has an operational
    // assignment, keep a purely additive personal workspace.
    if (bindsOperationalHome) {
      if (ownProfile.workspaceId) throw new ConflictException('This manager profile is already bound to a workspace.');
      // Trusted server context: the new workspace is bound for this transaction, so manager_profile_tenant WITH CHECK checks the write
      // against it (workspace_id = current workspace). The binding is transaction-local.
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspace.id]);
      await manager.update(ManagerProfile, { id: ownProfile.id }, { workspaceId: workspace.id });

      // Hyper Workspace Phase 3: the owner's membership is this new workspace. The request context has no workspace
      // yet, so assignOwnWorkspace binds it for this one INSERT and restores the previous value. Always bound to the
      // real OWNER's id, never the acting caller's — see this method's own doc comment.
      await this.workspaceMembership.assignOwnWorkspace(manager, { ...ctx, userId: params.ownerUserId }, workspace.id);
    }

    await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_CREATED, {
      targetUserId: params.ownerUserId,
      entityType: 'manager_workspace',
      entityId: workspace.id,
      metadata: { subdomain: workspace.subdomain },
    });

    return toResponse(workspace);
  }

  /**
   * Owner decision (2026-10-13): a CEO (including a Platform Super Admin's CEO identity) who creates
   * their OWN workspace through self-service, and has no operational workspace anywhere yet, gets it
   * as their operational home — otherwise the workspace they just built is one they cannot use, and
   * every workspace-scoped endpoint answers 404. Deliberately narrow:
   *   - self-service only (actor === owner) — invite-time creation for someone else never binds here;
   *   - never when the profile is already bound or the user already holds an active membership —
   *     an existing operational assignment is never overridden (the one-active-per-user index would
   *     also reject it);
   *   - Platform Admin status plays no part — the grant comes from owning this one workspace.
   * Venue Managers keep the inert personal-workspace behaviour.
   */
  private async ceoClaimsOwnWorkspaceAsHome(
    manager: EntityManager,
    ctx: AuthContext,
    ownerUserId: string,
    ownProfile: ManagerProfile,
  ): Promise<boolean> {
    if (ownProfile.type !== ManagerType.CEO || ownerUserId !== ctx.userId || ownProfile.workspaceId) return false;
    const active = await manager.query(
      `SELECT 1 FROM core.workspace_membership WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [ownerUserId],
    );
    return active.length === 0;
  }

  /**
   * Reuses the identical normalization/validation/reserved-check/
   * availability pipeline as `create` — only the Workspace owner may call
   * this (structurally true here: it only ever operates on the caller's
   * OWN workspace, never an id from the request).
   */
  async updateSubdomain(ctx: AuthContext, dto: UpdateManagerWorkspaceSubdomainDto): Promise<ManagerWorkspaceResponse> {
    let renamed: { oldSubdomain: string; newSubdomain: string } | null = null;
    const result = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const workspace = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
      if (!workspace) throw new NotFoundException('Workspace not found.');

      const availability = await this.subdomainService.checkAvailability(dto.subdomain, workspace.id, manager);
      if (!availability.available) {
        throw new ConflictException({
          message: availability.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.',
          normalized: availability.normalized,
          suggested: availability.suggested,
          alternatives: availability.alternatives,
        });
      }

      if (availability.normalized === workspace.subdomain) return toResponse(workspace);

      const oldSubdomain = workspace.subdomain;
      try {
        // Lane S2's trigger releases the old label into rename quarantine (core.released_host_label) in this same
        // statement; only this workspace may reclaim it before it expires. This service never writes those tables.
        await manager.update(ManagerWorkspace, workspace.id, { subdomain: availability.normalized });
      } catch (error) {
        throwIfHostLabelViolation(error);
        throw error;
      }

      const updated = await manager.findOneByOrFail(ManagerWorkspace, { id: workspace.id });
      const oldLabelQuarantinedUntil = await this.subdomainService.quarantineUntil(manager);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_WORKSPACE_SUBDOMAIN_CHANGED, {
        entityType: 'manager_workspace',
        entityId: updated.id,
        // `oldLabelQuarantinedUntil`: when lane S2's quarantine released the old label until (layer-2 record of the DB's own row).
        metadata: { oldSubdomain, newSubdomain: updated.subdomain, ...(oldLabelQuarantinedUntil ? { oldLabelQuarantinedUntil } : {}) },
      });
      renamed = { oldSubdomain, newSubdomain: updated.subdomain };
      return toResponse(updated);
    });
    await this.invalidateWorkspaceCache(result.id, ctx.userId);
    // Wave 3 lane H (C13): the old host now redirects (quarantine) and the new one routes - drop both cached answers and
    // this process's origin-trust snapshot, after the commit. Best-effort, never throws.
    const change = renamed as { oldSubdomain: string; newSubdomain: string } | null;
    if (change) await this.hostResolver?.invalidateLabels(change.oldSubdomain, change.newSubdomain);
    return this.withNavigation(ctx, result);
  }

  /**
   * The live availability check for the signed-in Manager (C3): their OWN workspace (and its own quarantined labels) are
   * excluded, so re-typing the current label reads "available" instead of "taken". The workspace id is the caller's own
   * (looked up by `ctx.userId`), never a request field.
   */
  async checkSubdomainFor(ctx: AuthContext, candidate: string): Promise<SubdomainAvailability> {
    const ownId = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const own = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
      return own?.id ?? null;
    });
    return this.subdomainService.checkAvailability(candidate, ownId);
  }

  /**
   * Twenty-style subdomain suggestions (C3) from server-derived inputs only: the caller's own email domain (unless a free
   * provider), the workspace name being typed, and the organisation's display name. Up to three available labels.
   */
  async suggestSubdomains(ctx: AuthContext, workspaceName: string | undefined): Promise<{ suggestions: string[] }> {
    const { email, organisationName, ownId } = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const [user] = await manager.query<Array<{ email: string }>>('SELECT email FROM core."user" WHERE id = $1', [ctx.userId]);
      const [org] = ctx.organisationId
        ? await manager.query<Array<{ name: string }>>('SELECT name FROM core.organisation WHERE id = $1', [ctx.organisationId])
        : [];
      const own = await manager.findOne(ManagerWorkspace, { where: { ownerUserId: ctx.userId } });
      return { email: user?.email ?? null, organisationName: org?.name ?? null, ownId: own?.id ?? null };
    });
    const suggestions = await this.subdomainService.suggest({ email, workspaceName, organisationName }, ownId);
    return { suggestions };
  }
}
