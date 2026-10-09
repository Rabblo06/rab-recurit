import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import {
  HwsBackfillError,
  HwsBackfillService,
  WorkspaceApplyResult,
  WorkspaceDryRunReport,
  WorkspaceVerifyResult,
} from '../database/typeorm/workspace-schema/backfill/hws-backfill.service';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';

interface Options {
  workspaceId?: string;
  all?: boolean;
  batch?: number;
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  resume?: boolean;
  reportFile?: string;
}

export interface HwsBackfillReport {
  mode: 'dry-run' | 'apply' | 'verify';
  classification: string;
  database: string;
  workspacesSelected: number;
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
 * Runs as `rab_app` (this package's `DATABASE_URL`, like every other command) — never
 * `rab_owner`. See `HwsBackfillService`'s own doc comment for why no owner connection is needed:
 * workspace discovery goes through `core.worker_list_workspaces()` (the same narrow, `rab_app`-
 * granted function the worker's own discovery already uses), and the per-workspace copy itself
 * is two ordinary tenant-bound transactions (read `core` under that workspace's own context, write
 * the physical schema under the same context) — exactly the two halves of what a normal `rab_app`
 * request already does, just driven by this tool instead of an HTTP request. RLS is never
 * disabled: reads/writes are bound to the target workspace's own tenant context like any other
 * `rab_app` work, and every table this tool touches is FORCE RLS.
 *
 * `DB_TARGET` and the production-command safeguards (`database-target.ts`) already run globally in
 * `command/main.ts`'s `bootstrap()`, before this or any other command's `run()` — no separate
 * target check is added here, and none is needed.
 *
 * Modes (mutually exclusive; `--dry-run` is the default if none is given — report-only, zero
 * writes, matching `storage:reconcile`'s own safety-first default):
 *   --dry-run   report only — workspace/registry status, row counts, conflicts, blocked rows
 *   --apply     copies rows (idempotent — a second run reports already-complete, never duplicates)
 *   --verify    validates a previously-applied (or claimed-complete) workspace, no writes
 *   --resume    identical mechanics to --apply; the distinct flag exists for operator clarity
 *               (announces which tables are being skipped as already-`completed` per the
 *               checkpoint table, rather than looking like a fresh run)
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

  @Option({ flags: '--report-file <path>', description: 'Write the JSON report to this path' })
  parseReportFile(value: string): string {
    return value;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const modesRequested = [options.dryRun, options.apply, options.verify, options.resume].filter(Boolean).length;
    if (modesRequested > 1) throw new Error('--dry-run, --apply, --verify and --resume are mutually exclusive — pass exactly one.');
    const mode: 'dry-run' | 'apply' | 'verify' = options.verify ? 'verify' : options.apply || options.resume ? 'apply' : 'dry-run';

    if (!options.workspaceId && !options.all) throw new Error('One workspace selector is required: --workspace-id <uuid> or --all.');
    if (options.workspaceId && options.all) throw new Error('--workspace-id and --all are mutually exclusive.');

    const candidates = options.workspaceId
      ? await (async () => {
          const found = await this.backfill.findCandidate(options.workspaceId!);
          if (!found) throw new Error(`Workspace ${options.workspaceId} was not found in the trusted registry (core.worker_list_workspaces) — refusing.`);
          return [found];
        })()
      : await this.backfill.listCandidates(options.batch && options.batch > 0 ? options.batch : 50);

    // eslint-disable-next-line no-console
    console.log(`[hws:backfill] mode=${mode} hws_runtime_enabled=${this.environment.get('HWS_RUNTIME_ENABLED')} workspacesSelected=${candidates.length}`);

    const report: HwsBackfillReport = {
      mode,
      classification: 'see runtime-database-guard / database-target logs above this command\'s own output for the resolved identity',
      database: 'resolved by DB_TARGET — see command/main.ts bootstrap log',
      workspacesSelected: candidates.length,
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
      // Owner connection, opened ONLY for apply (dry-run/verify never write, never need it) and closed again
      // right after this batch — see HwsBackfillService's own doc comment for exactly why the physical-schema
      // write needs rab_owner, not rab_app. Never DATABASE_URL (that's rab_app); DATABASE_URL_UNPOOLED is this
      // package's existing rab_owner convention (BootstrapAdminCommand, provisionWorkspaceSchema, ...).
      if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is required for --apply (the rab_owner connection the physical-schema write needs).');
      const ownerDataSource = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL_UNPOOLED, entities: [], synchronize: false, logging: false });
      await ownerDataSource.initialize();
      this.backfill.ownerDataSource = ownerDataSource;
      try {
        report.apply = [];
        for (const ctx of candidates) {
          try {
            const result = await this.backfill.apply(ctx);
            report.apply.push(result);
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
        await ownerDataSource.destroy();
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
