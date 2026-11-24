import { IconArrowUpRight } from '@tabler/icons-react';
import './record-open-action.css';

/** Presentation-only shortcut to a record's existing view. */
export default function RecordOpenAction({ label, onOpen }: { label: string; onOpen: () => void }) {
  return <button type="button" className="record-open-action" aria-label={label} title={label} onClick={event => { event.stopPropagation(); onOpen(); }}><IconArrowUpRight size={14} stroke={1.7} aria-hidden="true"/></button>;
}
