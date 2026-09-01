import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../../shared/api';
import { EmptyState, TableSkeleton } from '../../shared/components/LoadingState';
import PageHeader from '../../shared/components/PageHeader';

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

function monthKey(d: string | Date) {
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export default function Payroll() {
  const { data: offers = [], isLoading } = useQuery({
    queryKey: ['offers'],
    queryFn: async () => { const { data } = await api.get('/offers'); return data; },
  });

  const completed = useMemo(
    () => offers.filter((o: any) => o.status === 'completed' && o.amountEarned != null),
    [offers],
  );

  const periods = useMemo(() => {
    const set = new Set<string>(completed.map((o: any) => monthKey(o.checkOutAt ?? o.placement?.date ?? o.updatedAt)));
    return [...set].sort().reverse();
  }, [completed]);

  const [period, setPeriod] = useState('');
  const [search, setSearch] = useState('');
  const activePeriod = period || periods[0] || '';

  const rows = useMemo(() => {
    const inPeriod = completed.filter(
      (o: any) => monthKey(o.checkOutAt ?? o.placement?.date ?? o.updatedAt) === activePeriod,
    );
    const byUser: Record<string, { name: string; shifts: number; hours: number; amount: number }> = {};
    for (const o of inPeriod) {
      const id = o.user?.id ?? o.userId;
      byUser[id] ??= { name: o.user?.fullName ?? 'Unknown', shifts: 0, hours: 0, amount: 0 };
      byUser[id].shifts += 1;
      byUser[id].hours += Number(o.totalHoursWorked ?? 0);
      byUser[id].amount += Number(o.amountEarned ?? 0);
    }
    return Object.entries(byUser)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [completed, activePeriod]);

  const filteredRows = useMemo(() => {
    const q = search.toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const totals = filteredRows.reduce(
    (acc, r) => ({ shifts: acc.shifts + r.shifts, hours: acc.hours + r.hours, amount: acc.amount + r.amount }),
    { shifts: 0, hours: 0, amount: 0 },
  );

  const fmtPeriod = (p: string) => {
    if (!p) return '—';
    const [y, m] = p.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  return (
    <div className="page">
      <PageHeader title="Payroll" subtitle={fmtPeriod(activePeriod)} />

      <div className="list-tabs-row">
        <span className="tab-link active">Pay periods</span>
      </div>

      <div className="list-toolbar-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="toolbar-search">
            <IconSearch size={14}/>
            <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <select
            value={activePeriod}
            onChange={e => setPeriod(e.target.value)}
            style={{
              height: 28, padding: '0 8px', border: '1px solid var(--border-medium)',
              borderRadius: 'var(--radius-sm)', font: 'var(--text-body)', background: 'var(--bg-primary)', color: 'var(--font-secondary)',
            }}
          >
            {periods.length === 0 && <option value="">No completed shifts</option>}
            {periods.map(p => <option key={p} value={p}>{fmtPeriod(p)}</option>)}
          </select>
        </div>
        <div className="list-toolbar-actions">
          <button className="btn btn-outline">Filter</button>
          <button className="btn btn-outline">Sort</button>
          <button className="btn btn-outline">Options</button>
        </div>
      </div>

      <div className="table-container">
        {isLoading ? (
          <TableSkeleton columns={4} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 'auto' }}>Staff</th>
                <th>Shifts</th>
                <th>Hours</th>
                <th>Amount due</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => {
                const c = getColor(r.name);
                return (
                  <tr key={r.id}>
                    <td style={{ width: 'auto' }}>
                      <span className="user-cell">
                        <span className="round-avatar" style={{ background: c.bg, color: c.color }}>{r.name[0]}</span>
                        {r.name}
                      </span>
                    </td>
                    <td className="cell-muted">{r.shifts}</td>
                    <td className="cell-muted">{r.hours.toFixed(2)}h</td>
                    <td style={{ color: 'var(--color-green)', fontWeight: 600 }}>£{r.amount.toFixed(2)}</td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr><td colSpan={4}>
                  <EmptyState
                    variant={search ? 'matches' : 'files'}
                    title={search ? 'No staff found' : 'No payroll records yet'}
                    description={search ? 'Try a different name.' : 'Completed shifts for this pay period will appear here.'}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="table-footer">
        <span>Total</span>
        <span>{totals.shifts} shifts</span>
        <span>{totals.hours.toFixed(2)}h</span>
        <span style={{ fontWeight: 600, color: 'var(--font-primary)' }}>£{totals.amount.toFixed(2)}</span>
      </div>
    </div>
  );
}
