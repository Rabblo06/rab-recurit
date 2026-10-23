/**
 * FROZEN with migration ArchiveAndSearchSchema1786719920000 (never edited after merge; a later change is a new module).
 *
 * Waves 4+5 lane DB5 (search, CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §3.13). Contract:
 * docs/evidence/w45-db5/CONTRACT.md §4. Requires `unaccent` + `pg_trgm` and `core.immutable_unaccent(text)`, created by
 * the same migration in `core` before any workspace module runs.
 *
 *  - `search_vector tsvector GENERATED ALWAYS AS (...) STORED` + GIN on staff_profile (staff_ref, preferred_name), venue
 *    (name, client_name) and shift (address, notes); config `simple` (names and references: no stemming); input normalised
 *    with `core.immutable_unaccent(lower(...))`. **No email, phone or address-of-a-person column in any vector** (email
 *    search needs its own permission-gated path; names live in core."user", indexed by the migration).
 *  - Trigram GIN (`public.gin_trgm_ops`) on short identifiers users already infix-search with ILIKE: `lower(staff_ref)`,
 *    `immutable_unaccent(lower(venue.name))`, `immutable_unaccent(lower(job_role.name))`. Queries must use the identical
 *    expression to use them.
 *  - job_offer is not indexed: it has no searchable text of its own.
 *  - Indexes never bypass RLS; generated columns inherit the table's policies and grants (table-level grants here).
 *
 * A STORED generated column REWRITES the table under ACCESS EXCLUSIVE (measured on dev, see WAVES45_LANE_DB5_REPORT.md).
 * Applied to `core` by the migration and to every workspace schema as module `v1.017-search-vectors`.
 */
const norm = (expr: string) => `core.immutable_unaccent(lower(${expr}))`;
const vector = (a: string, b: string) =>
  `to_tsvector('pg_catalog.simple'::regconfig, ${norm(`coalesce(${a}, '') || ' ' || coalesce(${b}, '')`)})`;

export const SEARCH_VECTOR_TABLES = [
  { table: 'staff_profile', a: 'staff_ref', b: 'preferred_name' },
  { table: 'venue', a: 'name', b: 'client_name' },
  { table: 'shift', a: 'address', b: 'notes' },
] as const;

export const TRIGRAM_INDEXES = [
  { name: 'staff_profile_staff_ref_trgm_idx', table: 'staff_profile', expr: 'lower(staff_ref)' },
  { name: 'venue_name_trgm_idx', table: 'venue', expr: norm('name') },
  { name: 'job_role_name_trgm_idx', table: 'job_role', expr: norm('name') },
] as const;

export function searchVectorsSql(schema: string): string {
  const statements: string[] = [];
  for (const v of SEARCH_VECTOR_TABLES) {
    statements.push(`ALTER TABLE ${schema}.${v.table} ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (${vector(v.a, v.b)}) STORED`);
    statements.push(`CREATE INDEX ${v.table}_search_vector_idx ON ${schema}.${v.table} USING gin (search_vector)`);
  }
  for (const t of TRIGRAM_INDEXES) {
    statements.push(`CREATE INDEX ${t.name} ON ${schema}.${t.table} USING gin ((${t.expr}) public.gin_trgm_ops)`);
  }
  return statements.join(';\n');
}

/** core."user" (core only — names live here, never email/phone). */
export const USER_SEARCH_SQL = [
  `ALTER TABLE core."user" ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (${vector('first_name', 'last_name')}) STORED`,
  `CREATE INDEX user_search_vector_idx ON core."user" USING gin (search_vector)`,
  `CREATE INDEX user_name_trgm_idx ON core."user" USING gin ((${norm(`first_name || ' ' || last_name`)}) public.gin_trgm_ops)`,
  `GRANT SELECT (search_vector) ON core."user" TO crewflow_app, crewflow`,
].join(';\n');

/** Extensions + the IMMUTABLE wrapper. Fully qualified so it is inlinable and immune to search_path. */
export const SEARCH_PREREQUISITES_SQL = `
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE OR REPLACE FUNCTION core.immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $unaccent$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $unaccent$;
ALTER FUNCTION core.immutable_unaccent(text) OWNER TO crewflow;
`;
