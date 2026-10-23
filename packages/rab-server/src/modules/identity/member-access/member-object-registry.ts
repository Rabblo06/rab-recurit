import { EmploymentStatus, PermissionFlag, PermissionFlagType, ShiftStatus, VenueStatus, VenueType } from '@rab/shared';

/**
 * Server-owned metadata for what CUSTOM workspace-member roles can be granted on (Settings → Members → Roles editor).
 *
 * This file is the ONLY source of object keys, field keys, response properties, filterable columns and operators used
 * by object-, field- and record-level permissions. Nothing a client sends is ever used as an identifier: field keys
 * from requests are looked up here, and SQL is only ever built from the `column`/`property` strings below.
 *
 * Only objects with a real, owner-scoped member read path are listed (Staff, Venues, Shifts). Members are read-only:
 * Edit / Delete / Destroy are reported as unsupported so the UI can show them disabled — never as fake toggles.
 */

export type MemberObjectKey = 'staff' | 'venue' | 'shift';
export const MEMBER_OBJECT_KEYS: readonly MemberObjectKey[] = ['staff', 'venue', 'shift'];

export type FieldDataType = 'text' | 'email' | 'phone' | 'number' | 'money' | 'date' | 'datetime' | 'enum' | 'relation' | 'boolean' | 'json' | 'list';
export type FilterOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'gte' | 'lte' | 'is_empty' | 'is_not_empty';
export type FilterValueKind = 'enum' | 'relation' | 'text' | 'date';

export interface MemberField {
  key: string;
  label: string;
  dataType: FieldDataType;
  /** Response properties this field controls. A member response contains ONLY properties of visible fields. */
  properties: string[];
  /** Always visible to anyone who can see the object (identity / label fields). Not configurable. */
  locked?: boolean;
  /** Visible when no explicit rule exists. Sensitive fields default to hidden (least privilege). */
  defaultVisible: boolean;
  /** Making this field visible to members requires the role editor to hold this permission themselves. */
  sensitiveAuthority?: PermissionFlagType;
  /** If set, the field can be used in record-level filters. */
  filter?: {
    kind: FilterValueKind;
    operators: FilterOperator[];
    /** Entity property name (QueryBuilder); prefixed with the caller's alias. */
    property: string;
    /** Database column name (raw SQL); prefixed with the caller's alias. */
    column: string;
    nullable?: boolean;
    options?: Array<{ value: string; label: string }>;
    /** For relation filters: which object/endpoint supplies the choices, and the table used to validate ids. */
    relation?: { target: 'venue' | 'job_role'; table: string };
  };
}

export interface MemberObject {
  key: MemberObjectKey;
  label: string;
  labelPlural: string;
  icon: string;
  description: string;
  /** The existing route-level permission flag that a "See" grant on this object materialises into. */
  readFlag: PermissionFlagType;
  /** Response properties always returned for a visible record (ids, timestamps the UI needs to function). */
  baseProperties: string[];
  fields: MemberField[];
  actions: { read: true; update: false; softDelete: false; destroy: false };
  unsupportedReason: string;
}

const enumOptions = (values: Record<string, string>) =>
  Object.values(values).map((value) => ({ value, label: value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));

const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'].map((value) => ({ value, label: value }));
const READ_ONLY_REASON = 'Workspace members have read-only access. Editing and deleting records stay with the workspace owner.';

export const MEMBER_OBJECTS: Record<MemberObjectKey, MemberObject> = {
  staff: {
    key: 'staff',
    label: 'Staff',
    labelPlural: 'Staff',
    icon: 'users',
    description: 'Recruitment staff in your workspace (Users page).',
    readFlag: PermissionFlag.STAFF_VIEW,
    baseProperties: ['id', 'createdAt', 'archivedAt'],
    actions: { read: true, update: false, softDelete: false, destroy: false },
    unsupportedReason: READ_ONLY_REASON,
    fields: [
      { key: 'name', label: 'Name', dataType: 'text', properties: ['firstName', 'lastName', 'preferredName', 'avatarKey'], locked: true, defaultVisible: true },
      { key: 'staffRef', label: 'Staff reference', dataType: 'text', properties: ['staffRef'], locked: true, defaultVisible: true },
      {
        key: 'employmentStatus',
        label: 'Employment status',
        dataType: 'enum',
        properties: ['employmentStatus', 'accountStatus'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'enum', operators: ['eq', 'neq', 'in', 'not_in'], property: 'employmentStatus', column: 'employment_status', options: enumOptions(EmploymentStatus) },
      },
      {
        key: 'jobRole',
        label: 'Job role',
        dataType: 'relation',
        properties: ['jobRoleId'],
        defaultVisible: true,
        filter: { kind: 'relation', operators: ['in', 'not_in', 'is_empty', 'is_not_empty'], property: 'jobRoleId', column: 'job_role_id', nullable: true, relation: { target: 'job_role', table: 'job_role' } },
      },
      {
        key: 'employmentType',
        label: 'Employment type',
        dataType: 'enum',
        properties: ['employmentType'],
        defaultVisible: true,
        filter: { kind: 'enum', operators: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty'], property: 'employmentType', column: 'employment_type', nullable: true, options: EMPLOYMENT_TYPES },
      },
      {
        key: 'startDate',
        label: 'Start date',
        dataType: 'date',
        properties: ['startDate'],
        defaultVisible: true,
        filter: { kind: 'date', operators: ['gte', 'lte', 'is_empty', 'is_not_empty'], property: 'startDate', column: 'start_date', nullable: true },
      },
      {
        key: 'city',
        label: 'City',
        dataType: 'text',
        properties: ['city'],
        defaultVisible: true,
        filter: { kind: 'text', operators: ['eq', 'neq', 'is_empty', 'is_not_empty'], property: 'city', column: 'city', nullable: true },
      },
      { key: 'skills', label: 'Skills & languages', dataType: 'list', properties: ['otherSkills', 'yearsExperience', 'languages'], defaultVisible: true },
      { key: 'availability', label: 'Availability', dataType: 'list', properties: ['availableDays', 'preferredShiftTimes', 'maxHoursPerWeek'], defaultVisible: true },
      { key: 'email', label: 'Email', dataType: 'email', properties: ['email'], defaultVisible: false },
      { key: 'phone', label: 'Phone', dataType: 'phone', properties: ['phone'], defaultVisible: false, sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE },
      { key: 'address', label: 'Home address', dataType: 'text', properties: ['address', 'postcode'], defaultVisible: false, sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE },
      { key: 'dateOfBirth', label: 'Date of birth', dataType: 'date', properties: ['dateOfBirth'], defaultVisible: false, sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE },
      { key: 'payRate', label: 'Default pay rate', dataType: 'money', properties: ['defaultPayRatePence'], defaultVisible: false, sensitiveAuthority: PermissionFlag.PAYROLL_VIEW },
      {
        key: 'emergencyContact',
        label: 'Emergency contact',
        dataType: 'text',
        properties: ['emergencyContactName', 'emergencyContactRelationship', 'emergencyContactPhone'],
        defaultVisible: false,
        sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE,
      },
      {
        key: 'rightToWork',
        label: 'Right to work',
        dataType: 'text',
        properties: ['rightToWorkStatus', 'documentType', 'expiryDate'],
        defaultVisible: false,
        sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE,
      },
      { key: 'notes', label: 'Notes', dataType: 'text', properties: ['notes'], defaultVisible: false, sensitiveAuthority: PermissionFlag.STAFF_VIEW_SENSITIVE },
    ],
  },
  venue: {
    key: 'venue',
    label: 'Venue',
    labelPlural: 'Venues',
    icon: 'building',
    description: 'Client venues and their site details.',
    readFlag: PermissionFlag.VENUE_VIEW,
    baseProperties: ['id', 'createdAt', 'updatedAt', 'archivedAt'],
    actions: { read: true, update: false, softDelete: false, destroy: false },
    unsupportedReason: READ_ONLY_REASON,
    fields: [
      {
        key: 'name',
        label: 'Name',
        dataType: 'relation',
        properties: ['name'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'relation', operators: ['in', 'not_in'], property: 'id', column: 'id', relation: { target: 'venue', table: 'venue' } },
      },
      {
        key: 'status',
        label: 'Status',
        dataType: 'enum',
        properties: ['status'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'enum', operators: ['eq', 'neq', 'in', 'not_in'], property: 'status', column: 'status', options: enumOptions(VenueStatus) },
      },
      {
        key: 'type',
        label: 'Type',
        dataType: 'enum',
        properties: ['type'],
        defaultVisible: true,
        filter: { kind: 'enum', operators: ['eq', 'neq', 'in', 'not_in'], property: 'type', column: 'type', options: enumOptions(VenueType) },
      },
      { key: 'clientName', label: 'Client name', dataType: 'text', properties: ['clientName'], defaultVisible: true },
      { key: 'address', label: 'Address & location', dataType: 'json', properties: ['address', 'lat', 'lng', 'geofenceRadiusM', 'enforceGeofence'], defaultVisible: true },
      { key: 'siteInstructions', label: 'Site instructions', dataType: 'text', properties: ['instructions', 'checkInInstructions', 'parking', 'accessNotes', 'uniform'], defaultVisible: true },
      { key: 'breakPolicy', label: 'Break policy', dataType: 'boolean', properties: ['breakPaid', 'defaultBreakMinutes'], defaultVisible: true },
      { key: 'contact', label: 'Site contact', dataType: 'json', properties: ['contact'], defaultVisible: false, sensitiveAuthority: PermissionFlag.VENUE_EDIT },
    ],
  },
  shift: {
    key: 'shift',
    label: 'Shift',
    labelPlural: 'Shifts',
    icon: 'calendar',
    description: 'Shifts, the calendar and job roles.',
    readFlag: PermissionFlag.SCHEDULE_VIEW,
    baseProperties: ['id', 'createdAt', 'updatedAt', 'archivedAt'],
    actions: { read: true, update: false, softDelete: false, destroy: false },
    unsupportedReason: READ_ONLY_REASON,
    fields: [
      { key: 'times', label: 'Start & end time', dataType: 'datetime', properties: ['startsAt', 'endsAt', 'defaultStartsAt', 'defaultEndsAt', 'breakMinutes'], locked: true, defaultVisible: true },
      {
        key: 'status',
        label: 'Status',
        dataType: 'enum',
        properties: ['status', 'publishedAt'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'enum', operators: ['eq', 'neq', 'in', 'not_in'], property: 'status', column: 'status', options: enumOptions(ShiftStatus) },
      },
      {
        key: 'venue',
        label: 'Venue',
        dataType: 'relation',
        properties: ['venueId'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'relation', operators: ['in', 'not_in'], property: 'venueId', column: 'venue_id', relation: { target: 'venue', table: 'venue' } },
      },
      {
        key: 'jobRole',
        label: 'Job role',
        dataType: 'relation',
        properties: ['jobRoleId'],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'relation', operators: ['in', 'not_in'], property: 'jobRoleId', column: 'job_role_id', relation: { target: 'job_role', table: 'job_role' } },
      },
      {
        key: 'startDate',
        label: 'Shift date',
        dataType: 'date',
        properties: [],
        locked: true,
        defaultVisible: true,
        filter: { kind: 'date', operators: ['gte', 'lte'], property: 'startsAt', column: 'starts_at' },
      },
      { key: 'staffing', label: 'Staffing numbers', dataType: 'number', properties: ['requiredCount', 'filledCount'], defaultVisible: true },
      { key: 'address', label: 'Shift address', dataType: 'text', properties: ['address'], defaultVisible: true },
      { key: 'notes', label: 'Notes', dataType: 'text', properties: ['notes', 'cancelledReason', 'declinedReason'], defaultVisible: false },
      { key: 'payRate', label: 'Pay rate', dataType: 'money', properties: ['payRatePence', 'defaultRatePence'], defaultVisible: false, sensitiveAuthority: PermissionFlag.PAYROLL_VIEW },
      { key: 'chargeRate', label: 'Charge rate', dataType: 'money', properties: ['chargeRatePence'], defaultVisible: false, sensitiveAuthority: PermissionFlag.PAYROLL_VIEW },
    ],
  },
};

export function memberObject(key: string): MemberObject | null {
  return (MEMBER_OBJECTS as Record<string, MemberObject>)[key] ?? null;
}

export function memberField(objectKey: string, fieldKey: string): MemberField | null {
  return memberObject(objectKey)?.fields.find((f) => f.key === fieldKey) ?? null;
}

/** Public, client-safe metadata (no SQL expressions). */
export function publicObjectMetadata() {
  return MEMBER_OBJECT_KEYS.map((key) => {
    const o = MEMBER_OBJECTS[key];
    return {
      key: o.key,
      label: o.label,
      labelPlural: o.labelPlural,
      icon: o.icon,
      description: o.description,
      actions: o.actions,
      unsupportedReason: o.unsupportedReason,
      fields: o.fields.map((f) => ({
        key: f.key,
        label: f.label,
        dataType: f.dataType,
        locked: !!f.locked,
        defaultVisible: f.defaultVisible,
        sensitive: !!f.sensitiveAuthority,
        filter: f.filter ? { kind: f.filter.kind, operators: f.filter.operators, nullable: !!f.filter.nullable, options: f.filter.options ?? null, relation: f.filter.relation?.target ?? null } : null,
      })),
    };
  });
}
