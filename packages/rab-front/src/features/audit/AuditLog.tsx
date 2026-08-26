import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconChevronLeft, IconChevronRight, IconCalendar, IconUser,
  IconBolt, IconTarget, IconNotes, IconSearch,
} from '@tabler/icons-react';
import { api } from '../../shared/api';
import ViewBar from '../../shared/components/ViewBar';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';

const PAGE_SIZE = 50;

const actionColors: Record<string, { bg: string; color: string }> = {
  created: { bg: '#d9f0de', color: '#2a8e44' },
  updated: { bg: '#dbe9fe', color: '#1961ed' },
  deleted: { bg: '#fdded9', color: '#d93025' },
  cancelled: { bg: '#fdded9', color: '#d93025' },
  approved: { bg: '#d9f0de', color: '#2a8e44' },
  accepted: { bg: '#fdf2d4', color: '#946c00' },
  login: { bg: '#f1e6fd', color: '#7d3bc8' },
  logout: { bg: '#f1f1f1', color: '#666666' },
  sent: { bg: '#dbe9fe', color: '#1961ed' },
  confirmed: { bg: '#d9f0de', color: '#2a8e44' },
  rejected: { bg: '#fdded9', color: '#d93025' },
  declined: { bg: '#fdded9', color: '#d93025' },
  withdrawn: { bg: '#f1f1f1', color: '#666666' },
};

function actionColor(action: string) {
  const verb = action?.split('.')[1] ?? '';
  return actionColors[verb] ?? { bg: '#f1f1f1', color: '#666' };
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

const selectStyle: React.CSSProperties = {
  height: 26, padding: '0 8px', border: '1px solid var(--border-medium)',
  borderRadius: 4, fontSize: 13, fontFamily: 'inherit',
  background: 'var(--bg-primary)', color: 'var(--font-primary)',
};

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [verb, setVerb] = useState('all');
  const [dateFrom, setDateFrom] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', 'full'],
    queryFn: async () => {
      const { data } = await api.get('/audit-logs', { params: { page: 1, limit: 500 } });
      return data;
    },
  });

  const all = data?.items ?? [];

  const categories = useMemo(() => [...new Set(all.map((l: any) => l.targetType))].sort() as string[], [all]);
  const verbs = useMemo(() => [...new Set(all.map((l: any) => l.action?.split('.')[1]).filter(Boolean))].sort() as string[], [all]);

  const filtered = useMemo(() => all.filter((log: any) => {
    if (category !== 'all' && log.targetType !== category) return false;
    if (verb !== 'all' && log.action?.split('.')[1] !== verb) return false;
    if (dateFrom && new Date(log.createdAt) < new Date(dateFrom)) return false;
    const q = search.toLowerCase().trim();
    if (q) {
      const hay = `${log.action} ${log.actor?.fullName ?? ''} ${log.metadata?.name ?? ''} ${log.targetType}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [all, search, category, verb, dateFrom]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="page">
      <ViewBar label="All Entries" count={filtered.length}>
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search action, user, record…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/>
        </div>
        <select style={selectStyle} value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}>
          <option value="all">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select style={selectStyle} value={verb} onChange={e => { setVerb(e.target.value); setPage(1); }}>
          <option value="all">All actions</option>
          {verbs.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <input
          type="date"
          style={selectStyle}
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          title="Show entries since"
        />
      </ViewBar>

      <div className="table-container">
        {isLoading ? (
          <TableSkeleton columns={5} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 'auto', paddingLeft: 12 }}><span className="th-inner"><IconCalendar size={14}/>When</span></th>
                <th><span className="th-inner"><IconUser size={14}/>Performed by</span></th>
                <th><span className="th-inner"><IconBolt size={14}/>Action</span></th>
                <th><span className="th-inner"><IconTarget size={14}/>Category</span></th>
                <th><span className="th-inner"><IconNotes size={14}/>Record</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((log: any) => {
                const c = actionColor(log.action);
                const ac = getColor(log.actor?.fullName || 'A');
                return (
                  <tr key={log.id}>
                    <td className="cell-muted" style={{ paddingLeft: 12, width: 'auto' }} title={new Date(log.createdAt).toLocaleString('en-GB')}>
                      {timeAgo(log.createdAt)}
                    </td>
                    <td>
                      <span className="user-cell">
                        <span className="round-avatar" style={{ background: ac.bg, color: ac.color }}>
                          {log.actor?.fullName?.[0] ?? '?'}
                        </span>
                        {log.actor?.fullName ?? log.actorId?.slice(0, 8) ?? '–'}
                      </span>
                    </td>
                    <td>
                      <span className="badge" style={{ background: c.bg, color: c.color }}>
                        {log.action?.replace(/[._]/g, ' ')}
                      </span>
                    </td>
                    <td className="cell-muted">{log.targetType}</td>
                    <td className="cell-muted" style={{ maxWidth: 320 }}>
                      {log.metadata?.name ?? (log.targetId ? log.targetId.slice(0, 8) : '–')}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={5}><EmptyState variant={search || category !== 'all' || verb !== 'all' || dateFrom ? 'matches' : 'timeline'} title="No audit entries found" description="Try changing the search or filters." /></td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="table-footer">
        <span>{filtered.length} entries</span>
        <span style={{ flex: 1 }}/>
        <button className="btn-icon" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)} style={{ opacity: safePage <= 1 ? 0.4 : 1 }}>
          <IconChevronLeft size={14}/>
        </button>
        <span>Page {safePage} of {pages}</span>
        <button className="btn-icon" disabled={safePage >= pages} onClick={() => setPage(p => p + 1)} style={{ opacity: safePage >= pages ? 0.4 : 1 }}>
          <IconChevronRight size={14}/>
        </button>
      </div>
    </div>
  );
}
