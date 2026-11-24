/**
 * Metadata engine M1 / E2: the PURE half of the standard-object sync. Definitions → the rows a workspace must hold → a plan
 * (insert / update) against the rows it holds now. No I/O, so every rule is unit-tested without a database.
 *
 * Twenty (twentyhq/twenty @ eedb0a73): `twenty-standard-application.service.ts:42-156` computes the code's "to" maps
 * (`computeTwentyStandardApplicationAllFlatEntityMaps`), keeps the workspace-owned properties of the "from" maps
 * (`flat-entity/utils/keep-workspace-owned-properties.util.ts:12-57`) and hands both to the migration builder, which matches
 * entities by universal identifier (create / update / delete) and refuses changes to non-updatable properties
 * (`workspace-entity-migration-builder.service.ts:498-505`, NON_UPDATABLE_PROPERTY_DIVERGENCE). Re-implemented, not copied.
 *
 * Deliberate differences (Crewflow):
 *  - NEVER deletes. Twenty runs the standard sync with `inferDeletionFromMissingEntities: true`; here a stored standard object,
 *    field or option the code no longer declares is a refusal (fail closed: an unknown state is rejected, and locked metadata
 *    cannot be deleted at all). Removing a standard column is a reviewed change of its own.
 *  - NEVER unlocks, never renames, never retypes: a stored row whose immutable property differs from the code is a refusal.
 *  - Writes each row at most once (one INSERT or one UPDATE): the Part D runner's metadata-write check relies on it.
 *  - Workspace-owned properties: an object's `is_active` (non-system objects) and a field's `is_exportable_when_sensitive`
 *    (OB-13, an admin opt-in) are left as the workspace set them. System objects are always active.
 */
import type { StandardFieldDefinition, StandardFieldType, StandardObjectDefinition } from './standard-object-definition';
import { fieldKey, inverseKey, objectKey, standardUniversalIdentifier } from './standard-universal-identifier';

export class StandardObjectSyncError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DEFINITIONS'
      | 'CATALOG_MISMATCH'
      | 'UNKNOWN_STANDARD_OBJECT'
      | 'UNKNOWN_STANDARD_FIELD'
      | 'UNKNOWN_STANDARD_OPTION'
      | 'IMMUTABLE_DIVERGENCE'
      | 'NAME_CONFLICT'
      | 'METADATA_TABLES_MISSING'
      | 'NO_TENANT',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StandardObjectSyncError';
  }
}

/** One object row the workspace must hold (column names of core.object_metadata). */
export interface DesiredObject {
  readonly universal_identifier: string;
  readonly name_singular: string;
  readonly name_plural: string;
  readonly label_singular: string;
  readonly label_plural: string;
  readonly description: string | null;
  readonly icon: string;
  readonly physical_table: string;
  /** 'core_reference' for the read-only core tables (M1-meta's object_metadata.storage), else 'workspace'. */
  readonly storage: 'workspace' | 'core_reference';
  readonly is_system: boolean;
  readonly allows_custom_fields: boolean;
  readonly is_searchable: boolean;
  /** Universal identifier of the label-identifier field (resolved to an id when planning). */
  readonly label_identifier_field_uid: string | null;
}

export interface DesiredOption {
  readonly value: string;
  readonly label: string;
  readonly position: number;
}

/** One field row the workspace must hold (column names of core.field_metadata). */
export interface DesiredField {
  readonly universal_identifier: string;
  readonly object_uid: string;
  readonly name: string;
  readonly label: string;
  readonly type: StandardFieldType;
  readonly physical_column: string | null;
  readonly is_system: boolean;
  readonly is_ui_read_only: boolean;
  readonly is_money: boolean;
  readonly is_sensitive: boolean;
  readonly is_nullable: boolean;
  readonly is_unique: boolean;
  readonly is_searchable: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly relation_target_object_uid: string | null;
  readonly relation_target_field_uid: string | null;
  readonly position: number;
  readonly options: readonly DesiredOption[];
}

export interface DesiredMetadata {
  readonly objects: readonly DesiredObject[];
  readonly fields: readonly DesiredField[];
}

const NAME = /^[a-z][a-zA-Z0-9]{0,62}$/;
const COLUMN = /^[a-z][a-z0-9_]{0,62}$/;
const OPTION = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const ICON = /^[A-Za-z0-9]{1,64}$/;
const label = (s: string) => s.trim().length >= 1 && s.trim().length <= 80;

/** SECURITY (§0.3): the seven objects that are system objects, whatever a definition says. */
export const PAYROLL_ATTENDANCE_SYSTEM_TABLES: readonly string[] = Object.freeze([
  'attendance',
  'attendance_correction',
  'payroll_record',
  'payroll_run',
  'payroll_run_line',
  'payslip',
  'payslip_document',
]);

/**
 * Structure level 22 (owner decision 0a): relations to core."user" have no FK; they are checked by this service only
 * (CoreReferenceService.assertUsersOfOrganisationTx), plus the Worker's report-only orphan check.
 */
export const CORE_USER_REFERENCE_ENFORCER = 'service:CoreReferenceService';

/** Owner decisions D1, D3, D4 (2026-11-13): standard tables that take no custom fields. */
export const NO_CUSTOM_FIELD_TABLES: readonly string[] = Object.freeze([
  ...PAYROLL_ATTENDANCE_SYSTEM_TABLES,
  'shift_assignment',
  'venue_role_rate',
  'venue_manager_staff',
  'manager_venue',
  'shift_request_staff',
  'shift_report',
  'replacement_request',
  'user_note',
  // Structure level 27 (owner decision 91, pending): breaks and sync receipts are pay evidence; ordinary locked standard
  // objects (decision 45), never extended with custom fields.
  'attendance_break',
  'attendance_sync_receipt',
]);

/** SELECT fields whose name says they are a state machine (S13): read-only everywhere. */
const isStatusColumn = (column: string) => column === 'status' || column.endsWith('_status');

/**
 * Validates the definitions (names, labels, uniqueness, relation targets, locks). Throws INVALID_DEFINITIONS on the first
 * problem. `workspaceTables` is the authoritative list of workspace tables (WORKSPACE_TABLES).
 */
export function validateStandardDefinitions(
  standard: readonly StandardObjectDefinition[],
  coreReferences: readonly StandardObjectDefinition[],
  workspaceTables: readonly string[],
): void {
  const bad = (m: string): never => {
    throw new StandardObjectSyncError('INVALID_DEFINITIONS', m);
  };
  const tables = standard.map((o) => o.table);
  if (tables.length !== workspaceTables.length || [...tables].sort().join() !== [...workspaceTables].sort().join()) {
    bad(`the standard objects must be exactly the ${workspaceTables.length} workspace tables`);
  }
  const all = [...standard, ...coreReferences];
  const objectNames = new Set<string>();
  for (const o of all) {
    for (const n of [o.nameSingular, o.namePlural]) {
      if (!NAME.test(n)) bad(`${o.table}: bad object name ${n}`);
      if (objectNames.has(n.toLowerCase())) bad(`object name ${n} used twice`);
      objectNames.add(n.toLowerCase());
    }
    if (o.nameSingular === o.namePlural) bad(`${o.table}: singular equals plural`);
    if (!label(o.labelSingular) || !label(o.labelPlural)) bad(`${o.table}: bad label`);
    if (!ICON.test(o.icon)) bad(`${o.table}: bad icon`);
    if (o.description !== null && o.description.length > 1000) bad(`${o.table}: description too long`);
    if (!COLUMN.test(o.table)) bad(`bad table ${o.table}`);
    const isWorkspace = workspaceTables.includes(o.table);
    if (o.kind === 'coreReference' ? isWorkspace : !isWorkspace) bad(`${o.table}: kind ${o.kind} does not match where the table lives`);
    if (PAYROLL_ATTENDANCE_SYSTEM_TABLES.includes(o.table) && o.kind !== 'system') bad(`${o.table} must be a system object (§0.3)`);
    if (o.kind === 'system' && !PAYROLL_ATTENDANCE_SYSTEM_TABLES.includes(o.table)) bad(`${o.table}: only the seven §0.3 tables are kind system`);
    if (o.allowsCustomFields && (o.kind !== 'standard' || NO_CUSTOM_FIELD_TABLES.includes(o.table))) bad(`${o.table} may not allow custom fields (§0.3, D1-D4)`);
    if (o.kind === 'standard' && !NO_CUSTOM_FIELD_TABLES.includes(o.table) && !o.allowsCustomFields) bad(`${o.table}: custom fields are allowed by the owner's decisions`);
    const fieldNames = new Set<string>();
    const columns = new Set<string>();
    for (const f of o.fields) {
      if (!NAME.test(f.name)) bad(`${o.table}.${f.column}: bad field name ${f.name}`);
      if (!COLUMN.test(f.column)) bad(`${o.table}: bad column ${f.column}`);
      if (f.column === 'organisation_id' || f.column === 'workspace_id') bad(`${o.table}: tenant columns are never fields`);
      if (fieldNames.has(f.name.toLowerCase())) bad(`${o.table}: field name ${f.name} used twice`);
      if (columns.has(f.column)) bad(`${o.table}: column ${f.column} listed twice`);
      fieldNames.add(f.name.toLowerCase());
      columns.add(f.column);
      if (!label(f.label)) bad(`${o.table}.${f.column}: bad label`);
      if ((f.type === 'SELECT') !== Boolean(f.options?.length)) bad(`${o.table}.${f.column}: a select-type field needs options, and only a select-type field has them`);
      for (const v of f.options ?? []) if (!OPTION.test(v)) bad(`${o.table}.${f.column}: bad option ${v}`);
      if (f.options && new Set(f.options).size !== f.options.length) bad(`${o.table}.${f.column}: duplicate option`);
      if ((f.type === 'RELATION') !== Boolean(f.relation)) bad(`${o.table}.${f.column}: RELATION needs a relation and only RELATION has one`);
      if (f.settings?.money && (f.pgType !== 'bigint' || f.type !== 'NUMBER')) bad(`${o.table}.${f.column}: money must be NUMBER bigint pence (§0.5: never CURRENCY on a standard object)`);
      if (/_pence$/.test(f.column) && !f.settings?.money) bad(`${o.table}.${f.column}: a pence column must be flagged money`);
      if (f.settings?.money && (!f.isUIReadOnly || f.sensitive?.authority !== 'payroll.view')) bad(`${o.table}.${f.column}: money must be read-only and sensitive (payroll.view)`);
      if (f.type === 'SELECT' && isStatusColumn(f.column) && !f.isUIReadOnly) bad(`${o.table}.${f.column}: a status column is a state machine and must be read-only (S13)`);
      if ((o.kind === 'system' || o.kind === 'junction') && !f.isUIReadOnly) bad(`${o.table}.${f.column}: every field of a ${o.kind} object is read-only`);
      if (f.relation) {
        const target = all.find((t) => (t.kind === 'coreReference' ? t.nameSingular : t.table) === f.relation!.target);
        if (!target) bad(`${o.table}.${f.column}: unknown relation target ${f.relation.target}`);
        if (target!.kind === 'coreReference' && f.relation.inverse) bad(`${o.table}.${f.column}: core reference objects get no inverse field`);
        if (target!.kind !== 'coreReference' && !f.relation.inverse) bad(`${o.table}.${f.column}: a workspace relation needs an inverse`);
        if (f.pgType !== 'uuid') bad(`${o.table}.${f.column}: a relation column is uuid`);
        // Structure level 22 (owner decision 0a): no FK to core."user" any more; such a relation is service-enforced and has no
        // ON DELETE. Every other relation keeps its FK's ON DELETE.
        // The enforcer is pinned exactly (not any `service:*`): the one reviewed service that checks core user references.
        const service = f.relation.enforcedBy?.startsWith('service:') ?? false;
        const coreUserEnforced = f.relation.enforcedBy === CORE_USER_REFERENCE_ENFORCER;
        if (f.relation.target === 'workspaceMember' ? !coreUserEnforced || f.relation.onDelete !== undefined : service || !f.relation.onDelete) {
          bad(`${o.table}.${f.column}: a workspaceMember relation is enforced by ${CORE_USER_REFERENCE_ENFORCER} without onDelete; any other relation has its FK's onDelete`);
        }
      }
    }
    if (o.labelIdentifierColumn !== null && !columns.has(o.labelIdentifierColumn)) bad(`${o.table}: label identifier ${o.labelIdentifierColumn} is not a column`);
    if (o.kind !== 'junction' && !columns.has('id')) bad(`${o.table}: every non-junction object has an id field`);
    if (o.kind === 'junction' && columns.has('id')) bad(`${o.table}: junction objects have no id (S1)`);
  }
  // Inverse names must not collide with the target's own fields or with each other.
  for (const target of all) {
    const key = target.kind === 'coreReference' ? target.nameSingular : target.table;
    const names = new Set(target.fields.map((f) => f.name.toLowerCase()));
    for (const o of standard) {
      for (const f of o.fields) {
        if (f.relation?.target !== key || !f.relation.inverse) continue;
        const n = f.relation.inverse.name;
        if (!NAME.test(n) || !label(f.relation.inverse.label)) bad(`${o.table}.${f.column}: bad inverse name or label`);
        if (names.has(n.toLowerCase())) bad(`${key}: inverse ${n} collides with another field`);
        names.add(n.toLowerCase());
      }
    }
  }
}

function fieldSettings(o: StandardObjectDefinition, f: StandardFieldDefinition): Record<string, unknown> {
  const s: Record<string, unknown> = { ...(f.settings ?? {}) };
  if (f.sensitive) s.sensitiveAuthority = f.sensitive.authority;
  if (f.relation) {
    s.relationType = 'MANY_TO_ONE';
    if (f.relation.onDelete) s.onDelete = f.relation.onDelete;
    if (f.relation.enforcedBy) s.enforcedBy = f.relation.enforcedBy;
  }
  return s;
}

const humanOption = (v: string) => {
  const spaced = v.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** The rows every workspace must hold, from the definitions (deterministic: same input, same output). */
export function desiredStandardMetadata(standard: readonly StandardObjectDefinition[], coreReferences: readonly StandardObjectDefinition[]): DesiredMetadata {
  const objects: DesiredObject[] = [];
  const fields: DesiredField[] = [];
  const all = [...coreReferences, ...standard];
  const objectUid = (o: StandardObjectDefinition) => standardUniversalIdentifier(objectKey(o.table, o.kind === 'coreReference'));
  const fieldUid = (o: StandardObjectDefinition, column: string) => standardUniversalIdentifier(fieldKey(o.table, column, o.kind === 'coreReference'));
  const byTarget = new Map(all.map((o) => [o.kind === 'coreReference' ? o.nameSingular : o.table, o] as const));
  const inverseCount = new Map<string, number>();
  for (const o of all) {
    objects.push({
      universal_identifier: objectUid(o),
      name_singular: o.nameSingular,
      name_plural: o.namePlural,
      label_singular: o.labelSingular,
      label_plural: o.labelPlural,
      description: o.description,
      icon: o.icon,
      physical_table: o.table,
      storage: o.kind === 'coreReference' ? 'core_reference' : 'workspace',
      is_system: o.kind !== 'standard',
      allows_custom_fields: o.kind === 'standard' && o.allowsCustomFields,
      is_searchable: o.isSearchable,
      label_identifier_field_uid: o.labelIdentifierColumn === null ? null : fieldUid(o, o.labelIdentifierColumn),
    });
    o.fields.forEach((f, position) => {
      const target = f.relation ? byTarget.get(f.relation.target)! : null;
      fields.push({
        universal_identifier: fieldUid(o, f.column),
        object_uid: objectUid(o),
        name: f.name,
        label: f.label,
        type: f.type,
        physical_column: f.column,
        is_system: Boolean(f.isSystem),
        is_ui_read_only: Boolean(f.isUIReadOnly || o.kind === 'system' || o.kind === 'junction' || o.kind === 'coreReference'),
        is_money: Boolean(f.settings?.money),
        is_sensitive: Boolean(f.sensitive),
        is_nullable: f.nullable,
        is_unique: Boolean(f.isUnique),
        is_searchable: Boolean(f.isSearchable),
        settings: fieldSettings(o, f),
        relation_target_object_uid: target ? objectUid(target) : null,
        relation_target_field_uid: f.relation?.inverse ? standardUniversalIdentifier(inverseKey(o.table, f.column)) : null,
        position,
        options: (f.options ?? []).map((value, i) => ({ value, label: humanOption(value), position: i })),
      });
    });
  }
  // The ONE_TO_MANY side of every workspace relation (Twenty pairs every MANY_TO_ONE with its inverse:
  // validate-morph-or-relation-flat-field-metadata.util.ts:145-205). It owns no column.
  for (const o of standard) {
    for (const f of o.fields) {
      if (!f.relation?.inverse) continue;
      const target = byTarget.get(f.relation.target)!;
      const n = (inverseCount.get(target.table) ?? 0) + 1;
      inverseCount.set(target.table, n);
      fields.push({
        universal_identifier: standardUniversalIdentifier(inverseKey(o.table, f.column)),
        object_uid: objectUid(target),
        name: f.relation.inverse.name,
        label: f.relation.inverse.label,
        type: 'RELATION',
        physical_column: null,
        is_system: false,
        is_ui_read_only: true,
        is_money: false,
        // #166 Info-2: an inverse that lists payroll / attendance rows (payrollRecords, payslips, attendances, corrections, …)
        // is itself payroll data: sensitive (payroll.view), never to AI, search or export by default.
        is_sensitive: o.kind === 'system',
        is_nullable: true,
        is_unique: false,
        is_searchable: false,
        settings: o.kind === 'system' ? { relationType: 'ONE_TO_MANY', sensitiveAuthority: 'payroll.view' } : { relationType: 'ONE_TO_MANY' },
        relation_target_object_uid: objectUid(o),
        relation_target_field_uid: fieldUid(o, f.column),
        position: 1000 + n,
        options: [],
      });
    }
  }
  return { objects, fields };
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff against the stored rows.
// ---------------------------------------------------------------------------------------------------------------------

export interface StoredObject {
  id: string;
  universal_identifier: string | null;
  is_custom: boolean;
  name_singular: string;
  name_plural: string;
  label_singular: string;
  label_plural: string;
  description: string | null;
  icon: string | null;
  physical_table: string;
  storage: string;
  is_system: boolean;
  is_active: boolean;
  allows_custom_fields: boolean;
  is_searchable: boolean;
  label_identifier_field_id: string | null;
}

export interface StoredField {
  id: string;
  object_metadata_id: string;
  universal_identifier: string | null;
  is_custom: boolean;
  name: string;
  label: string;
  description: string | null;
  type: string;
  physical_column: string | null;
  is_system: boolean;
  is_locked: boolean;
  is_ui_read_only: boolean;
  is_money: boolean;
  is_sensitive: boolean;
  is_exportable_when_sensitive: boolean;
  is_nullable: boolean;
  is_unique: boolean;
  is_searchable: boolean;
  settings: Record<string, unknown> | null;
  relation_target_object_metadata_id: string | null;
  relation_target_field_metadata_id: string | null;
  position: number;
}

export interface StoredOption {
  id: string;
  field_metadata_id: string;
  value: string;
  label: string;
  position: number;
}

export interface ObjectRow {
  id: string;
  universal_identifier: string;
  name_singular: string;
  name_plural: string;
  label_singular: string;
  label_plural: string;
  description: string | null;
  icon: string;
  physical_table: string;
  storage: 'workspace' | 'core_reference';
  is_system: boolean;
  is_active: boolean;
  allows_custom_fields: boolean;
  is_searchable: boolean;
  label_identifier_field_id: string | null;
}

export interface FieldRow {
  id: string;
  object_metadata_id: string;
  universal_identifier: string;
  name: string;
  label: string;
  type: string;
  physical_column: string | null;
  is_system: boolean;
  is_ui_read_only: boolean;
  is_money: boolean;
  is_sensitive: boolean;
  is_exportable_when_sensitive: boolean;
  is_nullable: boolean;
  is_unique: boolean;
  is_searchable: boolean;
  settings: Readonly<Record<string, unknown>>;
  relation_target_object_metadata_id: string | null;
  relation_target_field_metadata_id: string | null;
  position: number;
}

export interface OptionRow {
  id: string;
  field_metadata_id: string;
  value: string;
  label: string;
  position: number;
}

export interface StandardSyncPlan {
  insertObjects: ObjectRow[];
  updateObjects: ObjectRow[];
  insertFields: FieldRow[];
  updateFields: FieldRow[];
  insertOptions: OptionRow[];
  updateOptions: OptionRow[];
}

export const isEmptyPlan = (p: StandardSyncPlan): boolean => Object.values(p).every((rows) => rows.length === 0);

/** Key-order-independent JSON, so a jsonb read back compares equal to the code's object. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/**
 * The plan that brings the stored rows to the desired ones. `newId` makes the id of each inserted row (ids are chosen in code so
 * an object can be inserted already pointing at its label-identifier field, and a relation pair in one statement: each row is
 * written once). Throws StandardObjectSyncError on anything the sync may not change.
 */
export function planStandardObjectSync(
  desired: DesiredMetadata,
  stored: { objects: readonly StoredObject[]; fields: readonly StoredField[]; options: readonly StoredOption[] },
  newId: () => string,
): StandardSyncPlan {
  const plan: StandardSyncPlan = { insertObjects: [], updateObjects: [], insertFields: [], updateFields: [], insertOptions: [], updateOptions: [] };
  const desiredObjectUids = new Set(desired.objects.map((o) => o.universal_identifier));
  const desiredFieldUids = new Set(desired.fields.map((f) => f.universal_identifier));

  // Objects: match by universal identifier; any other non-custom object is unknown (refuse, never delete).
  const storedObjects = new Map<string, StoredObject>();
  for (const s of stored.objects) {
    if (s.is_custom) continue;
    if (!s.universal_identifier || !desiredObjectUids.has(s.universal_identifier)) {
      throw new StandardObjectSyncError('UNKNOWN_STANDARD_OBJECT', `stored standard object ${s.name_singular} is not declared by this code`);
    }
    storedObjects.set(s.universal_identifier, s);
  }
  const customNames = new Set(stored.objects.filter((s) => s.is_custom).flatMap((s) => [s.name_singular.toLowerCase(), s.name_plural.toLowerCase()]));
  const customTables = new Set(stored.objects.filter((s) => s.is_custom).map((s) => s.physical_table));
  const objectId = new Map<string, string>();
  for (const d of desired.objects) {
    const s = storedObjects.get(d.universal_identifier);
    if (!s && (customNames.has(d.name_singular.toLowerCase()) || customNames.has(d.name_plural.toLowerCase()) || customTables.has(d.physical_table))) {
      throw new StandardObjectSyncError('NAME_CONFLICT', `a custom object already uses the name or table of standard object ${d.name_singular}`);
    }
    objectId.set(d.universal_identifier, s?.id ?? newId());
  }

  // Fields.
  const storedFields = new Map<string, StoredField>();
  const standardObjectIds = new Set([...storedObjects.values()].map((o) => o.id));
  for (const s of stored.fields) {
    if (s.is_custom) continue;
    if (!s.universal_identifier || !desiredFieldUids.has(s.universal_identifier)) {
      throw new StandardObjectSyncError('UNKNOWN_STANDARD_FIELD', `stored built-in field ${s.name} is not declared by this code`);
    }
    storedFields.set(s.universal_identifier, s);
  }
  const customFieldNames = new Set(stored.fields.filter((s) => s.is_custom && standardObjectIds.has(s.object_metadata_id)).map((s) => `${s.object_metadata_id}:${s.name.toLowerCase()}`));
  const fieldId = new Map<string, string>();
  for (const d of desired.fields) fieldId.set(d.universal_identifier, storedFields.get(d.universal_identifier)?.id ?? newId());
  const idOf = (map: Map<string, string>, uid: string | null) => (uid === null ? null : map.get(uid)!);

  for (const d of desired.objects) {
    const s = storedObjects.get(d.universal_identifier);
    const row: ObjectRow = {
      id: objectId.get(d.universal_identifier)!,
      universal_identifier: d.universal_identifier,
      name_singular: d.name_singular,
      name_plural: d.name_plural,
      label_singular: d.label_singular,
      label_plural: d.label_plural,
      description: d.description,
      icon: d.icon,
      physical_table: d.physical_table,
      storage: d.storage,
      is_system: d.is_system,
      // Workspace-owned for non-system objects (Twenty keepWorkspaceOwnedProperties); system objects are always active.
      is_active: d.is_system ? true : (s?.is_active ?? true),
      allows_custom_fields: d.allows_custom_fields,
      is_searchable: d.is_searchable,
      label_identifier_field_id: idOf(fieldId, d.label_identifier_field_uid),
    };
    if (!s) {
      plan.insertObjects.push(row);
      continue;
    }
    if (s.name_singular !== d.name_singular || s.name_plural !== d.name_plural || s.physical_table !== d.physical_table || s.storage !== d.storage || s.is_system !== d.is_system) {
      throw new StandardObjectSyncError('IMMUTABLE_DIVERGENCE', `standard object ${d.name_singular}: a stored name, table, storage or system flag differs from the code`);
    }
    const changed =
      s.label_singular !== row.label_singular ||
      s.label_plural !== row.label_plural ||
      (s.description ?? null) !== row.description ||
      (s.icon ?? null) !== row.icon ||
      s.is_active !== row.is_active ||
      s.allows_custom_fields !== row.allows_custom_fields ||
      s.is_searchable !== row.is_searchable ||
      (s.label_identifier_field_id ?? null) !== row.label_identifier_field_id;
    if (changed) plan.updateObjects.push(row);
  }

  const storedOptionsByField = new Map<string, StoredOption[]>();
  for (const o of stored.options) {
    const list = storedOptionsByField.get(o.field_metadata_id) ?? [];
    list.push(o);
    storedOptionsByField.set(o.field_metadata_id, list);
  }

  for (const d of desired.fields) {
    const s = storedFields.get(d.universal_identifier);
    const id = fieldId.get(d.universal_identifier)!;
    const objectMetadataId = objectId.get(d.object_uid)!;
    if (!s && customFieldNames.has(`${objectMetadataId}:${d.name.toLowerCase()}`)) {
      throw new StandardObjectSyncError('NAME_CONFLICT', `a custom field already uses the name of built-in field ${d.name}`);
    }
    const row: FieldRow = {
      id,
      object_metadata_id: objectMetadataId,
      universal_identifier: d.universal_identifier,
      name: d.name,
      label: d.label,
      type: d.type,
      physical_column: d.physical_column,
      is_system: d.is_system,
      is_ui_read_only: d.is_ui_read_only,
      is_money: d.is_money,
      is_sensitive: d.is_sensitive,
      // OB-13 opt-in is workspace-owned, but it can only exist on a sensitive field (the table's CHECK).
      is_exportable_when_sensitive: d.is_sensitive ? (s?.is_exportable_when_sensitive ?? false) : false,
      is_nullable: d.is_nullable,
      is_unique: d.is_unique,
      is_searchable: d.is_searchable,
      settings: d.settings,
      relation_target_object_metadata_id: idOf(objectId, d.relation_target_object_uid),
      relation_target_field_metadata_id: idOf(fieldId, d.relation_target_field_uid),
      position: d.position,
    };
    if (!s) {
      plan.insertFields.push(row);
    } else {
      if (
        s.name !== row.name ||
        s.type !== row.type ||
        (s.physical_column ?? null) !== row.physical_column ||
        s.object_metadata_id !== row.object_metadata_id ||
        s.is_system !== row.is_system ||
        s.is_money !== row.is_money ||
        (s.relation_target_object_metadata_id ?? null) !== row.relation_target_object_metadata_id
      ) {
        throw new StandardObjectSyncError('IMMUTABLE_DIVERGENCE', `built-in field ${d.name}: a stored name, type, column, object, system or money flag or relation target differs from the code`);
      }
      const changed =
        !s.is_locked || // never unlocked: restore the lock (MT-26)
        s.label !== row.label ||
        (s.description ?? null) !== null ||
        s.is_ui_read_only !== row.is_ui_read_only ||
        s.is_sensitive !== row.is_sensitive ||
        s.is_exportable_when_sensitive !== row.is_exportable_when_sensitive ||
        s.is_nullable !== row.is_nullable ||
        s.is_unique !== row.is_unique ||
        s.is_searchable !== row.is_searchable ||
        canonicalJson(s.settings ?? {}) !== canonicalJson(row.settings) ||
        (s.relation_target_field_metadata_id ?? null) !== row.relation_target_field_metadata_id ||
        Number(s.position) !== row.position;
      if (changed) plan.updateFields.push(row);
    }

    // Options (SELECT): matched by value; a stored value the code no longer declares is refused (never deleted).
    const existing = s ? (storedOptionsByField.get(s.id) ?? []) : [];
    const desiredValues = new Set(d.options.map((o) => o.value));
    for (const e of existing) {
      if (!desiredValues.has(e.value)) throw new StandardObjectSyncError('UNKNOWN_STANDARD_OPTION', `built-in field ${d.name} holds option ${e.value} the code does not declare`);
    }
    for (const o of d.options) {
      const e = existing.find((x) => x.value === o.value);
      const optionRow: OptionRow = { id: e?.id ?? newId(), field_metadata_id: id, value: o.value, label: o.label, position: o.position };
      if (!e) plan.insertOptions.push(optionRow);
      else if (e.label !== o.label || Number(e.position) !== o.position) plan.updateOptions.push(optionRow);
    }
  }
  return plan;
}
