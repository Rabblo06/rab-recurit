import type { EntityManager } from 'typeorm';

import type { CycleLockWrapper, CycleOutcome, WorkerLoopOptions } from '../../core/runtime/worker-runtime';
import type { ProcessHandler, HandlerRegistry } from '../../core/scheduler/processor-explorer';
import { combinedShiftScanMemberDefs, CombinedShiftScanMember, ScanJobDefinition, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import type { WorkerJobDependencies } from '../../core/scheduler/worker-dependencies';
import { discoverMembersInWorkspaces, WalkMember, WalkResult } from '../../core/database/workspace-discovery';
import { discoverFinalTimesheetCandidates, FinalTimesheetCandidate, processFinalTimesheetCandidates } from '../rab-reports/final-timesheet.job';
import { discoverShiftReportCandidates, processShiftReportCandidates, ShiftReportCandidate } from '../rab-reports/shift-report-scheduler.job';
import { AttendanceMonitorScope, discoverAttendanceMonitorScopes, processAttendanceMonitorScopes } from './attendance-monitor.job';
import { discoverShiftMonitorInWorkspace, processShiftMonitorDiscoveries, ShiftMonitorDiscovery } from './shift-monitor.job';

/**
 * Phase D-Q4a — the combined shift scan (`WORKER_SHIFT_SCAN_MODE=combined`, default `separate`; owner approval 2026-11-04,
 * OD-1: the four 300-s scans only). docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §1.
 *
 * What changes: HOW the four scans find their work. Instead of four workspace walks (four `core.worker_list_workspaces`
 * page loops and four READ ONLY tenant transactions per workspace), one walk opens ONE READ ONLY tenant transaction per
 * workspace and runs each DUE member's own discovery query in it, each inside its own SAVEPOINT
 * (`discoverMembersInWorkspaces`).
 *
 * What does not change: each member's discovery SQL (the functions the separate scans call), its processing (the same
 * `process*` functions: one `runScopedForOrg` transaction per candidate, the same worker_event keys, compare-and-sets,
 * Pass A/B revalidation, notifications and audit records), its DataSource (the two report members take their per-shift
 * session advisory locks on the DIRECT DataSource, as in separate mode), its interval and its Health keys
 * (`last<Loop>At` / `<loop>Failures` / `<loop>Skipped`, duration metrics, scan ticks).
 *
 * Timing: the combined scan ticks at the greatest common divisor of the members' intervals (≥ 30 s, checked at boot); a
 * member is DUE on a tick when at least its own interval has passed since it last started here (half a tick of timer
 * jitter tolerated), so no member ever runs less often than in separate mode. With the defaults (all 300 s) every member is
 * due on every 300-s tick.
 *
 * Processing: after the walk, each member's processing runs as ITS OWN runtime cycle (`runtime.runOnce`), concurrently and
 * not awaited by the tick — exactly as the four separate scans run independently today. So a slow member (a long run of
 * report renders) never delays another member's next discovery, and a member whose previous processing is still running
 * is skipped for that tick only (`skipped-running`, counted in its own `<loop>Skipped`), exactly like the separate scan's
 * own overlap guard. Every interleaving this produces is one separate mode can already produce (independent timers), so
 * no outcome is new. Late clock-in stays its own scan, so the late-clock-in vs no-show order (OD-2) is not affected.
 *
 * Multi-replica: unchanged primitives. Interval mode runs the combined scan once per replica (as each scan today);
 * cross-replica correctness is the worker_event UNIQUE keys, the compare-and-sets and the per-shift advisory locks. Lane A
 * (`WORKER_SCHEDULER=bullmq`): one cluster scheduler and one scan lock for the combined scan (its walk); each member's
 * processing additionally takes that member's own scan lock when one is supplied (`memberLock`), so at most one replica
 * processes a given member at a time, as with the separate schedulers.
 */

/** One member as the combined scan runs it: its definition (name, stats keys, metric key) plus discover/process. */
export interface CombinedMember {
  def: ScanJobDefinition;
  /** The member's per-workspace discovery (the separate scan's own callback). */
  discover: (manager: EntityManager) => Promise<unknown[]>;
  /** The member's processing of everything its discovery found (the separate scan's own post-discovery code). */
  process: (found: unknown[]) => Promise<void>;
}

export interface CombinedShiftScanOptions {
  /** The member definitions, in registration order (default: COMBINED_SHIFT_SCAN_MEMBERS from SCAN_JOBS). */
  members?: readonly ScanJobDefinition[];
  /** discover/process of each member, built per tick (reads environment values at tick time, like the processors). */
  bind: () => ReadonlyMap<string, Pick<CombinedMember, 'discover' | 'process'>>;
  /** The shared walk (production: `discoverMembersInWorkspaces` on the runtime DataSource). */
  walk: (members: readonly WalkMember[]) => Promise<WalkResult>;
  intervalOf: (def: ScanJobDefinition) => number;
  tickMs: number;
  runtime: { runOnce(options: WorkerLoopOptions, lock?: CycleLockWrapper): Promise<CycleOutcome>; isRunning(name: string): boolean };
  /** Lane A: the member's own cross-replica scan lock, when the scheduler has one (undefined: run unlocked). */
  memberLock?: (schedulerId: string) => CycleLockWrapper | undefined;
  now?: () => number;
  logger?: { warn(message: string): void };
}

export interface CombinedTickReport {
  due: string[];
  skippedRunning: string[];
  discovered: string[];
  failed: string[];
  /** The member cycles started by this tick (settle independently; tests await them). */
  started: Promise<CycleOutcome>[];
}

export class CombinedShiftScan {
  private readonly members: readonly ScanJobDefinition[];
  private readonly lastStartedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: CombinedShiftScanOptions) {
    this.members = options.members ?? combinedShiftScanMemberDefs();
    this.now = options.now ?? Date.now;
  }

  /** Due when at least the member's own interval (minus half a tick of timer jitter) has passed since it last started. */
  isDue(def: ScanJobDefinition, now: number): boolean {
    const last = this.lastStartedAt.get(def.jobName);
    return last === undefined || now - last >= this.options.intervalOf(def) - this.options.tickMs / 2;
  }

  /** The cycle registered as `shift-scan-combined`. False (idle) when no member was discovered on this tick. */
  async run(): Promise<boolean> {
    const report = await this.tick();
    return report.discovered.length + report.failed.length > 0;
  }

  async tick(): Promise<CombinedTickReport> {
    const now = this.now();
    const due = this.members.filter((def) => this.isDue(def, now));
    const report: CombinedTickReport = { due: due.map((d) => d.jobName), skippedRunning: [], discovered: [], failed: [], started: [] };
    if (!due.length) return report;
    const bound = this.options.bind();
    const toDiscover: ScanJobDefinition[] = [];
    for (const def of due) {
      this.lastStartedAt.set(def.jobName, now);
      if (this.options.runtime.isRunning(def.name)) {
        // Per-member overlap guard. `runOnce` checks `running` synchronously before any await, so this call is
        // guaranteed to return `skipped-running` (counted in the member's own <loop>Skipped and metrics) without running.
        report.skippedRunning.push(def.jobName);
        report.started.push(this.options.runtime.runOnce(this.loopOf(def, () => Promise.reject(new Error(`${def.name}: overlap guard bypassed`)))));
        continue;
      }
      toDiscover.push(def);
    }
    if (!toDiscover.length) return report;

    const walk = await this.options.walk(toDiscover.map((def) => ({ key: def.jobName, discover: bound.get(def.jobName)!.discover })));

    for (const def of toDiscover) {
      const result = walk.members.get(def.jobName);
      const member = bound.get(def.jobName)!;
      let run: () => Promise<void>;
      if (result?.ok) {
        report.discovered.push(def.jobName);
        const found = result.rows;
        run = () => member.process(found);
      } else {
        // The member's discovery failed (its own query, or the walk): its cycle fails exactly like the separate scan's
        // would — `<loop>Failures` + 1, `<name> cycle failed` logged, nothing processed — and it is retried next time due.
        report.failed.push(def.jobName);
        const error = result ? result.error : new Error(`${def.name}: no discovery result`);
        run = () => Promise.reject(error);
      }
      const lock = this.options.memberLock?.(schedulerIdOf(def));
      report.started.push(this.options.runtime.runOnce(this.loopOf(def, run), lock));
    }
    if (walk.walkError !== null) {
      // The walk itself failed (catalogue page, workspace transaction): also the combined scan's own failure.
      throw walk.walkError;
    }
    return report;
  }

  private loopOf(def: ScanJobDefinition, run: () => Promise<void>): WorkerLoopOptions {
    return { name: def.name, intervalMs: this.options.intervalOf(def), statKeys: def.statKeys, metricKey: def.jobName, run: () => run() };
  }
}

/**
 * Production binding of the four members: the SAME discovery and processing functions the separate cycles call, with the
 * same DataSources (the two report members get the DIRECT DataSource for their session advisory locks, exactly as
 * report.processors.ts passes it) and the same log lines as shift.processors.ts / report.processors.ts.
 */
export function bindCombinedShiftScanMembers(deps: WorkerJobDependencies): Map<CombinedShiftScanMember, Pick<CombinedMember, 'discover' | 'process'>> {
  const { directDataSource, tenantContext, notificationService, auditService, attendanceQrService, qrImageService, emailOutboxService, fileService, environmentService, logger } =
    deps;
  const clockInEarlyMinutes = environmentService.get('CLOCK_IN_EARLY_MINUTES');
  const reportAvailableBeforeMinutes = environmentService.get('REPORT_AVAILABLE_BEFORE_MINUTES');
  return new Map<CombinedShiftScanMember, Pick<CombinedMember, 'discover' | 'process'>>([
    [
      'shift-monitor',
      {
        discover: discoverShiftMonitorInWorkspace,
        process: async (found) => {
          const result = await processShiftMonitorDiscoveries(tenantContext, { notificationService, auditService }, clockInEarlyMinutes, found as ShiftMonitorDiscovery[]);
          if (result.remindersSent || result.noShowsFlagged) {
            logger.log(`shift monitor: reminders=${result.remindersSent} noShows=${result.noShowsFlagged}`);
          }
        },
      },
    ],
    [
      'attendance-monitor',
      {
        discover: discoverAttendanceMonitorScopes,
        process: async (found) => {
          const result = await processAttendanceMonitorScopes(tenantContext, { notificationService, auditService }, found as AttendanceMonitorScope[]);
          if (result.flagged) logger.log(`attendance monitor: flagged=${result.flagged}`);
        },
      },
    ],
    [
      'shift-report-scheduler',
      {
        discover: (manager) => discoverShiftReportCandidates(manager, reportAvailableBeforeMinutes),
        process: async (found) => {
          const result = await processShiftReportCandidates(
            directDataSource,
            tenantContext,
            attendanceQrService,
            qrImageService,
            emailOutboxService,
            fileService,
            found as ShiftReportCandidate[],
            auditService,
          );
          if (result.generated || result.failed) {
            logger.log(`shift report scheduler: generated=${result.generated} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
          }
        },
      },
    ],
    [
      'final-timesheet',
      {
        discover: discoverFinalTimesheetCandidates,
        process: async (found) => {
          const result = await processFinalTimesheetCandidates(directDataSource, tenantContext, emailOutboxService, fileService, found as FinalTimesheetCandidate[], auditService);
          if (result.sent || result.failed) {
            logger.log(`final timesheet: sent=${result.sent} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
          }
        },
      },
    ],
  ]);
}

/** main.ts (combined mode only): the production CombinedShiftScan on the runtime DataSource's shared walk. */
export function createCombinedShiftScan(
  deps: () => WorkerJobDependencies,
  options: Pick<CombinedShiftScanOptions, 'intervalOf' | 'tickMs' | 'runtime' | 'memberLock'>,
): CombinedShiftScan {
  return new CombinedShiftScan({
    ...options,
    bind: () => bindCombinedShiftScanMembers(deps()),
    walk: (members) => {
      const { runtimeDataSource, tenantContext } = deps();
      return discoverMembersInWorkspaces(runtimeDataSource, tenantContext, members);
    },
  });
}

/**
 * Wraps the handler registry (as withGlobalDispatch does) so `shift-scan-combined` runs the combined scan. Every other
 * scan's handler is unchanged. Installed by main.ts only in combined mode.
 */
export function withCombinedShiftScan(registry: HandlerRegistry, combined: Pick<CombinedShiftScan, 'run'>): HandlerRegistry {
  return {
    handlers: registry.handlers,
    get: registry.get,
    scan: (def: ScanJobDefinition): ProcessHandler => (def.jobName === COMBINED_SHIFT_SCAN_JOB ? () => combined.run() : registry.scan(def)),
  };
}

export const COMBINED_SHIFT_SCAN_JOB = 'shift-scan-combined';
