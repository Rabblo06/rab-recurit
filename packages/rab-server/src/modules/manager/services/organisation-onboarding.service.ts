import { ManagerType, UserStatus } from '@rab/shared';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { renderInitialManagerInvitationEmail } from '../../../engine/core-modules/email/templates';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInvite } from '../../identity/entities/account-invite.entity';
import { ManagerWorkspaceService } from '../../manager-workspace/services/manager-workspace.service';
import { Organisation, User } from '../../identity/entities';
import { ManagerProfile } from '../entities/manager-profile.entity';
import { CreateOrganisationDto } from '../dto/create-organisation.dto';
import { InviteInitialManagerDto } from '../dto/invite-initial-manager.dto';
import { ReplaceInitialManagerDto } from '../dto/replace-initial-manager.dto';
import { ManagerService, ManagerSummary } from './manager.service';

/** Mirrors `AccountInviteService`'s own `MAX_SEND_ATTEMPTS` (not exported there) — replacement is only ever offered once resend is no longer possible at all. */
const INITIAL_MANAGER_MAX_SEND_ATTEMPTS = 3;
/** CEO-route replacement cap, lifetime per organisation — mirrors the 3-send philosophy. The Super-Admin route (`replaceInitialManagerAsAdmin`-equivalent access, same method, `isPlatformAdmin` branch) is deliberately uncapped — the explicit, already-audited recovery procedure once this cap is reached. */
const INITIAL_MANAGER_MAX_REPLACEMENTS = 3;
/** Closes the "cancel the final attempt the instant it's sent, then replace immediately" loophole — a NATURALLY expired final attempt needs no extra wait (expiry windows already run multiple days), but an explicitly-revoked one does. */
const INITIAL_MANAGER_REPLACE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface OrganisationSummary {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: Date;
  ceo: ManagerSummary | null;
  /**
   * P2.9 gap review, item 1 (owner-approved) — additive only, every existing field above is
   * unchanged. Resolved exactly the way `ceo` already is: the same `runInTenantContext` call
   * already bound to this (target) organisation, the same `ManagerService.get()` lookup, behind
   * the same `PlatformAdminGuard`/`assertActorIsPlatformAdmin` check `getOrganisation` already
   * had. No new table, column, migration, RLS policy, SECURITY DEFINER function or guard.
   */
  initialManager: ManagerSummary | null;
}

/** Deliberately narrower than `ManagerSummary` — `listOrganisations()` reads from `core.list_organisations_for_admin()`'s own fixed column set (one cross-tenant query, not per-org `ManagerService.get()` calls), so it can only ever offer what that function actually returns. */
export interface CeoListInfo {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  accountStatus: string;
}

export interface OrganisationListItem {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: Date;
  ceo: CeoListInfo | null;
}

/** The nil UUID — never a real organisation id, used only to make `organisation_slug_taken`'s `id <> $2` exclusion a no-op when there is no organisation to exclude yet (passing a literal `NULL` there would make `<>` evaluate to `NULL` for every row, so `EXISTS(...)` would always read `false`). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * P2.9B — Platform Super Admin creates a new organisation and invites its first CEO, in one
 * action. Lives under `modules/manager/`, not `engine/core-modules/platform-admin/`, because it
 * depends on `ManagerService` (CLAUDE.md: `engine/` never imports from `modules/` — this service
 * is domain orchestration, even though every caller of it is platform-admin-gated).
 *
 * `core.organisation` is NOT FORCEd (CLAUDE.md's own exemption list) but its `organisation_self`
 * RLS policy (`id = core.current_org()`) still binds the ordinary runtime role for everything
 * EXCEPT the table owner — and a brand-new row's id can never already equal whatever
 * `current_org()` happens to be bound to, so there was never a way to INSERT a first row from an
 * ordinary request. `core.create_organisation()` (`CreateOrganisationFunction1786706000000`) is
 * the fix: a narrow SECURITY DEFINER function, same precedent as `organisation_slug_taken`/
 * `provision_workspace_schema`. Once the row exists, EVERYTHING else (CEO user, role, invite,
 * audit) runs through the completely ordinary `runInTenantContext`/RLS-enforced path, bound to the
 * new organisation's own id — exactly like any other request for that tenant.
 *
 * CEO creation itself is NOT reimplemented here — `ManagerService.createWithin()` already owns
 * user/role/membership/profile/invite/audit for every manager type, including the
 * platform-admin-only check for `type: 'ceo'` (`assertCeoMutationAllowed`/the inline check in
 * `createWithin`, backed by `CeoCreationGuard` at the HTTP layer for the ordinary same-org route).
 * This service only adds the ONE missing piece — creating the organisation itself — then binds a
 * context to it and delegates.
 */
@Injectable()
export class OrganisationOnboardingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly managerService: ManagerService,
    private readonly managerWorkspaceService: ManagerWorkspaceService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly auditService: AuditService,
  ) {}

  async createOrganisationWithCeoInvite(
    actorCtx: Pick<AuthContext, 'userId'>,
    dto: CreateOrganisationDto,
  ): Promise<OrganisationSummary> {
    await this.assertActorIsPlatformAdmin(actorCtx);

    const slug = await this.resolveUniqueSlug(dto.name);
    const [{ create_organisation: organisationId }] = await this.dataSource.query<Array<{ create_organisation: string }>>(
      'SELECT core.create_organisation($1, $2) AS create_organisation',
      [dto.name, slug],
    );

    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    // `sendAccountInvite`'s suspension check inside `createWithin` is always a no-op here (the
    // organisation was just created, never suspended) — reused unconditionally rather than
    // special-cased, same as every other caller.
    const ceo = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_CREATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { name: dto.name, slug },
      });
      return this.managerService.createWithin(manager, ctx, {
        email: dto.ceoEmail,
        firstName: dto.ceoFirstName,
        lastName: dto.ceoLastName,
        type: ManagerType.CEO,
      });
    });

    return this.toOrganisationSummary(organisationId, dto.name, slug, false, new Date(), ceo);
  }

  async getOrganisation(actorCtx: Pick<AuthContext, 'userId'>, organisationId: string): Promise<OrganisationSummary> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const org = await manager.findOneBy(Organisation, { id: organisationId });
      if (!org) throw new NotFoundException('Organisation not found.');
      const ceoProfile = await manager.findOne(ManagerProfile, { where: { organisationId, type: ManagerType.CEO } });
      const ceo = ceoProfile ? await this.managerService.get(ctx, ceoProfile.id) : null;
      const initialManagerProfile = await manager.findOne(ManagerProfile, {
        where: { organisationId, type: ManagerType.INTERNAL, isInitialManager: true, supersededAt: IsNull() },
      });
      const initialManager = initialManagerProfile ? await this.managerService.get(ctx, initialManagerProfile.id) : null;
      return this.toOrganisationSummary(org.id, org.name, org.slug, org.suspendedAt != null, org.createdAt, ceo, initialManager);
    });
  }

  /**
   * Platform-wide, genuinely cross-tenant — see `ListOrganisationsForAdmin1786707000000`'s own
   * doc comment for why this needs a dedicated SECURITY DEFINER function rather than the ordinary
   * per-org RLS path. `rab_secure_owner` (that function's owner) is deliberately NOT granted
   * BYPASSRLS (CLAUDE.md: never weaken RLS broadly to solve one narrow case) and does not own
   * `core.manager_profile` (owned by `crewflow`) — so the function's own internal read of that
   * table is still subject to `manager_profile_tenant`'s policy, specifically the
   * `core.is_active_platform_admin(core.current_uid())` branch `ManagerProfilePlatformAdminRls
   * 1786708000000` added. That branch needs `rab.user_id` actually bound to resolve `current_uid()`
   * — binding JUST that one GUC (never `organisation_id`, since this read is genuinely cross-org)
   * inside an explicit transaction, so the `SET LOCAL` and the function call share one connection.
   */
  async listOrganisations(actorCtx: Pick<AuthContext, 'userId'>): Promise<OrganisationListItem[]> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const rows = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [actorCtx.userId]);
      return manager.query<
        Array<{
          id: string;
          name: string;
          slug: string;
          suspendedAt: string | null;
          createdAt: string;
          ceoUserId: string | null;
          ceoEmail: string | null;
          ceoFirstName: string | null;
          ceoLastName: string | null;
          ceoStatus: string | null;
        }>
      >('SELECT * FROM core.list_organisations_for_admin()');
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      suspended: row.suspendedAt != null,
      createdAt: new Date(row.createdAt),
      ceo: row.ceoUserId
        ? { id: row.ceoUserId, email: row.ceoEmail!, firstName: row.ceoFirstName!, lastName: row.ceoLastName!, accountStatus: row.ceoStatus! }
        : null,
    }));
  }

  async resendCeoInvite(actorCtx: Pick<AuthContext, 'userId'>, organisationId: string): Promise<{ sendNumber: number; expiresAt: Date; queued: boolean }> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const ceoProfileId = await this.findCeoProfileIdOrFail(ctx);
    // Reuses the generic template (not `renderCeoInvitationEmail`) — `ManagerService.resendInvite`
    // doesn't take a template override today; documented as a known, deliberate scope limit (the
    // first send already carries the CEO-specific subject) rather than extended further here.
    return this.managerService.resendInvite(ctx, ceoProfileId);
  }

  async revokeCeoInvite(actorCtx: Pick<AuthContext, 'userId'>, organisationId: string): Promise<void> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const ceoProfileId = await this.findCeoProfileIdOrFail(ctx);
    return this.managerService.cancelInvite(ctx, ceoProfileId);
  }

  /**
   * P2.9C, reversed by the universal-self-service-onboarding checkpoint (docs/HANDOFF.md) — the
   * Super Admin OR the organisation's own CEO may invite its Initial Manager (owner's rule), but
   * no longer names their workspace. No `ManagerWorkspace` row is created here at all; the
   * recipient activates, completes their profile, and then self-services their own workspace
   * name/subdomain through the EXACT SAME `CreateWorkspaceScreen`/`POST /manager-workspaces` path
   * an ordinary Add-Manager account already uses — `App.tsx`'s `OnboardingGate` routes any
   * activated `type: 'internal'` Manager with no workspace yet there, regardless of which flow
   * created the account, so no frontend change was needed for this reconciliation beyond removing
   * the now-unused invite-time fields. "Check the existing initial-manager condition" (owner's
   * requirement 2): an organisation may only ever receive ONE Initial Manager invitation — once it
   * has any Internal Manager at all, subsequent Managers go through the ordinary, unmodified
   * `POST /managers` (Add Manager) flow, per the owner's own rule ("Uses existing Add Manager...
   * for normal subsequent account creation").
   */
  async inviteInitialManager(
    actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>,
    organisationId: string,
    dto: InviteInitialManagerDto,
  ): Promise<{ manager: ManagerSummary }> {
    await this.assertActorCanManageOrganisation(actorCtx, organisationId);

    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // P2.9 gap review, item 2: scoped to the CURRENT Initial Manager slot only
      // (isInitialManager=true, not yet superseded) — an ordinary additional Internal Manager
      // (Add-Manager flow, isInitialManager defaults false) never counts here. This also fixes a
      // latent bug the gap review found: previously counting ANY type='internal' row meant a CEO
      // who added an ordinary Manager before ever using this screen would find it permanently,
      // incorrectly blocked.
      const existingInitialManager = await manager.count(ManagerProfile, {
        where: { organisationId, type: ManagerType.INTERNAL, isInitialManager: true, supersededAt: IsNull() },
      });
      if (existingInitialManager > 0) {
        throw new ConflictException('This organisation already has its Initial Manager. Use the Add Manager feature for additional managers.');
      }

      const created = await this.managerService.createWithin(
        manager,
        ctx,
        { email: dto.email, firstName: dto.firstName, lastName: dto.lastName, type: ManagerType.INTERNAL },
        { templateRenderer: renderInitialManagerInvitationEmail },
      );
      // Never a client-settable field — `CreateManagerDto` has no such property at all, so this
      // is the ONLY place in the codebase that ever sets it true.
      await manager.update(ManagerProfile, created.id, { isInitialManager: true });

      return { manager: created };
    });
  }

  async resendInitialManagerInvite(actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>, organisationId: string): Promise<{ sendNumber: number; expiresAt: Date; queued: boolean }> {
    await this.assertActorCanManageOrganisation(actorCtx, organisationId);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const profileId = await this.findInitialManagerProfileIdOrFail(ctx);
    return this.managerService.resendInvite(ctx, profileId);
  }

  async revokeInitialManagerInvite(actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>, organisationId: string): Promise<void> {
    await this.assertActorCanManageOrganisation(actorCtx, organisationId);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const profileId = await this.findInitialManagerProfileIdOrFail(ctx);
    return this.managerService.cancelInvite(ctx, profileId);
  }

  /**
   * P2.9 gap review, item 2 (owner-approved, corrected, non-destructive design) — replaces a
   * never-activated, genuinely stuck Initial Manager invitation. The old `User`/`ManagerProfile`/
   * `ManagerWorkspace` rows are NEVER deleted or modified beyond `superseded_at` — every prior
   * audit row (invite-created, resent, cancelled) stays exactly as it was. Access check is
   * IDENTICAL to `inviteInitialManager`'s own (`assertActorCanManageOrganisation`): platform admin
   * OR this organisation's own CEO — no new authorization surface.
   *
   * Eligibility, re-verified under a row lock (never trusted from an earlier read):
   *  - `expectedProfileId` must match the organisation's CURRENT (not yet superseded) Initial
   *    Manager profile — optimistic concurrency; a stale or racing caller gets a clean 409.
   *  - The account must never have activated (`invited`/`invite_expired` only) — the hard
   *    invariant every other safety property in this design depends on: a never-activated
   *    account cannot own real data, cannot hold any other membership, and (traced through
   *    `AccountInviteService.consume()` and `AuthService.signInWithProvider()`'s own guards this
   *    session) cannot authenticate by password, Google/Microsoft OAuth, or a refresh token once
   *    its invite is revoked and its password hash is nulled.
   *  - The invitation must have genuinely exhausted its OWN resend path (`sendNumber >=
   *    INITIAL_MANAGER_MAX_SEND_ATTEMPTS`) — replacement is never a shortcut around a still-usable
   *    resend/re-invite.
   *  - AND either the last attempt has naturally expired, or it was explicitly revoked at least
   *    `INITIAL_MANAGER_REPLACE_COOLDOWN_MS` ago — closes the "cancel the final attempt the
   *    instant it's sent, then replace immediately" loophole.
   *  - The owned workspace's schema must not already be fully provisioned (`READY`) — enforced by
   *    `core.mark_workspace_schema_superseded`'s own allow-list guard (CREATING/FAILED only),
   *    never assumed client-side.
   *  - A CEO is capped at `INITIAL_MANAGER_MAX_REPLACEMENTS` lifetime per organisation (derived
   *    from counting superseded Initial Manager profiles — no new counter column). A platform
   *    admin is uncapped: the explicit, already-fully-audited recovery procedure once that cap is
   *    reached, not a counter reset.
   */
  async replaceInitialManager(
    actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>,
    organisationId: string,
    dto: ReplaceInitialManagerDto,
  ): Promise<{ manager: ManagerSummary }> {
    const isPlatformAdmin = await this.platformAdmin.isPlatformAdmin(actorCtx);
    await this.assertActorCanManageOrganisation(actorCtx, organisationId);

    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const suspendedRows = await manager.query<Array<{ organisation_is_suspended: boolean }>>(
        'SELECT core.organisation_is_suspended($1) AS organisation_is_suspended',
        [organisationId],
      );
      if (suspendedRows[0]?.organisation_is_suspended) {
        throw new ForbiddenException('This organisation is suspended.');
      }

      // Row lock FIRST — every check below re-reads under it, so a concurrent replace or a
      // concurrent activation of the SAME profile resolves deterministically (whichever commits
      // first wins; the other sees the now-changed state and fails cleanly).
      // Locked alone, never joined — Postgres refuses `FOR UPDATE` on the nullable side of an
      // outer join, and `ManagerProfile.user` is a LEFT JOIN relation. The `User` row is fetched
      // separately immediately after; both reads happen inside this same transaction either way.
      const profile = await manager.findOne(ManagerProfile, {
        where: { id: dto.expectedProfileId, organisationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) throw new NotFoundException('Initial Manager invitation not found.');
      if (!profile.isInitialManager || profile.supersededAt) {
        throw new ConflictException({
          code: 'STALE_INITIAL_MANAGER',
          message: 'This is no longer the organisation\'s current Initial Manager invitation.',
        });
      }
      const user = await manager.findOneOrFail(User, { where: { id: profile.userId } });
      if (user.status !== UserStatus.INVITED && user.status !== UserStatus.INVITE_EXPIRED) {
        throw new ConflictException({
          code: 'ALREADY_ACTIVATED',
          message: 'This account has already been activated and cannot be replaced.',
        });
      }

      const invite = await manager.findOne(AccountInvite, { where: { userId: profile.userId }, order: { createdAt: 'DESC' } });
      const sendNumber = invite?.sendNumber ?? 0;
      if (sendNumber < INITIAL_MANAGER_MAX_SEND_ATTEMPTS) {
        throw new ConflictException({
          code: 'RESEND_STILL_AVAILABLE',
          message: 'This invitation can still be resent. Replacement is only available once resend attempts are exhausted.',
        });
      }
      const now = Date.now();
      const naturallyExpired = !invite || invite.expiresAt.getTime() <= now;
      const cancelledLongEnoughAgo = Boolean(invite?.revokedAt) && now - invite!.revokedAt!.getTime() >= INITIAL_MANAGER_REPLACE_COOLDOWN_MS;
      if (!naturallyExpired && !cancelledLongEnoughAgo) {
        throw new ConflictException({
          code: 'REPLACE_COOLDOWN_ACTIVE',
          message: 'This invitation was recently cancelled. Replacement becomes available 24 hours after cancellation, or once it naturally expires.',
        });
      }

      if (!isPlatformAdmin) {
        const replacedCount = await manager.count(ManagerProfile, {
          where: { organisationId, isInitialManager: true, supersededAt: Not(IsNull()) },
        });
        if (replacedCount >= INITIAL_MANAGER_MAX_REPLACEMENTS) {
          throw new ConflictException({
            code: 'REPLACE_LIMIT_REACHED',
            message: 'This organisation has reached its Initial Manager replacement limit. A platform administrator can complete this recovery.',
          });
        }
      }

      // Fences any workspace the OLD invite already had — only ever non-null for a pending
      // invitation that predates this reconciliation (the old inviter-named-workspace-at-invite
      // model). A fresh invite under the current model has no workspace yet, so this is a no-op
      // for every new replacement going forward (see `fenceWorkspaceForReplacement`'s own guard).
      await this.fenceWorkspaceForReplacement(manager, profile);

      // Revoke the old invite + null the password — the OLD identity can never activate again
      // (traced against AccountInviteService.consume() and AuthService.signInWithProvider()'s own
      // guards; see this method's own doc comment). Reuses ManagerService's existing inner step,
      // never reimplemented here.
      await this.managerService.cancelInviteWithin(manager, ctx, profile.id);
      await manager.update(ManagerProfile, profile.id, { supersededAt: new Date() });

      // The replacement is created through the IDENTICAL path a fresh invite already uses — no
      // workspace is pre-created here either (see this method's own doc comment); the new
      // recipient self-services their own workspace after activating, same as `inviteInitialManager`.
      const created = await this.managerService.createWithin(
        manager,
        ctx,
        { email: dto.email, firstName: dto.firstName, lastName: dto.lastName, type: ManagerType.INTERNAL },
        { templateRenderer: renderInitialManagerInvitationEmail },
      );
      await manager.update(ManagerProfile, created.id, { isInitialManager: true });
      // ManagerSummary.id is the ManagerProfile's own id, not the user's — re-resolved for the
      // audit entry's targetUserId, which must be the actual User row.
      const createdProfile = await manager.findOneOrFail(ManagerProfile, { where: { id: created.id } });

      await this.auditService.record(manager, ctx, AuditAction.INITIAL_MANAGER_REPLACED, {
        targetUserId: createdProfile.userId,
        metadata: { organisationId, oldProfileId: profile.id, oldEmail: user.email, newEmail: dto.email },
      });

      return { manager: created };
    });
  }

  /**
   * The Worker-fencing step (P2.9 gap review, item 2): calls the narrow, allow-list-guarded
   * `core.mark_workspace_schema_superseded()` and then RE-READS the real status to confirm it
   * actually won — never trusts the call not throwing as proof on its own, since the function is
   * idempotent on an already-SUPERSEDED row. If the status comes back anything else (a concurrent
   * Worker already completed it to READY, or the function refused a READY/MIGRATING workspace),
   * this throws a clean, typed conflict and the whole transaction rolls back — the old record is
   * never touched.
   */
  private async fenceWorkspaceForReplacement(manager: EntityManager, profile: ManagerProfile): Promise<void> {
    if (!profile.workspaceId) return;
    try {
      await manager.query('SELECT core.mark_workspace_schema_superseded($1, $2)', [
        profile.workspaceId,
        'superseded by Initial Manager replacement',
      ]);
    } catch {
      throw new ConflictException({
        code: 'WORKSPACE_ALREADY_PROVISIONED',
        message: 'This workspace has already been fully provisioned and cannot be replaced from here.',
      });
    }
    const [row] = await manager.query<Array<{ schema_status: string | null }>>(
      'SELECT schema_status FROM core.manager_workspace WHERE id = $1',
      [profile.workspaceId],
    );
    if (row?.schema_status !== 'SUPERSEDED') {
      throw new ConflictException({
        code: 'WORKSPACE_ALREADY_PROVISIONED',
        message: 'This workspace has already been fully provisioned and cannot be replaced from here.',
      });
    }
  }

  private async findInitialManagerProfileIdOrFail(ctx: AuthContext): Promise<string> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, {
        where: { organisationId: ctx.organisationId!, type: ManagerType.INTERNAL, isInitialManager: true, supersededAt: IsNull() },
      });
      if (!profile) throw new NotFoundException('This organisation has no Initial Manager invitation.');
      return profile.id;
    });
  }

  /** Platform admin, unconditionally — OR the organisation's own CEO acting within their own session (never an arbitrary other org, even if they are somehow a CEO elsewhere). */
  private async assertActorCanManageOrganisation(actorCtx: Pick<AuthContext, 'userId' | 'organisationId'>, organisationId: string): Promise<void> {
    if (await this.platformAdmin.isPlatformAdmin(actorCtx)) return;
    if (actorCtx.organisationId === organisationId) {
      const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
      const isCeo = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const profile = await manager.findOne(ManagerProfile, { where: { userId: actorCtx.userId, organisationId, type: ManagerType.CEO } });
        return profile != null;
      });
      if (isCeo) return;
    }
    throw new ForbiddenException('Only a platform administrator or this organisation\'s own CEO can manage its Initial Manager invitation.');
  }

  private async findCeoProfileIdOrFail(ctx: AuthContext): Promise<string> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { organisationId: ctx.organisationId!, type: ManagerType.CEO } });
      if (!profile) throw new NotFoundException('This organisation has no CEO invitation.');
      return profile.id;
    });
  }

  private async resolveUniqueSlug(name: string): Promise<string> {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'organisation';
    let candidate = base;
    let suffix = 1;
    // `p_exclude_org_id` can never be a real organisation's id here — NIL_UUID makes the
    // function's own `id <> $2` exclusion correctly a no-op (see that constant's own comment).
    while (
      (
        await this.dataSource.query<Array<{ organisation_slug_taken: boolean }>>(
          'SELECT core.organisation_slug_taken($1, $2) AS organisation_slug_taken',
          [candidate, NIL_UUID],
        )
      )[0]!.organisation_slug_taken
    ) {
      candidate = `${base}-${++suffix}`;
    }
    return candidate;
  }

  private toOrganisationSummary(
    id: string,
    name: string,
    slug: string,
    suspended: boolean,
    createdAt: Date,
    ceo: ManagerSummary | null,
    /** Always `null` from `createOrganisationWithCeoInvite` — a brand-new organisation never has one yet. */
    initialManager: ManagerSummary | null = null,
  ): OrganisationSummary {
    return { id, name, slug, suspended, createdAt, ceo, initialManager };
  }

  private async assertActorIsPlatformAdmin(actorCtx: Pick<AuthContext, 'userId'>): Promise<void> {
    if (!(await this.platformAdmin.isPlatformAdmin(actorCtx))) {
      throw new ForbiddenException('Only a platform administrator can manage organisations.');
    }
  }
}
