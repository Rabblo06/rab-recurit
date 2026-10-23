import 'reflect-metadata';
import { Client } from 'pg';

import { PayrollEvidenceRestrict1786719700000 } from '../../database/typeorm/core/migrations/1786719700000-PayrollEvidenceRestrict';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { provisionWorkspaceSchema } from '../../database/typeorm/workspace-schema/provision-workspace-schema';
import { PAYROLL_EVIDENCE_FKS } from '../../database/typeorm/workspace-schema/v1/payroll-evidence-restrict';

/**
 * F3 (Wave 1 lane S, migration PayrollEvidenceRestrict1786719700000): approved payroll evidence can no longer be deleted by
 * deleting the staff profile, user, shift, booking or attendance it points at — in `core` AND in a workspace schema built by
 * either provisioning path. Direct SQL as the bootstrap SUPERUSER (no RLS, the most privileged identity there is): if it
 * cannot remove the evidence, no application path can. Each refused delete must be SQLSTATE 23503 and leave every row in
 * place. The runtime role still has no DELETE on payroll rows at all (42501).
 *
 * Also proves the change is narrow: a staff profile WITHOUT payroll history still deletes exactly as before (its unpaid
 * bookings/attendance cascade), and the migration's down()/up() round trip restores CASCADE and the 1786719500000 function
 * body byte for byte (inside a rolled-back transaction).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(120_000);

interface Chain {
  staffUser: string;
  sp: string;
  shift: string;
  sa: string;
  att: string;
  pr: string | null;
}

describeIfDb('F3: payroll evidence is never deleted by cascade (core + workspace schemas)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const suffix = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  let ws: { id: string; org: string; owner: string; schema: string };
  let legacy: { id: string; org: string; owner: string; schema: string };

  const seedWorkspace = async (label: string) => {
    const r = await admin.query(
      `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
            u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                  SELECT id, $1::text || '@f3.invalid', 'F3', 'Owner', 'active' FROM o RETURNING id, organisation_id)
       INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
       SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id`,
      [`f3-${label}-${suffix}`],
    );
    const row = r.rows[0];
    return { id: row.id as string, org: row.organisation_id as string, owner: row.owner_user_id as string, schema: `workspace_${String(row.id).replace(/-/g, '')}` };
  };

  /** One staff member's full chain in schema `q`; with `paid` an APPROVED payroll record points at it. */
  const seedChain = async (q: string, w: typeof ws, label: string, paid: boolean): Promise<Chain> => {
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
    const staffUser = await one(
      `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'F3', 'Staff', 'active') RETURNING id`,
      [w.org, `f3-${label}-${suffix}@f3.invalid`],
    );
    const venue = await one(`INSERT INTO ${q}.venue(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `F3 venue ${label}`]);
    const role = await one(`INSERT INTO ${q}.job_role(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `F3 role ${label}`]);
    const sp = await one(
      `INSERT INTO ${q}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, $4) RETURNING id`,
      [w.org, w.id, staffUser, `F3-${label}`],
    );
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
    const pr = paid
      ? await one(
          `INSERT INTO ${q}.payroll_record(organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence,
                                          amount_pence, status, approved_at, approved_by)
           VALUES ($1, $2, $3, $4, $5, 240, 1200, 4800, 'approved', now(), $6) RETURNING id`,
          [w.org, w.id, att, shift, sp, w.owner],
        )
      : null;
    return { staffUser, sp, shift, sa, att, pr };
  };

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO-CODE';
    }
  };
  const exists = async (q: string, table: string, id: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${q}.${table} WHERE id = $1`, [id])).rows[0].n === 1;
  const fkActions = async (schema: string) =>
    (
      await admin.query(
        `SELECT conname, confdeltype::text AS action FROM pg_constraint
          WHERE conrelid = format('%I.payroll_record', $1::text)::regclass AND conname = ANY($2::text[]) ORDER BY conname`,
        [schema, PAYROLL_EVIDENCE_FKS.map((f) => f.name)],
      )
    ).rows;
  const allRestrict = PAYROLL_EVIDENCE_FKS.map((f) => ({ conname: f.name, action: 'r' })).sort((a, b) => a.conname.localeCompare(b.conname));

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const [{ rolsuper }] = (await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows;
    if (!rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');

    // Server path: core.provision_workspace as crewflow_app with the server-bound GUCs.
    ws = await seedWorkspace('srv');
    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [ws.org, ws.owner]);
      const { rows } = await app.query('SELECT core.provision_workspace($1) AS o', [ws.id]);
      await app.query('COMMIT');
      expect(rows[0].o).toBe('READY');
    } finally {
      await app.end();
    }

    // Legacy path: the TypeScript provisioner as crewflow (rollback artifact, also used by the Worker reconciler).
    legacy = await seedWorkspace('ts');
    const crewflow = new Client({ connectionString: adminUrl });
    await crewflow.connect();
    try {
      await crewflow.query('SET ROLE crewflow');
      expect((await provisionWorkspaceSchema(crewflow, legacy.id)).outcome).toBe('READY');
    } finally {
      await crewflow.end();
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('core and every workspace schema have the three payroll_record parent FKs as ON DELETE RESTRICT (both provisioning paths)', async () => {
    expect(await fkActions('core')).toEqual(allRestrict);
    expect(await fkActions(ws.schema)).toEqual(allRestrict);
    expect(await fkActions(legacy.schema)).toEqual(allRestrict);
    const { rows } = await admin.query(
      `SELECT n.nspname, k.conname, k.confdeltype::text AS action FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
        WHERE (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$') AND k.conname = ANY($1::text[]) AND k.confdeltype <> 'r'`,
      [PAYROLL_EVIDENCE_FKS.map((f) => f.name)],
    );
    expect(rows).toEqual([]);
  });

  for (const where of ['core', 'workspace (server path)', 'workspace (TypeScript provisioner)'] as const) {
    describe(where, () => {
      let q: string;
      let w: typeof ws;
      let paid: Chain;
      let unpaid: Chain;

      beforeAll(async () => {
        w = where === 'workspace (TypeScript provisioner)' ? legacy : ws;
        q = where === 'core' ? 'core' : `"${w.schema}"`;
        const tag = where === 'core' ? 'c' : where.includes('server') ? 's' : 't';
        paid = await seedChain(q, w, `${tag}-paid`, true);
        unpaid = await seedChain(q, w, `${tag}-unpaid`, false);
      });

      const evidenceIntact = async () => {
        expect(await exists(q, 'payroll_record', paid.pr!)).toBe(true);
        expect(await exists(q, 'attendance', paid.att)).toBe(true);
        expect(await exists(q, 'shift_assignment', paid.sa)).toBe(true);
        expect(await exists(q, 'shift', paid.shift)).toBe(true);
        expect(await exists(q, 'staff_profile', paid.sp)).toBe(true);
      };

      it('deleting the staff profile of approved payroll fails with 23503 and deletes nothing', async () => {
        expect(await codeOf(admin.query(`DELETE FROM ${q}.staff_profile WHERE id = $1`, [paid.sp]))).toBe('23503');
        await evidenceIntact();
      });

      it('deleting the staff member\'s user account (core."user" → staff_profile CASCADE) fails with 23503', async () => {
        expect(await codeOf(admin.query(`DELETE FROM core."user" WHERE id = $1`, [paid.staffUser]))).toBe('23503');
        await evidenceIntact();
      });

      it('deleting the shift fails with 23503 and deletes nothing', async () => {
        expect(await codeOf(admin.query(`DELETE FROM ${q}.shift WHERE id = $1`, [paid.shift]))).toBe('23503');
        await evidenceIntact();
      });

      it('deleting the booking (shift_assignment → attendance CASCADE) fails with 23503', async () => {
        expect(await codeOf(admin.query(`DELETE FROM ${q}.shift_assignment WHERE id = $1`, [paid.sa]))).toBe('23503');
        await evidenceIntact();
      });

      it('deleting the attendance row fails with 23503 and deletes nothing', async () => {
        expect(await codeOf(admin.query(`DELETE FROM ${q}.attendance WHERE id = $1`, [paid.att]))).toBe('23503');
        await evidenceIntact();
      });

      it('the restricted runtime role still has no DELETE on payroll rows at all (42501)', async () => {
        const app = new Client({ connectionString: appUrl });
        await app.connect();
        try {
          await app.query('BEGIN');
          await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
            w.org,
            w.id,
            w.owner,
          ]);
          expect(await codeOf(app.query(`DELETE FROM ${q}.payroll_record WHERE id = $1`, [paid.pr]))).toBe('42501');
          await app.query('ROLLBACK');
        } finally {
          await app.end();
        }
        await evidenceIntact();
      });

      it('narrow change: a staff profile with NO payroll history still deletes as before (its unpaid booking and attendance cascade)', async () => {
        await admin.query(`DELETE FROM ${q}.staff_profile WHERE id = $1`, [unpaid.sp]);
        expect(await exists(q, 'staff_profile', unpaid.sp)).toBe(false);
        expect(await exists(q, 'shift_assignment', unpaid.sa)).toBe(false);
        expect(await exists(q, 'attendance', unpaid.att)).toBe(false);
        await evidenceIntact();
      });
    });
  }

  it('the migration down() restores CASCADE and the 1786719500000 function body exactly; up() re-applies RESTRICT (rolled back)', async () => {
    const runner = { query: async (sql: string, params?: unknown[]) => (await admin.query(sql, params as unknown[])).rows } as never;
    const body = async () => (await admin.query(`SELECT md5(prosrc) AS h, prosrc FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows[0];
    const acl = async () =>
      (await admin.query(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig, proacl::text FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows[0];
    const restrictLine = 'REFERENCES "workspace_00000000000000000000000000000000".staff_profile(id, workspace_id) ON DELETE RESTRICT';
    const before = await body();
    const aclBefore = await acl();
    expect(before.prosrc).toContain(restrictLine);
    await admin.query('BEGIN');
    try {
      await new PayrollEvidenceRestrict1786719700000().down(runner);
      expect((await fkActions('core')).map((r: { action: string }) => r.action)).toEqual(['c', 'c', 'c']);
      expect((await fkActions(ws.schema)).map((r: { action: string }) => r.action)).toEqual(['c', 'c', 'c']);
      const down = await body();
      expect(down.prosrc).not.toContain(restrictLine);
      expect(down.prosrc).toContain('REFERENCES "workspace_00000000000000000000000000000000".staff_profile(id, workspace_id) ON DELETE CASCADE');
      expect(await acl()).toEqual(aclBefore);
      await new PayrollEvidenceRestrict1786719700000().up(runner);
      expect(await fkActions('core')).toEqual(allRestrict);
      expect(await fkActions(ws.schema)).toEqual(allRestrict);
      expect((await body()).h).toBe(before.h);
      expect(await acl()).toEqual(aclBefore);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await body()).h).toBe(before.h);
  });
});
