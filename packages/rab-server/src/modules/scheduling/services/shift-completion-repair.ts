import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { completeShiftIfSettled, OPEN_SEAT_STATUSES, openSeatSql } from '../utils/complete-shift-if-settled';

/**
 * ONE-OFF REPAIR (owner decision 2026-11-06, Q3) for shifts left `in_progress` before the completion roll-up ran after
 * every seat close (fix/shift-completion-after-withdrawal) and before an expired offer's seat counted as closed
 * (fix/shift-completion-expired-seat). Driven only by the `shift:complete-settled` CLI command; it never runs on its own
 * (no job, no schedule, no endpoint).
 *
 *  - `list` is READ-ONLY: per workspace, inside that tenant's context (SET LOCAL + FORCE RLS) and a READ ONLY
 *    transaction, the `in_progress` shifts that `completeShiftIfSettled` WOULD complete — the same open-seat predicate
 *    (`openSeatSql`), not a copy — with their seat breakdown.
 *  - `apply` completes ONLY the ids it is given: each id is located in the trusted workspace registry
 *    (`core.worker_list_workspaces`), then completed by `completeShiftIfSettled` itself in its own tenant transaction
 *    (shift row lock, the predicate re-checked under it, `assertTransition`, compare-and-set), so an id that is not
 *    settled any more — or never was — is refused, and a repeat run changes nothing. Every completion is audited
 *    (`shift.completed_by_repair`) in the same transaction, naming the platform-admin actor.
 * No new state or transition; the seat rows are never written.
 */

export interface SettledShiftRow {
  organisationId: string;
  workspaceId: string;
  shiftId: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  /** Seat states on the shift, by state (an `offered` seat here always has only expired offers). */
  seats: Record<string, number>;
}

export type RepairOutcome = 'completed' | 'already_completed' | 'not_settled' | 'not_found';

export interface RepairResult {
  shiftId: string;
  outcome: RepairOutcome;
  organisationId?: string;
  workspaceId?: string;
}

interface Scope {
  organisation_id: string;
  workspace_id: string;
}

const PAGE = 100;

/**
 * A workspace listed by the registry but not routable yet (still being provisioned: `registry-missing` / `not-ready`) has
 * no workspace-schema rows, so it is skipped and counted — the same two codes the Worker's walks skip
 * (rab-worker workspace-routing.ts; duck-typed, the server cannot import the Worker). Every other refusal is rethrown.
 */
function isNotYetRoutable(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'WorkspaceRoutingError') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'registry-missing' || code === 'not-ready';
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An ids file larger than this is refused: a one-off repair is reviewed row by row, not bulk-applied. */
export const MAX_REPAIR_IDS = 5000;

/** Parses an ids file: one shift UUID per line; blank lines and `#` comments ignored; anything else refuses the whole file. */
export function parseRepairIds(text: string): string[] {
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    if (!UUID.test(line)) throw new Error(`ids file line ${index + 1} is not a shift UUID; refusing the whole file`);
    ids.add(line.toLowerCase());
  });
  if (ids.size === 0) throw new Error('ids file holds no shift id; refusing');
  if (ids.size > MAX_REPAIR_IDS) throw new Error(`ids file holds ${ids.size} ids (more than ${MAX_REPAIR_IDS}); refusing`);
  return [...ids];
}

export class ShiftCompletionRepair {
  /** Workspaces skipped by the last list / apply because they were not routable yet (see `isNotYetRoutable`). */
  skippedWorkspaces = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
  ) {}

  /** Fail closed: the session must not be a superuser or RLS-exempt (the boot gates check the same; this is layer 2). */
  async assertRestrictedSession(): Promise<void> {
    const [row] = await this.dataSource.query<Array<{ exempt: boolean }>>(
      `SELECT (r.rolsuper OR r.rolbypassrls) AS exempt FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    );
    if (!row || row.exempt) throw new Error('refused: shift:complete-settled must run as the restricted runtime login, never a superuser or BYPASSRLS role');
  }

  private async *scopes(organisationId?: string): AsyncGenerator<Scope> {
    let after: string | null = null;
    for (;;) {
      const page: Scope[] = await this.dataSource.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [after, PAGE]);
      if (!page.length) return;
      for (const scope of page) if (!organisationId || scope.organisation_id === organisationId) yield scope;
      after = page[page.length - 1]!.workspace_id;
    }
  }

  private context(scope: Scope, userId = '') {
    return { organisationId: scope.organisation_id, workspaceId: scope.workspace_id, userId, role: '' };
  }

  /** A read in one workspace's tenant context; null when that workspace is not routable yet (skipped and counted). */
  private async readIn<T>(scope: Scope, fn: (m: EntityManager) => Promise<T>): Promise<T | null> {
    try {
      return await this.tenantContext.runInTenantContext(this.context(scope), async (m: EntityManager) => {
        await m.query('SET TRANSACTION READ ONLY');
        return fn(m);
      });
    } catch (error) {
      if (!isNotYetRoutable(error)) throw error;
      this.skippedWorkspaces += 1;
      return null;
    }
  }

  /** READ-ONLY. Every in_progress shift the roll-up would complete, per workspace, in that tenant's context. */
  async list(opts: { organisationId?: string } = {}): Promise<SettledShiftRow[]> {
    await this.assertRestrictedSession();
    this.skippedWorkspaces = 0;
    const out: SettledShiftRow[] = [];
    for await (const scope of this.scopes(opts.organisationId)) {
      const rows = await this.readIn(scope, (m) =>
        m.query<Array<{ id: string; venue_name: string; starts_at: Date; ends_at: Date; seats: Record<string, number> | null }>>(
          // sql-injection-reviewed: openSeatSql(2) is a code-constant fragment (integer parameter index); values are bound $n parameters.
          `SELECT s.id, v.name AS venue_name, s.starts_at, s.ends_at,
                  (SELECT jsonb_object_agg(b.status, b.n) FROM (SELECT sa2.status, count(*)::int AS n FROM shift_assignment sa2
                     WHERE sa2.shift_id = s.id GROUP BY sa2.status) b) AS seats
             FROM shift s JOIN venue v ON v.id = s.venue_id
            WHERE s.status = 'in_progress' AND s.organisation_id = $1
              AND NOT EXISTS (SELECT 1 FROM shift_assignment sa WHERE sa.shift_id = s.id AND sa.organisation_id = $1 AND ${openSeatSql(2)})
            ORDER BY s.ends_at, s.id`,
          [scope.organisation_id, OPEN_SEAT_STATUSES],
        ),
      );
      for (const r of rows ?? []) {
        out.push({
          organisationId: scope.organisation_id,
          workspaceId: scope.workspace_id,
          shiftId: r.id,
          venueName: r.venue_name,
          startsAt: new Date(r.starts_at).toISOString(),
          endsAt: new Date(r.ends_at).toISOString(),
          seats: r.seats ?? {},
        });
      }
    }
    return out;
  }

  /**
   * Completes ONLY `shiftIds`, each re-checked by `completeShiftIfSettled` in its own tenant transaction, audited with
   * `actorUserId` (an ACTIVE platform admin, resolved by the caller). An id found in no workspace (in `organisationId`
   * when given) is `not_found` and nothing happens.
   */
  async apply(shiftIds: readonly string[], actor: { userId: string; changeRef?: string }, opts: { organisationId?: string } = {}): Promise<RepairResult[]> {
    await this.assertRestrictedSession();
    if (!actor.userId) throw new Error('refused: --apply needs a platform-admin actor');
    this.skippedWorkspaces = 0;
    const pending = new Set(shiftIds.map((id) => id.toLowerCase()));
    const results: RepairResult[] = [];
    for await (const scope of this.scopes(opts.organisationId)) {
      if (pending.size === 0) break;
      const here = await this.readIn(scope, async (m) =>
        (await m.query<Array<{ id: string }>>(`SELECT id FROM shift WHERE id = ANY($1::uuid[]) AND organisation_id = $2`, [[...pending], scope.organisation_id])).map((r) => r.id),
      );
      for (const shiftId of here ?? []) {
        pending.delete(shiftId);
        const outcome = await this.tenantContext.runInTenantContext(this.context(scope, actor.userId), async (m: EntityManager): Promise<RepairOutcome> => {
          if (await completeShiftIfSettled(m, scope.organisation_id, shiftId)) {
            await this.auditService.record(m, { organisationId: scope.organisation_id, userId: actor.userId }, AuditAction.SHIFT_COMPLETED_BY_REPAIR, {
              entityType: 'shift',
              entityId: shiftId,
              metadata: { source: 'cli:shift:complete-settled', previousStatus: 'in_progress', changeRef: actor.changeRef ?? null },
              actorUserId: actor.userId,
            });
            return 'completed';
          }
          const [row] = await m.query<Array<{ status: string }>>(`SELECT status FROM shift WHERE id = $1 AND organisation_id = $2`, [shiftId, scope.organisation_id]);
          return row?.status === 'completed' ? 'already_completed' : 'not_settled';
        });
        results.push({ shiftId, outcome, organisationId: scope.organisation_id, workspaceId: scope.workspace_id });
      }
    }
    for (const shiftId of pending) results.push({ shiftId, outcome: 'not_found' });
    return results;
  }
}
