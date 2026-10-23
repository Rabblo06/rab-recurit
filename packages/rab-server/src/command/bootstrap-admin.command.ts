import { loadSystemRoleDefaultPermissions } from '../modules/identity/services/system-role-permissions';
import { ManagerType } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource, EntityManager } from 'typeorm';

import { revokeSessionsForPrivilegedGrant } from '../engine/core-modules/platform-admin/privileged-grant-session-reset';

import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../engine/core-modules/auth/services/account-lifecycle.service';
import { renderSuperAdminActivationEmail } from '../engine/core-modules/email/templates';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { OrganisationMember, Role, RolePermission, UserRole } from '../modules/identity/entities';
import { ManagerProfile } from '../modules/manager/entities/manager-profile.entity';
import { ROLE_DEFS } from '../modules/manager/services/manager.service';

/** `core.bootstrap_first_platform_admin` — see BootstrapFirstPlatformAdminFunction1786719620000. */
const BOOTSTRAP_FUNCTION = 'core.bootstrap_first_platform_admin(public.citext, text, text, public.citext, text)';

type BootstrapOutcome =
  | 'ALREADY_BOOTSTRAPPED'
  | 'CLOSED'
  | 'REFUSED_AMBIGUOUS_EMAIL'
  | 'REFUSED_AMBIGUOUS_ORGANISATION'
  | 'GRANTED_EXISTING'
  | 'CREATED_INVITED';

interface BootstrapResult {
  outcome: BootstrapOutcome;
  user_id: string | null;
  organisation_id: string | null;
  created_user: boolean;
  created_organisation: boolean;
}

/**
 * Foundation fix P2 (2026-10-22) — how this command is authorised and why it no longer needs a superuser.
 *
 * The one step that needs more than ordinary tenant-scoped authority (finding/creating the organisation and user and
 * inserting the FIRST `core.platform_admin` row — tables owned by the NOLOGIN `rab_secure_owner`) is the narrow SECURITY
 * DEFINER function `core.bootstrap_first_platform_admin` (migration 1786719620000). It holds this command's advisory lock,
 * is one-time (it returns ALREADY_BOOTSTRAPPED / CLOSED once any platform admin has ever existed, so it can never mint a
 * second or replacement administrator), and only `crewflow` may EXECUTE it — never `crewflow_app`, so no API/Worker
 * request path can reach it. Run the command with `DATABASE_URL` set to the `crewflow` identity (the same operator
 * identity as the other one-off commands); the bootstrap superuser also works but is not needed. Everything after the
 * grant — the operational CEO role, the activation invitation and the audit entry — runs as that same connection under
 * ordinary FORCE RLS, with the tenant context bound by `TenantContextService` (no RLS bypass, no new grant).
 * The "History" notes below describe the pre-split design this replaces.
 */

/**
 * History — P2.9A — automatic, env-driven first-Platform-Admin bootstrap, invoked once on every container
 * boot (`start.sh`, after migrations, before `main.js`), never on-demand. ONLY
 * `BOOTSTRAP_ADMIN_EMAIL` is read — there is deliberately no `BOOTSTRAP_ADMIN_PASSWORD` any more
 * (the owner's own non-negotiable rule for this checkpoint: "Do not configure an initial
 * administrator password in environment variables"). A brand-new admin account is created
 * `INVITED`, with no password at all, and goes through the EXACT SAME invitation-token/
 * `/auth/activate-account` path every Staff/Manager/Venue-Manager invite already uses
 * (`AccountLifecycleService.sendAccountInvite`, reused verbatim here — only the email subject
 * differs, via `renderSuperAdminActivationEmail`). No session is ever issued to this row until the
 * recipient completes that flow themselves; an `INVITED` user with no `password_hash` cannot log in
 * (`AuthService.login`'s own `ACTIVE || (INVITED && passwordHash !== null)` gate) — so there is no
 * window where a "pending administrator" has a usable session.
 *
 * Reuses, rather than re-implements, the existing bootstrap security model:
 * `grant-platform-admin.command.ts`'s own doc comment states the first
 * grant can only ever happen by writing directly as `rab_owner` (this
 * table is deliberately NOT FORCEd for exactly that reason) — this command
 * runs the same way, via the same `DATABASE_URL_UNPOOLED`-as-`rab_owner`
 * convention `start.sh` already uses for migrations. The "existing user by
 * email, refuse on cross-org ambiguity" lookup below is the same shape as
 * `grant-platform-admin.command.ts`'s, not a second, competing algorithm —
 * an email that already matches a real, already-activated account is
 * granted directly (no invite needed; that person can already log in).
 *
 * Idempotency/no-duplication (owner's rules: "no repeated creation after server restarts", "no
 * duplication when two API replicas start simultaneously") is the SAME mechanism as before,
 * unchanged: a transaction-scoped advisory lock held for the whole check-then-act block, keyed on
 * `core.platform_admin`'s row count. Once the first admin exists (pending activation or not), every
 * later boot — including a concurrent second replica blocked on the same lock — sees a non-zero
 * count and cleanly no-ops. This IS "permanently disable the initial bootstrap path after
 * completion" (owner's rule): there is no separate flag to maintain, because the condition this
 * command checks can never become false again once satisfied.
 *
 * Everything runs on ONE manager from a single `dataSource.transaction()`
 * — deliberately not `TenantContextService.runInTenantContext`, which
 * always opens its own separate transaction/connection. Nesting that
 * inside this one would mean the advisory lock below (held on THIS
 * transaction's connection) provides no protection at all for the actual
 * writes, and they could commit independently of this transaction's
 * outcome. `organisation`/`user`/`platform_admin` are all NOT FORCEd, so
 * `rab_owner` (the table owner) bypasses their RLS unconditionally with no
 * context needed; `audit_log` IS FORCEd, so its one insert gets an inline
 * `set_config` on this same manager instead, right before it's needed.
 * `AccountLifecycleService.sendAccountInvite` itself issues further raw
 * queries/inserts on this SAME manager — it takes no transaction of its own,
 * so it participates in this one exactly like every other raw query here.
 */
@Command({
  name: 'bootstrap-admin',
  description: 'One-time, env-driven bootstrap of the first Platform Admin on a fresh deploy (idempotent, safe to run every boot)',
})
export class BootstrapAdminCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    if (!email) return; // not configured — ordinary boot, nothing to do

    // Deprecated, deliberately ignored rather than treated as fatal — an operator who hasn't yet
    // removed it from an old deploy config shouldn't have their boot fail over it, but it must
    // never be read or applied (owner's rule).
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      console.warn('BOOTSTRAP_ADMIN_PASSWORD is set but no longer used — Super Admin bootstrap is email-only now (an activation link is emailed instead). Remove this variable.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const firstName = (process.env.BOOTSTRAP_ADMIN_FIRST_NAME ?? 'Admin').trim();
    const lastName = (process.env.BOOTSTRAP_ADMIN_LAST_NAME ?? '').trim();

    await this.dataSource.transaction(async (manager) => {
      await this.assertBootstrapAuthority(manager);

      // Lock, one-time check, resolution and the FIRST platform_admin row: one atomic call (see the function's
      // migration). It takes the same advisory lock this command always used, held until this transaction ends, so a
      // concurrent second boot waits here and then sees the committed admin.
      const [result] = await manager.query<BootstrapResult[]>(
        `SELECT outcome, user_id, organisation_id, created_user, created_organisation
           FROM core.bootstrap_first_platform_admin($1::public.citext, $2, $3, $4::public.citext, $5)`,
        [
          normalizedEmail,
          firstName,
          lastName,
          process.env.BOOTSTRAP_ADMIN_ORG_SLUG?.trim().toLowerCase() || null,
          process.env.BOOTSTRAP_ADMIN_ORG_NAME?.trim() || null,
        ],
      );
      if (!result) throw new Error('Platform Admin bootstrap: core.bootstrap_first_platform_admin returned no row. Nothing was changed.');

      switch (result.outcome) {
        case 'ALREADY_BOOTSTRAPPED': {
          // Gap-review finding (universal self-service onboarding checkpoint): the owner's own
          // requirement is "Super Admin = normal authorised workspace experience + Admin Panel" — an
          // admin that already exists (every boot after the first) still needs this checked, not just
          // a freshly-bootstrapped one. `ensureOperationalIdentity` is idempotent, so running it here
          // on every boot is safe and correctly self-heals an admin that predates this checkpoint.
          await this.bindContext(manager, result.organisation_id!, result.user_id!);
          await this.ensureOperationalIdentity(manager, result.organisation_id!, result.user_id!);
          console.log('Platform Admin already exists — bootstrap skipped');
          return;
        }
        case 'CLOSED':
          // Fail closed and loudly: the one-time bootstrap is spent. Restoring an administrator after every one has been
          // revoked is a deliberate DBA action (grant-platform-admin), never an env-driven boot side effect.
          throw new Error(
            'Platform Admin bootstrap is closed: platform administrators have existed on this database but none is active. ' +
              'Nothing was changed. Restoring one is a deliberate operator action (grant-platform-admin), not a bootstrap.',
          );
        case 'REFUSED_AMBIGUOUS_EMAIL':
          console.error(
            `Platform Admin bootstrap: "${normalizedEmail}" matches more than one existing user across different organisations — refusing to guess. ` +
              `Run "grant-platform-admin --email ${normalizedEmail} --org <slug>" manually instead.`,
          );
          return;
        case 'REFUSED_AMBIGUOUS_ORGANISATION':
          console.error(
            `Platform Admin bootstrap: several organisations exist and none has a user matching "${normalizedEmail}" — refusing to guess which one. ` +
              `Set BOOTSTRAP_ADMIN_ORG_SLUG explicitly, or run "grant-platform-admin --email <existing-user-email> --org <slug>" manually instead.`,
          );
          return;
        case 'GRANTED_EXISTING':
        case 'CREATED_INVITED':
          break;
        default:
          throw new Error(`Platform Admin bootstrap: unexpected outcome "${String(result.outcome)}". Nothing was committed.`);
      }

      const userId = result.user_id!;
      const organisationId = result.organisation_id!;
      const isNewUser = result.created_user;
      if (result.created_organisation) console.log('Platform Admin bootstrap: the bootstrap organisation did not exist — created it.');
      if (!isNewUser) console.log(`Platform Admin bootstrap: granting the existing user "${normalizedEmail}" rather than creating a new one.`);

      // Everything below is ordinary tenant-scoped work under FORCE RLS: bind the new admin's own organisation/user
      // with the same helper every tenant-context entry point uses, on THIS transaction (the advisory lock above must
      // cover these writes, so no second transaction is opened).
      await this.bindContext(manager, organisationId, userId);

      await this.ensureOperationalIdentity(manager, organisationId, userId);

      // CF-07: promoting an EXISTING account ends every session it already holds (same transaction), so no
      // pre-promotion session carries platform-admin authority. A brand-new user has none.
      if (!isNewUser) await revokeSessionsForPrivilegedGrant(manager, userId);

      if (isNewUser) {
        // Same invitation-token/email path Staff/Manager/Venue-Manager invites already use —
        // never a second activation mechanism. `actorUserId: null`: there is no authenticated human
        // actor at bootstrap time.
        const ctx: AuthContext = { organisationId, workspaceId: null, userId, role: '' };
        await this.accountLifecycle.sendAccountInvite(
          manager,
          ctx,
          { userId, email: normalizedEmail, createdBy: null },
          { templateRenderer: renderSuperAdminActivationEmail, actorUserId: null },
        );
      }

      // Same trade-off as grant-platform-admin.command.ts: audit_log's own
      // organisation_id is NOT NULL and this table predates the
      // platform-wide concept platform_admin itself is — the grant ACTION
      // is not org-scoped, only this row's storage location is.
      await this.auditService.record(manager, { organisationId, userId }, AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED, {
        targetUserId: userId,
        actorUserId: null,
        metadata: { via: 'env_bootstrap', pendingActivation: isNewUser, createdOrganisation: result.created_organisation },
      });

      console.log(
        isNewUser
          ? `Platform Admin bootstrapped (user ${userId}) — pending activation, activation email queued.`
          : `Platform Admin bootstrapped (user ${userId}).`,
      );
    });
  }

  /**
   * Explicit authorisation, checked before anything is written: the connection must be allowed to EXECUTE the bootstrap
   * function (only `crewflow` — and a superuser — are). The runtime identity `crewflow_app` is refused here with an
   * actionable message instead of a bare permission error, and the database refuses it again regardless.
   */
  private async assertBootstrapAuthority(manager: EntityManager): Promise<void> {
    const [row] = await manager.query<Array<{ who: string; allowed: boolean | null }>>(
      `SELECT current_user AS who,
              CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE has_function_privilege(to_regprocedure($1), 'EXECUTE') END AS allowed`,
      [BOOTSTRAP_FUNCTION],
    );
    if (!row || row.allowed === null) {
      throw new Error('Platform Admin bootstrap: core.bootstrap_first_platform_admin does not exist — apply pending migrations first. Nothing was changed.');
    }
    if (!row.allowed) {
      throw new Error(
        `Platform Admin bootstrap refused: the connected role "${row.who}" may not run the bootstrap. ` +
          'Run bootstrap-admin with DATABASE_URL set to the crewflow operator identity, never the crewflow_app runtime identity. Nothing was changed.',
      );
    }
  }

  private async bindContext(manager: EntityManager, organisationId: string, userId: string): Promise<void> {
    await this.tenantContext.bindCoreIdentityGucs(manager, { organisationId, workspaceId: null, userId, role: '' });
  }

  /**
   * Universal-self-service-onboarding checkpoint (docs/HANDOFF.md) — the owner's own explicit
   * requirement: "Super Admin = normal authorised Crewflow workspace experience + extra Admin
   * Panel in Settings," not a platform-only console. `platform_admin` itself stays exactly as
   * narrow and separate as it already was (`core.platform_admin`, no FK to `user_role`/`role`) —
   * this grants a completely independent, ordinary CEO-shaped operational role in the SAME
   * bootstrap organisation the admin's own `User` row already lives in (never a different/new org
   * — that would mean guessing which tenant "owns" the admin's workspace, exactly what this
   * command already refuses to do elsewhere). Reuses `ManagerService.ROLE_DEFS`/the identical
   * role/permission-seeding shape `ManagerService.ensureRole()`/`createWithin()` already use for an
   * ordinary CEO — never a second, competing role-creation path. `ManagerService` itself is NOT
   * injected here (this command's module graph is deliberately smaller than `AppModule` — see this
   * file's own header comment — and `ManagerService` pulls in a long dependency chain this CLI
   * command has no other reason to need); only the plain, dependency-free `ROLE_DEFS` constant and
   * the TypeORM entities are imported.
   *
   * Idempotent — a no-op once the user already has any `ManagerProfile` — so this is safe to call
   * unconditionally on every boot, including for an admin that was bootstrapped before this
   * checkpoint existed (self-healing, not just for brand-new admins).
   */
  private async ensureOperationalIdentity(manager: EntityManager, organisationId: string, userId: string): Promise<void> {
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
    console.log(`Platform Admin bootstrap: granted operational CEO-shaped role to user ${userId} (org ${organisationId}).`);
  }
}
