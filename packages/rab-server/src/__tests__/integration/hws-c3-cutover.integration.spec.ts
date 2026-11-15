import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { HWS_CUTOVER_TABLES } from '../../database/typeorm/core/hws-cutover-sql';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { SchemaResolverService, WorkspaceRoutingError } from '../../engine/core-modules/tenant/schema-resolver.service';
import type { WorkspaceMetadataCacheService } from '../../engine/core-modules/entity-cache/workspace-metadata-cache.service';
import { createUpgradeCommandHost } from '../../engine/core-modules/upgrade/upgrade-command-host';
import { CUTOVER_BACKUP_MARKER_ENV } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/hws-cutover-backup';
import { createHwsCutoverCommand, HWS_CUTOVER_VERIFIED_ACTION, HwsCutoverOptions, HwsCutoverRefused, runHwsCutover } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/hws-cutover';
import type { UpgradeCommandHost } from '../../engine/core-modules/upgrade/upgrade-commands/upgrade-command';
import { upgradeSessionOf } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { UpgradeRun } from '../../engine/core-modules/upgrade/upgrade-runner';
import { dropWorkspaceSchema, provisionTypeScript, SeededWorkspace, seedWorkspace, sqlstateOf } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part C3 (option A′, PENDING OWNER CHOICE AND SQL REVIEW): the HWS cutover copy path on a real, disposable
 * database, through the one runtime login (TEST_DATABASE_URL = crewflow_owner) holding the migration lock, exactly as the
 * migrate-on-start child runs an upgrade command. Workspaces are READY (TypeScript provisioner, module 20) with their
 * business rows seeded in the core copies by the cluster superuser (the shape of deploy-order-tests/seed-organisations.sql).
 * Proves:
 *  - abuse cases of every new function (no lock, another tenant, a table outside the list, limits, not READY, crewflow_app);
 *  - HWS off → refused, nothing blocked or copied; no backup → refused, the workspace BLOCKED (resolver: 'upgrading' = 503),
 *    nothing copied;
 *  - copy correctness on seeded data (every table: counts, rows, money and minutes equal), statement pointers reconciled;
 *  - a kill (pg_terminate_backend) partway through, then a resume: no duplicate, no gap, FORCE never left off;
 *  - a checksum mismatch → the workspace stays blocked, no verified row, the step fails;
 *  - zero rows with no tenant context, and with another organisation bound, in core and in the workspace schema;
 *  - through UpgradeRun (Part B logbook): failed (attempt 1) → completed (attempt 2).
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const LOCK = MIGRATION_LOCK_KEY.toString();
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

interface Seeded extends SeededWorkspace {
  venueId: string;
}

describeIfDb('C3 HWS cutover copy path (option A′)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let dbName: string;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  let backupDir: string;
  let seq = 0;

  const make = async (n: string): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `c3-${n}-${SFX}-${String.fromCharCode(97 + seq)}`);
    created.push(ws);
    await provisionTypeScript(adminUrl, ws);
    return ws;
  };

  /** One representative row graph per workspace in the CORE copies (superuser, no RLS), money in bigint pence. */
  const seedBusiness = async (ws: SeededWorkspace): Promise<Seeded> => {
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0] as Record<string, string>;
    const { org, owner, id } = ws;
    const t0 = new Date(Date.UTC(2026, 9, 1, 9, 0, 0));
    const at = (h: number) => new Date(t0.getTime() + h * 3_600_000).toISOString();
    await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'ceo', $3)`, [org, owner, id]);
    const vmUser = await one(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'C3', 'VenueMgr', 'active') RETURNING id`, [org, `vm-${ws.label}@c3.invalid`]);
    const vm = await one(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'venue', $3) RETURNING id`, [org, vmUser.id, id]);
    const venue = await one(`INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, 'C3 Hall', $2, $3) RETURNING id`, [org, owner, id]);
    const venue2 = await one(`INSERT INTO core.venue (organisation_id, name, created_by, workspace_id) VALUES ($1, 'C3 Garden', $2, $3) RETURNING id`, [org, owner, id]);
    const jr = await one(`INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, 'C3 Bartender', 1500, $2, $3) RETURNING id`, [org, owner, id]);
    await admin.query(`INSERT INTO core.venue_role_rate (organisation_id, venue_id, job_role_id, pay_rate_pence, workspace_id) VALUES ($1, $2, $3, 1650, $4)`, [org, venue.id, jr.id, id]);
    await admin.query(`INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [org, vm.id, venue.id, id]);
    const staff: Array<{ user: string; sp: string }> = [];
    for (let i = 1; i <= 3; i += 1) {
      const u = await one(`INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'C3', $3, 'active') RETURNING id`, [org, `s${i}-${ws.label}@c3.invalid`, `Staff ${i}`]);
      const sp = await one(`INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [org, u.id, `C3-${seq}-${i}`, owner, id]);
      staff.push({ user: u.id, sp: sp.id });
    }
    await admin.query(`INSERT INTO core.venue_manager_staff (organisation_id, workspace_id, manager_profile_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [org, id, vm.id, staff[0]!.sp]);
    const past = await one(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, $5, 30, 2, 2, 1500, 'completed', $6, $7) RETURNING id`,
      [org, venue.id, jr.id, at(0), at(8), owner, id],
    );
    const future = await one(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, $5, 30, 2, 0, 1500, 'open', $6, $7) RETURNING id`,
      [org, venue2.id, jr.id, at(24 * 400), at(24 * 400 + 8), owner, id],
    );
    await admin.query(`INSERT INTO core.shift_request_staff (organisation_id, workspace_id, shift_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [org, id, future.id, staff[2]!.sp]);
    await admin.query(`INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id) VALUES ($1, $2, $3)`, [org, id, past.id]);
    const cal = await one(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2026, 1, 'c3-seed', $2) RETURNING id`, [org, owner]);
    const per = await one(
      `INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, $3::date, $4::date, $5::date) RETURNING id`,
      [org, cal.id, '2026-09-25', '2026-10-08', '2026-10-12'],
    );
    const run = await one(`INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES ($1, $2, $3, $4) RETURNING id`, [org, id, per.id, owner]);
    for (let i = 0; i < 2; i += 1) {
      const sp = staff[i]!.sp;
      const asg = await one(
        `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
         VALUES ($1, $2, $3, 'completed', 1500, $4, $5, tstzrange($6::timestamptz, $7::timestamptz), $8) RETURNING id`,
        [org, past.id, sp, owner, at(-24), at(0), at(8), id],
      );
      await admin.query(
        `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
         VALUES ($1, $2, $3, 'staff_accepted', $4, $5, 11250, $6, $7)`,
        [org, asg.id, sp, at(-48), at(-24), owner, id],
      );
      const att = await one(
        `INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', 450, 11250) RETURNING id`,
        [org, asg.id, past.id, sp, id, at(0), at(8)],
      );
      await admin.query(
        `INSERT INTO core.attendance_correction (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
         VALUES ($1, $2, $3, 'clock_out_at', $4, $5, 'C3 seed correction', $6)`,
        [org, id, att.id, at(7), at(8), owner],
      );
      const rec = await one(
        `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, 'approved', 450, 1500, $6, $7, $8) RETURNING id`,
        [org, id, att.id, past.id, sp, String(11250 + i), at(24), owner],
      );
      await admin.query(
        `INSERT INTO core.payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence)
         VALUES ($1, $2, $3, $4, $5, $6::date, 450, 1500, $7)`,
        [org, id, run.id, rec.id, sp, '2026-10-01', String(11250 + i)],
      );
      await admin.query(`INSERT INTO core.payslip (organisation_id, workspace_id, run_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [org, id, run.id, sp]);
    }
    await admin.query(`INSERT INTO core.user_note (organisation_id, subject_user_id, author_user_id, body) VALUES ($1, $2, $3, 'C3 note about staff one')`, [org, staff[0]!.user, owner]);
    await admin.query(`INSERT INTO core.user_note (organisation_id, subject_user_id, author_user_id, body) VALUES ($1, $2, $3, 'C3 note about the venue manager')`, [org, vmUser.id, owner]);
    return { ...ws, venueId: venue.id };
  };

  const countIn = async (schema: string, table: string, ws: SeededWorkspace): Promise<number> => {
    if (schema === 'core' && table === 'user_note') {
      return Number(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM core.user_note n WHERE n.subject_user_id IN (SELECT user_id FROM core.staff_profile WHERE workspace_id = $1 UNION SELECT user_id FROM core.manager_profile WHERE workspace_id = $1)`,
            [ws.id],
          )
        ).rows[0].n,
      );
    }
    const where = schema === 'core' ? ' WHERE workspace_id = $1' : '';
    return Number((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.${table}${where}`, schema === 'core' ? [ws.id] : [])).rows[0].n);
  };
  const wsTotal = async (ws: SeededWorkspace) => {
    let n = 0;
    for (const t of HWS_CUTOVER_TABLES) n += await countIn(ws.schema, t, ws);
    return n;
  };
  const migrationError = async (ws: SeededWorkspace) => (await admin.query('SELECT migration_error FROM core.workspace_schema_registry WHERE workspace_id = $1', [ws.id])).rows[0].migration_error as string | null;
  const verifiedRows = async (ws: SeededWorkspace) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1 AND action = $2`, [ws.id, HWS_CUTOVER_VERIFIED_ACTION])).rows[0].n);
  /** FORCE + ENABLE on every core business table and on every table of the given schemas. */
  const forceOffAnywhere = async (schemas: string[]) =>
    (
      await admin.query(
        `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND c.relname = ANY ($1::text[]) AND (n.nspname = 'core' OR n.nspname = ANY ($2::text[]))
            AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
        [[...HWS_CUTOVER_TABLES, 'manager_profile'], schemas],
      )
    ).rows.map((r) => r.rel as string);

  /** The resolver every API / Worker workspace bind passes through (cache stubbed to "always ask Postgres"). */
  const resolveAs = async (ws: SeededWorkspace): Promise<string> => {
    const cache = { resolveSchema: (_id: string, fetch: () => Promise<unknown>) => fetch(), invalidate: async () => undefined } as unknown as WorkspaceMetadataCacheService;
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [ws.org, ws.id]);
      const manager = { query: (sql: string, params?: unknown[]) => c.query(sql, params).then((r) => r.rows) } as never;
      try {
        return await new SchemaResolverService(cache).resolve(manager, ws.id);
      } catch (error) {
        return error instanceof WorkspaceRoutingError ? `refused:${error.code}` : `error:${(error as Error).name}`;
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };

  /** A real pg_dump-shaped file + the marker the runbook writes. */
  const writeBackup = (opts: { takenAt?: string } = {}) => {
    const dump = Buffer.concat([Buffer.from('PGDMP'), Buffer.from(randomUUID())]);
    writeFileSync(join(backupDir, 'pre-cutover.dump'), dump);
    const marker = {
      kind: 'crewflow-hws-cutover-backup',
      version: 1,
      database: dbName,
      takenAt: opts.takenAt ?? new Date().toISOString(),
      format: 'pg_dump-custom',
      dumpFile: 'pre-cutover.dump',
      sha256: createHash('sha256').update(dump).digest('hex'),
      sizeBytes: dump.length,
      restoreVerified: true,
    };
    writeFileSync(join(backupDir, 'marker.json'), JSON.stringify(marker));
  };
  const host = (opts: { backup?: boolean; hws?: boolean } = {}): UpgradeCommandHost =>
    createUpgradeCommandHost({ env: opts.backup === false ? {} : { [CUTOVER_BACKUP_MARKER_ENV]: join(backupDir, 'marker.json') }, hwsRuntimeEnabled: opts.hws ?? true });
  const cutover = (q: Client, ids: string[], h: UpgradeCommandHost, extra: HwsCutoverOptions = {}) =>
    runHwsCutover({ query: (sql, params) => q.query(sql, params as unknown[]).then((r) => r.rows), log, host: h }, { workspaceIds: ids, ...extra });

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    dbName = (await app.query('SELECT current_database() AS d')).rows[0].d;
    backupDir = mkdtempSync(join(tmpdir(), 'c3-backup-'));
  });

  afterAll(async () => {
    await app?.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    for (const ws of created) {
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', migration_error = NULL WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
      await admin.query(`DELETE FROM core.worker_dispatch_pointer WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND name LIKE '0.7.0_%' AND executed_by_version = '0.7.0'`).catch(() => undefined);
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    await app?.end();
    await admin?.end();
  });

  it('the session is the one runtime login, holding the migration lock', async () => {
    expect((await app.query('SELECT current_user::text AS u')).rows[0].u).toBe('crewflow_owner');
  });

  it('abuse cases: no lock, another tenant, a table outside the list, limits, not READY, crewflow_app → refused', async () => {
    const a = await make('abuse-a');
    const b = await make('abuse-b');
    const bound = async (c: Client, org: string, ws: string, sql: string, params: unknown[]) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org, ws]);
        return await c.query(sql, params);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    };
    const copy = 'SELECT * FROM core.hws_cutover_copy_batch($1, $2, $3, $4)';
    const verify = 'SELECT * FROM core.hws_cutover_verify_range($1, $2, $3, $4)';
    const noLock = new Client({ connectionString: appUrl });
    await noLock.connect();
    try {
      expect(await sqlstateOf(bound(noLock, a.org, a.id, copy, [a.id, 'venue', null, 10]))).toBe('42501');
      expect(await sqlstateOf(bound(noLock, a.org, a.id, verify, [a.id, 'venue', null, 10]))).toBe('42501');
      expect(await sqlstateOf(bound(noLock, a.org, a.id, 'SELECT * FROM core.hws_cutover_probe($1)', [a.id]))).toBe('42501');
      expect(await sqlstateOf(bound(noLock, a.org, a.id, 'SELECT * FROM core.hws_cutover_reconcile_statement_pointers($1, false)', [a.id]))).toBe('42501');
    } finally {
      await noLock.end();
    }
    // The lock holder, but the tenant bound to ANOTHER workspace (and another organisation).
    expect(await sqlstateOf(bound(app, b.org, b.id, copy, [a.id, 'venue', null, 10]))).toBe('42501');
    expect(await sqlstateOf(bound(app, a.org, b.id, copy, [a.id, 'venue', null, 10]))).toBe('42501');
    expect(await sqlstateOf(bound(app, b.org, b.id, 'SELECT * FROM core.hws_cutover_reconcile_statement_pointers($1, true)', [a.id]))).toBe('42501');
    // Closed table list, limits, keyset arity.
    for (const t of ['user', 'organisation', 'manager_workspace', 'audit_log', 'venue; DROP TABLE core.venue', null]) {
      expect(await sqlstateOf(bound(app, a.org, a.id, copy, [a.id, t, null, 10]))).toBe('22023');
      expect(await sqlstateOf(bound(app, a.org, a.id, verify, [a.id, t, null, 10]))).toBe('22023');
    }
    for (const n of [0, -1, 10_001, null]) expect(await sqlstateOf(bound(app, a.org, a.id, copy, [a.id, 'venue', null, n]))).toBe('22023');
    expect(await sqlstateOf(bound(app, a.org, a.id, copy, [a.id, 'manager_venue', randomUUID(), 10]))).toBe('22023');
    expect(await sqlstateOf(bound(app, a.org, a.id, copy, [a.id, 'venue', 'not-a-uuid', 10]))).toBe('22P02');
    // Not READY (a workspace with no schema) → 55000; a registry name mismatch → 55000.
    const notReady = await seedWorkspace(admin, `c3-notready-${SFX}`);
    created.push(notReady);
    expect(await sqlstateOf(bound(app, notReady.org, notReady.id, copy, [notReady.id, 'venue', null, 10]))).toBe('55000');
    // crewflow_app (the restricted reference grant set) holds no EXECUTE on any of them.
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE crewflow_app');
      for (const fn of [
        'core.hws_cutover_copy_batch(uuid,text,text,integer)',
        'core.hws_cutover_verify_range(uuid,text,text,integer)',
        'core.hws_cutover_probe(uuid)',
        'core.hws_cutover_schema(uuid)',
        'core.hws_cutover_source_sql(text)',
        'core.hws_cutover_reconcile_statement_pointers(uuid,boolean)',
      ]) {
        expect((await admin.query(`SELECT has_function_privilege('crewflow_app', $1, 'EXECUTE') AS x`, [fn])).rows[0].x).toBe(false);
      }
      await admin.query('SAVEPOINT s');
      expect(await sqlstateOf(admin.query(copy, [a.id, 'venue', null, 10]))).toBe('42501');
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await forceOffAnywhere([a.schema, b.schema])).toEqual([]);
  });

  let w1: Seeded;
  let corePointersBefore: string[] = [];
  let noPointerRecord = '';

  it('HWS off: refused (HWS_RUNTIME_OFF); nothing blocked, nothing copied', async () => {
    w1 = await seedBusiness(await make('main'));
    writeBackup();
    await expect(cutover(app, [w1.id], host({ hws: false }))).rejects.toMatchObject({ name: 'HwsCutoverRefused', errorClass: 'HWS_RUNTIME_OFF' });
    expect(await migrationError(w1)).toBeNull();
    expect(await wsTotal(w1)).toBe(0);
    expect(await verifiedRows(w1)).toBe(0);
  });

  it('no backup → refused (NO_BACKUP): the workspace is BLOCKED (503 "being upgraded"), nothing is copied', async () => {
    expect(await resolveAs(w1)).toBe(w1.schema);
    await expect(cutover(app, [w1.id], host({ backup: false }))).rejects.toMatchObject({ name: 'HwsCutoverRefused', errorClass: 'NO_BACKUP' });
    expect(await migrationError(w1)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_PENDING)');
    expect(await resolveAs(w1)).toBe('refused:upgrading');
    expect(await wsTotal(w1)).toBe(0);
    // A stale backup refuses the same way.
    writeBackup({ takenAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    await expect(cutover(app, [w1.id], host())).rejects.toMatchObject({ errorClass: 'NO_BACKUP' });
    expect(await wsTotal(w1)).toBe(0);
    expect(await verifiedRows(w1)).toBe(0);
  });

  it('a kill partway through the copy leaves the workspace blocked, FORCE on, no verified row', async () => {
    writeBackup();
    // One historical approved record whose core twin has NO statement pointer: the copy must not create due work for it.
    const recs = (await admin.query(`SELECT id FROM core.payroll_record WHERE workspace_id = $1 ORDER BY id`, [w1.id])).rows.map((r) => r.id as string);
    noPointerRecord = recs[0]!;
    await admin.query(`DELETE FROM core.worker_dispatch_pointer WHERE queue = 'statement' AND subject_id = $1`, [noPointerRecord]);
    corePointersBefore = (
      await admin.query(`SELECT subject_id FROM core.worker_dispatch_pointer WHERE queue = 'statement' AND workspace_id = $1 AND source_schema = 'core' ORDER BY 1`, [w1.id])
    ).rows.map((r) => r.subject_id as string);
    expect(corePointersBefore).not.toContain(noPointerRecord);

    await app.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]);
    const k = new Client({ connectionString: appUrl });
    await k.connect();
    k.on('error', () => undefined);
    await k.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    const pid = (await k.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    let killed = false;
    const run = cutover(k, [w1.id], host(), {
      batchSize: 1,
      afterBatch: async ({ table, batch }) => {
        if (!killed && table === 'shift_assignment' && batch === 1) {
          killed = true;
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
          // Wait until the backend is really gone, so no further batch of this run can commit.
          for (let i = 0; i < 200; i += 1) {
            if (!(await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rows.length) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      },
    });
    await expect(run).rejects.toBeDefined();
    expect(killed).toBe(true);
    await k.end().catch(() => undefined);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);

    expect(await migrationError(w1)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_PENDING)');
    expect(await resolveAs(w1)).toBe('refused:upgrading');
    expect(await countIn(w1.schema, 'job_role', w1)).toBe(1);
    expect(await countIn(w1.schema, 'shift_assignment', w1)).toBe(1);
    expect(await countIn(w1.schema, 'payroll_record', w1)).toBe(0);
    expect(await verifiedRows(w1)).toBe(0);
    expect(await forceOffAnywhere([w1.schema])).toEqual([]);
  });

  it('resume: copies the rest, verifies every table (counts, rows, checksums, money, minutes), unblocks; no duplicate, no gap', async () => {
    const report = await cutover(app, [w1.id], host(), { batchSize: 1 });
    expect(report.backup).toBe('verified');
    expect(report.workspaces).toEqual([expect.objectContaining({ workspaceId: w1.id, status: 'verified' })]);
    for (const t of HWS_CUTOVER_TABLES) {
      expect({ t, n: await countIn(w1.schema, t, w1) }).toEqual({ t, n: await countIn('core', t, w1) });
    }
    expect(await countIn(w1.schema, 'payroll_record', w1)).toBe(2);
    expect(await countIn(w1.schema, 'user_note', w1)).toBe(2);
    // Full-precision equality, both directions, for the money tables (every column, as canonical jsonb text).
    for (const t of ['payroll_record', 'payroll_run_line', 'attendance', 'attendance_correction', 'payslip', 'payroll_run']) {
      const diff = await admin.query(
        `SELECT (SELECT count(*) FROM (SELECT to_jsonb(c)::text FROM core.${t} c WHERE c.workspace_id = $1 EXCEPT ALL SELECT to_jsonb(w)::text FROM ${w1.schema}.${t} w) x)::int AS missing,
                (SELECT count(*) FROM (SELECT to_jsonb(w)::text FROM ${w1.schema}.${t} w EXCEPT ALL SELECT to_jsonb(c)::text FROM core.${t} c WHERE c.workspace_id = $1) x)::int AS extra`,
        [w1.id],
      );
      expect({ t, ...diff.rows[0] }).toEqual({ t, missing: 0, extra: 0 });
    }
    const pence = await admin.query(
      `SELECT (SELECT sum(amount_pence)::text FROM core.payroll_record WHERE workspace_id = $1) AS core, (SELECT sum(amount_pence)::text FROM ${w1.schema}.payroll_record) AS ws`,
      [w1.id],
    );
    expect(pence.rows[0]).toEqual({ core: '22501', ws: '22501' });
    expect(await migrationError(w1)).toBeNull();
    expect(await resolveAs(w1)).toBe(w1.schema);
    expect(await verifiedRows(w1)).toBe(1);
    const meta = (await admin.query(`SELECT metadata FROM core.audit_log WHERE entity_id = $1 AND action = $2`, [w1.id, HWS_CUTOVER_VERIFIED_ACTION])).rows[0].metadata;
    expect(meta).toMatchObject({ step: 'HwsCutover', outcome: 'copied-and-verified', tables: { payroll_record: { rows: 2, pence: '22501', minutes: '900' } } });
    // Statement pointers (Q13): exactly the core twins' pointers now exist for the workspace copy; none for the record whose
    // twin had none; every core-source pointer of the workspace is purged.
    const after = await admin.query(`SELECT subject_id, source_schema FROM core.worker_dispatch_pointer WHERE queue = 'statement' AND workspace_id = $1 ORDER BY 1`, [w1.id]);
    expect(after.rows.map((r) => r.subject_id)).toEqual(corePointersBefore);
    expect(after.rows.every((r) => r.source_schema === w1.schema)).toBe(true);
    expect(after.rows.map((r) => r.subject_id)).not.toContain(noPointerRecord);
    expect(await forceOffAnywhere([w1.schema])).toEqual([]);
  });

  it('idempotent: a second run copies and verifies nothing again and writes no second verified row', async () => {
    const before = await wsTotal(w1);
    const report = await cutover(app, [w1.id], host({ backup: false }));
    expect(report.workspaces).toEqual([{ workspaceId: w1.id, status: 'already-verified' }]);
    expect(await wsTotal(w1)).toBe(before);
    expect(await verifiedRows(w1)).toBe(1);
  });

  it('zero rows with no tenant context, and with another organisation bound, in the workspace schema and in core', async () => {
    const other = await make('other-org');
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      for (const t of HWS_CUTOVER_TABLES) {
        expect({ t, n: Number((await c.query(`SELECT count(*)::int AS n FROM ${w1.schema}.${t}`)).rows[0].n) }).toEqual({ t, n: 0 });
        expect({ t, n: Number((await c.query(`SELECT count(*)::int AS n FROM core.${t}`)).rows[0].n) }).toEqual({ t, n: 0 });
      }
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [other.org, w1.id]);
      for (const t of ['payroll_record', 'staff_profile', 'attendance', 'payslip', 'attendance_correction', 'user_note']) {
        expect({ t, n: Number((await c.query(`SELECT count(*)::int AS n FROM ${w1.schema}.${t}`)).rows[0].n) }).toEqual({ t, n: 0 });
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('a checksum mismatch → the workspace stays BLOCKED (HWS_CUTOVER_MISMATCH), no verified row, the step fails', async () => {
    const w2 = await seedBusiness(await make('mismatch'));
    writeBackup();
    const run = cutover(app, [w2.id], host(), {
      beforeVerify: async () => {
        // A planted difference after the copy (venue has no update guard): one column of one row.
        await admin.query(`UPDATE ${w2.schema}.venue SET name = name || ' (changed)' WHERE id = $1`, [w2.venueId]);
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'HwsCutoverRefused', errorClass: 'HWS_CUTOVER_WORKSPACE_FAILED' });
    expect(await migrationError(w2)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_MISMATCH)');
    expect(await resolveAs(w2)).toBe('refused:upgrading');
    expect(await verifiedRows(w2)).toBe(0);
    expect(lines.some((l) => l.includes(w2.id) && l.includes('venue: checksum mismatch'))).toBe(true);
    // Never half-switched: the next start re-verifies, finds the same difference (the copy never overwrites), stays blocked.
    await expect(cutover(app, [w2.id], host())).rejects.toMatchObject({ errorClass: 'HWS_CUTOVER_WORKSPACE_FAILED' });
    expect(await migrationError(w2)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_MISMATCH)');
    expect(await forceOffAnywhere([w2.schema])).toEqual([]);
  });

  it('rows already in the schema of a workspace never cut over → refused (BOTH_POPULATED), blocked, nothing merged', async () => {
    const w4 = await seedBusiness(await make('both'));
    writeBackup();
    await admin.query(
      `INSERT INTO ${w4.schema}.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, 'Written with HWS on', 1700, $2, $3)`,
      [w4.org, w4.owner, w4.id],
    );
    // First start without a backup: refused before any copy, but the workspace is already marked BOTH_POPULATED ...
    await expect(cutover(app, [w4.id], host({ backup: false }))).rejects.toMatchObject({ errorClass: 'NO_BACKUP' });
    expect(await migrationError(w4)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_BOTH_POPULATED)');
    // ... so the next start (backup present) does not take it for a partial copy of its own: refused, nothing merged.
    await expect(cutover(app, [w4.id], host())).rejects.toMatchObject({ errorClass: 'HWS_CUTOVER_WORKSPACE_FAILED' });
    expect(await migrationError(w4)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_BOTH_POPULATED)');
    expect(await wsTotal(w4)).toBe(1);
    expect(await verifiedRows(w4)).toBe(0);
  });

  it('through the Part B logbook (UpgradeRun): failed attempt 1 (no backup, blocks reported) → completed attempt 2', async () => {
    const w3 = await seedBusiness(await make('ledger'));
    const command = createHwsCutoverCommand({ workspaceIds: [w3.id] });
    const step = '0.7.0_HwsCutover_1786721510100';
    const session = upgradeSessionOf(app);
    const runOnce = async (h: UpgradeCommandHost) => {
      const run = new UpgradeRun({
        codeVersion: '0.7.0',
        previousVersions: ['0.4.0', '0.5.0', '0.6.0'],
        force: true,
        log,
        registry: { '0-7': [command] },
        workspaceRegistry: {},
        workspaceRunner: { workspaceIds: [] },
        host: h,
      });
      await run.beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true });
      await run.afterApply(session);
      return run.report;
    };
    const rows = async () => (await admin.query(`SELECT status, attempt, forced FROM core.upgrade_migration WHERE workspace_id IS NULL AND name = $1 ORDER BY attempt`, [step])).rows;
    const first = await runOnce(host({ backup: false }));
    expect(first.commandFailure).toMatchObject({ name: step, errorName: 'HwsCutoverRefused' });
    expect(first.commandBlockChanged).toBe(true);
    expect(await rows()).toEqual([{ status: 'failed', attempt: 1, forced: true }]);
    expect(await migrationError(w3)).toBe('upgrade-blocked: HwsCutover (HWS_CUTOVER_PENDING)');
    writeBackup();
    const second = await runOnce(host());
    expect(second.commandFailure).toBeNull();
    expect(second.commandBlockChanged).toBe(true);
    expect(await rows()).toEqual([
      { status: 'failed', attempt: 1, forced: true },
      { status: 'completed', attempt: 2, forced: true },
    ]);
    expect(await migrationError(w3)).toBeNull();
    expect(await verifiedRows(w3)).toBe(1);
  });
});
