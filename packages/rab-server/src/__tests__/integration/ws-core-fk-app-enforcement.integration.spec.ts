import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { WorkspaceCoreForeignKeyRemoval1786721490000 } from '../../database/typeorm/core/migrations/1786721490000-WorkspaceCoreForeignKeyRemoval';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { assertUsersOfOrganisationTx } from '../../engine/core-modules/core-references/core-references';
import { userReferenceColumns, workspaceRestrictReference } from '../../engine/core-modules/core-references/workspace-user-references';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { UserDeletionService } from '../../engine/core-modules/user-deletion/user-deletion.service';
import { dropWorkspaceSchema, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (structure level 22; owner approved 2026-11-15): every case a dropped workspace → core foreign
 * key used to refuse is refused (or carried out) by the application instead. Real PostgreSQL, a level-22 workspace built by the
 * TypeScript provisioner, the application's own services on the runtime login with the tenant bound:
 *  - organisation_id / workspace_id: a row naming another organisation, another workspace or no existing organisation is refused
 *    by FORCE RLS / the per-table binding CHECK (no foreign key needed);
 *  - a user id from anything but the actor: assertUsersOfOrganisationTx → 404 for a missing user and for another organisation's
 *    user (stricter than the old FK, which accepted any organisation's user);
 *  - user deletion (owner 0g: soft by default; a never-activated invite with no history is hard-deleted in a savepoint):
 *    - the former RESTRICT (Q3): a no-ON-DELETE workspace column naming the invite makes the hard delete unsafe → soft delete;
 *    - the former CASCADE / SET NULL (Q2): the hard delete removes the invite's own staff profile and clears the SET NULL
 *      columns, in the same savepoint;
 *    - an in-schema row that still needs the profile (a payslip) → 23503 inside the savepoint → soft delete, nothing removed;
 *    - approved payroll evidence (F3) → soft delete, every row stays;
 *  - the 0a migration's down() refuses while a level-22 workspace exists (nothing changed).
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('Part D 0a: the application enforces what the workspace → core foreign keys did (integration)', () => {
  const { adminUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let moduleRef: TestingModule;
  let runtime: DataSource;
  let deletion: UserDeletionService;
  let tenantContext: TenantContextService;
  let admin: Client;
  let w: SeededWorkspace;
  let other: SeededWorkspace;
  const created: SeededWorkspace[] = [];

  const user = async (org: string, label: string): Promise<string> =>
    (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'F', 'K', 'active') RETURNING id`, [org, `${label}-${randomUUID().slice(0, 8)}@ws0a.invalid`]))
      .rows[0].id as string;
  /** The workspace owner as the caller: a manager of THIS workspace (its manager branches of RLS apply), tenant bound. */
  const ctxOf = (ws: SeededWorkspace): AuthContext => ({ organisationId: ws.org, workspaceId: ws.id, userId: ws.owner, role: 'manager' }) as AuthContext;
  const asOwner = <T>(ws: SeededWorkspace, fn: (m: EntityManager) => Promise<T>): Promise<T> =>
    runtime.transaction(async (m) => {
      await m.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true),
                set_config('rab.role', 'manager', true), set_config('rab.actor_type', 'user', true), set_config('search_path', 'core', true)`,
        [ws.org, ws.id, ws.owner],
      );
      return fn(m);
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    runtime = moduleRef.get(DataSource);
    deletion = moduleRef.get(UserDeletionService);
    tenantContext = moduleRef.get(TenantContextService);
    for (const n of ['w', 'other']) {
      const ws = await seedWorkspace(admin, `ws0a-app-${n}-${SFX}`);
      created.push(ws);
      expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
      expect((await registryOf(admin, ws.id)).module_version).toBe(22);
      // The owner is an internal manager of its own workspace (the manager branches of the workspace RLS).
      await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [ws.org, ws.owner, ws.id]);
    }
    [w, other] = created as [SeededWorkspace, SeededWorkspace];
  });

  afterAll(async () => {
    for (const ws of created) {
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await moduleRef?.close();
    await admin?.end();
  });

  it('the level-22 workspace has no foreign key to core."user", core.organisation or core.manager_workspace left', async () => {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace s ON s.oid = k.connamespace
        WHERE s.nspname = $1 AND k.contype = 'f' AND k.confrelid IN ('core."user"'::regclass, 'core.organisation'::regclass, 'core.manager_workspace'::regclass)`,
      [w.schema],
    );
    expect(rows[0].n).toBe(0);
    expect(userReferenceColumns()).toHaveLength(31);
  });

  it('organisation_id / workspace_id: another organisation, another workspace or a missing organisation is refused (RLS / binding CHECK)', async () => {
    const attempt = (org: string, ws: string) =>
      asOwner(w, async (m) => m.query(`INSERT INTO ${w.schema}.job_role (organisation_id, name, workspace_id) VALUES ($1, 'fk-probe', $2)`, [org, ws])).then(
        () => 'inserted',
        (e: { driverError?: { code?: string }; code?: string }) => e.driverError?.code ?? e.code ?? 'error',
      );
    expect(await attempt(w.org, w.id)).toBe('inserted');
    expect(['42501', '23514']).toContain(await attempt(other.org, w.id));
    expect(['42501', '23514']).toContain(await attempt(w.org, other.id));
    expect(['42501', '23514']).toContain(await attempt(randomUUID(), w.id));
  });

  it('a user id from anything but the actor: a missing user and another organisation\'s user are 404 (stricter than the old FK)', async () => {
    const own = await user(w.org, 'own');
    const foreign = await user(other.org, 'foreign');
    await asOwner(w, async (m) => {
      await expect(assertUsersOfOrganisationTx(m, w.org, [own])).resolves.toBeUndefined();
    });
    for (const id of [randomUUID(), foreign]) {
      await expect(asOwner(w, (m) => assertUsersOfOrganisationTx(m, w.org, [id]))).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  // Owner decision 0g: a user is SOFT deleted (the row stays, every reference keeps resolving); only a never-activated invite
  // with no history is hard-deleted, inside a savepoint that falls back to soft. These cases drive that hard-delete path.
  const invited = async (label: string): Promise<string> =>
    (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'F', 'K', 'invited') RETURNING id`, [w.org, `${label}-${randomUUID().slice(0, 8)}@ws0a.invalid`]))
      .rows[0].id as string;
  const userRow = async (id: string) => (await admin.query(`SELECT deleted_at IS NOT NULL AS deleted FROM core."user" WHERE id = $1`, [id])).rows[0] as { deleted: boolean } | undefined;
  const countIn = async (table: string, id: string) => (await admin.query(`SELECT count(*)::int AS n FROM ${w.schema}.${table} WHERE id = $1`, [id])).rows[0].n as number;
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
  const venueAndRole = async (label: string) => ({
    venue: await one(`INSERT INTO ${w.schema}.venue(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `${label} venue ${SFX}`]),
    role: await one(`INSERT INTO ${w.schema}.job_role(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `${label} role ${SFX}`]),
  });
  const deleteAsOwner = (target: string) => tenantContext.runInTenantContext(ctxOf(w), (m) => deletion.deleteUser(m, ctxOf(w), target));
  const withLog = async <T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const log = jest.spyOn(Logger.prototype, 'log');
    try {
      const result = await run();
      return { result, lines: log.mock.calls.map((c) => String(c[0])) };
    } finally {
      log.mockRestore();
    }
  };

  it('the former RESTRICT: a column no pre-delete history check reads (shift.approved_by) is probed; the invite is soft-deleted, nothing removed', async () => {
    const target = await invited('restrict');
    const { venue, role } = await venueAndRole('restrict');
    const shift = await one(
      `INSERT INTO ${w.schema}.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, approved_by)
       VALUES ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 4 hours', 1, 1200, $5, $6) RETURNING id`,
      [w.org, w.id, venue, role, w.owner, target],
    );
    expect(await tenantContext.runInTenantContext(ctxOf(w), (m) => workspaceRestrictReference(m, target))).toBe('shift.approved_by');
    const { result, lines } = await withLog(() => deleteAsOwner(target));
    expect(result).toBe('soft_deleted');
    expect(lines).toContainEqual(expect.stringMatching(/^user hard delete not safe \(history:shift\.approved_by\)/));
    expect(await userRow(target)).toEqual({ deleted: true });
    expect(await countIn('shift', shift)).toBe(1);
  });

  it('the former CASCADE / SET NULL: the hard delete removes the invite\'s own staff profile and clears the attribution columns', async () => {
    const target = await invited('cascade');
    const staff = await one(`INSERT INTO ${w.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      w.org,
      target,
      `FK-${SFX}`,
      w.id,
      w.owner,
    ]);
    const authored = await one(`INSERT INTO ${w.schema}.user_note (organisation_id, subject_user_id, author_user_id, body, workspace_id) VALUES ($1, $2, $3, 'by', $4) RETURNING id`, [
      w.org,
      w.owner,
      target,
      w.id,
    ]);
    expect(await deleteAsOwner(target)).toBe('hard_deleted');
    expect(await userRow(target)).toBeUndefined();
    expect(await countIn('staff_profile', staff)).toBe(0);
    expect((await admin.query(`SELECT author_user_id FROM ${w.schema}.user_note WHERE id = $1`, [authored])).rows[0].author_user_id).toBeNull();
  });

  it('an in-schema row still needs the profile (a payslip): the cleanup meets the in-schema foreign key, the savepoint rolls back, soft delete', async () => {
    const target = await invited('payslip');
    const sp = await one(`INSERT INTO ${w.schema}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, target, `PS-${SFX}`]);
    const cal = await one(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2026, 1, 'ws0a-test', $2) RETURNING id`, [w.org, w.owner]);
    const period = await one(`INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, '2026-09-01', '2026-09-14', '2026-09-18') RETURNING id`, [w.org, cal]);
    const run = await one(`INSERT INTO ${w.schema}.payroll_run (organisation_id, workspace_id, period_id, prepared_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, period, w.owner]);
    const payslip = await one(`INSERT INTO ${w.schema}.payslip (organisation_id, workspace_id, run_id, staff_profile_id) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, run, sp]);
    const { result, lines } = await withLog(() => deleteAsOwner(target));
    expect(result).toBe('soft_deleted');
    expect(lines).toContainEqual(expect.stringMatching(/^user hard delete not safe \(foreign_key:payslip_staff_id_fkey:payslip\)/));
    expect(await userRow(target)).toEqual({ deleted: true });
    expect(await countIn('staff_profile', sp)).toBe(1);
    expect(await countIn('payslip', payslip)).toBe(1);
  });

  it('approved payroll evidence (F3): the invite with a paid shift is soft-deleted; the user row and every evidence row stay', async () => {
    const q = w.schema;
    const target = await invited('paid');
    const { venue, role } = await venueAndRole('paid');
    const sp = await one(`INSERT INTO ${q}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, target, `PAID-${SFX}`]);
    const shift = await one(
      `INSERT INTO ${q}.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by)
       VALUES ($1, $2, $3, $4, now() - interval '5 hours', now() - interval '1 hour', 1, 1200, $5) RETURNING id`,
      [w.org, w.id, venue, role, w.owner],
    );
    const sa = await one(
      `INSERT INTO ${q}.shift_assignment(organisation_id, workspace_id, shift_id, staff_profile_id, pay_rate_snapshot_pence, period)
       VALUES ($1, $2, $3, $4, 1200, tstzrange(now() - interval '5 hours', now() - interval '1 hour')) RETURNING id`,
      [w.org, w.id, shift, sp],
    );
    const att = await one(
      `INSERT INTO ${q}.attendance(organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
       VALUES ($1, $2, $3, $4, $5, now() - interval '5 hours', now() - interval '1 hour', 'approved') RETURNING id`,
      [w.org, w.id, sa, shift, sp],
    );
    const pr = await one(
      `INSERT INTO ${q}.payroll_record(organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence,
                                      amount_pence, status, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, 240, 1200, 4800, 'approved', now(), $6) RETURNING id`,
      [w.org, w.id, att, shift, sp, w.owner],
    );
    expect(await deleteAsOwner(target)).toBe('soft_deleted');
    expect(await userRow(target)).toEqual({ deleted: true });
    for (const [table, id] of [['staff_profile', sp], ['shift_assignment', sa], ['attendance', att], ['payroll_record', pr]] as const) {
      expect(await countIn(table, id)).toBe(1);
    }
  });

  it('down() of WorkspaceCoreForeignKeyRemoval1786721490000 refuses while a level-22 workspace exists (nothing changed)', async () => {
    const bodies = async () =>
      (await admin.query(`SELECT pg_catalog.md5(p.prosrc) AS h FROM pg_catalog.pg_proc p WHERE p.oid IN ('core.provision_workspace(uuid)'::regprocedure, 'core.verify_workspace_schema_v1(uuid)'::regprocedure) ORDER BY 1`)).rows;
    const before = await bodies();
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceCoreForeignKeyRemoval1786721490000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 22/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await bodies()).toEqual(before);
  });
});
