// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, constraint, trigger, policy and role names, type lists, patterns, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-15 (metadata engine M1 E1, DRAFT for owner SQL review).
/**
 * Metadata engine M1 / E1 (OWNER-METADATA-ENGINE.md §1 E1; DRAFT — owner SQL review FIRST, run only on throwaway databases
 * until approved): the metadata tables of Crewflow's re-implementation of Twenty's metadata engine. SQL of migration
 * MetadataEngineTables1786721550000, kept as data so the exact statements can be reviewed, scanned and unit-tested.
 *
 * Twenty (twentyhq/twenty @ eedb0a73; behaviour re-implemented, never copied — AGPL):
 *   core.object_metadata         T:metadata-modules/object-metadata/object-metadata.entity.ts:48-243 (names :70-73, labels
 *                                :76-79, description/icon/color :82-88, isActive :133, isSystem :136, isSearchable :206)
 *   core.field_metadata          T:metadata-modules/field-metadata/field-metadata.entity.ts:52-217 (unique name per object
 *                                :64, type :96, name :99, label :102, defaultValue :105, settings :133, isActive/isSystem
 *                                :143-146, isNullable :183, isUnique :186, isSearchable :188, relation targets :200-217)
 *   core.field_metadata_option   T:metadata-modules/field-metadata-option/entities/field-metadata-option.entity.ts:27-73
 *   core.index_metadata (+ index_field_metadata)  T:metadata-modules/index-metadata/index-metadata.entity.ts:33-95
 *   field types                  TS:types/FieldMetadataType.ts:1-27 (the 25 values); relation settings
 *                                TS:types/FieldMetadataSettings.ts:53-55 (relationType); relations are fields, there is
 *                                no relation-metadata table at eedb0a73
 *   name rules                   validate-flat-object-metadata-name.util.ts:14-15, validate-flat-field-metadata-name.util.ts:13-14
 *                                (^[a-z][a-zA-Z0-9]*$), TS:metadata/constants/identifier-max-char-length.constant.ts:2 (63)
 *   locks                        flat-object-metadata-validator.service.ts:145-170 (system objects are never deleted),
 *                                flat-field-metadata-validator.service.ts:83-128 (system fields change only isActive/settings)
 * (T: = packages/twenty-server/src/engine/, TS: = packages/twenty-shared/src/; validators under
 * T:workspace-manager/workspace-migration/workspace-migration-builder/validators/.)
 *
 * Deliberate Crewflow differences (owner decisions, METADATA-PLAN.md §3 / OWNER-METADATA-ENGINE.md §0):
 *   - every table carries organisation_id + workspace_id and is ENABLE + FORCE ROW LEVEL SECURITY with one tenant policy
 *     (USING + WITH CHECK) in this same migration (§0.1; Twenty has no RLS);
 *   - opaque, immutable physical names (physical_table `c_…`, physical_column `cf_…` for custom; the real name for built-ins);
 *   - is_locked / is_money / is_ui_read_only / is_sensitive / is_exportable_when_sensitive (§0.3, §0.5, OB-13);
 *   - API names immutable after creation (OB-10), enforced by a trigger, not only by the service;
 *   - CURRENCY only on custom objects and no custom field on an object that does not allow them (§0.3, §0.5), enforced by
 *     the same trigger on INSERT;
 *   - `storage = 'core_reference'` for the read-only core reference objects (workspaceMember → core."user", …;
 *     M0-STANDARD-OBJECTS §3), so a relation to core has a target row and no engine action can ever address core as a
 *     workspace table;
 *   - Crewflow-internal field type RANGE (tstzrange, M0-STANDARD-OBJECTS S8), built-in system fields only; MORPH_RELATION is
 *     in the vocabulary (Twenty's 25) but refused (out of scope, M0-BACKEND §0.1);
 *   - no applicationId / isRemote / morph / standardOverrides columns; no metadata version here (E5, agent M1-cache);
 *   - TRUNCATE (which ignores RLS) follows the same identity rule: refused for the request path, allowed for the
 *     privileged identities (operators, test teardowns' TRUNCATE core.organisation CASCADE as the superuser);
 *   - identity split (security review #165 M2): built-in / locked rows are written only by crewflow (SET LOCAL ROLE
 *     crewflow in the E2 sync; the M2 executor as a crewflow-owned definer), rab_secure_owner or a superuser (the M-T2
 *     allow-list, registry-guard-allowlist-sql.ts); the request path may change only their display columns;
 *   - the seven payroll / attendance tables are pinned to `is_system AND NOT allows_custom_fields` (review M1); core
 *     reference objects only for the four known core tables (I1); labels refuse bidi / zero-width characters (I3).
 *
 * ACCESS: the tables and the guard function are owned by crewflow (handed over inside withCrewflowCoreCreate: no LOGIN role
 * owns a core object); crewflow_app holds SELECT, INSERT, UPDATE, DELETE; nothing for PUBLIC. The runtime login
 * crewflow_owner reaches them through crewflow and is bound by FORCE RLS (no tenant bound → zero rows). BC-01 (accepted):
 * crewflow_owner can, through its membership, ALTER, DISABLE TRIGGER or DROP these tables; the triggers below guard normal
 * code paths, not injected SQL.
 */
/** The five tables, in creation order (also the order of the RLS / grant loop and of the post-condition). */
export const METADATA_TABLES = ['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata'] as const;
export type MetadataTable = (typeof METADATA_TABLES)[number];

/** Row-level guard triggers (BEFORE, FOR EACH ROW) on every table. */
export const METADATA_ROW_TRIGGERS: Readonly<Record<MetadataTable, string>> = Object.freeze({
  object_metadata: 'BEFORE INSERT OR UPDATE OR DELETE',
  field_metadata: 'BEFORE INSERT OR UPDATE OR DELETE',
  field_metadata_option: 'BEFORE INSERT OR UPDATE OR DELETE',
  index_metadata: 'BEFORE INSERT OR UPDATE OR DELETE',
  index_field_metadata: 'BEFORE INSERT OR UPDATE OR DELETE',
});

export const METADATA_GUARD_FUNCTION = 'core.metadata_guard()';

/**
 * Values of the field_metadata.type CHECK: Twenty's 25 (TS:types/FieldMetadataType.ts:1-27) plus the Crewflow-internal RANGE.
 * A frozen literal on purpose: a merged migration's SQL must never change when a shared constant changes later. The unit
 * spec pins it to @rab/shared FIELD_METADATA_TYPES + CREWFLOW_INTERNAL_FIELD_METADATA_TYPES.
 */
export const STORED_FIELD_TYPES: readonly string[] = Object.freeze([
  'ACTOR', 'ADDRESS', 'ARRAY', 'BOOLEAN', 'CURRENCY', 'DATE', 'DATE_TIME', 'EMAILS', 'FILES', 'FULL_NAME', 'LINKS',
  'MORPH_RELATION', 'MULTI_SELECT', 'NUMBER', 'NUMERIC', 'PHONES', 'POSITION', 'RATING', 'RAW_JSON', 'RELATION',
  'RICH_TEXT', 'SELECT', 'TEXT', 'TS_VECTOR', 'UUID',
  'RANGE',
]);

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/** OWNER-METADATA-ENGINE §0.3: the seven payroll / attendance tables are system objects (frozen literal). */
export const PAYROLL_ATTENDANCE_TABLES: readonly string[] = Object.freeze([
  'attendance', 'attendance_correction', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document',
]);
/** M0-STANDARD-OBJECTS §3: the only core tables a read-only core reference object may stand for (frozen literal). */
export const CORE_REFERENCE_TABLES: readonly string[] = Object.freeze(['user', 'manager_profile', 'stored_file', 'payroll_calendar_period']);

export const API_NAME_PATTERN = '^[a-z][a-zA-Z0-9]{0,62}$';
export const CUSTOM_TABLE_PATTERN = '^c_[a-z0-9]{1,30}$';
export const CUSTOM_COLUMN_PATTERN = '^cf_[a-z0-9]{1,30}$';
export const BUILTIN_NAME_PATTERN = '^[a-z][a-z0-9_]{0,62}$';
export const INDEX_NAME_PATTERN = '^ix_[a-z0-9]{1,30}$';
export const OPTION_VALUE_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,62}$';
export const ICON_PATTERN = '^[A-Za-z0-9]{1,64}$';
export const COLOR_PATTERN = '^[a-z]{1,20}$';
export const LABEL_MAX = 80;
export const DESCRIPTION_MAX = 1000;
export const SETTINGS_MAX_BYTES = 4096;
export const DEFAULT_VALUE_MAX_BYTES = 2048;

/** Bidi controls and zero-width / invisible characters (review I3: a label must render as what it says). */
export const INVISIBLE_CHARACTERS_CLASS = '[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]';
const label = (col: string) =>
  `pg_catalog.char_length(pg_catalog.btrim(${col})) BETWEEN 1 AND ${LABEL_MAX} AND ${col} !~ '[[:cntrl:]]' AND ${col} !~ '${INVISIBLE_CHARACTERS_CLASS}'`;
const finite = (col: string) => `${col} BETWEEN -1e9 AND 1e9`; // NaN and ±Infinity compare outside the range
const tenantFk = (t: string) =>
  `CONSTRAINT ${t}_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE`;

export const TENANT_PREDICATE = 'organisation_id = core.current_org() AND workspace_id = core.current_workspace()';

export const METADATA_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.metadata_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Identity split (security review #165 M2): built-in and locked metadata is written only by the sync / executor identity
  -- (crewflow: SET LOCAL ROLE crewflow, or a crewflow-owned definer), the rab_secure_owner definers or a superuser; the
  -- request path (crewflow_owner, crewflow_app) may change only display columns of it. Same allow-list as M-T2
  -- (registry-guard-allowlist-sql.ts).
  v_privileged boolean := current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
    OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false);
  v_is_custom boolean;
  v_allows_custom_fields boolean;
  v_is_system boolean;
  v_is_locked boolean;
  v_display text[];
BEGIN
  -- TRUNCATE ignores RLS, so the request path never truncates metadata (a workspace's rows leave through the FK cascade).
  -- The privileged identities may (operators; test teardowns' TRUNCATE core.organisation CASCADE as the superuser).
  IF TG_OP = 'TRUNCATE' THEN
    IF NOT v_privileged THEN
      RAISE EXCEPTION 'metadata tables are never truncated by the request path' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;

  -- One branch per table: PL/pgSQL resolves every NEW / OLD field an expression names, whatever the other operands of
  -- AND evaluate to. A direct DELETE runs at trigger depth 1; cascades (workspace or organisation deletion, a custom
  -- object's own fields, a custom field's options) arrive through the foreign-key triggers at depth 2 or more.
  IF TG_TABLE_NAME = 'object_metadata' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT NEW.is_custom AND NOT v_privileged THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      IF pg_trigger_depth() = 1 AND (NOT OLD.is_custom OR OLD.is_system) THEN
        RAISE EXCEPTION 'locked metadata cannot be deleted' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.physical_table IS DISTINCT FROM OLD.physical_table
       OR NEW.storage IS DISTINCT FROM OLD.storage
       OR NEW.is_custom IS DISTINCT FROM OLD.is_custom
       OR NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.universal_identifier IS DISTINCT FROM OLD.universal_identifier
       OR NEW.name_singular IS DISTINCT FROM OLD.name_singular
       OR NEW.name_plural IS DISTINCT FROM OLD.name_plural THEN
      RAISE EXCEPTION 'metadata column is immutable' USING ERRCODE = '42501';
    END IF;
    IF NOT OLD.is_custom AND NOT v_privileged THEN
      v_display := CASE WHEN OLD.is_system THEN ARRAY['nav_position', 'updated_at']
                        ELSE ARRAY['label_singular', 'label_plural', 'description', 'icon', 'color', 'nav_position', 'updated_at'] END;
      IF (pg_catalog.to_jsonb(NEW) - v_display) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_display) THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_TABLE_NAME = 'field_metadata' THEN
    IF TG_OP = 'DELETE' THEN
      IF pg_trigger_depth() = 1 AND (OLD.is_locked OR OLD.is_system) THEN
        RAISE EXCEPTION 'locked metadata cannot be deleted' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
      -- FOR SHARE: allows_custom_fields / is_custom cannot change under this insert before it commits.
      SELECT o.is_custom, o.allows_custom_fields INTO v_is_custom, v_allows_custom_fields
        FROM core.object_metadata o
       WHERE o.id = NEW.object_metadata_id AND o.workspace_id = NEW.workspace_id
         FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the parent object does not exist in this workspace'
          USING ERRCODE = '23503', CONSTRAINT = 'field_metadata_object_fkey';
      END IF;
      IF (NOT NEW.is_custom OR NEW.is_locked OR NEW.is_system) AND NOT v_privileged THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      IF NEW.is_custom AND NOT v_allows_custom_fields THEN
        RAISE EXCEPTION 'custom fields are not allowed on this object'
          USING ERRCODE = '23514', CONSTRAINT = 'field_metadata_custom_fields_allowed';
      END IF;
      IF NEW.type = 'CURRENCY' AND NOT v_is_custom THEN
        RAISE EXCEPTION 'CURRENCY fields are allowed on custom objects only'
          USING ERRCODE = '23514', CONSTRAINT = 'field_metadata_currency_custom_object_only';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.physical_column IS DISTINCT FROM OLD.physical_column
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.object_metadata_id IS DISTINCT FROM OLD.object_metadata_id
       OR NEW.is_custom IS DISTINCT FROM OLD.is_custom
       OR NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.is_money IS DISTINCT FROM OLD.is_money
       OR NEW.universal_identifier IS DISTINCT FROM OLD.universal_identifier
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.relation_target_object_metadata_id IS DISTINCT FROM OLD.relation_target_object_metadata_id
       OR (OLD.is_locked AND NOT NEW.is_locked)
       OR (OLD.is_locked AND NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
      RAISE EXCEPTION 'metadata column is immutable' USING ERRCODE = '42501';
    END IF;
    IF NOT v_privileged THEN
      IF NEW.is_locked AND NOT OLD.is_locked THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      IF NOT OLD.is_custom OR OLD.is_locked THEN
        SELECT o.is_system INTO v_is_system FROM core.object_metadata o
         WHERE o.id = OLD.object_metadata_id AND o.workspace_id = OLD.workspace_id;
        v_display := CASE WHEN coalesce(v_is_system, true) THEN ARRAY['position', 'updated_at']
                          ELSE ARRAY['label', 'description', 'icon', 'position', 'updated_at'] END;
        IF (pg_catalog.to_jsonb(NEW) - v_display) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_display) THEN
          RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_TABLE_NAME = 'field_metadata_option' THEN
    IF TG_OP = 'DELETE' THEN
      IF pg_trigger_depth() > 1 OR v_privileged THEN
        RETURN OLD;
      END IF;
      SELECT f.is_custom, f.is_locked INTO v_is_custom, v_is_locked FROM core.field_metadata f
       WHERE f.id = OLD.field_metadata_id AND f.workspace_id = OLD.workspace_id
         FOR SHARE;
      IF FOUND AND (NOT v_is_custom OR v_is_locked) THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND (
         NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.field_metadata_id IS DISTINCT FROM OLD.field_metadata_id
      OR NEW.value IS DISTINCT FROM OLD.value) THEN
      RAISE EXCEPTION 'metadata column is immutable' USING ERRCODE = '42501';
    END IF;
    SELECT f.is_custom, f.is_locked INTO v_is_custom, v_is_locked FROM core.field_metadata f
     WHERE f.id = NEW.field_metadata_id AND f.workspace_id = NEW.workspace_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the parent field does not exist in this workspace'
        USING ERRCODE = '23503', CONSTRAINT = 'field_metadata_option_field_fkey';
    END IF;
    IF (NOT v_is_custom OR v_is_locked) AND NOT v_privileged THEN
      RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;

  ELSIF TG_TABLE_NAME = 'index_metadata' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT o.is_custom INTO v_is_custom FROM core.object_metadata o
       WHERE o.id = NEW.object_metadata_id AND o.workspace_id = NEW.workspace_id
         FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the parent object does not exist in this workspace'
          USING ERRCODE = '23503', CONSTRAINT = 'index_metadata_object_fkey';
      END IF;
      -- An index on a built-in object is created by the sync / executor identity only.
      IF NOT v_is_custom AND NOT v_privileged THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF pg_trigger_depth() > 1 OR v_privileged THEN
        RETURN OLD;
      END IF;
      IF EXISTS (SELECT 1 FROM core.index_field_metadata x
                   JOIN core.field_metadata f ON f.id = x.field_metadata_id AND f.object_metadata_id = x.object_metadata_id
                  WHERE x.index_metadata_id = OLD.id AND (NOT f.is_custom OR f.is_locked)) THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    -- UPDATE: an index definition never changes (deactivate it, then add a new one).
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.object_metadata_id IS DISTINCT FROM OLD.object_metadata_id
       OR NEW.physical_name IS DISTINCT FROM OLD.physical_name
       OR NEW.is_unique IS DISTINCT FROM OLD.is_unique THEN
      RAISE EXCEPTION 'metadata column is immutable' USING ERRCODE = '42501';
    END IF;
    -- Deactivating an index over a built-in or locked field is the sync / executor identity's decision only.
    IF NEW.is_active IS DISTINCT FROM OLD.is_active AND NOT v_privileged
       AND EXISTS (SELECT 1 FROM core.index_field_metadata x
                     JOIN core.field_metadata f ON f.id = x.field_metadata_id AND f.object_metadata_id = x.object_metadata_id
                    WHERE x.index_metadata_id = OLD.id AND (NOT f.is_custom OR f.is_locked)) THEN
      RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;

  ELSIF TG_TABLE_NAME = 'index_field_metadata' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'index fields are immutable' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF pg_trigger_depth() > 1 OR v_privileged THEN
        RETURN OLD;
      END IF;
      SELECT f.is_custom, f.is_locked INTO v_is_custom, v_is_locked FROM core.field_metadata f
       WHERE f.id = OLD.field_metadata_id AND f.object_metadata_id = OLD.object_metadata_id AND f.workspace_id = OLD.workspace_id
         FOR SHARE;
      IF FOUND AND (NOT v_is_custom OR v_is_locked) THEN
        RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    SELECT f.is_custom, f.is_locked INTO v_is_custom, v_is_locked FROM core.field_metadata f
     WHERE f.id = NEW.field_metadata_id AND f.object_metadata_id = NEW.object_metadata_id AND f.workspace_id = NEW.workspace_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the indexed field does not exist on this object'
        USING ERRCODE = '23503', CONSTRAINT = 'index_field_metadata_field_fkey';
    END IF;
    IF (NOT v_is_custom OR v_is_locked) AND NOT v_privileged THEN
      RAISE EXCEPTION 'built-in metadata is written by the sync identity only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'metadata_guard: unexpected table' USING ERRCODE = '42501';
END
$fn$`;

export const METADATA_TABLES_UP_SQL: readonly string[] = [
  // ------------------------------------------------------------------------------------------------------------ objects
  `CREATE TABLE core.object_metadata (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  universal_identifier uuid,
  storage text NOT NULL DEFAULT 'workspace',
  name_singular text NOT NULL,
  name_plural text NOT NULL,
  label_singular text NOT NULL,
  label_plural text NOT NULL,
  description text,
  icon text,
  color text,
  physical_table text NOT NULL,
  is_custom boolean NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  allows_custom_fields boolean NOT NULL DEFAULT false,
  is_searchable boolean NOT NULL DEFAULT false,
  label_identifier_field_id uuid,
  nav_position double precision,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT object_metadata_pkey PRIMARY KEY (id),
  CONSTRAINT object_metadata_id_workspace_key UNIQUE (id, workspace_id),
  ${tenantFk('object_metadata')},
  CONSTRAINT object_metadata_storage_ck CHECK (storage IN ('workspace', 'core_reference')),
  CONSTRAINT object_metadata_name_singular_ck CHECK (name_singular ~ '${API_NAME_PATTERN}'),
  CONSTRAINT object_metadata_name_plural_ck CHECK (name_plural ~ '${API_NAME_PATTERN}'),
  CONSTRAINT object_metadata_name_pair_ck CHECK (name_singular <> name_plural),
  CONSTRAINT object_metadata_label_singular_ck CHECK (${label('label_singular')}),
  CONSTRAINT object_metadata_label_plural_ck CHECK (${label('label_plural')}),
  CONSTRAINT object_metadata_description_ck CHECK (description IS NULL OR pg_catalog.char_length(description) <= ${DESCRIPTION_MAX}),
  CONSTRAINT object_metadata_icon_ck CHECK (icon IS NULL OR icon ~ '${ICON_PATTERN}'),
  CONSTRAINT object_metadata_color_ck CHECK (color IS NULL OR color ~ '${COLOR_PATTERN}'),
  CONSTRAINT object_metadata_physical_table_ck CHECK (physical_table ~ '${CUSTOM_TABLE_PATTERN}' OR physical_table ~ '${BUILTIN_NAME_PATTERN}'),
  CONSTRAINT object_metadata_kind_ck CHECK (
    (is_custom AND physical_table ~ '${CUSTOM_TABLE_PATTERN}' AND universal_identifier IS NULL AND NOT is_system
       AND allows_custom_fields AND storage = 'workspace')
    OR (NOT is_custom AND physical_table !~ '^c_' AND universal_identifier IS NOT NULL)),
  CONSTRAINT object_metadata_system_no_custom_fields_ck CHECK (NOT (is_system AND allows_custom_fields)),
  CONSTRAINT object_metadata_core_reference_ck CHECK (storage = 'workspace' OR (NOT is_custom AND is_system AND NOT allows_custom_fields)),
  CONSTRAINT object_metadata_core_reference_tables_ck CHECK (storage = 'workspace' OR physical_table IN (${sqlList(CORE_REFERENCE_TABLES)})),
  CONSTRAINT object_metadata_payroll_locked_ck CHECK (is_custom OR storage <> 'workspace'
    OR physical_table NOT IN (${sqlList(PAYROLL_ATTENDANCE_TABLES)})
    OR (is_system AND NOT allows_custom_fields)),
  CONSTRAINT object_metadata_nav_position_ck CHECK (nav_position IS NULL OR ${finite('nav_position')})
)`,
  'CREATE UNIQUE INDEX object_metadata_name_singular_uq ON core.object_metadata (workspace_id, pg_catalog.lower(name_singular))',
  'CREATE UNIQUE INDEX object_metadata_name_plural_uq ON core.object_metadata (workspace_id, pg_catalog.lower(name_plural))',
  'CREATE UNIQUE INDEX object_metadata_physical_table_uq ON core.object_metadata (workspace_id, storage, physical_table)',
  'CREATE UNIQUE INDEX object_metadata_universal_identifier_uq ON core.object_metadata (workspace_id, universal_identifier) WHERE universal_identifier IS NOT NULL',
  'CREATE INDEX object_metadata_organisation_workspace_idx ON core.object_metadata (organisation_id, workspace_id)',

  // ------------------------------------------------------------------------------------------------------------- fields
  `CREATE TABLE core.field_metadata (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_metadata_id uuid NOT NULL,
  universal_identifier uuid,
  type text NOT NULL,
  name text NOT NULL,
  label text NOT NULL,
  description text,
  icon text,
  physical_column text,
  default_value jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_custom boolean NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  is_ui_read_only boolean NOT NULL DEFAULT false,
  is_money boolean NOT NULL DEFAULT false,
  is_sensitive boolean NOT NULL DEFAULT false,
  is_exportable_when_sensitive boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_nullable boolean NOT NULL DEFAULT true,
  is_unique boolean NOT NULL DEFAULT false,
  is_searchable boolean NOT NULL DEFAULT false,
  relation_target_object_metadata_id uuid,
  relation_target_field_metadata_id uuid,
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT field_metadata_pkey PRIMARY KEY (id),
  CONSTRAINT field_metadata_id_workspace_key UNIQUE (id, workspace_id),
  CONSTRAINT field_metadata_id_object_key UNIQUE (id, object_metadata_id),
  ${tenantFk('field_metadata')},
  CONSTRAINT field_metadata_object_fkey FOREIGN KEY (object_metadata_id, workspace_id)
    REFERENCES core.object_metadata (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT field_metadata_relation_target_object_fkey FOREIGN KEY (relation_target_object_metadata_id, workspace_id)
    REFERENCES core.object_metadata (id, workspace_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT field_metadata_relation_target_field_fkey FOREIGN KEY (relation_target_field_metadata_id, relation_target_object_metadata_id)
    REFERENCES core.field_metadata (id, object_metadata_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT field_metadata_type_ck CHECK (type IN (${sqlList(STORED_FIELD_TYPES)})),
  CONSTRAINT field_metadata_morph_relation_unsupported CHECK (type <> 'MORPH_RELATION'),
  CONSTRAINT field_metadata_internal_type_ck CHECK (type <> 'RANGE' OR (NOT is_custom AND is_system)),
  CONSTRAINT field_metadata_name_ck CHECK (name ~ '${API_NAME_PATTERN}'),
  CONSTRAINT field_metadata_label_ck CHECK (${label('label')}),
  CONSTRAINT field_metadata_description_ck CHECK (description IS NULL OR pg_catalog.char_length(description) <= ${DESCRIPTION_MAX}),
  CONSTRAINT field_metadata_icon_ck CHECK (icon IS NULL OR icon ~ '${ICON_PATTERN}'),
  CONSTRAINT field_metadata_physical_column_ck CHECK (
    physical_column IS NULL OR physical_column ~ '${CUSTOM_COLUMN_PATTERN}' OR physical_column ~ '${BUILTIN_NAME_PATTERN}'),
  CONSTRAINT field_metadata_physical_namespace_ck CHECK (
    physical_column IS NULL OR (is_custom AND physical_column ~ '${CUSTOM_COLUMN_PATTERN}') OR (NOT is_custom AND physical_column !~ '^cf_')),
  CONSTRAINT field_metadata_physical_presence_ck CHECK (
    (type = 'RELATION' AND COALESCE(settings ->> 'relationType', '') = 'ONE_TO_MANY') = (physical_column IS NULL)),
  CONSTRAINT field_metadata_default_value_ck CHECK (default_value IS NULL OR pg_catalog.pg_column_size(default_value) <= ${DEFAULT_VALUE_MAX_BYTES}),
  CONSTRAINT field_metadata_settings_ck CHECK (
    pg_catalog.jsonb_typeof(settings) = 'object' AND pg_catalog.pg_column_size(settings) <= ${SETTINGS_MAX_BYTES}),
  CONSTRAINT field_metadata_builtin_locked_ck CHECK (is_custom OR is_locked),
  CONSTRAINT field_metadata_money_ck CHECK (
    NOT is_money OR (type = 'NUMBER' AND NOT is_custom AND is_locked AND is_sensitive AND is_ui_read_only)),
  CONSTRAINT field_metadata_export_optin_ck CHECK (NOT is_exportable_when_sensitive OR is_sensitive),
  CONSTRAINT field_metadata_relation_shape_ck CHECK ((type = 'RELATION') = (relation_target_object_metadata_id IS NOT NULL)),
  CONSTRAINT field_metadata_relation_inverse_ck CHECK (relation_target_field_metadata_id IS NULL OR type = 'RELATION'),
  CONSTRAINT field_metadata_relation_settings_ck CHECK (
    type <> 'RELATION' OR (
      COALESCE(settings ->> 'relationType', '') IN ('MANY_TO_ONE', 'ONE_TO_MANY')
      AND (settings ->> 'onDelete' IS NULL OR settings ->> 'onDelete' IN ('CASCADE', 'RESTRICT', 'SET_NULL', 'NO_ACTION')))),
  CONSTRAINT field_metadata_position_ck CHECK (${finite('position')})
)`,
  'CREATE UNIQUE INDEX field_metadata_name_uq ON core.field_metadata (object_metadata_id, pg_catalog.lower(name))',
  'CREATE UNIQUE INDEX field_metadata_physical_column_uq ON core.field_metadata (object_metadata_id, physical_column) WHERE physical_column IS NOT NULL',
  'CREATE UNIQUE INDEX field_metadata_universal_identifier_uq ON core.field_metadata (workspace_id, universal_identifier) WHERE universal_identifier IS NOT NULL',
  'CREATE INDEX field_metadata_organisation_workspace_idx ON core.field_metadata (organisation_id, workspace_id)',
  'CREATE INDEX field_metadata_relation_target_object_idx ON core.field_metadata (relation_target_object_metadata_id) WHERE relation_target_object_metadata_id IS NOT NULL',
  'CREATE INDEX field_metadata_relation_target_field_idx ON core.field_metadata (relation_target_field_metadata_id) WHERE relation_target_field_metadata_id IS NOT NULL',
  // The label identifier must be a field of the SAME object (Twenty object-metadata.entity.ts labelIdentifierFieldMetadataId).
  `ALTER TABLE core.object_metadata ADD CONSTRAINT object_metadata_label_identifier_fkey
  FOREIGN KEY (label_identifier_field_id, id) REFERENCES core.field_metadata (id, object_metadata_id) DEFERRABLE INITIALLY DEFERRED`,
  'CREATE INDEX object_metadata_label_identifier_idx ON core.object_metadata (label_identifier_field_id) WHERE label_identifier_field_id IS NOT NULL',

  // ------------------------------------------------------------------------------------------------------------ options
  `CREATE TABLE core.field_metadata_option (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  field_metadata_id uuid NOT NULL,
  value text NOT NULL,
  label text NOT NULL,
  color text,
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT field_metadata_option_pkey PRIMARY KEY (id),
  ${tenantFk('field_metadata_option')},
  CONSTRAINT field_metadata_option_field_fkey FOREIGN KEY (field_metadata_id, workspace_id)
    REFERENCES core.field_metadata (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT field_metadata_option_value_ck CHECK (value ~ '${OPTION_VALUE_PATTERN}'),
  CONSTRAINT field_metadata_option_label_ck CHECK (${label('label')}),
  CONSTRAINT field_metadata_option_color_ck CHECK (color IS NULL OR color ~ '${COLOR_PATTERN}'),
  CONSTRAINT field_metadata_option_position_ck CHECK (${finite('position')})
)`,
  'CREATE UNIQUE INDEX field_metadata_option_value_uq ON core.field_metadata_option (field_metadata_id, value)',
  'CREATE INDEX field_metadata_option_organisation_workspace_idx ON core.field_metadata_option (organisation_id, workspace_id)',

  // ------------------------------------------------------------------------------------------------------------ indexes
  `CREATE TABLE core.index_metadata (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_metadata_id uuid NOT NULL,
  physical_name text NOT NULL,
  is_unique boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT index_metadata_pkey PRIMARY KEY (id),
  CONSTRAINT index_metadata_id_object_key UNIQUE (id, object_metadata_id),
  ${tenantFk('index_metadata')},
  CONSTRAINT index_metadata_object_fkey FOREIGN KEY (object_metadata_id, workspace_id)
    REFERENCES core.object_metadata (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT index_metadata_physical_name_ck CHECK (physical_name ~ '${INDEX_NAME_PATTERN}')
)`,
  'CREATE UNIQUE INDEX index_metadata_physical_name_uq ON core.index_metadata (workspace_id, physical_name)',
  'CREATE INDEX index_metadata_object_idx ON core.index_metadata (object_metadata_id)',
  'CREATE INDEX index_metadata_organisation_workspace_idx ON core.index_metadata (organisation_id, workspace_id)',
  // A field used by an index cannot be deleted while the index row exists (NO ACTION): the M2 diff builder drops the index
  // metadata first. Deleting the whole object (or workspace) removes both in one statement.
  `CREATE TABLE core.index_field_metadata (
  organisation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  index_metadata_id uuid NOT NULL,
  object_metadata_id uuid NOT NULL,
  field_metadata_id uuid NOT NULL,
  position smallint NOT NULL,
  CONSTRAINT index_field_metadata_pkey PRIMARY KEY (index_metadata_id, position),
  CONSTRAINT index_field_metadata_field_key UNIQUE (index_metadata_id, field_metadata_id),
  ${tenantFk('index_field_metadata')},
  CONSTRAINT index_field_metadata_object_fkey FOREIGN KEY (object_metadata_id, workspace_id)
    REFERENCES core.object_metadata (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT index_field_metadata_index_fkey FOREIGN KEY (index_metadata_id, object_metadata_id)
    REFERENCES core.index_metadata (id, object_metadata_id) ON DELETE CASCADE,
  CONSTRAINT index_field_metadata_field_fkey FOREIGN KEY (field_metadata_id, object_metadata_id)
    REFERENCES core.field_metadata (id, object_metadata_id),
  CONSTRAINT index_field_metadata_position_ck CHECK (position BETWEEN 0 AND 2)
)`,
  'CREATE INDEX index_field_metadata_field_idx ON core.index_field_metadata (field_metadata_id, object_metadata_id)',
  'CREATE INDEX index_field_metadata_organisation_workspace_idx ON core.index_field_metadata (organisation_id, workspace_id)',

  // --------------------------------------------------------------------------------------------- guard function, triggers
  METADATA_GUARD_FUNCTION_SQL,
  'REVOKE ALL ON FUNCTION core.metadata_guard() FROM PUBLIC',
  ...Object.entries(METADATA_ROW_TRIGGERS).map(
    ([t, timing]) => `CREATE TRIGGER ${t}_guard ${timing} ON core.${t} FOR EACH ROW EXECUTE FUNCTION core.metadata_guard()`,
  ),
  ...METADATA_TABLES.map((t) => `CREATE TRIGGER ${t}_truncate_guard BEFORE TRUNCATE ON core.${t} FOR EACH STATEMENT EXECUTE FUNCTION core.metadata_guard()`),

  // ------------------------------------------------------------------------------------- RLS + grants (same migration)
  ...METADATA_TABLES.flatMap((t) => [
    `ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${t}_tenant ON core.${t} AS PERMISSIVE FOR ALL TO PUBLIC
  USING (${TENANT_PREDICATE})
  WITH CHECK (${TENANT_PREDICATE})`,
    `REVOKE ALL ON TABLE core.${t} FROM PUBLIC`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE core.${t} TO crewflow_app`,
  ]),
];

/** Run inside withCrewflowCoreCreate after METADATA_TABLES_UP_SQL: no LOGIN role may own a core object. */
export const METADATA_OWNERSHIP_SQL: readonly string[] = [
  ...METADATA_TABLES.map((t) => `ALTER TABLE core.${t} OWNER TO crewflow`),
  'ALTER FUNCTION core.metadata_guard() OWNER TO crewflow',
];

export const METADATA_TABLES_DOWN_SQL: readonly string[] = [
  // Reverse dependency order; DROP TABLE removes its policies, triggers, indexes and constraints.
  'DROP TABLE core.index_field_metadata',
  'DROP TABLE core.index_metadata',
  'DROP TABLE core.field_metadata_option',
  'ALTER TABLE core.object_metadata DROP CONSTRAINT object_metadata_label_identifier_fkey',
  'DROP TABLE core.field_metadata',
  'DROP TABLE core.object_metadata',
  'DROP FUNCTION core.metadata_guard()',
];

/**
 * down() refuses while any metadata row exists. A migration binds no tenant, so under FORCE RLS a plain count would see zero
 * rows and down() would drop real metadata. The count therefore runs after NO FORCE inside down()'s own transaction (the
 * migration identity owns the tables through crewflow, so the owner exemption applies); a refusal rolls the whole
 * transaction back, FORCE included. Only reached on the way to DROP TABLE.
 */
export const METADATA_DOWN_UNFORCE_SQL: readonly string[] = METADATA_TABLES.map((t) => `ALTER TABLE core.${t} NO FORCE ROW LEVEL SECURITY`);
export const METADATA_ROWS_SQL = `SELECT
  ((SELECT pg_catalog.count(*) FROM core.object_metadata) + (SELECT pg_catalog.count(*) FROM core.field_metadata)
   + (SELECT pg_catalog.count(*) FROM core.field_metadata_option) + (SELECT pg_catalog.count(*) FROM core.index_metadata)
   + (SELECT pg_catalog.count(*) FROM core.index_field_metadata))::int AS metadata_rows`;

export const METADATA_GONE_SQL = `SELECT
  pg_catalog.to_regclass('core.object_metadata') IS NULL AND pg_catalog.to_regclass('core.field_metadata') IS NULL
  AND pg_catalog.to_regclass('core.field_metadata_option') IS NULL AND pg_catalog.to_regclass('core.index_metadata') IS NULL
  AND pg_catalog.to_regclass('core.index_field_metadata') IS NULL
  AND pg_catalog.to_regprocedure('core.metadata_guard()') IS NULL AS gone`;

/**
 * Preflight (up / down): an identity that can act as crewflow AND rab_secure_owner (withCrewflowCoreCreate grants CREATE on
 * core, owned by rab_secure_owner, to crewflow; the hand-over needs membership of crewflow), Phase 0b applied (core owned by
 * rab_secure_owner), the roles present, the FK target and the tenant functions present, PostgreSQL 16+, (up) no table yet.
 */
export const METADATA_PREFLIGHT_SQL = `
SELECT current_user::text AS who,
       r.rolsuper AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner'::name, 'USAGE') AS can_act_secure,
       pg_catalog.pg_has_role(current_user, 'crewflow'::name, 'USAGE') AS can_act_crewflow,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles x WHERE x.rolname IN ('crewflow', 'crewflow_app'))::int AS roles,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = pg_catalog.to_regclass('core.manager_workspace') AND k.contype IN ('u', 'p')
                  AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname)
                         FROM pg_catalog.unnest(k.conkey) c(n)
                         JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = c.n) = ARRAY['id', 'organisation_id']) AS workspace_key,
       (pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL) AS tenant_functions,
       (pg_catalog.current_setting('server_version_num')::int >= 160000) AS pg16_or_later,
       (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(ARRAY['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata']) t(n)
         WHERE pg_catalog.to_regclass('core.' || t.n) IS NOT NULL)::int AS tables_present,
       (pg_catalog.to_regprocedure('core.metadata_guard()') IS NOT NULL) AS guard_present
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition, one row per table: compared exactly with expectedTableState(). */
export const METADATA_STATE_SQL = `
SELECT c.relname::text AS tbl,
       pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                 || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
            FROM pg_catalog.aclexplode(c.relacl) a
           WHERE a.grantee <> c.relowner) x) AS acl,
       (SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':' || p.polroles::text
                                     || ':' || (pg_catalog.pg_get_expr(p.polqual, p.polrelid) = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))::text,
                                     ';' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
       (SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::regprocedure::text, ';' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.oid AND a.attname IN ('organisation_id', 'workspace_id') AND a.attnotnull AND NOT a.attisdropped)::int AS tenant_columns,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite w WHERE w.ev_class = c.oid)::int AS rules
  FROM pg_catalog.pg_class c
 WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY (ARRAY['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata'])
 ORDER BY c.relname`;

export const METADATA_FUNCTION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer,
       pg_catalog.array_to_string(p.proconfig, ';') AS config,
       pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_execute,
       (p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0)) AS public_revoked
  FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.metadata_guard()')`;

export interface MetadataTableState {
  tbl: string;
  owner: string;
  rls: boolean;
  force: boolean;
  acl: string | null;
  policies: string | null;
  triggers: string | null;
  tenant_columns: number;
  rules: number;
}

/** The exact state every table must have after up(). */
export function expectedTableState(t: MetadataTable): MetadataTableState {
  const triggers = [
    ...(t in METADATA_ROW_TRIGGERS ? [`${t}_guard:O:${METADATA_GUARD_FUNCTION}`] : []),
    `${t}_truncate_guard:O:${METADATA_GUARD_FUNCTION}`,
  ].sort();
  return {
    tbl: t,
    owner: 'crewflow',
    rls: true,
    force: true,
    acl: ['crewflow_app:DELETE:false', 'crewflow_app:INSERT:false', 'crewflow_app:SELECT:false', 'crewflow_app:UPDATE:false'].join(','),
    policies: `${t}_tenant:*:true:{0}:true`,
    triggers: triggers.join(';'),
    tenant_columns: 2,
    rules: 0,
  };
}

/** Problems with the post-condition rows (empty = exactly as reviewed). */
export function metadataStateProblems(rows: readonly MetadataTableState[], fn: Record<string, unknown> | undefined): string[] {
  const problems: string[] = [];
  for (const t of METADATA_TABLES) {
    const got = rows.find((r) => r.tbl === t);
    const want = expectedTableState(t);
    if (!got) {
      problems.push(`core.${t}: missing`);
      continue;
    }
    for (const key of Object.keys(want) as Array<keyof MetadataTableState>) {
      if (String(got[key]) !== String(want[key])) problems.push(`core.${t}.${key}: expected ${JSON.stringify(want[key])}, found ${JSON.stringify(got[key])}`);
    }
  }
  if (rows.length !== METADATA_TABLES.length) problems.push(`expected ${METADATA_TABLES.length} metadata tables, found ${rows.length}`);
  const wantFn = { owner: 'crewflow', definer: false, config: 'search_path=pg_catalog, pg_temp', app_execute: false, public_revoked: true };
  if (!fn) problems.push(`${METADATA_GUARD_FUNCTION}: missing`);
  else for (const [k, v] of Object.entries(wantFn)) if (fn[k] !== v) problems.push(`${METADATA_GUARD_FUNCTION}.${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(fn[k])}`);
  return problems;
}
