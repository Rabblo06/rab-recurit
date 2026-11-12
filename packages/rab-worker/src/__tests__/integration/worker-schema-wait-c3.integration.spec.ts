import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSourceOptions, MigrationInterface } from 'typeorm';

import { readUpgradeEvidence, runDatabaseBootGates } from '@rab/server/database/boot-checks/database-boot-gates';
import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';

import { waitForWorkerSchemaOn } from '../../core/runtime/schema-wait';

/**
 * O3 T8a-WORKER regression (owner decision 2026-11-05, "the Worker starts too, like Twenty"). The Worker's bounded schema
 * wait used to call checkSchemaCompatibility WITHOUT the C3 upgrade evidence, so after a failed upgrade it refused the
 * Worker that gate 7 would have started. Now the wait makes the same call gate 7 makes (readUpgradeEvidence: Agent 1's
 * classifier CHAIN-PARTIAL + the physical fresh-install proof NOT fresh), on the real test database:
 *   - a first install (no upgrade evidence) with a pending tail: still refused;
 *   - an OUT-OF-ORDER pending migration, or an INTERLEAVED ledger: still refused, evidence or not;
 *   - an in-order pending tail on a stopped UPGRADE (evidence planted): the wait proceeds at once, and the Worker's start
 *     (the wait, then gate 7) logs exactly ONE partly-upgraded WARNING, naming the first pending migration.
 * "A failed upgrade" is modelled as this code expecting one migration more than the ledger holds (nothing is migrated).
 *
 * The first case needs a database with no physical tenant data yet (a pristine fresh install). On a database that already
 * holds some (shared CI), that case cannot be constructed and is reported as such; the unit specs cover the first-install
 * rule (schema-compatibility.c3.spec.ts).
 */
const { appUrl, adminUrl } = resolveIntegrationTestDatabase(process.env);
const TAIL = 'WorkerWaitFakePending9999999999999';
const OUT_OF_ORDER = 'WorkerWaitFakeOutOfOrder1700000000000';

class WorkerWaitFakePending9999999999999 implements MigrationInterface {
  name = TAIL;
  async up(): Promise<void> {
    throw new Error('never run');
  }
  async down(): Promise<void> {
    throw new Error('never run');
  }
}

describe('Worker schema wait after a failed upgrade (C3, real database)', () => {
  let client: Client;
  let ledger: string[];
  const query = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[]).then((r) => r.rows as unknown[]);
  const wait = (expected: readonly string[], log: (line: string) => void = () => undefined) =>
    waitForWorkerSchemaOn(query, { expected, production: false, maxWaitMs: 0, log, sleep: async () => undefined });

  /** Physical upgrade evidence (Agent 3's approach): a rolled-back INSERT allocates a heap page in core.organisation. */
  async function plantUpgradeEvidence(): Promise<void> {
    const su = new Client({ connectionString: adminUrl });
    await su.connect();
    try {
      await su.query('BEGIN');
      const slug = `worker-wait-evidence-${randomUUID().slice(0, 8)}`;
      await su.query('INSERT INTO core.organisation (name, slug) VALUES ($1, $2)', [slug, slug]);
      await su.query('ROLLBACK');
    } finally {
      await su.end();
    }
  }

  beforeAll(async () => {
    client = new Client({ connectionString: appUrl });
    await client.connect();
    ledger = ((await client.query('SELECT name FROM core.migrations ORDER BY "timestamp", id')).rows as Array<{ name: string }>).map((r) => r.name);
    expect(ledger.length).toBeGreaterThan(10);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('a first install (no upgrade evidence) with a pending tail is still refused', async () => {
    const expected = [...ledger, TAIL];
    if (await readUpgradeEvidence(query, expected)) {
      // Not constructible on this database (it already holds physical tenant data); covered by the unit specs.
      console.warn('worker-schema-wait-c3: the database is not a pristine first install; the first-install refusal case is not constructible here');
      return;
    }
    await expect(wait(expected)).rejects.toThrow(/migrations are still pending|1 migration\(s\) are not applied/);
  });

  describe('with physical upgrade evidence (a stopped UPGRADE)', () => {
    beforeAll(async () => {
      await plantUpgradeEvidence();
      expect(await readUpgradeEvidence(query, [...ledger, TAIL])).toBe(true);
    });

    it('an OUT-OF-ORDER pending migration (older than the newest applied) is still refused', async () => {
      await expect(wait([...ledger, OUT_OF_ORDER])).rejects.toThrow(/1 migration\(s\) are not applied: WorkerWaitFakeOutOfOrder1700000000000/);
    });

    it('an INTERLEAVED ledger (a name this code does not know, older than its newest) is still refused', async () => {
      const middle = ledger[Math.floor(ledger.length / 2)]!;
      const expected = [...ledger.filter((name) => name !== middle), TAIL];
      await expect(wait(expected)).rejects.toThrow(new RegExp(middle));
    });

    it('an in-order pending tail: the wait proceeds at once and the Worker start logs exactly ONE partly-upgraded WARNING', async () => {
      const lines: string[] = [];
      const result = await wait([...ledger, TAIL], (line) => lines.push(line));
      expect(result.checks).toBe(1);
      expect(result.assessment?.upgradeIncomplete).toBe(TAIL);
      // Then gate 7, exactly as the Worker's bootstrap runs it after the wait (same database, same expected set).
      const migrations = [...((coreDataSourceOptions.migrations as string[]) ?? []), WorkerWaitFakePending9999999999999] as DataSourceOptions['migrations'];
      await runDatabaseBootGates('worker', {
        env: { NODE_ENV: 'test' },
        connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: appUrl },
        migrations,
        retry: { attempts: 1 },
        log: (line) => lines.push(line),
      });
      const partly = lines.filter((line) => /partly-upgraded/.test(line));
      expect(partly).toHaveLength(1);
      expect(partly[0]).toMatch(new RegExp(`WARNING worker process: .*running on a partly-upgraded schema: ${TAIL} and 0 more not applied`));
    });
  });
});
