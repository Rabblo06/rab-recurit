import { Injectable } from '@nestjs/common';
import { ManagerType } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../../../../engine/core-modules/auth/services/account-lifecycle.service';
import { renderSuperAdminActivationEmail } from '../../../../engine/core-modules/email/templates';
import { revokeSessionsForPrivilegedGrant } from '../../../../engine/core-modules/platform-admin/privileged-grant-session-reset';
import { AuthContext } from '../../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../../engine/core-modules/tenant/tenant-context.service';
import { ManagerProfile } from '../../../manager/entities/manager-profile.entity';
import { ROLE_DEFS } from '../../../manager/services/manager.service';
import { OrganisationMember, Role, RolePermission, UserRole } from '../../entities';
import { loadSystemRoleDefaultPermissions } from '../../services/system-role-permissions';

/** `core.bootstrap_first_platform_admin` — see BootstrapFirstPlatformAdminFunction1786719620000. */
export const BOOTSTRAP_FUNCTION = 'core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text)';

type BootstrapOutcome =
  | 'ALREADY_BOOTSTRAPPED'
  | 'CLOSED'
  | 'REFUSED_AMBIGUOUS_EMAIL'
  | 'REFUSED_AMBIGUOUS_ORGANISATION'
  | 'GRANTED_EXISTING'
  | 'CREATED_INVITED';

interface BootstrapRow {
  outcome: BootstrapOutcome;
  user_id: string | null;
  organisation_id: string | null;
  created_user: boolean;
  created_organisation: boolean;
}

/**
 * The bootstrap inputs, read from the environment by ONE function for both callers (the `bootstrap-admin` CLI command and
 * the API's boot-time bootstrap). There is deliberately no password field: the first administrator is created INVITED with
 * no password and activates through the emailed, expiring link (P2.9A).
 */
export interface PlatformAdminBootstrapInput {
  /** Trimmed and lower-cased. The database function validates the shape again (22023 on anything malformed). */
  email: string;
  firstName: string;
  lastName: string;
  orgSlug: string | null;
  orgName: string | null;
}

/** The input from BOOTSTRAP_ADMIN_EMAIL (+ the optional name / organisation variables), or null when the email is unset. */
export function readPlatformAdminBootstrapInput(env: Record<string, string | undefined>): PlatformAdminBootstrapInput | null {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return null; // not configured: nothing to do
  return {
    email: email.trim().toLowerCase(),
    firstName: (env.BOOTSTRAP_ADMIN_FIRST_NAME ?? 'Admin').trim(),
    lastName: (env.BOOTSTRAP_ADMIN_LAST_NAME ?? '').trim(),
    orgSlug: env.BOOTSTRAP_ADMIN_ORG_SLUG?.trim().toLowerCase() || null,
    orgName: env.BOOTSTRAP_ADMIN_ORG_NAME?.trim() || null,
  };
}

/** Progress inside the transaction, so each caller can word it its own way (the CLI keeps its historical lines). */
export type PlatformAdminBootstrapEvent =
  | { kind: 'organisation-created' }
  | { kind: 'granting-existing-user' }
  | { kind: 'operational-role-granted'; userId: string; organisationId: string };

export type PlatformAdminBootstrapResult =
  /**
   * An active platform admin already exists. Nothing was created; no email was queued. `activation` is reported only with
   * `inspectExistingAdminActivation`: 'expired' = the admin is still invited and holds no unexpired, unused invite.
   */
  | { outcome: 'ALREADY_BOOTSTRAPPED'; userId: string; organisationId: string; activation?: 'done' | 'pending' | 'expired' }
  /** Platform admins have existed and none is active: the one-time bootstrap is spent. Nothing was changed. */
  | { outcome: 'CLOSED' }
  | { outcome: 'REFUSED_AMBIGUOUS_EMAIL' }
  | { outcome: 'REFUSED_AMBIGUOUS_ORGANISATION' }
  /**
   * `requireProvenExistingAccount` only: the email matches one existing account that is not ACTIVE with a verified email
   * (e.g. a pending invitation whose address was never proven). Rolled back: nothing was written, no email queued.
   */
  | { outcome: 'REFUSED_EXISTING_ACCOUNT_UNVERIFIED' }
  /** `requireProvenExistingAccount` only: the matching account has no manager-tier profile (e.g. staff only). Rolled back. */
  | { outcome: 'REFUSED_EXISTING_ACCOUNT_NOT_MANAGER' }
  /** An existing account was granted (no invite: it can already sign in); its existing sessions were ended. */
  | { outcome: 'GRANTED_EXISTING'; userId: string; organisationId: string; createdOrganisation: boolean }
  /** A new INVITED account (no password) was created and ONE activation email was queued to the input email. */
  | { outcome: 'CREATED_INVITED'; userId: string; organisationId: string; createdOrganisation: boolean; activationExpiresAt: Date };

export type PlatformAdminBootstrapErrorReason = 'FUNCTION_MISSING' | 'NOT_AUTHORISED' | 'NO_RESULT' | 'UNEXPECTED_OUTCOME';

/** A refusal raised by this service itself (never a database error). `message` is the CLI's historical wording. */
export class PlatformAdminBootstrapError extends Error {
  constructor(
    readonly reason: PlatformAdminBootstrapErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAdminBootstrapError';
  }
}

export interface PlatformAdminBootstrapOptions {
  /**
   * Who is running it. Recorded in the audit entry only for the API boot (`trigger: 'api_boot'`); the CLI's audit metadata
   * stays exactly what it always was.
   */
  trigger: 'command' | 'api_boot';
  /**
   * ALREADY_BOOTSTRAPPED: also make sure the existing admin has its operational CEO-shaped identity (idempotent self-heal).
   * The CLI does this (unchanged behaviour); the API boot does NOT — once an admin exists the boot path writes nothing.
   */
  selfHealExistingAdmin: boolean;
  /**
   * GRANTED_EXISTING (security review of #264, F2/F3): grant an existing account only when it is ACTIVE, its email was
   * verified (`email_verified_at` set at activation) and it has a manager-tier profile; otherwise roll the whole
   * transaction back and report a REFUSED_EXISTING_ACCOUNT_* outcome. The API boot sets it; the CLI does not (unchanged).
   */
  requireProvenExistingAccount?: boolean;
  /** ALREADY_BOOTSTRAPPED: also report whether the existing admin's activation is done, pending or expired (read only). */
  inspectExistingAdminActivation?: boolean;
  onEvent?: (event: PlatformAdminBootstrapEvent) => void;
}

/**
 * The ONE implementation of the first-Platform-Admin bootstrap, shared verbatim by the `bootstrap-admin` CLI command and by
 * the API's boot-time bootstrap (PlatformAdminBootstrapOnBoot). Moved here unchanged from bootstrap-admin.command.ts; see
 * that file's header for the full history and BootstrapFirstPlatformAdminFunction1786719620000 for the database function.
 *
 * Guarantees (all come from the database function and this single transaction, not from the caller):
 *   - ONE-TIME: the function returns ALREADY_BOOTSTRAPPED once an active platform admin exists and CLOSED once any has ever
 *     existed, so this can never mint a second or a replacement administrator.
 *   - MULTI-REPLICA SAFE: the function takes `pg_advisory_xact_lock(hashtext('rab_bootstrap_platform_admin'))` on THIS
 *     transaction, held until it commits or rolls back. A concurrent caller (a second replica, a CLI run) blocks there and
 *     then reads the committed admin (READ COMMITTED: the function's next statement takes a fresh snapshot), so it answers
 *     ALREADY_BOOTSTRAPPED. Everything after the grant — the operational role, the invite, the email outbox row and the
 *     audit entry — is written on the SAME transaction, so they commit or roll back together with the admin.
 *   - ONE EMAIL, ONLY TO THE INPUT ADDRESS: the activation email is a `core.email_outbox` row written in this transaction
 *     (AccountLifecycleService.sendAccountInvite, recipient = input.email), published to the queue only after commit. A
 *     rolled-back attempt leaves no row, so nothing is ever sent for it; a loser of the lock writes none.
 *   - NO PASSWORD: a new account is INVITED with `password_hash` NULL and cannot sign in until the expiring link is used.
 *
 * Authorisation (layer 2, in the service, before anything is written): the connection must be allowed to EXECUTE the
 * function. In the owner-login architecture that is `crewflow_owner` (an INHERIT member of `crewflow`, which holds the only
 * EXECUTE grant); the schema role `crewflow_app` is refused here and again by the database.
 */
@Injectable()
export class PlatformAdminBootstrapService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async run(input: PlatformAdminBootstrapInput, options: PlatformAdminBootstrapOptions): Promise<PlatformAdminBootstrapResult> {
    const emit = options.onEvent ?? (() => undefined);

    try {
      return await this.runTransaction(input, options, emit);
    } catch (error) {
      if (error instanceof ExistingAccountRefusal) return { outcome: error.outcome };
      throw error;
    }
  }

  private async runTransaction(
    input: PlatformAdminBootstrapInput,
    options: PlatformAdminBootstrapOptions,
    emit: (event: PlatformAdminBootstrapEvent) => void,
  ): Promise<PlatformAdminBootstrapResult> {
    return this.dataSource.transaction(async (manager): Promise<PlatformAdminBootstrapResult> => {
      await this.assertBootstrapAuthority(manager);

      // Lock, one-time check, resolution and the FIRST platform_admin row: one atomic call (see the function's migration).
      // It takes the advisory lock, held until this transaction ends, so a concurrent second boot waits here and then sees
      // the committed admin.
      const [result] = await manager.query<BootstrapRow[]>(
        `SELECT outcome, user_id, organisation_id, created_user, created_organisation
           FROM core.bootstrap_first_platform_admin($1::public.citext, $2, $3, $4::public.citext, $5)`,
        [input.email, input.firstName, input.lastName, input.orgSlug, input.orgName],
      );
      if (!result) {
        throw new PlatformAdminBootstrapError('NO_RESULT', 'Platform Admin bootstrap: core.bootstrap_first_platform_admin returned no row. Nothing was changed.');
      }

      switch (result.outcome) {
        case 'ALREADY_BOOTSTRAPPED': {
          if (options.selfHealExistingAdmin) {
            // Gap-review finding (universal self-service onboarding checkpoint): "Super Admin = normal authorised workspace
            // experience + Admin Panel" — an admin that already exists still needs this checked. Idempotent.
            await this.bindContext(manager, result.organisation_id!, result.user_id!);
            await this.ensureOperationalIdentity(manager, result.organisation_id!, result.user_id!, emit);
          }
          if (options.inspectExistingAdminActivation) {
            await this.bindContext(manager, result.organisation_id!, result.user_id!);
            const activation = await this.existingAdminActivation(manager, result.user_id!);
            return { outcome: 'ALREADY_BOOTSTRAPPED', userId: result.user_id!, organisationId: result.organisation_id!, activation };
          }
          return { outcome: 'ALREADY_BOOTSTRAPPED', userId: result.user_id!, organisationId: result.organisation_id! };
        }
        case 'CLOSED':
        case 'REFUSED_AMBIGUOUS_EMAIL':
        case 'REFUSED_AMBIGUOUS_ORGANISATION':
          // The function changed nothing for any of these; the caller reports (the CLI fails loudly on CLOSED).
          return { outcome: result.outcome };
        case 'GRANTED_EXISTING':
        case 'CREATED_INVITED':
          break;
        default:
          throw new PlatformAdminBootstrapError('UNEXPECTED_OUTCOME', `Platform Admin bootstrap: unexpected outcome "${String(result.outcome)}". Nothing was committed.`);
      }

      const userId = result.user_id!;
      const organisationId = result.organisation_id!;
      const isNewUser = result.created_user;
      if (result.created_organisation) emit({ kind: 'organisation-created' });
      if (!isNewUser) emit({ kind: 'granting-existing-user' });

      // Everything below is ordinary tenant-scoped work under FORCE RLS: bind the new admin's own organisation/user with
      // the same helper every tenant-context entry point uses, on THIS transaction (the advisory lock above must cover
      // these writes, so no second transaction is opened).
      await this.bindContext(manager, organisationId, userId);

      // F2/F3 (API boot): never hand platform-wide authority to an account whose email ownership was never proven, or to a
      // staff-only account. Thrown to ROLL BACK this transaction (the function's platform_admin row included); run() turns
      // it into the outcome. Checked here, in the same transaction and under the function's advisory lock, on the row the
      // function itself resolved (locked FOR UPDATE), so nothing can change it between the check and the grant.
      if (!isNewUser && options.requireProvenExistingAccount) await this.assertProvenExistingAccount(manager, userId);

      await this.ensureOperationalIdentity(manager, organisationId, userId, emit);

      // CF-07: promoting an EXISTING account ends every session it already holds (same transaction), so no pre-promotion
      // session carries platform-admin authority. A brand-new user has none.
      if (!isNewUser) await revokeSessionsForPrivilegedGrant(manager, userId);

      let activationExpiresAt: Date | null = null;
      if (isNewUser) {
        // Same invitation-token/email path Staff/Manager/Venue-Manager invites already use — never a second activation
        // mechanism, so the token TTL is the ordinary account-invite TTL. `actorUserId: null`: there is no authenticated
        // human actor at bootstrap time. The recipient is the bootstrap input's email and nothing else.
        const ctx: AuthContext = { organisationId, workspaceId: null, userId, role: '' };
        const invite = await this.accountLifecycle.sendAccountInvite(
          manager,
          ctx,
          { userId, email: input.email, createdBy: null },
          { templateRenderer: renderSuperAdminActivationEmail, actorUserId: null },
        );
        activationExpiresAt = invite.expiresAt;
      }

      // Same trade-off as grant-platform-admin.command.ts: audit_log's own organisation_id is NOT NULL and this table
      // predates the platform-wide concept platform_admin itself is — the grant ACTION is not org-scoped, only this row's
      // storage location is.
      await this.auditService.record(manager, { organisationId, userId }, AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED, {
        targetUserId: userId,
        actorUserId: null,
        metadata: {
          via: 'env_bootstrap',
          pendingActivation: isNewUser,
          createdOrganisation: result.created_organisation,
          ...(options.trigger === 'api_boot' ? { trigger: 'api_boot' } : {}),
        },
      });

      return isNewUser
        ? { outcome: 'CREATED_INVITED', userId, organisationId, createdOrganisation: result.created_organisation, activationExpiresAt: activationExpiresAt! }
        : { outcome: 'GRANTED_EXISTING', userId, organisationId, createdOrganisation: result.created_organisation };
    });
  }

  /**
   * Explicit authorisation, checked before anything is written: the connection must be allowed to EXECUTE the bootstrap
   * function (only `crewflow` and its INHERIT members — `crewflow_owner` — and a superuser are). The schema role
   * `crewflow_app` is refused here with an actionable message instead of a bare permission error, and the database refuses
   * it again regardless.
   */
  private async assertBootstrapAuthority(manager: EntityManager): Promise<void> {
    const [row] = await manager.query<Array<{ who: string; allowed: boolean | null }>>(
      `SELECT current_user AS who,
              CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE has_function_privilege(to_regprocedure($1), 'EXECUTE') END AS allowed`,
      [BOOTSTRAP_FUNCTION],
    );
    if (!row || row.allowed === null) {
      throw new PlatformAdminBootstrapError(
        'FUNCTION_MISSING',
        'Platform Admin bootstrap: core.bootstrap_first_platform_admin does not exist — apply pending migrations first. Nothing was changed.',
      );
    }
    if (!row.allowed) {
      throw new PlatformAdminBootstrapError(
        'NOT_AUTHORISED',
        `Platform Admin bootstrap refused: the connected role "${row.who}" may not run the bootstrap. ` +
          'Run bootstrap-admin with PG_DATABASE_URL set to the crewflow operator identity, never the crewflow_app runtime identity. Nothing was changed.',
      );
    }
  }

  private async assertProvenExistingAccount(manager: EntityManager, userId: string): Promise<void> {
    const [row] = await manager.query<Array<{ status: string; verified: boolean; manager_tier: boolean }>>(
      `SELECT u.status, u.email_verified_at IS NOT NULL AS verified,
              EXISTS (SELECT 1 FROM core.manager_profile mp WHERE mp.user_id = u.id) AS manager_tier
         FROM core."user" u
        WHERE u.id = $1 AND u.deleted_at IS NULL
        FOR UPDATE OF u`,
      [userId],
    );
    // Fail closed: an account this transaction cannot see is treated as unproven.
    if (!row || row.status !== 'active' || row.verified !== true) throw new ExistingAccountRefusal('REFUSED_EXISTING_ACCOUNT_UNVERIFIED');
    if (row.manager_tier !== true) throw new ExistingAccountRefusal('REFUSED_EXISTING_ACCOUNT_NOT_MANAGER');
  }

  /** Read only: is the existing admin still waiting for activation, and does it still hold a usable (unexpired) invite? */
  private async existingAdminActivation(manager: EntityManager, userId: string): Promise<'done' | 'pending' | 'expired'> {
    const [row] = await manager.query<Array<{ status: string; live_invite: boolean }>>(
      `SELECT u.status,
              EXISTS (SELECT 1 FROM core.account_invite i
                       WHERE i.user_id = u.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS live_invite
         FROM core."user" u
        WHERE u.id = $1`,
      [userId],
    );
    if (!row || (row.status !== 'invited' && row.status !== 'invite_expired')) return 'done';
    return row.live_invite ? 'pending' : 'expired';
  }

  private async bindContext(manager: EntityManager, organisationId: string, userId: string): Promise<void> {
    await this.tenantContext.bindCoreIdentityGucs(manager, { organisationId, workspaceId: null, userId, role: '' });
  }

  /**
   * Universal-self-service-onboarding checkpoint — the owner's own explicit requirement: "Super Admin = normal authorised
   * Crewflow workspace experience + extra Admin Panel in Settings," not a platform-only console. `platform_admin` itself stays
   * exactly as narrow and separate as it already was (`core.platform_admin`, no FK to `user_role`/`role`) — this grants a
   * completely independent, ordinary CEO-shaped operational role in the SAME bootstrap organisation the admin's own `User`
   * row already lives in. Reuses `ManagerService.ROLE_DEFS`/the identical role/permission-seeding shape
   * `ManagerService.ensureRole()`/`createWithin()` already use for an ordinary CEO — never a second, competing
   * role-creation path. `ManagerService` itself is NOT injected (the CLI's module graph is deliberately smaller than
   * `AppModule`, and `ManagerService` pulls in a long dependency chain); only the plain, dependency-free `ROLE_DEFS`
   * constant and the TypeORM entities are imported.
   *
   * Idempotent — a no-op once the user already has any `ManagerProfile`.
   */
  private async ensureOperationalIdentity(
    manager: EntityManager,
    organisationId: string,
    userId: string,
    emit: (event: PlatformAdminBootstrapEvent) => void,
  ): Promise<void> {
    const existingProfile = await manager.findOne(ManagerProfile, { where: { userId } });
    if (existingProfile) return;

    const def = ROLE_DEFS[ManagerType.CEO]!;
    let role = await manager.findOne(Role, { where: { organisationId, key: def.key } });
    if (!role) {
      const result = await manager.insert(Role, { organisationId, key: def.key, name: def.name, isSystem: true });
      role = await manager.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
      // Fail closed: an incomplete catalogue must stop the bootstrap, not mint a CEO role missing most of its access.
      const permissions = await loadSystemRoleDefaultPermissions(manager, def.key, def.permissions);
      if (permissions.length > 0) {
        await manager.insert(RolePermission, permissions.map((permission) => ({ roleId: role!.id, permissionId: permission.id, organisationId })));
      }
    }

    await manager.insert(UserRole, { userId, roleId: role.id, organisationId });
    await manager.insert(OrganisationMember, { organisationId, userId });
    await manager.insert(ManagerProfile, { organisationId, userId, type: ManagerType.CEO });
    emit({ kind: 'operational-role-granted', userId, organisationId });
  }
}

/** Thrown inside the transaction to roll it back; never escapes PlatformAdminBootstrapService.run. */
class ExistingAccountRefusal extends Error {
  constructor(readonly outcome: 'REFUSED_EXISTING_ACCOUNT_UNVERIFIED' | 'REFUSED_EXISTING_ACCOUNT_NOT_MANAGER') {
    super(outcome);
    this.name = 'ExistingAccountRefusal';
  }
}
