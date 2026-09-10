import { IconCheck } from '@tabler/icons-react';
import type { SortOptionConfig, SortState } from './types';

export default function SortPopover({
  options,
  active,
  onChange,
}: {
  options: SortOptionConfig[];
  active: SortState;
  onChange: (next: SortState) => void;
}) {
  const activeOption = options.find((o) => o.key === active.sort);

  return (
    <div>
      <div className="rab-popover-title">Sort</div>
      {options.map((option) => {
        const isActive = option.key === active.sort;
        return (
          <button
            key={option.key}
            type="button"
            className={`sort-option${isActive ? ' active' : ''}`}
            onClick={() => onChange({ sort: option.key, direction: option.directions[0] ?? 'asc' })}
          >
            {option.label}
            {isActive && <IconCheck size={14} />}
          </button>
        );
      })}
      {activeOption && activeOption.directions.length > 1 && (
        <div className="sort-direction-toggle">
          {activeOption.directions.map((dir) => (
            <button
              key={dir}
              type="button"
              className={active.direction === dir ? 'active' : ''}
              onClick={() => onChange({ sort: active.sort, direction: dir })}
            >
              {activeOption.directionLabels?.[dir] ?? (dir === 'asc' ? 'Ascending' : 'Descending')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
