import type { ReactNode } from 'react';

/** Large page title + muted subtitle, rendered at the top of each page's own content — matches the reference design's "Dashboard / Friday, 28 August 2026", "Venues / 0 venues" pattern. */
export default function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-header-title">{title}</h1>
        {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </div>
  );
}
