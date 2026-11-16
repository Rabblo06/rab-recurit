/**
 * Metadata engine (E1): the field-type vocabulary shared by the server, the web console and the mobile app.
 *
 * Twenty's 25 field types, re-implemented (twentyhq/twenty @ eedb0a73 `packages/twenty-shared/src/types/FieldMetadataType.ts:1-27`;
 * behaviour only, AGPL). The database CHECK on `core.field_metadata.type` (MetadataEngineTables1786721550000) holds exactly
 * these values plus CREWFLOW_INTERNAL_FIELD_METADATA_TYPES; a unit spec in rab-server pins the two lists together.
 */
export const FIELD_METADATA_TYPES = [
  'ACTOR',
  'ADDRESS',
  'ARRAY',
  'BOOLEAN',
  'CURRENCY',
  'DATE',
  'DATE_TIME',
  'EMAILS',
  'FILES',
  'FULL_NAME',
  'LINKS',
  'MORPH_RELATION',
  'MULTI_SELECT',
  'NUMBER',
  'NUMERIC',
  'PHONES',
  'POSITION',
  'RATING',
  'RAW_JSON',
  'RELATION',
  'RICH_TEXT',
  'SELECT',
  'TEXT',
  'TS_VECTOR',
  'UUID',
] as const;

export type FieldMetadataType = (typeof FIELD_METADATA_TYPES)[number];

/**
 * Crewflow-only types for built-in columns Twenty has no type for (M0-STANDARD-OBJECTS S8: `shift_assignment.period`
 * tstzrange). Allowed only on a built-in system field; never offered for custom fields and never exposed in generated APIs.
 */
export const CREWFLOW_INTERNAL_FIELD_METADATA_TYPES = ['RANGE'] as const;

/** Every value `core.field_metadata.type` can hold. */
export type StoredFieldMetadataType = FieldMetadataType | (typeof CREWFLOW_INTERNAL_FIELD_METADATA_TYPES)[number];

/** In Twenty's vocabulary but refused by the database (morph relations are out of scope, M0-BACKEND §0.1). */
export const UNSUPPORTED_FIELD_METADATA_TYPES: readonly FieldMetadataType[] = ['MORPH_RELATION'];

/** Allowed on custom objects only (OWNER-METADATA-ENGINE §0.5): stored as bigint minor units + a currency code. */
export const CUSTOM_OBJECT_ONLY_FIELD_METADATA_TYPES: readonly FieldMetadataType[] = ['CURRENCY'];

/** `field_metadata.settings.relationType` (Twenty `FieldMetadataSettings.ts:53-55`). Only MANY_TO_ONE owns a column. */
export const RELATION_TYPES = ['MANY_TO_ONE', 'ONE_TO_MANY'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** `field_metadata.settings.onDelete` of a MANY_TO_ONE relation. */
export const RELATION_ON_DELETE_ACTIONS = ['CASCADE', 'RESTRICT', 'SET_NULL', 'NO_ACTION'] as const;
export type RelationOnDelete = (typeof RELATION_ON_DELETE_ACTIONS)[number];

/** `object_metadata.storage`: a table of the workspace schema, or a read-only core reference object (M0-STANDARD-OBJECTS §3). */
export const OBJECT_METADATA_STORAGES = ['workspace', 'core_reference'] as const;
export type ObjectMetadataStorage = (typeof OBJECT_METADATA_STORAGES)[number];

export function isFieldMetadataType(value: unknown): value is FieldMetadataType {
  return typeof value === 'string' && (FIELD_METADATA_TYPES as readonly string[]).includes(value);
}
