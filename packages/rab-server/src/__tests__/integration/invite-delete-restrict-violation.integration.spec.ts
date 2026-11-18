import 'reflect-metadata';
import { Client } from 'pg';
import type { QueryRunner } from 'typeorm';

import {
  INVITE_DELETE_BODY_HASH_FK_ONLY,
  INVITE_DELETE_BODY_HASH_RESTRICT,
  INVITE_DELETE_BODY_HASH_SQL,
  INVITE_DELETE_EXPECTED_STATE,
  INVITE_DELETE_RESTRICT_VIOLATION_SQL,
  INVITE_DELETE_STATE_SQL,
} from '../../database/typeorm/core/invite-delete-restrict-violation-sql';
import { InviteDeleteRestrictViolation1786721580000 } from '../../database/typeorm/core/migrations/1786721580000-InviteDeleteRestrictViolation';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * InviteDeleteRestrictViolation1786721580000 (PR #227 follow-up): on PostgreSQL 18 a RESTRICT foreign key reports 23001
 * (restrict_violation), which core.worker_delete_expired_invited_user(uuid) did not catch. The scenario is real, not a
 * fixture key: an expired invitee whose core staff profile has APPROVED payroll evidence. Deleting the user cascades to
 * the staff profile, and the payroll_record parent keys are ON DELETE RESTRICT (PayrollEvidenceRestrict1786719700000), so
 * the delete is refused — 23503 on 16/17, 23001 on 18. The definer must answer 'referenced' on every major and delete nothing.
 *
 * Direct SQL as the bootstrap SUPERUSER (the definer runs as its owner rab_secure_owner either way). Not opt-in: it runs in
 * every server job, so the per-major CI jobs (16/17/18) cover it. The migration's down()/up() round trip runs inside a
 * rolled-back transaction and doubles as the fail-first proof: with the 1786721520000 body PostgreSQL 18 raises 23001.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(120_000);

describeIfDb('invite cleanup definer: a RESTRICT refusal is "referenced" on every supported major (1786721580000)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const suffix = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  let major = 0;
  let invitee: string;
  let payrollRecord: string;
  let staffProfile: string;

  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ACCEPTED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO-CODE';
    }
  };
  const callDefiner = async () => (await admin.query('SELECT core.worker_delete_expired_invited_user($1) AS r', [invitee])).rows[0].r as string;
  const bodyHash = async () => (await admin.query(INVITE_DELETE_BODY_HASH_SQL)).rows[0]?.body_hash as string | undefined;
  const runner = { query: async (sql: string, params?: unknown[]) => (await admin.query(sql, params)).rows } as unknown as QueryRunner;
  const intact = async () => {
    expect((await admin.query(`SELECT status FROM core."user" WHERE id = $1`, [invitee])).rows[0]?.status).toBe('invite_expired');
    expect((await admin.query(`SELECT count(*)::int AS n FROM core.account_invite WHERE user_id = $1`, [invitee])).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM core.staff_profile WHERE id = $1`, [staffProfile])).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM core.payroll_record WHERE id = $1`, [payrollRecord])).rows[0].n).toBe(1);
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const [{ rolsuper }] = (await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows;
    if (!rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    major = Math.floor(Number((await admin.query(`SELECT current_setting('server_version_num')::int AS n`)).rows[0].n) / 10000);

    // An organisation, its owner and a workspace row (core business tables need one), then the invitee in that organisation:
    // never signed in, no session, third invite expired 9 days ago, cleanup due 2 days ago — eligible for the hard delete.
    const tag = `idrv-${suffix}`;
    const ws = (
      await admin.query(
        `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id),
              u AS (INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
                    SELECT id, $1::text || '@idrv.invalid', 'IDRV', 'Owner', 'active' FROM o RETURNING id, organisation_id)
         INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
         SELECT organisation_id, id, $1::text, $1::text, 'active', 'CREATING' FROM u RETURNING id, organisation_id, owner_user_id`,
        [tag],
      )
    ).rows[0] as { id: string; organisation_id: string; owner_user_id: string };
    invitee = await one(
      `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'IDRV', 'Invitee', 'invite_expired') RETURNING id`,
      [ws.organisation_id, `${tag}-invitee@idrv.invalid`],
    );
    await admin.query(
      `INSERT INTO core.account_invite (organisation_id, user_id, token_hash, send_number, expires_at, cleanup_at)
       VALUES ($1, $2, md5(random()::text || clock_timestamp()::text), 3, now() - interval '9 days', now() - interval '2 days')`,
      [ws.organisation_id, invitee],
    );
    // The invitee's staff profile with approved payroll evidence (the shift and the approval belong to the owner).
    const venue = await one(`INSERT INTO core.venue(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [ws.organisation_id, ws.id, `IDRV venue ${suffix}`]);
    const role = await one(`INSERT INTO core.job_role(organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [ws.organisation_id, ws.id, `IDRV role ${suffix}`]);
    staffProfile = await one(
      `INSERT INTO core.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ws.organisation_id, ws.id, invitee, `IDRV-${suffix}`],
    );
    const shift = await one(
      `INSERT INTO core.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by)
       VALUES ($1, $2, $3, $4, now() - interval '5 hours', now() - interval '1 hour', 1, 1200, $5) RETURNING id`,
      [ws.organisation_id, ws.id, venue, role, ws.owner_user_id],
    );
    const sa = await one(
      `INSERT INTO core.shift_assignment(organisation_id, workspace_id, shift_id, staff_profile_id, pay_rate_snapshot_pence, period)
       VALUES ($1, $2, $3, $4, 1200, tstzrange(now() - interval '5 hours', now() - interval '1 hour')) RETURNING id`,
      [ws.organisation_id, ws.id, shift, staffProfile],
    );
    const att = await one(
      `INSERT INTO core.attendance(organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
       VALUES ($1, $2, $3, $4, $5, now() - interval '5 hours', now() - interval '1 hour', 'approved') RETURNING id`,
      [ws.organisation_id, ws.id, sa, shift, staffProfile],
    );
    payrollRecord = await one(
      `INSERT INTO core.payroll_record(organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence,
                                       amount_pence, status, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, 240, 1200, 4800, 'approved', now(), $6) RETURNING id`,
      [ws.organisation_id, ws.id, att, shift, staffProfile, ws.owner_user_id],
    );
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('the scenario really is a RESTRICT refusal: deleting the invitee directly fails with 23001 on 18 and 23503 on 16/17', async () => {
    expect([16, 17, 18]).toContain(major);
    expect(await codeOf(admin.query(`DELETE FROM core."user" WHERE id = $1`, [invitee]))).toBe(major >= 18 ? '23001' : '23503');
    await intact();
  });

  it('the installed definer is the fixed body, with the owner, ACL and shape 1786721520000 left', async () => {
    expect(await bodyHash()).toBe(INVITE_DELETE_BODY_HASH_RESTRICT);
    expect((await admin.query(INVITE_DELETE_STATE_SQL)).rows[0].state).toBe(INVITE_DELETE_EXPECTED_STATE);
  });

  it('the definer answers "referenced" for the referenced invitee and deletes nothing (every major)', async () => {
    expect(await callDefiner()).toBe('referenced');
    await intact();
  });

  it('down()/up() round trip (rolled back): with the 1786721520000 body PostgreSQL 18 raises 23001; up() restores "referenced"; an unknown body is refused', async () => {
    const migration = new InviteDeleteRestrictViolation1786721580000();
    await admin.query('BEGIN');
    try {
      await migration.down(runner);
      expect(await bodyHash()).toBe(INVITE_DELETE_BODY_HASH_FK_ONLY);
      await admin.query('SAVEPOINT before_call');
      // Fail-first: the old handler catches 23503 only.
      expect(await codeOf(callDefiner())).toBe(major >= 18 ? '23001' : 'ACCEPTED');
      await admin.query('ROLLBACK TO SAVEPOINT before_call');
      if (major < 18) expect(await callDefiner()).toBe('referenced');

      await migration.up(runner);
      expect(await bodyHash()).toBe(INVITE_DELETE_BODY_HASH_RESTRICT);
      expect((await admin.query(INVITE_DELETE_STATE_SQL)).rows[0].state).toBe(INVITE_DELETE_EXPECTED_STATE);
      expect(await callDefiner()).toBe('referenced');
      await migration.up(runner); // idempotent re-run on its own body
      expect(await bodyHash()).toBe(INVITE_DELETE_BODY_HASH_RESTRICT);

      // A body the migration does not know (hand-altered) is refused before any replace, in both directions.
      await admin.query(INVITE_DELETE_RESTRICT_VIOLATION_SQL.replace("RETURN 'deleted';", "RETURN 'deleted'; -- altered"));
      const altered = await bodyHash();
      await expect(migration.up(runner)).rejects.toThrow(/unknown body/);
      await expect(migration.down(runner)).rejects.toThrow(/unknown body/);
      expect(await bodyHash()).toBe(altered);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await bodyHash()).toBe(INVITE_DELETE_BODY_HASH_RESTRICT);
    await intact();
  });
});
