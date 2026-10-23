/**
 * FROZEN with migration WorkspaceSchemaMigrationLedger1786719800000 (never edited after merge).
 *
 * Wave 2 lane S2 (B3/B4) DDL: the per-workspace migration ledger, the registry's version/drift columns, the registry
 * versioning guard, and the drift recorder. Kept out of the migration file because TypeORM loads every export of a
 * migration file as a migration class.
 */
export const WORKSPACE_SCHEMA_LEDGER_UP_SQL = `
CREATE TABLE core.workspace_schema_migration (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL,
  organisation_id   uuid        NOT NULL,
  schema_name       text        NOT NULL,
  module_id         text        NOT NULL,
  version           integer     NOT NULL,
  checksum          text        NOT NULL,
  previous_version  integer     NOT NULL,
  target_version    integer     NOT NULL,
  attempt           integer     NOT NULL,
  status            text        NOT NULL,
  started_at        timestamptz NOT NULL,
  completed_at      timestamptz NOT NULL DEFAULT now(),
  error_class       text,
  app_version       text        NOT NULL,
  -- Deliberately NO foreign key to manager_workspace: the ledger is append-only history (a trigger refuses every UPDATE,
  -- DELETE and TRUNCATE), so a RESTRICT FK would make a provisioned workspace undeletable forever and a CASCADE FK is
  -- refused by that same trigger. Rows are written only by the migrator / provisioners for an existing workspace, and
  -- schema_name is CHECK-bound to workspace_id. Rows hold uuids, module ids and checksums only (no personal data).
  CONSTRAINT workspace_schema_migration_schema_name_check CHECK (schema_name = 'workspace_' || replace(workspace_id::text, '-', '')),
  CONSTRAINT workspace_schema_migration_module_id_check CHECK (module_id ~ '^v[0-9]+\\.[0-9]{3}-[a-z0-9-]{1,48}$'),
  CONSTRAINT workspace_schema_migration_version_check CHECK (version >= 1 AND previous_version >= 0 AND target_version >= version),
  CONSTRAINT workspace_schema_migration_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_schema_migration_attempt_check CHECK (attempt >= 1),
  CONSTRAINT workspace_schema_migration_status_check CHECK (status IN ('APPLIED', 'BASELINED', 'FAILED', 'REFUSED')),
  CONSTRAINT workspace_schema_migration_error_check CHECK (
    (status IN ('FAILED', 'REFUSED')) = (error_class IS NOT NULL)
    AND (error_class IS NULL OR error_class ~ '^[A-Z0-9_]{1,64}$')),
  CONSTRAINT workspace_schema_migration_app_version_check CHECK (app_version ~ '^[A-Za-z0-9._:@+/-]{1,100}$'),
  CONSTRAINT workspace_schema_migration_time_check CHECK (completed_at >= started_at),
  CONSTRAINT workspace_schema_migration_attempt_key UNIQUE (workspace_id, module_id, attempt)
);
-- At most one successful row per (workspace, module): a module is applied (or baselined) once.
CREATE UNIQUE INDEX workspace_schema_migration_success_key
  ON core.workspace_schema_migration (workspace_id, module_id) WHERE status IN ('APPLIED', 'BASELINED');
CREATE INDEX workspace_schema_migration_org_idx ON core.workspace_schema_migration (organisation_id, workspace_id, version);

ALTER TABLE core.workspace_schema_migration OWNER TO crewflow;
ALTER TABLE core.workspace_schema_migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace_schema_migration FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_schema_migration_tenant ON core.workspace_schema_migration AS PERMISSIVE FOR ALL TO PUBLIC
  USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
REVOKE ALL ON core.workspace_schema_migration FROM PUBLIC;
REVOKE ALL ON core.workspace_schema_migration FROM crewflow_app;
-- The runtime role may READ its own organisation's history (RLS); it can never write, change or delete it.
GRANT SELECT ON core.workspace_schema_migration TO crewflow_app;

-- Append-only for EVERY role, the owner included (a ledger that can be rewritten is not evidence).
CREATE FUNCTION core.workspace_schema_migration_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $append_only$
BEGIN
  RAISE EXCEPTION 'core.workspace_schema_migration is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END;
$append_only$;
ALTER FUNCTION core.workspace_schema_migration_append_only() OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.workspace_schema_migration_append_only() FROM PUBLIC;
CREATE TRIGGER workspace_schema_migration_no_update_delete BEFORE UPDATE OR DELETE ON core.workspace_schema_migration
  FOR EACH ROW EXECUTE FUNCTION core.workspace_schema_migration_append_only();
CREATE TRIGGER workspace_schema_migration_no_truncate BEFORE TRUNCATE ON core.workspace_schema_migration
  FOR EACH STATEMENT EXECUTE FUNCTION core.workspace_schema_migration_append_only();

-- Registry: per-step module version + structural fingerprint + drift state (alert-only; routing never reads these).
ALTER TABLE core.workspace_schema_registry
  ADD COLUMN module_version integer NOT NULL DEFAULT 0,
  ADD COLUMN expected_fingerprint text,
  ADD COLUMN observed_fingerprint text,
  ADD COLUMN fingerprint_checked_at timestamptz,
  ADD COLUMN drift_status text NOT NULL DEFAULT 'UNCHECKED',
  ADD COLUMN drift_detail text,
  ADD CONSTRAINT workspace_schema_registry_module_version_check CHECK (module_version >= 0),
  ADD CONSTRAINT workspace_schema_registry_fingerprint_check CHECK (
    (expected_fingerprint IS NULL OR expected_fingerprint ~ '^[0-9a-f]{64}$')
    AND (observed_fingerprint IS NULL OR observed_fingerprint ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT workspace_schema_registry_drift_status_check CHECK (
    drift_status IN ('UNCHECKED', 'OK', 'DRIFTED', 'MISSING', 'UNVERIFIED', 'NOT_READY')),
  ADD CONSTRAINT workspace_schema_registry_drift_detail_check CHECK (drift_detail IS NULL OR char_length(drift_detail) <= 500);

-- crewflow_app holds table-level UPDATE on the registry (pre-existing grant); a column REVOKE cannot narrow that, so this
-- trigger makes the new versioning/drift columns writable only by the migration/provisioner identities.
CREATE FUNCTION core.workspace_schema_registry_versioning_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF current_user <> 'crewflow_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.module_version <> 0 OR NEW.expected_fingerprint IS NOT NULL OR NEW.observed_fingerprint IS NOT NULL
       OR NEW.drift_status <> 'UNCHECKED' OR NEW.drift_detail IS NOT NULL OR NEW.fingerprint_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'workspace schema versioning and drift columns are written by the migration identity only' USING ERRCODE = '42501';
    END IF;
  ELSIF (NEW.module_version, NEW.expected_fingerprint, NEW.observed_fingerprint, NEW.fingerprint_checked_at, NEW.drift_status, NEW.drift_detail)
        IS DISTINCT FROM
        (OLD.module_version, OLD.expected_fingerprint, OLD.observed_fingerprint, OLD.fingerprint_checked_at, OLD.drift_status, OLD.drift_detail) THEN
    RAISE EXCEPTION 'workspace schema versioning and drift columns are written by the migration identity only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$guard$;
ALTER FUNCTION core.workspace_schema_registry_versioning_guard() OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.workspace_schema_registry_versioning_guard() FROM PUBLIC;
CREATE TRIGGER workspace_schema_registry_versioning_guard BEFORE INSERT OR UPDATE ON core.workspace_schema_registry
  FOR EACH ROW EXECUTE FUNCTION core.workspace_schema_registry_versioning_guard();

-- Drift recorder (B4). Alert-only by design (owner default "report, never block"): it writes the observed fingerprint
-- and a drift status, and NEVER changes status/schema_version, so SchemaResolverService routing is unaffected.
-- Not SECURITY DEFINER: the caller (the provisioner identity, crewflow) binds rab.organisation_id to the workspace's own
-- organisation, and FORCE RLS on the registry hides every other organisation's row.
CREATE FUNCTION core.record_workspace_schema_drift(p_workspace_id uuid)
RETURNS TABLE (r_status text, r_detail text, r_module_version integer, r_fingerprint text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $drift$
DECLARE
  v_status   text;
  v_version  integer;
  v_expected text;
  v_fp       text;
  v_problem  text;
  v_out      text;
  v_detail   text;
BEGIN
  SELECT r.status, r.module_version, r.expected_fingerprint INTO v_status, v_version, v_expected
    FROM core.workspace_schema_registry r WHERE r.workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002';
  END IF;
  v_fp := core.workspace_schema_fingerprint(p_workspace_id);
  IF v_status <> 'READY' THEN
    v_out := 'NOT_READY'; v_detail := 'registry status ' || v_status;
  ELSIF v_fp IS NULL THEN
    v_out := 'MISSING'; v_detail := 'the workspace schema does not exist';
  ELSIF v_expected IS NULL THEN
    v_out := 'UNVERIFIED'; v_detail := 'no recorded fingerprint yet (not provisioned or baselined through the migrator)';
  ELSIF v_fp <> v_expected THEN
    v_out := 'DRIFTED'; v_detail := 'structure differs from the fingerprint recorded at module version ' || v_version;
  ELSE
    v_problem := core.verify_workspace_schema_v1(p_workspace_id);
    IF v_problem IS NOT NULL THEN
      v_out := 'DRIFTED'; v_detail := 'verify_workspace_schema_v1: ' || v_problem;
    ELSE
      v_out := 'OK'; v_detail := NULL;
    END IF;
  END IF;
  UPDATE core.workspace_schema_registry
     SET observed_fingerprint = v_fp, fingerprint_checked_at = now(), drift_status = v_out, drift_detail = v_detail
   WHERE workspace_id = p_workspace_id;
  RETURN QUERY SELECT v_out, v_detail, v_version, v_fp;
END;
$drift$;
ALTER FUNCTION core.record_workspace_schema_drift(uuid) OWNER TO crewflow;
REVOKE ALL ON FUNCTION core.record_workspace_schema_drift(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.record_workspace_schema_drift(uuid) TO crewflow;
`;

export const WORKSPACE_SCHEMA_LEDGER_DOWN_SQL = `
DROP FUNCTION IF EXISTS core.record_workspace_schema_drift(uuid);
DROP TRIGGER IF EXISTS workspace_schema_registry_versioning_guard ON core.workspace_schema_registry;
DROP FUNCTION IF EXISTS core.workspace_schema_registry_versioning_guard();
ALTER TABLE core.workspace_schema_registry
  DROP CONSTRAINT IF EXISTS workspace_schema_registry_drift_detail_check,
  DROP CONSTRAINT IF EXISTS workspace_schema_registry_drift_status_check,
  DROP CONSTRAINT IF EXISTS workspace_schema_registry_fingerprint_check,
  DROP CONSTRAINT IF EXISTS workspace_schema_registry_module_version_check,
  DROP COLUMN IF EXISTS drift_detail,
  DROP COLUMN IF EXISTS drift_status,
  DROP COLUMN IF EXISTS fingerprint_checked_at,
  DROP COLUMN IF EXISTS observed_fingerprint,
  DROP COLUMN IF EXISTS expected_fingerprint,
  DROP COLUMN IF EXISTS module_version;
DROP FUNCTION IF EXISTS core.workspace_schema_fingerprint(uuid);
DROP FUNCTION IF EXISTS core.workspace_schema_fingerprint_lines(uuid);
DROP TABLE IF EXISTS core.workspace_schema_migration;
DROP FUNCTION IF EXISTS core.workspace_schema_migration_append_only();
`;

/** verify_workspace_schema_v1 with the binding-CHECK scan isolated to its own schema (same checks, labels, owner, ACL). */
export const VERIFY_WORKSPACE_SCHEMA_V1_ISOLATED_SQL = `
CREATE OR REPLACE FUNCTION core.verify_workspace_schema_v1(p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $verify$
    DECLARE
      v_name   text := 'workspace_' || replace(p_workspace_id::text, '-', '');
      v_n      integer;
      v_forced integer;
      v_owned  integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      IF v_n <> 21 THEN RETURN 'table count'; END IF;
      IF v_forced <> 21 THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> 21 THEN RETURN 'table owner'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = v_name) <> 90 THEN RETURN 'index count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = v_name) <> 39 THEN RETURN 'policy count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> 128 THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound') <> 21 THEN
        RETURN 'workspace CHECK count';
      END IF;
      -- Wave 2 lane S2: the schema's own binding CHECKs are selected FIRST (MATERIALIZED), so pg_get_constraintdef — which
      -- takes AccessShareLock on the constrained table — never touches another workspace's tables. Before this, a lock
      -- held on ANY workspace's table blocked the verification (and therefore provisioning/migration) of every other one.
      IF EXISTS (WITH bound AS MATERIALIZED (
                   SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                    WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound')
                 SELECT 1 FROM bound b
                  WHERE strpos(pg_catalog.pg_get_constraintdef(b.oid), '''' || p_workspace_id::text || '''::uuid') = 0
                     OR strpos(pg_catalog.pg_get_constraintdef(b.oid), 'workspace_id IS NOT NULL') = 0) THEN
        RETURN 'workspace CHECK value or NULL exclusion';
      END IF;
      IF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = v_name) IS DISTINCT FROM 'rab_secure_owner' THEN
        RETURN 'schema owner';
      END IF;
      IF (SELECT a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = v_name AND c.relname = 'user_note' AND a.attname = 'workspace_id') IS DISTINCT FROM true THEN
        RETURN 'user_note workspace_id NOT NULL';
      END IF;
      RETURN NULL;
    END;
    $verify$;
`;

/** The 1786719500000 body (restored by down()). */
export const VERIFY_WORKSPACE_SCHEMA_V1_ORIGINAL_SQL = `
CREATE OR REPLACE FUNCTION core.verify_workspace_schema_v1(p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $verify$
    DECLARE
      v_name   text := 'workspace_' || replace(p_workspace_id::text, '-', '');
      v_n      integer;
      v_forced integer;
      v_owned  integer;
    BEGIN
      -- Same checks, same labels, as provision-workspace-schema.ts verifyStructure(), plus table ownership.
      SELECT count(*)::int,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int,
             count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'crewflow')::int
        INTO v_n, v_forced, v_owned
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = v_name AND c.relkind = 'r';
      IF v_n <> 21 THEN RETURN 'table count'; END IF;
      IF v_forced <> 21 THEN RETURN 'FORCE RLS'; END IF;
      IF v_owned <> 21 THEN RETURN 'table owner'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = v_name) <> 90 THEN RETURN 'index count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = v_name) <> 39 THEN RETURN 'policy count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'f') <> 128 THEN RETURN 'foreign key count'; END IF;
      IF (SELECT count(*) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
           WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound') <> 21 THEN
        RETURN 'workspace CHECK count';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace ns ON ns.oid = k.connamespace
                  WHERE ns.nspname = v_name AND k.contype = 'c' AND k.conname LIKE '%\_workspace\_bound'
                    AND (strpos(pg_catalog.pg_get_constraintdef(k.oid), '''' || p_workspace_id::text || '''::uuid') = 0
                         OR strpos(pg_catalog.pg_get_constraintdef(k.oid), 'workspace_id IS NOT NULL') = 0)) THEN
        RETURN 'workspace CHECK value or NULL exclusion';
      END IF;
      IF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = v_name) IS DISTINCT FROM 'rab_secure_owner' THEN
        RETURN 'schema owner';
      END IF;
      IF (SELECT a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = v_name AND c.relname = 'user_note' AND a.attname = 'workspace_id') IS DISTINCT FROM true THEN
        RETURN 'user_note workspace_id NOT NULL';
      END IF;
      RETURN NULL;
    END;
    $verify$;
`;
