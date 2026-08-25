import type { ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';

export default function TableFooter({ count, children }: { count: number; children?: ReactNode }) {
  return (
    <div className="table-footer">
      <button className="btn-ghost" style={{ color: 'var(--font-tertiary)', fontWeight: 400 }}>
        Calculate <IconChevronDown size={12}/>
      </button>
      <div style={{ flex: 1 }}/>
      {children}
      <span>Count all</span>
      <span style={{ fontWeight: 600, color: 'var(--font-primary)' }}>{count}</span>
    </div>
  );
}
