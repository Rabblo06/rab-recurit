import { FilterOperator, memberObject, MemberField } from './member-object-registry';

/**
 * Record-level permission filters for custom workspace-member roles.
 *
 * Storage shape (role_object_permission.record_filter):
 *   { op: 'and' | 'or', conditions: Array<Condition | { op, conditions: Condition[] }> }
 *   Condition = { field: <registry field key>, operator: <allowlisted operator>, value?: string | string[] }
 *
 * Limits: one root group, at most one level of nested groups, 1–20 conditions in total, every group non-empty.
 * A filter can only NARROW what a member sees: callers always AND it onto the mandatory organisation, workspace and
 * owner scope, which it cannot reference or replace.
 *
 * SQL is generated only from registry-owned property/column names and parameter placeholders; values are always bound
 * parameters. A stored filter that no longer validates (e.g. a field was removed from the registry) compiles to FALSE
 * — deny, never allow.
 */

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: string | string[];
}
export interface FilterGroup {
  op: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

export const MAX_FILTER_CONDITIONS = 20;
const MAX_IN_VALUES = 50;
const MAX_TEXT_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_OPERATORS: FilterOperator[] = ['in', 'not_in'];
const NO_VALUE_OPERATORS: FilterOperator[] = ['is_empty', 'is_not_empty'];

export class RecordFilterError extends Error {}

const isGroup = (node: unknown): node is FilterGroup =>
  !!node && typeof node === 'object' && 'op' in (node as Record<string, unknown>) && 'conditions' in (node as Record<string, unknown>);

/** Relation ids referenced by a filter, per target table — the caller verifies they exist in the actor's scope. */
export interface ValidatedFilter {
  filter: FilterGroup;
  relationIds: Record<string, string[]>;
}

/** Strict structural + semantic validation. Throws RecordFilterError with a user-facing message; never partially accepts. */
export function validateRecordFilter(objectKey: string, input: unknown): ValidatedFilter {
  const object = memberObject(objectKey);
  if (!object) throw new RecordFilterError('Unknown object.');
  const relationIds: Record<string, string[]> = {};
  let count = 0;

  const normaliseCondition = (raw: unknown): FilterCondition => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RecordFilterError('Each condition must be an object.');
    const c = raw as Record<string, unknown>;
    const extra = Object.keys(c).filter((k) => !['field', 'operator', 'value'].includes(k));
    if (extra.length) throw new RecordFilterError(`Unexpected condition property: ${extra[0]}.`);
    if (typeof c.field !== 'string') throw new RecordFilterError('Each condition needs a field.');
    const field = object.fields.find((f) => f.key === c.field && f.filter);
    if (!field || !field.filter) throw new RecordFilterError(`"${c.field}" cannot be used in a record filter for ${object.labelPlural}.`);
    const operator = c.operator as FilterOperator;
    if (typeof operator !== 'string' || !field.filter.operators.includes(operator)) {
      throw new RecordFilterError(`Operator "${String(c.operator)}" is not allowed for ${field.label}.`);
    }
    count += 1;
    if (NO_VALUE_OPERATORS.includes(operator)) {
      if (c.value !== undefined && c.value !== null) throw new RecordFilterError(`${field.label}: this operator takes no value.`);
      return { field: field.key, operator };
    }
    const values = LIST_OPERATORS.includes(operator) ? c.value : [c.value];
    if (!Array.isArray(values) || values.length === 0) throw new RecordFilterError(`${field.label}: choose at least one value.`);
    if (values.length > MAX_IN_VALUES) throw new RecordFilterError(`${field.label}: too many values (max ${MAX_IN_VALUES}).`);
    const clean = values.map((v) => checkValue(field, v));
    if (field.filter.kind === 'relation') {
      const table = field.filter.relation!.table;
      relationIds[table] = [...new Set([...(relationIds[table] ?? []), ...clean])];
    }
    return { field: field.key, operator, value: LIST_OPERATORS.includes(operator) ? [...new Set(clean)] : clean[0] };
  };

  const normaliseGroup = (raw: unknown, depth: number): FilterGroup => {
    if (!isGroup(raw)) throw new RecordFilterError('A filter must be a group with "op" and "conditions".');
    const g = raw as unknown as Record<string, unknown>;
    const extra = Object.keys(g).filter((k) => !['op', 'conditions'].includes(k));
    if (extra.length) throw new RecordFilterError(`Unexpected group property: ${extra[0]}.`);
    if (g.op !== 'and' && g.op !== 'or') throw new RecordFilterError('Group operator must be "and" or "or".');
    if (!Array.isArray(g.conditions) || g.conditions.length === 0) throw new RecordFilterError('A group needs at least one condition.');
    const conditions = (g.conditions as unknown[]).map((node) => {
      if (isGroup(node)) {
        if (depth >= 1) throw new RecordFilterError('Groups can only be nested one level deep.');
        return normaliseGroup(node, depth + 1);
      }
      return normaliseCondition(node);
    });
    return { op: g.op, conditions };
  };

  const filter = normaliseGroup(input, 0);
  if (count === 0) throw new RecordFilterError('A filter needs at least one condition.');
  if (count > MAX_FILTER_CONDITIONS) throw new RecordFilterError(`A filter can have at most ${MAX_FILTER_CONDITIONS} conditions.`);
  return { filter, relationIds };
}

function checkValue(field: MemberField, value: unknown): string {
  const f = field.filter!;
  if (typeof value !== 'string') throw new RecordFilterError(`${field.label}: values must be text.`);
  switch (f.kind) {
    case 'enum':
      if (!f.options?.some((o) => o.value === value)) throw new RecordFilterError(`${field.label}: "${value}" is not a valid option.`);
      return value;
    case 'relation':
      if (!UUID.test(value)) throw new RecordFilterError(`${field.label}: invalid selection.`);
      return value.toLowerCase();
    case 'date': {
      if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new RecordFilterError(`${field.label}: use a YYYY-MM-DD date.`);
      return value;
    }
    case 'text': {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > MAX_TEXT_LENGTH) throw new RecordFilterError(`${field.label}: enter 1–${MAX_TEXT_LENGTH} characters.`);
      return trimmed;
    }
  }
}

export type CompileTarget = { mode: 'qb'; alias: string; paramPrefix: string } | { mode: 'raw'; alias: string; firstParam: number };
export interface CompiledFilter {
  sql: string;
  /** Named parameters (qb mode) or positional values in order (raw mode). */
  named: Record<string, unknown>;
  positional: unknown[];
}

/**
 * Compile a STORED filter for runtime enforcement. Re-validates first; any problem ⇒ `FALSE` (deny everything).
 * `null` filter ⇒ `TRUE` (no restriction beyond the mandatory scope the caller already applies).
 */
export function compileRecordFilter(objectKey: string, stored: unknown, target: CompileTarget): CompiledFilter {
  if (stored === null || stored === undefined) return { sql: 'TRUE', named: {}, positional: [] };
  let filter: FilterGroup;
  try {
    filter = validateRecordFilter(objectKey, stored).filter;
  } catch {
    return { sql: 'FALSE', named: {}, positional: [] };
  }
  const object = memberObject(objectKey)!;
  const named: Record<string, unknown> = {};
  const positional: unknown[] = [];
  let n = 0;
  // CAST(... AS t), never '::t' right after a named parameter (TypeORM would read ':t' as another parameter).
  const bind = (value: unknown, cast: string): string => {
    let placeholder: string;
    if (target.mode === 'qb') {
      const name = `${target.paramPrefix}${n++}`;
      named[name] = value;
      placeholder = `:${name}`;
    } else {
      positional.push(value);
      placeholder = `$${target.firstParam + positional.length - 1}`;
    }
    return cast ? `CAST(${placeholder} AS ${cast})` : placeholder;
  };
  const bindList = (values: string[], cast: string): string => {
    if (target.mode === 'qb') {
      const name = `${target.paramPrefix}${n++}`;
      named[name] = values;
      return `(:...${name})`;
    }
    positional.push(values);
    return `ANY(CAST($${target.firstParam + positional.length - 1} AS ${cast || 'text'}[]))`;
  };

  const renderCondition = (c: FilterCondition): string => {
    const field = object.fields.find((f) => f.key === c.field)!.filter!;
    const col = target.mode === 'qb' ? `${target.alias}.${field.property}` : `${target.alias}.${field.column}`;
    const cast = field.kind === 'relation' ? 'uuid' : field.kind === 'date' ? 'date' : '';
    const lhs = field.kind === 'date' ? `(${col})::date` : field.kind === 'text' ? `lower(${col})` : col;
    switch (c.operator) {
      case 'eq':
        return field.kind === 'text' ? `${lhs} = lower(${bind(c.value, '')})` : `${lhs} = ${bind(c.value, cast)}`;
      case 'neq':
        return field.kind === 'text'
          ? `(${col} IS NULL OR ${lhs} <> lower(${bind(c.value, '')}))`
          : `(${col} IS NULL OR ${lhs} <> ${bind(c.value, cast)})`;
      case 'in':
        return target.mode === 'qb' ? `${lhs} IN ${bindList(c.value as string[], cast)}` : `${lhs} = ${bindList(c.value as string[], cast)}`;
      case 'not_in':
        return target.mode === 'qb'
          ? `(${col} IS NULL OR ${lhs} NOT IN ${bindList(c.value as string[], cast)})`
          : `(${col} IS NULL OR NOT (${lhs} = ${bindList(c.value as string[], cast)}))`;
      case 'gte':
        return `${lhs} >= ${bind(c.value, cast)}`;
      case 'lte':
        return `${lhs} <= ${bind(c.value, cast)}`;
      case 'is_empty':
        return field.kind === 'text' ? `NULLIF(btrim(${col}), '') IS NULL` : `${col} IS NULL`;
      case 'is_not_empty':
        return field.kind === 'text' ? `NULLIF(btrim(${col}), '') IS NOT NULL` : `${col} IS NOT NULL`;
    }
  };
  const renderGroup = (g: FilterGroup): string =>
    `(${g.conditions.map((node) => (isGroup(node) ? renderGroup(node) : renderCondition(node))).join(g.op === 'and' ? ' AND ' : ' OR ')})`;

  return { sql: renderGroup(filter), named, positional };
}

/**
 * Combine several compiled filters (one per role) with AND — multiple roles can only narrow further. In raw mode the
 * caller must have compiled the parts with consecutive `firstParam` offsets (see MemberAccessPolicyService).
 */
export function andCompiled(parts: CompiledFilter[]): CompiledFilter {
  if (parts.length === 0) return { sql: 'FALSE', named: {}, positional: [] };
  return {
    sql: parts.map((p) => `(${p.sql})`).join(' AND '),
    named: Object.assign({}, ...parts.map((p) => p.named)),
    positional: parts.flatMap((p) => p.positional),
  };
}
