import { useEffect, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import type { ActiveFilters, FilterFieldConfig } from './types';

function FilterValueControl({
  field,
  value,
  onChange,
}: {
  field: FilterFieldConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.label}>
        <option value="">Any</option>
        {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (field.type === 'date') {
    return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.label} />;
  }
  return (
    <input
      type="text"
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-label={field.label}
    />
  );
}

function RangeValueControl({
  field,
  from,
  to,
  onChangeFrom,
  onChangeTo,
}: {
  field: FilterFieldConfig;
  from: string;
  to: string;
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
}) {
  const inputType = field.type === 'dateRange' ? 'date' : 'number';
  return (
    <>
      <input type={inputType} value={from} onChange={(e) => onChangeFrom(e.target.value)} aria-label={`${field.label} from`} style={{ width: 90 }} />
      <span style={{ color: 'var(--font-tertiary)', fontSize: 11 }}>to</span>
      <input type={inputType} value={to} onChange={(e) => onChangeTo(e.target.value)} aria-label={`${field.label} to`} style={{ width: 90 }} />
    </>
  );
}

/**
 * "+ Add filter" only offers fields with no active value yet — a field
 * already showing a row is edited/removed there, not re-added. Every value
 * change calls `onChange` immediately with the full next `ActiveFilters` map
 * (the caller — `useTableQueryState` — owns debouncing/URL-sync), matching
 * how the reference Users flow ("choose Status → choose Active → table
 * updates") is expected to behave: no separate "Apply" step.
 */
export default function FilterPopover({
  fields,
  active,
  onChange,
}: {
  fields: FilterFieldConfig[];
  active: ActiveFilters;
  onChange: (next: ActiveFilters) => void;
}) {
  const isRangeField = (f: FilterFieldConfig) => f.type === 'dateRange' || f.type === 'numberRange';
  const fieldHasValue = (f: FilterFieldConfig) =>
    isRangeField(f) ? Boolean(active[`${f.key}From`] || active[`${f.key}To`]) : Boolean(active[f.key]);

  const [extraRows, setExtraRows] = useState<string[]>([]);
  // A field shows a row if it has a value OR the user just added it blank.
  const visibleFields = fields.filter((f) => fieldHasValue(f) || extraRows.includes(f.key));
  const availableToAdd = fields.filter((f) => !fieldHasValue(f) && !extraRows.includes(f.key));

  useEffect(() => {
    // Once a just-added blank row gets a real value, it's driven by
    // `active` from here on — stop tracking it as an "extra" row so it
    // doesn't linger duplicated if `active` is ever reset externally.
    setExtraRows((prev) => prev.filter((k) => !fields.find((f) => f.key === k && fieldHasValue(f))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const setValue = (key: string, value: string) => onChange({ ...active, [key]: value });
  const setRangeValue = (baseKey: string, part: 'From' | 'To', value: string) =>
    onChange({ ...active, [`${baseKey}${part}`]: value });

  const removeField = (field: FilterFieldConfig) => {
    setExtraRows((prev) => prev.filter((k) => k !== field.key));
    if (isRangeField(field)) {
      const next = { ...active };
      delete next[`${field.key}From`];
      delete next[`${field.key}To`];
      onChange(next);
    } else {
      const next = { ...active };
      delete next[field.key];
      onChange(next);
    }
  };

  const hasAnyValue = fields.some(fieldHasValue);

  return (
    <div>
      <div className="rab-popover-title">Filter</div>
      {visibleFields.length === 0 && <div className="rab-popover-empty">No filters applied.</div>}
      {visibleFields.map((field) => (
        <div className="filter-row" key={field.key}>
          <span className="filter-field-label">{field.label}</span>
          {isRangeField(field) ? (
            <RangeValueControl
              field={field}
              from={active[`${field.key}From`] ?? ''}
              to={active[`${field.key}To`] ?? ''}
              onChangeFrom={(v) => setRangeValue(field.key, 'From', v)}
              onChangeTo={(v) => setRangeValue(field.key, 'To', v)}
            />
          ) : (
            <FilterValueControl field={field} value={active[field.key] ?? ''} onChange={(v) => setValue(field.key, v)} />
          )}
          <button type="button" className="filter-row-remove" aria-label={`Remove ${field.label} filter`} onClick={() => removeField(field)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
      {availableToAdd.length > 0 && (
        <div className="filter-add-row">
          <select
            value=""
            aria-label="Add filter"
            onChange={(e) => {
              if (e.target.value) setExtraRows((prev) => [...prev, e.target.value]);
            }}
          >
            <option value="">+ Add filter</option>
            {availableToAdd.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
      )}
      {hasAnyValue && (
        <div className="filter-popover-footer">
          <button type="button" className="filter-clear-all" onClick={() => { setExtraRows([]); onChange({}); }}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
