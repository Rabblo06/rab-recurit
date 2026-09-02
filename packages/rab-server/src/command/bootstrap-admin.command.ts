import { checkPasswordStrength } from '@rab/shared';
import { Command, CommandRunner } from 'nest-commander';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';

interface UserCandidate {
  id: string;
  organisation_id: string;
  org_slug: string;
}

/**
 * Automatic, env-driven first-Platform-Admin bootstrap — invoked once on
 * every container boot (`start.sh`, after migrations, before `main.js`),
 * never on-demand. This is deliberately NOT an authentication path: the
 * env vars are read exactly once, at process start, to seed a completely
 * normal `core.user` row (real argon2id hash, no different from any other
 * account) and an equally normal `core.platform_admin` grant — there is no
 * runtime code anywhere that compares a login attempt against these env
 * vars. Once bootstrapped, `BOOTSTRAP_ADMIN_PASSWORD` can be removed from
 * Render entirely with zero effect on the resulting account.
 *
 * Reuses, rather than re-implements, the existing bootstrap security model:
 * `grant-platform-admin.command.ts`'s own doc comment states the first
 * grant can only ever happen by writing directly as `rab_owner` (this
 * table is deliberately NOT FORCEd for exactly that reason) — this command
 * runs the same way, via the same `DATABASE_URL_UNPOOLED`-as-`rab_owner`
 * convention `start.sh` already uses for migrations. The "existing user by
 * email, refuse on cross-org ambiguity" lookup below is the same shape as
 * `grant-platform-admin.command.ts`'s, not a second, competing algorithm.
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
 */
@Command({
  name: 'bootstrap-admin',
  description: 'One-time, env-driven bootstrap of the first Platform Admin on a fresh deploy (idempotent, safe to run every boot)',
})
export class BootstrapAdminCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly passwordHashing: PasswordHashingService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

    // Phase 8 — partial config is a real misconfiguration, not a valid
    // "skip" state: fail the boot loudly rather than silently do nothing
    // (or worse, half of something) with whichever one var is set.
    if (!email && !password) return; // neither configured — ordinary boot, nothing to do
    if (!email || !password) {
      console.error('Platform Admin bootstrap configuration is incomplete — both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required together.');
      process.exit(1);
      return; // unreachable in production (process.exit never returns) — guards a mocked exit in tests
    }

    const normalizedEmail = email.trim().toLowerCase();
    const firstName = (process.env.BOOTSTRAP_ADMIN_FIRST_NAME ?? 'Admin').trim();
    const lastName = (process.env.BOOTSTRAP_ADMIN_LAST_NAME ?? '').trim();

    const check = checkPasswordStrength(password, normalizedEmail);
    if (!check.valid) {
      console.error(`Platform Admin bootstrap refused: BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy (${check.reasons.join(' ')})`);
      process.exit(1);
      return; // unreachable in production (process.exit never returns) — guards a mocked exit in tests
    }

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
        console.log('Platform Admin already exists — bootstrap skipped');
        return;
      }

      const userId = await this.resolveOrCreateUser(manager, normalizedEmail, firstName, lastName, password);
      if (!userId) return; // ambiguous / refused — already logged below

      await manager.query(
        `INSERT INTO core.platform_admin (user_id, granted_by)
         VALUES ($1, NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET granted_at = now(), granted_by = NULL, revoked_at = NULL, revoked_by = NULL`,
        [userId],
      );

      const [userRow] = await manager.query<[{ organisation_id: string }]>(
        `SELECT organisation_id FROM core."user" WHERE id = $1`,
        [userId],
      );
      const organisationId = userRow!.organisation_id;

      // audit_log is FORCEd — bind just enough context on this same
      // manager/transaction for its WITH CHECK to pass, matching
      // TenantContextService's own set_config calls exactly, without
      // opening a second transaction to get them.
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, ['']);
      await manager.query(`SELECT set_config('rab.role', $1, true)`, ['']);

      // Same trade-off as grant-platform-admin.command.ts: audit_log's own
      // organisation_id is NOT NULL and this table predates the
      // platform-wide concept platform_admin itself is — the grant ACTION
      // is not org-scoped, only this row's storage location is.
      await this.auditService.record(
        manager,
        { organisationId, userId },
        AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED,
        { targetUserId: userId, actorUserId: null, metadata: { via: 'env_bootstrap' } },
      );

      console.log(`Platform Admin bootstrapped (user ${userId}).`);
    });
  }

  /**
   * Returns the user id to grant, or `null` if bootstrap should be
   * refused (already logged a reason). Existing-user lookup deliberately
   * mirrors `grant-platform-admin.command.ts`'s own semantics — email
   * alone doesn't uniquely identify a user (`(organisation_id, email)` is
   * the real uniqueness scope), so a match in more than one organisation
   * fails closed rather than guessing.
   */
  private async resolveOrCreateUser(
    manager: EntityManager,
    email: string,
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<string | null> {
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
      // Phase 9 — an existing account with this email: grant, don't
      // duplicate. The account's own real password is untouched;
      // BOOTSTRAP_ADMIN_PASSWORD is not applied to a pre-existing user.
      console.log(`Platform Admin bootstrap: granting existing user "${email}" (org "${candidates[0]!.org_slug}") rather than creating a new one.`);
      return candidates[0]!.id;
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

    const passwordHash = await this.passwordHashing.hash(password);
    const [user] = await manager.query<[{ id: string }]>(
      `INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status, must_reset_password)
       VALUES ($1, $2, $3, $4, $5, 'active', false)
       RETURNING id`,
      [organisationId, email, passwordHash, firstName, lastName],
    );
    return user!.id;
  }
}
