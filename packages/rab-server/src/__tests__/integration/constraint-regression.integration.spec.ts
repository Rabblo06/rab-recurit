import 'reflect-metadata';
import * as shared from '@rab/shared';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, SeededWorkspace, seedWorkspace, sqlstateOf } from './helpers/workspace-fixtures';

/**
 * Wave 2 lane S2 (C1 constraints, C2 enum/state parity, CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.10–3.12).
 *
 * C1: every critical domain constraint is asserted BY SQLSTATE in `core` AND in a workspace schema built by EACH
 * provisioning path. Writes run as the disposable database's bootstrap superuser (no RLS, the most privileged identity):
 * if the constraint stops it, it stops every application path. Each case runs in a rolled-back transaction.
 *   23P01 double booking (shift_assignment_no_double_booking), payroll period overlap (core only)
 *   23505 one active attendance per staff, one payroll record per attendance, one booking per (shift, staff),
 *         one active payroll calendar per year (core only)
 *   23514 shift time order, capacity, negative pay snapshot, negative payroll figures, the NEW attendance money CHECKs,
 *         the workspace binding CHECK (workspace schemas only)
 * C2: every state-transition table in @rab/shared equals the DB CHECK list of its column, in core and every workspace.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

interface Base {
  q: string;
  ws: SeededWorkspace;
  sp: string;
  sp2: string;
  venue: string;
  role: string;
  shiftA: string;
  shiftB: string;
}

describeIfDb('constraint + state regression in core and every workspace schema (C1/C2)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const sfx = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  let srv: SeededWorkspace;
  let ts: SeededWorkspace;
  const bases = new Map<string, Base>();

  const one = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;

  const buildBase = async (q: string, ws: SeededWorkspace, tag: string): Promise<Base> => {
    const user = async (n: string) =>
      one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'C', 'R', 'active') RETURNING id`, [
        ws.org,
        `cr-${tag}-${n}-${sfx}@s2.invalid`,
      ]);
    const venue = await one(`INSERT INTO ${q}.venue(organisation_id, workspace_id, name) VALUES ($1, $2, 'v') RETURNING id`, [ws.org, ws.id]);
    const role = await one(`INSERT INTO ${q}.job_role(organisation_id, workspace_id, name) VALUES ($1, $2, 'r') RETURNING id`, [ws.org, ws.id]);
    const sp = await one(`INSERT INTO ${q}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, 'S1') RETURNING id`, [
      ws.org, ws.id, await user('s1'),
    ]);
    const sp2 = await one(`INSERT INTO ${q}.staff_profile(organisation_id, workspace_id, user_id, staff_ref) VALUES ($1, $2, $3, 'S2') RETURNING id`, [
      ws.org, ws.id, await user('s2'),
    ]);
    const shift = (from: string, to: string) =>
      one(
        `INSERT INTO ${q}.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by)
         VALUES ($1, $2, $3, $4, now() + $5::interval, now() + $6::interval, 2, 1200, $7) RETURNING id`,
        [ws.org, ws.id, venue, role, from, to, ws.owner],
      );
    return { q, ws, sp, sp2, venue, role, shiftA: await shift('1 day', '1 day 4 hours'), shiftB: await shift('1 day 2 hours', '1 day 6 hours') };
  };

  /** Runs `fn` in a transaction that is always rolled back; returns the SQLSTATE of the LAST statement it awaits. */
  const inRollback = async (fn: () => Promise<unknown>): Promise<string> => {
    await admin.query('BEGIN');
    try {
      return await sqlstateOf(fn());
    } finally {
      await admin.query('ROLLBACK');
    }
  };
  const assignment = (b: Base, shift: string, sp: string, status = 'confirmed', from = '1 day', to = '1 day 4 hours', rate = 1200) =>
    one(
      `INSERT INTO ${b.q}.shift_assignment(organisation_id, workspace_id, shift_id, staff_profile_id, pay_rate_snapshot_pence, period, status)
       VALUES ($1, $2, $3, $4, $8, tstzrange(now() + $5::interval, now() + $6::interval), $7) RETURNING id`,
      [b.ws.org, b.ws.id, shift, sp, from, to, status, rate],
    );
  const attendance = (b: Base, sa: string, shift: string, sp: string, status: string, extra: { earned?: number; minutes?: number } = {}) =>
    one(
      `INSERT INTO ${b.q}.attendance(organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status, earned_pence, worked_minutes)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8) RETURNING id`,
      [b.ws.org, b.ws.id, sa, shift, sp, status, extra.earned ?? null, extra.minutes ?? null],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
      throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    }
    srv = await seedWorkspace(admin, `s2c-srv-${sfx}`);
    ts = await seedWorkspace(admin, `s2c-ts-${sfx}`);
    expect(await provisionServerPath(appUrl, srv)).toBe('READY');
    expect(await provisionTypeScript(adminUrl, ts)).toBe('READY');
    bases.set('core', await buildBase('core', srv, 'core'));
    bases.set('workspace (server path)', await buildBase(`"${srv.schema}"`, srv, 'srv'));
    bases.set('workspace (TypeScript provisioner)', await buildBase(`"${ts.schema}"`, ts, 'ts'));
  });

  afterAll(async () => {
    for (const ws of [srv, ts]) if (ws) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    await admin?.end();
  });

  for (const where of ['core', 'workspace (server path)', 'workspace (TypeScript provisioner)']) {
    describe(where, () => {
      const b = () => bases.get(where)!;

      it('23P01: one staff member cannot hold two overlapping confirmed bookings (shift_assignment_no_double_booking)', async () => {
        expect(
          await inRollback(async () => {
            await assignment(b(), b().shiftA, b().sp);
            return assignment(b(), b().shiftB, b().sp, 'confirmed', '1 day 2 hours', '1 day 6 hours');
          }),
        ).toBe('23P01');
        // Control: a different staff member, or a non-binding status, is accepted.
        expect(
          await inRollback(async () => {
            await assignment(b(), b().shiftA, b().sp);
            await assignment(b(), b().shiftB, b().sp, 'offered', '1 day 2 hours', '1 day 6 hours');
            return assignment(b(), b().shiftB, b().sp2, 'confirmed', '1 day 2 hours', '1 day 6 hours');
          }),
        ).toBe('ACCEPTED');
      });

      it('23505: one booking per (shift, staff) and one active attendance per staff', async () => {
        expect(await inRollback(async () => {
          await assignment(b(), b().shiftA, b().sp, 'offered');
          return assignment(b(), b().shiftA, b().sp, 'offered');
        })).toBe('23505');
        expect(
          await inRollback(async () => {
            const a1 = await assignment(b(), b().shiftA, b().sp, 'offered');
            const a2 = await assignment(b(), b().shiftB, b().sp, 'offered', '1 day 2 hours', '1 day 6 hours');
            await attendance(b(), a1, b().shiftA, b().sp, 'clocked_in');
            return attendance(b(), a2, b().shiftB, b().sp, 'on_break');
          }),
        ).toBe('23505');
      });

      it('23505: one payroll record per attendance (payroll_record_attendance_id_key)', async () => {
        expect(
          await inRollback(async () => {
            const sa = await assignment(b(), b().shiftA, b().sp);
            const att = await attendance(b(), sa, b().shiftA, b().sp, 'approved');
            const pr = (n: number) =>
              admin.query(
                `INSERT INTO ${b().q}.payroll_record(organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence, amount_pence, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 1200, 4800, 'draft')`,
                [b().ws.org, b().ws.id, att, b().shiftA, b().sp, n],
              );
            await pr(240);
            return pr(241);
          }),
        ).toBe('23505');
      });

      it('23514: shift time order, capacity, negative pay snapshot, negative payroll figures', async () => {
        const shift = (sql: string) =>
          inRollback(() =>
            admin.query(
              `INSERT INTO ${b().q}.shift(organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, filled_count)
               ${sql}`,
              [b().ws.org, b().ws.id, b().venue, b().role, b().ws.owner],
            ),
          );
        expect(await shift(`VALUES ($1, $2, $3, $4, now(), now() - interval '1 hour', 1, 1200, $5, 0)`)).toBe('23514');
        expect(await shift(`VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour', 1, 1200, $5, 2)`)).toBe('23514');
        expect(await shift(`VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour', 1, -1, $5, 0)`)).toBe('23514');
        expect(await inRollback(() => assignment(b(), b().shiftA, b().sp, 'offered', '1 day', '1 day 4 hours', -5))).toBe('23514');
        expect(
          await inRollback(async () => {
            const sa = await assignment(b(), b().shiftA, b().sp);
            const att = await attendance(b(), sa, b().shiftA, b().sp, 'approved');
            return admin.query(
              `INSERT INTO ${b().q}.payroll_record(organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence, amount_pence, status)
               VALUES ($1, $2, $3, $4, $5, 240, 1200, -1, 'draft')`,
              [b().ws.org, b().ws.id, att, b().shiftA, b().sp],
            );
          }),
        ).toBe('23514');
      });

      it('23514: the new attendance money CHECKs refuse negative earned_pence / worked_minutes (zero and NULL pass)', async () => {
        const att = (extra: { earned?: number; minutes?: number }) =>
          inRollback(async () => attendance(b(), await assignment(b(), b().shiftA, b().sp), b().shiftA, b().sp, 'clocked_out', extra));
        expect(await att({ earned: -1 })).toBe('23514');
        expect(await att({ minutes: -1 })).toBe('23514');
        expect(await att({ earned: 0, minutes: 0 })).toBe('ACCEPTED');
        expect(await att({})).toBe('ACCEPTED');
        const { rows } = await admin.query(
          `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = format('%s.attendance', $1::text)::regclass
              AND conname IN ('attendance_earned_pence_non_negative', 'attendance_worked_minutes_non_negative') ORDER BY 1`,
          [b().q],
        );
        expect(rows).toEqual([
          { conname: 'attendance_earned_pence_non_negative', convalidated: true },
          { conname: 'attendance_worked_minutes_non_negative', convalidated: true },
        ]);
      });

      if (where !== 'core') {
        it('23514: a row for another workspace cannot enter this workspace schema (workspace binding CHECK)', async () => {
          const other = where.includes('server') ? ts : srv;
          expect(
            await inRollback(() =>
              admin.query(`INSERT INTO ${b().q}.venue(organisation_id, workspace_id, name) VALUES ($1, $2, 'x')`, [other.org, other.id]),
            ),
          ).toBe('23514');
        });
      }
    });
  }

  it('core: 23P01 overlapping active payroll periods, 23505 two active calendars for one year', async () => {
    const cal = (year: number) =>
      one(
        `INSERT INTO core.payroll_calendar(organisation_id, year, version, source, created_by) VALUES ($1, $2,
           (SELECT coalesce(max(version), 0) + 1 FROM core.payroll_calendar WHERE organisation_id = $1 AND year = $2), 'test', $3) RETURNING id`,
        [srv.org, year, srv.owner],
      );
    const period = (calendar: string, start: string, end: string) =>
      admin.query(
        `INSERT INTO core.payroll_calendar_period(organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, $3::date, $4::date, $4::date)`,
        [srv.org, calendar, start, end],
      );
    expect(await inRollback(async () => {
      const c = await cal(2031);
      await period(c, '2031-01-01', '2031-01-31');
      return period(c, '2031-01-15', '2031-02-14');
    })).toBe('23P01');
    expect(await inRollback(async () => {
      await cal(2032);
      await admin.query(`INSERT INTO core.payroll_calendar(organisation_id, year, version, source, created_by) VALUES ($1, 2032, 99, 'x', $2)`, [srv.org, srv.owner]);
    })).toBe('23505');
  });

  describe('C2: shared state-transition tables equal the DB CHECK lists', () => {
    const MAPPED: Array<{ name: string; table: string; column: string; transitions: Record<string, readonly string[]>; coreOnly?: boolean }> = [
      { name: 'USER_STATUS_TRANSITIONS', table: 'user', column: 'status', transitions: shared.USER_STATUS_TRANSITIONS, coreOnly: true },
      { name: 'EMPLOYMENT_STATUS_TRANSITIONS', table: 'staff_profile', column: 'employment_status', transitions: shared.EMPLOYMENT_STATUS_TRANSITIONS },
      { name: 'ATTENDANCE_TRANSITIONS', table: 'attendance', column: 'status', transitions: shared.ATTENDANCE_TRANSITIONS },
      { name: 'OFFER_TRANSITIONS', table: 'job_offer', column: 'status', transitions: shared.OFFER_TRANSITIONS },
      { name: 'PAYROLL_RECORD_TRANSITIONS', table: 'payroll_record', column: 'status', transitions: shared.PAYROLL_RECORD_TRANSITIONS },
      { name: 'SHIFT_TRANSITIONS', table: 'shift', column: 'status', transitions: shared.SHIFT_TRANSITIONS },
      { name: 'SHIFT_ASSIGNMENT_TRANSITIONS', table: 'shift_assignment', column: 'status', transitions: shared.SHIFT_ASSIGNMENT_TRANSITIONS },
      { name: 'VENUE_TRANSITIONS', table: 'venue', column: 'status', transitions: shared.VENUE_TRANSITIONS },
    ];
    /** Exported transition tables with NO persisted column (documented gap, see WAVE2_LANE_S2_REPORT.md). */
    // ARCHIVE_TRANSITIONS (wave 5, DATA lane): the state is persisted as archived_at nullness, guarded by the
    // <table>_archived_pair_check / shift_archived_draft_only_check CHECKs (waves 4+5 lane DB5), not a status column.
    const NOT_PERSISTED = ['ARCHIVE_TRANSITIONS', 'PAYROLL_PERIOD_TRANSITIONS'];

    const checkValues = async (schema: string, table: string, column: string): Promise<string[]> => {
      const { rows } = await admin.query(
        `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
          WHERE k.conrelid = format('%I.%I', $1::text, $2::text)::regclass AND k.contype = 'c'
            AND pg_get_constraintdef(k.oid) ~ ('^CHECK \\(\\(' || $3 || ' = ANY \\(ARRAY\\[')`,
        [schema, table, column],
      );
      expect(rows).toHaveLength(1);
      return [...(rows[0].def as string).matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
    };

    it('every exported *_TRANSITIONS table is covered (mapped to a column or explicitly not persisted)', () => {
      const exported = Object.keys(shared).filter((k) => /_TRANSITIONS$/.test(k)).sort();
      expect(exported).toEqual([...MAPPED.map((m) => m.name), ...NOT_PERSISTED].sort());
    });

    it('each table: keys == DB CHECK list (core and every workspace schema); every target is a key', async () => {
      for (const m of MAPPED) {
        const states = Object.keys(m.transitions).sort();
        for (const targets of Object.values(m.transitions)) for (const t of targets) expect(states).toContain(t);
        const schemas = m.coreOnly ? ['core'] : ['core', srv.schema, ts.schema];
        for (const schema of schemas) {
          expect({ table: `${schema}.${m.table}.${m.column}`, values: await checkValues(schema, m.table, m.column) }).toEqual({
            table: `${schema}.${m.table}.${m.column}`,
            values: states,
          });
        }
      }
    });
  });
});
