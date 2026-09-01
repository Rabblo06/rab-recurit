import type { ReactNode } from 'react';

/**
 * `hideLabel` + `left`: pages with their own tab row (Users, Offers) render
 * it via `left` instead of the default single-tab `label` — showing `label`
 * too would duplicate it. The spacer sits between the left-side tabs and
 * the right-side actions (`children`), not before everything — putting it
 * first would push the tabs themselves to the right along with the actions,
 * which is the exact bug this shape exists to prevent.
 */
export default function ViewBar({ label, hideLabel, left, children }: {
  label: string; count: number; hideLabel?: boolean; left?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="viewbar">
      {!hideLabel && <span className="tab-link active">{label}</span>}
      {left}
      <div className="topbar-spacer"/>
      {children}
      <button className="btn-ghost">Filter</button>
      <button className="btn-ghost">Sort</button>
      <button className="btn-ghost">Options</button>
    </div>
  );
}
