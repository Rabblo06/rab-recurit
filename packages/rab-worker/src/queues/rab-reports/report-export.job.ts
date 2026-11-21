import { NotificationType, NotificationTypeType, REPORT_EXPORT_MAX_ATTEMPTS, REPORT_EXPORT_MAX_BYTES, REPORT_LABELS, ReportExportError, ReportExportErrorType } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

// The ONE rab-server import of this job (import-boundary ratchet, worker-deep-import): the report builders. The
// collaborators below are typed structurally so the job adds no other edge; the processor passes the real services.
import { buildReportCsv, ReportExportJob } from '@rab/server/modules/reports/services/report-builders';
import { runScopedForOrg } from '../../core/database/scoped-job';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { isNotYetRoutableWorkspace } from '../../core/database/workspace-routing';

type TenantContextService = Parameters<typeof runScopedForOrg>[0];

/** The slice of rab-server's notification service this job uses. */
export interface ReportExportNotifier {
  notify(
    manager: EntityManager,
    params: { organisationId: string; userId: string; type: NotificationTypeType; title: string; message: string; relatedEntityType?: string; relatedEntityId?: string },
  ): Promise<void>;
}

/** The slice of rab-server's audit service this job uses (actions are the `report_export.*` values of AuditAction). */
export interface ReportExportAuditor {
  record(
    manager: EntityManager,
    ctx: { organisationId: string; userId: string },
    action: 'report_export.ready' | 'report_export.failed' | 'report_export.file_deleted',
    opts: { entityType: string; entityId: string; targetUserId?: string; metadata?: Record<string, unknown>; actorUserId?: string | null },
  ): Promise<void>;
}

/** Rows handled per workspace per cycle (the rest wait for the next cycle, every 15 s by default). */
const BATCH_PER_WORKSPACE = 10;
/** Upper bound on each of one export's queries (a period of up to 366 days); transaction-local, so it ends with the build. */
const BUILD_STATEMENT_TIMEOUT = '120s';

interface DueRow {
  id: string;
  organisation_id: string;
  workspace_id: string;
  due: 'build' | 'delete';
}

export interface ReportExportCycleResult {
  built: number;
  failed: number;
  retried: number;
  deleted: number;
}

export interface ReportExportCycleOptions {
  lateGraceMinutes: number;
  organisationId?: string;
}

/**
 * Owner decision 29: the Worker half of the reports export.
 *
 *  - DISCOVER: per workspace (the Worker's own binding, rab.actor_type = 'worker', the report_export_worker_* policies),
 *    pending exports, and ready exports whose file is due for deletion (24 h after it was ready).
 *  - BUILD: one transaction per export. `FOR UPDATE SKIP LOCKED` on a still-pending row is the cross-replica claim (a
 *    second Worker skips it; a crash rolls back and the row stays pending). The CSV is built inside a savepoint from the
 *    requester's STORED, already-checked decision (scope, venue, pay / hours columns); on an error the savepoint is
 *    rolled back and the attempt counted, and after REPORT_EXPORT_MAX_ATTEMPTS the export is marked failed. A CSV over
 *    REPORT_EXPORT_MAX_BYTES fails as `too_large` (no retry). On success: ready, the file kept until ready_at + 24 h, an
 *    in-app notice to the requester, an audit row. Never a download link: only the requester's own session issues one.
 *  - DELETE: the file content is removed (status expired); the row and its audit trail stay.
 * The database guard (`core.report_export_guard()`) refuses any other status move and any Worker change to a link.
 */
export async function runReportExportCycle(
  runtimeDataSource: DataSource,
  tenantContext: TenantContextService,
  notifications: ReportExportNotifier,
  audit: ReportExportAuditor,
  options: ReportExportCycleOptions,
): Promise<ReportExportCycleResult> {
  const due = await discoverInWorkspaces(
    runtimeDataSource,
    tenantContext,
    (m) =>
      m.query<DueRow[]>(
        `SELECT id, organisation_id, workspace_id, CASE WHEN status = 'pending' THEN 'build' ELSE 'delete' END AS due
           FROM core.report_export
          WHERE organisation_id = core.current_org() AND workspace_id = core.current_workspace()
            AND (status = 'pending' OR (status = 'ready' AND file_expires_at <= now()))
          ORDER BY created_at, id
          LIMIT ${BATCH_PER_WORKSPACE}`,
      ),
    options.organisationId,
  );

  const result: ReportExportCycleResult = { built: 0, failed: 0, retried: 0, deleted: 0 };
  for (const row of due) {
    try {
      const outcome = await runScopedForOrg(tenantContext, row.organisation_id, row.workspace_id, (m) =>
        row.due === 'build' ? buildOne(m, row.id, notifications, audit, options) : deleteOne(m, row.id, audit),
      );
      if (outcome) result[outcome] += 1;
    } catch (error) {
      // A workspace blocked by a failed upgrade step pauses; its exports are handled once it is routable again.
      if (isNotYetRoutableWorkspace(error)) continue;
      throw error;
    }
  }
  return result;
}

async function buildOne(
  m: EntityManager,
  id: string,
  notifications: ReportExportNotifier,
  audit: ReportExportAuditor,
  options: ReportExportCycleOptions,
): Promise<keyof ReportExportCycleResult | null> {
  const [job] = await m.query<Array<ReportExportJob & { attempts: number }>>(
    `SELECT id, organisation_id, workspace_id, requested_by, report_key, to_char(period_from, 'YYYY-MM-DD') AS period_from,
            to_char(period_to, 'YYYY-MM-DD') AS period_to, venue_id, payroll_run_id, include_pay, include_hours, scope_kind,
            scope_owner_user_id, scope_venue_ids, attempts
       FROM core.report_export
      WHERE id = $1 AND status = 'pending'
      FOR UPDATE SKIP LOCKED`,
    [id],
  );
  if (!job) return null; // another replica holds it, or it is no longer pending

  await m.query('SAVEPOINT report_export_build');
  let built: { csv: string; rowCount: number } | null = null;
  let errorCode: ReportExportErrorType | null = null;
  try {
    await m.query(`SET LOCAL statement_timeout = '${BUILD_STATEMENT_TIMEOUT}'`);
    built = await buildReportCsv(m, job, { lateGraceMinutes: options.lateGraceMinutes });
    await m.query('RELEASE SAVEPOINT report_export_build');
  } catch (error) {
    await m.query('ROLLBACK TO SAVEPOINT report_export_build');
    errorCode = (error as { status?: number })?.status === 404 ? ReportExportError.NOT_FOUND : ReportExportError.BUILD_FAILED;
  }

  if (built) {
    const bytes = Buffer.byteLength(built.csv, 'utf8');
    if (bytes > REPORT_EXPORT_MAX_BYTES) {
      await fail(m, job, ReportExportError.TOO_LARGE, audit);
      return 'failed';
    }
    await m.query(
      `UPDATE core.report_export
          SET status = 'ready', csv_content = $2, csv_bytes = $3, row_count = $4, ready_at = now(), file_expires_at = now() + interval '24 hours'
        WHERE id = $1 AND status = 'pending'`,
      [job.id, built.csv, bytes, built.rowCount],
    );
    await notifications.notify(m, {
      organisationId: job.organisation_id,
      userId: job.requested_by,
      type: NotificationType.REPORT_EXPORT_READY,
      title: 'Your report is ready',
      message: `${REPORT_LABELS[job.report_key]} is ready to download. The file is deleted after 24 hours.`,
      relatedEntityType: 'report_export',
      relatedEntityId: job.id,
    });
    await audit.record(m, { organisationId: job.organisation_id, userId: '' }, 'report_export.ready', {
      entityType: 'report_export',
      entityId: job.id,
      targetUserId: job.requested_by,
      metadata: { reportKey: job.report_key, rowCount: built.rowCount, bytes },
      actorUserId: null,
    });
    return 'built';
  }

  // A missing payroll run never appears later: no retry. Anything else is retried up to the limit.
  if (errorCode === ReportExportError.NOT_FOUND || job.attempts + 1 >= REPORT_EXPORT_MAX_ATTEMPTS) {
    await fail(m, job, errorCode ?? ReportExportError.BUILD_FAILED, audit);
    return 'failed';
  }
  await m.query(`UPDATE core.report_export SET attempts = attempts + 1 WHERE id = $1 AND status = 'pending'`, [job.id]);
  return 'retried';
}

async function fail(m: EntityManager, job: ReportExportJob & { attempts: number }, errorCode: ReportExportErrorType, audit: ReportExportAuditor): Promise<void> {
  await m.query(
    `UPDATE core.report_export SET status = 'failed', error_code = $2, attempts = LEAST(attempts + 1, $3) WHERE id = $1 AND status = 'pending'`,
    [job.id, errorCode, REPORT_EXPORT_MAX_ATTEMPTS],
  );
  await audit.record(m, { organisationId: job.organisation_id, userId: '' }, 'report_export.failed', {
    entityType: 'report_export',
    entityId: job.id,
    targetUserId: job.requested_by,
    metadata: { reportKey: job.report_key, errorCode },
    actorUserId: null,
  });
}

async function deleteOne(m: EntityManager, id: string, audit: ReportExportAuditor): Promise<keyof ReportExportCycleResult | null> {
  const [rows] = (await m.query(
    `UPDATE core.report_export SET status = 'expired', csv_content = NULL, file_deleted_at = now()
      WHERE id = $1 AND status = 'ready' AND file_expires_at <= now()
      RETURNING organisation_id, requested_by, report_key`,
    [id],
  )) as [Array<{ organisation_id: string; requested_by: string; report_key: string }>, number];
  const row = rows[0];
  if (!row) return null;
  await audit.record(m, { organisationId: row.organisation_id, userId: '' }, 'report_export.file_deleted', {
    entityType: 'report_export',
    entityId: id,
    targetUserId: row.requested_by,
    metadata: { reportKey: row.report_key },
    actorUserId: null,
  });
  return 'deleted';
}
