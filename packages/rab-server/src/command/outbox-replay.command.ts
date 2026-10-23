import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { OutboxOperationsService, ReplayResult } from '../engine/core-modules/platform-admin/outbox-operations.service';

interface Options {
  organisation?: string;
  actorEmail?: string;
  allowUncertain?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `outbox:replay <emailOutboxId> --actor-email <platform admin> [--organisation <id>] [--allow-uncertain]`
 *
 * Wave 5 lane OPS — the CLI twin of `POST /rest/v1/admin/outbox/organisations/:org/emails/:id/replay`. Same service,
 * same checks (`OutboxOperationsService` refuses unless the actor is an ACTIVE platform admin), same database function
 * (`core.replay_failed_email`: FAILED -> PENDING once, generation bump, `email.replay_requested` audit row with the
 * actor). The actor is resolved from an email through the pre-auth lookup and must be an active platform admin; the
 * audit row names that person, so an operator cannot replay anonymously.
 *
 * Without `--organisation`, every organisation is tried in id order until one holds the FAILED row; the function only
 * ever acts on a FAILED row of the bound organisation, so the other attempts are no-ops (NOT_FOUND, no audit row).
 *
 * Prints ids and the outcome only. Exit 0 = REPLAYED; 1 = NOT_FOUND / NO_BODY / UNCERTAIN / refused.
 */
@Command({ name: 'outbox:replay', arguments: '<emailOutboxId>', description: 'Replay one FAILED email exactly once (audited; platform admin actor required)' })
export class OutboxReplayCommand extends CommandRunner {
  constructor(
    private readonly outbox: OutboxOperationsService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  @Option({ flags: '--organisation <id>', description: "The email's organisation id (optional; otherwise searched)" })
  parseOrganisation(value: string): string {
    if (!UUID.test(value)) throw new Error('--organisation must be a UUID');
    return value.toLowerCase();
  }

  @Option({ flags: '--actor-email <email>', description: 'Email of the ACTIVE platform admin performing the replay (recorded in audit_log)' })
  parseActorEmail(value: string): string {
    return value.trim().toLowerCase();
  }

  @Option({ flags: '--allow-uncertain', description: 'Also replay a DELIVERY_UNCERTAIN row (the provider may already have sent it)' })
  parseAllowUncertain(): boolean {
    return true;
  }

  async run(params: string[], options: Options): Promise<void> {
    const emailId = params[0] ?? '';
    if (!UUID.test(emailId)) throw new Error('outbox:replay: <emailOutboxId> must be a UUID');
    if (!options.actorEmail) throw new Error('outbox:replay: --actor-email <platform admin email> is required');

    const actorUserId = await this.resolveActor(options.actorEmail);
    if (!actorUserId) {
      // eslint-disable-next-line no-console
      console.error('[outbox:replay] refused: the actor is not an active platform admin');
      process.exitCode = 1;
      return;
    }
    const actor = { userId: actorUserId };

    let result: ReplayResult = 'NOT_FOUND';
    let organisationId: string | undefined = options.organisation;
    if (organisationId) {
      result = await this.outbox.replayFailedEmailRaw(actor, organisationId, emailId, { allowUncertain: options.allowUncertain });
    } else {
      for await (const candidate of this.outbox.organisationsForCli()) {
        const r = await this.outbox.replayFailedEmailRaw(actor, candidate, emailId, { allowUncertain: options.allowUncertain });
        if (r !== 'NOT_FOUND') {
          result = r;
          organisationId = candidate;
          break;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[outbox:replay] email=${emailId} organisation=${organisationId ?? '-'} result=${result}`);
    if (result === 'NO_BODY') {
      // eslint-disable-next-line no-console
      console.log('  the body carried a one-time link and was cleared (F1); the user must request a new link');
    }
    if (result === 'UNCERTAIN') {
      // eslint-disable-next-line no-console
      console.log('  delivery may already have happened; re-run with --allow-uncertain only after checking the provider');
    }
    if (result !== 'REPLAYED') process.exitCode = 1;
  }

  /** Pre-auth email lookup (the same SECURITY DEFINER path login uses), then the platform-admin check. Never prints the id on failure. */
  private async resolveActor(email: string): Promise<string | null> {
    // Only id/status columns are selected (the function also returns the password hash — never read here).
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
