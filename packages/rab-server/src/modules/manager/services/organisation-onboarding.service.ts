import { checkPasswordStrength, EmailOutboxJobType, EmailOutboxStatus, ManagerType, MEMBER_INVITATION_MAX_SENDS, MEMBER_INVITATION_TTL_MS, normalizeEmail, PermissionFlag, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, IsNull, QueryFailedError } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { renderCeoInvitationEmail, renderInitialManagerInvitationEmail } from '../../../engine/core-modules/email/templates';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EMAIL_UNAVAILABLE_CODE, EMAIL_UNAVAILABLE_MESSAGE } from '../../../engine/filters/email-unavailable';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { InvitationRateLimitService } from '../../../engine/core-modules/rate-limit/invitation-rate-limit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInvite } from '../../identity/entities/account-invite.entity';
import { ManagerWorkspaceService } from '../../manager-workspace/services/manager-workspace.service';
import { EmailOutbox, Organisation, User } from '../../identity/entities';
import { ManagerProfile } from '../entities/manager-profile.entity';
import { InviteInitialManagerDto } from '../dto/invite-initial-manager.dto';
import { ReplaceInitialManagerDto } from '../dto/replace-initial-manager.dto';
import { ManagerService, ManagerSummary } from './manager.service';

/** Mirrors `AccountInviteService`'s own `MAX_SEND_ATTEMPTS` (not exported there) — replacement is only ever offered once resend is no longer possible at all. */
const INITIAL_MANAGER_MAX_SEND_ATTEMPTS = 3;
// Owner decision (2026-10-15, later): Initial Manager replacements are UNLIMITED — there is deliberately no lifetime count. What
// stays bounded is the lifecycle (only a never-activated, resend-exhausted invitation can be replaced), "one current Initial
// Manager" (the partial unique index), and request rate (the global throttler).
/** Closes the "cancel the final attempt the instant it's sent, then replace immediately" loophole — a NATURALLY expired final attempt needs no extra wait (expiry windows already run multiple days), but an explicitly-revoked one does. */
const INITIAL_MANAGER_REPLACE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The acting caller of an Initial Manager operation: identity and organisation exactly as the verified session resolved them. */
export type InitialManagerActor = Pick<AuthContext, 'userId' | 'organisationId'> &
  Partial<Pick<AuthContext, 'inspectedBy' | 'security' | 'workspaceId' | 'role' | 'sessionId'>>;

export interface LeadershipCapabilities {
  canCreateOrganisation: boolean;
  initialManagerScope: 'own' | 'none';
}

export interface OrganisationSummary {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  createdAt: Date;
  ceo: ManagerSummary | null;
  // Organisation isolation (2026-10-15): the former `initialManager` field is gone. Another organisation's Initial Manager is not
  // platform-level data — only that organisation's own CEO (or a platform admin acting within their OWN organisation) manages it,
  // through Settings → Members → Add. `manager_profile`'s platform-admin RLS branch now reaches CEO rows only.
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

/** The one message every invalid, unknown, expired, revoked, superseded or used CEO invitation link produces. */
export const INVALID_ORGANISATION_INVITATION_MESSAGE = 'This invitation link is invalid or has expired.';

/** 'account_exists' never reaches a caller: it becomes the generic 409 EMAIL_UNAVAILABLE refusal. */
export type OrganisationInvitationOutcome = 'invited' | 'already_invited' | 'account_exists';

/** A platform administrator's CEO invitation, as Settings → Members → Add lists it. Email and lifecycle only. */
export interface OrganisationInvitationItem {
  id: string;
  email: string;
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  sendCount: number;
  maxSends: number;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date | null;
  acceptedOrganisationId: string | null;
}

export interface AcceptOrganisationInvitationInput {
  token: string;
  firstName: string;
  lastName: string;
  organisationName: string;
  newPassword: string;
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
    private readonly permissions: PermissionsService,
    private readonly securityVersion: SecurityVersionService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly env: EnvironmentService,
    private readonly rateLimit: InvitationRateLimitService,
    private readonly passwordHashing: PasswordHashingService,
  ) {}

  // ── CEO (organisation) invitations — owner correction 2026-10-23 ─────────────────────────────────────────────────
  //
  // Settings → Members → Add: a platform administrator enters ONLY the CEO's email. No organisation, user, role or
  // placeholder name exists until the CEO accepts and supplies their own first name, last name, organisation name and
  // password (`acceptCeoInvitation`). The pending invitation lives in `core.organisation_invitation`
  // (OrganisationCeoInvitation1786720010000), reachable only through its SECURITY DEFINER functions, which re-check the
  // platform-administrator claim themselves (layer 3 under this service's own check and `PlatformAdminGuard`). The email
  // goes through the ordinary outbox + worker, in the inviting administrator's organisation. 24 h expiry, at most 3
  // sends, single-use token, revoke, audit: the same lifecycle as every other email-first invitation.

  async inviteCeo(actorCtx: AuthContext, rawEmail: string): Promise<{ email: string; outcome: OrganisationInvitationOutcome; invitation?: OrganisationInvitationItem }> {
    if (actorCtx.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    await this.assertActorIsPlatformAdmin(actorCtx);
    const email = normalizeEmail(rawEmail ?? '');
    if (!email || email.length > 254 || !isEmail(email)) throw new BadRequestException('Enter a valid email address.');
    // Metered before the account lookup, so the endpoint cannot be used to probe which addresses have accounts.
    await this.rateLimit.assertCanSend({ actorUserId: actorCtx.userId, organisationId: actorCtx.organisationId!, recipientEmails: [email] });

    const { token, tokenHash } = this.newInvitationToken();
    const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
    let published: EmailOutbox | null = null;
    const result = await this.tenantContext.runInTenantContext(this.actorContext(actorCtx), async (manager) => {
      const [row] = await manager.query<Array<{ outcome: OrganisationInvitationOutcome; invitationId: string | null; sendCount: number | null; expiresAt: Date | null; inviterOrganisationId: string | null }>>(
        'SELECT * FROM core.organisation_invitation_issue($1, $2, $3)',
        [email, tokenHash, expiresAt],
      );
      // Owner policy (2026-10-15): an address that already has an account anywhere gets the same generic refusal as
      // every other account-creation path (never which organisation, never the account's state).
      if (row?.outcome === 'account_exists') throw new ConflictException({ statusCode: 409, code: EMAIL_UNAVAILABLE_CODE, message: EMAIL_UNAVAILABLE_MESSAGE });
      if (!row || row.outcome !== 'invited' || !row.invitationId) return { email, outcome: row?.outcome ?? 'already_invited' };
      const outbox = await this.enqueueCeoInvitationEmail(manager, actorCtx, row.invitationId, email, token);
      published = outbox;
      await this.auditService.record(manager, actorCtx, AuditAction.ORGANISATION_INVITATION_SENT, {
        entityType: 'organisation_invitation',
        entityId: row.invitationId,
        metadata: { sendCount: 1, emailOutboxId: outbox.id },
      });
      const invitation: OrganisationInvitationItem = {
        id: row.invitationId,
        email,
        status: 'pending',
        sendCount: row.sendCount ?? 1,
        maxSends: MEMBER_INVITATION_MAX_SENDS,
        expiresAt: row.expiresAt ?? expiresAt,
        lastSentAt: new Date(),
        createdAt: new Date(),
        acceptedOrganisationId: null,
      };
      return { email, outcome: 'invited' as const, invitation };
    });
    if (published) void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), published);
    return result;
  }

  async listCeoInvitations(actorCtx: AuthContext, page = 1, limit = 25): Promise<{ data: OrganisationInvitationItem[]; total: number }> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.tenantContext.runInTenantContext(this.actorContext(actorCtx), (manager) =>
      manager.query<Array<{ id: string; email: string; status: string; sendCount: number; expiresAt: Date; lastSentAt: Date; createdAt: Date; acceptedOrganisationId: string | null; total: string }>>(
        'SELECT * FROM core.organisation_invitation_list($1, $2)',
        [take, (Math.max(page, 1) - 1) * take],
      ),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        status: (['pending', 'expired', 'accepted', 'revoked'].includes(r.status) ? r.status : 'revoked') as OrganisationInvitationItem['status'],
        sendCount: r.sendCount,
        maxSends: MEMBER_INVITATION_MAX_SENDS,
        expiresAt: r.expiresAt,
        lastSentAt: r.lastSentAt,
        createdAt: r.createdAt,
        acceptedOrganisationId: r.acceptedOrganisationId,
      })),
      total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    };
  }

  async resendCeoInvitation(actorCtx: AuthContext, invitationId: string): Promise<{ sendCount: number; expiresAt: Date }> {
    if (actorCtx.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    await this.assertActorIsPlatformAdmin(actorCtx);
    const { token, tokenHash } = this.newInvitationToken();
    const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
    let published: EmailOutbox | null = null;
    const result = await this.tenantContext.runInTenantContext(this.actorContext(actorCtx), async (manager) => {
      const [row] = await manager.query<Array<{ outcome: string; email: string | null; sendCount: number | null; expiresAt: Date | null; inviterOrganisationId: string | null }>>(
        'SELECT * FROM core.organisation_invitation_resend($1, $2, $3, $4)',
        [invitationId, tokenHash, expiresAt, MEMBER_INVITATION_MAX_SENDS],
      );
      if (!row || row.outcome === 'not_found') throw new NotFoundException('Invitation not found.');
      if (row.outcome === 'max_sends') {
        throw new ConflictException({ code: 'MAX_SENDS_REACHED', message: 'This invitation has been sent the maximum number of times. Revoke it and send a new invitation.' });
      }
      if (row.outcome !== 'resent') throw new ConflictException('This invitation is no longer pending.');
      // The email (and its audit) live in the inviting organisation's outbox; the previous link is dead now.
      const ctx = await this.bindInviterOrganisation(manager, actorCtx, row.inviterOrganisationId);
      await this.cancelOpenCeoInvitationEmails(manager, invitationId, 'Superseded by a resend.');
      const outbox = await this.enqueueCeoInvitationEmail(manager, ctx, invitationId, row.email!, token);
      published = outbox;
      await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_INVITATION_RESENT, {
        entityType: 'organisation_invitation',
        entityId: invitationId,
        metadata: { sendCount: row.sendCount, emailOutboxId: outbox.id },
      });
      return { sendCount: row.sendCount!, expiresAt: row.expiresAt! };
    });
    if (published) void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), published);
    return result;
  }

  async revokeCeoInvitation(actorCtx: AuthContext, invitationId: string): Promise<void> {
    if (actorCtx.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    await this.assertActorIsPlatformAdmin(actorCtx);
    await this.tenantContext.runInTenantContext(this.actorContext(actorCtx), async (manager) => {
      const [row] = await manager.query<Array<{ outcome: string; email: string | null; inviterOrganisationId: string | null }>>(
        'SELECT * FROM core.organisation_invitation_revoke($1)',
        [invitationId],
      );
      if (!row || row.outcome === 'not_found') throw new NotFoundException('Invitation not found.');
      if (row.outcome === 'accepted') throw new ConflictException('This invitation has already been accepted.');
      if (row.outcome !== 'revoked') throw new ConflictException('This invitation is no longer pending.');
      const ctx = await this.bindInviterOrganisation(manager, actorCtx, row.inviterOrganisationId);
      await this.cancelOpenCeoInvitationEmails(manager, invitationId, 'Invitation revoked.');
      await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_INVITATION_REVOKED, { entityType: 'organisation_invitation', entityId: invitationId });
    });
  }

  /**
   * Public (the invited CEO has no account yet): what this link is, for the acceptance form — or `null` when the token
   * is not a CEO invitation (the caller then tries the workspace-member invitation path). A live CEO invitation only;
   * nothing about any other state is disclosed.
   */
  async resolveCeoInvitation(token: string, clientIp: string): Promise<{ kind: 'organisation'; email: string; roleLabel: string; workspaceName: null; expiresAt: Date } | null> {
    const found = await this.peekCeoInvitation(token);
    if (!found) return null;
    await this.rateLimit.assertCanRedeem(clientIp);
    return { kind: 'organisation', email: found.email, roleLabel: 'CEO', workspaceName: null, expiresAt: found.expiresAt };
  }

  /**
   * Public: the invited CEO accepts, supplying their OWN first name, last name, organisation name and password. In ONE
   * transaction, under the INVITING administrator's authority re-verified now (still an active platform administrator):
   * the organisation is created through `core.create_organisation()` (unique slug derived from the name), the CEO account
   * through `ManagerService.createWithin()` (role, membership, profile, audit — no activation email: the CEO sets their
   * password here), and the invitation is consumed by `core.organisation_invitation_complete()` under its row lock, which
   * also proves the account carries the invited email. Any failure rolls everything back: no half-created or orphan
   * organisation, no second organisation for a replayed or concurrent acceptance. No session is issued; the CEO signs in
   * normally and completes the existing workspace onboarding (name, subdomain, profile) on the server path.
   * Returns `null` when the token is not a CEO invitation (the caller tries the member-invitation path).
   */
  async acceptCeoInvitation(input: AcceptOrganisationInvitationInput, clientIp: string): Promise<{ applicationTarget: 'manager_web'; managerLoginUrl: string } | null> {
    const found = await this.peekCeoInvitation(input.token);
    if (!found) return null;
    await this.rateLimit.assertCanRedeem(clientIp);
    const firstName = (input.firstName ?? '').trim();
    const lastName = (input.lastName ?? '').trim();
    const organisationName = (input.organisationName ?? '').trim().replace(/\s+/g, ' ');
    if (!firstName || !lastName) throw new BadRequestException('Enter your first and last name.');
    if (!organisationName || organisationName.length > 120) throw new BadRequestException('Enter your organisation name (up to 120 characters).');
    const { valid, reasons } = checkPasswordStrength(input.newPassword ?? '', found.email);
    if (!valid) throw new BadRequestException(reasons.join(' '));
    const passwordHash = await this.passwordHashing.hash(input.newPassword);
    const slug = await this.resolveUniqueSlug(organisationName);

    await this.dataSource.transaction(async (manager) => {
      await this.acceptCeoInvitationTx(manager, found, { firstName, lastName, organisationName, slug, passwordHash });
    }).catch((error: unknown) => {
      // A concurrent acceptance of the same link (or the cross-organisation email rule) surfaces as a uniqueness conflict
      // from the losing transaction — which has rolled back completely. Same generic answer as every other dead link.
      if (error instanceof ConflictException || (error instanceof QueryFailedError && (error as unknown as { code?: string }).code === '23505')) {
        throw new BadRequestException(INVALID_ORGANISATION_INVITATION_MESSAGE);
      }
      throw error;
    });
    return { applicationTarget: 'manager_web', managerLoginUrl: `${this.env.get('APP_URL').replace(/\/+$/, '')}/login` };
  }

  private async acceptCeoInvitationTx(
    manager: EntityManager,
    found: { invitationId: string; email: string; invitedBy: string; tokenHash: string },
    input: { firstName: string; lastName: string; organisationName: string; slug: string; passwordHash: string },
  ): Promise<void> {
    const { firstName, lastName, organisationName, slug, passwordHash } = input;
    // The inviter's authority, re-verified NOW (not as it was when the email was sent). CF-13: core.create_organisation()
    // itself requires the bound user to be an active platform administrator.
    await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [found.invitedBy]);
    if (!(await this.platformAdmin.isPlatformAdminTx(manager, { userId: found.invitedBy }))) {
      throw new BadRequestException(INVALID_ORGANISATION_INVITATION_MESSAGE);
    }
    const [{ create_organisation: organisationId }] = await manager.query<Array<{ create_organisation: string }>>(
      'SELECT core.create_organisation($1, $2) AS create_organisation',
      [organisationName, slug],
    );
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: found.invitedBy, role: '' };
    await this.tenantContext.bindCoreIdentityGucs(manager, ctx);
    await manager.query(`SELECT set_config('search_path', 'core', true)`);
    // One account per email across organisations (owner policy 2026-10-15): never a second identity.
    const [elsewhere] = await manager.query<Array<{ taken: boolean }>>(`SELECT core.email_registered_in_another_organisation($1) AS taken`, [found.email]);
    if (elsewhere?.taken) throw new BadRequestException(INVALID_ORGANISATION_INVITATION_MESSAGE);
    await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_CREATED, {
      entityType: 'organisation',
      entityId: organisationId,
      metadata: { name: organisationName, slug, via: 'ceo_invitation', invitationId: found.invitationId },
    });
    await this.managerService.createWithin(manager, ctx, { email: found.email, firstName, lastName, type: ManagerType.CEO }, { sendInvite: false });
    const [ceo] = await manager.query<Array<{ id: string }>>(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [organisationId, found.email]);
    if (!ceo) throw new BadRequestException(INVALID_ORGANISATION_INVITATION_MESSAGE);
    // Possession of the emailed single-use token proves control of the address; the password is the CEO's own.
    await manager.update(User, ceo.id, { passwordHash, mustResetPassword: false, emailVerifiedAt: new Date() });
    await this.securityVersion.bumpUser(manager, ceo.id);
    const [{ completed }] = await manager.query<Array<{ completed: string | null }>>(
      'SELECT core.organisation_invitation_complete($1, $2, $3) AS completed',
      [found.tokenHash, organisationId, ceo.id],
    );
    if (!completed) throw new BadRequestException(INVALID_ORGANISATION_INVITATION_MESSAGE); // rolls the organisation back too
    await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_INVITATION_ACCEPTED, {
      entityType: 'organisation_invitation',
      entityId: found.invitationId,
      targetUserId: ceo.id,
      actorUserId: ceo.id,
      metadata: { organisationId },
    });
  }

  private async peekCeoInvitation(token: string): Promise<{ invitationId: string; email: string; expiresAt: Date; invitedBy: string; tokenHash: string } | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const tokenHash = this.hashInvitationToken(token);
    const [row] = await this.dataSource.query<Array<{ invitationId: string; email: string; expiresAt: Date; invitedBy: string }>>(
      'SELECT * FROM core.organisation_invitation_peek($1)',
      [tokenHash],
    );
    return row ? { ...row, tokenHash } : null;
  }

  private newInvitationToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashInvitationToken(token) };
  }

  private hashInvitationToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** The acting administrator's own (verified) organisation context; the functions read the bound user id. */
  private actorContext(actorCtx: AuthContext): AuthContext {
    return { organisationId: actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
  }

  /** Rebinds the open transaction to the organisation that sent the invitation (where its emails and audit live). */
  private async bindInviterOrganisation(manager: EntityManager, actorCtx: AuthContext, inviterOrganisationId: string | null): Promise<AuthContext> {
    const ctx: AuthContext = { organisationId: inviterOrganisationId ?? actorCtx.organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    await this.tenantContext.bindCoreIdentityGucs(manager, ctx);
    return ctx;
  }

  private async enqueueCeoInvitationEmail(manager: EntityManager, ctx: AuthContext, invitationId: string, email: string, token: string): Promise<EmailOutbox> {
    // The raw token exists only here, in the rendered email (scrubbed from the outbox once terminal — F1). It is never
    // returned by an API, logged or audited. Same acceptance page as every email-first invitation.
    const activationUrl = `${this.env.get('ACCOUNTS_URL')}/accept-invitation?token=${encodeURIComponent(token)}`;
    return this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.ORGANISATION_INVITATION,
      recipientEmail: email,
      organisationInvitationId: invitationId,
      rendered: renderCeoInvitationEmail({ recipientEmail: email, activationUrl }),
      createdBy: ctx.userId,
    });
  }

  private async cancelOpenCeoInvitationEmails(manager: EntityManager, invitationId: string, reason: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()', lastErrorMessageSanitized: reason })
      .where('organisation_invitation_id = :invitationId AND status IN (:...open)', {
        invitationId,
        open: [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.RETRY],
      })
      .execute();
  }

  async getOrganisation(actorCtx: Pick<AuthContext, 'userId'>, organisationId: string): Promise<OrganisationSummary> {
    await this.assertActorIsPlatformAdmin(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const org = await manager.findOneBy(Organisation, { id: organisationId });
      if (!org) throw new NotFoundException('Organisation not found.');
      const ceoProfile = await manager.findOne(ManagerProfile, { where: { organisationId, type: ManagerType.CEO } });
      const ceo = ceoProfile ? await this.managerService.get(ctx, ceoProfile.id) : null;
      return this.toOrganisationSummary(org.id, org.name, org.slug, org.suspendedAt != null, org.createdAt, ceo);
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
  async inviteInitialManager(actorCtx: InitialManagerActor, dto: InviteInitialManagerDto): Promise<{ manager: ManagerSummary }> {
    const organisationId = await this.assertActorCanManageOwnInitialManager(actorCtx);

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
      await this.markInitialManager(manager, created.id);

      return { manager: created };
    });
  }

  async resendInitialManagerInvite(actorCtx: InitialManagerActor): Promise<{ sendNumber: number; expiresAt: Date; queued: boolean }> {
    const organisationId = await this.assertActorCanManageOwnInitialManager(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const profileId = await this.findInitialManagerProfileIdOrFail(ctx);
    return this.managerService.resendInvite(ctx, profileId);
  }

  async revokeInitialManagerInvite(actorCtx: InitialManagerActor): Promise<void> {
    const organisationId = await this.assertActorCanManageOwnInitialManager(actorCtx);
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const profileId = await this.findInitialManagerProfileIdOrFail(ctx);
    return this.managerService.cancelInvite(ctx, profileId);
  }

  /**
   * P2.9 gap review, item 2 (owner-approved, corrected, non-destructive design) — replaces a
   * never-activated, genuinely stuck Initial Manager invitation. The old `User`/`ManagerProfile`/
   * `ManagerWorkspace` rows are NEVER deleted or modified beyond `superseded_at` — every prior
   * audit row (invite-created, resent, cancelled) stays exactly as it was. Access check is
   * IDENTICAL to `inviteInitialManager`'s own (`assertActorCanManageOwnInitialManager`): this
   * organisation's own CEO, or a platform admin acting within their OWN organisation.
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
   *  - No lifetime replacement count (owner decision, 2026-10-15): superseded profiles are history, never a quota.
   *
   * Concurrency: the profile, the old user and the old invitation rows are all locked before any check, so a racing activation,
   * resend, cancel, suspension or second replacement either commits first (and this one then fails its re-read cleanly) or waits.
   * The old identity is retired completely inside the same transaction: invitation revoked, password removed, every refresh
   * family and web session revoked, and its security version bumped (cached auth snapshots die on the next request).
   */
  async replaceInitialManager(actorCtx: InitialManagerActor, dto: ReplaceInitialManagerDto): Promise<{ manager: ManagerSummary }> {
    const organisationId = await this.assertActorCanManageOwnInitialManager(actorCtx);

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
      // Lock order matches activation (AccountInviteService.consume → user update): invitation FIRST, then the user, so a racing
      // activation and this replacement serialise instead of deadlocking. Whichever commits first wins; the other re-reads and fails.
      const invite = await manager.findOne(AccountInvite, {
        where: { userId: profile.userId },
        order: { createdAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });
      const user = await manager.findOneOrFail(User, { where: { id: profile.userId }, lock: { mode: 'pessimistic_write' } });
      if (user.status !== UserStatus.INVITED && user.status !== UserStatus.INVITE_EXPIRED) {
        throw new ConflictException({
          code: 'ALREADY_ACTIVATED',
          message: 'This account has already been activated and cannot be replaced.',
        });
      }
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
      // Defence in depth: a never-activated account should hold no credential, but retire any that exists (same primitives as an
      // admin password reset) so nothing issued to the old identity — and no cached auth snapshot — outlives the replacement.
      await this.refreshTokenService.revokeAllForUser(manager, profile.userId, 'initial_manager_replaced');
      await this.securityVersion.bumpUser(manager, profile.userId);

      // The replacement is created through the IDENTICAL path a fresh invite already uses — no
      // workspace is pre-created here either (see this method's own doc comment); the new
      // recipient self-services their own workspace after activating, same as `inviteInitialManager`.
      const created = await this.managerService.createWithin(
        manager,
        ctx,
        { email: dto.email, firstName: dto.firstName, lastName: dto.lastName, type: ManagerType.INTERNAL },
        { templateRenderer: renderInitialManagerInvitationEmail },
      );
      await this.markInitialManager(manager, created.id);
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

  /** `manager_profile_one_current_initial_manager` is the authority on "one current Initial Manager": a concurrent second invite that passed the count check loses here as a clean 409 (the whole transaction rolls back). */
  private async markInitialManager(manager: EntityManager, profileId: string): Promise<void> {
    try {
      await manager.update(ManagerProfile, profileId, { isInitialManager: true });
    } catch (error) {
      if ((error as { driverError?: { constraint?: string } }).driverError?.constraint === 'manager_profile_one_current_initial_manager') {
        throw new ConflictException('This organisation already has its Initial Manager. Use the Add Manager feature for additional managers.');
      }
      throw error;
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

  /**
   * Leadership presentation capabilities for Settings → Members → Add, derived from the SAME checks the write paths enforce
   * (never a client role label). `initialManagerScope` is only ever 'own' or 'none' — there is no cross-organisation scope.
   * Presentation only: every write re-checks through `assertActorCanManageOwnInitialManager`.
   */
  async getLeadershipCapabilities(actorCtx: InitialManagerActor): Promise<LeadershipCapabilities> {
    const canCreateOrganisation = !actorCtx.inspectedBy && (await this.platformAdmin.isPlatformAdmin(actorCtx));
    const canManageInitialManager = await this.assertActorCanManageOwnInitialManager(actorCtx).then(() => true, () => false);
    // The HTTP routes also require MANAGER_MANAGE (layer 1); without it the option would only ever 403.
    const holdsManagerManage =
      canManageInitialManager && (await this.permissions.userHasPermission(actorCtx as AuthContext, PermissionFlag.MANAGER_MANAGE));
    return { canCreateOrganisation, initialManagerScope: holdsManagerManage ? 'own' : 'none' };
  }

  /**
   * Organisation isolation (owner policy, 2026-10-15, superseding P2.9C's "platform admin, any organisation"): Initial Manager
   * onboarding is strictly SAME-organisation for every actor. The organisation is the actor's own verified one — there is no
   * organisation parameter at all, so a route parameter, body field or header can never grant authority. Allowed:
   *  - this organisation's own CEO, or
   *  - an active platform admin acting within their OWN organisation (platform status adds no cross-organisation reach).
   * Re-verified against PostgreSQL on every call, never trusted from the caller's context alone: the actor's user row must belong
   * to that organisation and be active. Fails closed: no organisation context, or an actor outside it → 404 (no existence
   * oracle); an Admin Inspect session (`inspectedBy`) → 403; same organisation but not CEO/platform admin → 403.
   * Returns the organisation id every caller must use.
   */
  private async assertActorCanManageOwnInitialManager(actorCtx: InitialManagerActor): Promise<string> {
    if (actorCtx.inspectedBy) {
      throw new ForbiddenException('Initial Manager onboarding is not available while inspecting another account.');
    }
    const organisationId = actorCtx.organisationId;
    if (!organisationId) throw new NotFoundException('Organisation not found.');
    const ctx: AuthContext = { organisationId, workspaceId: null, userId: actorCtx.userId, role: '' };
    const verdict = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const actor = await manager.findOne(User, { where: { id: actorCtx.userId, organisationId } });
      if (!actor) return 'not-found' as const;
      if (actor.status !== UserStatus.ACTIVE) return 'forbidden' as const;
      const isCeo = await manager.exists(ManagerProfile, { where: { userId: actorCtx.userId, organisationId, type: ManagerType.CEO } });
      if (isCeo || (await this.platformAdmin.isPlatformAdminTx(manager, actorCtx))) return 'allowed' as const;
      return 'forbidden' as const;
    });
    if (verdict === 'not-found') throw new NotFoundException('Organisation not found.');
    if (verdict === 'forbidden') {
      throw new ForbiddenException(
        'Only this organisation\'s own CEO, or a platform administrator within their own organisation, can manage its Initial Manager invitation.',
      );
    }
    return organisationId;
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
  ): OrganisationSummary {
    return { id, name, slug, suspended, createdAt, ceo };
  }

  private async assertActorIsPlatformAdmin(actorCtx: Pick<AuthContext, 'userId'>): Promise<void> {
    if (!(await this.platformAdmin.isPlatformAdmin(actorCtx))) {
      throw new ForbiddenException('Only a platform administrator can manage organisations.');
    }
  }
}
