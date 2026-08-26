import type { CSSProperties, ReactNode } from 'react';

export type EmptyStateVariant =
  | 'records'
  | 'matches'
  | 'tasks'
  | 'widgets'
  | 'timeline'
  | 'inbox'
  | 'notes'
  | 'files'
  | 'access'
  | 'functions'
  | 'notFound'
  | 'serverError';

const EMPTY_STATE_ASSETS: Record<EmptyStateVariant, string> = {
  records: 'no_record',
  matches: 'no_match_record',
  tasks: 'no_task',
  widgets: 'no_widgets',
  timeline: 'empty_timeline',
  inbox: 'empty_inbox',
  notes: 'no_note',
  files: 'no_file',
  access: 'not_shared',
  functions: 'empty_functions',
  notFound: '404',
  serverError: '500',
};

function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <span className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}

export function TableSkeleton({ columns = 6, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="table-skeleton" role="status" aria-label="Loading records">
      <div className="table-skeleton-row table-skeleton-head" style={{ gridTemplateColumns: `repeat(${columns}, minmax(72px, 1fr))` }}>
        {Array.from({ length: columns }, (_, column) => (
          <Skeleton key={column} style={{ width: `${48 + (column % 3) * 14}%`, height: 10 }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div className="table-skeleton-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(72px, 1fr))` }} key={row}>
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className={column === 0 ? 'skeleton-with-avatar' : ''}
              style={{ width: `${58 + ((row + column) % 4) * 9}%`, height: 12 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="list-skeleton" role="status" aria-label="Loading items">
      {Array.from({ length: rows }, (_, row) => (
        <div className="list-skeleton-row" key={row}>
          <Skeleton className="skeleton-avatar" />
          <div className="list-skeleton-copy">
            <Skeleton style={{ width: `${42 + (row % 3) * 12}%`, height: 12 }} />
            <Skeleton style={{ width: `${62 + (row % 2) * 14}%`, height: 9 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="settings-page loading-form" role="status" aria-label="Loading settings">
      {Array.from({ length: sections }, (_, section) => (
        <div className="settings-section" key={section}>
          <Skeleton style={{ width: 120, height: 14 }} />
          <Skeleton style={{ width: '54%', height: 10, marginTop: 9 }} />
          <div className="loading-form-fields">
            <Skeleton style={{ height: 32 }} />
            <Skeleton style={{ height: 32 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="detail-skeleton" role="status" aria-label="Loading details">
      <Skeleton className="detail-skeleton-avatar" />
      <Skeleton style={{ width: '52%', height: 14 }} />
      <Skeleton style={{ width: '74%', height: 10 }} />
      <div className="detail-skeleton-fields">
        {Array.from({ length: 6 }, (_, row) => <Skeleton key={row} style={{ height: 32 }} />)}
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" role="status" aria-label="Loading dashboard">
      <div className="stats-grid">
        {Array.from({ length: 5 }, (_, card) => (
          <div className="stat-card" key={card}>
            <Skeleton style={{ width: '58%', height: 12 }} />
            <Skeleton style={{ width: 54, height: 28 }} />
          </div>
        ))}
      </div>
      <div className="dashboard-skeleton-grid">
        {Array.from({ length: 4 }, (_, chart) => (
          <div className="dashboard-skeleton-chart" key={chart}>
            <Skeleton style={{ width: 110, height: 11 }} />
            <Skeleton className="dashboard-skeleton-plot" />
          </div>
        ))}
      </div>
      <TableSkeleton columns={5} rows={5} />
    </div>
  );
}

export function CalendarSkeleton() {
  return (
    <div className="calendar-skeleton" role="status" aria-label="Loading calendar">
      {Array.from({ length: 42 }, (_, cell) => (
        <div className="calendar-skeleton-cell" key={cell}>
          <Skeleton style={{ width: 18, height: 10 }} />
          {cell % 3 === 0 && <Skeleton style={{ width: '76%', height: 18, marginTop: 12 }} />}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  variant = 'records',
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: EmptyStateVariant;
  compact?: boolean;
}) {
  const asset = EMPTY_STATE_ASSETS[variant];

  return (
    <div className={`empty-state${compact ? ' empty-state-compact' : ''}`}>
      <div className="empty-state-visual" aria-hidden="true">
        <img src={`/images/placeholders/background/${asset}_bg.png`} alt="" draggable={false} className="empty-state-layer empty-state-background empty-state-light" />
        <img src={`/images/placeholders/moving-image/${asset}.png`} alt="" draggable={false} className="empty-state-layer empty-state-foreground empty-state-light" />
        <img src={`/images/placeholders/dark-background/${asset}_bg.png`} alt="" draggable={false} className="empty-state-layer empty-state-background empty-state-dark" />
        <img src={`/images/placeholders/dark-moving-image/${asset}.png`} alt="" draggable={false} className="empty-state-layer empty-state-foreground empty-state-dark" />
      </div>
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
