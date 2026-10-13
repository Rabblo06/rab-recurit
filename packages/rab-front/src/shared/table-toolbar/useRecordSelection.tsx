import { useState } from 'react';

/** Local row highlighting, scoped to the records currently displayed. No mutation is implicit. */
export function useRecordSelection(ids: string[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const count = ids.filter(id => selected.has(id)).length;
  const allSelected = ids.length > 0 && count === ids.length;
  const allCheckbox = <input type="checkbox" aria-label="Select all visible records" disabled={!ids.length} checked={allSelected} ref={el=>{if(el)el.indeterminate=count>0&&!allSelected;}} onChange={()=>setSelected(allSelected ? new Set() : new Set(ids))} />;
  const checkbox = (id:string, label:string) => <input type="checkbox" aria-label={`Select ${label}`} checked={selected.has(id)} onChange={()=>setSelected(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;})} />;
  const summary = count>0 ? <span className="selection-summary" role="status">{count} selected <button type="button" onClick={()=>setSelected(new Set())}>Clear selection</button></span> : null;
  return {allCheckbox,checkbox,summary,isSelected:(id:string)=>selected.has(id)};
}
