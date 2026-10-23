import { QueryRunner } from 'typeorm';

/**
 * FROZEN with migration HwsHistoricalRowsPrivilegedCopy1786719520000 (owner decision 2026-10-22, "Option 1: one-off
 * approved copy"). The ONLY code that writes the PRIVILEGED_COPY_TABLES rows into workspace schemas. It runs inside the
 * guarded migration runner, as the migration identity, in the migration's own transaction, and it:
 *   - refuses unless the connecting role is RLS-exempt (superuser or BYPASSRLS). It never creates a policy, grant,
 *     function, GUC bypass or role; FORCE RLS and every runtime privilege stay exactly as they were;
 *   - copies historical rows of the payroll family + shift_staff_review from core into the workspace schema chosen by
 *     the AUTHORITATIVE owner of each row (`core.<table>.workspace_id` → that workspace's registry schema), preserving
 *     every column (ids, money, statuses, approvals, timestamps at full precision) via jsonb_populate_record;
 *   - is idempotent: `ON CONFLICT DO NOTHING`, then a full verification — re-running copies nothing and passes;
 *   - VERIFIES ALL 21 workspace tables of every processed workspace at full precision (canonical jsonb text, both
 *     directions, counts + keys + every column). ANY mismatch raises and rolls the whole migration back — nothing is
 *     forced through (owner requirement 12). FK and CHECK constraints are enforced by PostgreSQL on every inserted row;
 *   - writes one audit_log row per workspace (`workspace.hws_backfill_privileged_copy`) recording what was copied and the
 *     AUTHORITATIVE per-table counts. `hws:backfill --verify` compares what it can see against those counts and fails
 *     on any difference (the under-count guard);
 *   - never modifies or deletes a core row (owner requirement 10).
 * A workspace that has core business rows but was never run through `hws:backfill --apply` (no checkpoint rows) is
 * SKIPPED and audited as skipped — its tool-owned tables are not in place yet, so verifying it would only fail; the
 * runtime tool's verify keeps failing for it (no census) until a new privileged step is approved for that environment.
 */

/** Deferred tables, in FK-safe order (their FK children are all inside this list). */
export const PRIVILEGED_COPY_ORDER = ['payroll_run', 'payslip', 'payslip_document', 'shift_staff_review', 'payroll_record', 'payroll_run_line'] as const;

/** All 21 workspace tables (WORKSPACE_TABLES as of 1786719520000). user_note is mapped by subject, as in hws:backfill. */
export const PRIVILEGED_VERIFY_TABLES = [
  'staff_profile', 'user_note', 'venue', 'venue_manager_staff', 'job_role', 'venue_role_rate', 'manager_venue', 'shift',
  'shift_request_staff', 'shift_assignment', 'job_offer', 'replacement_request', 'attendance', 'attendance_correction', 'shift_report', 'shift_staff_review',
  'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
] as const;

export const PRIVILEGED_COPY_AUDIT_ACTION = 'workspace.hws_backfill_privileged_copy';
export const PRIVILEGED_COPY_SKIPPED_AUDIT_ACTION = 'workspace.hws_backfill_privileged_copy_skipped';

export interface PrivilegedCopyWorkspaceResult {
  workspaceId: string;
  schema: string;
  outcome: 'copied-and-verified' | 'skipped-not-backfilled';
  copied: Record<string, number>;
  trueCounts: Record<string, number>;
}

const SCHEMA_RE = /^workspace_[0-9a-f]{32}$/;
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** core-side rows for a workspace, shaped like the workspace table (user_note: mapped by subject, workspace_id merged). */
function coreRowsSql(table: string): string {
  if (table === 'user_note') {
    return `SELECT (to_jsonb(n) || jsonb_build_object('workspace_id', $1::uuid))::text AS j FROM core.user_note n
             WHERE n.subject_user_id IN (SELECT user_id FROM core.staff_profile WHERE workspace_id = $1
                                         UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1)`;
  }
  return `SELECT to_jsonb(c)::text AS j FROM core.${q(table)} c WHERE c.workspace_id = $1`;
}

export async function runHwsPrivilegedCopy(
  runner: QueryRunner,
  opts: { migrationName: string; workspaceIds?: readonly string[] },
): Promise<PrivilegedCopyWorkspaceResult[]> {
  const [{ exempt }] = (await runner.query(
    `SELECT (rolsuper OR rolbypassrls) AS exempt FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ exempt: boolean }>;
  if (!exempt) {
    throw new Error(
      `${opts.migrationName} refuses to run: the connecting role is neither SUPERUSER nor BYPASSRLS, so FORCE RLS would hide historical rows and the copy could not be verified. Run it with the approved migration identity; no policy or grant is added to work around this.`,
    );
  }

  const workspaces = (await runner.query(
    `SELECT w.id::text AS id, w.organisation_id::text AS org, r.schema_name AS schema
       FROM core.manager_workspace w JOIN core.workspace_schema_registry r ON r.workspace_id = w.id
      WHERE r.status = 'READY' AND w.schema_status = 'READY' AND ($1::uuid[] IS NULL OR w.id = ANY ($1::uuid[]))
      ORDER BY w.id`,
    [opts.workspaceIds ? [...opts.workspaceIds] : null],
  )) as Array<{ id: string; org: string; schema: string }>;

  const results: PrivilegedCopyWorkspaceResult[] = [];
  for (const ws of workspaces) {
    if (!SCHEMA_RE.test(ws.schema) || ws.schema !== `workspace_${ws.id.replace(/-/g, '')}`) {
      throw new Error(`${opts.migrationName}: registry schema for workspace ${ws.id} is not its canonical derived name; refusing.`);
    }

    // Authoritative counts (RLS-exempt identity sees every core row).
    const trueCounts: Record<string, number> = {};
    for (const table of PRIVILEGED_VERIFY_TABLES) {
      const [{ n }] = (await runner.query(`SELECT count(*)::int AS n FROM (${coreRowsSql(table)}) s`, [ws.id])) as Array<{ n: number }>;
      trueCounts[table] = n;
    }
    const coreRows = Object.values(trueCounts).reduce((a, b) => a + b, 0);
    const [{ backfilled }] = (await runner.query(
      `SELECT EXISTS (SELECT 1 FROM core.hws_backfill_checkpoint WHERE workspace_id = $1) AS backfilled`,
      [ws.id],
    )) as Array<{ backfilled: boolean }>;

    if (coreRows > 0 && !backfilled) {
      await runner.query(
        `INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata, entity_type, entity_id, created_at)
         VALUES (gen_random_uuid(), $1, NULL, $2, $3::jsonb, 'manager_workspace', $4, now())`,
        [ws.org, PRIVILEGED_COPY_SKIPPED_AUDIT_ACTION, JSON.stringify({ migration: opts.migrationName, reason: 'not backfilled by hws:backfill --apply yet', trueCounts }), ws.id],
      );
      results.push({ workspaceId: ws.id, schema: ws.schema, outcome: 'skipped-not-backfilled', copied: {}, trueCounts });
      continue;
    }

    // Copy the deferred tables (idempotent). PostgreSQL enforces every FK/CHECK (incl. <table>_workspace_bound).
    const copied: Record<string, number> = {};
    for (const table of PRIVILEGED_COPY_ORDER) {
      const res = (await runner.query(
        `WITH ins AS (
           INSERT INTO ${q(ws.schema)}.${q(table)}
           SELECT (jsonb_populate_record(NULL::${q(ws.schema)}.${q(table)}, to_jsonb(c))).*
             FROM core.${q(table)} c WHERE c.workspace_id = $1
           ON CONFLICT DO NOTHING RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
        [ws.id],
      )) as Array<{ n: number }>;
      copied[table] = res[0]!.n;
    }

    // Full-precision verification of ALL 21 tables, both directions. Any mismatch aborts the whole migration.
    const problems: string[] = [];
    for (const table of PRIVILEGED_VERIFY_TABLES) {
      const [row] = (await runner.query(
        `WITH a AS (${coreRowsSql(table)}),
              b AS (SELECT to_jsonb(t)::text AS j FROM ${q(ws.schema)}.${q(table)} t)
         SELECT (SELECT count(*) FROM a)::int AS core_n, (SELECT count(*) FROM b)::int AS ws_n,
                (SELECT count(*) FROM (SELECT j FROM a EXCEPT ALL SELECT j FROM b) x)::int AS missing,
                (SELECT count(*) FROM (SELECT j FROM b EXCEPT ALL SELECT j FROM a) x)::int AS extra`,
        [ws.id],
      )) as Array<{ core_n: number; ws_n: number; missing: number; extra: number }>;
      if (row!.core_n !== row!.ws_n || row!.missing !== 0 || row!.extra !== 0) {
        problems.push(`${table}: core=${row!.core_n} workspace=${row!.ws_n} missing_or_different=${row!.missing} extra_or_different=${row!.extra}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`${opts.migrationName}: workspace ${ws.id} does not match core at full precision — nothing was committed. ${problems.join('; ')}`);
    }

    await runner.query(
      `INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata, entity_type, entity_id, created_at)
       VALUES (gen_random_uuid(), $1, NULL, $2, $3::jsonb, 'manager_workspace', $4, now())`,
      [ws.org, PRIVILEGED_COPY_AUDIT_ACTION, JSON.stringify({ migration: opts.migrationName, copied, trueCounts, verified: 'full-precision, all 21 tables' }), ws.id],
    );
    results.push({ workspaceId: ws.id, schema: ws.schema, outcome: 'copied-and-verified', copied, trueCounts });
  }
  return results;
}

/** down(): removes ONLY the deferred-table rows that exist in core for that workspace (reverse FK order). Core is untouched. */
export async function undoHwsPrivilegedCopy(runner: QueryRunner): Promise<void> {
  const workspaces = (await runner.query(
    `SELECT w.id::text AS id, r.schema_name AS schema FROM core.manager_workspace w JOIN core.workspace_schema_registry r ON r.workspace_id = w.id`,
  )) as Array<{ id: string; schema: string }>;
  for (const ws of workspaces) {
    if (!SCHEMA_RE.test(ws.schema)) continue;
    for (const table of [...PRIVILEGED_COPY_ORDER].reverse()) {
      await runner.query(`DELETE FROM ${q(ws.schema)}.${q(table)} t WHERE t.id IN (SELECT c.id FROM core.${q(table)} c WHERE c.workspace_id = $1)`, [ws.id]);
    }
  }
}
