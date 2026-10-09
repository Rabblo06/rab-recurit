import * as fs from 'fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { coreDataSourceOptions } from '../database/typeorm/core/core.datasource';
import { AuditService } from '../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../engine/core-modules/auth/token/services/refresh-token.service';
import { SecurityVersionService } from '../engine/core-modules/auth/services/security-version.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../engine/core-modules/tenant/workspace-membership.service';
import {
  ContainmentExpectation,
  ContainmentRefusal,
  ContainmentTarget,
  suspendContainmentTargets,
  verifyContainmentAfter,
  verifyContainmentTargets,
} from './containment/suspend-test-accounts';

interface ContainmentOptions {
  target?: string;
  expectOrgs?: string;
  expectUsers?: string;
  expectActive?: string;
  actorUserId?: string;
  log?: string;
  execute?: boolean;
}

/**
 * `containment:suspend-test-accounts`. Dry-run by default. Requires the frozen target file and the expected totals, with no
 * defaults, and an explicit actor. Writes an ID-only JSON-lines log. The command guard (DB_TARGET) runs before this body.
 *
 *   --target <tsv>            organisation_id and user_id columns (the frozen containment set)
 *   --expect-orgs <n>         the number of test-pattern organisations in the database (389)
 *   --expect-users <n>        all users in those organisations (698)
 *   --expect-active <n>       active users in those organisations (645)
 *   --actor-user-id <uuid>    the audited actor for every suspension
 *   --log <path>              JSON-lines outcome log (ids and results only)
 *   --execute                 without this flag nothing is written
 *
 * Reads use the owner connection (DATABASE_URL_UNPOOLED). Organisation and user rows are not visible to the runtime role
 * without a tenant context, so an app-role read would see nothing and refuse. Writes go through the injected runtime
 * DataSource and the tenant context, the same RLS-bound path as the production deactivation service.
 */
@Command({ name: 'containment:suspend-test-accounts', description: 'Incident 2026-10-05: deactivate active fixture accounts (dry-run by default)' })
export class ContainmentSuspendCommand extends CommandRunner {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly membership: WorkspaceMembershipService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async run(_passedParams: string[], options: ContainmentOptions = {}): Promise<void> {
    const required = ['target', 'expectOrgs', 'expectUsers', 'expectActive', 'actorUserId', 'log'] as const;
    for (const key of required) {
      if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
    const expected: ContainmentExpectation = {
      organisations: Number(options.expectOrgs),
      users: Number(options.expectUsers),
      activeUsers: Number(options.expectActive),
    };
    if (![expected.organisations, expected.users, expected.activeUsers].every(Number.isInteger)) {
      throw new Error('expected totals must be integers');
    }
    const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
    if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED is required for the containment reads');

    const targets = readTargets(options.target!);
    const execute = options.execute === true;
    const logLines: string[] = [];
    const record = (entry: Record<string, unknown>) => logLines.push(JSON.stringify({ at: new Date().toISOString(), ...entry }));
    const flush = () => fs.writeFileSync(options.log!, logLines.join('\n') + '\n');

    const reader = new DataSource({
      ...(coreDataSourceOptions as PostgresConnectionOptions),
      url: ownerUrl,
      name: `containment-read-${Date.now()}`,
    });
    await reader.initialize();
    try {
      record({ event: 'start', mode: execute ? 'execute' : 'dry-run', targets: targets.length, expected });
      const verified = await verifyContainmentTargets(reader, targets, expected);
      await suspendContainmentTargets(
        {
          dataSource: reader,
          tenantContext: this.tenantContext,
          membership: this.membership,
          refreshTokens: this.refreshTokens,
          securityVersion: this.securityVersion,
          audit: this.audit,
        },
        options.actorUserId!,
        verified,
        { execute, onOutcome: (o) => record({ event: 'outcome', ...o }) },
      );
      const after = await verifyContainmentAfter(reader, targets.map((t) => t.userId));
      record({ event: 'after', ...after });
      flush();
      // eslint-disable-next-line no-console
      console.log(
        `[containment] mode=${execute ? 'execute' : 'dry-run'} targets=${targets.length} activeRemaining=${after.activeTargets} liveFamiliesRemaining=${after.liveFamilies} log=${options.log}`,
      );
    } catch (error) {
      record({ event: 'stopped', reason: error instanceof ContainmentRefusal ? error.message : (error as Error).name });
      flush();
      throw error;
    } finally {
      await reader.destroy();
    }
  }

  @Option({ flags: '--target <path>', description: 'frozen containment target file (TSV with organisation_id, user_id)' })
  parseTarget(value: string): string {
    return value;
  }

  @Option({ flags: '--expect-orgs <n>', description: 'expected test-pattern organisations' })
  parseExpectOrgs(value: string): string {
    return value;
  }

  @Option({ flags: '--expect-users <n>', description: 'expected users in those organisations' })
  parseExpectUsers(value: string): string {
    return value;
  }

  @Option({ flags: '--expect-active <n>', description: 'expected active users in those organisations' })
  parseExpectActive(value: string): string {
    return value;
  }

  @Option({ flags: '--actor-user-id <uuid>', description: 'audited actor' })
  parseActor(value: string): string {
    return value;
  }

  @Option({ flags: '--log <path>', description: 'JSON-lines outcome log' })
  parseLog(value: string): string {
    return value;
  }

  @Option({ flags: '--execute', description: 'perform the suspensions (without this, dry-run)' })
  parseExecute(): boolean {
    return true;
  }
}

/** Reads organisation_id and user_id from a TSV with a header row. Other columns (including any email) are ignored. */
export function readTargets(path: string): ContainmentTarget[] {
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0]!.split('\t');
  const orgIndex = header.indexOf('organisation_id');
  const userIndex = header.indexOf('user_id');
  if (orgIndex < 0 || userIndex < 0) throw new Error('target file needs organisation_id and user_id columns');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return { organisationId: cells[orgIndex]!, userId: cells[userIndex]! };
  });
}
