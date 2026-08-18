import type { ReactNode } from 'react';
import { IconMenu2, IconChevronDown } from '@tabler/icons-react';

export default function ViewBar({ label, count, children }: { label: string; count: number; children?: ReactNode }) {
  return (
    <div className="viewbar">
      <div className="viewbar-view">
        <IconMenu2 size={14}/>
        {label}
        <span className="viewbar-count">· {count}</span>
        <IconChevronDown size={13} color="#999"/>
      </div>
      <div className="topbar-spacer"/>
      {children}
      <button className="btn-ghost">Filter</button>
      <button className="btn-ghost">Sort</button>
      <button className="btn-ghost">Options</button>
    </div>
  );
}
