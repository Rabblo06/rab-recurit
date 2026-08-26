import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLock, IconMail, IconDatabase, IconTools } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { FormSkeleton } from '../../../shared/components/LoadingState';

interface ConfigResponse {
  authentication: { method: string };
  smtp: {
    host: string | null;
    port: number | null;
    encryption: string | null;
    username: string | null;
    fromName: string | null;
    fromEmail: string | null;
    hasPassword: boolean;
  };
  storage: { driver: string };
  maintenanceMode: { enabled: boolean; message: string | null };
}

const EMPTY_SMTP_FORM = { host: '', port: 587, encryption: 'starttls', username: '', password: '', fromName: '', fromEmail: '' };

export default function ConfigTab() {
  const qc = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ['admin', 'config'],
    queryFn: async () => (await api.get<ConfigResponse>('/admin/config')).data,
  });

  const [smtpForm, setSmtpForm] = useState(EMPTY_SMTP_FORM);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  useEffect(() => {
    if (!config) return;
    setSmtpForm({
      host: config.smtp.host ?? '',
      port: config.smtp.port ?? 587,
      encryption: config.smtp.encryption ?? 'starttls',
      username: config.smtp.username ?? '',
      password: '',
      fromName: config.smtp.fromName ?? '',
      fromEmail: config.smtp.fromEmail ?? '',
    });
    setMaintenanceEnabled(config.maintenanceMode.enabled);
    setMaintenanceMessage(config.maintenanceMode.message ?? '');
  }, [config]);

  const saveSmtp = useMutation({
    mutationFn: () => {
      const { password, ...rest } = smtpForm;
      return api.patch('/admin/config/smtp', { ...rest, ...(password ? { password } : {}) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'config'] });
      toast.success('SMTP settings saved.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not save SMTP settings.'),
  });

  const testSmtp = useMutation({
    mutationFn: (sendTest: boolean) => {
      const { password, ...rest } = smtpForm;
      return api.post<{ ok: boolean; message: string }>('/admin/config/smtp/test', {
        ...rest,
        ...(password ? { password } : {}),
        ...(sendTest && testEmail ? { sendTo: testEmail } : {}),
      });
    },
    onSuccess: (res) => setTestResult(res.data),
    onError: (err: any) => setTestResult({ ok: false, message: err?.response?.data?.message ?? 'Test failed.' }),
  });

  const saveMaintenance = useMutation({
    mutationFn: () => api.patch('/admin/config/maintenance-mode', { enabled: maintenanceEnabled, message: maintenanceMessage || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'config'] });
      toast.success('Maintenance mode updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not update maintenance mode.'),
  });

  if (isLoading || !config) return <FormSkeleton sections={4} />;

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconLock size={14} /> Authentication</h3>
        <p>Authentication providers used by this workspace.</p>
        <div className="settings-row">
          <span>Email / Password</span>
          <span className="badge badge-active">Active</span>
        </div>
      </div>

      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconMail size={14} /> Email / SMTP</h3>
        <p>Configure your email settings.</p>
        <div className="form-grid">
          <div className="field">
            <label>SMTP Host</label>
            <input value={smtpForm.host} onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })} />
          </div>
          <div className="field">
            <label>SMTP Port</label>
            <input type="number" value={smtpForm.port} onChange={(e) => setSmtpForm({ ...smtpForm, port: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Encryption</label>
            <select value={smtpForm.encryption} onChange={(e) => setSmtpForm({ ...smtpForm, encryption: e.target.value })}>
              <option value="none">None</option>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
            </select>
          </div>
          <div className="field">
            <label>SMTP Username</label>
            <input value={smtpForm.username} onChange={(e) => setSmtpForm({ ...smtpForm, username: e.target.value })} />
          </div>
          <div className="field">
            <label>SMTP Password</label>
            <input
              type="password"
              value={smtpForm.password}
              onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
              placeholder={config.smtp.hasPassword ? '••••••••' : 'Not configured'}
            />
          </div>
          <div className="field">
            <label>From Name</label>
            <input value={smtpForm.fromName} onChange={(e) => setSmtpForm({ ...smtpForm, fromName: e.target.value })} />
          </div>
          <div className="field field-full">
            <label>From Email</label>
            <input value={smtpForm.fromEmail} onChange={(e) => setSmtpForm({ ...smtpForm, fromEmail: e.target.value })} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-dark" disabled={saveSmtp.isPending} onClick={() => saveSmtp.mutate()}>
            {saveSmtp.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button className="btn btn-outline" disabled={testSmtp.isPending} onClick={() => testSmtp.mutate(false)}>
            Test SMTP Connection
          </button>
          <input
            placeholder="you@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            style={{ height: 28, padding: '0 8px', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}
          />
          <button className="btn btn-outline" disabled={testSmtp.isPending || !testEmail} onClick={() => testSmtp.mutate(true)}>
            Send Test Email
          </button>
        </div>
        {testResult && (
          <p style={{ marginTop: 8, fontSize: 12, color: testResult.ok ? 'var(--color-green)' : 'var(--color-red)' }}>
            {testResult.message}
          </p>
        )}
      </div>

      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconDatabase size={14} /> Storage</h3>
        <p>Manage file storage settings.</p>
        <div className="settings-row">
          <span>Storage provider</span>
          <span style={{ color: 'var(--font-primary)' }}>{config.storage.driver}</span>
        </div>
      </div>

      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconTools size={14} /> Maintenance</h3>
        <p>Temporarily disable public access. You will always retain access.</p>
        <div className="settings-row">
          <span>Maintenance mode</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={maintenanceEnabled} onChange={(e) => setMaintenanceEnabled(e.target.checked)} />
            {maintenanceEnabled ? 'Enabled' : 'Disabled'}
          </label>
        </div>
        {maintenanceEnabled && (
          <div className="field">
            <label>Message shown to users</label>
            <input value={maintenanceMessage} onChange={(e) => setMaintenanceMessage(e.target.value)} placeholder="We'll be back shortly." />
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-dark" disabled={saveMaintenance.isPending} onClick={() => saveMaintenance.mutate()}>
            {saveMaintenance.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
