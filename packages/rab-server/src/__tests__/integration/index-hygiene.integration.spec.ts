import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { collectIndexHygiene, indexHygieneProblems, proposedBaseline, readIndexHygieneBaseline } from '../../database/typeorm/core/index-hygiene';
import { dropWorkspaceSchema, provisionTypeScript, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Index-fix tooling 1 and 3 on a real catalogue: the unindexed-foreign-key, invalid-index and index-name rules
 * (core/index-hygiene.ts) against the committed baseline (index-hygiene.baseline.json), for `core` AND a workspace schema
 * provisioned here at the current structure level. ci-security's rls-coverage job runs the same rules on a fresh install,
 * which has no workspace schema, so this spec is where the `WS` entries are held to the baseline. Only this file's own
 * workspace schema is scanned: other files' leftover schemas may have been built from older templates on purpose.
 * Read-only catalogue queries, plus the usual fixture seed and drop of one workspace.
 */
jest.setTimeout(180_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('index hygiene: unindexed foreign keys, invalid indexes and index names against the baseline (integration)', () => {
  const { adminUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let ws: SeededWorkspace;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    ws = await seedWorkspace(admin, `idxh-${SFX}`);
    expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
  });

  afterAll(async () => {
    if (ws) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    await admin?.end();
  });

  const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => (await admin.query(sql, params)).rows as T[];

  it('core and a freshly provisioned workspace schema match the baseline exactly (no new finding, no stale entry)', async () => {
    const findings = await collectIndexHygiene(query, ['core', ws.schema]);
    expect(findings.foreignKeys).toBeGreaterThan(0);
    // The workspace schema really was scanned (it has foreign keys of its own, e.g. to core.organisation).
    expect(findings.unindexed.some((fk) => fk.schema === ws.schema) || findings.redundant.some((r) => r.index.startsWith('WS.'))).toBe(true);
    const baseline = readIndexHygieneBaseline();
    const problems = indexHygieneProblems(findings, baseline);
    if (problems.length > 0) {
      // The exact lines to review (names only): new findings and stale entries.
      const proposed = JSON.stringify(proposedBaseline(findings, baseline), null, 2);
      console.error(['index hygiene problems:', ...problems, 'proposed baseline (review before committing):', proposed].join('\n'));
    }
    expect(problems).toEqual([]);
  });

  it('a new unindexed foreign key is caught: a scratch table referencing core.organisation without an index fails the check', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query(`CREATE TABLE ${ws.schema}.index_hygiene_probe (id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES core.organisation(id))`);
      const findings = await collectIndexHygiene(query, ['core', ws.schema]);
      expect(indexHygieneProblems(findings, readIndexHygieneBaseline())).toEqual([
        'unindexed foreign key WS.index_hygiene_probe(organisation_id) -> core.organisation: add an index whose leading columns are the key\'s columns, or a reasoned baseline entry',
      ]);
      await admin.query(`CREATE INDEX index_hygiene_probe_org_idx ON ${ws.schema}.index_hygiene_probe (organisation_id)`);
      expect(indexHygieneProblems(await collectIndexHygiene(query, ['core', ws.schema]), readIndexHygieneBaseline())).toEqual([]);
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
