/**
 * Index hygiene gate (index-fix tooling 1 and 3; the rules are in core/index-hygiene.ts). Read-only catalogue queries.
 *
 *   INDEX_HYGIENE_DATABASE_URL=postgres://... ts-node check-index-hygiene.ts                  # exit 1 on a new finding
 *   INDEX_HYGIENE_DATABASE_URL=postgres://... ts-node check-index-hygiene.ts --print-baseline # the baseline these findings need
 *
 * The URL is read ONLY from INDEX_HYGIENE_DATABASE_URL (no .env, no default) and connected through the connection factory
 * (URL policy, TLS, read-only session). Any role that can read pg_catalog works. Scans `core` and every
 * `workspace_<32 hex>` schema present; a database without a workspace schema (CI's fresh install) is compared on its core
 * entries only; the workspace (`WS`) entries are compared by index-hygiene.integration.spec.ts on a freshly provisioned one.
 * Prints names and counts only, never row data.
 */
import { createPgClientForUrl } from '../../postgres';
import {
  collectIndexHygiene,
  foreignKeyKey,
  indexHygieneProblems,
  listCheckedSchemas,
  proposedBaseline,
  readIndexHygieneBaseline,
  INDEX_HYGIENE_BASELINE_FILE,
} from '../core/index-hygiene';

async function main(): Promise<void> {
  const url = process.env.INDEX_HYGIENE_DATABASE_URL?.trim();
  if (!url) throw new Error('INDEX_HYGIENE_DATABASE_URL is required. There is no fallback.');
  const client = createPgClientForUrl(url, 'the index hygiene database URL', { purpose: 'index-hygiene', readOnly: true, statementTimeoutMs: 120_000 });
  await client.connect();
  try {
    const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => (await client.query(sql, params)).rows as T[];
    const schemas = await listCheckedSchemas(query);
    if (!schemas.includes('core')) throw new Error('no core schema in this database: point INDEX_HYGIENE_DATABASE_URL at a migrated Crewflow database');
    const findings = await collectIndexHygiene(query, schemas);
    const baseline = readIndexHygieneBaseline();
    if (process.argv.includes('--print-baseline')) {
      process.stdout.write(`${JSON.stringify(proposedBaseline(findings, baseline), null, 2)}\n`);
      return;
    }
    const workspaces = schemas.filter((s) => s !== 'core').length;
    console.log(
      `index hygiene: core + ${workspaces} workspace schema(s); ${findings.foreignKeys} foreign keys, ${findings.indexes} indexes; ` +
        `${new Set(findings.unindexed.map(foreignKeyKey)).size} unindexed foreign key(s) and ${findings.names.length} name finding(s) ` +
        `(baseline: ${baseline.unindexedForeignKeys.length} + ${baseline.indexNames.length}); ${findings.invalid.length} invalid index(es)`,
    );
    if (findings.redundant.length > 0) {
      console.log(`report only (index-fix L1; dropping one needs production idx_scan evidence and the owner's decision): ${findings.redundant.length} redundancy candidate(s)`);
      for (const r of findings.redundant) console.log(`  ${r.index} is a leading prefix of ${r.coveredBy}`);
    }
    const problems = indexHygieneProblems(findings, baseline);
    if (problems.length > 0) {
      console.error(`index hygiene FAILED (${problems.length}); baseline: ${INDEX_HYGIENE_BASELINE_FILE}`);
      for (const p of problems) console.error(`  ${p}`);
      // The baseline these findings would need, for review (never applied automatically). Names only.
      console.log('::group::proposed index-hygiene.baseline.json for these findings (review each change; fix rather than baseline where possible)');
      console.log(JSON.stringify(proposedBaseline(findings, baseline), null, 2));
      console.log('::endgroup::');
      process.exitCode = 1;
      return;
    }
    console.log('index hygiene OK: no new unindexed foreign key, no invalid index, no new index name finding, no stale baseline entry');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`index hygiene check failed to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
