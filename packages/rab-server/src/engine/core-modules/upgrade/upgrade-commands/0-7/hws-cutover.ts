/**
 * OWNER-DB-ULTIMATE Part C3: the HWS cutover, an INSTANCE upgrade command in Part B's logbook (one row when it ends:
 * completed, or failed with attempt + 1; a crash leaves no row and the next start runs it again). Option A′ — PENDING OWNER
 * CHOICE (A′ vs B′) AND SQL REVIEW: it calls the core.hws_cutover_* functions of HwsCutoverCopyFunctions1786721510000.
 *
 * Twenty (twentyhq/twenty @ eedb0a73) keeps each workspace's data only in its own schema and runs upgrades one workspace at
 * a time (`workspace-command-runner.service.ts:106-153`); it has no legacy shared tables to move, so the copy itself is a
 * Crewflow addition (§0: RLS stays).
 *
 * Not a Part D WORKSPACE command: the workspace runner refuses any catalog or row write outside the target schema
 * (D-RUNNER.md §4.1), and this step writes core rows (the registry block marker, core.hws_cutover_state, audit_log, the
 * dispatch pointers).
 *
 * One run, on the locked migration session (each statement group in its own short transaction, role crewflow, tenant bound
 * to exactly one workspace, search_path pg_catalog). Per-workspace state lives in core.hws_cutover_state (started →
 * verified; crewflow-owned, no runtime DML — security review L-2), never in audit_log (written as a human-readable record):
 *   0. HWS runtime OFF and any workspace not yet verified → refuse (HWS_RUNTIME_OFF), nothing written: the core copies stay
 *      served; the first start with HWS on does the cutover.
 *   1. BLOCK FIRST (review H-1): every pending READY workspace not blocked by another step gets the Part D marker
 *      `upgrade-blocked: HwsCutover (HWS_CUTOVER_PENDING)` → 503 "workspace is being upgraded", Worker jobs paused; the
 *      resolver cache epoch is bumped right away (review L-4, fatal on failure). Any later error re-blocks the pending
 *      workspaces before it propagates.
 *   2. Probe each (core rows of W? rows already in W's schema? core rows of W carrying another organisation? ambiguous
 *      notes?). No core data at all → state 'verified', audit record, block lifted at once (its schema is authoritative).
 *   3. Anything to copy → a verified backup marker is required (hws-cutover-backup.ts), else refuse (NO_BACKUP): nothing is
 *      copied, the workspaces with core data stay blocked.
 *   4. Per workspace: refuse ORG_MISMATCH / USER_NOTE_AMBIGUOUS / BOTH_POPULATED (rows in its schema although no copy of ours
 *      ever started: written by HWS-on serving; never merged); else state 'started' (the core write fence, the resolver and
 *      the HWS-off boot refusal key off it), keyset copy in FK order (ON CONFLICT DO NOTHING: idempotent, resumable after a
 *      kill), statement pointers of the rows each batch inserted reconciled in that batch (Q13 / review M-1); then verify
 *      every table by key range (row counts, rows both directions, md5 checksum, money and worked-minute totals, column
 *      gaps, no NOT VALID constraint beyond the known one). Verified → state 'verified', audit record, its core-source
 *      statement pointers purged, its block LIFTED straight away (review M-2). Failed → it stays blocked with the class.
 *   5. Any workspace failed or refused (including not-READY ones and ones blocked by another step) → the step fails (warn and
 *      serve, exit 70); the others are already served from their schemas. The next start retries only the unverified ones.
 * The core copies are never written. attendance_correction is only ever INSERTed. Money never passes through a JS number and
 * is never logged or audited per workspace (review Info-4: only checksums are recorded).
 */
import type { Query } from '../../upgrade-migration.service';
import type { UpgradeCommand, UpgradeCommandContext } from '../upgrade-command';
import { CutoverBackupMarker, verifyCutoverBackup } from './hws-cutover-backup';
import { HWS_CUTOVER_COPY_ORDER, HWS_CUTOVER_KNOWN_NOT_VALID, HWS_CUTOVER_TABLE_LIST } from './hws-cutover-tables';

export const HWS_CUTOVER_NAME = 'HwsCutover';
export const HWS_CUTOVER_TIMESTAMP = 1786721510100;
/** audit_log action of the human-readable record per verified workspace (never read back: the state table decides). */
export const HWS_CUTOVER_VERIFIED_ACTION = 'workspace.hws_cutover_verified';
/** Same format as workspace-upgrade-block.ts upgradeBlockMarker('HwsCutover', class) (hws-cutover.spec.ts proves it). */
export const HWS_CUTOVER_BLOCK_PREFIX = 'upgrade-blocked: HwsCutover (';
const ANY_BLOCK_PREFIX = 'upgrade-blocked: ';
export const HWS_CUTOVER_DEFAULT_BATCH = 5000;
const SCHEMA_RE = /^workspace_[0-9a-f]{32}$/;

export function hwsCutoverBlockMarker(errorClass: string): string {
  const cls = errorClass.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'UNKNOWN';
  return `${HWS_CUTOVER_BLOCK_PREFIX}${cls})`;
}

/** The whole step refused or failed. errorClass is a code label (the runner stores the message as-is in the logbook). */
export class HwsCutoverRefused extends Error {
  constructor(
    readonly errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = 'HwsCutoverRefused';
  }
}

export interface HwsCutoverWorkspace {
  workspaceId: string;
  organisationId: string;
  schemaName: string;
  registryStatus: string | null;
  registrySchema: string | null;
  migrationError: string | null;
  /** core.hws_cutover_state.state (null = no copy of ours ever started). */
  cutoverState: 'started' | 'verified' | null;
}

export interface WorkspaceCutoverOutcome {
  workspaceId: string;
  status: 'verified' | 'already-verified' | 'nothing-to-copy' | 'failed';
  errorClass?: string;
  problems?: string[];
  copied?: Record<string, number>;
}

export interface HwsCutoverReport {
  workspaces: WorkspaceCutoverOutcome[];
  backup: 'verified' | 'not-needed';
  unmappedNotes: number;
}

export interface HwsCutoverOptions {
  /** Rows per keyset batch (1..10,000; default 5,000). */
  batchSize?: number;
  /** Test seam (integration specs only, never from env): only these workspaces. */
  workspaceIds?: readonly string[];
  /** Test seam: after each committed copy batch (a kill / crash is injected here). */
  afterBatch?: (info: { workspaceId: string; table: string; batch: number }) => Promise<void>;
  /** Test seam: after the copy, before the verification of a workspace (a planted mismatch is injected here). */
  beforeVerify?: (workspaceId: string) => Promise<void>;
}

interface ProbeRow {
  table_name: string;
  core_rows: boolean;
  ws_rows: boolean;
  org_mismatch: number;
  ambiguous_notes: number;
  unmapped_notes: number;
}

interface VerifyRow {
  core_rows: number;
  ws_rows: number;
  missing: number;
  extra: number;
  last_key: string | null;
  core_md5: string;
  ws_md5: string;
  core_pence: string | null;
  ws_pence: string | null;
  core_minutes: string | null;
  ws_minutes: string | null;
  column_gap: string | null;
}

interface TableVerification {
  coreRows: number;
  wsRows: number;
  coreChecksum: string;
  problems: string[];
}

const derivedSchema = (workspaceId: string) => `workspace_${workspaceId.replace(/-/g, '')}`;
const ours = (marker: string | null) => typeof marker === 'string' && marker.startsWith(HWS_CUTOVER_BLOCK_PREFIX);
const blockedByOther = (marker: string | null) => typeof marker === 'string' && marker.startsWith(ANY_BLOCK_PREFIX) && !ours(marker);

/** A safe class for an unexpected error: the SQLSTATE or the error name (never the message). */
function errorClassOf(error: unknown): string {
  if (error instanceof HwsCutoverRefused) return error.errorClass;
  const code = (error as { code?: unknown })?.code;
  if (code === '55P03') return 'LOCK_TIMEOUT';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : 'INTERNAL';
}

/** A dead or unusable session (the connection is gone): the run cannot go on and must not pretend to record anything. */
function sessionLost(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03')) return true;
  const message = error instanceof Error ? error.message : '';
  return /Connection terminated|Client has encountered a connection error|not queryable|ECONNRESET/i.test(message);
}

/** Role crewflow (as the Part D runner's enterWorkspace, M-T2), search_path pg_catalog, tenant bound. Inside a transaction. */
async function enter(q: Query, organisationId: string, workspaceId: string): Promise<void> {
  const [r] = (await q(
    `SELECT (current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
             OR coalesce((SELECT x.rolsuper FROM pg_catalog.pg_roles x WHERE x.rolname = current_user), false)) AS allowed,
            EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow') AND pg_catalog.pg_has_role(current_user, 'crewflow', 'SET') AS can_set`,
  )) as Array<{ allowed: boolean; can_set: boolean }>;
  if (!r?.allowed) {
    if (!r?.can_set) throw new HwsCutoverRefused('NO_MIGRATION_ROLE', 'hws cutover: this session is neither crewflow nor able to SET ROLE crewflow');
    await q(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
  }
  await q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [organisationId, workspaceId]);
  await q('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))', [derivedSchema(workspaceId)]);
}

async function inTenant<T>(q: Query, organisationId: string, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  await q('BEGIN');
  try {
    await enter(q, organisationId, workspaceId);
    const result = await fn();
    await q('COMMIT');
    return result;
  } catch (error) {
    await q('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Every workspace (any status) in id order, with its registry row and its cutover state, read under its organisation. */
export async function scanCutoverWorkspaces(q: Query, only?: readonly string[]): Promise<HwsCutoverWorkspace[]> {
  const out: HwsCutoverWorkspace[] = [];
  let after: string | null = null;
  for (;;) {
    const page = (await q('SELECT workspace_id::text AS workspace_id, organisation_id::text AS organisation_id FROM core.worker_list_workspaces($1, 100)', [after])) as Array<{
      workspace_id: string;
      organisation_id: string;
    }>;
    for (const w of page) {
      if (only && !only.includes(w.workspace_id)) continue;
      const rows = (await inTenant(q, w.organisation_id, w.workspace_id, () =>
        q(
          `SELECT r.status, r.schema_name, r.migration_error,
                  (SELECT s.state FROM core.hws_cutover_state s WHERE s.workspace_id = $1::uuid) AS cutover_state
             FROM (SELECT 1) one LEFT JOIN core.workspace_schema_registry r ON r.workspace_id = $1::uuid`,
          [w.workspace_id],
        ),
      )) as Array<{ status: string | null; schema_name: string | null; migration_error: string | null; cutover_state: 'started' | 'verified' | null }>;
      const r = rows[0];
      out.push({
        workspaceId: w.workspace_id,
        organisationId: w.organisation_id,
        schemaName: derivedSchema(w.workspace_id),
        registryStatus: r?.status ?? null,
        registrySchema: r?.schema_name ?? null,
        migrationError: r?.migration_error ?? null,
        cutoverState: r?.cutover_state ?? null,
      });
    }
    if (page.length < 100) break;
    after = page[page.length - 1]!.workspace_id;
  }
  return out;
}

async function setBlock(q: Query, ws: HwsCutoverWorkspace, errorClass: string): Promise<void> {
  await inTenant(q, ws.organisationId, ws.workspaceId, () =>
    q('UPDATE core.workspace_schema_registry SET migration_error = $2 WHERE workspace_id = $1::uuid', [ws.workspaceId, hwsCutoverBlockMarker(errorClass)]),
  );
  ws.migrationError = hwsCutoverBlockMarker(errorClass);
}

async function liftBlock(q: Query, ws: HwsCutoverWorkspace): Promise<void> {
  await inTenant(q, ws.organisationId, ws.workspaceId, () =>
    q(`UPDATE core.workspace_schema_registry SET migration_error = NULL WHERE workspace_id = $1::uuid AND pg_catalog.starts_with(migration_error, $2)`, [
      ws.workspaceId,
      HWS_CUTOVER_BLOCK_PREFIX,
    ]),
  );
  ws.migrationError = null;
}

/** core.hws_cutover_state: 'started' (kept when already started) or 'verified'. Role crewflow (the runtime login is refused). */
async function setState(q: Query, ws: HwsCutoverWorkspace, state: 'started' | 'verified'): Promise<void> {
  await inTenant(q, ws.organisationId, ws.workspaceId, () =>
    state === 'started'
      ? q(
          `INSERT INTO core.hws_cutover_state (workspace_id, organisation_id, state) VALUES ($1::uuid, $2::uuid, 'started')
           ON CONFLICT (workspace_id) DO NOTHING`,
          [ws.workspaceId, ws.organisationId],
        )
      : q(
          `INSERT INTO core.hws_cutover_state (workspace_id, organisation_id, state, verified_at) VALUES ($1::uuid, $2::uuid, 'verified', pg_catalog.now())
           ON CONFLICT (workspace_id) DO UPDATE SET state = 'verified', verified_at = pg_catalog.now()`,
          [ws.workspaceId, ws.organisationId],
        ),
  );
  ws.cutoverState = state === 'started' && ws.cutoverState === 'verified' ? 'verified' : state;
}

async function copyWorkspace(q: Query, ws: HwsCutoverWorkspace, size: number, options: HwsCutoverOptions, log: (l: string) => void): Promise<Record<string, number>> {
  const copied: Record<string, number> = {};
  for (const table of HWS_CUTOVER_COPY_ORDER) {
    let after: string | null = null;
    let batch = 0;
    copied[table] = 0;
    for (;;) {
      const row = await inTenant(q, ws.organisationId, ws.workspaceId, async () => {
        const [r] = (await q('SELECT copied, read_rows, last_key, inserted_keys FROM core.hws_cutover_copy_batch($1::uuid, $2, $3, $4)', [ws.workspaceId, table, after, size])) as Array<{
          copied: number;
          read_rows: number;
          last_key: string | null;
          inserted_keys: string[] | null;
        }>;
        // Q13 / review M-1: the INSERT trigger gave copied approved records with no statement a workspace pointer due now; keep
        // only those whose core twin had one, and touch no pointer of any row this batch did not insert. Same transaction.
        if (table === 'payroll_record' && r!.inserted_keys?.length) {
          await q('SELECT core.hws_cutover_drop_new_statement_pointers($1::uuid, $2::uuid[]) AS n', [ws.workspaceId, r!.inserted_keys]);
        }
        return r!;
      });
      batch += 1;
      copied[table] += Number(row.copied);
      if (options.afterBatch) await options.afterBatch({ workspaceId: ws.workspaceId, table, batch });
      if (Number(row.read_rows) < size || row.last_key === null) break;
      after = row.last_key;
    }
  }
  log(`hws cutover: workspace ${ws.workspaceId}: copied ${Object.values(copied).reduce((a, b) => a + b, 0)} row(s)`);
  return copied;
}

async function verifyTable(q: Query, ws: HwsCutoverWorkspace, table: string, size: number): Promise<TableVerification> {
  const coreMd5: string[] = [];
  const wsMd5: string[] = [];
  const v: TableVerification = { coreRows: 0, wsRows: 0, coreChecksum: '', problems: [] };
  const sums = { corePence: [] as string[], wsPence: [] as string[], coreMinutes: [] as string[], wsMinutes: [] as string[] };
  let after: string | null = null;
  let missing = 0;
  let extra = 0;
  let gap: string | null = null;
  for (;;) {
    const r = await inTenant(q, ws.organisationId, ws.workspaceId, async () => {
      const rows = (await q('SELECT * FROM core.hws_cutover_verify_range($1::uuid, $2, $3, $4)', [ws.workspaceId, table, after, size])) as VerifyRow[];
      return rows[0]!;
    });
    v.coreRows += Number(r.core_rows);
    v.wsRows += Number(r.ws_rows);
    missing += Number(r.missing);
    extra += Number(r.extra);
    coreMd5.push(r.core_md5);
    wsMd5.push(r.ws_md5);
    if (r.core_pence !== null) sums.corePence.push(String(r.core_pence));
    if (r.ws_pence !== null) sums.wsPence.push(String(r.ws_pence));
    if (r.core_minutes !== null) sums.coreMinutes.push(String(r.core_minutes));
    if (r.ws_minutes !== null) sums.wsMinutes.push(String(r.ws_minutes));
    if (r.column_gap) gap = r.column_gap;
    if (r.last_key === null) break;
    after = r.last_key;
  }
  // Exact arithmetic and comparison in the database (numeric): money never passes through a JS number and is never logged.
  const [t] = (await q(
    `SELECT pg_catalog.md5(pg_catalog.array_to_string($1::text[], ',')) AS core_checksum,
            (SELECT pg_catalog.sum(x) FROM pg_catalog.unnest($2::numeric[]) x) IS NOT DISTINCT FROM (SELECT pg_catalog.sum(x) FROM pg_catalog.unnest($3::numeric[]) x) AS pence_equal,
            (SELECT pg_catalog.sum(x) FROM pg_catalog.unnest($4::numeric[]) x) IS NOT DISTINCT FROM (SELECT pg_catalog.sum(x) FROM pg_catalog.unnest($5::numeric[]) x) AS minutes_equal`,
    [coreMd5, sums.corePence, sums.wsPence, sums.coreMinutes, sums.wsMinutes],
  )) as Array<{ core_checksum: string; pence_equal: boolean; minutes_equal: boolean }>;
  v.coreChecksum = t!.core_checksum;
  if (gap) v.problems.push(`${table}: core column(s) missing in the workspace table: ${gap}`);
  if (v.coreRows !== v.wsRows) v.problems.push(`${table}: row count core=${v.coreRows} workspace=${v.wsRows}`);
  if (missing) v.problems.push(`${table}: ${missing} core row(s) missing or different in the workspace`);
  if (extra) v.problems.push(`${table}: ${extra} workspace row(s) not in core or different`);
  if (coreMd5.some((m, i) => m !== wsMd5[i])) v.problems.push(`${table}: checksum mismatch`);
  if (!t!.pence_equal) v.problems.push(`${table}: money total differs`);
  if (!t!.minutes_equal) v.problems.push(`${table}: worked-minutes total differs`);
  return v;
}

async function verifyWorkspace(q: Query, ws: HwsCutoverWorkspace, size: number): Promise<{ tables: Record<string, TableVerification>; problems: string[] }> {
  const tables: Record<string, TableVerification> = {};
  const problems: string[] = [];
  for (const table of HWS_CUTOVER_TABLE_LIST) {
    tables[table] = await verifyTable(q, ws, table, size);
    problems.push(...tables[table]!.problems);
  }
  // FKs and CHECKs: PostgreSQL enforced them on every inserted row; a NOT VALID constraint would not prove existing rows.
  const notValid = (await inTenant(q, ws.organisationId, ws.workspaceId, () =>
    q(
      `SELECT k.conrelid::pg_catalog.regclass::text AS tbl, k.conname::text AS name
         FROM pg_catalog.pg_constraint k
        WHERE k.connamespace = pg_catalog.to_regnamespace($1) AND k.contype IN ('f', 'c') AND NOT k.convalidated
        ORDER BY 1, 2`,
      [ws.schemaName],
    ),
  )) as Array<{ tbl: string; name: string }>;
  for (const c of notValid) if (!HWS_CUTOVER_KNOWN_NOT_VALID.includes(c.name)) problems.push(`constraint ${c.name} on ${c.tbl} is NOT VALID`);
  return { tables, problems };
}

/** The human-readable record (audit_log is insert-only; never read back — core.hws_cutover_state decides). */
async function recordAudit(q: Query, ws: HwsCutoverWorkspace, metadata: Record<string, unknown>): Promise<void> {
  await inTenant(q, ws.organisationId, ws.workspaceId, () =>
    q(
      `INSERT INTO core.audit_log (id, organisation_id, actor_user_id, action, metadata, entity_type, entity_id, created_at)
       VALUES (pg_catalog.gen_random_uuid(), $1::uuid, NULL, $2, $3::jsonb, 'manager_workspace', $4::uuid, pg_catalog.now())`,
      [ws.organisationId, HWS_CUTOVER_VERIFIED_ACTION, JSON.stringify(metadata), ws.workspaceId],
    ),
  );
}

/** pg_control_system().system_identifier, or null when this login may not call it (review Info-2). */
async function systemIdentifier(q: Query): Promise<string | null> {
  try {
    const [r] = (await q('SELECT system_identifier::text AS sid FROM pg_catalog.pg_control_system()')) as Array<{ sid: string }>;
    return r?.sid ?? null;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === '42501' || code === '42883') return null;
    throw error;
  }
}

/** The C3 cutover (see the file comment). Throws HwsCutoverRefused when the step must be recorded failed. */
export async function runHwsCutover(ctx: UpgradeCommandContext, options: HwsCutoverOptions = {}): Promise<HwsCutoverReport> {
  const { query: q, log } = ctx;
  const size = Math.min(10_000, Math.max(1, Math.trunc(options.batchSize ?? HWS_CUTOVER_DEFAULT_BATCH)));
  const report: HwsCutoverReport = { workspaces: [], backup: 'not-needed', unmappedNotes: 0 };
  const blockChanged = () => ctx.markBlockChanged?.();

  const all = await scanCutoverWorkspaces(q, options.workspaceIds);
  const pending = all.filter((w) => w.cutoverState !== 'verified');
  for (const w of all.filter((x) => x.cutoverState === 'verified')) report.workspaces.push({ workspaceId: w.workspaceId, status: 'already-verified' });
  log(`hws cutover: ${all.length} workspace(s), ${pending.length} pending`);
  if (!pending.length) return report;

  // 0. HWS off: the core copies stay authoritative and served; nothing is written (no block, no state).
  if (ctx.host?.hwsRuntimeEnabled !== true) {
    throw new HwsCutoverRefused(
      'HWS_RUNTIME_OFF',
      `hws cutover refused: HWS runtime routing is OFF in this deployment (HWS_RUNTIME_ENABLED) and ${pending.length} workspace(s) are not cut over. A copy made now would be a snapshot that later writes to core make stale. Start this release with HWS on. Nothing was written.`,
    );
  }

  const ready = (w: HwsCutoverWorkspace) => w.registryStatus === 'READY' && w.registrySchema === w.schemaName && SCHEMA_RE.test(w.schemaName);
  const eligible = pending.filter((w) => ready(w) && !blockedByOther(w.migrationError));
  const failures: WorkspaceCutoverOutcome[] = [];
  const failOutcome = (w: HwsCutoverWorkspace, errorClass: string, problems: string[]) => {
    const outcome: WorkspaceCutoverOutcome = { workspaceId: w.workspaceId, status: 'failed', errorClass, problems };
    report.workspaces.push(outcome);
    failures.push(outcome);
    log(`hws cutover: ERROR: workspace ${w.workspaceId} ${errorClass}: ${problems.slice(0, 10).join('; ')}`);
  };
  // Review M-2: not-READY workspaces and ones blocked by another step fail only themselves (the resolver already refuses them).
  for (const w of pending.filter((x) => !ready(x))) failOutcome(w, 'WORKSPACE_NOT_READY', ['no READY schema under its derived name; provision it first']);
  for (const w of pending.filter((x) => ready(x) && blockedByOther(x.migrationError))) failOutcome(w, 'WORKSPACE_UPGRADE_BLOCKED', ['blocked by another upgrade step']);

  /** Review H-1: whatever went wrong, no eligible, unverified workspace is left unblocked. Best effort; never masks the error. */
  const reblockAll = async () => {
    for (const w of eligible) {
      if (w.cutoverState === 'verified' || ours(w.migrationError)) continue;
      try {
        await setBlock(q, w, 'HWS_CUTOVER_PENDING');
        blockChanged();
      } catch {
        // the original error propagates; the next start blocks again first
      }
    }
  };

  try {
    // 1. Block first, then make sure no cached resolution still routes them.
    if (eligible.length) blockChanged();
    for (const w of eligible) {
      if (ours(w.migrationError)) continue;
      await setBlock(q, w, 'HWS_CUTOVER_PENDING');
      log(`hws cutover: workspace ${w.workspaceId} BLOCKED until its copy is verified (503, Worker paused)`);
    }
    if (eligible.length && ctx.flushBlockCache) await ctx.flushBlockCache();

    // 2. Probe; nothing of W in core → verified and served at once.
    const probes = new Map<string, ProbeRow[]>();
    for (const w of eligible) {
      const rows = (await inTenant(q, w.organisationId, w.workspaceId, () =>
        q('SELECT table_name, core_rows, ws_rows, org_mismatch, ambiguous_notes, unmapped_notes FROM core.hws_cutover_probe($1::uuid)', [w.workspaceId]),
      )) as ProbeRow[];
      probes.set(w.workspaceId, rows);
    }
    const note = (w: HwsCutoverWorkspace) => probes.get(w.workspaceId)!.find((r) => r.table_name === 'user_note');
    const orgMismatch = (w: HwsCutoverWorkspace) => probes.get(w.workspaceId)!.reduce((n, r) => n + Number(r.org_mismatch), 0);
    const ambiguous = (w: HwsCutoverWorkspace) => Number(note(w)?.ambiguous_notes ?? 0);
    // Review L-1 / L-3: rows of W under another organisation and ambiguous notes ARE core data (never "nothing to copy").
    const coreHas = (w: HwsCutoverWorkspace) => probes.get(w.workspaceId)!.some((r) => r.core_rows) || orgMismatch(w) > 0 || ambiguous(w) > 0;
    const wsHas = (w: HwsCutoverWorkspace) => probes.get(w.workspaceId)!.some((r) => r.ws_rows);
    report.unmappedNotes = Math.max(0, ...eligible.map((w) => Number(note(w)?.unmapped_notes ?? 0)));
    if (report.unmappedNotes > 0) {
      log(`hws cutover: WARNING: ${report.unmappedNotes} note(s) in an organisation have a subject with no staff or manager profile; they belong to no workspace and stay only in core.user_note (owner decision before C5)`);
    }
    for (const w of eligible.filter((x) => !coreHas(x))) {
      await setState(q, w, 'verified');
      await recordAudit(q, w, { step: HWS_CUTOVER_NAME, outcome: 'nothing-to-copy' });
      await liftBlock(q, w);
      blockChanged();
      report.workspaces.push({ workspaceId: w.workspaceId, status: 'nothing-to-copy' });
      log(`hws cutover: workspace ${w.workspaceId}: nothing in core to copy; unblocked (served from its own schema)`);
    }
    const toCopy = eligible.filter((x) => coreHas(x));

    // 3. Backup (only when something must be copied).
    let backup: CutoverBackupMarker | null = null;
    if (toCopy.length) {
      const [facts] = (await q(`SELECT pg_catalog.current_database()::text AS db, pg_catalog.now() AS now`)) as Array<{ db: string; now: Date | string }>;
      const check = await verifyCutoverBackup(ctx.host, { database: facts!.db, systemIdentifier: await systemIdentifier(q), dbNow: new Date(facts!.now) });
      if (!check.ok) throw new HwsCutoverRefused('NO_BACKUP', `hws cutover refused: no verified backup (${check.reason}). Nothing was copied; ${toCopy.length} workspace(s) stay blocked.`);
      backup = check.marker;
      report.backup = 'verified';
      log(`hws cutover: backup verified (taken ${backup.takenAt})`);
    }

    // 4. Per workspace.
    for (const w of toCopy) {
      const fail = async (errorClass: string, problems: string[]) => {
        failOutcome(w, errorClass, problems);
        await setBlock(q, w, errorClass);
        blockChanged();
      };
      if (orgMismatch(w) > 0) {
        await fail('HWS_CUTOVER_ORG_MISMATCH', probes.get(w.workspaceId)!.filter((r) => Number(r.org_mismatch) > 0).map((r) => `${r.table_name}: ${r.org_mismatch} core row(s) of this workspace carry another organisation`));
        continue;
      }
      if (ambiguous(w) > 0) {
        await fail('HWS_CUTOVER_USER_NOTE_AMBIGUOUS', [`user_note: ${ambiguous(w)} note(s) whose subject has a profile here and another elsewhere`]);
        continue;
      }
      if (wsHas(w) && w.cutoverState !== 'started') {
        // Rows in W's schema although no copy of ours ever started: written by HWS-on serving while core still holds rows.
        // Copying would resurrect rows deleted there. Operator / owner decision; never merged automatically.
        await fail('HWS_CUTOVER_BOTH_POPULATED', probes.get(w.workspaceId)!.filter((r) => r.ws_rows && r.core_rows).map((r) => `${r.table_name}: rows in core and in the workspace schema`));
        continue;
      }
      try {
        await setState(q, w, 'started');
        const copied = await copyWorkspace(q, w, size, options, log);
        if (options.beforeVerify) await options.beforeVerify(w.workspaceId);
        const verification = await verifyWorkspace(q, w, size);
        if (verification.problems.length) {
          await fail('HWS_CUTOVER_MISMATCH', verification.problems);
          continue;
        }
        const tables: Record<string, Record<string, unknown>> = {};
        for (const [t, v] of Object.entries(verification.tables)) tables[t] = { rows: v.coreRows, checksum: v.coreChecksum };
        await setState(q, w, 'verified');
        await recordAudit(q, w, { step: HWS_CUTOVER_NAME, outcome: 'copied-and-verified', copied, tables, backup: backup ? { takenAt: backup.takenAt, sha256: backup.sha256 } : null });
        // Review M-2: served from its own schema right away; its core-source statement pointers are dead from now on (R2).
        await inTenant(q, w.organisationId, w.workspaceId, () => q('SELECT core.hws_cutover_purge_core_statement_pointers($1::uuid) AS n', [w.workspaceId]));
        await liftBlock(q, w);
        blockChanged();
        report.workspaces.push({ workspaceId: w.workspaceId, status: 'verified', copied });
        log(`hws cutover: workspace ${w.workspaceId} verified (21 tables: counts, rows, checksums, money and minutes equal); unblocked`);
      } catch (error) {
        if (sessionLost(error)) throw error;
        await fail(errorClassOf(error), [`${errorClassOf(error)} during the copy or the verification`]);
      }
    }
  } catch (error) {
    if (!sessionLost(error)) await reblockAll();
    throw error;
  }

  if (failures.length) {
    throw new HwsCutoverRefused(
      'HWS_CUTOVER_WORKSPACE_FAILED',
      `hws cutover: ${failures.length} workspace(s) failed (${failures.slice(0, 20).map((f) => `${f.workspaceId} ${f.errorClass}`).join(', ')}); they stay blocked (503) and the next start retries them. Every other workspace is served from its own schema.`,
    );
  }
  log(`hws cutover: complete (${report.workspaces.filter((o) => o.status === 'verified').length} copied and verified this run)`);
  return report;
}

export function createHwsCutoverCommand(options: HwsCutoverOptions = {}): UpgradeCommand {
  return {
    name: HWS_CUTOVER_NAME,
    timestamp: HWS_CUTOVER_TIMESTAMP,
    run: async (ctx) => {
      await runHwsCutover(ctx, options);
    },
  };
}
