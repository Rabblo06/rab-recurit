/**
 * Metadata engine E5 — the shape of one workspace's cached metadata and the two SQL statements that read it.
 *
 * Both statements take the tenant identity ONLY from the transaction-local GUCs (`core.current_org()`,
 * `core.current_workspace()`), never from a caller argument, and return it next to the data. The cache builds its key
 * from what PostgreSQL says is bound, so a caller cannot ask for (or be served) another workspace's entry by passing the
 * wrong id. Every subquery repeats the org + workspace predicate (layer 3) on top of the tables' FORCE RLS tenant policy
 * (layer 4).
 *
 * `LOAD_SQL` is ONE statement on purpose: PostgreSQL gives a statement a single snapshot (in READ COMMITTED too), so the
 * version and the rows it returns always belong together. That is the property the cache's correctness rests on — an
 * entry is only ever stored under the version that was read in the same snapshot as its content, so a fill that races a
 * metadata change can never store old content under the new version. (The entity cache's epoch read the version from
 * Redis and the content from PostgreSQL in two separate steps; that gap is what this design removes.)
 *
 * Rows are kept as the database returns them (`to_jsonb(row)`, snake_case), so this cache does not depend on the exact
 * column list of the E1 tables. Typed views (object by API name, field maps, GraphQL types) are derived artefacts built
 * on top and cached under the same (organisation, workspace, version) key by their owners (E4/E6).
 */

export type MetadataRow = Readonly<Record<string, unknown>>;

export interface WorkspaceMetadataSnapshot {
  readonly organisationId: string;
  readonly workspaceId: string;
  /**
   * `core.workspace_metadata_state.metadata_version` as a canonical decimal string (bigint). `'0'` means the workspace has
   * no version row yet (no metadata was ever written); such a snapshot is never cached.
   */
  readonly version: string;
  readonly objects: readonly MetadataRow[];
  readonly fields: readonly MetadataRow[];
  readonly fieldOptions: readonly MetadataRow[];
  readonly indexes: readonly MetadataRow[];
  readonly indexFields: readonly MetadataRow[];
}

/** The cheap per-call authority read: who is bound, and the current version (null = no version row). */
export interface MetadataHead {
  organisationId: string;
  workspaceId: string;
  version: string | null;
}

/** Version `'0'`: no version row exists, nothing is cacheable. */
export const NO_METADATA_VERSION = '0';

export const HEAD_SQL = `SELECT core.current_org()::text AS organisation_id,
       core.current_workspace()::text AS workspace_id,
       (SELECT s.metadata_version::text
          FROM core.workspace_metadata_state s
         WHERE s.workspace_id = core.current_workspace()
           AND s.organisation_id = core.current_org()) AS metadata_version`;

function rowsOf(table: string, orderBy: string): string {
  return `(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${orderBy}), '[]'::jsonb)
            FROM core.${table} t
           WHERE t.workspace_id = core.current_workspace()
             AND t.organisation_id = core.current_org())`;
}

export const LOAD_SQL = `SELECT core.current_org()::text AS organisation_id,
       core.current_workspace()::text AS workspace_id,
       (SELECT s.metadata_version::text
          FROM core.workspace_metadata_state s
         WHERE s.workspace_id = core.current_workspace()
           AND s.organisation_id = core.current_org()) AS metadata_version,
       ${rowsOf('object_metadata', 't.id')} AS objects,
       ${rowsOf('field_metadata', 't.id')} AS fields,
       ${rowsOf('field_metadata_option', 't.id')} AS field_options,
       ${rowsOf('index_metadata', 't.id')} AS indexes,
       ${rowsOf('index_field_metadata', 't.index_metadata_id, t.position')} AS index_fields`;

/**
 * M2 (optimistic concurrency): lock the version row for the rest of the transaction and return its value. The row lock
 * serialises concurrent metadata changes of one workspace; the version trigger then bumps it once in this transaction.
 */
export const LOCK_VERSION_SQL = `SELECT s.metadata_version::text AS metadata_version
  FROM core.workspace_metadata_state s
 WHERE s.workspace_id = core.current_workspace()
   AND s.organisation_id = core.current_org()
   FOR UPDATE`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^[1-9][0-9]{0,18}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isCacheableVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}

/** Numeric order of two canonical version strings (no leading zeros), without floating point. */
export function compareVersions(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function isRowArray(value: unknown): value is MetadataRow[] {
  return Array.isArray(value) && value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}
