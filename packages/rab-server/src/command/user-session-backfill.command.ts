import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { resolvePgEnvironmentCached } from '../database/postgres';
import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import {
  CandidateRow,
  UserSessionBackfillAbort,
  UserSessionBackfillExecutor,
  UserSessionBackfillService,
} from '../engine/core-modules/auth/token/backfill/user-session-backfill.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { ElevatedOpsSession, ElevatedOpsSessionError, verifyOpsAppSession } from './ops/elevated-ops-session';
import { OPS_ELEVATED_PLANS } from './ops/ops-statements';
import { assertOpsRun, describeOpsLabel, opsAuditMetadata } from './ops/ops-run';

interface Options {
  batch?: number;
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
}

/**
 * `user-session:backfill` — P1B's backfill from existing `core.refresh_token` families to
 * `core.user_session` rows, for sessions created before this phase shipped. See
 * `UserSessionBackfillService`'s own doc comment for the full algorithm (consistency check,
 * fail-closed, terminal-state derivation, idempotency).
 *
 * Phase B (ops container, owner decision): runs ONLY in the one-off operations container (command/ops/ops-run.ts), with the
 * operator label required, at the minimum effective role per mode:
 *   --verify    crewflow_app only (`core.count_user_session_backfill_status()`, EXECUTE crewflow_app). PG_DATABASE_URL (the
 *               migration identity) is REFUSED for this mode. Run it first: when missing = 0 no privileged run is needed.
 *   --dry-run   the verified elevated session, `SET LOCAL ROLE rab_secure_owner`, READ ONLY: the cross-organisation
 *               candidate scan of `core.refresh_token` (rab_secure_owner-owned, not FORCE'd: only its owner sees every
 *               tenant). Zero writes.
 *   --apply     the same scan READ ONLY, then one READ WRITE elevated transaction per family (`SET LOCAL ROLE
 *               rab_secure_owner`, bind the family's own identity, idempotent INSERT into `core.user_session`, whose INSERT
 *               privilege only its owner holds). Then ONE actor-less audit row per organisation through crewflow_app, carrying
 *               the operational label. Idempotent: re-running reports already-present, never duplicates.
 * Every elevated transaction is verified (elevated-ops-session.ts) and runs only the frozen statements of its plan
 * (ops-statements.ts). `DB_TARGET` and the boot gates already ran in `command/main.ts`.
 */
@Command({
  name: 'user-session:backfill',
  description: 'Backfill core.user_session rows for existing refresh_token families (dry-run by default)',
})
export class UserSessionBackfillCommand extends CommandRunner {
  constructor(
    private readonly backfill: UserSessionBackfillService,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  @Option({ flags: '--batch <n>', description: 'Bound on how many families are scanned per run (default 500)' })
  parseBatch(value: string): number {
    return Number(value);
  }

  @Option({ flags: '--dry-run', description: 'Report only, zero writes (default if no mode flag is given)' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--apply', description: "MODIFIES: write core.user_session rows for consistent, not-yet-backfilled families" })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--verify', description: 'Report cross-organisation backfill completeness; no writes' })
  parseVerify(): boolean {
    return true;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const modesRequested = [options.dryRun, options.apply, options.verify].filter(Boolean).length;
    if (modesRequested > 1) throw new Error('--dry-run, --apply and --verify are mutually exclusive — pass exactly one.');
    const mode: 'dry-run' | 'apply' | 'verify' = options.verify ? 'verify' : options.apply ? 'apply' : 'dry-run';
    const batchSize = options.batch && options.batch > 0 ? options.batch : 500;
    const resolved = resolvePgEnvironmentCached(process.env);
    // Layer 2: ops container, operator label, and PG_DATABASE_URL present exactly when this mode needs it.
    const label = assertOpsRun('user-session:backfill', mode, { needsElevated: mode !== 'verify' }, resolved);
    // eslint-disable-next-line no-console
    console.log(describeOpsLabel(label));
    const app = await verifyOpsAppSession(this.dataSource, resolved, process.env, label.command);

    // eslint-disable-next-line no-console
    console.log(`[user-session:backfill] mode=${mode} batch=${batchSize} run=${label.runId} app=${app.login} identity=${app.identity}`);
    if (mode === 'verify') {
      const result = await this.backfill.verify(this.dataSource);
      // eslint-disable-next-line no-console
      console.log(`  total=${result.totalFamilies} backfilled=${result.backfilled} missing=${result.missing} PASS=${result.pass}`);
      return;
    }

    const plan = mode === 'apply' ? OPS_ELEVATED_PLANS['user-session-apply'] : OPS_ELEVATED_PLANS['user-session-scan'];
    let elevatedLogin: string | undefined;
    const session = await ElevatedOpsSession.open({
      plan,
      resolved,
      env: process.env,
      app,
      onVerified: (v) => {
        elevatedLogin = v.login;
      },
    });
    // Verification refusals stop the run (never counted as "one bad family").
    const abortOnRefusal = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof ElevatedOpsSessionError || (error instanceof Error && error.name === 'DeploymentIdentityError')) {
          throw new UserSessionBackfillAbort(error.message);
        }
        throw error;
      }
    };
    const executor: UserSessionBackfillExecutor = {
      findCandidates: (n) =>
        abortOnRefusal(() =>
          session.transaction('read-only', async (run) => (await run('user-session-backfill.candidates', [n])) as unknown as CandidateRow[]),
        ),
      insertFamily: (binding, values) =>
        abortOnRefusal(() =>
          session.transaction('read-write', async (run) => {
            await run('user-session-backfill.bind-family', binding);
            return (await run('user-session-backfill.insert-family', values)) as Array<{ id: string }>;
          }),
        ),
    };
    this.backfill.executor = executor;
    try {
      const result = await this.backfill.run({ dryRun: mode === 'dry-run', batchSize });
      // eslint-disable-next-line no-console
      console.log(
        `  scanned=${result.candidatesScanned} inserted=${result.inserted} alreadyPresent=${result.alreadyPresent} failedClosed=${result.failedClosed}`,
      );
      for (const family of result.families) {
        if (family.outcome === 'skipped-inconsistent') {
          // eslint-disable-next-line no-console
          console.warn(`  BLOCKED family=${family.familyId}: ${family.reason}`);
        }
      }
      if (mode === 'apply') {
        // One actor-less audit row per organisation that received rows, through the restricted runtime path.
        const byOrg = new Map<string, string[]>();
        for (const f of result.families) {
          if (f.outcome === 'inserted' && f.organisationId) byOrg.set(f.organisationId, [...(byOrg.get(f.organisationId) ?? []), f.familyId]);
        }
        const metadata = opsAuditMetadata(label, { appLogin: app.login, elevatedLogin, elevatedRole: plan.role, identity: app.identity });
        for (const [organisationId, familyIds] of byOrg) {
          await this.tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, (m) =>
            this.audit.record(
              m,
              { organisationId, userId: '' },
              AuditAction.OPS_USER_SESSION_BACKFILL_APPLIED,
              { actorUserId: null, entityType: 'ops_run', entityId: label.runId, metadata: { ...metadata, insertedFamilies: familyIds.length, familyIds } },
            ),
          );
        }
        // eslint-disable-next-line no-console
        console.log(`  audit rows=${byOrg.size} (one per organisation, action=${AuditAction.OPS_USER_SESSION_BACKFILL_APPLIED})`);
      }
    } finally {
      this.backfill.executor = undefined;
      await session.destroy();
    }
  }
}
