// sql-injection-reviewed-file: SQL definition module (database layer). The only interpolation is a code constant of this repository (the frozen v1 guard text from staff-document-sql.ts); no request or row data reaches these templates. Reviewed 2026-11-24 (Lane D follow-up, DRAFT for owner SQL review).
import { STAFF_DOCUMENT_GUARD_FUNCTION_SQL } from './staff-document-sql';

/**
 * Lane D follow-up (independent v2 re-review, Low): StaffDocumentGuardScanBinding1786722320000. DRAFT — owner SQL review first.
 *
 * The v1 guard (StaffDocumentSchema1786722300000) let a session whose current_user is `crewflow` change the scan columns when
 * the document was still not_scanned and the status did not change — it checked the ROLE only. A session that runs
 * `SET ROLE crewflow` (or `set_config('role', 'crewflow', true)` inside a statement) could therefore UPDATE the scan columns
 * directly and skip the bindings core.staff_document_record_scan() applies. The guard now repeats those bindings inside the
 * branch: the verdict is `clean`, the row belongs to the bound organisation + workspace, and it was uploaded by the CURRENT
 * user IN THIS TRANSACTION (OLD.created_at = now(), which the guard itself forces on INSERT). Anything else: 42501.
 *
 * Only the function body changes (CREATE OR REPLACE keeps the owner crewflow, SECURITY INVOKER, the pinned search_path, the
 * revoked PUBLIC EXECUTE and the three triggers). No table, policy or grant changes.
 */
const V1_BRANCH = `    IF current_user IS DISTINCT FROM 'crewflow'::name OR OLD.scan_status <> 'not_scanned' OR NEW.status IS DISTINCT FROM OLD.status THEN`;
const V2_BRANCH = `    IF current_user IS DISTINCT FROM 'crewflow'::name OR OLD.scan_status <> 'not_scanned' OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.scan_status IS DISTINCT FROM 'clean'
       OR OLD.uploaded_by IS DISTINCT FROM v_uid OR OLD.created_at IS DISTINCT FROM pg_catalog.now()
       OR OLD.organisation_id IS DISTINCT FROM core.current_org() OR OLD.workspace_id IS DISTINCT FROM core.current_workspace() THEN`;

const replaceable = (sql: string) => {
  if (!sql.startsWith('CREATE FUNCTION core.staff_document_guard()'))
    throw new Error('unexpected v1 guard text');
  return sql.replace(
    'CREATE FUNCTION core.staff_document_guard()',
    'CREATE OR REPLACE FUNCTION core.staff_document_guard()',
  );
};

/** up(): the v1 body with the one branch tightened. Fails at import time if the v1 anchor is not found exactly once. */
export const STAFF_DOCUMENT_GUARD_V2_SQL = (() => {
  if (STAFF_DOCUMENT_GUARD_FUNCTION_SQL.split(V1_BRANCH).length !== 2)
    throw new Error('v1 guard scan branch not found exactly once');
  return replaceable(
    STAFF_DOCUMENT_GUARD_FUNCTION_SQL.replace(V1_BRANCH, V2_BRANCH),
  );
})();

/** down(): exactly the approved v1 body again. */
export const STAFF_DOCUMENT_GUARD_V1_RESTORE_SQL = replaceable(
  STAFF_DOCUMENT_GUARD_FUNCTION_SQL,
);

/** Post-condition: still owned by crewflow, invoker, pinned search_path, no EXECUTE for crewflow_app / PUBLIC, three triggers. */
export const STAFF_DOCUMENT_GUARD_POSTURE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
       pg_catalog.array_to_string(p.proconfig, ';') AS config,
       pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_execute,
       (p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0)) AS public_revoked,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal AND t.tgenabled = 'O')::int AS triggers,
       pg_catalog.strpos(p.prosrc, 'OLD.created_at IS DISTINCT FROM pg_catalog.now()') > 0 AS bound
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.staff_document_guard()')`;
