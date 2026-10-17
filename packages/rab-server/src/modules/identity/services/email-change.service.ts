import { EmailOutboxJobType, normalizeEmail, PermissionFlagType, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { renderEmailChangeNoticeEmail, renderEmailChangeVerificationEmail } from '../../../engine/core-modules/email/templates';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { EMAIL_UNAVAILABLE_CODE, EMAIL_UNAVAILABLE_MESSAGE, isEmailUnavailableViolation } from '../../../engine/filters/email-unavailable';

const REQUEST_TTL_HOURS = 24;
const INVALID_LINK = 'This confirmation link is invalid or has expired.';

export interface EmailChangeRequestResult {
  status: 'pending_verification';
  /** The current (still authoritative) email. The new address is never echoed back. */
  email: string;
}

/**
 * CF-04 (October 15 audit): an email change on an ACTIVE account is a credential change, not a data edit.
 *
 * request():  authorised actor (layer-2 permission re-check here, not only the route guard) + step-up with the actor's own
 *             current password; refused for a platform-admin target; uniqueness checked; one open request per user (a newer
 *             request cancels the older one); a single-use token (only its SHA-256 is stored) mailed to the NEW address and a
 *             notice to the OLD one. `user.email` does not change.
 * confirm():  pre-auth, by token. Locks the request and the user, re-checks eligibility and uniqueness, then in one
 *             transaction: changes the email, ends every session, bumps the security version, removes Google/Microsoft
 *             links (they re-link only with a provider-verified match of the new address — a subject never silently
 *             follows the old email), voids outstanding password-reset tokens, audits and notifies the old address.
 *
 * Pending (never activated) accounts keep the existing direct correction path in StaffService/ManagerService: they hold no
 * credential and no data, and correcting a typo before the invitation is (re)sent is the point of that path.
 */
@Injectable()
export class EmailChangeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly stepUp: StepUpReauthService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly auditService: AuditService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly env: EnvironmentService,
  ) {}

  async request(
    ctx: AuthContext,
    params: { targetUserId: string; newEmail: string; currentPassword: string | undefined; requiredPermission: PermissionFlagType },
  ): Promise<EmailChangeRequestResult> {
    await this.assertStepUp(ctx, params.currentPassword);
    const newEmail = normalizeEmail(params.newEmail);
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const queued = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (!(await this.permissions.userHasPermissionTx(manager, ctx, params.requiredPermission))) {
        throw new ForbiddenException('You do not have access to this. Ask an administrator if you need it.');
      }
      const [target] = await manager.query<Array<{ id: string; email: string; first_name: string; status: string }>>(
        `SELECT id, email, first_name, status FROM core."user" WHERE id = $1 AND organisation_id = $2 FOR UPDATE`,
        [params.targetUserId, ctx.organisationId],
      );
      if (!target) throw new NotFoundException('User not found.');
      if (target.status !== UserStatus.ACTIVE) throw new BadRequestException('Only an active account needs a confirmed email change.');
      await this.assertNotProtectedTx(manager, target.id);
      if (normalizeEmail(target.email) === newEmail) throw new BadRequestException("This is already this account's email.");
      await this.assertEmailAvailableTx(manager, ctx.organisationId!, newEmail);

      await manager.query(
        `UPDATE core.email_change_request SET cancelled_at = now(), cancel_reason = 'superseded'
          WHERE user_id = $1 AND confirmed_at IS NULL AND cancelled_at IS NULL`,
        [target.id],
      );
      await manager.query(
        `INSERT INTO core.email_change_request (organisation_id, user_id, new_email, token_hash, requested_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
        [ctx.organisationId, target.id, newEmail, tokenHash, ctx.inspectedBy ?? ctx.userId, REQUEST_TTL_HOURS],
      );
      const confirmUrl = `${this.env.get('ACCOUNTS_URL')}/confirm-email-change?token=${token}`;
      const verification = await this.emailOutbox.enqueue(manager, {
        organisationId: ctx.organisationId!,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: newEmail,
        targetUserId: target.id,
        rendered: renderEmailChangeVerificationEmail({ confirmUrl, expiresInHours: REQUEST_TTL_HOURS }),
      });
      const notice = await this.emailOutbox.enqueue(manager, {
        organisationId: ctx.organisationId!,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: target.email,
        targetUserId: target.id,
        rendered: renderEmailChangeNoticeEmail({ firstName: target.first_name, stage: 'requested' }),
      });
      await this.auditService.record(manager, ctx, AuditAction.EMAIL_CHANGE_REQUESTED, {
        targetUserId: target.id,
        metadata: { from: target.email, to: newEmail },
      });
      return { rows: [verification, notice], email: target.email };
    });
    for (const row of queued.rows) void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
    return { status: 'pending_verification', email: queued.email };
  }

  async confirm(token: string): Promise<{ confirmed: true }> {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new BadRequestException(INVALID_LINK);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [found] = await this.dataSource.query<Array<{ requestId: string; organisationId: string; userId: string }>>(
      'SELECT * FROM core.auth_find_email_change_request($1)',
      [tokenHash],
    );
    if (!found) throw new BadRequestException(INVALID_LINK);
    const ctx: AuthContext = { organisationId: found.organisationId, workspaceId: null, userId: found.userId, role: '' };

    const notice = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Lock order: request, then user (the same order request() uses user-then-request only inside its own row set).
      const [request] = await manager.query<Array<{ id: string; new_email: string; requested_by: string | null }>>(
        `SELECT id, new_email, requested_by FROM core.email_change_request
          WHERE id = $1 AND token_hash = $2 AND confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [found.requestId, tokenHash],
      );
      if (!request) throw new BadRequestException(INVALID_LINK);
      const [user] = await manager.query<Array<{ id: string; email: string; first_name: string; status: string }>>(
        `SELECT id, email, first_name, status FROM core."user" WHERE id = $1 FOR UPDATE`,
        [found.userId],
      );
      if (!user || user.status !== UserStatus.ACTIVE) {
        await this.cancelTx(manager, request.id, 'account_not_active');
        return { cancelled: true as const };
      }
      if (await this.isProtectedTx(manager, user.id)) {
        await this.cancelTx(manager, request.id, 'protected_account');
        return { cancelled: true as const };
      }
      // Savepoint: the cross-organisation uniqueness trigger raises inside this transaction, and the request must still be
      // cancelled (committed) when the new address turned out to be taken in the meantime.
      await manager.query('SAVEPOINT email_change_apply');
      try {
        await this.assertEmailAvailableTx(manager, found.organisationId, request.new_email);
        await manager.query(`UPDATE core."user" SET email = $2 WHERE id = $1`, [user.id, request.new_email]);
        await manager.query('RELEASE SAVEPOINT email_change_apply');
      } catch (error) {
        if (error instanceof ConflictException || isEmailUnavailableViolation(error)) {
          await manager.query('ROLLBACK TO SAVEPOINT email_change_apply');
          await this.cancelTx(manager, request.id, 'email_unavailable');
          return { cancelled: true as const };
        }
        throw error;
      }
      await manager.query(`UPDATE core.email_change_request SET confirmed_at = now() WHERE id = $1`, [request.id]);
      await this.securityVersion.bumpUser(manager, user.id);
      await this.refreshTokens.revokeAllForUser(manager, user.id, 'email_changed');
      await manager.query(`SELECT core.unlink_provider_identities_for_user($1)`, [user.id]);
      await manager.query(`UPDATE core.password_reset_token SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await this.auditService.record(manager, ctx, AuditAction.EMAIL_CHANGE_CONFIRMED, {
        targetUserId: user.id,
        actorUserId: null,
        metadata: { from: user.email, to: request.new_email, requestedBy: request.requested_by },
      });
      const row = await this.emailOutbox.enqueue(manager, {
        organisationId: found.organisationId,
        jobType: EmailOutboxJobType.NOTIFICATION,
        recipientEmail: user.email,
        targetUserId: user.id,
        rendered: renderEmailChangeNoticeEmail({ firstName: user.first_name, stage: 'completed' }),
      });
      return { cancelled: false as const, row };
    });
    // A request that can no longer be honoured is cancelled (committed above) and reported exactly like an invalid link.
    if (notice.cancelled) throw new BadRequestException(INVALID_LINK);
    void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), notice.row);
    return { confirmed: true };
  }

  /** Step-up with the ACTOR's own current password. A password-less (Google/Microsoft-only) actor cannot pass it. */
  private async assertStepUp(ctx: AuthContext, currentPassword: string | undefined): Promise<void> {
    if (ctx.inspectedBy) throw new ForbiddenException('Admin Inspect is read-only.');
    if (!currentPassword) {
      throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', message: 'Confirm your own current password to change this email.' });
    }
    const [row] = await this.tenantContext.runInTenantContext({ ...ctx, workspaceId: null }, (manager) =>
      manager.query<Array<{ passwordHash: string | null }>>('SELECT "passwordHash" FROM core.auth_find_password_hash_by_user_id($1)', [ctx.userId]),
    );
    if (!row?.passwordHash) {
      throw new ForbiddenException({
        code: 'STEP_UP_UNAVAILABLE',
        message: 'Your account signs in without a password, so it cannot confirm this change. Ask an administrator who signs in with a password.',
      });
    }
    await this.stepUp.assertCurrentPassword(ctx, currentPassword);
  }

  private async isProtectedTx(manager: EntityManager, userId: string): Promise<boolean> {
    const [row] = await manager.query<Array<{ ok: boolean }>>(`SELECT core.is_active_platform_admin($1) AS ok`, [userId]);
    return row?.ok === true;
  }

  private async assertNotProtectedTx(manager: EntityManager, userId: string): Promise<void> {
    if (await this.isProtectedTx(manager, userId)) {
      throw new ForbiddenException({ code: 'PROTECTED_ACCOUNT', message: "A platform administrator's sign-in email can't be changed here." });
    }
  }

  private async assertEmailAvailableTx(manager: EntityManager, organisationId: string, email: string): Promise<void> {
    const [local] = await manager.query<unknown[]>(`SELECT 1 FROM core."user" WHERE organisation_id = $1 AND email = $2`, [organisationId, email]);
    if (local) throw new ConflictException('A user with this email already exists.');
    const [elsewhere] = await manager.query<Array<{ taken: boolean }>>(`SELECT core.email_registered_in_another_organisation($1) AS taken`, [email]);
    if (elsewhere?.taken) throw new ConflictException({ code: EMAIL_UNAVAILABLE_CODE, message: EMAIL_UNAVAILABLE_MESSAGE });
  }

  private async cancelTx(manager: EntityManager, requestId: string, reason: string): Promise<void> {
    await manager.query(`UPDATE core.email_change_request SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [requestId, reason]);
  }
}
