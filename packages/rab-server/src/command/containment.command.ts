import * as fs from 'fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { resolvePgEnvironmentCached } from '../database/postgres';
import { AuditService } from '../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../engine/core-modules/auth/token/services/refresh-token.service';
import { SecurityVersionService } from '../engine/core-modules/auth/services/security-version.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../engine/core-modules/tenant/workspace-membership.service';
import {
  ContainmentExpectation,
  ContainmentReadSession,
  ContainmentRefusal,
  ContainmentTarget,
  suspendContainmentTargets,
  verifyContainmentAfter,
  verifyContainmentTargets,
} from './containment/suspend-test-accounts';
import { ElevatedOpsSession, verifyOpsAppSession } from './ops/elevated-ops-session';
import { OPS_ELEVATED_PLANS } from './ops/ops-statements';
import { assertOpsRun, describeOpsLabel, OPS_LABEL_NOTE, opsAuditMetadata } from './ops/ops-run';

interface ContainmentOptions {
  target?: string;
  expectOrgs?: string;
  expectUsers?: string;
  expectActive?: string;
  actorUserId?: string;
  log?: string;
  execute?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `containment:suspend-test-accounts`. Dry-run by default. Requires the frozen target file and the expected totals, with no
 * defaults, and an explicit actor. Writes an ID-only JSON-lines log.
 *
 *   --target <tsv>            organisation_id and user_id columns (the frozen containment set)
 *   --expect-orgs <n>         the number of test-pattern organisations in the database (389)
 *   --expect-users <n>        all users in those organisations (698)
 *   --expect-active <n>       active users in those organisations (645)
 *   --actor-user-id <uuid>    the audited actor of every suspension: must be an ACTIVE platform admin
 *                             (core.is_active_platform_admin, checked on the restricted session before anything else).
 *                             It is still a CLAIM made by whoever runs the container, recorded with the operational label
 *                             and marked as such — never proof of who ran the command.
 *   --log <path>              JSON-lines outcome log (ids and results only)
 *   --execute                 without this flag nothing is written
 *
 * Phase B (ops container, owner decision): runs ONLY in the one-off operations container (command/ops/ops-run.ts), with the
 * operator label required. Reads: the verified elevated session (migration identity, `SET LOCAL ROLE rab_secure_owner`,
 * READ ONLY, frozen statements) — organisation and user rows are rab_secure_owner-owned and not FORCE'd, so only their
 * owner sees every tenant. Writes: the injected restricted DataSource (crewflow_app) and the tenant context, the same
 * RLS-bound path as the production deactivation service; never the elevated session.
 */
@Command({ name: 'containment:suspend-test-accounts', description: 'Incident 2026-10-05: deactivate active fixture accounts (dry-run by default)' })
export class ContainmentSuspendCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly membership: WorkspaceMembershipService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async run(_passedParams: string[], options: ContainmentOptions = {}): Promise<void> {
    const execute = options.execute === true;
    const resolved = resolvePgEnvironmentCached(process.env);
    // Layer 2: ops container, operator label, minimum-privilege endpoint rule — before any argument is even read.
    const label = assertOpsRun('containment:suspend-test-accounts', execute ? 'execute' : 'dry-run', { needsElevated: true }, resolved);

    const required = ['target', 'expectOrgs', 'expectUsers', 'expectActive', 'actorUserId', 'log'] as const;
    for (const key of required) {
      if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
    if (!UUID.test(options.actorUserId!)) throw new Error('--actor-user-id must be a uuid');
    const expected: ContainmentExpectation = {
      organisations: Number(options.expectOrgs),
      users: Number(options.expectUsers),
      activeUsers: Number(options.expectActive),
    };
    if (![expected.organisations, expected.users, expected.activeUsers].every(Number.isInteger)) {
      throw new Error('expected totals must be integers');
    }

    const targets = readTargets(options.target!);
    const logLines: string[] = [];
    const record = (entry: Record<string, unknown>) => logLines.push(JSON.stringify({ at: new Date().toISOString(), ...entry }));
    const flush = () => fs.writeFileSync(options.log!, logLines.join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(describeOpsLabel(label));

    // The restricted app session first: exactly crewflow_app, and its deployment identity (the elevated session must match it).
    const app = await verifyOpsAppSession(this.dataSource, resolved, process.env, label.command);
    // The actor claim must name a real, ACTIVE platform admin (definer function, EXECUTE crewflow_app; no elevated read).
    const [admin] = (await this.dataSource.query(`SELECT core.is_active_platform_admin($1::uuid) AS ok`, [options.actorUserId])) as Array<{ ok: boolean }>;
    if (admin?.ok !== true) throw new ContainmentRefusal('--actor-user-id is not an active platform admin; refusing');

    const plan = OPS_ELEVATED_PLANS.containment;
    let elevatedLogin: string | undefined;
    const session = await ElevatedOpsSession.open({
      plan,
      resolved,
      env: process.env,
      app,
      onVerified: (v) => {
        elevatedLogin = v.login;
        record({ event: 'elevated-verified', plan: v.plan, access: v.access, acting: v.acting, identity: v.identity });
      },
    });
    const reader: ContainmentReadSession = { readOnly: (fn) => session.transaction('read-only', (run) => fn(run)) };
    try {
      record({ event: 'start', mode: execute ? 'execute' : 'dry-run', targets: targets.length, expected, operationalLabel: label });
      const verified = await verifyContainmentTargets(reader, targets, expected);
      const auditMetadata = {
        ...opsAuditMetadata(label, { appLogin: app.login, elevatedLogin, elevatedRole: plan.role, identity: app.identity }),
        actorClaim: {
          userId: options.actorUserId,
          checkedAgainst: 'core.is_active_platform_admin',
          note: `${OPS_LABEL_NOTE}: a platform admin named by the operator, not proof of who ran the command`,
        },
      };
      await suspendContainmentTargets(
        {
          dataSource: this.dataSource,
          tenantContext: this.tenantContext,
          membership: this.membership,
          refreshTokens: this.refreshTokens,
          securityVersion: this.securityVersion,
          audit: this.audit,
        },
        options.actorUserId!,
        verified,
        { execute, auditMetadata, onOutcome: (o) => record({ event: 'outcome', ...o }) },
      );
      const after = await verifyContainmentAfter(reader, targets.map((t) => t.userId));
      record({ event: 'after', ...after });
      flush();
      // eslint-disable-next-line no-console
      console.log(
        `[containment] mode=${execute ? 'execute' : 'dry-run'} run=${label.runId} targets=${targets.length} activeRemaining=${after.activeTargets} liveFamiliesRemaining=${after.liveFamilies} log=${options.log}`,
      );
    } catch (error) {
      record({ event: 'stopped', reason: error instanceof ContainmentRefusal ? error.message : (error as Error).name });
      flush();
      throw error;
    } finally {
      await session.destroy();
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

  @Option({ flags: '--actor-user-id <uuid>', description: 'audited actor: an ACTIVE platform admin (a recorded claim, not proof of who ran it)' })
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
