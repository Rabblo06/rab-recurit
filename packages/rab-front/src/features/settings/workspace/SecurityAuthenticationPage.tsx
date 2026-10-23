import { useQuery } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { FormSkeleton } from '../../../shared/components/LoadingState';
import ManagedByPlatformAdminNotice from './ManagedByPlatformAdminNotice';

interface ProviderState {
  organisationEnabled: boolean;
  systemEnabled: boolean;
}

interface AuthProvidersResponse {
  password: ProviderState;
  google: ProviderState;
  microsoft: ProviderState;
}

const PROVIDERS: Array<{ key: keyof AuthProvidersResponse; label: string; description: string }> = [
  { key: 'password', label: 'Password', description: 'Sign in with email and password.' },
  { key: 'google', label: 'Google', description: 'Sign in with Google.' },
  { key: 'microsoft', label: 'Microsoft', description: 'Sign in with Microsoft.' },
];

/**
 * P1C.1B — Settings -> Security -> Authentication. READ-ONLY since W6-E2E-04 (owner decision 2026-10-23): a platform
 * administrator changes an organisation's sign-in methods (Admin Panel → Organisations); the organisation sees them here.
 * There is no tenant route to change them (`PATCH /workspace/security` was removed), so nothing on this page can.
 */
export default function SecurityAuthenticationPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['workspace-security'],
    queryFn: async () => (await api.get<AuthProvidersResponse>('/workspace/security')).data,
  });

  if (isLoading || !data) {
    return <FormSkeleton />;
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Authentication</h3>
        <p>Sign-in methods available to people in this organisation.</p>
        <ManagedByPlatformAdminNotice />

        {PROVIDERS.map(({ key, label, description }) => {
          const state = data[key];
          const on = state.systemEnabled && state.organisationEnabled;
          return (
            <div key={key} className="settings-row" style={{ alignItems: 'flex-start', padding: '12px 0' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{label}</div>
                <p style={{ fontSize: 12, color: 'var(--font-tertiary, #888)', margin: '2px 0 0' }}>
                  {state.systemEnabled ? description : 'Unavailable on this deployment.'}
                </p>
              </div>
              <span className={`badge badge-${on ? 'active' : 'inactive'}`} aria-label={`${label} sign-in ${on ? 'on' : 'off'}`}>{on ? 'On' : 'Off'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
