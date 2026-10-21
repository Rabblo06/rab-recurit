import { useState } from 'react';
import BulkActionBar, { type BulkAction } from '../components/BulkActionBar';

/**
 * Local row highlighting, scoped to the records currently displayed. No mutation is implicit: a page that offers bulk
 * actions passes `actions` (built from the visible selected ids) and keeps its own permission and lifecycle checks.
 */
export function useRecordSelection(ids: string[], options: { actions?: (selectedIds: string[]) => BulkAction[] } = {}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectedIds = ids.filter(id => selected.has(id));
  const count = selectedIds.length;
  const allSelected = ids.length > 0 && count === ids.length;
  const clear = () => setSelected(new Set());
  const allCheckbox = <input type="checkbox" aria-label="Select all visible records" disabled={!ids.length} checked={allSelected} ref={el=>{if(el)el.indeterminate=count>0&&!allSelected;}} onChange={()=>setSelected(allSelected ? new Set() : new Set(ids))} />;
  const checkbox = (id:string, label:string) => <input type="checkbox" aria-label={`Select ${label}`} checked={selected.has(id)} onChange={()=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;})} />;
  // Floating bar (portal) instead of an inline toolbar summary; it carries actions only when the page supplies them.
  const summary = <BulkActionBar count={count} onClear={clear} actions={options.actions?.(selectedIds) ?? []} />;
  return {allCheckbox,checkbox,summary,isSelected:(id:string)=>selected.has(id),selectedIds,clear};
}
