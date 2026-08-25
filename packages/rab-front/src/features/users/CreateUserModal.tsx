import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkPasswordStrength, generateSecurePassword } from '@rab/shared';
import { IconEye, IconEyeOff, IconRefresh, IconCopy, IconCheck } from '@tabler/icons-react';
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

/**
 * Global create-staff/create-manager side panel. Opened from anywhere via:
 *   document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'staff' | 'manager' } }))
 *
 * Only fields the real API accepts (CreateStaffDto / CreateManagerDto) —
 * `forbidNonWhitelisted` on the backend 400s on anything else, so this
 * can't grow speculative fields ahead of the backend supporting them.
 */
export default function CreateUserModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('staff');
  const [form, setForm] = useState<FormState>({ ...empty });
  const [tempPassword, setTempPassword] = useState('');
  const [showTempPassword, setShowTempPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setRole(detail.role === 'manager' ? 'manager' : 'staff');
      setForm({ ...empty });
      setTempPassword('');
      setShowTempPassword(false);
      setCopied(false);
      setError('');
      setCreatedPassword(null);
      setOpen(true);
    };
    document.addEventListener('open-create-user', handler);
    return () => document.removeEventListener('open-create-user', handler);
  }, []);

  const passwordStrength = useMemo(
    () => (tempPassword ? checkPasswordStrength(tempPassword, form.email) : null),
    [tempPassword, form.email],
  );

  const create = useMutation({
    mutationFn: (): Promise<any> => {
      const temporaryPassword = tempPassword || undefined;
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
          temporaryPassword,
        });
      }
      return api.post('/managers', {
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
        type: form.managerType,
        jobTitle: form.jobTitle || undefined,
        temporaryPassword,
      });
    },
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: [role === 'staff' ? 'staff' : 'managers'] });
      setCreatedPassword(data.temporaryPassword);
    },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(', ') : message ?? 'Failed to create.');
    },
  });

  const handleGeneratePassword = () => {
    setTempPassword(generateSecurePassword());
    setShowTempPassword(true);
  };

  const handleCopyPassword = async () => {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const f = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(p => ({ ...p, [key]: e.target.value }));

  const title = role === 'staff' ? 'Create staff member' : 'Create manager';
  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(empty) || tempPassword !== '',
    [form, tempPassword],
  );
  const canSubmit = Boolean(
    form.email &&
    form.firstName &&
    form.lastName &&
    (role === 'manager' || form.staffRef) &&
    (!tempPassword || passwordStrength?.valid),
  );

  const close = () => setOpen(false);

  return (
    <Drawer
      open={open}
      onClose={close}
      title={title}
      loading={create.isPending}
      dirty={isDirty && !createdPassword}
      footer={
        createdPassword ? (
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
      {createdPassword ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13 }}>
            Account created. A one-time setup link has been emailed to them — they'll
            create their own password from there. If the email doesn't arrive, you can
            share this temporary password with them directly instead; it won't be shown again.
          </p>
          <div className="field">
            <label>Temporary password</label>
            <input readOnly value={createdPassword} onFocus={e => e.target.select()} />
          </div>
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

          <div className="field-section-title">Login information</div>
          <div className="field">
            <label>Temporary password</label>
            <div className="password-field-row">
              <input
                type={showTempPassword ? 'text' : 'password'}
                value={tempPassword}
                onChange={e => setTempPassword(e.target.value)}
                placeholder="Leave blank to auto-generate"
              />
              <div className="password-field-actions">
                <button
                  type="button"
                  className="password-field-btn"
                  title={showTempPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowTempPassword(v => !v)}
                >
                  {showTempPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                </button>
                <button
                  type="button"
                  className="password-field-btn"
                  title="Copy password"
                  disabled={!tempPassword}
                  onClick={handleCopyPassword}
                >
                  {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                </button>
                <button
                  type="button"
                  className="password-field-btn"
                  title="Generate a secure password"
                  onClick={handleGeneratePassword}
                >
                  <IconRefresh size={15} />
                </button>
              </div>
            </div>
            {tempPassword && passwordStrength && (
              passwordStrength.valid ? (
                <p className="password-strength-ok">Strong password.</p>
              ) : (
                <ul className="password-strength-issues">
                  {passwordStrength.reasons.map(reason => <li key={reason}>{reason}</li>)}
                </ul>
              )
            )}
            <p className="field-hint">
              Sent to the new user via a one-time setup link — they'll never need to know this.
              Leave blank to have the server generate one automatically.
            </p>
          </div>

          {error && <p className="error" style={{ margin: '4px 0' }}>{error}</p>}
        </div>
      )}
    </Drawer>
  );
}
