import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconSearch, IconUserOff, IconUserCheck, IconEye, IconKey,
  IconAbc, IconMail, IconPhone, IconTag, IconCircleCheck, IconCalendar,
  IconCurrencyPound, IconBriefcase, IconLock,
} from '@tabler/icons-react';
import { api } from '../api';
import ViewBar from '../components/ViewBar';
import TableFooter from '../components/TableFooter';
import { timeAgo } from '../lib/timeAgo';

interface StaffRow {
  id: string;
  staffRef: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  employmentStatus: string;
  startDate: string | null;
  defaultPayRatePence: number;
  createdAt: string;
  accountStatus: string;
  mustResetPassword: boolean;
}

interface ManagerRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  type: 'internal' | 'venue';
  jobTitle: string | null;
  createdAt: string;
  accountStatus: string;
  mustResetPassword: boolean;
}

const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

function openCreate(role: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role } }));
}

function openDetail(id: string, type: 'staff' | 'manager') {
  document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type } }));
}

function PasswordStatusBadge({ mustResetPassword }: { mustResetPassword: boolean }) {
  return (
    <span className={`badge ${mustResetPassword ? 'badge-pending' : 'badge-active'}`}>
      <IconLock size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
      {mustResetPassword ? 'Temporary' : 'Active'}
    </span>
  );
}

function StaffTab({ search, onCount }: { search: string; onCount: (n: number) => void }) {
  const qc = useQueryClient();
  const { data: staff = [], isLoading } = useQuery({
    queryKey: ['staff'],
    queryFn: async () => { const { data } = await api.get<StaffRow[]>('/staff'); return data; },
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/staff/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/staff/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });

  const filtered = useMemo(() => staff.filter((s) => {
    const q = search.toLowerCase();
    return !q
      || `${s.firstName} ${s.lastName}`.toLowerCase().includes(q)
      || s.email.toLowerCase().includes(q)
      || s.staffRef.toLowerCase().includes(q);
  }), [staff, search]);

  useEffect(() => onCount(filtered.length), [filtered.length, onCount]);

  if (isLoading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th><span className="th-inner"><IconAbc size={14}/>Name</span></th>
          <th><span className="th-inner"><IconTag size={14}/>Ref</span></th>
          <th><span className="th-inner"><IconMail size={14}/>Email</span></th>
          <th><span className="th-inner"><IconPhone size={14}/>Phone</span></th>
          <th><span className="th-inner"><IconCurrencyPound size={14}/>Rate</span></th>
          <th><span className="th-inner"><IconCircleCheck size={14}/>Status</span></th>
          <th><span className="th-inner"><IconLock size={14}/>Password</span></th>
          <th><span className="th-inner"><IconCalendar size={14}/>Added</span></th>
          <th style={{ width: 76 }}/>
        </tr>
      </thead>
      <tbody>
        {filtered.map((s) => {
          const name = `${s.firstName} ${s.lastName}`;
          const c = getColor(name);
          const active = s.employmentStatus === 'active';
          return (
            <tr key={s.id}>
              <td>
                <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(s.id, 'staff')}>
                  <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                  {name}
                </span>
              </td>
              <td className="cell-muted">{s.staffRef}</td>
              <td className="cell-muted">{s.email}</td>
              <td className="cell-muted">{s.phone ?? '–'}</td>
              <td className="cell-muted">{s.defaultPayRatePence ? `£${(s.defaultPayRatePence / 100).toFixed(2)}/hr` : '–'}</td>
              <td><span className={`badge badge-${active ? 'active' : 'inactive'}`}>{s.employmentStatus.replace(/_/g, ' ')}</span></td>
              <td><PasswordStatusBadge mustResetPassword={s.mustResetPassword}/></td>
              <td className="cell-muted">{timeAgo(s.createdAt)}</td>
              <td>
                <div className="row-actions">
                  <button className="btn-icon" title="View" onClick={() => openDetail(s.id, 'staff')}>
                    <IconEye size={14}/>
                  </button>
                  <button
                    className="btn-icon"
                    title="Reset password"
                    onClick={() => { if (confirm(`Reset ${name}'s password? They'll be emailed a new one-time setup link.`)) resetPassword.mutate(s.id); }}
                  >
                    <IconKey size={14}/>
                  </button>
                  <button
                    className={`btn-icon ${active ? 'danger' : 'success'}`}
                    title={active ? 'Deactivate' : 'Reactivate'}
                    onClick={() => setActive.mutate({ id: s.id, active: !active })}
                  >
                    {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
        {filtered.length === 0 && (
          <tr><td colSpan={9}><div className="empty-state"><p>No staff members have been added yet.</p></div></td></tr>
        )}
      </tbody>
    </table>
  );
}

function ManagersTab({ search, onCount }: { search: string; onCount: (n: number) => void }) {
  const qc = useQueryClient();
  const { data: managers = [], isLoading } = useQuery({
    queryKey: ['managers'],
    queryFn: async () => { const { data } = await api.get<ManagerRow[]>('/managers'); return data; },
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.post(`/managers/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post(`/managers/${id}/reset-password`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['managers'] }),
  });

  const filtered = useMemo(() => managers.filter((m) => {
    const q = search.toLowerCase();
    return !q
      || `${m.firstName} ${m.lastName}`.toLowerCase().includes(q)
      || m.email.toLowerCase().includes(q)
      || m.jobTitle?.toLowerCase().includes(q);
  }), [managers, search]);

  useEffect(() => onCount(filtered.length), [filtered.length, onCount]);

  if (isLoading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th><span className="th-inner"><IconAbc size={14}/>Name</span></th>
          <th><span className="th-inner"><IconMail size={14}/>Email</span></th>
          <th><span className="th-inner"><IconPhone size={14}/>Phone</span></th>
          <th><span className="th-inner"><IconBriefcase size={14}/>Job title</span></th>
          <th><span className="th-inner"><IconTag size={14}/>Type</span></th>
          <th><span className="th-inner"><IconCircleCheck size={14}/>Status</span></th>
          <th><span className="th-inner"><IconLock size={14}/>Password</span></th>
          <th><span className="th-inner"><IconCalendar size={14}/>Added</span></th>
          <th style={{ width: 76 }}/>
        </tr>
      </thead>
      <tbody>
        {filtered.map((m) => {
          const name = `${m.firstName} ${m.lastName}`;
          const c = getColor(name);
          const active = m.accountStatus === 'active';
          return (
            <tr key={m.id}>
              <td>
                <span className="record-chip" style={{ cursor: 'pointer' }} onClick={() => openDetail(m.id, 'manager')}>
                  <span className="mini-avatar" style={{ background: c.bg, color: c.color }}>{name[0]}</span>
                  {name}
                </span>
              </td>
              <td className="cell-muted">{m.email}</td>
              <td className="cell-muted">{m.phone ?? '–'}</td>
              <td className="cell-muted">{m.jobTitle ?? '–'}</td>
              <td><span className="badge badge-admin">{m.type === 'venue' ? 'Venue manager' : 'Manager'}</span></td>
              <td><span className={`badge badge-${active ? 'active' : 'inactive'}`}>{active ? 'Active' : 'Suspended'}</span></td>
              <td><PasswordStatusBadge mustResetPassword={m.mustResetPassword}/></td>
              <td className="cell-muted">{timeAgo(m.createdAt)}</td>
              <td>
                <div className="row-actions">
                  <button className="btn-icon" title="View" onClick={() => openDetail(m.id, 'manager')}>
                    <IconEye size={14}/>
                  </button>
                  <button
                    className="btn-icon"
                    title="Reset password"
                    onClick={() => { if (confirm(`Reset ${name}'s password? They'll be emailed a new one-time setup link.`)) resetPassword.mutate(m.id); }}
                  >
                    <IconKey size={14}/>
                  </button>
                  <button
                    className={`btn-icon ${active ? 'danger' : 'success'}`}
                    title={active ? 'Deactivate' : 'Reactivate'}
                    onClick={() => setActive.mutate({ id: m.id, active: !active })}
                  >
                    {active ? <IconUserOff size={14}/> : <IconUserCheck size={14}/>}
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
        {filtered.length === 0 && (
          <tr><td colSpan={9}><div className="empty-state"><p>No managers have been added yet.</p></div></td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function Users() {
  const [tab, setTab] = useState<'staff' | 'managers'>('staff');
  const [search, setSearch] = useState('');
  const [count, setCount] = useState(0);

  return (
    <div className="page">
      <ViewBar label={tab === 'staff' ? 'Staff' : 'Managers'} count={count}>
        <div style={{ display: 'flex', gap: 4, marginRight: 12 }}>
          <button className={`btn btn-sm ${tab === 'staff' ? 'btn-dark' : 'btn-outline'}`} onClick={() => setTab('staff')}>Staff</button>
          <button className={`btn btn-sm ${tab === 'managers' ? 'btn-dark' : 'btn-outline'}`} onClick={() => setTab('managers')}>Managers</button>
        </div>
        <div className="toolbar-search">
          <IconSearch size={14}/>
          <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <button className="btn btn-dark" style={{ marginLeft: 'auto' }} onClick={() => openCreate(tab === 'staff' ? 'staff' : 'manager')}>
          + New {tab === 'staff' ? 'Staff' : 'Manager'}
        </button>
      </ViewBar>

      <div className="table-container">
        {tab === 'staff' ? <StaffTab search={search} onCount={setCount} /> : <ManagersTab search={search} onCount={setCount} />}
      </div>
      <TableFooter count={count}/>
    </div>
  );
}
