import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { resolvePgEnvironmentCached } from '../database/postgres';
import {
  HwsBackfillError,
  HwsBackfillService,
  WorkspaceApplyResult,
  WorkspaceDryRunReport,
  WorkspaceVerifyResult,
} from '../database/typeorm/workspace-schema/backfill/hws-backfill.service';
import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { verifyOpsAppSession } from './ops/elevated-ops-session';
import { assertHwsApplyAllowed } from './ops/hws-cutover-policy';
import { assertOpsRun, describeOpsLabel, opsAuditMetadata } from './ops/ops-run';

interface Options {
  workspaceId?: string;
  all?: boolean;
  batch?: number;
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  resume?: boolean;
  reportFile?: string;
  hwsCutover?: boolean;
}

export interface HwsBackfillReport {
  mode: 'dry-run' | 'apply' | 'verify';
  classification: string;
  database: string;
  workspacesSelected: number;
  runId: string;
  dryRun?: WorkspaceDryRunReport[];
  apply?: WorkspaceApplyResult[];
  verify?: WorkspaceVerifyResult[];
}

/**
 * `hws:backfill` — HWS backfill tool (Part 2 of the backfill brief). Copies EXISTING legacy
 * `core.<table>` business rows into each workspace's own physical schema, in FK-safe order
 * (`WORKSPACE_TABLE_COPY_ORDER`, derived from the live V1 catalog — see `fk-graph.ts`). The source
 * `core` rows are never modified or deleted by this command, under any mode.
 *
 * Phase B (ops container, owner decision): runs ONLY in the one-off operations container (command/ops/ops-run.ts) with the
 * operator label required, and EVERY mode runs as the restricted runtime login crewflow_app (PG_OPS_APP_DATABASE_URL):
 * discovery through `core.worker_list_workspaces()`, the tenant-bound reads, the checkpoint upserts, AND the physical-schema
 * copy (`writePhysical`). The copy no longer uses an owner connection: every workspace table is FORCE'd (so the owner had no
 * RLS advantage), crewflow_app holds INSERT on each of them, and the `attendance_post_shift_reset` trigger and the generated
 * columns behave the same — proven on a disposable database (runbook ops section). PG_DATABASE_URL (the migration
 * identity) is therefore REFUSED for this command. The six runtime-actor tables stay with the one-off privileged migration.
 *
 * `--apply` / `--resume` while HWS runtime routing is OFF requires `--hws-cutover` (assertHwsApplyAllowed). Do not run it in
 * production while HWS is off. Each applied workspace gets one actor-less audit row (`ops.hws_backfill_applied`, its
 * organisation) carrying the operational label.
 *
 * Modes (mutually exclusive; `--dry-run` is the default if none is given — report-only, zero writes):
 *   --dry-run   report only — workspace/registry status, row counts, conflicts, blocked rows
 *   --apply     copies rows (idempotent — a second run reports already-complete, never duplicates)
 *   --verify    validates a previously-applied (or claimed-complete) workspace, no writes
 *   --resume    identical mechanics to --apply; the distinct flag exists for operator clarity
 *
 * Selection: --workspace-id <uuid> (one explicit workspace, validated against the trusted registry
 * via `core.worker_list_workspaces` — never a bare client-supplied id taken on faith), or
 * --all with --batch <n> (bounded; defaults to 50). A schema NAME is never accepted as input
 * anywhere in this command (Part 8) — only a workspace UUID, resolved to its physical schema
 * exclusively through `SchemaResolverService`.
 */
@Command({
  name: 'hws:backfill',
  description: "Copy legacy core.<table> workspace-business rows into each workspace's physical schema (dry-run by default)",
})
export class HwsBackfillCommand extends CommandRunner {
  constructor(
    private readonly backfill: HwsBackfillService,
    private readonly environment: EnvironmentService,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  @Option({ flags: '--workspace-id <uuid>', description: 'Back up this one workspace (validated against core.worker_list_workspaces, never taken on faith)' })
  parseWorkspaceId(value: string): string {
    return value;
  }

  @Option({ flags: '--all', description: 'Select every workspace the trusted registry reports (bounded by --batch)' })
  parseAll(): boolean {
    return true;
  }

  @Option({ flags: '--batch <n>', description: 'Bound on how many workspaces --all selects (default 50)' })
  parseBatch(value: string): number {
    return Number(value);
  }

  @Option({ flags: '--dry-run', description: 'Report only, zero writes (default if no mode flag is given)' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--apply', description: 'MODIFIES: copy rows into each selected workspace\'s physical schema' })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--verify', description: 'Validate a previously-applied workspace; no writes' })
  parseVerify(): boolean {
    return true;
  }

  @Option({ flags: '--resume', description: 'Same as --apply; reports which tables are skipped as already complete' })
  parseResume(): boolean {
    return true;
  }

  @Option({ flags: '--hws-cutover', description: 'Required for --apply/--resume while HWS runtime routing is OFF: this copy is an approved HWS cutover step' })
  parseHwsCutover(): boolean {
    return true;
  }

  @Option({ flags: '--report-file <path>', description: 'Write the JSON report to this path' })
  parseReportFile(value: string): string {
    return value;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const modesRequested = [options.dryRun, options.apply, options.verify, options.resume].filter(Boolean).length;
    if (modesRequested > 1) throw new Error('--dry-run, --apply, --verify and --resume are mutually exclusive — pass exactly one.');
    const mode: 'dry-run' | 'apply' | 'verify' = options.verify ? 'verify' : options.apply || options.resume ? 'apply' : 'dry-run';
    const resolved = resolvePgEnvironmentCached(process.env);
    // Layer 2: ops container, operator label, and no migration identity at all (every mode runs as crewflow_app).
    const label = assertOpsRun('hws:backfill', options.resume ? 'resume' : mode, { needsElevated: false }, resolved);
    const hwsRuntimeEnabled = this.environment.get('HWS_RUNTIME_ENABLED') === true;
    assertHwsApplyAllowed({ mode, hwsRuntimeEnabled, hwsCutover: options.hwsCutover === true, production: process.env.DB_TARGET?.trim() === 'production' });

    if (!options.workspaceId && !options.all) throw new Error('One workspace selector is required: --workspace-id <uuid> or --all.');
    if (options.workspaceId && options.all) throw new Error('--workspace-id and --all are mutually exclusive.');

    // eslint-disable-next-line no-console
    console.log(describeOpsLabel(label));
    const app = await verifyOpsAppSession(this.dataSource, resolved, process.env, label.command);

    const candidates = options.workspaceId
      ? await (async () => {
          const found = await this.backfill.findCandidate(options.workspaceId!);
          if (!found) throw new Error(`Workspace ${options.workspaceId} was not found in the trusted registry (core.worker_list_workspaces) — refusing.`);
          return [found];
        })()
      : await this.backfill.listCandidates(options.batch && options.batch > 0 ? options.batch : 50);

    // eslint-disable-next-line no-console
    console.log(
      `[hws:backfill] mode=${mode} run=${label.runId} hws_runtime_enabled=${hwsRuntimeEnabled} hws_cutover=${options.hwsCutover === true} app=${app.login} identity=${app.identity} workspacesSelected=${candidates.length}`,
    );

    const report: HwsBackfillReport = {
      mode,
      classification: 'see runtime-database-guard / database-target logs above this command\'s own output for the resolved identity',
      database: app.database,
      workspacesSelected: candidates.length,
      runId: label.runId,
    };

    if (mode === 'dry-run') {
      report.dryRun = [];
      for (const ctx of candidates) {
        const result = await this.backfill.dryRun(ctx);
        report.dryRun.push(result);
        // eslint-disable-next-line no-console
        console.log(
          `  workspace=${ctx.workspaceId} org=${ctx.organisationId} registry=${result.registryStatus} safeToApply=${result.safeToApply} ` +
            `tables=${result.tables.map((t) => `${t.table}:${t.toCopy}new/${t.alreadyCopied}copied/${t.conflicts}conflict/${t.blocked}blocked`).join(' ')}`,
        );
        if (result.unsupportedConditions.length) {
          for (const condition of result.unsupportedConditions) {
            // eslint-disable-next-line no-console
            console.log(`    BLOCKER: ${condition}`);
          }
        }
      }
    } else if (mode === 'apply') {
      // The physical copy runs on the injected restricted DataSource (crewflow_app), the same login as every read: no owner
      // connection is opened at all. The service's binding (organisation, workspace, the workspace's owning manager, the
      // resolved schema) is what the FORCE'd insert policies check.
      this.backfill.ownerDataSource = this.dataSource;
      const metadata = opsAuditMetadata(label, { appLogin: app.login, identity: app.identity });
      try {
        report.apply = [];
        for (const ctx of candidates) {
          try {
            const result = await this.backfill.apply(ctx);
            report.apply.push(result);
            await this.tenantContext.runInTenantContext({ organisationId: ctx.organisationId, workspaceId: null, userId: '', role: '' }, (m) =>
              this.audit.record(m, { organisationId: ctx.organisationId, userId: '' }, AuditAction.OPS_HWS_BACKFILL_APPLIED, {
                actorUserId: null,
                entityType: 'manager_workspace',
                entityId: ctx.workspaceId,
                metadata: {
                  ...metadata,
                  hwsCutover: options.hwsCutover === true,
                  overall: result.overall,
                  tables: result.tables.map((t) => ({ table: t.table, state: t.state, rowsCopied: t.rowsCopied })),
                },
              }),
            );
            // eslint-disable-next-line no-console
            console.log(`  workspace=${ctx.workspaceId} overall=${result.overall} ` + result.tables.map((t) => `${t.table}:${t.state}(${t.rowsCopied})`).join(' '));
          } catch (error) {
            if (error instanceof HwsBackfillError) {
              // eslint-disable-next-line no-console
              console.error(`  workspace=${ctx.workspaceId} REFUSED: ${error.message}`);
              continue; // one workspace's refusal must not abort the whole batch
            }
            throw error;
          }
        }
      } finally {
        this.backfill.ownerDataSource = undefined;
      }
    } else {
      report.verify = [];
      for (const ctx of candidates) {
        const result = await this.backfill.verify(ctx);
        report.verify.push(result);
        // eslint-disable-next-line no-console
        console.log(`  workspace=${ctx.workspaceId} PASS=${result.pass} ` + result.tables.map((t) => `${t.table}:${t.pass ? 'PASS' : 'FAIL(' + t.reasons.join(';') + ')'}`).join(' '));
      }
    }

    if (options.reportFile) writeFileSync(options.reportFile, JSON.stringify(report, null, 2));
  }
}
