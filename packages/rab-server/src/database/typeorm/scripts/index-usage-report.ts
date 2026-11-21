/**
 * Read-only index usage report (index-fix tooling 5 and 6, docs/plans/index-fix/CREWFLOW_INDEX_FIX_PROMPT.md "Tooling"):
 * the evidence the owner needs before deciding a drop (index-fix L1/L2) or an addition (IDX-C/D).
 *
 *   INDEX_REPORT_DATABASE_URL=postgres://... ts-node index-usage-report.ts          # summary, unused and largest indexes
 *   INDEX_REPORT_DATABASE_URL=postgres://... ts-node index-usage-report.ts --full   # every index
 *
 * Prints, for `core` and every `workspace_<32 hex>` schema (canonicalised to WS, summed over workspaces):
 *   - when the statistics were last reset (idx_scan counts only since then; on a replica they are that replica's own);
 *   - index count and total index size;
 *   - indexes never scanned since the reset (idx_scan = 0), excluding those that enforce a constraint (primary key,
 *     unique, exclusion): the drop candidates, largest first;
 *   - the largest indexes with their scan counts;
 *   - with pgstattuple installed: leaf density and fragmentation of the 10 largest btree indexes (bloat);
 *   - with pg_stat_statements installed (it must be in shared_preload_libraries): the 20 statements with the most total
 *     execution time (normalised text, constants already replaced by $n, cut to 160 characters).
 * Each optional section says so when its extension is missing instead of failing. Every statement is a SELECT, run in a
 * READ ONLY session (the connection factory's `default_transaction_read_only`); the URL is read only from
 * INDEX_REPORT_DATABASE_URL. Never point it at production without the owner's go-ahead: it is safe to run, but production
 * access is the owner's call.
 */
import { createPgClientForUrl } from '../../postgres';
import { canonicalSchema } from '../core/index-hygiene';

interface IndexUsageRow {
  schema: string;
  table: string;
  name: string;
  scans: string;
  bytes: string;
  enforces: boolean;
}

const USAGE_SQL = `
  SELECT s.schemaname::text AS schema, s.relname::text AS "table", s.indexrelname::text AS name, s.idx_scan::text AS scans,
         pg_catalog.pg_relation_size(s.indexrelid)::text AS bytes,
         (i.indisprimary OR i.indisunique OR i.indisexclusion) AS enforces
    FROM pg_catalog.pg_stat_user_indexes s
    JOIN pg_catalog.pg_index i ON i.indexrelid = s.indexrelid
   WHERE s.schemaname = 'core' OR s.schemaname ~ '^workspace_[0-9a-f]{32}$'`;

const STATS_RESET_SQL = `SELECT coalesce(stats_reset::text, 'never (since cluster creation)') AS reset FROM pg_catalog.pg_stat_database WHERE datname = current_database()`;
const EXTENSIONS_SQL = `SELECT extname::text AS name FROM pg_catalog.pg_extension WHERE extname IN ('pgstattuple', 'pg_stat_statements')`;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const url = process.env.INDEX_REPORT_DATABASE_URL?.trim();
  if (!url) throw new Error('INDEX_REPORT_DATABASE_URL is required. There is no fallback.');
  const full = process.argv.includes('--full');
  const client = createPgClientForUrl(url, 'the index report database URL', { purpose: 'index-report', readOnly: true, statementTimeoutMs: 120_000 });
  await client.connect();
  try {
    const reset = (await client.query<{ reset: string }>(STATS_RESET_SQL)).rows[0]?.reset ?? 'unknown';
    const rows = (await client.query<IndexUsageRow>(USAGE_SQL)).rows;
    // Sum each canonical index over every workspace schema (one line per WS index, not per workspace).
    const merged = new Map<string, { schema: string; table: string; name: string; scans: number; bytes: number; enforces: boolean; copies: number }>();
    for (const r of rows) {
      const schema = canonicalSchema(r.schema);
      const key = `${schema}.${r.table}.${r.name}`;
      const m = merged.get(key) ?? { schema, table: r.table, name: r.name, scans: 0, bytes: 0, enforces: r.enforces, copies: 0 };
      m.scans += Number(r.scans);
      m.bytes += Number(r.bytes);
      m.copies += 1;
      merged.set(key, m);
    }
    const all = [...merged.values()].sort((a, b) => b.bytes - a.bytes);
    const line = (i: (typeof all)[number]) => `  ${i.schema}.${i.table}.${i.name}  scans=${i.scans}  size=${mb(i.bytes)}${i.copies > 1 ? ` (${i.copies} workspaces)` : ''}`;
    console.log(`statistics since: ${reset}`);
    console.log(`indexes: ${all.length} (${rows.length} physical), total size ${mb(all.reduce((s, i) => s + i.bytes, 0))}`);
    const unused = all.filter((i) => i.scans === 0 && !i.enforces);
    console.log(`never scanned since the reset, enforcing no constraint (drop candidates, largest first): ${unused.length}`);
    for (const i of full ? unused : unused.slice(0, 30)) console.log(line(i));
    console.log(full ? 'every index, largest first:' : 'largest 20 indexes:');
    for (const i of full ? all : all.slice(0, 20)) console.log(line(i));

    const extensions = new Set((await client.query<{ name: string }>(EXTENSIONS_SQL)).rows.map((r) => r.name));
    if (extensions.has('pgstattuple')) {
      console.log('btree bloat (pgstattuple, 10 largest btree indexes):');
      const bloat = await client.query<{ name: string; density: string; fragmentation: string }>(
        `SELECT n.nspname || '.' || c.relname AS name, (s).avg_leaf_density::text AS density, (s).leaf_fragmentation::text AS fragmentation
           FROM (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_am am ON am.oid = c.relam
                  WHERE c.relkind = 'i' AND am.amname = 'btree' AND (n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$')
                  ORDER BY pg_catalog.pg_relation_size(c.oid) DESC LIMIT 10) big
           JOIN pg_catalog.pg_class c ON c.oid = big.oid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
                LATERAL (SELECT pgstatindex(big.oid) AS s) x`,
      );
      for (const b of bloat.rows) console.log(`  ${b.name}  leaf density=${b.density}%  fragmentation=${b.fragmentation}%`);
    } else {
      console.log('btree bloat: pgstattuple is not installed in this database (CREATE EXTENSION pgstattuple, an owner decision)');
    }
    if (extensions.has('pg_stat_statements')) {
      console.log('top 20 statements by total execution time (pg_stat_statements):');
      const top = await client.query<{ calls: string; total_ms: string; mean_ms: string; query: string }>(
        `SELECT calls::text, round(total_exec_time)::text AS total_ms, round(mean_exec_time::numeric, 2)::text AS mean_ms,
                left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query
           FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
          ORDER BY total_exec_time DESC LIMIT 20`,
      );
      for (const t of top.rows) console.log(`  total=${t.total_ms} ms  calls=${t.calls}  mean=${t.mean_ms} ms  ${t.query}`);
    } else {
      console.log('top statements: pg_stat_statements is not installed here (shared_preload_libraries + CREATE EXTENSION; provider support and enabling it are owner decisions)');
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`index usage report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
