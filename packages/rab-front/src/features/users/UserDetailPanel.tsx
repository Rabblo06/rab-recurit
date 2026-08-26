import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconUserOff, IconUserCheck, IconKey } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import { DetailSkeleton } from '../../shared/components/LoadingState';

type UserType = 'staff' | 'manager';

interface DetailForm {
  firstName: string;
  lastName: string;
  phone: string;
  staffRef: string;
  startDate: string;
  hourlyRate: string;
  jobTitle: string;
}

const empty: DetailForm = {
  firstName: '', lastName: '', phone: '',
  staffRef: '', startDate: '', hourlyRate: '',
  jobTitle: '',
};

/**
 * Opened globally via:
 *   document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id, type: 'staff' | 'manager' } }))
 *
 * Reads/writes only what the real StaffProfile/ManagerProfile + User records
 * hold (via GET/PATCH /staff/:id and /managers/:id) — no fictional HR
 * fields. Email is read-only (immutable, set on create only, same as
 * staffRef/username elsewhere in the app); manager type is read-only for
 * the same reason (changing it would mean re-provisioning roles).
 */
export default function UserDetailPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userType, setUserType] = useState<UserType>('staff');
  const [id, setId] = useState<string | null>(null);
  const [form, setForm] = useState<DetailForm>(empty);
  const [initialForm, setInitialForm] = useState<DetailForm>(empty);
  const [error, setError] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (!detail.id) return;
      setUserType(detail.type === 'manager' ? 'manager' : 'staff');
      setId(detail.id);
      setError('');
      setResetConfirm(false);
      setResetDone(false);
      setOpen(true);
    };
    document.addEventListener('open-user-detail', handler);
    return () => document.removeEventListener('open-user-detail', handler);
  }, []);

  const endpoint = userType === 'staff' ? 'staff' : 'managers';

  const { data: record, isLoading } = useQuery({
    queryKey: [endpoint, id],
    queryFn: async () => { const { data } = await api.get(`/${endpoint}/${id}`); return data; },
    enabled: !!id && open,
  });

  useEffect(() => {
    if (!record) return;
    const next: DetailForm = {
      firstName: record.firstName ?? '',
      lastName: record.lastName ?? '',
      phone: record.phone ?? '',
      staffRef: record.staffRef ?? '',
      startDate: record.startDate ?? '',
      hourlyRate: record.defaultPayRatePence ? (record.defaultPayRatePence / 100).toFixed(2) : '',
      jobTitle: record.jobTitle ?? '',
    };
    setForm(next);
    setInitialForm(next);
  }, [record]);

  const save = useMutation({
    mutationFn: (): Promise<any> => {
      if (userType === 'staff') {
        const pounds = parseFloat(form.hourlyRate);
        return api.patch(`/staff/${id}`, {
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          staffRef: form.staffRef,
          startDate: form.startDate || undefined,
          defaultPayRatePence: Number.isFinite(pounds) ? Math.round(pounds * 100) : undefined,
        });
      }
      return api.patch(`/managers/${id}`, {
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
        jobTitle: form.jobTitle || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [endpoint] });
      qc.invalidateQueries({ queryKey: [endpoint, id] });
      setInitialForm(form);
      setError('');
    },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to save changes.');
    },
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) => api.post(`/${endpoint}/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [endpoint] });
      qc.invalidateQueries({ queryKey: [endpoint, id] });
    },
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/${endpoint}/${id}/reset-password`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [endpoint] });
      qc.invalidateQueries({ queryKey: [endpoint, id] });
      setResetConfirm(false);
      setResetDone(true);
    },
    onError: (e: any) => {
      setError(e?.response?.data?.message ?? 'Failed to reset password.');
      setResetConfirm(false);
    },
  });

  const f = (key: keyof DetailForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [key]: e.target.value }));

  const isDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const close = () => setOpen(false);

  // Staff activity is tracked as employment status; manager account access is
  // tracked as user status — two different underlying controls, same "is
  // this person able to work / sign in" question from the admin's view.
  const isActive = userType === 'staff' ? record?.employmentStatus === 'active' : record?.accountStatus === 'active';
  const passwordLabel = record?.mustResetPassword ? 'Temporary password' : 'Active';

  return (
    <Drawer
      open={open}
      onClose={close}
      title={record ? `${record.firstName} ${record.lastName}` : userType === 'staff' ? 'Staff member' : 'Manager'}
      description={record?.email}
      loading={isLoading || save.isPending}
      dirty={isDirty}
      footer={record && (
        <>
          <button type="button" className="btn btn-outline" onClick={() => setActive.mutate(!isActive)} disabled={setActive.isPending}>
            {isActive ? <IconUserOff size={14} /> : <IconUserCheck size={14} />}
            {isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          <button
            type="button"
            className="btn btn-dark"
            style={{ marginLeft: 'auto' }}
            disabled={!isDirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </>
      )}
    >
      {!record ? (
        <DetailSkeleton />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Email</label>
            <input readOnly value={record.email} style={{ background: 'var(--bg-secondary)', cursor: 'not-allowed' }} />
          </div>
          <div className="form-grid">
            <div className="field"><label>First name</label><input value={form.firstName} onChange={f('firstName')} /></div>
            <div className="field"><label>Last name</label><input value={form.lastName} onChange={f('lastName')} /></div>
          </div>
          <div className="field"><label>Phone</label><input value={form.phone} onChange={f('phone')} placeholder="+44 7700 900000" /></div>

          {userType === 'staff' ? (
            <>
              <div className="field-section-title">Employment information</div>
              <div className="field"><label>Staff reference</label><input value={form.staffRef} onChange={f('staffRef')} /></div>
              <div className="form-grid">
                <div className="field"><label>Start date</label><input type="date" value={form.startDate} onChange={f('startDate')} /></div>
                <div className="field"><label>Default rate (£/hr)</label><input type="number" min="0" step="0.01" value={form.hourlyRate} onChange={f('hourlyRate')} /></div>
              </div>
            </>
          ) : (
            <>
              <div className="field-section-title">Manager information</div>
              <div className="field">
                <label>Manager type</label>
                <input readOnly value={record.type === 'venue' ? 'Venue manager' : 'Internal manager'} style={{ background: 'var(--bg-secondary)', cursor: 'not-allowed' }} />
              </div>
              <div className="field"><label>Job title</label><input value={form.jobTitle} onChange={f('jobTitle')} placeholder="Operations Manager" /></div>
            </>
          )}

          <div className="field-section-title">Account</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className={`badge badge-${isActive ? 'active' : 'inactive'}`}>
              {isActive ? 'Active' : userType === 'staff' ? 'Inactive' : 'Suspended'}
            </span>
            <span className={`badge ${record.mustResetPassword ? 'badge-pending' : 'badge-active'}`}>{passwordLabel}</span>
          </div>

          {resetConfirm ? (
            <div className="drawer-discard-confirm" style={{ marginTop: 4 }}>
              <p>Reset {record.firstName}'s password? They'll be emailed a new one-time setup link and any active sessions will be signed out.</p>
              <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                <button type="button" className="btn btn-outline" onClick={() => setResetConfirm(false)}>Cancel</button>
                <button type="button" className="btn btn-dark" disabled={resetPassword.isPending} onClick={() => resetPassword.mutate()}>
                  {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-outline" style={{ width: '100%', gap: 6 }} onClick={() => { setResetDone(false); setResetConfirm(true); }}>
              <IconKey size={14} />
              Reset password
            </button>
          )}
          {resetDone && <p style={{ fontSize: 12, color: 'var(--color-green)', margin: 0 }}>A new setup link has been sent.</p>}

          {error && <p className="error" style={{ margin: '4px 0' }}>{error}</p>}
        </div>
      )}
    </Drawer>
  );
}
