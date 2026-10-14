import {
  checkPasswordStrength,
  EmailOutboxJobType,
  EmailOutboxStatus,
  MEMBER_INVITATION_MAX_SENDS,
  MEMBER_INVITATION_TTL_MS,
  MemberInvitationOutcome,
  MemberInvitationOutcomeType,
  MemberInvitationStatus,
  MemberInvitationStatusType,
  normalizeEmail,
  PermissionFlag,
  UserStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { ApplicationTarget } from '../../../engine/core-modules/auth/application-access';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { renderMemberInvitationEmail } from '../../../engine/core-modules/email/templates';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { InvitationRateLimitService } from '../../../engine/core-modules/rate-limit/invitation-rate-limit.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../../engine/core-modules/tenant/workspace-membership.service';
import { EmailOutbox, OrganisationMember, User, UserRole } from '../../identity/entities';
import { AssignableMemberRole, MemberRolePolicyService } from '../../identity/services/member-role-policy.service';

/** The one message every invalid, unknown, expired, revoked, superseded or consumed link produces — no state oracle. */
export const INVALID_INVITATION_MESSAGE = 'This invitation link is invalid or has expired.';

const OPEN_OUTBOX_STATUSES = [EmailOutboxStatus.PENDING, EmailOutboxStatus.QUEUED, EmailOutboxStatus.RETRY];
const UUID = /^[0-9a-f-]{36}$/i;

export interface MemberInvitationItem {
  id: string;
  email: string;
  role: { id: string; name: string };
  status: MemberInvitationStatusType;
  sendCount: number;
  maxSends: number;
  expiresAt: Date;
  lastSentAt: Date;
  createdAt: Date;
  invitedByName: string | null;
}

export interface SendResult {
  email: string;
  outcome: MemberInvitationOutcomeType;
  invitation?: MemberInvitationItem;
}

interface InvitationRow {
  id: string;
  organisation_id: string;
  workspace_id: string;
  email: string;
  role_id: string;
  role_name?: string | null;
  send_count: number;
  expires_at: Date;
  last_sent_at: Date;
  created_at: Date;
  invited_by: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
  superseded_at: Date | null;
  outbox_status?: string | null;
  invited_by_first?: string | null;
  invited_by_last?: string | null;
  is_expired?: boolean;
}

/**
 * Email-first workspace-member invitations — Settings → Members → Invite (Twenty-style, adapted to Crewflow).
 *
 * The workspace OWNER (the Manager — or CEO in their own operational workspace — whose private workspace it is)
 * supplies only email addresses and one of their CUSTOM workspace-member roles. No `core.user`, role assignment or
 * workspace membership exists for the recipient until they accept and supply their OWN first name, last name and
 * password; `accept` then creates exactly that (user + that one role + membership of the inviter's workspace — no
 * staff/manager profile, never a new workspace) in one transaction, under the inviter's authority re-verified at
 * that moment.
 *
 * Recruitment Staff, Venue Managers, Managers and leadership roles are never invitable here: `MemberRolePolicyService`
 * only returns custom roles of the actor's own workspace, and the composite FK on `member_invitation(role_id,
 * workspace_id)` makes anything else unrepresentable in PostgreSQL.
 *
 * Every method re-derives the caller's authority from PostgreSQL inside its own transaction (CLAUDE.md layer 2),
 * independent of the route guard. Organisation and workspace always come from the verified session (or, for the
 * public endpoints, from the token's own row) — never from the request body.
 */
@Injectable()
export class MemberInvitationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly memberRolePolicy: MemberRolePolicyService,
    private readonly workspaceMembership: WorkspaceMembershipService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly audit: AuditService,
    private readonly env: EnvironmentService,
    private readonly rateLimit: InvitationRateLimitService,
    private readonly passwordHashing: PasswordHashingService,
  ) {}

  // ── Authority ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * True when `ctx` may administer member invitations of its CURRENT workspace right now: holds ROLE_MANAGE, has an
   * active membership of that workspace, and OWNS it. Platform-admin status alone grants nothing.
   */
  private async isWorkspaceAdministratorTx(manager: EntityManager, ctx: AuthContext): Promise<boolean> {
    if (!ctx.workspaceId) return false;
    if (!(await this.permissions.userHasPermissionTx(manager, ctx, PermissionFlag.ROLE_MANAGE))) return false;
    const rows = await manager.query(
      `SELECT 1 FROM core.manager_workspace w
         JOIN core.workspace_membership m ON m.workspace_id = w.id AND m.user_id = $2 AND m.status = 'active'
        WHERE w.id = $1 AND w.owner_user_id = $2 AND w.status = 'active'`,
      [ctx.workspaceId, ctx.userId],
    );
    return rows.length > 0;
  }

  private async assertAdministratorTx(manager: EntityManager, ctx: AuthContext): Promise<void> {
    if (!(await this.isWorkspaceAdministratorTx(manager, ctx))) {
      throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
    }
  }

  async assignableRoles(ctx: AuthContext): Promise<Array<{ id: string; name: string; permissionKeys: string[] }>> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertAdministratorTx(manager, ctx);
      const roles = await this.memberRolePolicy.listAssignableTx(manager, ctx);
      return roles.map((r) => ({ id: r.id, name: r.name, permissionKeys: r.permissionKeys }));
    });
  }

  private async assertOrganisationActive(manager: EntityManager, organisationId: string): Promise<void> {
    const [org] = await manager.query<Array<{ suspended_at: string | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [organisationId]);
    if (!org || org.suspended_at) throw new ForbiddenException('This organisation has been suspended. New invitations cannot be sent.');
  }

  // ── Send ─────────────────────────────────────────────────────────────────────────────────────────────────

  async send(ctx: AuthContext, emails: string[], roleId: string): Promise<{ results: SendResult[] }> {
    const role = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertOrganisationActive(manager, ctx.organisationId!);
      await this.assertAdministratorTx(manager, ctx);
      return this.memberRolePolicy.loadAssignableTx(manager, ctx, roleId);
    });

    const seen = new Set<string>();
    const results: SendResult[] = [];
    const valid: string[] = [];
    for (const raw of emails) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      if (seen.has(email)) continue; // duplicates in one request collapse into a single invitation
      seen.add(email);
      if (email.length > 254 || !isEmail(email)) {
        results.push({ email, outcome: MemberInvitationOutcome.INVALID_EMAIL });
        continue;
      }
      valid.push(email);
    }
    if (valid.length === 0) return { results };

    // Metered before any membership lookup, so the endpoint can't be used to probe who already has an account.
    await this.rateLimit.assertCanSend({ actorUserId: ctx.userId, organisationId: ctx.organisationId!, recipientEmails: valid });

    const published: Array<{ id: string; organisationId: string }> = [];
    for (const email of valid) {
      results.push(await this.sendOne(ctx, email, role, published));
    }
    for (const row of published) void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
    return { results };
  }

  /** One recipient, one transaction — a conflict for one address never rolls back the others. */
  private async sendOne(ctx: AuthContext, email: string, role: AssignableMemberRole, published: Array<{ id: string; organisationId: string }>): Promise<SendResult> {
    try {
      return await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const existingUser = await manager.query(`SELECT 1 FROM core."user" WHERE organisation_id = $1 AND email = $2`, [ctx.organisationId, email]);
        if (existingUser.length > 0) return { email, outcome: MemberInvitationOutcome.ALREADY_MEMBER };

        const visibleLive = await manager.query(
          `SELECT 1 FROM core.member_invitation WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL`,
          [email],
        );
        if (visibleLive.length > 0) return { email, outcome: MemberInvitationOutcome.ALREADY_INVITED };

        const { token, tokenHash } = this.newToken();
        const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
        const inserted = await manager.query<Array<{ id: string }>>(
          `INSERT INTO core.member_invitation (organisation_id, workspace_id, email, role_id, token_hash, send_count, expires_at, invited_by)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7) RETURNING id`,
          [ctx.organisationId, ctx.workspaceId, email, role.id, tokenHash, expiresAt, ctx.userId],
        );
        const invitationId = inserted[0]!.id;
        const outbox = await this.enqueueEmail(manager, ctx, { invitationId, email, workspaceId: ctx.workspaceId!, token });
        published.push(outbox);
        await this.audit.record(manager, ctx, AuditAction.MEMBER_INVITATION_SENT, {
          entityType: 'member_invitation',
          entityId: invitationId,
          metadata: { roleId: role.id, roleName: role.name, sendCount: 1, emailOutboxId: outbox.id },
        });
        const item = await this.loadItem(manager, invitationId);
        return { email, outcome: MemberInvitationOutcome.INVITED, invitation: item ?? undefined };
      });
    } catch (error) {
      // member_invitation_one_live_per_email: a concurrent send for the same address won, or a live invitation
      // exists in a workspace this caller cannot see. Re-check visibility in a fresh transaction to pick the
      // outcome without disclosing the other workspace's invitation.
      if (error instanceof QueryFailedError && (error as unknown as { code?: string }).code === '23505') {
        const visible = await this.tenantContext.runInTenantContext(ctx, (manager) =>
          manager.query(`SELECT 1 FROM core.member_invitation WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL`, [email]),
        );
        return { email, outcome: visible.length > 0 ? MemberInvitationOutcome.ALREADY_INVITED : MemberInvitationOutcome.UNAVAILABLE };
      }
      throw error;
    }
  }

  private newToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashToken(token) };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async enqueueEmail(
    manager: EntityManager,
    ctx: AuthContext,
    params: { invitationId: string; email: string; workspaceId: string; token: string },
  ): Promise<EmailOutbox> {
    // The raw token exists only here, in the rendered email, exactly as for account invitations (see the
    // trade-off recorded in THREAT-MODEL.md). It is never returned by any API, logged by this service, or audited.
    const activationUrl = `${this.env.get('ACCOUNTS_URL')}/accept-invitation?token=${encodeURIComponent(params.token)}`;
    return this.emailOutbox.enqueue(manager, {
      organisationId: ctx.organisationId!,
      jobType: EmailOutboxJobType.MEMBER_INVITATION,
      recipientEmail: params.email,
      memberInvitationId: params.invitationId,
      // Lets the worker bind the invitation's workspace before revalidating it under RLS.
      workspaceId: params.workspaceId,
      rendered: renderMemberInvitationEmail({ recipientEmail: params.email, activationUrl }),
      createdBy: ctx.userId,
    });
  }

  private async cancelOpenEmails(manager: EntityManager, invitationId: string, reason: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(EmailOutbox)
      .set({ status: EmailOutboxStatus.CANCELLED, cancelledAt: () => 'now()', lastErrorMessageSanitized: reason })
      .where('member_invitation_id = :invitationId AND status IN (:...open)', { invitationId, open: OPEN_OUTBOX_STATUSES })
      .execute();
  }

  // ── List ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Pending invitations of the caller's own workspace (RLS + explicit workspace filter), optionally filtered by status/email. */
  async list(
    ctx: AuthContext,
    page = 1,
    limit = 25,
    filter: { q?: string; status?: MemberInvitationStatusType } = {},
  ): Promise<{ data: MemberInvitationItem[]; total: number; page: number; limit: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertAdministratorTx(manager, ctx);
      const params: unknown[] = [ctx.workspaceId];
      let where = `i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.superseded_at IS NULL`;
      if (filter.q) {
        params.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where += ` AND i.email::text ILIKE $${params.length}`;
      }
      // Status is derived (expiry + latest email row), so it is filtered after derivation within the live set.
      const rows = await manager.query<InvitationRow[]>(`${this.selectSql()} WHERE ${where} ORDER BY i.created_at DESC, i.id`, params);
      const items = rows.map((r) => this.toItem(r)).filter((item) => !filter.status || item.status === filter.status);
      const offset = (page - 1) * limit;
      return { data: items.slice(offset, offset + limit), total: items.length, page, limit };
    });
  }

  private selectSql(): string {
    return `SELECT i.id, i.organisation_id, i.workspace_id, i.email::text AS email, i.role_id, r.name AS role_name, i.send_count, i.expires_at,
                   i.last_sent_at, i.created_at, i.invited_by, i.accepted_at, i.revoked_at, i.superseded_at, (i.expires_at <= now()) AS is_expired,
                   u.first_name AS invited_by_first, u.last_name AS invited_by_last,
                   (SELECT eo.status FROM core.email_outbox eo WHERE eo.member_invitation_id = i.id ORDER BY eo.created_at DESC, eo.id DESC LIMIT 1) AS outbox_status
              FROM core.member_invitation i
              LEFT JOIN core.role r ON r.id = i.role_id
              LEFT JOIN core."user" u ON u.id = i.invited_by`;
  }

  private async loadItem(manager: EntityManager, id: string): Promise<MemberInvitationItem | null> {
    const [row] = await manager.query<InvitationRow[]>(`${this.selectSql()} WHERE i.id = $1`, [id]);
    return row ? this.toItem(row) : null;
  }

  private toItem(row: InvitationRow): MemberInvitationItem {
    return {
      id: row.id,
      email: row.email,
      role: { id: row.role_id, name: row.role_name ?? 'Role' },
      status: this.deriveStatus(row),
      sendCount: row.send_count,
      maxSends: MEMBER_INVITATION_MAX_SENDS,
      expiresAt: row.expires_at,
      lastSentAt: row.last_sent_at,
      createdAt: row.created_at,
      invitedByName: [row.invited_by_first, row.invited_by_last].filter((p) => p && p.trim()).join(' ') || null,
    };
  }

  /** Invitation state, never account state. `sent` only once the provider confirmed the latest email. */
  private deriveStatus(row: InvitationRow): MemberInvitationStatusType {
    if (row.accepted_at) return MemberInvitationStatus.ACCEPTED;
    if (row.revoked_at) return MemberInvitationStatus.REVOKED;
    if (row.superseded_at) return MemberInvitationStatus.SUPERSEDED;
    if (row.is_expired) return MemberInvitationStatus.EXPIRED;
    switch (row.outbox_status) {
      case EmailOutboxStatus.SENT:
        return MemberInvitationStatus.SENT;
      case EmailOutboxStatus.PROCESSING:
      case EmailOutboxStatus.RETRY:
        return MemberInvitationStatus.SENDING;
      case EmailOutboxStatus.FAILED:
        return MemberInvitationStatus.DELIVERY_FAILED;
      default:
        return MemberInvitationStatus.QUEUED;
    }
  }

  // ── Resend / revoke ──────────────────────────────────────────────────────────────────────────────────────

  /** Loads an invitation of the caller's own workspace, or 404 — another workspace's invitation is indistinguishable from a missing one. */
  private async findActionable(manager: EntityManager, ctx: AuthContext, id: string, lock: boolean): Promise<InvitationRow> {
    if (!UUID.test(id)) throw new NotFoundException('Invitation not found.');
    await this.assertAdministratorTx(manager, ctx);
    const [row] = await manager.query<InvitationRow[]>(
      `SELECT i.*, i.email::text AS email, (i.expires_at <= now()) AS is_expired FROM core.member_invitation i
        WHERE i.id = $1 AND i.workspace_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [id, ctx.workspaceId],
    );
    if (!row) throw new NotFoundException('Invitation not found.');
    return row;
  }

  async resend(ctx: AuthContext, id: string): Promise<MemberInvitationItem> {
    const snapshot = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.assertOrganisationActive(manager, ctx.organisationId!);
      const row = await this.findActionable(manager, ctx, id, false);
      if (row.accepted_at || row.revoked_at || row.superseded_at) throw new ConflictException('This invitation is no longer pending.');
      // Re-check that THIS actor may still grant the role — a resend re-issues a credential (Twenty skips this).
      await this.memberRolePolicy.loadAssignableTx(manager, ctx, row.role_id);
      if (row.send_count >= MEMBER_INVITATION_MAX_SENDS) {
        throw new ConflictException({ code: 'MAX_SENDS_REACHED', message: 'This invitation has been sent the maximum number of times. Revoke it and send a new invitation.' });
      }
      return row;
    });

    await this.rateLimit.assertCanSend({ actorUserId: ctx.userId, organisationId: ctx.organisationId!, recipientEmails: [snapshot.email] });

    let published: { id: string; organisationId: string } | null = null;
    const item = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const { token, tokenHash } = this.newToken();
      const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
      // Compare-and-set on the send count we validated: a concurrent resend, revoke or acceptance makes this a no-op.
      const updated = await manager.query<Array<{ id: string }>>(
        `UPDATE core.member_invitation
            SET token_hash = $1, send_count = send_count + 1, expires_at = $2, last_sent_at = now(), updated_at = now()
          WHERE id = $3 AND send_count = $4 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL
          RETURNING id`,
        [tokenHash, expiresAt, snapshot.id, snapshot.send_count],
      );
      if (updated.length === 0) throw new ConflictException('This invitation changed while you were resending it. Refresh and try again.');
      // The previous link is now dead (its hash no longer exists); any of its emails still waiting are cancelled.
      await this.cancelOpenEmails(manager, snapshot.id, 'Superseded by a resend.');
      const outbox = await this.enqueueEmail(manager, ctx, { invitationId: snapshot.id, email: snapshot.email, workspaceId: snapshot.workspace_id, token });
      published = outbox;
      await this.audit.record(manager, ctx, AuditAction.MEMBER_INVITATION_RESENT, {
        entityType: 'member_invitation',
        entityId: snapshot.id,
        metadata: { roleId: snapshot.role_id, sendCount: snapshot.send_count + 1, emailOutboxId: outbox.id },
      });
      return this.loadItem(manager, snapshot.id);
    });
    if (published) void this.emailOutbox.tryFastPublish((rowId, orgId) => this.emailQueue.publish(rowId, orgId), published);
    return item!;
  }

  async revoke(ctx: AuthContext, id: string): Promise<MemberInvitationItem> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await this.findActionable(manager, ctx, id, true);
      if (row.accepted_at) throw new ConflictException('This invitation has already been accepted.');
      if (row.revoked_at || row.superseded_at) throw new ConflictException('This invitation is no longer pending.');
      const updated = await manager.query<Array<{ id: string }>>(
        `UPDATE core.member_invitation SET revoked_at = now(), revoked_by = $2, updated_at = now()
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL RETURNING id`,
        [row.id, ctx.userId],
      );
      if (updated.length === 0) throw new ConflictException('This invitation is no longer pending.');
      await this.cancelOpenEmails(manager, row.id, 'Invitation revoked.');
      await this.audit.record(manager, ctx, AuditAction.MEMBER_INVITATION_REVOKED, { entityType: 'member_invitation', entityId: row.id, metadata: { roleId: row.role_id } });
      return (await this.loadItem(manager, row.id))!;
    });
  }

  // ── Public: resolve and accept ───────────────────────────────────────────────────────────────────────────

  private async locate(token: string): Promise<{ invitationId: string; organisationId: string; workspaceId: string; tokenHash: string } | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const tokenHash = this.hashToken(token);
    const [found] = await this.dataSource.query<Array<{ invitationId: string; organisationId: string; workspaceId: string }>>(
      'SELECT * FROM core.auth_find_member_invitation($1)',
      [tokenHash],
    );
    return found ? { ...found, tokenHash } : null;
  }

  /** Live, unexpired, organisation active, workspace active. Runs under the invitation's own tenant context. */
  private async loadLive(manager: EntityManager, invitationId: string, tokenHash: string, lock: boolean): Promise<InvitationRow | null> {
    const [row] = await manager.query<InvitationRow[]>(
      `SELECT i.*, i.email::text AS email, (i.expires_at <= now()) AS is_expired FROM core.member_invitation i
        WHERE i.id = $1 AND i.token_hash = $2${lock ? ' FOR UPDATE' : ''}`,
      [invitationId, tokenHash],
    );
    if (!row || row.accepted_at || row.revoked_at || row.superseded_at || row.is_expired) return null;
    const [org] = await manager.query<Array<{ suspended_at: string | null }>>(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [row.organisation_id]);
    if (!org || org.suspended_at) return null;
    const [ws] = await manager.query<Array<{ status: string }>>(`SELECT status FROM core.manager_workspace WHERE id = $1`, [row.workspace_id]);
    if (!ws || ws.status !== 'active') return null;
    return row;
  }

  async resolve(token: string, clientIp: string): Promise<{ email: string; roleLabel: string; workspaceName: string | null; expiresAt: Date }> {
    await this.rateLimit.assertCanRedeem(clientIp);
    const found = await this.locate(token);
    if (!found) throw new BadRequestException(INVALID_INVITATION_MESSAGE);
    const ctx: AuthContext = { organisationId: found.organisationId, workspaceId: found.workspaceId, userId: '', role: '' };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const row = await this.loadLive(manager, found.invitationId, found.tokenHash, false);
      if (!row) throw new BadRequestException(INVALID_INVITATION_MESSAGE);
      const [ws] = await manager.query<Array<{ name: string }>>(`SELECT name FROM core.manager_workspace WHERE id = $1`, [row.workspace_id]);
      const [role] = await manager.query<Array<{ name: string }>>(`SELECT name FROM core.role WHERE id = $1`, [row.role_id]);
      return { email: row.email, roleLabel: role?.name ?? 'Member', workspaceName: ws?.name ?? null, expiresAt: row.expires_at };
    });
  }

  /**
   * Accept: the recipient supplies their own name and password; the server creates the real identity (user + the
   * invitation's custom role + organisation membership + membership of the inviter's workspace) and consumes the
   * invitation — all in ONE transaction holding the invitation's row lock, so simultaneous acceptances, a revoke
   * or resend racing this, or expiry, can never yield more than one account or a half-created one. The
   * one-active-membership-per-user index and the (organisation, email) user uniqueness are the database backstops.
   *
   * The creation runs under the INVITER's authority, re-verified now: still ACTIVE, still the owner of this
   * workspace with an active membership, still holding ROLE_MANAGE, and still allowed to grant this role (it must
   * still be a custom role of this workspace whose every permission the inviter holds — checked again here, not
   * trusted from send time). If any of that fails, or an account with this email now exists in the organisation,
   * the invitation is marked SUPERSEDED (committed) and the recipient gets the same generic failure as any other
   * invalid link.
   *
   * Like `/auth/activate-account`, this issues no session: the account stays INVITED with a password and becomes
   * ACTIVE at its first ordinary sign-in, through the unchanged login/session machinery.
   */
  async accept(
    dto: { token: string; firstName: string; lastName: string; newPassword: string },
    clientIp: string,
  ): Promise<{ applicationTarget: ApplicationTarget; managerLoginUrl: string }> {
    await this.rateLimit.assertCanRedeem(clientIp);
    const found = await this.locate(dto.token);
    if (!found) throw new BadRequestException(INVALID_INVITATION_MESSAGE);
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    if (!firstName || !lastName) throw new BadRequestException('Enter your first and last name.');

    const baseCtx: AuthContext = { organisationId: found.organisationId, workspaceId: found.workspaceId, userId: '', role: '' };

    const outcome = await this.tenantContext.runInWorkspaceContext(baseCtx, async (manager): Promise<{ ok: true; userId: string } | { ok: false }> => {
      const row = await this.loadLive(manager, found.invitationId, found.tokenHash, true);
      if (!row) throw new BadRequestException(INVALID_INVITATION_MESSAGE);

      const supersede = async (reason: string) => {
        await manager.query(
          `UPDATE core.member_invitation SET superseded_at = now(), updated_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL`,
          [row.id],
        );
        await this.cancelOpenEmails(manager, row.id, 'Invitation superseded.');
        await this.audit.record(manager, baseCtx, AuditAction.MEMBER_INVITATION_SUPERSEDED, {
          entityType: 'member_invitation',
          entityId: row.id,
          metadata: { reason },
          actorUserId: null,
        });
        return { ok: false as const };
      };

      // One account per email per organisation: if one now exists (created through another path since the
      // invitation was sent), never create a second identity and never attach this invitation to it.
      const existing = await manager.query(`SELECT 1 FROM core."user" WHERE organisation_id = $1 AND email = $2`, [row.organisation_id, row.email]);
      if (existing.length > 0) return supersede('email_already_has_account');

      // Re-verify the inviter's authority NOW, not as it was when the email was sent.
      if (!row.invited_by) return supersede('inviter_missing');
      const [inviter] = await manager.query<Array<{ status: string }>>(`SELECT status FROM core."user" WHERE id = $1`, [row.invited_by]);
      if (!inviter || inviter.status !== UserStatus.ACTIVE) return supersede('inviter_not_active');
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [row.invited_by]);
      const inviterCtx: AuthContext = { ...baseCtx, userId: row.invited_by };
      if (!(await this.isWorkspaceAdministratorTx(manager, inviterCtx))) return supersede('inviter_no_longer_authorised');
      try {
        await this.memberRolePolicy.loadAssignableTx(manager, inviterCtx, row.role_id);
      } catch {
        return supersede('role_no_longer_assignable');
      }

      const { valid, reasons } = checkPasswordStrength(dto.newPassword, row.email);
      if (!valid) throw new BadRequestException(reasons.join(' '));
      const passwordHash = await this.passwordHashing.hash(dto.newPassword);
      const acceptedAt = new Date();

      const userResult = await manager.insert(User, {
        organisationId: row.organisation_id,
        email: row.email,
        firstName,
        lastName,
        passwordHash,
        mustResetPassword: false,
        // Possession of the emailed single-use token proves control of this address.
        emailVerifiedAt: acceptedAt,
      });
      const userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId: row.role_id, organisationId: row.organisation_id });
      await manager.insert(OrganisationMember, { organisationId: row.organisation_id, userId });
      await this.workspaceMembership.assignToWorkspace(manager, inviterCtx, userId);

      const consumed = await manager.query<Array<{ id: string }>>(
        `UPDATE core.member_invitation SET accepted_at = $2, accepted_user_id = $3, updated_at = now()
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL AND expires_at > now() RETURNING id`,
        [row.id, acceptedAt, userId],
      );
      if (consumed.length === 0) throw new BadRequestException(INVALID_INVITATION_MESSAGE); // rolls back the identity too
      await this.cancelOpenEmails(manager, row.id, 'Invitation accepted.');
      await this.audit.record(manager, inviterCtx, AuditAction.USER_CREATED, {
        targetUserId: userId,
        metadata: { source: 'member_invitation', invitationId: row.id, roleId: row.role_id },
      });
      await this.audit.record(manager, baseCtx, AuditAction.MEMBER_INVITATION_ACCEPTED, {
        entityType: 'member_invitation',
        entityId: row.id,
        targetUserId: userId,
        actorUserId: userId,
        metadata: { roleId: row.role_id },
      });
      return { ok: true, userId };
    });

    if (!outcome.ok) throw new BadRequestException(INVALID_INVITATION_MESSAGE);
    // Workspace members use the manager web console only (application-access.ts).
    return { applicationTarget: 'manager_web', managerLoginUrl: `${this.env.get('APP_URL')}/login` };
  }
}
