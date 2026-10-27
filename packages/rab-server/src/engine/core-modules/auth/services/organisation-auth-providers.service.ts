import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Organisation } from '../../../../modules/identity/entities';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { EnvironmentService } from '../../environment/environment.service';
import { PlatformAdminService } from '../../platform-admin/platform-admin.service';
import { AuthContext } from '../../tenant/auth-context.interface';
import { TenantContextService } from '../../tenant/tenant-context.service';
import { PasswordSessionRevocationService } from './password-session-revocation.service';
import { SecurityVersionService } from './security-version.service';
import { StepUpReauthService } from './step-up-reauth.service';

export type AuthProviderKey = 'password' | 'google' | 'microsoft';

export interface EffectiveAuthProviders {
  password: boolean;
  google: boolean;
  microsoft: boolean;
}

export interface OrganisationAuthProviderFlags {
  passwordAuthEnabled: boolean;
  googleAuthEnabled: boolean;
  microsoftAuthEnabled: boolean;
}

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.5/§33.7.6/§33.7.12, OrganisationAuthProviders1786680100000).
 *
 * The one place "is provider X usable right now" is decided — always `system ENV flag AND
 * organisation's own column`. Used by: `AuthService.signInWithProvider` (service-layer gate,
 * never trusting a guard alone — CLAUDE.md's 5-layer model, layer 2), the Google/Microsoft
 * provider-enabled guards (layer 1, system-only — org isn't known until the callback resolves an
 * identity), `GET /rest/v1/auth/config` (public, pre-auth), `WorkspaceController`'s read-only
 * Settings -> Security -> Authentication view, and the platform-admin organisation settings routes.
 *
 * W6-E2E-04 (owner decision 2026-10-23): CHANGING an organisation's sign-in methods is PLATFORM ADMIN ONLY. `update()`
 * takes the acting user and the TARGET organisation separately and re-checks `core.is_active_platform_admin` itself
 * (layer 2 — jobs/CLI/other services never pass the HTTP guard). No tenant role can change it, whatever it holds.
 *
 * Lockout prevention is TWO independent layers, per the owner's explicit instruction not to
 * accept the P1C.1A-named narrow gap:
 *  1. The DB CHECK constraint (`organisation_auth_provider_not_all_disabled`) — an organisation's
 *     OWN three flags can never all be false, structurally, regardless of caller.
 *  2. `update()` below computes the EFFECTIVE (system AND org) result of the requested change
 *     and refuses it if that result would leave zero usable providers — this is the layer that
 *     catches "org flag true but system flag false" combinations the CHECK constraint alone
 *     cannot see.
 *  3. `OnApplicationBootstrap` (this class) scans every organisation once at process start and
 *     refuses to boot if ANY of them would have zero effective providers under the CURRENT
 *     system env — protects against an operator changing ENV and accidentally locking out
 *     existing organisations that were fine under the previous configuration.
 */
@Injectable()
export class OrganisationAuthProvidersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrganisationAuthProvidersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly env: EnvironmentService,
    private readonly auditService: AuditService,
    private readonly securityVersion: SecurityVersionService,
    private readonly passwordSessions: PasswordSessionRevocationService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly stepUp: StepUpReauthService,
  ) {}

  systemEnabled(): EffectiveAuthProviders {
    return {
      password: this.env.get('AUTH_PASSWORD_ENABLED'),
      google: this.env.get('AUTH_GOOGLE_ENABLED'),
      microsoft: this.env.get('AUTH_MICROSOFT_ENABLED'),
    };
  }

  private effectiveFrom(system: EffectiveAuthProviders, org: OrganisationAuthProviderFlags): EffectiveAuthProviders {
    return {
      password: system.password && org.passwordAuthEnabled,
      google: system.google && org.googleAuthEnabled,
      microsoft: system.microsoft && org.microsoftAuthEnabled,
    };
  }

  private isLockedOut(effective: EffectiveAuthProviders): boolean {
    return !effective.password && !effective.google && !effective.microsoft;
  }

  async getOrganisationFlags(manager: EntityManager, organisationId: string): Promise<OrganisationAuthProviderFlags> {
    const org = await manager.findOneOrFail(Organisation, { where: { id: organisationId } });
    return { passwordAuthEnabled: org.passwordAuthEnabled, googleAuthEnabled: org.googleAuthEnabled, microsoftAuthEnabled: org.microsoftAuthEnabled };
  }

  async getEffective(ctx: AuthContext): Promise<EffectiveAuthProviders> {
    const org = await this.tenantContext.runInTenantContext(ctx, (manager) => this.getOrganisationFlags(manager, ctx.organisationId!));
    return this.effectiveFrom(this.systemEnabled(), org);
  }

  /**
   * Pre-auth, by slug — `GET /rest/v1/auth/config`'s own org-scoped branch. Returns the
   * system-only view for an unknown slug (never reveals whether the slug exists via a different
   * response shape).
   */
  async getEffectiveBySlug(slug: string): Promise<EffectiveAuthProviders> {
    const system = this.systemEnabled();
    const [org] = await this.dataSource.query<[OrganisationAuthProviderFlags | undefined]>(
      'SELECT password_auth_enabled AS "passwordAuthEnabled", google_auth_enabled AS "googleAuthEnabled", microsoft_auth_enabled AS "microsoftAuthEnabled" FROM core.auth_find_organisation_by_slug($1)',
      [slug],
    );
    return org ? this.effectiveFrom(system, org) : system;
  }

  /** Service-layer gate — never trust the controller guard alone (CLAUDE.md layer 2). Generic failure, no reason disclosed. */
  async assertProviderEnabledOrThrow(ctx: AuthContext, provider: AuthProviderKey): Promise<void> {
    const effective = await this.getEffective(ctx);
    if (!effective[provider]) {
      throw new UnauthorizedException('We could not sign you in. Try again or use another sign-in method.');
    }
  }

  /**
   * Mutation-time lockout validation (owner decision §4A). Computes the EFFECTIVE result of the
   * proposed patch under the CURRENT system env and refuses the write (the previous configuration
   * remains unchanged — the whole call is one transaction) if it would leave zero usable
   * providers. The DB CHECK constraint is a second, independent backstop for the narrower "all
   * three org flags false" case; this check is the one that also sees the system side.
   *
   * W6-E2E-04: `actor` must be an ACTIVE platform administrator (checked in this transaction; 403 otherwise, before
   * anything is read) and may target any organisation (`targetOrganisationId`, 404 if it does not exist). The
   * transaction is bound to the TARGET organisation, so the row, the security-version bump, the wave-1 password-session
   * revocation and both audit entries land in that organisation, attributed to the administrator.
   */
  async update(
    actor: Pick<AuthContext, 'userId' | 'inspectedBy' | 'organisationId' | 'workspaceId' | 'sessionId'>,
    targetOrganisationId: string,
    patch: Partial<OrganisationAuthProviderFlags>,
  ): Promise<OrganisationAuthProviderFlags> {
    if (actor.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    // Lane D (M10-2, closes W6X trade-off 2): changing an organisation's sign-in methods (incl. turning password sign-in
    // off, which logs people out) needs a recent step-up of the administrator's OWN session — password + current code
    // when enrolled. Checked against the actor's own organisation, before the target is read.
    await this.stepUp.assertRecentStepUp(
      { organisationId: actor.organisationId, workspaceId: actor.workspaceId ?? null, userId: actor.userId, sessionId: actor.sessionId },
      'organisation.auth_providers.update',
    );
    const ctx = { organisationId: targetOrganisationId, workspaceId: null, userId: actor.userId, role: '', inspectedBy: undefined };
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      if (!(await this.platformAdmin.isPlatformAdminTx(manager, actor))) {
        throw new ForbiddenException("Only a platform administrator can change an organisation's sign-in methods.");
      }
      const org = await manager.findOne(Organisation, { where: { id: targetOrganisationId } });
      if (!org) throw new NotFoundException('Organisation not found.');
      const current: OrganisationAuthProviderFlags = {
        passwordAuthEnabled: org.passwordAuthEnabled,
        googleAuthEnabled: org.googleAuthEnabled,
        microsoftAuthEnabled: org.microsoftAuthEnabled,
      };
      const next: OrganisationAuthProviderFlags = { ...current, ...patch };
      const effective = this.effectiveFrom(this.systemEnabled(), next);
      if (this.isLockedOut(effective)) {
        throw new BadRequestException(
          'This change would leave no way for anyone in this organisation to sign in. At least one authentication method must remain usable.',
        );
      }
      await manager.update(Organisation, targetOrganisationId, {
        passwordAuthEnabled: next.passwordAuthEnabled,
        googleAuthEnabled: next.googleAuthEnabled,
        microsoftAuthEnabled: next.microsoftAuthEnabled,
      });
      await this.securityVersion.bumpOrganisation(manager, targetOrganisationId);
      // Wave 1 lane A (D-A2) — owner decision "log them out": turning password sign-in OFF revokes the organisation's
      // live password sessions (SSO sessions untouched, mobile-workforce exemption kept) in THIS transaction, through the
      // existing revokeFamily/security-version path, and audits it. A failure rolls the setting change back too.
      const passwordSessionsRevoked =
        current.passwordAuthEnabled && !next.passwordAuthEnabled
          ? await this.passwordSessions.revokeForPasswordSignInDisabled(manager, ctx, targetOrganisationId)
          : 0;
      await this.auditService.record(manager, ctx, AuditAction.ORGANISATION_AUTH_PROVIDERS_UPDATED, {
        entityType: 'organisation',
        entityId: targetOrganisationId,
        metadata: { fields: Object.keys(patch), effective, passwordSessionsRevoked, via: 'platform_admin' },
      });
      return next;
    });
  }

  /**
   * Owner decision §4B — runs once after Nest's module graph (and therefore the DB connection) is
   * ready, before the process starts accepting traffic. A locked-out organisation found here is a
   * genuine, sanitised boot failure (no organisation id, no secrets) — never a silent warning,
   * since by the time a request arrives it's too late to protect that organisation's users.
   */
  async onApplicationBootstrap(): Promise<void> {
    const system = this.systemEnabled();
    // `core.organisation` carries the real `organisation_self` RLS policy (`id = current_org()`)
    // — a plain `rab_app` scan with no tenant context bound would see ZERO rows, exactly like
    // every other RLS-protected table (found live by this checkpoint's own integration test, not
    // assumed safe from the entity's own doc comment). The narrow SECURITY DEFINER function
    // below is the fix, same pattern as `core.worker_list_workspaces`.
    const rows = await this.dataSource.query<OrganisationAuthProviderFlags[]>('SELECT * FROM core.auth_list_organisation_providers()');
    const lockedOutCount = rows.filter((org) => this.isLockedOut(this.effectiveFrom(system, org))).length;
    if (lockedOutCount > 0) {
      throw new Error(
        `Startup refused: ${lockedOutCount} organisation(s) would have NO effective authentication method under the current AUTH_PASSWORD_ENABLED/AUTH_GOOGLE_ENABLED/AUTH_MICROSOFT_ENABLED configuration. Adjust the environment configuration or that organisation's own provider settings before restarting.`,
      );
    }
    this.logger.log(`auth provider lockout check: ${rows.length} organisation(s) checked, 0 locked out`);
  }
}
