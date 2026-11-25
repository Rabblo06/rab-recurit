import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Index hygiene (index-fix tooling 1 and 3, docs/plans/index-fix/CREWFLOW_INDEX_FIX_PROMPT.md "Tooling"): catalogue checks
 * that keep the index set from regressing. Read-only: every statement here is a SELECT on pg_catalog, run as any role.
 *
 *   1. Every foreign key has an index whose leading key columns are the foreign key's columns (any order; or, as in the
 *      owner-reviewed index-fix evidence, whose leading column is the key's first column), so a parent DELETE/UPDATE (the
 *      RI trigger's `WHERE fk = $1`) and the usual joins are not a sequential scan of the child. A partial index counts
 *      only when its predicate is nothing but `<fk column> IS NOT NULL` (implied by `fk = $1`).
 *   2. No index is INVALID (a failed CREATE INDEX CONCURRENTLY leaves one behind; it costs writes and serves nothing).
 *   3. Index names follow the convention (`_idx`, `_key`, `_pkey`, `_uq`, `_uniq`, `_unique`, `_uidx`, `_excl`) and are not
 *      63 bytes long: PostgreSQL silently truncates a longer name to 63, so a later DROP/ALTER by the full name misses.
 *   4. Report only: an index whose key columns are a leading prefix of another index on the same table (same method, same
 *      predicate, neither enforcing a constraint) is listed as a redundancy candidate (index-fix L1). Never fails: dropping
 *      one needs production idx_scan evidence and the owner's decision.
 *
 * Today's findings are the committed baseline (index-hygiene.baseline.json), each with a reason. The comparison is exact:
 * a NEW finding fails, and so does a baseline entry that no longer matches anything (remove it in the PR that fixed it), so
 * the baseline only ever shrinks deliberately. Adding or dropping an index stays an owner decision (index-fix IDX-C/D/E,
 * L1-L7); this file only stops new gaps.
 *
 * Workspace schemas (`workspace_<32 hex>`) are canonicalised to `WS`, so one entry covers every workspace.
 */

export type CatalogQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export const WORKSPACE_SCHEMA_PATTERN = /^workspace_[0-9a-f]{32}$/;
export const INDEX_NAME_SUFFIX = /_(idx|key|pkey|uq|uniq|unique|uidx|excl)$/;
/** PostgreSQL's NAMEDATALEN - 1: a name of exactly this many bytes was probably truncated. */
export const MAX_IDENTIFIER_BYTES = 63;

export const INDEX_HYGIENE_BASELINE_FILE = join(__dirname, 'index-hygiene.baseline.json');

export interface ForeignKeyRow {
  schema: string;
  table: string;
  constraint: string;
  columns: string[];
  parent_schema: string;
  parent_table: string;
  on_delete: string;
}

export interface IndexRow {
  schema: string;
  table: string;
  name: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  /** Key columns in order (INCLUDE columns excluded); null for an expression column. */
  keys: Array<string | null>;
  predicate: string | null;
  /** p / u / x when the index backs a constraint, else null. */
  constraint_type: string | null;
}

export interface BaselineEntry {
  key: string;
  reason: string;
}

export interface IndexHygieneBaseline {
  unindexedForeignKeys: BaselineEntry[];
  indexNames: BaselineEntry[];
}

const FOREIGN_KEYS_SQL = `
  SELECT n.nspname::text AS schema, cl.relname::text AS "table", c.conname::text AS "constraint",
         ARRAY(SELECT a.attname::text
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                ORDER BY k.ord) AS columns,
         pn.nspname::text AS parent_schema, pc.relname::text AS parent_table,
         CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_catalog.pg_class pc ON pc.oid = c.confrelid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
   WHERE c.contype = 'f' AND n.nspname = ANY($1::text[])
   ORDER BY 1, 2, 3`;

const INDEXES_SQL = `
  SELECT n.nspname::text AS schema, t.relname::text AS "table", ic.relname::text AS name, am.amname::text AS method,
         i.indisunique AS "unique", i.indisprimary AS "primary", (i.indisvalid AND i.indisready) AS valid,
         ARRAY(SELECT a.attname::text
                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum AND k.attnum > 0
                WHERE k.ord <= i.indnkeyatts
                ORDER BY k.ord) AS keys,
         pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
         (SELECT con.contype::text FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x') LIMIT 1) AS constraint_type
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
   WHERE n.nspname = ANY($1::text[])
   ORDER BY 1, 2, 3`;

const SCHEMAS_SQL = `SELECT nspname::text AS name FROM pg_catalog.pg_namespace WHERE nspname = 'core' OR nspname ~ '^workspace_[0-9a-f]{32}$' ORDER BY 1`;

export async function listCheckedSchemas(query: CatalogQuery): Promise<string[]> {
  return (await query<{ name: string }>(SCHEMAS_SQL)).map((r) => r.name);
}

export async function readForeignKeys(query: CatalogQuery, schemas: readonly string[]): Promise<ForeignKeyRow[]> {
  return query<ForeignKeyRow>(FOREIGN_KEYS_SQL, [schemas]);
}

export async function readIndexes(query: CatalogQuery, schemas: readonly string[]): Promise<IndexRow[]> {
  return query<IndexRow>(INDEXES_SQL, [schemas]);
}

export function canonicalSchema(schema: string): string {
  return WORKSPACE_SCHEMA_PATTERN.test(schema) ? 'WS' : schema;
}

export function foreignKeyKey(fk: ForeignKeyRow): string {
  return `${canonicalSchema(fk.schema)}.${fk.table}(${fk.columns.join(',')}) -> ${canonicalSchema(fk.parent_schema)}.${fk.parent_table}`;
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"') ? identifier.slice(1, -1).replace(/""/g, '"') : identifier;
}

/** True when a partial index's predicate is only `<column> IS NOT NULL` conjunctions over the given columns. */
export function predicateOnlyNotNull(predicate: string, columns: readonly string[]): boolean {
  let text = predicate.trim();
  while (text.startsWith('(') && text.endsWith(')') && balanced(text.slice(1, -1))) text = text.slice(1, -1).trim();
  return text.split(/\s+AND\s+/i).every((part) => {
    const m = /^\(?\s*("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\s+IS\s+NOT\s+NULL\s*\)?$/i.exec(part.trim());
    return m !== null && columns.includes(unquote(m[1]!));
  });
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * An index serves a foreign key when its first k key columns are the key's k columns (any order), or when its leading
 * column is the key's first column (the rule of the owner-reviewed index-fix evidence, catalog-extract.sql: for a composite
 * key such as (conversation_id, organisation_id, ...) an index leading with conversation_id already makes the lookup an
 * index scan). Valid btree indexes only (or hash, for a one-column key).
 */
export function indexServesForeignKey(index: IndexRow, fk: ForeignKeyRow): boolean {
  if (!index.valid || index.schema !== fk.schema || index.table !== fk.table) return false;
  if (index.method !== 'btree' && !(index.method === 'hash' && fk.columns.length === 1)) return false;
  const leading = index.keys.slice(0, fk.columns.length);
  const want = new Set(fk.columns);
  const sameSet = leading.length === fk.columns.length && leading.every((k) => k !== null && want.has(k)) && new Set(leading).size === want.size;
  const sameFirst = index.keys[0] !== null && index.keys[0] !== undefined && index.keys[0] === fk.columns[0];
  if (!sameSet && !sameFirst) return false;
  return index.predicate === null || predicateOnlyNotNull(index.predicate, fk.columns);
}

export function unindexedForeignKeys(fks: readonly ForeignKeyRow[], indexes: readonly IndexRow[]): ForeignKeyRow[] {
  return fks.filter((fk) => !indexes.some((index) => indexServesForeignKey(index, fk)));
}

export function invalidIndexes(indexes: readonly IndexRow[]): IndexRow[] {
  return indexes.filter((i) => !i.valid);
}

export function indexNameKey(index: Pick<IndexRow, 'schema' | 'table' | 'name'>, problem: 'suffix' | 'length'): string {
  return `${canonicalSchema(index.schema)}.${index.table}.${index.name}: ${problem}`;
}

/** Name findings: a name without a conventional suffix, or one of exactly 63 bytes (probably truncated). */
export function indexNameProblems(indexes: readonly IndexRow[]): string[] {
  const out = new Set<string>();
  for (const index of indexes) {
    if (Buffer.byteLength(index.name, 'utf8') >= MAX_IDENTIFIER_BYTES) out.add(indexNameKey(index, 'length'));
    if (!INDEX_NAME_SUFFIX.test(index.name)) out.add(indexNameKey(index, 'suffix'));
  }
  return [...out].sort();
}

/** Report only: index A is redundant with B when A's keys are a leading prefix of B's (same table, method, predicate). */
export function redundantIndexes(indexes: readonly IndexRow[]): Array<{ index: string; coveredBy: string }> {
  const out = new Map<string, string>();
  for (const a of indexes) {
    if (a.unique || a.primary || a.constraint_type || a.keys.some((k) => k === null)) continue;
    for (const b of indexes) {
      if (a === b || b.schema !== a.schema || b.table !== a.table || b.method !== a.method || b.predicate !== a.predicate) continue;
      if (b.keys.length < a.keys.length || !a.keys.every((k, i) => b.keys[i] === k)) continue;
      // Two identical non-unique indexes: report the later name once.
      if (b.keys.length === a.keys.length && !b.unique && !b.constraint_type && a.name < b.name) continue;
      const key = `${canonicalSchema(a.schema)}.${a.table}.${a.name}`;
      if (!out.has(key)) out.set(key, `${canonicalSchema(b.schema)}.${b.table}.${b.name}`);
    }
  }
  return [...out.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([index, coveredBy]) => ({ index, coveredBy }));
}

export interface BaselineComparison {
  /** Findings with no baseline entry: fail. */
  unexpected: string[];
  /** Baseline entries that match no finding: fail (remove the entry). */
  stale: string[];
}

export function compareWithBaseline(found: readonly string[], baseline: readonly BaselineEntry[], scope: (key: string) => boolean = () => true): BaselineComparison {
  const foundSet = new Set(found.filter(scope));
  const baseSet = new Set(baseline.map((e) => e.key).filter(scope));
  return {
    unexpected: [...foundSet].filter((k) => !baseSet.has(k)).sort(),
    stale: [...baseSet].filter((k) => !foundSet.has(k)).sort(),
  };
}

export function readIndexHygieneBaseline(file = INDEX_HYGIENE_BASELINE_FILE): IndexHygieneBaseline {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<IndexHygieneBaseline>;
  const entries = (list: unknown, name: string): BaselineEntry[] => {
    if (!Array.isArray(list)) throw new Error(`${file}: ${name} must be an array`);
    const seen = new Set<string>();
    return list.map((e: unknown, i) => {
      const entry = e as Partial<BaselineEntry>;
      if (typeof entry?.key !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
        throw new Error(`${file}: ${name}[${i}] needs a key and a reason of at least 10 characters`);
      }
      if (seen.has(entry.key)) throw new Error(`${file}: ${name} lists ${entry.key} twice`);
      seen.add(entry.key);
      return { key: entry.key, reason: entry.reason };
    });
  };
  return { unindexedForeignKeys: entries(parsed.unindexedForeignKeys, 'unindexedForeignKeys'), indexNames: entries(parsed.indexNames, 'indexNames') };
}

/** The reason recorded for a pre-existing unindexed foreign key when the baseline is (re)generated. */
export function defaultForeignKeyReason(fk: ForeignKeyRow): string {
  const prefix = 'pre-existing on 2026-11-21 (index-fix list):';
  if (fk.parent_table === 'organisation' && fk.on_delete === 'CASCADE') return `${prefix} organisation-delete cascade child; organisations are rarely deleted (index-fix L6, owner decision)`;
  if (fk.parent_table === 'user') return `${prefix} user-reference foreign key (index-fix IDX-C / H5, awaiting the owner's decision)`;
  return `${prefix} unindexed foreign key (index-fix L5, awaiting the owner's decision)`;
}

export const DEFAULT_INDEX_NAME_REASON = 'pre-existing on 2026-11-21: the name predates the naming lint; renaming an index is a migration and an owner decision';

export interface IndexHygieneFindings {
  schemas: string[];
  foreignKeys: number;
  indexes: number;
  unindexed: ForeignKeyRow[];
  invalid: IndexRow[];
  names: string[];
  redundant: Array<{ index: string; coveredBy: string }>;
}

export async function collectIndexHygiene(query: CatalogQuery, schemas: readonly string[]): Promise<IndexHygieneFindings> {
  const fks = await readForeignKeys(query, schemas);
  const indexes = await readIndexes(query, schemas);
  return {
    schemas: [...schemas],
    foreignKeys: fks.length,
    indexes: indexes.length,
    unindexed: unindexedForeignKeys(fks, indexes),
    invalid: invalidIndexes(indexes),
    names: indexNameProblems(indexes),
    redundant: redundantIndexes(indexes),
  };
}

/**
 * Every failure line for these findings against the baseline (empty = pass). Only the keys of the scanned schemas are
 * compared (`scannedScope`), narrowed further by `scope` when given.
 */
export function indexHygieneProblems(findings: IndexHygieneFindings, baseline: IndexHygieneBaseline, extraScope?: (key: string) => boolean): string[] {
  const inScope = scannedScope(findings);
  const scope = (key: string) => inScope(key) && (extraScope ? extraScope(key) : true);
  const problems: string[] = [];
  for (const i of findings.invalid) problems.push(`invalid index ${i.schema}.${i.name} (a failed concurrent build left it behind: drop it CONCURRENTLY and rebuild)`);
  const fk = compareWithBaseline([...new Set(findings.unindexed.map(foreignKeyKey))], baseline.unindexedForeignKeys, scope);
  for (const k of fk.unexpected) problems.push(`unindexed foreign key ${k}: add an index whose leading columns are the key's columns, or a reasoned baseline entry`);
  for (const k of fk.stale) problems.push(`baseline entry ${k} matches no unindexed foreign key any more: remove it from index-hygiene.baseline.json`);
  const names = compareWithBaseline(findings.names, baseline.indexNames, scope);
  for (const k of names.unexpected) problems.push(`index name ${k}: names end in _idx/_key/_pkey/_uq/_uniq/_unique/_uidx/_excl and stay under ${MAX_IDENTIFIER_BYTES} bytes`);
  for (const k of names.stale) problems.push(`baseline entry ${k} matches no index name finding any more: remove it from index-hygiene.baseline.json`);
  return problems;
}

/** The canonical schema a baseline key belongs to (`core`, `WS`, ...). */
export function keySchema(key: string): string {
  return key.slice(0, key.indexOf('.'));
}

/** Compares only the keys of the schemas these findings scanned (a database without a workspace schema says nothing about WS). */
export function scannedScope(findings: Pick<IndexHygieneFindings, 'schemas'>): (key: string) => boolean {
  const scanned = new Set(findings.schemas.map(canonicalSchema));
  return (key) => scanned.has(keySchema(key));
}

/**
 * The baseline JSON these findings would need (a deliberate regeneration; review the diff like code). Entries of schemas
 * that were not scanned are kept as they are; reasons already written are kept.
 */
export function proposedBaseline(findings: IndexHygieneFindings, current?: IndexHygieneBaseline): IndexHygieneBaseline {
  const inScope = scannedScope(findings);
  const reasonOf = new Map((current?.unindexedForeignKeys ?? []).map((e) => [e.key, e.reason]));
  const nameReasonOf = new Map((current?.indexNames ?? []).map((e) => [e.key, e.reason]));
  const fks = new Map<string, string>((current?.unindexedForeignKeys ?? []).filter((e) => !inScope(e.key)).map((e) => [e.key, e.reason]));
  for (const fk of findings.unindexed) {
    const key = foreignKeyKey(fk);
    if (!fks.has(key)) fks.set(key, reasonOf.get(key) ?? defaultForeignKeyReason(fk));
  }
  const names = new Map<string, string>((current?.indexNames ?? []).filter((e) => !inScope(e.key)).map((e) => [e.key, e.reason]));
  for (const key of findings.names) names.set(key, nameReasonOf.get(key) ?? DEFAULT_INDEX_NAME_REASON);
  const sorted = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, reason]) => ({ key, reason }));
  return { unindexedForeignKeys: sorted(fks), indexNames: sorted(names) };
}
