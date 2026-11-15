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
  /**
   * The bump time of that version (`updated_at`, microseconds since the epoch, decimal string; `'0'` with version `'0'`).
   * Part of the cache identity with the version: if a version number is ever reused — a database restored from a backup,
   * the version row recreated — the new bump has another time, so no entry cached before can match it.
   */
  readonly stamp: string;
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
  stamp: string | null;
  /**
   * True when THIS transaction bumped the version (it changed metadata and has not committed). Its view is uncommitted
   * and may still change before commit under the same (version, stamp), so it is read through and never cached.
   */
  ownBump: boolean;
}

/** Version `'0'`: no version row exists, nothing is cacheable. */
export const NO_METADATA_VERSION = '0';

/**
 * Always exactly one row (the LEFT JOIN keeps it when the workspace has no version row yet). `metadata_stamp` is the bump
 * time in microseconds. Plain literals on purpose (no interpolation): nothing here is built at run time.
 */
export const HEAD_SQL = `SELECT core.current_org()::text AS organisation_id,
       core.current_workspace()::text AS workspace_id,
       s.metadata_version::text AS metadata_version,
       (extract(epoch FROM s.updated_at) * 1000000)::bigint::text AS metadata_stamp,
       COALESCE(s.last_bump_xact = pg_catalog.pg_current_xact_id_if_assigned(), false) AS own_bump
  FROM (SELECT 1) one
  LEFT JOIN core.workspace_metadata_state s
    ON s.workspace_id = core.current_workspace() AND s.organisation_id = core.current_org()`;

export const LOAD_SQL = `SELECT core.current_org()::text AS organisation_id,
       core.current_workspace()::text AS workspace_id,
       s.metadata_version::text AS metadata_version,
       (extract(epoch FROM s.updated_at) * 1000000)::bigint::text AS metadata_stamp,
       COALESCE(s.last_bump_xact = pg_catalog.pg_current_xact_id_if_assigned(), false) AS own_bump,
       (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
          FROM core.object_metadata t
         WHERE t.workspace_id = core.current_workspace() AND t.organisation_id = core.current_org()) AS objects,
       (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
          FROM core.field_metadata t
         WHERE t.workspace_id = core.current_workspace() AND t.organisation_id = core.current_org()) AS fields,
       (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
          FROM core.field_metadata_option t
         WHERE t.workspace_id = core.current_workspace() AND t.organisation_id = core.current_org()) AS field_options,
       (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
          FROM core.index_metadata t
         WHERE t.workspace_id = core.current_workspace() AND t.organisation_id = core.current_org()) AS indexes,
       (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.index_metadata_id, t.position), '[]'::jsonb)
          FROM core.index_field_metadata t
         WHERE t.workspace_id = core.current_workspace() AND t.organisation_id = core.current_org()) AS index_fields
  FROM (SELECT 1) one
  LEFT JOIN core.workspace_metadata_state s
    ON s.workspace_id = core.current_workspace() AND s.organisation_id = core.current_org()`;

/**
 * M2 (optimistic concurrency), step 1: a transaction-scoped advisory lock per workspace. It also serialises the very first
 * change of a workspace, when no version row exists yet to lock. Must be its own statement: the version read after it
 * needs a snapshot taken AFTER the lock was granted (READ COMMITTED).
 */
export const LOCK_WORKSPACE_METADATA_SQL = `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crewflow:metadata:' || core.current_workspace()::text, 0))`;

/** Step 2: lock the version row for the rest of the transaction and return its value. */
export const LOCK_VERSION_SQL = `SELECT s.metadata_version::text AS metadata_version
  FROM core.workspace_metadata_state s
 WHERE s.workspace_id = core.current_workspace()
   AND s.organisation_id = core.current_org()
   FOR UPDATE`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^[1-9][0-9]{0,18}$/;
const STAMP_RE = /^-?[0-9]{1,19}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isCacheableVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}

export function isStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP_RE.test(value);
}

/** The cache identity of one version: `<version>.<stamp>` (used in the Redis key and the in-process tier). */
export function cacheToken(version: string, stamp: string): string {
  return `${version}.${stamp}`;
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
