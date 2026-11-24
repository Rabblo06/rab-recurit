import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { BreakFixture, SHA } from './attendance-break-fixture';
import { SeededWorkspace } from './workspace-fixtures';

/**
 * Test-only: the §1.2-style abuse cases for attendance_break / attendance_sync_receipt (M4 §13 PR 2, A.3 / A.4 / A.7), run as
 * the RUNTIME login (crewflow_owner) on one copy (`core` or a workspace schema). Registered inside the caller's describe; every
 * write runs in a transaction that is always rolled back, so the fixture never changes.
 */
export interface BreakAbuseContext {
  app: () => Client;
  admin: () => Client;
  w: () => SeededWorkspace;
  fx: () => BreakFixture;
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
/** The SQLSTATE and, when the server names one, the constraint (review of #353, item 7). */
const coded = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; constraint?: string }) => (e.constraint ? `${e.code}:${e.constraint}` : (e.code ?? 'error')));

export function registerBreakAbuseCases(ctx: BreakAbuseContext): void {
  const q = () => `"${ctx.fx().schema}"`;
  /** Runs `fn` as the runtime login with the given GUCs, inside a transaction that is always rolled back. */
  const as = async <T>(o: { user?: string; actor?: string; workspace?: string; bind?: boolean }, fn: () => Promise<T>): Promise<T> => {
    const app = ctx.app();
    await app.query('BEGIN');
    try {
      if (o.bind !== false) {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [ctx.w().org, o.workspace ?? ctx.w().id]);
        await app.query(`SELECT set_config('rab.user_id', $1, true), set_config('rab.actor_type', $2, true)`, [o.user ?? '', o.actor ?? '']);
      }
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const run = (sql: string, params: unknown[] = []) => ctx.app().query(sql, params);
  const insertBreak = (attendance: string, profile: string, startedAt = 'now()', source = 'staff') =>
    run(
      `INSERT INTO ${q()}.attendance_break (organisation_id, workspace_id, attendance_id, staff_profile_id, started_at, start_source)
       VALUES ($1, $2, $3, $4, ${startedAt}, $5) RETURNING id`,
      [ctx.w().org, ctx.w().id, attendance, profile, source],
    );
  const insertReceipt = (user: string, profile: string, extra: { attendance?: string | null; shift?: string | null } = {}) =>
    run(
      `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type,
                                                    shift_id, attendance_id, outcome, time_trust, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'online', 'clock_in', $7, $8, 'applied', 'server', now()) RETURNING id`,
      [ctx.w().org, ctx.w().id, profile, user, randomUUID(), SHA, extra.shift ?? ctx.fx().shifts.x, extra.attendance ?? ctx.fx().att.xA],
    );
  /** Superuser seed of one closed break per staff member (A on xA, B on xB) and one receipt each, rolled back with the caller. */
  const seeded = async <T>(fn: (ids: { breakA: string; breakB: string; receiptA: string; receiptB: string }) => Promise<T>): Promise<T> => {
    const admin = ctx.admin();
    const fx = ctx.fx();
    const w = ctx.w();
    const brk = async (att: string, p: string) =>
      (
        await admin.query(
          `INSERT INTO ${q()}.attendance_break (organisation_id, workspace_id, attendance_id, staff_profile_id, started_at, ended_at, start_source, end_source)
           VALUES ($1, $2, $3, $4, now() - interval '40 minutes', now() - interval '30 minutes', 'staff', 'staff') RETURNING id`,
          [w.org, w.id, att, p],
        )
      ).rows[0].id as string;
    const rec = async (user: string, p: string, att: string) =>
      (
        await admin.query(
          `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type,
                                                        shift_id, attendance_id, outcome, time_trust, applied_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'online', 'clock_in', $7, $8, 'applied', 'server', now()) RETURNING id`,
          [w.org, w.id, p, user, randomUUID(), SHA, fx.shifts.x, att],
        )
      ).rows[0].id as string;
    const ids = { breakA: await brk(fx.att.xA, fx.profiles.a), breakB: await brk(fx.att.xB, fx.profiles.b), receiptA: '', receiptB: '' };
    ids.receiptA = await rec(fx.users.staffA, fx.profiles.a, fx.att.xA);
    ids.receiptB = await rec(fx.users.staffB, fx.profiles.b, fx.att.xB);
    try {
      return await fn(ids);
    } finally {
      await admin.query(`DELETE FROM ${q()}.attendance_sync_receipt WHERE id = ANY($1::uuid[])`, [[ids.receiptA, ids.receiptB]]);
      await admin.query(`DELETE FROM ${q()}.attendance_break WHERE id = ANY($1::uuid[])`, [[ids.breakA, ids.breakB]]);
    }
  };
  const visible = (o: Parameters<typeof as>[0], table: string, ids: string[]) =>
    as(o, async () => (await run(`SELECT id FROM ${q()}.${table} WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => String(r.id)).sort());
  const sorted = (...ids: string[]) => [...ids].sort();

  it('the runtime login is crewflow_owner (not SUPERUSER / BYPASSRLS): what the policies and triggers bind', async () => {
    const { rows } = await ctx.app().query(`SELECT current_user AS who, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toMatchObject({ who: 'crewflow_owner', su: false, bypass: false });
  });

  it('zero rows with no tenant context bound (both tables)', async () => {
    await seeded(async () => {
      for (const t of ['attendance_break', 'attendance_sync_receipt']) {
        expect(Number((await as({ bind: false }, () => run(`SELECT count(*)::int AS n FROM ${q()}.${t}`))).rows[0].n)).toBe(0);
      }
    });
  });

  it('Staff A starts their own break on their own open attendance; ±2 minutes: a staff start 5 minutes off is refused (23514, attendance_break_staff_window)', async () => {
    const fx = ctx.fx();
    expect(await as({ user: fx.users.staffA }, async () => (await insertBreak(fx.att.xA, fx.profiles.a)).rowCount)).toBe(1);
    expect(await as({ user: fx.users.staffA }, () => coded(insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '5 minutes'`)))).toBe('23514:attendance_break_staff_window');
    expect(await as({ user: fx.users.staffA }, () => coded(insertBreak(fx.att.xA, fx.profiles.a, `now() + interval '5 minutes'`)))).toBe('23514:attendance_break_staff_window');
  });

  it('review item 2: a staff member cannot dodge the window with another source: offline_sync start / end (the venue flag is off and cannot be turned on), manager end, clock_out end off the clock-out time', async () => {
    const fx = ctx.fx();
    expect(await as({ user: fx.users.staffA }, () => code(insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '20 minutes'`, 'offline_sync')))).toBe('42501');
    const ends = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '1 minute'`)).rows[0].id as string;
      const out: Record<string, string> = {};
      for (const src of ['manager', 'offline_sync', 'clock_out']) {
        await run('SAVEPOINT e');
        out[src] = await coded(run(`UPDATE ${q()}.attendance_break SET ended_at = now() - interval '30 seconds', end_source = $2 WHERE id = $1`, [id, src]));
        await run('ROLLBACK TO SAVEPOINT e');
      }
      return out;
    });
    expect(ends).toEqual({ manager: '42501', offline_sync: '42501', clock_out: '23514:attendance_break_clock_out_end' });
  });

  it('review item 2: a manager closes a break only as `manager` (not as `staff`), and a `clock_out` end only at the attendance\'s clock-out time', async () => {
    const fx = ctx.fx();
    const admin = ctx.admin();
    const id = (
      await admin.query(
        `INSERT INTO ${q()}.attendance_break (organisation_id, workspace_id, attendance_id, staff_profile_id, started_at, start_source) VALUES ($1, $2, $3, $4, now() - interval '10 minutes', 'staff') RETURNING id`,
        [ctx.w().org, ctx.w().id, fx.att.xB, fx.profiles.b],
      )
    ).rows[0].id as string;
    try {
      const out = await as({ user: fx.users.manager }, async () => {
        const r: Record<string, string> = {};
        await run('SAVEPOINT m');
        r.asStaff = await code(run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'staff' WHERE id = $1`, [id]));
        await run('ROLLBACK TO SAVEPOINT m');
        r.asManager = await code(run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'manager' WHERE id = $1`, [id]));
        return r;
      });
      expect(out).toEqual({ asStaff: '42501', asManager: 'ok' });
      // clock_out at the attendance's own clock_out_at (written first by the service): accepted; any other time is 23514.
      const clock = await as({ user: fx.users.manager }, async () => {
        await run(`UPDATE ${q()}.attendance SET clock_out_at = now() WHERE id = $1`, [fx.att.xB]);
        return coded(run(`UPDATE ${q()}.attendance_break SET ended_at = now() - interval '1 minute', end_source = 'clock_out' WHERE id = $1`, [id]));
      });
      expect(clock).toBe('23514:attendance_break_clock_out_end');
      const right = await as({ user: fx.users.manager }, async () => {
        await run(`UPDATE ${q()}.attendance SET clock_out_at = now() WHERE id = $1`, [fx.att.xB]);
        return (await run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'clock_out' WHERE id = $1`, [id])).rowCount;
      });
      expect(right).toBe(1);
    } finally {
      await admin.query(`DELETE FROM ${q()}.attendance_break WHERE id = $1`, [id]);
    }
  });

  it('re-review item 1: a break write succeeds end to end for its staff member (start now, close now): the guard reads the attendance', async () => {
    const fx = ctx.fx();
    const out = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a)).rows[0].id as string;
      const closed = (await run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'staff', updated_at = now() WHERE id = $1`, [id])).rowCount;
      const row = (await run(`SELECT start_source, end_source, ended_at IS NOT NULL AS closed FROM ${q()}.attendance_break WHERE id = $1`, [id])).rows[0];
      return { closed, row };
    });
    expect(out).toEqual({ closed: 1, row: { start_source: 'staff', end_source: 'staff', closed: true } });
  });

  it('re-review item 2: staff cannot dodge the window by moving their own clock_out_at and closing the break as clock_out (23514)', async () => {
    const fx = ctx.fx();
    const out = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a)).rows[0].id as string;
      await run(`UPDATE ${q()}.attendance SET clock_out_at = now() + interval '10 minutes' WHERE id = $1`, [fx.att.xA]);
      return coded(run(`UPDATE ${q()}.attendance_break SET ended_at = now() + interval '10 minutes', end_source = 'clock_out' WHERE id = $1`, [id]));
    });
    expect(out).toBe('23514:attendance_break_staff_window');
  });

  it('re-review item 3: a break cannot start at or after the attendance\'s clock-out, nor on an attendance that is no longer open (42501)', async () => {
    const fx = ctx.fx();
    const afterClockOut = await as({ user: fx.users.staffA }, async () => {
      await run(`UPDATE ${q()}.attendance SET clock_out_at = now() - interval '1 minute' WHERE id = $1`, [fx.att.xA]);
      return code(insertBreak(fx.att.xA, fx.profiles.a));
    });
    expect(afterClockOut).toBe('42501');
  });

  it('review item 3: a closed break is never changed again, by its staff member or a manager (42501)', async () => {
    const fx = ctx.fx();
    const reopened = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '1 minute'`)).rows[0].id as string;
      await run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'staff' WHERE id = $1`, [id]);
      return code(run(`UPDATE ${q()}.attendance_break SET ended_at = now() - interval '30 seconds' WHERE id = $1`, [id]));
    });
    expect(reopened).toBe('42501');
    await seeded(async ({ breakA }) => {
      expect(await as({ user: fx.users.manager }, () => code(run(`UPDATE ${q()}.attendance_break SET ended_at = ended_at - interval '5 minutes', end_source = 'manager' WHERE id = $1`, [breakA])))).toBe('42501');
      expect(await as({ user: fx.users.staffA }, () => code(run(`UPDATE ${q()}.attendance_break SET updated_at = now() WHERE id = $1`, [breakA])))).toBe('42501');
    });
  });

  it('review item 5: offline attendance cannot be switched on for a venue in the database (CHECK venue_offline_attendance_disabled), even by the superuser', async () => {
    const admin = ctx.admin();
    await admin.query('BEGIN');
    try {
      expect(await coded(admin.query(`UPDATE ${q()}.venue SET offline_attendance_enabled = true WHERE workspace_id = $1`, [ctx.w().id]))).toBe('23514:venue_offline_attendance_disabled');
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('Staff A cannot start a break on Staff B\'s attendance, nor as Staff B, nor on a clocked-out attendance (42501)', async () => {
    const fx = ctx.fx();
    expect(await as({ user: fx.users.staffA }, () => code(insertBreak(fx.att.xB, fx.profiles.b)))).toBe('42501');
    expect(await as({ user: fx.users.staffA }, () => code(insertBreak(fx.att.xB, fx.profiles.a)))).toBe('42501');
    expect(await as({ user: fx.users.staffB }, () => code(insertBreak(fx.att.yB, fx.profiles.b)))).toBe('42501');
    expect(await as({ user: fx.users.manager }, () => code(insertBreak(fx.att.xA, fx.profiles.a)))).toBe('42501');
  });

  it('one open break per attendance and no overlapping breaks', async () => {
    const fx = ctx.fx();
    const second = await as({ user: fx.users.staffA }, async () => {
      await insertBreak(fx.att.xA, fx.profiles.a);
      return code(insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '1 minute'`));
    });
    expect(['23505', '23P01']).toContain(second);
  });

  it('closing a break: only ended_at / end_source / updated_at may change (42501 otherwise); ±2 minutes on a staff end; no DELETE or TRUNCATE (42501)', async () => {
    const fx = ctx.fx();
    const outcome = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '1 minute'`)).rows[0].id as string;
      const moved = await code(run(`UPDATE ${q()}.attendance_break SET started_at = started_at - interval '1 hour' WHERE id = $1`, [id]));
      const paid = await code(run(`UPDATE ${q()}.attendance_break SET is_paid = true WHERE id = $1`, [id]));
      const late = await code(run(`UPDATE ${q()}.attendance_break SET ended_at = now() + interval '10 minutes', end_source = 'staff' WHERE id = $1`, [id]));
      return { moved, paid, late };
    });
    expect(outcome).toEqual({ moved: '42501', paid: '42501', late: '23514' });
    const closed = await as({ user: fx.users.staffA }, async () => {
      const id = (await insertBreak(fx.att.xA, fx.profiles.a, `now() - interval '1 minute'`)).rows[0].id as string;
      return (await run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'staff', updated_at = now() WHERE id = $1`, [id])).rowCount;
    });
    expect(closed).toBe(1);
    await seeded(async ({ breakA }) => {
      expect(await as({ user: fx.users.manager }, () => code(run(`DELETE FROM ${q()}.attendance_break WHERE id = $1`, [breakA])))).toBe('42501');
      expect(await as({ user: fx.users.manager }, () => code(run(`DELETE FROM ${q()}.attendance_break WHERE false`)))).toBe('42501');
      expect(await as({ user: fx.users.manager }, () => code(run(`TRUNCATE ${q()}.attendance_break`)))).toBe('42501');
    });
  });

  it('break visibility: staff own only; the Manager all; a Venue Manager only their venue; the worker marker all; strangers, another workspace and no user nothing', async () => {
    const fx = ctx.fx();
    await seeded(async ({ breakA, breakB }) => {
      const ids = [breakA, breakB];
      expect(await visible({ user: fx.users.staffA }, 'attendance_break', ids)).toEqual([breakA]);
      expect(await visible({ user: fx.users.staffB }, 'attendance_break', ids)).toEqual([breakB]);
      expect(await visible({ user: fx.users.manager }, 'attendance_break', ids)).toEqual(sorted(breakA, breakB));
      expect(await visible({ user: fx.users.vmX }, 'attendance_break', ids)).toEqual(sorted(breakA, breakB));
      expect(await visible({ user: fx.users.vmY }, 'attendance_break', ids)).toEqual([]);
      expect(await visible({ user: '', actor: 'worker' }, 'attendance_break', ids)).toEqual(sorted(breakA, breakB));
      expect(await visible({ user: '' }, 'attendance_break', ids)).toEqual([]);
      expect(await visible({ user: fx.users.stranger }, 'attendance_break', ids)).toEqual([]);
      expect(await visible({ user: fx.users.otherManager }, 'attendance_break', ids)).toEqual([]);
      expect(await visible({ user: fx.users.manager, workspace: fx.sibling }, 'attendance_break', ids)).toEqual([]);
      // Staff A cannot close Staff B's break (0 rows); the worker marker cannot write one.
      expect(await as({ user: fx.users.staffA }, async () => (await run(`UPDATE ${q()}.attendance_break SET ended_at = now(), end_source = 'staff' WHERE id = $1`, [breakB])).rowCount)).toBe(0);
      expect(await as({ user: '', actor: 'worker' }, async () => (await run(`UPDATE ${q()}.attendance_break SET end_source = 'manager' WHERE id = $1`, [breakB])).rowCount)).toBe(0);
    });
  });

  it('review item 6: a receipt references only its own staff member\'s attendance, break and shift (42501 otherwise)', async () => {
    const fx = ctx.fx();
    expect(await as({ user: fx.users.staffA }, () => code(insertReceipt(fx.users.staffA, fx.profiles.a, { attendance: fx.att.xB })))).toBe('42501');
    expect(await as({ user: fx.users.staffA }, () => code(insertReceipt(fx.users.staffA, fx.profiles.a, { shift: fx.shifts.y, attendance: null })))).toBe('42501');
    await seeded(async ({ breakB }) => {
      const out = await as({ user: fx.users.staffA }, () =>
        code(
          run(
            `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type,
                                                          shift_id, attendance_id, break_id, outcome, time_trust, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'online', 'break_end', $7, $8, $9, 'applied', 'server', now())`,
            [ctx.w().org, ctx.w().id, fx.profiles.a, fx.users.staffA, randomUUID(), SHA, fx.shifts.x, fx.att.xA, breakB],
          ),
        ),
      );
      expect(out).toBe('42501');
    });
  });

  it('receipts are insert-only: own session only (user_id and staff profile), UPDATE / DELETE / TRUNCATE refused (42501, even on zero rows)', async () => {
    const fx = ctx.fx();
    expect(await as({ user: fx.users.staffA }, async () => (await insertReceipt(fx.users.staffA, fx.profiles.a)).rowCount)).toBe(1);
    expect(await as({ user: fx.users.staffA }, () => code(insertReceipt(fx.users.staffB, fx.profiles.a)))).toBe('42501');
    expect(await as({ user: fx.users.staffA }, () => code(insertReceipt(fx.users.staffA, fx.profiles.b, { attendance: fx.att.xB })))).toBe('42501');
    expect(await as({ user: fx.users.manager }, () => code(insertReceipt(fx.users.manager, fx.profiles.a)))).toBe('42501');
    await seeded(async ({ receiptA }) => {
      for (const sql of [
        `UPDATE ${q()}.attendance_sync_receipt SET outcome = 'rejected', reason_code = 'X_FORGED' WHERE id = $1`,
        `DELETE FROM ${q()}.attendance_sync_receipt WHERE id = $1`,
        `UPDATE ${q()}.attendance_sync_receipt SET flags = '{}' WHERE id = $1 AND false`,
      ]) {
        expect(await as({ user: fx.users.staffA }, () => code(run(sql, [receiptA])))).toBe('42501');
        expect(await as({ user: fx.users.manager }, () => code(run(sql, [receiptA])))).toBe('42501');
      }
      expect(await as({ user: fx.users.manager }, () => code(run(`TRUNCATE ${q()}.attendance_sync_receipt`)))).toBe('42501');
    });
  });

  it('receipt visibility: staff own only; the Manager all; a Venue Manager of the shift; the worker marker; nobody else', async () => {
    const fx = ctx.fx();
    await seeded(async ({ receiptA, receiptB }) => {
      const ids = [receiptA, receiptB];
      expect(await visible({ user: fx.users.staffA }, 'attendance_sync_receipt', ids)).toEqual([receiptA]);
      expect(await visible({ user: fx.users.manager }, 'attendance_sync_receipt', ids)).toEqual(sorted(receiptA, receiptB));
      expect(await visible({ user: fx.users.vmX }, 'attendance_sync_receipt', ids)).toEqual(sorted(receiptA, receiptB));
      expect(await visible({ user: fx.users.vmY }, 'attendance_sync_receipt', ids)).toEqual([]);
      expect(await visible({ user: '', actor: 'worker' }, 'attendance_sync_receipt', ids)).toEqual(sorted(receiptA, receiptB));
      expect(await visible({ user: fx.users.stranger }, 'attendance_sync_receipt', ids)).toEqual([]);
      expect(await visible({ user: fx.users.manager, workspace: fx.sibling }, 'attendance_sync_receipt', ids)).toEqual([]);
    });
  });

  it('receipt CHECKs: a non-hex request hash, a forged reason code, an online receipt claiming anchored time are refused (23514)', async () => {
    const fx = ctx.fx();
    const bad = (column: string, value: string) =>
      as({ user: fx.users.staffA }, () =>
        code(
          run(
            `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type,
                                                          outcome, time_trust, applied_at, ${column})
             VALUES ($1, $2, $3, $4, $5, $6, 'online', 'clock_in', 'applied', 'server', now(), $7)`,
            [ctx.w().org, ctx.w().id, fx.profiles.a, fx.users.staffA, randomUUID(), SHA, value],
          ),
        ),
      );
    expect(await bad('reason_code', 'NOT_REJECTED')).toBe('23514');
    expect(await bad('device_key_thumbprint', 'short')).toBe('23514');
    expect(
      await as({ user: fx.users.staffA }, () =>
        code(
          run(
            `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type, outcome, time_trust, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'online', 'clock_in', 'applied', 'anchored', now())`,
            [ctx.w().org, ctx.w().id, fx.profiles.a, fx.users.staffA, randomUUID(), SHA],
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await as({ user: fx.users.staffA }, () =>
        code(
          run(
            `INSERT INTO ${q()}.attendance_sync_receipt (organisation_id, workspace_id, staff_profile_id, user_id, idempotency_key, request_sha256, channel, event_type, outcome, time_trust, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'online', 'clock_in', 'applied', 'server', now())`,
            [ctx.w().org, ctx.w().id, fx.profiles.a, fx.users.staffA, randomUUID(), 'A'.repeat(64)],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('A.7 RESTRICT: an attendance with a break or a receipt cannot be deleted, even by the owner role (pay evidence)', async () => {
    const fx = ctx.fx();
    await seeded(async () => {
      const admin = ctx.admin();
      await admin.query('BEGIN');
      const outcome = await code(admin.query(`DELETE FROM ${q()}.attendance WHERE id = $1`, [fx.att.xA]));
      await admin.query('ROLLBACK');
      expect(['23503', '23001']).toContain(outcome);
    });
  });

  it('crewflow_app holds SELECT, INSERT (+ UPDATE of the closing columns on breaks) and nothing else', async () => {
    const admin = ctx.admin();
    const priv = async (table: string) =>
      (
        await admin.query(
          `SELECT has_table_privilege('crewflow_app', $1, 'SELECT') AS s, has_table_privilege('crewflow_app', $1, 'INSERT') AS i,
                  has_table_privilege('crewflow_app', $1, 'UPDATE') AS u, has_table_privilege('crewflow_app', $1, 'DELETE') AS d,
                  has_table_privilege('crewflow_app', $1, 'TRUNCATE') AS t`,
          [table],
        )
      ).rows[0];
    for (const t of ['attendance_break', 'attendance_sync_receipt']) expect(await priv(`${q()}.${t}`)).toEqual({ s: true, i: true, u: false, d: false, t: false });
    const cols = (
      await admin.query(
        `SELECT a.attname::text AS c FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('crewflow_app', a.attrelid, a.attnum, 'UPDATE') ORDER BY 1`,
        [`${q()}.attendance_break`],
      )
    ).rows.map((r) => r.c);
    expect(cols).toEqual(['end_source', 'ended_at', 'updated_at']);
  });
}
