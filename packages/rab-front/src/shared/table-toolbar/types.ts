/**
 * One shared engine (`TableToolbar` + `FilterPopover`/`SortPopover`/
 * `ColumnVisibilityMenu`), configured per page via a plain `TableToolbarConfig`
 * object — see `rab-workforce-architecture.md`-style feature docs for why:
 * six near-identical bespoke toolbars would mean six places to fix the same
 * popover-clipping or keyboard bug. Every filter maps to a concrete, typed
 * backend query param (never a generic `{field,operator,value}` string sent
 * to the server) — "operator" is implicit in which field/type is used
 * (`select` → equality, `dateRange`/`numberRange` → between), so the backend
 * DTO can validate each param with an ordinary `class-validator` decorator
 * instead of parsing an arbitrary operator string from the client.
 */

export type FilterFieldType = 'select' | 'date' | 'dateRange' | 'text' | 'numberRange';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterFieldConfig {
  /** Query param name for 'select' | 'date' | 'text'. For 'dateRange'/'numberRange', the base — actual params are `${key}From`/`${key}To`. */
  key: string;
  label: string;
  type: FilterFieldType;
  /** Required for type 'select' — the actual domain enum values, never invented ones. */
  options?: FilterOption[];
  /** Optional placeholder for 'text'/'numberRange' inputs. */
  placeholder?: string;
}

export interface SortOptionConfig {
  /** Query param value sent as `sort=<key>` — must match the backend's allowlist exactly. */
  key: string;
  label: string;
  /** Directions this field actually supports — some (e.g. "Newest first") only make sense one way. */
  directions: Array<'asc' | 'desc'>;
  directionLabels?: { asc: string; desc: string };
}

export interface ColumnConfig {
  key: string;
  label: string;
  /** false for a column that must never be hidden (selection checkbox, row actions). */
  hideable: boolean;
}

export interface TableToolbarConfig {
  /** localStorage key for column-visibility persistence — must be unique per page/table. */
  storageKey: string;
  filters: FilterFieldConfig[];
  sorts: SortOptionConfig[];
  columns: ColumnConfig[];
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  /**
   * Applied only when the URL has no value for that key at all — preserves
   * a page's existing default view (e.g. Venues showing only active venues
   * today, with no way to see archived ones) rather than silently changing
   * to "no filter = show everything" the moment this shared engine replaces
   * a page's old always-on client-side filter. "Clear all" still clears
   * these too — a user can always explicitly ask for the unfiltered set via
   * "Any" on that field.
   */
  defaultFilters?: ActiveFilters;
}

/** Active filter values, keyed by FilterFieldConfig.key (or `${key}From`/`${key}To` for range types). */
export type ActiveFilters = Record<string, string>;

export interface SortState {
  sort: string;
  direction: 'asc' | 'desc';
}
