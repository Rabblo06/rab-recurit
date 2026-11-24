import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { AttendanceBreaksReceipts1786722140000 } from '../../database/typeorm/core/migrations/1786722140000-AttendanceBreaksReceipts';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { CORE_BREAKS_RECEIPTS_STATE_SQL, CoreStateRow, coreBreaksReceiptsProblems } from '../../database/typeorm/workspace-schema/attendance-breaks-receipts-sql';
import { BreakFixture, seedBreakFixture } from './helpers/attendance-break-fixture';
import { registerBreakAbuseCases } from './helpers/attendance-break-abuse';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * M4 design §13 PR 2 (DRAFT SQL, throwaway databases only): AttendanceBreaksReceipts1786722140000, the core copies (HWS off).
 * Proves, as the RUNTIME login (crewflow_owner): the A.3 / A.4 / A.7 abuse cases on core.attendance_break and
 * core.attendance_sync_receipt (helpers/attendance-break-abuse.ts: staff isolation both ways, the open-attendance insert rule,
 * one open break and no overlap, the closing-column allow-list, ±2 minutes on staff times, insert-only receipts, the CHECKs,
 * RESTRICT, crewflow_app's exact grants, zero rows with no tenant context); core.attendance_device_key own-row only, its key
 * columns immutable, no TRUNCATE; the migration's exact end state; down() refused while evidence exists.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('M4 §13 PR 2: core attendance breaks, sync receipts and device keys (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let w: SeededWorkspace;
  let fx: BreakFixture;
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    w = await seedWorkspace(admin, `brkcore-${SFX}`);
    fx = await seedBreakFixture(admin, w, 'core', `core-${SFX}`);
  });

  afterAll(async () => {
    // The core business rows of this fixture only (by organisation), children first; users and organisations stay.
    for (const table of ['attendance_sync_receipt', 'attendance_break', 'attendance_device_key', 'attendance', 'shift_assignment', 'shift', 'manager_venue', 'venue', 'job_role', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  registerBreakAbuseCases({ app: () => app, admin: () => admin, w: () => w, fx: () => fx });

  it('the migration end state holds exactly (tables FORCE and owned by crewflow, policies, triggers, grants, the time-guard function)', async () => {
    const rows = (await admin.query(CORE_BREAKS_RECEIPTS_STATE_SQL)).rows as CoreStateRow[];
    expect(coreBreaksReceiptsProblems(rows)).toEqual([]);
  });

  describe('core.attendance_device_key (A.5)', () => {
    const spki = () => randomBytes(91);
    const thumb = () => randomBytes(32).toString('base64url');
    const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [w.org, user]);
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    };
    const register = (user: string) =>
      app.query(
        `INSERT INTO core.attendance_device_key (organisation_id, user_id, session_family_id, install_id, platform, public_key_spki, key_thumbprint)
         VALUES ($1, $2, $3, $4, 'android', $5, $6) RETURNING id`,
        [w.org, user, randomUUID(), `install-${randomUUID()}`, spki(), thumb()],
      );

    it('own row only: a user registers and reads their own key, never registers or reads another user\'s', async () => {
      const seen = await as(fx.users.staffA, async () => {
        const id = (await register(fx.users.staffA)).rows[0].id as string;
        return (await app.query(`SELECT id FROM core.attendance_device_key WHERE id = $1`, [id])).rows.length;
      });
      expect(seen).toBe(1);
      expect(await as(fx.users.staffA, () => code(register(fx.users.staffB)))).toBe('42501');
      const { rows } = await admin.query(
        `INSERT INTO core.attendance_device_key (organisation_id, user_id, session_family_id, install_id, platform, public_key_spki, key_thumbprint)
         VALUES ($1, $2, $3, $4, 'ios', $5, $6) RETURNING id`,
        [w.org, fx.users.staffB, randomUUID(), `install-${randomUUID()}`, spki(), thumb()],
      );
      try {
        expect(await as(fx.users.staffA, async () => (await app.query(`SELECT id FROM core.attendance_device_key WHERE id = $1`, [rows[0].id])).rows)).toEqual([]);
        expect(await as(fx.users.manager, async () => (await app.query(`SELECT id FROM core.attendance_device_key WHERE id = $1`, [rows[0].id])).rows)).toEqual([]);
        expect(Number((await app.query(`SELECT count(*)::int AS n FROM core.attendance_device_key`)).rows[0].n)).toBe(0);
      } finally {
        await admin.query(`DELETE FROM core.attendance_device_key WHERE id = $1`, [rows[0].id]);
      }
    });

    it('the key, thumbprint, owner and session family never change (42501); revocation is one-way; DELETE and TRUNCATE are refused', async () => {
      const out = await as(fx.users.staffA, async () => {
        const id = (await register(fx.users.staffA)).rows[0].id as string;
        const swap = await code(app.query(`UPDATE core.attendance_device_key SET public_key_spki = $2 WHERE id = $1`, [id, spki()]));
        const family = await code(app.query(`UPDATE core.attendance_device_key SET session_family_id = $2 WHERE id = $1`, [id, randomUUID()]));
        const revoke = (await app.query(`UPDATE core.attendance_device_key SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [id])).rowCount;
        await app.query('SAVEPOINT k');
        const unrevoke = await code(app.query(`UPDATE core.attendance_device_key SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [id]));
        await app.query('ROLLBACK TO SAVEPOINT k');
        const touch = await code(app.query(`UPDATE core.attendance_device_key SET last_used_at = now() WHERE id = $1`, [id]));
        await app.query('ROLLBACK TO SAVEPOINT k');
        const remove = await code(app.query(`DELETE FROM core.attendance_device_key WHERE id = $1`, [id]));
        await app.query('ROLLBACK TO SAVEPOINT k');
        const truncate = await code(app.query(`TRUNCATE core.attendance_device_key`));
        return { swap, family, revoke, unrevoke, touch, remove, truncate };
      });
      // Review of #353 item 4: a revoked key never changes again (no un-revoke, no reuse); DELETE is refused for the runtime.
      expect(out).toEqual({ swap: '42501', family: '42501', revoke: 1, unrevoke: '42501', touch: '42501', remove: '42501', truncate: '42501' });
    });
  });

  it('down() is refused while any break, receipt or device key exists (nothing changed)', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query(
        `INSERT INTO core.attendance_break (organisation_id, workspace_id, attendance_id, staff_profile_id, started_at, start_source) VALUES ($1, $2, $3, $4, now(), 'staff')`,
        [w.org, w.id, fx.att.xA, fx.profiles.a],
      );
      await expect(new AttendanceBreaksReceipts1786722140000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: pay evidence exists \(breaks=\d+/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await admin.query(`SELECT to_regclass('core.attendance_break') IS NOT NULL AS t`)).rows[0].t).toBe(true);
  });

  it('review item 1: down() as an RLS-bound migrator (the owner login crewflow_owner) cannot count the evidence and refuses; it never reads 0 and drops', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE crewflow_owner');
      await expect(new AttendanceBreaksReceipts1786722140000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: the pay evidence could not be counted without row-level security/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await admin.query(`SELECT to_regclass('core.attendance_sync_receipt') IS NOT NULL AS t`)).rows[0].t).toBe(true);
  });
});
