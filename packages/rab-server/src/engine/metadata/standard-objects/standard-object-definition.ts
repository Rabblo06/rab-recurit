/**
 * Metadata engine M1 / E2: the shape of a code-defined STANDARD object (OWNER-METADATA-ENGINE.md §1 E2, M0-STANDARD-OBJECTS.md).
 *
 * Twenty (twentyhq/twenty @ eedb0a73) declares its built-in objects in code under
 * `packages/twenty-server/src/engine/workspace-manager/twenty-standard-application/` (objects:
 * `utils/object-metadata/create-standard-flat-object-metadata.util.ts`, fields: `utils/field-metadata/*`) and syncs them into
 * every workspace's metadata (`services/twenty-standard-application.service.ts:42-156`). Crewflow re-implements that idea (no
 * code copied): one frozen definition per workspace table, matched to the stored rows by a stable universal identifier.
 *
 * Pure types only: no imports, no I/O. The definitions themselves describe the workspace-schema template, so they live next to
 * it (`database/typeorm/workspace-schema/standard-objects/`); the sync machinery lives here, in the engine.
 */

/** The field types a standard column maps to (M0-STANDARD-OBJECTS.md §1). RANGE is Crewflow-internal (S8, never in an API). */
export type StandardFieldType =
  | 'UUID'
  | 'TEXT'
  | 'NUMBER'
  | 'NUMERIC'
  | 'BOOLEAN'
  | 'DATE'
  | 'DATE_TIME'
  | 'RAW_JSON'
  | 'ARRAY'
  | 'TS_VECTOR'
  | 'SELECT'
  | 'RELATION'
  | 'RANGE';

/** ON DELETE of the foreign key behind a MANY_TO_ONE relation (copied from the catalog, never chosen). */
export type RelationOnDelete = 'CASCADE' | 'RESTRICT' | 'SET_NULL' | 'NO_ACTION';

/**
 * What an object is:
 *  - `system`: the seven §0.3 payroll / attendance objects (isSystem, no custom fields, every column locked, read-only);
 *  - `junction`: the three link tables without an `id` (S1: isSystem, no custom fields, never generic records);
 *  - `standard`: the other eleven workspace tables (built-in columns locked; custom fields per owner decisions D1–D4);
 *  - `coreReference`: a read-only `core` table that standard relations point at (M0-STANDARD-OBJECTS.md §3). Never a
 *    custom-field target, never user-editable, never among "the 21".
 */
export type StandardObjectKind = 'system' | 'junction' | 'standard' | 'coreReference';

/** The keys of the core reference objects (relation targets outside the workspace schema, S7). */
export type CoreReferenceKey = 'workspaceMember' | 'managerProfile' | 'storedFile' | 'payrollCalendarPeriod';

export interface StandardFieldSettings {
  /** NUMBER: the PostgreSQL integer type of the column. */
  readonly dataType?: 'int' | 'smallint' | 'bigint';
  /** NUMERIC: the column's declared precision and scale. */
  readonly precision?: number;
  readonly scale?: number;
  readonly unit?: 'pence' | 'minutes' | 'metres' | 'count';
  /** bigint pence (§0.3 / §0.5): always locked, read-only and sensitive (payroll.view). Never CURRENCY on a standard object. */
  readonly money?: boolean;
  /** NUMBER smallint 1–5 shown as a rating (S9; never rewritten to Twenty's RATING text). */
  readonly displayAs?: 'rating';
  readonly min?: number;
  readonly max?: number;
}

export interface StandardRelationDefinition {
  /** A workspace table of this list, or a core reference object. */
  readonly target: string;
  /** The FK's ON DELETE action; absent when no foreign key backs the relation (core."user" since structure level 22). */
  readonly onDelete?: RelationOnDelete;
  /** The ONE_TO_MANY field created on the target (workspace targets only; core reference objects get no inverse). */
  readonly inverse?: { readonly name: string; readonly label: string };
  /**
   * The constraint that enforces the relation when it is not a plain FK to the target's `id` (shift_staff_review.staff_profile_id
   * is enforced through its composite FK to shift_assignment(shift_id, staff_profile_id)), or `service:<Name>` when only the
   * service layer enforces it (every relation to core."user" since DropWorkspaceCoreForeignKeys, owner decision 0a).
   */
  readonly enforcedBy?: string;
}

export interface StandardFieldDefinition {
  /** The physical column (immutable; the universal identifier is derived from table + column). */
  readonly column: string;
  /** `format_type(atttypid, atttypmod)` of the column in a freshly provisioned workspace (checked at every sync). */
  readonly pgType: string;
  readonly nullable: boolean;
  readonly name: string;
  readonly label: string;
  readonly type: StandardFieldType;
  readonly isSystem?: boolean;
  /** No write through any generated API or the generic UI (Twenty isUIReadOnly). S13: every status column. */
  readonly isUIReadOnly?: boolean;
  readonly isUnique?: boolean;
  readonly isSearchable?: boolean;
  /** §0.5: never to AI, search or export by default. `authority` = the permission that may read it (null = none named yet). */
  readonly sensitive?: { readonly authority: string | null };
  readonly settings?: StandardFieldSettings;
  /** SELECT: the allowed stored values, exactly as the column's CHECK lists them. */
  readonly options?: readonly string[];
  readonly relation?: StandardRelationDefinition;
}

export interface StandardObjectDefinition {
  /** The physical table (a workspace table, or for a core reference the `core` table name). */
  readonly table: string;
  readonly kind: StandardObjectKind;
  readonly nameSingular: string;
  readonly namePlural: string;
  readonly labelSingular: string;
  readonly labelPlural: string;
  readonly description: string | null;
  /** An icon key (`^[A-Za-z0-9]{1,64}$`), never markup. */
  readonly icon: string;
  readonly allowsCustomFields: boolean;
  readonly isSearchable: boolean;
  /** The column whose field is the record's label (Twenty labelIdentifierFieldMetadataId), or null. */
  readonly labelIdentifierColumn: string | null;
  readonly fields: readonly StandardFieldDefinition[];
}
