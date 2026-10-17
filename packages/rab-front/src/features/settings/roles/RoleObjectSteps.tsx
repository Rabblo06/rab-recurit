import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight, IconLock, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { RoleIcon, useRoleEditor } from './RoleEditorLayout';
import {
  countConditions, effectiveRead, FieldMeta, FilterCondition, FilterGroup, FilterOperator, isFieldVisible, MAX_FILTER_CONDITIONS,
  ObjectKey, ObjectMeta, ObjectRule, OPERATOR_LABELS, ReadOverride, roleApi,
} from './roleEditorModel';

const isGroup = (node: FilterCondition | FilterGroup): node is FilterGroup => 'conditions' in node;

/** "Add rule" step 1: pick the object the rule applies to (real, server-defined Crewflow objects only). */
export function SelectObjectStep() {
  const { metadata, draft, setDraft, basePath, readOnly } = useRoleEditor();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  if (readOnly) return <Navigate to={basePath} replace />;
  const objects = metadata.objects.filter((o) => `${o.label} ${o.labelPlural} ${o.description}`.toLowerCase().includes(search.trim().toLowerCase()));

  const choose = (key: ObjectKey) => {
    if (!draft.objects.some((o) => o.object === key)) {
      setDraft((d) => ({ ...d, objects: [...d.objects, { object: key, read: 'inherit', fields: {}, recordFilter: null }] }));
    }
    navigate(`${basePath}/objects/${key}`);
  };

  return (
    <section className="role-section role-step">
      <h3 className="role-step-title">1. Select an object</h3>
      <div className="role-search">
        <IconSearch size={13} aria-hidden="true" />
        <input aria-label="Search an object" placeholder="Search an object" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <h4 className="role-subheading">Standard</h4>
      <p className="role-section-description">All the standard objects</p>
      {objects.length === 0 ? (
        <p className="role-empty">No objects match your search.</p>
      ) : (
        <div className="role-object-grid">
          {objects.map((object) => {
            const configured = draft.objects.some((o) => o.object === object.key);
            return (
              <button type="button" key={object.key} className="role-object-chip" onClick={() => choose(object.key)} title={object.description}>
                <RoleIcon name={object.icon} size={14} />
                <span className="role-object-chip-name">{object.labelPlural}</span>
                {configured && <span className="role-object-chip-badge">Rule</span>}
                <IconChevronRight size={13} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      <div className="role-step-footer">
        <Link className="btn btn-outline" to={basePath}>Back</Link>
      </div>
    </section>
  );
}

/** "Add rule" step 2: object-level See, field visibility and record-level filters for one object. */
export function ObjectPermissionsStep() {
  const { objectKey } = useParams();
  const { metadata, draft, setDraft, basePath, readOnly } = useRoleEditor();
  const navigate = useNavigate();
  const object = metadata.objects.find((o) => o.key === objectKey);
  const rule = draft.objects.find((o) => o.object === objectKey);

  // A deep link straight to step 2 starts an (inheriting) rule, exactly as choosing the object in step 1 would.
  useEffect(() => {
    if (object && !rule && !readOnly) {
      setDraft((d) => (d.objects.some((o) => o.object === object.key) ? d : { ...d, objects: [...d.objects, { object: object.key, read: 'inherit', fields: {}, recordFilter: null }] }));
    }
  }, [object, rule, readOnly, setDraft]);

  if (!object || readOnly) return <Navigate to={basePath} replace />;
  if (!rule) return null;

  const updateRule = (update: (rule: ObjectRule) => ObjectRule) =>
    setDraft((d) => ({ ...d, objects: d.objects.map((o) => (o.object === object.key ? update(o) : o)) }));
  const removeRule = () => {
    setDraft((d) => ({ ...d, objects: d.objects.filter((o) => o.object !== object.key) }));
    navigate(basePath);
  };
  const canSee = effectiveRead(draft, object.key);
  const name = object.labelPlural;

  return (
    <section className="role-section role-step">
      <div className="role-step-heading">
        <h3 className="role-step-title">2. Set {name} permissions</h3>
        <Link className="btn btn-dark role-step-finish" to={basePath}>Finish</Link>
      </div>

      <h4 className="role-subheading">Object-Level</h4>
      <p className="role-section-description">Actions users can perform on this object</p>
      <ReadRow object={object} value={rule.read} inherited={draft.readAllObjects} onChange={(read) => updateRule((r) => ({ ...r, read }))} />
      {(['Edit', 'Delete', 'Destroy'] as const).map((action) => (
        <div key={action} className="role-row" title={object.unsupportedReason}>
          <span className="role-row-label">
            {action} {name} · <span className="cell-muted">Not available</span>
          </span>
          <span className="role-row-control">
            <input type="checkbox" aria-label={`${action} ${name} (not available)`} checked={false} disabled readOnly />
          </span>
        </div>
      ))}
      <p className="role-footnote"><IconLock size={11} aria-hidden="true" /> {object.unsupportedReason}</p>

      {!canSee && (
        <p className="role-notice-inline" role="note">
          Members with this role can’t see {name} right now. Field and record rules below take effect once See is on.
        </p>
      )}

      <h4 className="role-subheading">Fields Permissions</h4>
      <p className="role-section-description">Ability to interact with this object’s fields.</p>
      <FieldsTable object={object} rule={rule} onChange={(changes) => updateRule((r) => ({ ...r, fields: { ...r.fields, ...changes } }))} />

      <h4 className="role-subheading">Record-level</h4>
      <p className="role-section-description">Ability to filter the records a user can interact with. With no conditions, members see every {object.label.toLowerCase()} record they’re allowed to.</p>
      <RecordFilterBuilder object={object} value={rule.recordFilter} onChange={(recordFilter) => updateRule((r) => ({ ...r, recordFilter }))} />

      <div className="role-step-footer">
        <button type="button" className="btn btn-outline role-delete" onClick={removeRule}><IconTrash size={13} />Remove rule</button>
        <span className="role-step-footer-spacer" />
        <Link className="btn btn-outline" to={`${basePath}/objects`}>Back</Link>
      </div>
    </section>
  );
}

/**
 * See-records row. The checkbox shows the EFFECTIVE result; ticking/unticking sets an explicit grant/deny for this
 * object, and "Follow All Objects" clears the override. Granting is disabled when the editor can't see the object.
 */
function ReadRow({ object, value, inherited, onChange }: { object: ObjectMeta; value: ReadOverride; inherited: boolean; onChange: (value: ReadOverride) => void }) {
  const effective = value === 'grant' || (value === 'inherit' && inherited);
  const blocked = !effective && !object.grantable;
  const source = value === 'inherit' ? 'follows All Objects' : value === 'grant' ? 'set here' : 'denied here';
  return (
    <div className="role-row">
      <span className="role-row-label">
        See {object.labelPlural} · <span className="cell-muted">This role can see {effective ? 'all records' : 'no records'} ({source})</span>
        {value !== 'inherit' && (
          <button type="button" className="role-link-button" onClick={() => onChange('inherit')}>Follow All Objects</button>
        )}
        {blocked && <span className="role-row-hint">You can’t grant {object.labelPlural} because you can’t see them yourself.</span>}
      </span>
      <span className="role-row-control">
        <input
          type="checkbox"
          aria-label={`See ${object.labelPlural}`}
          checked={effective}
          disabled={blocked}
          onChange={(e) => onChange(e.target.checked ? 'grant' : 'deny')}
        />
      </span>
    </div>
  );
}

function FieldsTable({ object, rule, onChange }: { object: ObjectMeta; rule: ObjectRule; onChange: (changes: Record<string, 'visible' | 'hidden'>) => void }) {
  const [search, setSearch] = useState('');
  const [ascending, setAscending] = useState(true);
  const fields = object.fields
    .filter((f) => f.label.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => (ascending ? 1 : -1) * a.label.localeCompare(b.label));
  // "All" toggles every field this editor may change: never locked fields, and never reveals a field the editor can't grant.
  const togglable = object.fields.filter((f) => !f.locked);
  const allVisible = togglable.every((f) => isFieldVisible(rule, f));
  const setAll = (visible: boolean) =>
    onChange(Object.fromEntries(togglable.filter((f) => !visible || f.grantable || isFieldVisible(rule, f)).map((f) => [f.key, visible ? 'visible' : 'hidden'])));

  return (
    <>
      <div className="role-search">
        <IconSearch size={13} aria-hidden="true" />
        <input aria-label="Search a field" placeholder="Search a field..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="members-table-wrap">
        <table className="table role-fields-table">
          <thead>
            <tr>
              <th>
                <button type="button" className="role-sort" onClick={() => setAscending((v) => !v)} aria-label={`Sort by name ${ascending ? 'descending' : 'ascending'}`}>
                  Name {ascending ? '↑' : '↓'}
                </button>
              </th>
              <th>Data type</th>
              <th>See</th>
              <th>Edit</th>
            </tr>
          </thead>
          <tbody>
            {!search && (
              <tr className="role-fields-all">
                <td>All</td>
                <td />
                <td><input type="checkbox" aria-label="See all fields" checked={allVisible} onChange={(e) => setAll(e.target.checked)} /></td>
                <td><input type="checkbox" aria-label="Edit all fields (not available)" checked={false} disabled readOnly /></td>
              </tr>
            )}
            {fields.map((field) => {
              const visible = isFieldVisible(rule, field);
              const blocked = !field.locked && !visible && !field.grantable;
              const title = field.locked ? 'Always visible to anyone who can see this object.' : blocked ? 'You can’t reveal a field you can’t see yourself.' : undefined;
              return (
                <tr key={field.key}>
                  <td>
                    {field.label}
                    {field.sensitive && <span className="role-field-tag">Sensitive</span>}
                    {field.locked && <IconLock size={11} className="role-field-lock" aria-label="Always visible" />}
                  </td>
                  <td className="cell-muted">{dataTypeLabel(field)}</td>
                  <td title={title}>
                    <input type="checkbox" aria-label={`See ${field.label}`} checked={visible} disabled={field.locked || blocked} onChange={(e) => onChange({ [field.key]: e.target.checked ? 'visible' : 'hidden' })} />
                  </td>
                  <td title={object.unsupportedReason}>
                    <input type="checkbox" aria-label={`Edit ${field.label} (not available)`} checked={false} disabled readOnly />
                  </td>
                </tr>
              );
            })}
            {fields.length === 0 && (
              <tr><td colSpan={4} className="cell-muted">No fields match your search.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function dataTypeLabel(field: FieldMeta): string {
  const labels: Record<string, string> = {
    text: 'Text', email: 'Email', phone: 'Phone', number: 'Number', money: 'Currency', date: 'Date', datetime: 'Date & time',
    enum: 'Select', relation: 'Relation', boolean: 'Yes / No', json: 'Structured', list: 'List',
  };
  return labels[field.dataType] ?? field.dataType;
}

// ── Record-level filter builder ─────────────────────────────────────────────────────────────────────────────

function RecordFilterBuilder({ object, value, onChange }: { object: ObjectMeta; value: FilterGroup | null; onChange: (value: FilterGroup | null) => void }) {
  const filterable = object.fields.filter((f) => f.filter);
  const needsVenues = filterable.some((f) => f.filter?.relation === 'venue');
  const needsJobRoles = filterable.some((f) => f.filter?.relation === 'job_role');
  const venues = useQuery({ queryKey: ['roles', 'filter-options', 'venues'], queryFn: roleApi.venues, enabled: needsVenues, staleTime: 60_000 });
  const jobRoles = useQuery({ queryKey: ['roles', 'filter-options', 'job-roles'], queryFn: roleApi.jobRoles, enabled: needsJobRoles, staleTime: 60_000 });
  const relationOptions = useMemo(
    () => ({
      venue: (venues.data ?? []).map((v) => ({ value: v.id, label: v.name })),
      job_role: (jobRoles.data ?? []).map((j) => ({ value: j.id, label: j.name })),
    }),
    [venues.data, jobRoles.data],
  );

  if (filterable.length === 0) return <p className="role-empty">{object.labelPlural} can’t be filtered by record.</p>;

  const group: FilterGroup = value ?? { op: 'and', conditions: [] };
  const total = countConditions(value);
  const newCondition = (): FilterCondition => {
    const field = filterable[0]!;
    const operator = field.filter!.operators[0]!;
    return { field: field.key, operator, value: defaultValue(field, operator) };
  };
  const commit = (next: FilterGroup) => onChange(countConditions(next) === 0 ? null : next);

  return (
    <div className="role-filter">
      <GroupEditor
        group={group}
        depth={0}
        fields={filterable}
        relationOptions={relationOptions}
        canAdd={total < MAX_FILTER_CONDITIONS}
        newCondition={newCondition}
        onChange={commit}
      />
      {total === 0 && (
        <button type="button" className="btn btn-outline" onClick={() => commit({ op: 'and', conditions: [newCondition()] })}>
          <IconPlus size={14} />Add filter
        </button>
      )}
      {total >= MAX_FILTER_CONDITIONS && <p className="role-footnote">A role can have at most {MAX_FILTER_CONDITIONS} conditions per object.</p>}
    </div>
  );
}

type RelationOptions = Record<'venue' | 'job_role', Array<{ value: string; label: string }>>;

function GroupEditor({
  group, depth, fields, relationOptions, canAdd, newCondition, onChange, onRemove,
}: {
  group: FilterGroup;
  depth: number;
  fields: FieldMeta[];
  relationOptions: RelationOptions;
  canAdd: boolean;
  newCondition: () => FilterCondition;
  onChange: (group: FilterGroup) => void;
  onRemove?: () => void;
}) {
  if (group.conditions.length === 0 && depth === 0) return null;
  const replaceAt = (index: number, node: FilterCondition | FilterGroup | null) => {
    const conditions = [...group.conditions];
    if (node === null || (isGroup(node) && node.conditions.length === 0)) conditions.splice(index, 1);
    else conditions[index] = node;
    onChange({ ...group, conditions });
  };
  return (
    <div className={depth === 0 ? 'role-filter-group' : 'role-filter-group role-filter-subgroup'}>
      <div className="role-filter-group-head">
        <span>Show records matching</span>
        <select className="form-input" aria-label="Match all or any" value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as 'and' | 'or' })}>
          <option value="and">all of</option>
          <option value="or">any of</option>
        </select>
        <span>these conditions</span>
        {onRemove && <button type="button" className="btn-icon" aria-label="Remove group" onClick={onRemove}><IconTrash size={14} /></button>}
      </div>
      {group.conditions.map((node, index) =>
        isGroup(node) ? (
          <GroupEditor
            key={index}
            group={node}
            depth={depth + 1}
            fields={fields}
            relationOptions={relationOptions}
            canAdd={canAdd}
            newCondition={newCondition}
            onChange={(next) => replaceAt(index, next)}
            onRemove={() => replaceAt(index, null)}
          />
        ) : (
          <ConditionEditor key={index} condition={node} fields={fields} relationOptions={relationOptions} onChange={(next) => replaceAt(index, next)} onRemove={() => replaceAt(index, null)} />
        ),
      )}
      <div className="role-filter-add">
        <button type="button" className="btn btn-outline" disabled={!canAdd} onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition()] })}>
          <IconPlus size={14} />Add condition
        </button>
        {depth === 0 && (
          <button
            type="button"
            className="btn btn-outline"
            disabled={!canAdd}
            onClick={() => onChange({ ...group, conditions: [...group.conditions, { op: group.op === 'and' ? 'or' : 'and', conditions: [newCondition()] }] })}
          >
            <IconPlus size={14} />Add group
          </button>
        )}
      </div>
    </div>
  );
}

function defaultValue(field: FieldMeta, operator: FilterOperator): string | string[] | undefined {
  if (operator === 'is_empty' || operator === 'is_not_empty') return undefined;
  if (operator === 'in' || operator === 'not_in') return [];
  return field.filter?.kind === 'enum' ? field.filter.options?.[0]?.value ?? '' : '';
}

function conditionProblem(condition: FilterCondition): string | null {
  if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') return null;
  if (Array.isArray(condition.value)) return condition.value.length ? null : 'Choose at least one value.';
  return condition.value && String(condition.value).trim() ? null : 'Enter a value.';
}

function ConditionEditor({
  condition, fields, relationOptions, onChange, onRemove,
}: {
  condition: FilterCondition;
  fields: FieldMeta[];
  relationOptions: RelationOptions;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.key === condition.field) ?? fields[0]!;
  const filter = field.filter!;
  const options = filter.kind === 'relation' ? relationOptions[filter.relation!] : filter.options ?? [];
  const problem = conditionProblem(condition);
  const multi = condition.operator === 'in' || condition.operator === 'not_in';

  return (
    <div className="role-filter-condition">
      <select
        className="form-input"
        aria-label="Field"
        value={field.key}
        onChange={(e) => {
          const next = fields.find((f) => f.key === e.target.value)!;
          const operator = next.filter!.operators[0]!;
          onChange({ field: next.key, operator, value: defaultValue(next, operator) });
        }}
      >
        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      <select
        className="form-input"
        aria-label="Operator"
        value={condition.operator}
        onChange={(e) => {
          const operator = e.target.value as FilterOperator;
          onChange({ field: field.key, operator, value: defaultValue(field, operator) });
        }}
      >
        {filter.operators.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      <span className="role-filter-value">
        {condition.operator === 'is_empty' || condition.operator === 'is_not_empty' ? null : multi ? (
          <span className="role-filter-chips" role="group" aria-label="Values">
            {options.length === 0 && <span className="cell-muted">No options available.</span>}
            {options.map((o) => {
              const selected = (condition.value as string[] | undefined)?.includes(o.value) ?? false;
              return (
                <label key={o.value} className={selected ? 'role-chip selected' : 'role-chip'}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => {
                      const current = (condition.value as string[] | undefined) ?? [];
                      onChange({ ...condition, value: e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value) });
                    }}
                  />
                  {o.label}
                </label>
              );
            })}
          </span>
        ) : filter.kind === 'enum' || filter.kind === 'relation' ? (
          <select className="form-input" aria-label="Value" value={(condition.value as string) ?? ''} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
            <option value="" disabled>Choose…</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input
            className="form-input"
            aria-label="Value"
            type={filter.kind === 'date' ? 'date' : 'text'}
            maxLength={100}
            value={(condition.value as string) ?? ''}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        )}
      </span>
      <button type="button" className="btn-icon" aria-label="Remove condition" onClick={onRemove}><IconTrash size={14} /></button>
      {problem && <span className="role-filter-problem feedback-error">{problem}</span>}
    </div>
  );
}
