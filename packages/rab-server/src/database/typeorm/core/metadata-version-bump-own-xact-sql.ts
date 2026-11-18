// sql-injection-reviewed-file: SQL definition / check module (database layer). No interpolation of request or row data: the function text is a literal, and the only templates name code constants of this repository. Reviewed 2026-11-18 (metadata version bump own-transaction fix).
/**
 * Fix for the metadata version bump (SQL owner-approved 2026-11-18, "fix first, then build"): SQL of migration
 * MetadataVersionBumpOwnTransaction1786721570000, kept as data so the exact statement can be reviewed, scanned and
 * unit-tested. MetadataVersionState1786721560000 (merged, never edited) keeps importing its own constants from
 * ./metadata-version-sql.ts; this module only adds.
 *
 * ROOT CAUSE (THREAT-MODEL "Metadata version bump: lost step on concurrent first changes"). core.metadata_version_bump()
 * is VOLATILE plpgsql, so under READ COMMITTED each statement takes a fresh snapshot. Its "Already bumped by this
 * transaction?" check was a bare existence test:
 *
 *   PERFORM 1 FROM core.workspace_metadata_state s WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation;
 *
 * When the step-1 UPDATE saw no row (none committed yet) and a concurrent first change committed the row before this
 * PERFORM ran, the PERFORM saw that other transaction's row, took it for this transaction's own bump and returned: the
 * change committed with no version step (measured on a throwaway database: 11 of 150 workspaces with six uncoordinated
 * first writers lost a step; deterministic with a pause between the two statements). The cache keys every entry on that
 * version, so a lost step would let a stale snapshot stay current once the cache is wired into a request path.
 *
 * FIX (the only change, one predicate): the short-circuit matches only a bump by THIS transaction
 * (`AND s.last_bump_xact = v_xact`). A row another transaction created or bumped now falls through to the existing
 * INSERT ... ON CONFLICT DO NOTHING (conflict, no insert) and the final UPDATE, which steps +1 on the newest row version
 * (row lock + re-check). A row this transaction already bumped still returns early, so "at most once per transaction and
 * workspace" and "never backwards" are unchanged; no advisory lock is added (plain writes stay uncoordinated, as the E5
 * contract states).
 *
 * CREATE OR REPLACE keeps the function's OID (the five AFTER ROW triggers stay attached), its owner crewflow and its ACL
 * (EXECUTE revoked from PUBLIC); the migration re-checks all of that with METADATA_VERSION_STATE_SQL after the replace.
 */
import { METADATA_VERSION_BUMP_FUNCTION_SQL } from './metadata-version-sql';

/** The fixed "already bumped?" short-circuit: only a bump by THIS transaction counts. */
export const METADATA_VERSION_OWN_BUMP_CHECK =
  'PERFORM 1 FROM core.workspace_metadata_state s WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact = v_xact;';

/** The 1786721560000 short-circuit it replaces (any row of the workspace, whoever wrote it). */
export const METADATA_VERSION_ANY_ROW_CHECK =
  'PERFORM 1 FROM core.workspace_metadata_state s WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation;';

/** up(): the bump function with the own-transaction predicate. Verbatim the owner-approved SQL. */
export const METADATA_VERSION_BUMP_OWN_XACT_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION core.metadata_version_bump()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_workspace uuid;
  v_organisation uuid;
  v_xact xid8 := pg_catalog.pg_current_xact_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_workspace := OLD.workspace_id;
    v_organisation := OLD.organisation_id;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id) THEN
      RAISE EXCEPTION 'metadata rows never move between workspaces' USING ERRCODE = '42501';
    END IF;
    v_workspace := NEW.workspace_id;
    v_organisation := NEW.organisation_id;
  END IF;

  -- First change of this transaction for this workspace: one step. Later changes in the same transaction match nothing.
  UPDATE core.workspace_metadata_state s
     SET metadata_version = s.metadata_version + 1, last_bump_xact = v_xact, updated_at = pg_catalog.now()
   WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact IS DISTINCT FROM v_xact;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- A DELETE never creates the row: a workspace being deleted cascades its metadata, and re-inserting its version row
  -- would fail the foreign key and block the deletion. Without a row the cache reads through uncached.
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  -- Already bumped by this transaction?
  PERFORM 1 FROM core.workspace_metadata_state s WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact = v_xact;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- First metadata of this workspace.
  INSERT INTO core.workspace_metadata_state (workspace_id, organisation_id, metadata_version, last_bump_xact)
  VALUES (v_workspace, v_organisation, 1, v_xact)
  ON CONFLICT (workspace_id) DO NOTHING;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- A concurrent transaction created it and committed while we waited on the key: step on top of its version.
  UPDATE core.workspace_metadata_state s
     SET metadata_version = s.metadata_version + 1, last_bump_xact = v_xact, updated_at = pg_catalog.now()
   WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact IS DISTINCT FROM v_xact;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'metadata version row is not visible to this transaction' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$fn$`;

/** down(): the body of MetadataVersionState1786721560000, replaced in place (same OID, owner and ACL). */
export const METADATA_VERSION_BUMP_RESTORE_FUNCTION_SQL = METADATA_VERSION_BUMP_FUNCTION_SQL.replace(
  /^CREATE FUNCTION core\.metadata_version_bump\(\)/,
  'CREATE OR REPLACE FUNCTION core.metadata_version_bump()',
);

/** md5 of the installed bump function's source (pg_proc.prosrc), or NULL when it does not exist. */
export const METADATA_VERSION_BUMP_PROSRC_MD5_SQL = `SELECT pg_catalog.md5(p.prosrc) AS body_md5
  FROM pg_catalog.pg_proc p
 WHERE p.oid = pg_catalog.to_regprocedure('core.metadata_version_bump()')`;

/** The source text PostgreSQL stores in pg_proc.prosrc for one of the CREATE statements above (between the $fn$ tags). */
export function functionBodyOf(createSql: string): string {
  const m = /AS \$fn\$([\s\S]*)\$fn\$$/.exec(createSql);
  if (!m) throw new Error('functionBodyOf: no $fn$ body');
  return m[1]!;
}
