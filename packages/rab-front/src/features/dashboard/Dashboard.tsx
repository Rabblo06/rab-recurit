import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconUsers, IconUserStar, IconUserCheck, IconChecklist, IconBuildingSkyscraper,
} from '@tabler/icons-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  LineChart, Line,
} from 'recharts';
import { api } from '../../shared/api';
import { DashboardSkeleton, EmptyState } from '../../shared/components/LoadingState';
import { timeAgo } from '../../shared/lib/timeAgo';

// ── Colours ──────────────────────────────────────────────────────────────────
const GREEN   = '#2a8e44';
const BLUE    = '#1961ed';
const ORANGE  = '#e8883a';
const PINK    = '#e05a8a';
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

const ROLE_COLORS: Record<string, string> = {
  staff:   GREEN,
  manager: GOLD,
  admin:   BLUE,
};

const statCards = [
  { key: 'totalUsers',      label: 'Active Users',    Icon: IconUsers,              bg: '#dbe9fe', color: BLUE    },
  { key: 'totalManagers',   label: 'Managers',        Icon: IconUserStar,           bg: '#fdf2d4', color: GOLD    },
  { key: 'totalStaff',      label: 'Staff',           Icon: IconUserCheck,          bg: '#d9f0de', color: GREEN   },
  { key: 'activeOffers',    label: 'Active Offers',   Icon: IconChecklist,          bg: '#f1e6fd', color: PURPLE  },
  { key: 'totalPlacements', label: 'Venues',          Icon: IconBuildingSkyscraper, bg: '#fdded9', color: '#d93025' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px solid var(--border-medium)',
      borderRadius: 8, padding: '16px 20px',
    }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--font-secondary)', marginBottom: 16 }}>{title}</p>
      {children}
    </div>
  );
}

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

  const offersByStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of offers) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return [
      { name: 'Pending',              value: counts.pending           ?? 0, fill: BLUE  },
      { name: 'Awaiting Confirmation', value: counts.staff_accepted    ?? 0, fill: GOLD  },
      { name: 'Confirmed',            value: counts.manager_confirmed ?? 0, fill: GREEN },
      { name: 'Rejected',             value: counts.manager_rejected  ?? 0, fill: '#d93025' },
      { name: 'Declined',             value: counts.declined          ?? 0, fill: '#d93025' },
      { name: 'Expired/Withdrawn',    value: (counts.expired ?? 0) + (counts.withdrawn ?? 0), fill: '#b3b3b3' },
    ].filter(d => d.value > 0);
  }, [offers]);

  // Staff don't have sub-roles yet — the one real breakdown available today
  // is manager type (internal vs venue).
  const staffByRole = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of managers) counts[m.type] = (counts[m.type] ?? 0) + 1;
    return Object.entries(counts).map(([role, value]) => ({ name: role, value, fill: ROLE_COLORS[role === 'internal' ? 'manager' : 'admin'] ?? '#999' }));
  }, [managers]);

  const donutData = useMemo(() => {
    const active   = staff.filter((s: any) => s.employmentStatus === 'active').length;
    const inactive = staff.filter((s: any) => s.employmentStatus !== 'active').length;
    return [
      { name: 'Active',   value: active,   color: ORANGE },
      { name: 'Inactive', value: inactive, color: '#ebebeb' },
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

  const stats: Record<string, number> = {
    totalUsers: staff.length + managers.length,
    totalManagers: managers.length,
    totalStaff: staff.length,
    activeOffers: offers.filter((o: any) => o.status === 'pending' || o.status === 'staff_accepted').length,
    totalPlacements: venues.length,
  };
  const totalActive = donutData.find(d => d.name === 'Active')?.value ?? 0;

  if (staffLoading || managersLoading || venuesLoading || offersLoading) {
    return <div className="page page-scroll"><DashboardSkeleton /></div>;
  }

  return (
    <div className="page">
      <div className="page-scroll">

        {/* ── Stat cards ── */}
        <div className="stats-grid">
          {statCards.map(({ key, label, Icon, bg, color }) => (
            <div className="stat-card" key={key}>
              <div className="stat-head">
                <div className="stat-icon" style={{ background: bg, color }}>
                  <Icon size={15} stroke={1.8}/>
                </div>
                <p className="stat-label">{label}</p>
              </div>
              <p className="stat-value">{stats?.[key] ?? '–'}</p>
            </div>
          ))}
        </div>

        {/* ── Chart row 1 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

          {/* Offers by Status — vertical bar */}
          <ChartCard title="Offers by Status">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={offersByStatus} margin={{ top: 16, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false}/>
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                <YAxis tickFormatter={fmt} tick={{ fontSize: 11, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--border-medium)', borderRadius: 6, background: 'var(--bg-primary)' }}
                  cursor={{ fill: 'var(--bg-transparent-light)' }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} label={{ position: 'top', fontSize: 10, fill: 'var(--font-tertiary)' }}>
                  {offersByStatus.map((entry, i) => <Cell key={i} fill={entry.fill}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Active vs Inactive — donut */}
          <ChartCard title="Staff Overview">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, position: 'relative' }}>
              <PieChart width={180} height={180}>
                <Pie
                  data={donutData.length ? donutData : [{ name: 'None', value: 1, color: '#ebebeb' }]}
                  cx={85} cy={85} innerRadius={56} outerRadius={82}
                  dataKey="value" stroke="none"
                >
                  {(donutData.length ? donutData : [{ color: '#ebebeb' }]).map((entry, i) => (
                    <Cell key={i} fill={entry.color}/>
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--border-medium)', borderRadius: 6, background: 'var(--bg-primary)' }}
                />
              </PieChart>
              <div style={{
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                textAlign: 'center', pointerEvents: 'none',
              }}>
                <p style={{ fontSize: 26, fontWeight: 700, color: 'var(--font-primary)', lineHeight: 1 }}>{totalActive}</p>
                <p style={{ fontSize: 12, color: 'var(--font-tertiary)', marginTop: 2 }}>Active</p>
              </div>
              {/* Legend */}
              <div style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {donutData.map(d => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: d.color, flexShrink: 0 }}/>
                    <span style={{ color: 'var(--font-secondary)' }}>{d.name}</span>
                    <span style={{ color: 'var(--font-tertiary)', marginLeft: 4 }}>{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </ChartCard>
        </div>

        {/* ── Chart row 2 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

          {/* Staff by Role — horizontal bar */}
          <ChartCard title="Managers by Type">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={staffByRole} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" horizontal={false}/>
                <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: 'var(--font-secondary)' }} axisLine={false} tickLine={false} width={60}/>
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--border-medium)', borderRadius: 6, background: 'var(--bg-primary)' }}
                  cursor={{ fill: 'var(--bg-transparent-light)' }}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 11, fill: 'var(--font-tertiary)' }}>
                  {staffByRole.map((entry, i) => <Cell key={i} fill={entry.fill}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Earnings Timeline — line */}
          <ChartCard title="Earnings Timeline">
            {earningsTimeline.length === 0 ? (
              <EmptyState compact variant="widgets" title="No completed earnings yet" description="Earnings appear after shifts are completed." />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={earningsTimeline} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false}/>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                  <YAxis tickFormatter={v => `£${fmt(v)}`} tick={{ fontSize: 11, fill: 'var(--font-tertiary)' }} axisLine={false} tickLine={false}/>
                  <Tooltip
                    formatter={(v: any) => [`£${Number(v).toFixed(2)}`, 'Earnings']}
                    contentStyle={{ fontSize: 12, border: '1px solid var(--border-medium)', borderRadius: 6, background: 'var(--bg-primary)' }}
                  />
                  <Line type="monotone" dataKey="value" stroke={PINK} strokeWidth={2} dot={false} activeDot={{ r: 4 }}/>
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>

        {/* ── Staff widget (replaces stock market) ── */}
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-medium)', borderRadius: 8, marginBottom: 16 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', padding: '0 16px' }}>
            {STAFF_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setStaffTab(t.key)}
                style={{
                  padding: '10px 14px', background: 'none', border: 'none',
                  borderBottom: staffTab === t.key ? `2px solid ${t.color}` : '2px solid transparent',
                  fontSize: 13, fontWeight: staffTab === t.key ? 600 : 400,
                  color: staffTab === t.key ? t.color : 'var(--font-tertiary)',
                  cursor: 'pointer', marginBottom: -1,
                }}
              >
                {t.label}
                <span style={{
                  marginLeft: 6, fontSize: 11, fontWeight: 500,
                  background: staffTab === t.key ? t.color : 'var(--bg-tertiary)',
                  color: staffTab === t.key ? '#fff' : 'var(--font-tertiary)',
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
