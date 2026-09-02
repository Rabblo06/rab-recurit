import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';

type Role = 'staff' | 'manager';

const empty = {
  email: '',
  firstName: '',
  lastName: '',
  phone: '',
  // staff only
  staffRef: '',
  startDate: '',
  hourlyRate: '',
  // manager only
  managerType: 'internal' as 'internal' | 'venue',
  jobTitle: '',
};

type FormState = typeof empty;

interface CreatedInvite {
  sendNumber: number;
  delivered: boolean;
}

/**
 * Global create-staff/create-manager side panel. Opened from anywhere via:
 *   document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'staff' | 'manager' } }))
 *
 * Only fields the real API accepts (CreateStaffDto / CreateManagerDto) —
 * `forbidNonWhitelisted` on the backend 400s on anything else, so this
 * can't grow speculative fields ahead of the backend supporting them. No
 * password field — the account is created PENDING and activates itself via
 * the emailed invitation link; see `AccountInviteService`.
 */
export default function CreateUserModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('staff');
  const [form, setForm] = useState<FormState>({ ...empty });
  const [error, setError] = useState('');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setRole(detail.role === 'manager' ? 'manager' : 'staff');
      setForm({ ...empty });
      setError('');
      setCreatedInvite(null);
      setOpen(true);
    };
    document.addEventListener('open-create-user', handler);
    return () => document.removeEventListener('open-create-user', handler);
  }, []);

  const create = useMutation({
    mutationFn: (): Promise<any> => {
      if (role === 'staff') {
        const pounds = parseFloat(form.hourlyRate);
        return api.post('/staff', {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          staffRef: form.staffRef,
          startDate: form.startDate || undefined,
          defaultPayRatePence: Number.isFinite(pounds) ? Math.round(pounds * 100) : undefined,
        });
      }
      return api.post('/managers', {
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
        type: form.managerType,
        jobTitle: form.jobTitle || undefined,
      });
    },
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: [role === 'staff' ? 'staff' : 'managers'] });
      setCreatedInvite({ sendNumber: data.invite?.sendNumber ?? 1, delivered: data.invite?.delivered ?? true });
    },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to create.');
    },
  });

  const f = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(p => ({ ...p, [key]: e.target.value }));

  const title = role === 'staff' ? 'Create staff member' : 'Create manager';
  const isDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(empty), [form]);
  const canSubmit = Boolean(form.email && form.firstName && form.lastName && (role === 'manager' || form.staffRef));

  const close = () => setOpen(false);

  return (
    <Drawer
      open={open}
      onClose={close}
      title={title}
      loading={create.isPending}
      dirty={isDirty && !createdInvite}
      footer={
        createdInvite ? (
          <button className="btn btn-dark" onClick={close}>Done</button>
        ) : (
          <>
            <button className="btn btn-outline" onClick={close}>Cancel</button>
            <button className="btn btn-dark" disabled={!canSubmit || create.isPending} onClick={() => { setError(''); create.mutate(); }}>
              {create.isPending ? 'Creating…' : title}
            </button>
          </>
        )
      }
    >
      {createdInvite ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {createdInvite.delivered ? (
            <p style={{ fontSize: 13 }}>
              Account created. An invitation email has been sent — they&apos;ll set their own
              password to activate the account (Invitation {createdInvite.sendNumber} of 3,
              expires in 24 hours).
            </p>
          ) : (
            <p className="error" style={{ fontSize: 13 }}>
              Account created, but the invitation email failed to send. Use &quot;Resend
              Invitation&quot; from the account&apos;s details to try again.
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field">
            <label>Email <span style={{ color: 'var(--color-danger)' }}>*</span></label>
            <input type="email" value={form.email} onChange={f('email')} placeholder="jane@company.com" />
          </div>
          <div className="form-grid">
            <div className="field">
              <label>First name <span style={{ color: 'var(--color-danger)' }}>*</span></label>
              <input value={form.firstName} onChange={f('firstName')} />
            </div>
            <div className="field">
              <label>Last name <span style={{ color: 'var(--color-danger)' }}>*</span></label>
              <input value={form.lastName} onChange={f('lastName')} />
            </div>
          </div>
          <div className="field">
            <label>Phone</label>
            <input value={form.phone} onChange={f('phone')} placeholder="+44 7700 900000" />
          </div>

          {role === 'staff' ? (
            <>
              <div className="field">
                <label>Staff reference <span style={{ color: 'var(--color-danger)' }}>*</span></label>
                <input value={form.staffRef} onChange={f('staffRef')} placeholder="STF-001" />
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Start date</label>
                  <input type="date" value={form.startDate} onChange={f('startDate')} />
                </div>
                <div className="field">
                  <label>Default rate (£/hr)</label>
                  <input type="number" min="0" step="0.01" value={form.hourlyRate} onChange={f('hourlyRate')} placeholder="12.50" />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Manager type</label>
                <select value={form.managerType} onChange={f('managerType') as any}>
                  <option value="internal">Internal manager</option>
                  <option value="venue">Venue manager</option>
                </select>
              </div>
              <div className="field">
                <label>Job title</label>
                <input value={form.jobTitle} onChange={f('jobTitle')} placeholder="Operations Manager" />
              </div>
            </>
          )}

          <p className="field-hint">
            An invitation email will be sent to this address — they&apos;ll set their own
            password to activate the account. No password is set here.
          </p>

          {error && <p className="error" style={{ margin: '4px 0' }}>{error}</p>}
        </div>
      )}
    </Drawer>
  );
}
