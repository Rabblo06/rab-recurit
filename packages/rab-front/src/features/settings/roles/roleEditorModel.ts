import { api } from '../../../shared/api';

/**
 * Types and API calls for the full-page role editor (Settings → Members → Roles → [Role]). The server owns every
 * object, field, operator and option shown here (`GET /roles/object-metadata`) and re-validates every save — this
 * module never invents a permission the API does not understand.
 */

export type ObjectKey = 'staff' | 'venue' | 'shift';
export type ReadOverride = 'inherit' | 'grant' | 'deny';
export type FieldVisibility = 'visible' | 'hidden';
export type FilterOperator = 'eq' | 'neq' | 'in' | 'not_in' | 'gte' | 'lte' | 'is_empty' | 'is_not_empty';

export interface FieldMeta {
  key: string;
  label: string;
  dataType: string;
  locked: boolean;
  defaultVisible: boolean;
  sensitive: boolean;
  /** Whether the CURRENT editor may make this field visible (they hold the authority themselves). */
  grantable: boolean;
  filter: {
    kind: 'enum' | 'relation' | 'text' | 'date';
    operators: FilterOperator[];
    nullable: boolean;
    options: Array<{ value: string; label: string }> | null;
    relation: 'venue' | 'job_role' | null;
  } | null;
}

export interface ObjectMeta {
  key: ObjectKey;
  label: string;
  labelPlural: string;
  icon: string;
  description: string;
  actions: { read: boolean; update: boolean; softDelete: boolean; destroy: boolean };
  unsupportedReason: string;
  /** Whether the CURRENT editor may grant "See" on this object (they can see it themselves). */
  grantable: boolean;
  fields: FieldMeta[];
}

export interface ObjectMetadata {
  objects: ObjectMeta[];
  icons: string[];
}

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: string | string[];
}
export interface FilterGroup {
  op: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

export interface ObjectRule {
  object: ObjectKey;
  read: ReadOverride;
  fields: Record<string, FieldVisibility>;
  recordFilter: FilterGroup | null;
}

export interface RoleDefinition {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  isSystem: boolean;
  isMemberRole: boolean;
  assignableToMembers: boolean;
  readAllObjects: boolean;
  objects: ObjectRule[];
  permissionKeys: string[];
  updatedAt: string;
}

/** The editable part of a role, as the editor holds it between Save clicks. */
export interface RoleDraft {
  name: string;
  description: string;
  icon: string | null;
  assignableToMembers: boolean;
  readAllObjects: boolean;
  objects: ObjectRule[];
}

export const EMPTY_DRAFT: RoleDraft = { name: '', description: '', icon: 'shield', assignableToMembers: true, readAllObjects: false, objects: [] };

export class SavedRoleResponseError extends Error {}

/** A successful status without the saved definition cannot confirm a save. Keep the draft in that case. */
export function assertSavedRole(value: unknown, expectedId: string | null): asserts value is RoleDefinition {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const text = (item: unknown) => typeof item === 'string' && item.trim().length > 0;
  const nullableText = (item: unknown) => item === null || typeof item === 'string';
  const filter = (item: unknown, depth = 0): boolean => record(item) && depth < 10 &&
    ['and', 'or'].includes(String(item.op)) && Array.isArray(item.conditions) && item.conditions.every((condition) =>
      record(condition) && ('conditions' in condition ? filter(condition, depth + 1) :
        text(condition.field) && text(condition.operator) && (condition.value === undefined || typeof condition.value === 'string' ||
          Array.isArray(condition.value) && condition.value.every((entry) => typeof entry === 'string'))));
  const valid = record(value) && text(value.id) && (!expectedId || value.id === expectedId) && text(value.key) && text(value.name) &&
    nullableText(value.description) && nullableText(value.icon) && value.isSystem === false && value.isMemberRole === true &&
    typeof value.assignableToMembers === 'boolean' && typeof value.readAllObjects === 'boolean' &&
    typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) &&
    Array.isArray(value.permissionKeys) && value.permissionKeys.every((key) => typeof key === 'string') &&
    Array.isArray(value.objects) && value.objects.every((rule) => record(rule) && text(rule.object) &&
      ['inherit', 'grant', 'deny'].includes(String(rule.read)) && record(rule.fields) &&
      Object.values(rule.fields).every((visibility) => visibility === 'visible' || visibility === 'hidden') &&
      (rule.recordFilter === null || filter(rule.recordFilter)));
  if (!valid) throw new SavedRoleResponseError('The server did not return a complete saved role. Your draft has been kept. Reload the roles list to check whether the change was applied before retrying.');
}

export function draftFromDefinition(def: RoleDefinition): RoleDraft {
  return {
    name: def.name,
    description: def.description ?? '',
    icon: def.icon ?? 'shield',
    assignableToMembers: def.assignableToMembers,
    readAllObjects: def.readAllObjects,
    objects: def.objects.map((o) => ({ ...o, fields: { ...o.fields }, recordFilter: (o.recordFilter as FilterGroup | null) ?? null })),
  };
}

/** Request body for POST/PUT /roles — the whole definition, saved in one server transaction. */
export function toRequest(draft: RoleDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    icon: draft.icon,
    assignableToMembers: draft.assignableToMembers,
    readAllObjects: draft.readAllObjects,
    objects: draft.objects.map((o) => ({
      object: o.object,
      read: o.read,
      fields: o.fields,
      recordFilter: o.recordFilter,
    })),
  };
}

export function effectiveRead(draft: RoleDraft, object: ObjectKey): boolean {
  const rule = draft.objects.find((o) => o.object === object);
  if (rule?.read === 'grant') return true;
  if (rule?.read === 'deny') return false;
  return draft.readAllObjects;
}

export function isFieldVisible(rule: ObjectRule | undefined, field: FieldMeta): boolean {
  if (field.locked) return true;
  const explicit = rule?.fields[field.key];
  return explicit ? explicit === 'visible' : field.defaultVisible;
}

export function countConditions(group: FilterGroup | null): number {
  if (!group) return 0;
  return group.conditions.reduce((n, c) => n + ('conditions' in c ? countConditions(c) : 1), 0);
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  gte: 'is on or after',
  lte: 'is on or before',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

export const MAX_FILTER_CONDITIONS = 20;

/** Server message for a failed request, never a generic stack trace. */
export function apiError(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { message?: unknown } } })?.response?.data;
  const message = data?.message;
  if (Array.isArray(message)) return message.join(' ');
  return typeof message === 'string' && message ? message : fallback;
}

export const roleApi = {
  metadata: async () => (await api.get<ObjectMetadata>('/roles/object-metadata')).data,
  definition: async (id: string) => (await api.get<RoleDefinition>(`/roles/${id}/definition`)).data,
  create: async (draft: RoleDraft) => (await api.post<RoleDefinition>('/roles', toRequest(draft))).data,
  update: async (id: string, draft: RoleDraft) => (await api.put<RoleDefinition>(`/roles/${id}`, toRequest(draft))).data,
  remove: async (id: string) => {
    await api.delete(`/roles/${id}`);
  },
  venues: async () => (await api.get<{ data: Array<{ id: string; name: string }> }>('/venues?limit=1000')).data.data,
  jobRoles: async () => (await api.get<Array<{ id: string; name: string }>>('/job-roles')).data,
};
