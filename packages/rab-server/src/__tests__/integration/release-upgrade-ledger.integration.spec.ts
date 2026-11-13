import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Phase X U-2 (DRAFT, owner SQL review first): core.release_upgrade_event on the real test database (built by the chain,
 * so ReleaseUpgradeLedger1786721460000 is applied). As the runtime login crewflow_owner (TEST_DATABASE_URL) the table is
 * unreadable and unwritable directly (RESTRICTIVE deny through its crewflow membership, FORCE), UPDATE / DELETE / TRUNCATE
 * have no path, and the only write is the definer, which validates, numbers attempts and redacts. The schema roles
 * crewflow / crewflow_app cannot call the definer. Rows written here are removed by the cluster superuser afterwards
 * (TEST_DATABASE_URL_UNPOOLED): the runtime login itself cannot remove them, which is the point.
 */
jest.setTimeout(60_000);

const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

describeIfDb('release-upgrade ledger (integration)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let owner: Client;
  let admin: Client;
  const attempts: string[] = [];
  let hadRowsBefore = false;

  const record = (c: Client, a: Partial<Record<string, unknown>> & { event: string; attempt: string }) =>
    c.query(
      `SELECT core.release_upgrade_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) AS n`,
      [
        a.event,
        a.attempt,
        a.target ?? 'R257-unreleased',
        a.targetCount ?? 257,
        a.targetLast ?? 'ReleaseUpgradeLedger1786721460000',
        a.sha ?? SHA,
        a.from ?? null,
        a.fromCount ?? null,
        a.fromLast ?? null,
        a.pending ?? null,
        a.applied ?? null,
        a.failed ?? null,
        a.outcome ?? null,
        a.served ?? null,
        a.errorClass ?? null,
        a.message ?? null,
        a.appVersion ?? null,
      ],
    );
  const newAttempt = () => {
    const id = randomUUID();
    attempts.push(id);
    return id;
  };

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    admin = new Client({ connectionString: adminUrl });
    await owner.connect();
    await admin.connect();
    hadRowsBefore = ((await admin.query('SELECT count(*)::int AS n FROM core.release_upgrade_event')).rows[0].n as number) > 0;
  });

  afterAll(async () => {
    if (attempts.length) await admin.query('DELETE FROM core.release_upgrade_event WHERE attempt_id = ANY($1::uuid[])', [attempts]);
    await owner.end();
    await admin.end();
  });

  it('the runtime login reads and writes nothing directly (deny + FORCE); UPDATE / DELETE / TRUNCATE have no path', async () => {
    const who = await owner.query('SELECT current_user::text AS u, session_user::text AS s');
    expect(who.rows[0]).toEqual({ u: 'crewflow_owner', s: 'crewflow_owner' });
    await expect(owner.query('SELECT count(*) FROM core.release_upgrade_event')).resolves.toMatchObject({ rows: [{ count: '0' }] });
    await expect(
      owner.query(
        `INSERT INTO core.release_upgrade_event (attempt_id, attempt_number, event, recorded_at, session_login, target_release, target_migration_count, target_last_migration, target_set_sha256, from_release, from_migration_count, pending_count)
         VALUES ($1, 1, 'started', now(), 'x', 'R256', 256, 'RefreshTokenReplacedByIndex1786721450000', $2, 'R254', 254, 2)`,
        [randomUUID(), SHA],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query(`UPDATE core.release_upgrade_event SET outcome = 'ok'`)).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('DELETE FROM core.release_upgrade_event')).rejects.toMatchObject({ code: '42501' });
    await expect(owner.query('TRUNCATE core.release_upgrade_event')).rejects.toMatchObject({ code: '42501' });
  });

  it('the initial attribution (legacy database -> R254 / R256 from core.migrations) is accepted once, only while the ledger is empty', async () => {
    if (hadRowsBefore) return; // a database that already has ledger rows: the first-attribution case belongs to a fresh table
    const first = newAttempt();
    await expect(
      record(owner, { event: 'attributed', attempt: first, from: 'R254', fromCount: 254, fromLast: 'WorkspaceGrantParityGuards1786721430000' }),
    ).resolves.toMatchObject({ rows: [{ n: 1 }] });
    await expect(
      record(owner, { event: 'attributed', attempt: newAttempt(), from: 'R256', fromCount: 256, fromLast: 'RefreshTokenReplacedByIndex1786721450000' }),
    ).rejects.toMatchObject({ code: '55000' });
    const [row] = (await admin.query('SELECT event, from_release, from_migration_count, outcome FROM core.release_upgrade_event WHERE attempt_id = $1', [first])).rows;
    expect(row).toEqual({ event: 'attributed', from_release: 'R254', from_migration_count: 254, outcome: null });
  });

  it('the definer appends started -> completed for one attempt; the attempt number counts attempts at the same target set', async () => {
    const a1 = newAttempt();
    const s1 = await record(owner, { event: 'started', attempt: a1, from: 'R256', fromCount: 256, fromLast: 'RefreshTokenReplacedByIndex1786721450000', pending: 1 });
    const n1 = s1.rows[0].n as number;
    const c1 = await record(owner, { event: 'completed', attempt: a1, outcome: 'ok', served: true, applied: 1 });
    expect(c1.rows[0].n).toBe(n1);
    const a2 = newAttempt();
    const s2 = await record(owner, { event: 'started', attempt: a2, from: 'R256', fromCount: 256, pending: 1 });
    expect(s2.rows[0].n).toBe(n1 + 1);
    const other = newAttempt();
    expect((await record(owner, { event: 'started', attempt: other, sha: SHA2, from: 'R256', fromCount: 256, pending: 1 })).rows[0].n).toBe(1);
    const rows = (
      await admin.query(`SELECT event, attempt_number, session_login, outcome, served FROM core.release_upgrade_event WHERE attempt_id = $1 ORDER BY recorded_at`, [a1])
    ).rows;
    expect(rows).toEqual([
      { event: 'started', attempt_number: n1, session_login: 'crewflow_owner', outcome: null, served: null },
      { event: 'completed', attempt_number: n1, session_login: 'crewflow_owner', outcome: 'ok', served: true },
    ]);
  });

  it('a C3 degraded continue is a failed event with served = true; any other failure must say served = false', async () => {
    const a = newAttempt();
    await record(owner, { event: 'started', attempt: a, from: 'R256', fromCount: 256, pending: 2 });
    await expect(
      record(owner, { event: 'failed', attempt: a, outcome: 'degradedContinue', served: true, failed: 'DotProbeFail1786799990001', errorClass: 'QueryFailedError', message: 'division by zero', applied: 0 }),
    ).resolves.toBeDefined();
    const b = newAttempt();
    await expect(record(owner, { event: 'failed', attempt: b, outcome: 'behind', served: true, errorClass: 'UnsupportedUpgradeStartError', message: 'x' })).rejects.toMatchObject({ code: '23514' });
    await expect(record(owner, { event: 'failed', attempt: b, outcome: 'behind', served: false, errorClass: 'UnsupportedUpgradeStartError', message: 'older' })).resolves.toBeDefined();
  });

  it('shapes are enforced (a NULL cannot slip through) and one event per attempt', async () => {
    const a = newAttempt();
    await expect(record(owner, { event: 'completed', attempt: a, outcome: 'ok', served: null, applied: 1 })).rejects.toMatchObject({ code: '23514' });
    await expect(record(owner, { event: 'completed', attempt: a, outcome: null, served: true, applied: 1 })).rejects.toMatchObject({ code: '23514' });
    await expect(record(owner, { event: 'started', attempt: a, from: null, fromCount: 256, pending: 1 })).rejects.toMatchObject({ code: '23514' });
    await expect(record(owner, { event: 'started', attempt: a, target: 'v1.2', from: 'R256', fromCount: 256, pending: 1 })).rejects.toMatchObject({ code: '23514' });
    await expect(record(owner, { event: 'bogus', attempt: a })).rejects.toMatchObject({ code: '22023' });
    await record(owner, { event: 'started', attempt: a, from: 'R256', fromCount: 256, pending: 1 });
    await expect(record(owner, { event: 'started', attempt: a, from: 'R256', fromCount: 256, pending: 1 })).rejects.toMatchObject({ code: '23505' });
  });

  it('connection strings are redacted by the definer itself, and the message is bounded', async () => {
    const a = newAttempt();
    await record(owner, {
      event: 'failed',
      attempt: a,
      outcome: 'identity',
      served: false,
      errorClass: 'DbTargetError',
      message: `cannot reach postgres://crewflow_owner:s3cret@db.internal:5432/crewflow and redis://:pw@cache:6379 ${'x'.repeat(2000)}`,
    });
    const [row] = (await admin.query('SELECT error_message FROM core.release_upgrade_event WHERE attempt_id = $1', [a])).rows;
    expect(row.error_message).not.toMatch(/s3cret|:pw@/);
    expect(row.error_message).toMatch(/^cannot reach <url> and <url> x+$/);
    expect(row.error_message.length).toBe(1000);
  });

  it('the schema roles crewflow / crewflow_app cannot call the definer (no EXECUTE), even through SET ROLE', async () => {
    for (const role of ['crewflow_app', 'crewflow']) {
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${role}`);
        await expect(record(admin, { event: 'started', attempt: randomUUID(), from: 'R256', fromCount: 256, pending: 1 })).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query('ROLLBACK');
      }
    }
  });
});
