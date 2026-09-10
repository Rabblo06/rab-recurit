import { useRef, useState } from 'react';
import { IconSearch } from '@tabler/icons-react';
import Popover from '../components/Popover';
import ColumnVisibilityMenu from './ColumnVisibilityMenu';
import FilterPopover from './FilterPopover';
import SortPopover from './SortPopover';
import type { ActiveFilters, SortState, TableToolbarConfig } from './types';
import { useColumnVisibility } from './useColumnVisibility';

export function TableSearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="toolbar-search">
      <IconSearch size={14} />
      <input placeholder="Search…" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

type OpenPopover = 'filter' | 'sort' | 'options' | null;

/**
 * The `[Filter] [Sort] [Options]` cluster — one shared implementation,
 * configured per page via `TableToolbarConfig`. Deliberately does NOT own
 * the whole toolbar row: every existing page already places its own
 * create/bulk-action buttons (New Staff, Send Email, New Venue, …) inside
 * the same `.list-toolbar-actions` container, before these three — a caller
 * renders this alongside those, not instead of them (see each page's own
 * usage). Owns only which popover is open and the column-visibility
 * preference (both purely presentational); the actual query state
 * (`search`/`filters`/`sort`) lives in the caller via `useTableQueryState`.
 */
export default function TableViewControls({
  config,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  activeFilterCount,
  columnVisibility,
}: {
  config: TableToolbarConfig;
  filters: ActiveFilters;
  onFiltersChange: (next: ActiveFilters) => void;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  activeFilterCount: number;
  /** Return value of `useColumnVisibility(config.storageKey, config.columns)` — lifted to the caller so the table body can read `isVisible` too. */
  columnVisibility: ReturnType<typeof useColumnVisibility>;
}) {
  const [open, setOpen] = useState<OpenPopover>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);

  const activeSortOption = config.sorts.find((s) => s.key === sort.sort);

  return (
    <>
      {config.filters.length > 0 && (
        <button
          ref={filterRef}
          type="button"
          className={`btn btn-outline toolbar-btn${open === 'filter' ? ' active' : ''}`}
          onClick={() => setOpen(open === 'filter' ? null : 'filter')}
        >
          Filter
          {activeFilterCount > 0 && <span className="toolbar-btn-count">{activeFilterCount}</span>}
        </button>
      )}
      {config.sorts.length > 0 && (
        <button
          ref={sortRef}
          type="button"
          className={`btn btn-outline toolbar-btn${open === 'sort' ? ' active' : ''}`}
          onClick={() => setOpen(open === 'sort' ? null : 'sort')}
        >
          Sort{activeSortOption ? `: ${activeSortOption.label}` : ''}
        </button>
      )}
      <button
        ref={optionsRef}
        type="button"
        className={`btn btn-outline toolbar-btn${open === 'options' ? ' active' : ''}`}
        onClick={() => setOpen(open === 'options' ? null : 'options')}
      >
        Options
      </button>

      <Popover open={open === 'filter'} onClose={() => setOpen(null)} anchorRef={filterRef}>
        <FilterPopover fields={config.filters} active={filters} onChange={onFiltersChange} />
      </Popover>
      <Popover open={open === 'sort'} onClose={() => setOpen(null)} anchorRef={sortRef}>
        <SortPopover options={config.sorts} active={sort} onChange={onSortChange} />
      </Popover>
      <Popover open={open === 'options'} onClose={() => setOpen(null)} anchorRef={optionsRef} align="end">
        <ColumnVisibilityMenu
          columns={config.columns}
          isVisible={columnVisibility.isVisible}
          onToggle={columnVisibility.toggle}
          onReset={columnVisibility.reset}
        />
      </Popover>
    </>
  );
}
