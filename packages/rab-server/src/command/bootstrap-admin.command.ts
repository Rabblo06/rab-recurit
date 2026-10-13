import { ManagerType } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../engine/core-modules/auth/services/account-lifecycle.service';
import { renderSuperAdminActivationEmail } from '../engine/core-modules/email/templates';
import { AuthContext } from '../engine/core-modules/tenant/auth-context.interface';
import { OrganisationMember, Permission, Role, RolePermission, UserRole } from '../modules/identity/entities';
import { ManagerProfile } from '../modules/manager/entities/manager-profile.entity';
import { ROLE_DEFS } from '../modules/manager/services/manager.service';

interface UserCandidate {
  id: string;
  organisation_id: string;
  org_slug: string;
}

/**
 * P2.9A — automatic, env-driven first-Platform-Admin bootstrap, invoked once on every container
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
      // Phase 7 — a transaction-scoped advisory lock, held for the whole
      // check-then-act block. A concurrent second boot blocks here until
      // the first commits (releasing the lock), then re-reads the
      // now-nonzero admin count below and cleanly no-ops — no reliance on
      // "check count, then insert" being atomic on its own.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('rab_bootstrap_platform_admin'))`);

      const [{ count }] = await manager.query<[{ count: string }]>(
        `SELECT count(*)::int AS count FROM core.platform_admin WHERE revoked_at IS NULL`,
      );
      if (Number(count) > 0) {
        // Gap-review finding (universal self-service onboarding checkpoint): the owner's own
        // requirement is "Super Admin = normal authorised workspace experience + Admin Panel" — an
        // admin that already exists (every boot after the first) still needs this checked, not just
        // a freshly-bootstrapped one. `ensureOperationalIdentity` is idempotent, so running it here
        // on every boot is safe and correctly self-heals an admin that predates this checkpoint.
        const [existing] = await manager.query<[{ user_id: string; organisation_id: string } | undefined]>(
          `SELECT pa.user_id, u.organisation_id FROM core.platform_admin pa
             JOIN core."user" u ON u.id = pa.user_id
            WHERE pa.revoked_at IS NULL LIMIT 1`,
        );
        if (existing) await this.ensureOperationalIdentity(manager, existing.organisation_id, existing.user_id);
        console.log('Platform Admin already exists — bootstrap skipped');
        return;
      }

      const resolved = await this.resolveOrCreateUser(manager, normalizedEmail, firstName, lastName);
      if (!resolved) return; // ambiguous / refused — already logged below
      const { userId, organisationId, isNewUser } = resolved;

      await manager.query(
        `INSERT INTO core.platform_admin (user_id, granted_by)
         VALUES ($1, NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET granted_at = now(), granted_by = NULL, revoked_at = NULL, revoked_by = NULL,
               security_version = core.platform_admin.security_version + 1`,
        [userId],
      );

      // audit_log is FORCEd — bind just enough context on this same manager/transaction for its
      // WITH CHECK to pass, matching TenantContextService's own set_config calls exactly, without
      // opening a second transaction to get them. Set BEFORE sendAccountInvite below, which writes
      // its own FORCEd audit_log row (INVITE_EMAIL_QUEUED) for a brand-new pending admin.
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, ['']);
      await manager.query(`SELECT set_config('rab.role', $1, true)`, ['']);

      await this.ensureOperationalIdentity(manager, organisationId, userId);

      if (isNewUser) {
        // Same invitation-token/email path Staff/Manager/Venue-Manager invites already use —
        // never a second activation mechanism. `actorUserId: null` matches this command's own
        // existing convention for the bootstrap audit entry below: there is no authenticated human
        // actor at process-start time.
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
      await this.auditService.record(
        manager,
        { organisationId, userId },
        AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED,
        { targetUserId: userId, actorUserId: null, metadata: { via: 'env_bootstrap', pendingActivation: isNewUser } },
      );

      console.log(
        isNewUser
          ? `Platform Admin bootstrapped (user ${userId}) — pending activation, activation email queued.`
          : `Platform Admin bootstrapped (user ${userId}).`,
      );
    });
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
      const permissions = await manager.createQueryBuilder(Permission, 'p').where('p.key IN (:...keys)', { keys: def.permissions }).getMany();
      if (permissions.length > 0) {
        await manager.insert(RolePermission, permissions.map((permission) => ({ roleId: role!.id, permissionId: permission.id, organisationId })));
      }
    }

    await manager.insert(UserRole, { userId, roleId: role.id, organisationId });
    await manager.insert(OrganisationMember, { organisationId, userId });
    await manager.insert(ManagerProfile, { organisationId, userId, type: ManagerType.CEO });
    console.log(`Platform Admin bootstrap: granted operational CEO-shaped role to user ${userId} (org ${organisationId}).`);
  }

  /**
   * Returns the user to grant (and whether it was just created), or `null` if bootstrap should be
   * refused (already logged a reason). Existing-user lookup deliberately mirrors
   * `grant-platform-admin.command.ts`'s own semantics — email alone doesn't uniquely identify a
   * user (`(organisation_id, email)` is the real uniqueness scope), so a match in more than one
   * organisation fails closed rather than guessing.
   */
  private async resolveOrCreateUser(
    manager: EntityManager,
    email: string,
    firstName: string,
    lastName: string,
  ): Promise<{ userId: string; organisationId: string; isNewUser: boolean } | null> {
    const candidates = await manager.query<UserCandidate[]>(
      `SELECT u.id, u.organisation_id, o.slug AS org_slug
         FROM core."user" u
         JOIN core.organisation o ON o.id = u.organisation_id
        WHERE u.email = $1 AND u.deleted_at IS NULL`,
      [email],
    );

    if (candidates.length > 1) {
      console.error(
        `Platform Admin bootstrap: "${email}" matches ${candidates.length} existing users across different organisations — refusing to guess. ` +
          `Run "grant-platform-admin --email ${email} --org <slug>" manually instead.`,
      );
      return null;
    }

    if (candidates.length === 1) {
      // Phase 9 — an existing, already-activated account with this email: grant, don't duplicate.
      // Already has a real password and can already log in, so no invitation is sent.
      console.log(`Platform Admin bootstrap: granting existing user "${email}" (org "${candidates[0]!.org_slug}") rather than creating a new one.`);
      return { userId: candidates[0]!.id, organisationId: candidates[0]!.organisation_id, isNewUser: false };
    }

    // No existing user anywhere — genuinely fresh-DB path. Only proceed if
    // there's an unambiguous organisation to create the account in;
    // otherwise this would be guessing which of several tenants "owns"
    // the new platform admin, which nothing in this command is positioned
    // to decide safely.
    const explicitSlug = process.env.BOOTSTRAP_ADMIN_ORG_SLUG?.trim().toLowerCase();
    let organisationId: string;
    if (explicitSlug) {
      // An operator who names a specific org has already disambiguated —
      // look it up (or create it) by that exact slug, independent of how
      // many other organisations happen to exist. Without this, the
      // "how many total organisations exist" heuristic below would refuse
      // on any real, already-used deployment (or any populated local dev
      // database) even when the operator was perfectly explicit about
      // which one they meant.
      const [existing] = await manager.query<[{ id: string } | undefined]>(`SELECT id FROM core.organisation WHERE slug = $1`, [explicitSlug]);
      if (existing) {
        organisationId = existing.id;
      } else {
        const name = (process.env.BOOTSTRAP_ADMIN_ORG_NAME ?? 'Platform').trim();
        const [org] = await manager.query<[{ id: string }]>(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, [name, explicitSlug]);
        organisationId = org!.id;
        console.log(`Platform Admin bootstrap: no organisation "${explicitSlug}" existed — created it.`);
      }
    } else {
      const orgs = await manager.query<Array<{ id: string }>>(`SELECT id FROM core.organisation`);
      if (orgs.length === 0) {
        const [org] = await manager.query<[{ id: string }]>(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, ['Platform', 'platform']);
        organisationId = org!.id;
        console.log('Platform Admin bootstrap: no organisation existed — created "platform".');
      } else if (orgs.length === 1) {
        organisationId = orgs[0]!.id;
      } else {
        console.error(
          `Platform Admin bootstrap: ${orgs.length} organisations exist and none has a user matching "${email}" — refusing to guess which one. ` +
            `Set BOOTSTRAP_ADMIN_ORG_SLUG explicitly, or run "grant-platform-admin --email <existing-user-email> --org <slug>" manually instead.`,
        );
        return null;
      }
    }

    // P2.9A — INVITED, no password at all (never 'active', never a hashed env-var password): this
    // row cannot authenticate until the recipient completes /auth/activate-account themselves.
    // must_reset_password is irrelevant with no password yet set; left at its column default.
    const [user] = await manager.query<[{ id: string }]>(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status)
       VALUES ($1, $2, $3, $4, 'invited')
       RETURNING id`,
      [organisationId, email, firstName, lastName],
    );
    return { userId: user!.id, organisationId, isNewUser: true };
  }
}
