import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';

interface GrantPlatformAdminOptions {
  email?: string;
  org?: string;
}

/**
 * Stage 2A Phase 2 — the ONLY way to create the first-ever `platform_admin`
 * row (and the recovery path if every existing admin is ever revoked).
 * Never runs automatically at server startup, never reads an env-var grant
 * list — a human operator invokes this deliberately, out of band.
 *
 * Connects as `rab_owner` (same convention as `seed`/`ping` — invoked with
 * `DATABASE_URL` pointed at the owner role), which is what lets it write
 * `core.platform_admin` at all: that table's own `platform_admin_write`/
 * `_update` RLS policies require the ACTING session to already be an active
 * admin — an impossible bootstrap requirement for the very first grant, by
 * design. `rab_owner` bypasses that entirely (the table is deliberately
 * NOT FORCEd, same pre-auth-exemption class as `organisation`).
 *
 * `email` alone doesn't uniquely identify a user — `core.user`'s own
 * uniqueness is `(organisation_id, email)`, not email alone, so the same
 * address can legitimately exist in more than one organisation. An
 * ambiguous match fails closed (never guesses) and asks for `--org` to
 * disambiguate, rather than silently picking one.
 */
@Command({
  name: 'grant-platform-admin',
  description: 'Bootstrap or recover the first (or any) global platform administrator',
})
export class GrantPlatformAdminCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  @Option({ flags: '-e, --email <email>', description: 'Email of the User to grant platform admin status to (required)' })
  parseEmail(value: string): string {
    return value;
  }

  @Option({
    flags: '-o, --org <slug>',
    description: 'Organisation slug, only needed if the email matches a user in more than one organisation',
  })
  parseOrg(value: string): string {
    return value;
  }

  async run(_passedParams: string[], options: GrantPlatformAdminOptions): Promise<void> {
    const email = options.email;
    if (!email) {
      console.error('Usage: grant-platform-admin --email <email> [--org <slug>]');
      process.exit(1);
    }

    const params: unknown[] = [email];
    let orgFilter = '';
    if (options.org) {
      params.push(options.org);
      orgFilter = `AND o.slug = $${params.length}`;
    }

    const candidates = await this.dataSource.query<Array<{ id: string; organisation_id: string; org_slug: string; email: string }>>(
      `SELECT u.id, u.organisation_id, o.slug AS org_slug, u.email
         FROM core."user" u
         JOIN core.organisation o ON o.id = u.organisation_id
        WHERE u.email = $1 AND u.deleted_at IS NULL ${orgFilter}`,
      params,
    );

    if (candidates.length === 0) {
      console.error(`No active user found with email "${email}"${options.org ? ` in organisation "${options.org}"` : ''}.`);
      process.exit(1);
    }
    if (candidates.length > 1) {
      console.error(
        `"${email}" matches ${candidates.length} users across different organisations — re-run with --org to disambiguate:\n` +
          candidates.map((c) => `  --org ${c.org_slug}`).join('\n'),
      );
      process.exit(1);
    }

    const target = candidates[0]!;

    const [existing] = await this.dataSource.query<Array<{ revoked_at: Date | null }>>(
      `SELECT revoked_at FROM core.platform_admin WHERE user_id = $1`,
      [target.id],
    );

    if (existing && existing.revoked_at === null) {
      console.log(`"${email}" is already an active platform administrator — no change made.`);
      return;
    }

    await this.tenantContext.runInTenantContext(
      { organisationId: target.organisation_id, workspaceId: null, userId: target.id, role: '' },
      async (manager) => {
        await manager.query(
          `INSERT INTO core.platform_admin (user_id, granted_by)
           VALUES ($1, NULL)
           ON CONFLICT (user_id) DO UPDATE
             SET granted_at = now(), granted_by = NULL, revoked_at = NULL, revoked_by = NULL`,
          [target.id],
        );
        // actor_user_id = NULL — no authenticated human actor exists for a
        // CLI bootstrap grant; never fabricate one. organisation_id is
        // stamped from the TARGET user's own org purely because
        // `audit_log.organisation_id` is NOT NULL and this table predates
        // the platform-wide concept `platform_admin` itself is — the grant
        // ACTION is not org-scoped, only this audit row's storage location
        // is, which is why AuditAction/audit_log's own trade-off is
        // documented here rather than adding a workspace_id/nullable
        // organisation_id to the shared audit table for one caller.
        await this.auditService.record(manager, { organisationId: target.organisation_id, userId: target.id }, AuditAction.PLATFORM_ADMIN_GRANTED, {
          targetUserId: target.id,
          actorUserId: null,
          metadata: { via: 'bootstrap_cli' },
        });
      },
    );

    console.log(existing ? `Re-granted platform admin to "${email}".` : `Granted platform admin to "${email}".`);
  }
}
