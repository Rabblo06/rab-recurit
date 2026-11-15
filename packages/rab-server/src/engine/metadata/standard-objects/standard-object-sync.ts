/**
 * Metadata engine M1 / E2: sync the code-defined standard objects into ONE workspace's metadata, inside the caller's
 * transaction (the Part D workspace command runner on upgrade, or ManagerWorkspaceService.createFor for a new workspace).
 *
 * Twenty (twentyhq/twenty @ eedb0a73): `engine/workspace-manager/twenty-standard-application/services/
 * twenty-standard-application.service.ts:42-156` (`synchronizeTwentyStandardApplicationOrThrow`), run on workspace creation
 * and by upgrade commands. Re-implemented, not copied; the differences are listed in standard-object-plan.ts.
 *
 * Contract:
 *  - The caller has bound the tenant (`rab.organisation_id`, `rab.workspace_id`) to THIS workspace; every metadata table is
 *    FORCE RLS, so a read or write can only reach this workspace's rows. The binding is re-checked here (fail closed).
 *  - When `schemaName` is given, the 21 tables of that workspace schema are compared column-for-column with the definitions
 *    (name, `format_type`, nullability) BEFORE anything is written; any difference refuses (CATALOG_MISMATCH). So the
 *    metadata of a workspace can never describe a table it does not have.
 *  - Idempotent: a second run plans nothing and writes nothing (so M1-cache's version trigger does not fire either).
 *  - Each metadata row is written at most once per run and nothing is ever deleted (the runner's write check relies on it).
 *  - Every statement is a constant; values are bound parameters (one jsonb array per statement).
 */
import { randomUUID } from 'node:crypto';

import type { StandardObjectDefinition } from './standard-object-definition';
import {
  desiredStandardMetadata,
  isEmptyPlan,
  planStandardObjectSync,
  StandardObjectSyncError,
  StandardSyncPlan,
  StoredField,
  StoredObject,
  StoredOption,
  validateStandardDefinitions,
} from './standard-object-plan';

export type MetadataQuery = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;

export interface StandardObjectDefinitions {
  readonly standard: readonly StandardObjectDefinition[];
  readonly coreReferences: readonly StandardObjectDefinition[];
  /** The authoritative workspace table list (WORKSPACE_TABLES). */
  readonly workspaceTables: readonly string[];
}

export interface StandardSyncOptions {
  readonly workspaceId: string;
  readonly organisationId: string;
  /** The derived `workspace_<32 hex>` schema to verify against; omitted only when the schema does not exist yet (createFor). */
  readonly schemaName?: string;
  readonly newId?: () => string;
}

export interface StandardSyncReport {
  objectsInserted: number;
  objectsUpdated: number;
  fieldsInserted: number;
  fieldsUpdated: number;
  optionsInserted: number;
  optionsUpdated: number;
}

/** The tables the sync writes (the Part D runner allows exactly these, plus M1-cache's version row, for a declared command). */
export const STANDARD_SYNC_WRITTEN_TABLES = Object.freeze(['object_metadata', 'field_metadata', 'field_metadata_option'] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCHEMA = /^workspace_[0-9a-f]{32}$/;

export interface CatalogColumn {
  t: string;
  c: string;
  ty: string;
  nn: boolean;
}

/** Pure: the differences between the workspace tables' columns and the definitions (empty = they match exactly). */
export function catalogProblems(definitions: StandardObjectDefinitions, columns: readonly CatalogColumn[]): string[] {
  const problems: string[] = [];
  const byTable = new Map<string, CatalogColumn[]>();
  for (const c of columns) byTable.set(c.t, [...(byTable.get(c.t) ?? []), c]);
  for (const t of byTable.keys()) {
    // c_* tables are generated custom objects (M2); anything else unknown is drift.
    if (!definitions.workspaceTables.includes(t) && !/^c_[a-z0-9]{1,30}$/.test(t)) problems.push(`unexpected table ${t}`);
  }
  for (const o of definitions.standard) {
    const actual = byTable.get(o.table);
    if (!actual) {
      problems.push(`missing table ${o.table}`);
      continue;
    }
    const declared = new Map(o.fields.map((f) => [f.column, f]));
    for (const tenant of ['organisation_id', 'workspace_id']) {
      if (!actual.some((c) => c.c === tenant && c.ty === 'uuid' && c.nn)) problems.push(`${o.table}.${tenant} missing or not uuid NOT NULL`);
    }
    for (const c of actual) {
      if (c.c === 'organisation_id' || c.c === 'workspace_id') continue;
      const f = declared.get(c.c);
      // cf_* columns are custom fields (M2) on a standard table that allows them.
      if (!f) {
        if (!(o.allowsCustomFields && /^cf_[a-z0-9]{1,30}(__[a-z0-9]{1,16})?$/.test(c.c))) problems.push(`${o.table}.${c.c} has no standard field`);
        continue;
      }
      if (f.pgType !== c.ty) problems.push(`${o.table}.${c.c} is ${c.ty}, declared ${f.pgType}`);
      if (f.nullable === c.nn) problems.push(`${o.table}.${c.c} nullability differs`);
    }
    for (const f of o.fields) if (!actual.some((c) => c.c === f.column)) problems.push(`${o.table}.${f.column} is declared but not in the table`);
  }
  return problems;
}

const CATALOG_SQL = `SELECT c.relname::text AS t, a.attname::text AS c, pg_catalog.format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull AS nn
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`;

const TABLES_SQL = `SELECT pg_catalog.to_regclass('core.object_metadata') IS NOT NULL
   AND pg_catalog.to_regclass('core.field_metadata') IS NOT NULL
   AND pg_catalog.to_regclass('core.field_metadata_option') IS NOT NULL AS ok`;

const BINDING_SQL = `SELECT COALESCE(pg_catalog.current_setting('rab.organisation_id', true), '') AS org,
  COALESCE(pg_catalog.current_setting('rab.workspace_id', true), '') AS ws`;

const STORED_OBJECTS_SQL = `SELECT id::text, universal_identifier::text, is_custom, name_singular, name_plural, label_singular, label_plural,
  description, icon, physical_table, storage, is_system, is_active, allows_custom_fields, is_searchable, label_identifier_field_id::text
  FROM core.object_metadata WHERE workspace_id = $1`;

const STORED_FIELDS_SQL = `SELECT id::text, object_metadata_id::text, universal_identifier::text, is_custom, name, label, description, type,
  physical_column, is_system, is_locked, is_ui_read_only, is_money, is_sensitive, is_exportable_when_sensitive, is_nullable, is_unique, is_searchable, settings,
  relation_target_object_metadata_id::text, relation_target_field_metadata_id::text, position
  FROM core.field_metadata WHERE workspace_id = $1`;

const STORED_OPTIONS_SQL = `SELECT id::text, field_metadata_id::text, value, label, position FROM core.field_metadata_option WHERE workspace_id = $1`;

const INSERT_OBJECTS_SQL = `INSERT INTO core.object_metadata (id, organisation_id, workspace_id, universal_identifier, name_singular, name_plural,
    label_singular, label_plural, description, icon, physical_table, storage, is_custom, is_system, is_active, allows_custom_fields, is_searchable,
    label_identifier_field_id)
  SELECT r.id, $2::uuid, $3::uuid, r.universal_identifier, r.name_singular, r.name_plural, r.label_singular, r.label_plural, r.description,
         r.icon, r.physical_table, r.storage, false, r.is_system, r.is_active, r.allows_custom_fields, r.is_searchable, r.label_identifier_field_id
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, universal_identifier uuid, name_singular text, name_plural text,
         label_singular text, label_plural text, description text, icon text, physical_table text, storage text, is_system boolean, is_active boolean,
         allows_custom_fields boolean, is_searchable boolean, label_identifier_field_id uuid)`;

const UPDATE_OBJECTS_SQL = `UPDATE core.object_metadata o
     SET label_singular = r.label_singular, label_plural = r.label_plural, description = r.description, icon = r.icon,
         is_active = r.is_active, allows_custom_fields = r.allows_custom_fields, is_searchable = r.is_searchable,
         label_identifier_field_id = r.label_identifier_field_id, updated_at = pg_catalog.now()
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, label_singular text, label_plural text, description text, icon text,
         is_active boolean, allows_custom_fields boolean, is_searchable boolean, label_identifier_field_id uuid)
   WHERE o.id = r.id AND o.workspace_id = $2::uuid AND NOT o.is_custom`;

const INSERT_FIELDS_SQL = `INSERT INTO core.field_metadata (id, organisation_id, workspace_id, object_metadata_id, universal_identifier, type, name,
    label, physical_column, settings, is_custom, is_system, is_locked, is_ui_read_only, is_money, is_sensitive, is_exportable_when_sensitive, is_active, is_nullable,
    is_unique, is_searchable, relation_target_object_metadata_id, relation_target_field_metadata_id, position)
  SELECT r.id, $2::uuid, $3::uuid, r.object_metadata_id, r.universal_identifier, r.type, r.name, r.label, r.physical_column, r.settings,
         false, r.is_system, true, r.is_ui_read_only, r.is_money, r.is_sensitive, r.is_exportable_when_sensitive, true, r.is_nullable, r.is_unique, r.is_searchable,
         r.relation_target_object_metadata_id, r.relation_target_field_metadata_id, r.position
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, object_metadata_id uuid, universal_identifier uuid, type text, name text,
         label text, physical_column text, settings jsonb, is_system boolean, is_ui_read_only boolean, is_money boolean, is_sensitive boolean, is_exportable_when_sensitive boolean,
         is_nullable boolean, is_unique boolean, is_searchable boolean, relation_target_object_metadata_id uuid,
         relation_target_field_metadata_id uuid, position double precision)`;

const UPDATE_FIELDS_SQL = `UPDATE core.field_metadata f
     SET label = r.label, description = NULL, is_locked = true, is_ui_read_only = r.is_ui_read_only, is_sensitive = r.is_sensitive,
         is_exportable_when_sensitive = r.is_exportable_when_sensitive, is_nullable = r.is_nullable, is_unique = r.is_unique,
         is_searchable = r.is_searchable, settings = r.settings, relation_target_field_metadata_id = r.relation_target_field_metadata_id,
         position = r.position, updated_at = pg_catalog.now()
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, label text, is_ui_read_only boolean, is_sensitive boolean, is_exportable_when_sensitive boolean,
         is_nullable boolean, is_unique boolean, is_searchable boolean, settings jsonb, relation_target_field_metadata_id uuid,
         position double precision)
   WHERE f.id = r.id AND f.workspace_id = $2::uuid AND NOT f.is_custom`;

const INSERT_OPTIONS_SQL = `INSERT INTO core.field_metadata_option (id, organisation_id, workspace_id, field_metadata_id, value, label, position)
  SELECT r.id, $2::uuid, $3::uuid, r.field_metadata_id, r.value, r.label, r.position
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, field_metadata_id uuid, value text, label text, position double precision)`;

const UPDATE_OPTIONS_SQL = `UPDATE core.field_metadata_option o SET label = r.label, position = r.position, updated_at = pg_catalog.now()
    FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(id uuid, label text, position double precision)
   WHERE o.id = r.id AND o.workspace_id = $2::uuid`;

/** Reads what the workspace holds, plans, verifies, writes. Returns the counts written (all zero on a re-run). */
export async function syncStandardObjects(query: MetadataQuery, definitions: StandardObjectDefinitions, options: StandardSyncOptions): Promise<StandardSyncReport> {
  const { workspaceId, organisationId, schemaName } = options;
  if (!UUID.test(workspaceId) || !UUID.test(organisationId)) throw new StandardObjectSyncError('NO_TENANT', 'workspace and organisation ids must be uuids');
  if (schemaName !== undefined && (!SCHEMA.test(schemaName) || schemaName !== `workspace_${workspaceId.replace(/-/g, '')}`)) {
    throw new StandardObjectSyncError('NO_TENANT', 'the schema is not this workspace\'s derived schema');
  }
  validateStandardDefinitions(definitions.standard, definitions.coreReferences, definitions.workspaceTables);

  const [binding] = (await query(BINDING_SQL)) as Array<{ org: string; ws: string }>;
  if (binding?.org !== organisationId || binding?.ws !== workspaceId) {
    throw new StandardObjectSyncError('NO_TENANT', 'the transaction is not bound to this workspace (rab.organisation_id / rab.workspace_id)');
  }
  const [tables] = (await query(TABLES_SQL)) as Array<{ ok: boolean }>;
  if (!tables?.ok) throw new StandardObjectSyncError('METADATA_TABLES_MISSING', 'core.object_metadata / field_metadata / field_metadata_option do not exist');

  if (schemaName !== undefined) {
    const problems = catalogProblems(definitions, (await query(CATALOG_SQL, [schemaName])) as CatalogColumn[]);
    if (problems.length) throw new StandardObjectSyncError('CATALOG_MISMATCH', `${problems.length} difference(s): ${problems.slice(0, 10).join('; ')}`);
  }

  const stored = {
    objects: (await query(STORED_OBJECTS_SQL, [workspaceId])) as StoredObject[],
    fields: (await query(STORED_FIELDS_SQL, [workspaceId])) as StoredField[],
    options: (await query(STORED_OPTIONS_SQL, [workspaceId])) as StoredOption[],
  };
  const plan = planStandardObjectSync(desiredStandardMetadata(definitions.standard, definitions.coreReferences), stored, options.newId ?? randomUUID);
  await applyPlan(query, plan, workspaceId, organisationId);
  return {
    objectsInserted: plan.insertObjects.length,
    objectsUpdated: plan.updateObjects.length,
    fieldsInserted: plan.insertFields.length,
    fieldsUpdated: plan.updateFields.length,
    optionsInserted: plan.insertOptions.length,
    optionsUpdated: plan.updateOptions.length,
  };
}

async function applyPlan(query: MetadataQuery, plan: StandardSyncPlan, workspaceId: string, organisationId: string): Promise<void> {
  if (isEmptyPlan(plan)) return;
  const json = (rows: readonly object[]) => JSON.stringify(rows);
  // Order: objects (relation targets must exist), fields, then options. The label-identifier and inverse-field references are
  // DEFERRABLE INITIALLY DEFERRED, so a row can point at a field inserted later in the same transaction.
  if (plan.insertObjects.length) await query(INSERT_OBJECTS_SQL, [json(plan.insertObjects), organisationId, workspaceId]);
  if (plan.insertFields.length) await query(INSERT_FIELDS_SQL, [json(plan.insertFields), organisationId, workspaceId]);
  if (plan.updateObjects.length) await query(UPDATE_OBJECTS_SQL, [json(plan.updateObjects), workspaceId]);
  if (plan.updateFields.length) await query(UPDATE_FIELDS_SQL, [json(plan.updateFields), workspaceId]);
  if (plan.insertOptions.length) await query(INSERT_OPTIONS_SQL, [json(plan.insertOptions), organisationId, workspaceId]);
  if (plan.updateOptions.length) await query(UPDATE_OPTIONS_SQL, [json(plan.updateOptions), workspaceId]);
}
