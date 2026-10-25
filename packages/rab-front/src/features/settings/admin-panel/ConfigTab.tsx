import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import AdminActionDialog from './AdminActionDialog';
import { adminApi } from './adminPanelApi';

const DRIVER_LABEL: Record<string, string> = { LOGGER: 'Logger (emails are written to the log, not sent)', SMTP: 'SMTP', RESEND: 'Resend', UNKNOWN: 'Unknown' };

/**
 * Admin panel → Config (mockup v2, owner decisions D4/D5/D8):
 *  - Maintenance mode is PER ORGANISATION (the admin's own) and the copy says exactly what it does: people in that
 *    organisation (except platform admins) get a maintenance message instead of their data; sign-in still works; other
 *    organisations are not affected.
 *  - Email delivery is read-only from the server's environment (the old editable DB SMTP form fed no driver and is
 *    retired); "Send test email to me" uses the live driver and the admin's own address only.
 *  - Environment: an allowlist; secrets and URLs show only Set / Not set — never values or host names.
 */
export default function ConfigTab({ organisationName }: { organisationName?: string }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['admin', 'config'], queryFn: adminApi.config });
  const email = useQuery({ queryKey: ['admin', 'config', 'email'], queryFn: adminApi.email });
  const env = useQuery({ queryKey: ['admin', 'config', 'environment'], queryFn: adminApi.environment });
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'maintenanceOn' | 'maintenanceOff' | 'testEmail' | null>(null);
  const enabled = config.data?.maintenanceMode?.enabled ?? false;
  const orgLabel = organisationName ?? 'your organisation';

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (Array.isArray(env.data) ? env.data : []).filter((r) => !f || `${r.group} ${r.key} ${r.value ?? ''}`.toLowerCase().includes(f));
  }, [env.data, filter]);

  return (
    <>
      <section className="ap-block" aria-label="Maintenance mode">
        <div className="ap-block-head"><h2 className="ap-h2">Maintenance mode (this organisation)</h2></div>
        <div className="ap-card ap-flagrow">
          <div>
            Maintenance mode for your organisation
            <small>
              People in {orgLabel} (except platform admins) see a maintenance message instead of their data. Sign-in still works, and other organisations are not affected.
            </small>
          </div>
          <label className="ap-toggle">
            <input
              type="checkbox"
              aria-label="Maintenance mode"
              checked={enabled}
              disabled={!config.data}
              onChange={(e) => setDialog(e.target.checked ? 'maintenanceOn' : 'maintenanceOff')}
            />
            <span />
          </label>
        </div>
        {config.isError && <p className="ap-callout ap-warn">The maintenance setting could not be loaded.</p>}
      </section>

      <section className="ap-block" aria-label="Email delivery">
        <div className="ap-block-head">
          <h2 className="ap-h2">Email delivery</h2>
          <button type="button" className="ap-btn" onClick={() => setDialog('testEmail')} disabled={!email.data}>Send test email to me</button>
        </div>
        <div className="ap-card">
          {email.isLoading ? (
            <p className="ap-muted" style={{ margin: 0 }}>Loading…</p>
          ) : email.isError || !email.data ? (
            <p className="ap-muted" style={{ margin: 0 }}>Email settings are not available.</p>
          ) : (
            <dl className="ap-kv">
              <dt>Driver</dt><dd>{DRIVER_LABEL[email.data.driver] ?? email.data.driver}</dd>
              <dt>From address</dt><dd>{email.data.fromAddress ?? 'Not set'}</dd>
              <dt>{email.data.driver === 'SMTP' ? 'SMTP password' : 'API key'}</dt>
              <dd>
                {email.data.credential === 'set' ? <span className="ap-pill ap-ok">Configured</span> : email.data.credential === 'not_set' ? <span className="ap-pill ap-warn">Not set</span> : <span className="ap-pill">Not needed</span>}
              </dd>
              <dt>Delivery</dt><dd>{email.data.deliveryEnabled ? 'On' : <span className="ap-pill ap-warn">Turned off (EMAIL_DELIVERY_ENABLED=false)</span>}</dd>
              <dt>Source</dt><dd>Server settings (EMAIL_DRIVER, EMAIL_FROM_ADDRESS). Change them in OpenShip and redeploy.</dd>
            </dl>
          )}
        </div>
      </section>

      <section className="ap-block" aria-label="Environment">
        <div className="ap-block-head">
          <h2 className="ap-h2">Environment</h2>
          <p className="ap-sub">Read-only, from an allowlist. Secrets and URLs show only whether they are set, never values or hostnames. Change them in OpenShip and redeploy.</p>
        </div>
        <div className="ap-row">
          <input className="ap-input ap-grow" type="search" placeholder="Filter variables" aria-label="Filter variables" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Group</th><th>Variable</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>
              {env.isLoading ? (
                <tr><td colSpan={4} className="ap-empty">Loading…</td></tr>
              ) : env.isError ? (
                <tr><td colSpan={4} className="ap-empty">The environment could not be loaded.</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="ap-empty">No variables match this filter.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.key}>
                    <td className="ap-muted">{r.group}</td>
                    <td className="ap-mono">{r.key}</td>
                    <td>{r.state === 'value' ? <span className="ap-mono">{r.value}</span> : r.state === 'set' ? <span className="ap-pill ap-ok">Set</span> : <span className="ap-pill">Not set</span>}</td>
                    <td className="ap-muted">{r.source}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(dialog === 'maintenanceOn' || dialog === 'maintenanceOff') && (
        <AdminActionDialog
          title={dialog === 'maintenanceOn' ? 'Turn on maintenance mode for your organisation' : 'Turn off maintenance mode'}
          body={
            dialog === 'maintenanceOn'
              ? 'People in your organisation, except platform admins, will see a maintenance message. Sign-in and other organisations are not affected.'
              : 'People in your organisation get their data back straight away.'
          }
          confirmLabel={dialog === 'maintenanceOn' ? 'Turn on' : 'Turn off'}
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            await adminApi.setMaintenance(dialog === 'maintenanceOn', reason);
            await qc.invalidateQueries({ queryKey: ['admin', 'config'] });
            toast.success(dialog === 'maintenanceOn' ? 'Maintenance mode is on' : 'Maintenance mode turned off');
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'testEmail' && (
        <AdminActionDialog
          title="Send a test email"
          body="Sends a test email to your own address using the server’s email settings."
          confirmLabel="Send"
          reason={false}
          stepUp={false}
          onConfirm={async () => {
            try {
              const result = await adminApi.sendTestEmail();
              if (result.sent) toast.success(`Test email sent to ${result.to}`);
              else toast.error('The test email could not be sent. Check the email settings.');
            } catch (err) {
              toast.error(getApiErrorMessage(err, 'The test email could not be sent.'));
            }
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
