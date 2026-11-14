/**
 * B2 tests (OWNER-DB-ULTIMATE.md Part B3): B1's "version complete" rule (isLastAttemptCompleted on the version's last step)
 * and its step sequence, against hand-built rows on the test database. Every row is written by the cluster superuser inside a
 * transaction that is ROLLED BACK; B1's service then reads them on the same connection after `SET LOCAL ROLE crewflow_owner`
 * (so the ledger's RLS applies exactly as for the runtime login).
 *
 *   LV-1  "version X complete" = the LAST step of X has a `completed` LATEST attempt (Twenty isLastAttemptCompleted,
 *         upgrade-migration.service.ts:33-110); no separate `version-recorded` row; an instance is_initial row of the
 *         migrations step at X (adoption) = X complete.
 *   LV-2  stepsForVersion: the migrations step `<v>_TypeOrmMigrations` first, then the version's commands; unique; every
 *         name matches the CHECK's shape.
 *   LV-4  versions are MAJOR.MINOR.PATCH; the code is at or after 0.6.0.
 */
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { ADOPTION, b1, FIRST_LEDGER_VERSION, loginOf, migrationsStep, Query, STEP_NAME_RE, VERSION_RE } from './ledger-contract';

jest.setTimeout(120_000);

const env = resolveIntegrationTestDatabase(process.env);
const RUN = b1() !== null && loginOf(env.appUrl) === 'crewflow_owner';
const describeIfB1 = RUN ? describe : describe.skip;

describeIfB1('the version-complete rule (Part B3, Twenty isLastAttemptCompleted)', () => {
  const B1 = b1()!;
  const V = B1.currentVersion;
  const last = () => {
    const s = B1.stepsOf(V);
    return s[s.length - 1]!;
  };

  /** Rows inserted as the superuser, then B1 asked as crewflow_owner, all inside one rolled-back transaction. */
  async function completeWith(rows: { name: string; status: 'completed' | 'failed'; attempt: number; version?: string; initial?: boolean; ws?: string }[], version = V): Promise<boolean> {
    const c = new Client({ connectionString: env.adminUrl, application_name: 'b2-ledger-rules-spec' });
    await c.connect();
    try {
      await c.query('BEGIN');
      // Rows already on the shared test database (the install's own) would decide the answer: hide them for this test.
      await c.query("DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL");
      for (const r of rows) {
        await c.query(
          'INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced) VALUES ($1, $2, $3, $4, $5, $6, $7, false)',
          [r.name, r.status, r.attempt, r.version ?? version, r.status === 'failed' ? 'b2 rules fixture' : null, r.initial ?? false, r.ws ?? null],
        );
      }
      await c.query('SET LOCAL ROLE crewflow_owner');
      const query: Query = async (sql, params) => (await c.query(sql, params as unknown[])).rows;
      return await B1.isVersionComplete(query, version);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  it('LV-2 the steps: the migrations step first, then the commands; unique; every name has the CHECK shape', () => {
    const s = B1.stepsOf(V);
    expect(s[0]).toBe(migrationsStep(V));
    expect(new Set(s).size).toBe(s.length);
    for (const n of s) expect(n).toMatch(STEP_NAME_RE);
    for (const n of s.slice(1)) expect(n).toMatch(new RegExp(`^${V.replace(/\./g, '\\.')}_[A-Za-z][A-Za-z0-9]*_[0-9]{13}$`));
  });

  it('LV-1 no rows -> not complete', async () => {
    expect(await completeWith([])).toBe(false);
  });

  it('LV-1 every step completed -> complete', async () => {
    expect(await completeWith(B1.stepsOf(V).map((name) => ({ name, status: 'completed' as const, attempt: 1 })))).toBe(true);
  });

  it('LV-1 earlier steps completed but the last failed or missing -> not complete', async () => {
    const s = B1.stepsOf(V);
    const earlier = s.slice(0, -1).map((name) => ({ name, status: 'completed' as const, attempt: 1 }));
    expect(await completeWith([...earlier, { name: last(), status: 'failed', attempt: 1 }])).toBe(false);
    if (s.length > 1) expect(await completeWith(earlier)).toBe(false);
  });

  it('LV-1 the LATEST attempt wins: completed then failed -> not complete; failed then completed -> complete', async () => {
    expect(await completeWith([{ name: last(), status: 'completed', attempt: 1 }, { name: last(), status: 'failed', attempt: 2 }])).toBe(false);
    expect(await completeWith([{ name: last(), status: 'failed', attempt: 1 }, { name: last(), status: 'completed', attempt: 2 }])).toBe(true);
    // Insert order is not "latest": attempt 2 inserted before attempt 1.
    expect(await completeWith([{ name: last(), status: 'completed', attempt: 2 }, { name: last(), status: 'failed', attempt: 1 }])).toBe(true);
  });

  it("LV-1 a workspace's row never completes the instance version", async () => {
    const c = new Client({ connectionString: env.adminUrl, application_name: 'b2-ledger-rules-spec' });
    await c.connect();
    let ws: string | undefined;
    try {
      ws = (await c.query<{ id: string }>('SELECT id::text FROM core.manager_workspace ORDER BY created_at LIMIT 1')).rows[0]?.id;
    } finally {
      await c.end();
    }
    if (!ws) throw new Error('the test database has no workspace to bind a workspace row to');
    expect(await completeWith([{ name: last(), status: 'completed', attempt: 1, ws, initial: true }])).toBe(false);
  });

  it('LV-1 adoption: an instance is_initial migrations-step row at 0.4.0 / 0.5.0 makes that version complete', async () => {
    for (const v of [ADOPTION.R254, ADOPTION.R256]) {
      const steps = B1.stepsOf(v);
      expect([v, steps[steps.length - 1]]).toEqual([v, migrationsStep(v)]);
      expect([v, await completeWith([{ name: migrationsStep(v), status: 'completed', attempt: 1, version: v, initial: true }], v)]).toEqual([v, true]);
    }
  });

  it('LV-4 versions are MAJOR.MINOR.PATCH and the code is at or after the first ledger release', () => {
    for (const v of [V, ADOPTION.R254, ADOPTION.R256, FIRST_LEDGER_VERSION]) expect(v).toMatch(VERSION_RE);
    const n = (v: string) => v.split('.').reduce((acc, p) => acc * 1000 + Number(p), 0);
    expect(n(V)).toBeGreaterThanOrEqual(n(FIRST_LEDGER_VERSION));
  });
});
