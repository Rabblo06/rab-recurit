import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { corePolicyStateSql, PAYSLIP_OWN_PAY_HASHES } from '../../database/typeorm/workspace-schema/payslip-own-pay-rls-sql';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Owner decision 51 (DRAFT SQL, throwaway database only): PayslipOwnPayRls1786723000000, the database layer under
 * PayrollRunService's own-pay refusals on the core copies (HWS off, production today). As the RUNTIME login, with one finalised
 * run holding two payslips — the own payslip of Manager M (who is also a staff member of the workspace) and Staff S's:
 *  - M cannot update their own payslip (net set / net clear / version bump / paid) and cannot add a document to it (42501);
 *  - M can still update S's payslip, and M's document INSERT for S's payslip passes RLS (it then fails only on the fake file FK);
 *  - another manager of the workspace can update M's payslip;
 *  - no tenant context reads no payslip.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('decision 51: payslip own-pay RLS (integration, throwaway database)', () => {
  const resolved = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let w: SeededWorkspace;
  const users = { m: '', s: '', m2: '' };
  const slips = { m: '', s: '' };

  beforeAll(async () => {
    admin = new Client({ connectionString: resolved.adminUrl });
    app = new Client({ connectionString: resolved.appUrl });
    await admin.connect();
    await app.connect();
    w = await seedWorkspace(admin, `ownpay-${SFX}`);
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
    for (const k of Object.keys(users) as Array<keyof typeof users>) {
      users[k] = await one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'OwnPay', $3, 'active') RETURNING id`, [
        w.org,
        `ownpay-${k}-${SFX}@ownpay.invalid`,
        k,
      ]);
    }
    const profile = (user: string, label: string) =>
      one(`INSERT INTO core.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        w.org,
        w.id,
        user,
        `OWNPAY-${label}-${SFX}`,
        w.owner,
      ]);
    const profileM = await profile(users.m, 'm');
    const profileS = await profile(users.s, 's');
    for (const u of [users.m, users.m2]) {
      await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [w.org, u, w.id]);
    }
    const calendar = await one(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2031, 1, 'own-pay test', $2) RETURNING id`, [
      w.org,
      w.owner,
    ]);
    const period = await one(
      `INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, '2031-01-06', '2031-01-19', '2031-01-29') RETURNING id`,
      [w.org, calendar],
    );
    const run = await one(
      `INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, status, prepared_by, finalised_at, finalised_by) VALUES ($1, $2, $3, 'finalised', $4, now(), $4) RETURNING id`,
      [w.org, w.id, period, users.m2],
    );
    slips.m = await one(`INSERT INTO core.payslip (organisation_id, workspace_id, run_id, staff_profile_id) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, run, profileM]);
    slips.s = await one(`INSERT INTO core.payslip (organisation_id, workspace_id, run_id, staff_profile_id) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, run, profileS]);
  });

  afterAll(async () => {
    for (const table of ['payslip_document', 'payslip', 'payroll_run', 'payroll_calendar_period', 'payroll_calendar', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  /** Runs `fn` as the runtime login with the given GUCs, inside a transaction that is always rolled back. */
  const as = async <T>(user: string | null, fn: () => Promise<T>): Promise<T> => {
    await app.query('BEGIN');
    try {
      if (user !== null) {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [w.org, w.id, user]);
      }
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const update = (user: string, slip: string, set: string) => as(user, async () => (await app.query(`UPDATE core.payslip SET ${set}, updated_at = now() WHERE id = $1`, [slip])).rowCount);
  const insertDocument = (user: string, slip: string) =>
    as(user, () =>
      app.query(
        `INSERT INTO core.payslip_document (organisation_id, workspace_id, payslip_id, version, file_id, sha256, uploaded_by) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [w.org, w.id, slip, randomUUID(), 'a'.repeat(64), user],
      ),
    );

  it('runs as the configured runtime login, which is neither SUPERUSER nor BYPASSRLS (what the policy binds)', async () => {
    const { rows } = await app.query(`SELECT current_user = $1 AS is_runtime, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`, [
      resolved.app.login,
    ]);
    expect(rows[0]).toMatchObject({ is_runtime: true, su: false, bypass: false });
  });

  it('the migration left exactly the reviewed expressions on both core policies', async () => {
    const [u] = (await admin.query(corePolicyStateSql('payslip', 'payslip_update'))).rows;
    expect(u).toMatchObject({ using_hash: PAYSLIP_OWN_PAY_HASHES.updateUsing, check_hash: PAYSLIP_OWN_PAY_HASHES.updateCheckAfter, permissive: true, cmd: 'w', to_public: true });
    const [d] = (await admin.query(corePolicyStateSql('payslip_document', 'payslip_document_insert'))).rows;
    expect(d).toMatchObject({ using_hash: null, check_hash: PAYSLIP_OWN_PAY_HASHES.documentInsertCheckAfter, permissive: true, cmd: 'a', to_public: true });
  });

  it('a manager cannot set or clear net pay, bump the version or mark paid on their OWN payslip (42501)', async () => {
    const own = [
      `net_pence = 1, net_source = 'provider_document', net_recorded_by = '${users.m}', net_recorded_at = now()`,
      `net_pence = NULL, net_source = NULL, net_recorded_by = NULL, net_recorded_at = NULL`,
      `version = version + 1`,
      `paid_at = now(), paid_by = '${users.m}'`,
    ];
    for (const set of own) await expect(update(users.m, slips.m, set)).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query(`SELECT version, net_pence, paid_at FROM core.payslip WHERE id = $1`, [slips.m])).rows[0]).toEqual({ version: 0, net_pence: null, paid_at: null });
  });

  it('a manager cannot add a document to their OWN payslip (42501, before any FK check)', async () => {
    await expect(insertDocument(users.m, slips.m)).rejects.toMatchObject({ code: '42501' });
  });

  it("the same manager may still administer another staff member's payslip", async () => {
    expect(await update(users.m, slips.s, `net_pence = 9000, net_source = 'provider_document', net_recorded_by = '${users.m}', net_recorded_at = now()`)).toBe(1);
    expect(await update(users.m, slips.s, `version = version + 1`)).toBe(1);
    // RLS admits the row; only the (deliberately fake) stored_file reference then fails, as a foreign-key violation.
    await expect(insertDocument(users.m, slips.s)).rejects.toMatchObject({ code: '23503' });
  });

  it("another manager of the workspace may administer the first manager's payslip", async () => {
    expect(await update(users.m2, slips.m, `net_pence = 100, net_source = 'provider_document', net_recorded_by = '${users.m2}', net_recorded_at = now()`)).toBe(1);
    await expect(insertDocument(users.m2, slips.m)).rejects.toMatchObject({ code: '23503' });
  });

  it('a staff member who is not a manager still cannot write any payslip; no tenant context reads none', async () => {
    expect(await update(users.s, slips.s, `version = version + 1`)).toBe(0);
    await expect(insertDocument(users.s, slips.s)).rejects.toMatchObject({ code: '42501' });
    expect(await as(null, async () => (await app.query(`SELECT id FROM core.payslip WHERE id = ANY($1::uuid[])`, [[slips.m, slips.s]])).rows)).toEqual([]);
  });
});
