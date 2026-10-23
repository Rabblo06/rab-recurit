import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ApplicationTarget, passwordExemptForMobileWorkforce } from '../application-access';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { RefreshTokenService } from '../token/services/refresh-token.service';

export const PASSWORD_SIGN_IN_DISABLED_REVOCATION_REASON = 'password_sign_in_disabled';

/**
 * Wave 1 lane A — finding D-A2. OWNER DECISION (2026-10-23): "Log them out". When an organisation turns password
 * sign-in OFF, its existing password-authenticated sessions are revoked immediately; Google/Microsoft sessions are
 * unaffected and users re-authenticate with SSO.
 *
 * Called by `OrganisationAuthProvidersService.update` on a true→false change of `password_auth_enabled`, with the SAME
 * tenant-bound `EntityManager` (one transaction): the setting change, every revocation and the audit rows commit or roll
 * back together — the setting can never be off while the revocation silently failed.
 *
 * Reuses the existing mechanism only: `RefreshTokenService.revokeFamily` ends the refresh-token family and its
 * `core.user_session` row together and bumps that session's `security_version` (so `SessionValidityService` and the
 * session caches refuse it on the very next request, Bearer or cookie). The caller also bumps the organisation's security
 * version. No new table, column or migration.
 *
 * Exempt (never revoked): sessions the setting itself still allows — an identity whose roles are EXCLUSIVELY
 * staff/venue_manager, signed in to its own mobile app (`passwordExemptForMobileWorkforce`, the same predicate
 * `AuthService.completeLogin` uses, so login and revocation can never disagree). Revoking those would only force a
 * password re-login that is then allowed again.
 */
@Injectable()
export class PasswordSessionRevocationService {
  private readonly logger = new Logger(PasswordSessionRevocationService.name);

  constructor(
    private readonly refreshTokens: RefreshTokenService,
    private readonly auditService: AuditService,
  ) {}

  /** Revokes the organisation's live password sessions (except exempt ones) and audits it. Returns the revoked count. */
  async revokeForPasswordSignInDisabled(manager: EntityManager, ctx: AuthContext, organisationId: string): Promise<number> {
    const sessions = await manager.query<Array<{ id: string; user_id: string; application_target: ApplicationTarget }>>(
      `SELECT id, user_id, application_target FROM core.user_session
        WHERE organisation_id = $1 AND auth_provider = 'password' AND revoked_at IS NULL
        FOR UPDATE`,
      [organisationId],
    );
    const exemptByUserAndTarget = new Map<string, boolean>();
    let revoked = 0;
    for (const session of sessions) {
      const cacheKey = `${session.user_id}:${session.application_target}`;
      let exempt = exemptByUserAndTarget.get(cacheKey);
      if (exempt === undefined) {
        const roles = (
          await manager.query<Array<{ key: string }>>(
            'SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1',
            [session.user_id],
          )
        ).map((r) => r.key);
        const [{ admin }] = await manager.query<[{ admin: boolean }]>('SELECT core.is_active_platform_admin($1) AS admin', [session.user_id]);
        exempt = passwordExemptForMobileWorkforce(roles, admin, session.application_target);
        exemptByUserAndTarget.set(cacheKey, exempt);
      }
      if (exempt) continue;
      await this.refreshTokens.revokeFamily(manager, session.id, PASSWORD_SIGN_IN_DISABLED_REVOCATION_REASON);
      revoked++;
    }
    await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_PASSWORD_SESSIONS_REVOKED, {
      entityType: 'organisation',
      entityId: organisationId,
      metadata: { revoked, exempt: sessions.length - revoked, reason: PASSWORD_SIGN_IN_DISABLED_REVOCATION_REASON },
    });
    this.logger.log(`password sign-in disabled: ${revoked} password session(s) revoked, ${sessions.length - revoked} exempt`);
    return revoked;
  }
}
