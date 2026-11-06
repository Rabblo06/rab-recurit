import { readFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { AuditService } from '../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { parseRepairIds, ShiftCompletionRepair } from '../modules/scheduling/services/shift-completion-repair';

interface Options {
  list?: boolean;
  apply?: boolean;
  ids?: string;
  actorEmail?: string;
  organisation?: string;
  changeRef?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:#/+-]{0,119}$/;

/**
 * `shift:complete-settled [--list] [--organisation <id>]`
 * `shift:complete-settled --apply --ids <file> --actor-email <platform admin> [--change-ref <ref>] [--organisation <id>]`
 *
 * ONE-OFF REPAIR (owner decision 2026-11-06, Q3) — see `ShiftCompletionRepair`. Never run automatically: the owner reviews
 * the `--list` output, writes the ids to approve into a file (one shift UUID per line), and only then runs `--apply`.
 *
 *  - `--list` (the DEFAULT, READ-ONLY): per organisation / workspace, in that tenant's context, the `in_progress` shifts
 *    the completion roll-up would complete (id, venue, starts/ends, seat breakdown), plus the count. Writes nothing.
 *  - `--apply --ids <file>`: completes ONLY those ids, each re-checked by the same roll-up in its tenant context
 *    (idempotent; an id that is not settled is refused; an id found in no workspace — another tenant's when
 *    `--organisation` is given, or a made-up one — is `not_found` and nothing happens), audited
 *    `shift.completed_by_repair` with the platform-admin actor (resolved from `--actor-email` through the pre-auth lookup,
 *    as `outbox:replay` does; an operator cannot apply anonymously).
 *
 * Guards: the CLI's own — DB_TARGET (+ ALLOW_PRODUCTION_DB_COMMANDS and the deployment identity in production), the boot
 * gates (the restricted owner login, never SUPERUSER / BYPASSRLS) — and, in the command body (layer 2, a body can be
 * reached without main.ts), a refusal of any superuser or RLS-exempt session. Prints ids, venue names, times and
 * counts; never a URL or credential. Exit 0 = list done / every id completed or already completed; 1 = otherwise.
 */
@Command({ name: 'shift:complete-settled', description: 'ONE-OFF: list (default, read-only) or apply the completion of settled in_progress shifts' })
export class ShiftCompleteSettledCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  @Option({ flags: '--list', description: 'READ-ONLY listing (the default)' })
  parseList(): boolean {
    return true;
  }

  @Option({ flags: '--apply', description: 'Complete ONLY the shifts listed in --ids (re-checked, audited)' })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--ids <file>', description: 'File with one shift UUID per line (required with --apply)' })
  parseIds(value: string): string {
    return value;
  }

  @Option({ flags: '--actor-email <email>', description: 'Email of the ACTIVE platform admin applying the repair (recorded in audit_log)' })
  parseActorEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  @Option({ flags: '--organisation <id>', description: 'Limit to one organisation id' })
  parseOrganisation(value: string): string {
    if (!UUID.test(value)) throw new Error('--organisation must be a UUID');
    return value.toLowerCase();
  }

  @Option({ flags: '--change-ref <ref>', description: 'The approval / change reference, recorded in the audit metadata' })
  parseChangeRef(value: string): string {
    if (!CHANGE_REF.test(value)) throw new Error('--change-ref must be a short printable reference (e.g. OPS-123, org/repo#45)');
    return value;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const repair = new ShiftCompletionRepair(this.dataSource, this.tenantContext, this.auditService);
    if (options.apply && options.list) throw new Error('shift:complete-settled: choose --list or --apply, not both');
    if (!options.apply) {
      const rows = await repair.list({ organisationId: options.organisation });
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(
          `[shift:complete-settled] would-complete organisation=${r.organisationId} workspace=${r.workspaceId} shift=${r.shiftId} ` +
            `venue=${JSON.stringify(r.venueName)} starts=${r.startsAt} ends=${r.endsAt} seats=${JSON.stringify(r.seats)}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[shift:complete-settled] list (read-only): ${rows.length} shift(s) would complete; nothing was changed` +
          (repair.skippedWorkspaces ? `; ${repair.skippedWorkspaces} workspace(s) not routable yet were skipped` : ''),
      );
      return;
    }

    if (!options.ids) throw new Error('shift:complete-settled: --apply needs --ids <file> (one shift UUID per line, from a reviewed --list)');
    if (!options.actorEmail) throw new Error('shift:complete-settled: --apply needs --actor-email <platform admin email>');
    const ids = parseRepairIds(readFileSync(options.ids, 'utf8'));
    const actorUserId = await this.resolveActor(options.actorEmail);
    if (!actorUserId) {
      // eslint-disable-next-line no-console
      console.error('[shift:complete-settled] refused: the actor is not an active platform admin');
      process.exitCode = 1;
      return;
    }
    const results = await repair.apply(ids, { userId: actorUserId, changeRef: options.changeRef }, { organisationId: options.organisation });
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[shift:complete-settled] shift=${r.shiftId} organisation=${r.organisationId ?? '-'} result=${r.outcome}`);
    }
    const ok = results.filter((r) => r.outcome === 'completed' || r.outcome === 'already_completed').length;
    // eslint-disable-next-line no-console
    console.log(`[shift:complete-settled] apply: ${results.filter((r) => r.outcome === 'completed').length} completed, ${results.length - ok} refused or not found`);
    if (ok !== results.length) process.exitCode = 1;
  }

  /** Pre-auth email lookup (the same SECURITY DEFINER path login uses), then the platform-admin check — as `outbox:replay`. */
  private async resolveActor(email: string): Promise<string | null> {
    const rows: Array<{ id: string; status: string }> = await this.dataSource
      .query(`SELECT u.id, u.status FROM core.auth_find_users_by_email($1::citext) u`, [email])
      .catch(() => []);
    for (const row of rows) {
      if (row.status !== 'active') continue;
      const admin: Array<{ ok: boolean }> = await this.dataSource.query('SELECT core.is_active_platform_admin($1) AS ok', [row.id]).catch(() => []);
      if (admin[0]?.ok === true) return row.id;
    }
    return null;
  }
}
