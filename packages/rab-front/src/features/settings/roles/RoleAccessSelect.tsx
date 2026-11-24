import { useRef, useState } from 'react';
import { IconCheck, IconChevronDown, IconEye, IconEyeOff } from '@tabler/icons-react';
import Popover from '../../../shared/components/Popover';
import type { ReadOverride } from './roleEditorModel';

/** Presentation of the existing read override; never expands the server permission model. */
export default function RoleAccessSelect({ label, value, disabled, canGrant, onChange }: {
  label: string; value: ReadOverride; disabled?: boolean; canGrant: boolean; onChange: (value: ReadOverride) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const labels = { inherit: 'Inherit', grant: 'See', deny: 'No access' };
  return <>
    <button ref={anchor} type="button" className="role-access-trigger" disabled={disabled} aria-label={`${label}: ${labels[value]}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      {value === 'deny' ? <IconEyeOff size={13} /> : <IconEye size={13} />}{labels[value]}<IconChevronDown size={12} />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} onEscape={() => { setOpen(false); anchor.current?.focus(); return true; }} anchorRef={anchor} minWidth={210} role="dialog" className="role-access-menu">
      <div role="group" aria-label={label}>
        {(['deny', 'grant', ...(label === 'All objects access' ? [] : ['inherit'])] as ReadOverride[]).map(option => <button key={option} type="button" className="dropdown-item" disabled={option === 'grant' && !canGrant} onClick={() => { onChange(option); setOpen(false); anchor.current?.focus(); }}>
          {labels[option]}{value === option && <IconCheck size={13} />}
        </button>)}
        <button type="button" className="dropdown-item" disabled>Edit · unavailable</button>
        <button type="button" className="dropdown-item" disabled>All · unavailable</button>
      </div>
    </Popover>
  </>;
}
