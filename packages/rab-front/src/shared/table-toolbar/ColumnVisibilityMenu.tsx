import type { ColumnConfig } from './types';

/**
 * Presentation only — toggling a column here never changes what the backend
 * query returns or what any other part of the app can see; it only hides a
 * `<td>` in this one table. A non-`hideable` column (selection checkbox, row
 * actions) renders its checkbox permanently checked and disabled, never
 * removable — hiding it would break the page's own primary actions.
 */
export default function ColumnVisibilityMenu({
  columns,
  isVisible,
  onToggle,
  onReset,
}: {
  columns: ColumnConfig[];
  isVisible: (key: string) => boolean;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  return (
    <div>
      <div className="rab-popover-title">Columns</div>
      {columns.map((col) => {
        const visible = col.hideable ? isVisible(col.key) : true;
        return (
          <label key={col.key} className={`column-toggle-row${col.hideable ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={visible}
              disabled={!col.hideable}
              onChange={() => col.hideable && onToggle(col.key)}
            />
            {col.label}
          </label>
        );
      })}
      <div className="options-reset-row">
        <button type="button" onClick={onReset}>Reset columns</button>
      </div>
    </div>
  );
}
