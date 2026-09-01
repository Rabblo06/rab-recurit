import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  XAxis, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import { api } from '../../shared/api';
import { DashboardSkeleton, EmptyState } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';
import PageHeader from '../../shared/components/PageHeader';

const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// ── Colours ──────────────────────────────────────────────────────────────────
const GREEN   = '#2a8e44';
const BLUE    = '#1961ed';
const PURPLE  = '#7d3bc8';
const GOLD    = '#946c00';

const OFFER_COLORS: Record<string, string> = {
  pending:           BLUE,
  staff_accepted:    GOLD,
  manager_confirmed: GREEN,
  manager_rejected:  '#d93025',
  declined:          '#d93025',
  expired:           '#b3b3b3',
  withdrawn:         '#b3b3b3',
};

const statCards = [
  { key: 'totalUsers',      label: 'Active Users' },
  { key: 'totalManagers',   label: 'Managers' },
  { key: 'totalStaff',      label: 'Staff' },
  { key: 'activeOffers',    label: 'Active Offers' },
  { key: 'totalPlacements', label: 'Venues' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const avatarColors = [
  { bg: '#dbe9fe', color: BLUE   },
  { bg: '#d9f0de', color: GREEN  },
  { bg: '#fdf2d4', color: GOLD   },
  { bg: '#f1e6fd', color: PURPLE },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

// ── Staff widget tabs ─────────────────────────────────────────────────────────
type StaffTab = 'active' | 'review' | 'accepted';

const STAFF_TABS: { key: StaffTab; label: string; color: string }[] = [
  { key: 'active',   label: 'Active Staff',         color: GREEN  },
  { key: 'review',   label: 'Awaiting Review',       color: GOLD   },
  { key: 'accepted', label: 'Shift Accepted',        color: BLUE   },
];

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [staffTab, setStaffTab] = useState<StaffTab>('active');

  const { data: staff = [], isLoading: staffLoading } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get('/staff'); return data; },
  });

  const { data: managers = [], isLoading: managersLoading } = useQuery({
    queryKey: ['managers'],
    queryFn: async () => { const { data } = await api.get('/managers'); return data; },
  });

  const { data: venues = [], isLoading: venuesLoading } = useQuery({
    queryKey: ['venues'],
    queryFn: async () => { const { data } = await api.get('/venues'); return data; },
  });

  const { data: offers = [], isLoading: offersLoading } = useQuery({
    queryKey: ['offers'],
    queryFn: async () => { const { data } = await api.get('/offers'); return data; },
  });

  // Real COUNT(*) from the backend, not `.length` on a (possibly
  // page-capped) downloaded list — see modules/dashboard/services on the
  // server. A field the caller lacks the underlying permission for comes
  // back null, rendered as the same '–' fallback the stat cards already use.
  const { data: summary } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: async () => { const { data } = await api.get('/dashboard/summary'); return data; },
  });

  const offersByStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of offers) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return [
      { name: 'Pending',              value: counts.pending           ?? 0 },
      { name: 'Awaiting Confirmation', value: counts.staff_accepted    ?? 0 },
      { name: 'Confirmed',            value: counts.manager_confirmed ?? 0 },
      { name: 'Rejected',             value: counts.manager_rejected  ?? 0 },
      { name: 'Declined',             value: counts.declined          ?? 0 },
      { name: 'Expired/Withdrawn',    value: (counts.expired ?? 0) + (counts.withdrawn ?? 0) },
    ].filter(d => d.value > 0);
  }, [offers]);

  // Staff don't have sub-roles yet — the one real breakdown available today
  // is manager type (internal vs venue).
  const staffByRole = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of managers) counts[m.type] = (counts[m.type] ?? 0) + 1;
    return Object.entries(counts).map(([role, value]) => ({ name: role, value }));
  }, [managers]);

  const donutData = useMemo(() => {
    const active   = staff.filter((s: any) => s.employmentStatus === 'active').length;
    const inactive = staff.filter((s: any) => s.employmentStatus !== 'active').length;
    return [
      { name: 'Active',   value: active },
      { name: 'Inactive', value: inactive },
    ].filter(d => d.value > 0);
  }, [staff]);

  // Actual earnings require completed attendance records, not just an
  // accepted offer — that's the payroll module (Phase 4), not built yet.
  // Left honestly empty rather than approximated from estimated offer pay.
  const earningsTimeline: { date: string; value: number }[] = [];

  // ── Staff widget data ─────────────────────────────────────────────────────
  // "Awaiting review" / "Shift accepted" depend on the offers module, which
  // doesn't exist yet — those tabs are honestly empty rather than guessed.
  const activeStaff = useMemo(() => staff.filter((s: any) => s.employmentStatus === 'active'), [staff]);

  const staffListMap: Record<StaffTab, any[]> = {
    active:   activeStaff,
    review:   [],
    accepted: [],
  };
  const currentStaffList = staffListMap[staffTab];
  const activeTab = STAFF_TABS.find(t => t.key === staffTab)!;

  const stats: Record<string, number | undefined> = {
    totalUsers: summary && summary.staffCount != null && summary.managerCount != null
      ? summary.staffCount + summary.managerCount
      : undefined,
    totalManagers: summary?.managerCount ?? undefined,
    totalStaff: summary?.staffCount ?? undefined,
    activeOffers: summary?.activeOfferCount ?? undefined,
    totalPlacements: summary?.venueCount ?? undefined,
  };
  const totalActive = donutData.find(d => d.name === 'Active')?.value ?? 0;

  if (staffLoading || managersLoading || venuesLoading || offersLoading) {
    return <div className="page page-scroll"><DashboardSkeleton /></div>;
  }

  return (
    <div className="page">
      <PageHeader title="Dashboard" subtitle={todayLabel} />
      <div className="page-scroll">

        {/* ── Stat cards ── */}
        <div className="stats-grid">
          {statCards.map(({ key, label }) => (
            <div className="stat-card" key={key}>
              <p className="stat-value">{stats?.[key] ?? '–'}</p>
              <p className="stat-label">{label}</p>
            </div>
          ))}
        </div>

        {/* ── Offers by status / Staff overview — plain rows, matching the reference (no chart chrome) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)', padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <p style={{ font: 'var(--text-section-title)', color: 'var(--font-primary)' }}>Offers by status</p>
              <span style={{ font: 'var(--text-small)', color: 'var(--font-tertiary)' }}>{offers.length} total</span>
            </div>
            {offersByStatus.length === 0 ? (
              <p style={{ font: 'var(--text-small)', color: 'var(--font-tertiary)', padding: '8px 0' }}>No offers yet.</p>
            ) : offersByStatus.map((row, i) => (
              <div key={row.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                <span style={{ font: 'var(--text-body)', color: 'var(--font-secondary)' }}>{row.name}</span>
                <span style={{ font: 'var(--text-body)', color: 'var(--font-primary)' }}>{row.value}</span>
              </div>
            ))}
          </div>

          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)', padding: '16px 20px' }}>
            <p style={{ font: 'var(--text-section-title)', color: 'var(--font-primary)', marginBottom: 16 }}>Staff overview</p>
            <p style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 26, fontWeight: 600, color: 'var(--font-primary)' }}>{totalActive}</span>{' '}
              <span style={{ font: 'var(--text-body)', color: 'var(--font-tertiary)' }}>of {staff.length} staff active</span>
            </p>
            <div style={{ height: 3, background: 'var(--bg-tertiary)', borderRadius: 2, marginBottom: 16 }}>
              <div style={{ height: '100%', borderRadius: 2, background: 'var(--color-accent)', width: staff.length ? `${(totalActive / staff.length) * 100}%` : '0%' }}/>
            </div>
            {staffByRole.map((row, i) => (
              <div key={row.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: i === 0 ? '1px solid var(--border-light)' : '1px solid var(--border-light)' }}>
                <span style={{ font: 'var(--text-body)', color: 'var(--font-secondary)' }}>{row.name === 'internal' ? 'Internal managers' : 'Venue managers'}</span>
                <span style={{ font: 'var(--text-body)', color: 'var(--font-primary)' }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Earnings timeline — full width, matching the reference ── */}
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)', padding: '16px 20px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
            <p style={{ font: 'var(--text-section-title)', color: 'var(--font-primary)' }}>Earnings timeline</p>
            {earningsTimeline.length > 0 && (
              <span>
                <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--font-primary)' }}>£{earningsTimeline.reduce((s, d) => s + d.value, 0).toFixed(0)}</span>{' '}
                <span style={{ font: 'var(--text-small)', color: 'var(--font-tertiary)' }}>this period</span>
              </span>
            )}
          </div>
          {earningsTimeline.length === 0 ? (
            <EmptyState compact variant="widgets" title="No completed earnings yet" description="Earnings appear after shifts are completed." />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={earningsTimeline} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                <Tooltip
                  formatter={(v: any) => [`£${Number(v).toFixed(2)}`, 'Earnings']}
                  contentStyle={{ fontSize: 12, border: '1px solid var(--border-medium)', borderRadius: 6, background: 'var(--bg-primary)' }}
                />
                <Line type="monotone" dataKey="value" stroke="var(--color-accent)" strokeWidth={2} dot={false} activeDot={{ r: 4 }}/>
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Staff widget (replaces stock market) ── */}
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius-sm)', marginBottom: 16 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', padding: '0 16px' }}>
            {STAFF_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setStaffTab(t.key)}
                style={{
                  padding: '10px 14px', background: 'none', border: 'none',
                  borderBottom: staffTab === t.key ? '2px solid var(--color-accent)' : '2px solid transparent',
                  fontSize: 13, fontWeight: staffTab === t.key ? 600 : 400,
                  color: staffTab === t.key ? 'var(--font-primary)' : 'var(--font-tertiary)',
                  cursor: 'pointer', marginBottom: -1,
                }}
              >
                {t.label}
                <span style={{
                  marginLeft: 6, fontSize: 11, fontWeight: 500,
                  background: staffTab === t.key ? 'var(--color-accent-soft)' : 'var(--bg-tertiary)',
                  color: staffTab === t.key ? 'var(--color-accent)' : 'var(--font-tertiary)',
                  padding: '1px 6px', borderRadius: 10,
                }}>
                  {staffListMap[t.key].length}
                </span>
              </button>
            ))}
          </div>

          {/* Staff list */}
          {currentStaffList.length === 0 ? (
            <EmptyState compact variant="records" title={`No ${activeTab.label.toLowerCase()} at the moment`} />
          ) : (
            <div>
              {/* Header row */}
              <div style={{ display: 'flex', padding: '8px 16px', borderBottom: '1px solid var(--border-light)', fontSize: 11, fontWeight: 600, color: 'var(--font-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <span style={{ flex: 1 }}>Name</span>
                <span style={{ width: 140 }}>Staff ref</span>
                <span style={{ width: 120 }}>Rate</span>
                <span style={{ width: 80, textAlign: 'right' }}>Status</span>
              </div>
              {currentStaffList.map((u: any) => {
                const name = `${u.firstName} ${u.lastName}`;
                const c = getColor(name);
                return (
                  <div
                    key={u.id}
                    style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border-light)' }}
                  >
                    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{
                        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                        background: c.bg, color: c.color,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700,
                      }}>{name[0]}</span>
                      <span>
                        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--font-primary)' }}>{name}</p>
                        <p style={{ fontSize: 11, color: 'var(--font-tertiary)' }}>{u.email}</p>
                      </span>
                    </span>
                    <span style={{ width: 140, fontSize: 12, color: 'var(--font-secondary)' }}>{u.staffRef || '–'}</span>
                    <span style={{ width: 120, fontSize: 12, color: 'var(--font-secondary)' }}>{u.defaultPayRatePence ? `£${(u.defaultPayRatePence / 100).toFixed(2)}/hr` : '–'}</span>
                    <span style={{ width: 80, textAlign: 'right' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10,
                        background: staffTab === 'active' ? '#d9f0de' : staffTab === 'review' ? '#fdf2d4' : '#dbe9fe',
                        color: activeTab.color,
                      }}>
                        {staffTab === 'active' ? 'Active' : staffTab === 'review' ? 'In Review' : 'Confirmed'}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Recent offers table ── */}
        <div className="section">
          <p className="section-title">Recent Offers</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 12 }}>Staff</th>
                  <th>Venue</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {[...offers]
                  .sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
                  .slice(0, 8)
                  .map((o: any) => (
                    <tr key={o.id}>
                      <td style={{ paddingLeft: 12, fontWeight: 500 }}>{o.staffName ?? '–'}</td>
                      <td className="cell-muted">{o.venueName ?? '–'}</td>
                      <td className="cell-muted">{o.startsAt ? new Date(o.startsAt).toLocaleDateString('en-GB') : '–'}</td>
                      <td>
                        <span className="badge" style={{ background: `${OFFER_COLORS[o.status]}22`, color: OFFER_COLORS[o.status] }}>
                          {o.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="cell-muted">{timeAgo(o.sentAt)}</td>
                    </tr>
                  ))}
                {offers.length === 0 && (
                  <tr><td colSpan={5}><EmptyState variant="inbox" title="No offers yet" description="Shift offers will appear here after they are sent." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
