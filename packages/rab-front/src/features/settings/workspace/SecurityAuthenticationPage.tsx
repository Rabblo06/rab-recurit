import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { FormSkeleton } from '../../../shared/components/LoadingState';

interface ProviderState {
  organisationEnabled: boolean;
  systemEnabled: boolean;
}

interface AuthProvidersResponse {
  password: ProviderState;
  google: ProviderState;
  microsoft: ProviderState;
}

const PROVIDERS: Array<{ key: keyof AuthProvidersResponse; field: string; label: string; description: string }> = [
  { key: 'password', field: 'passwordAuthEnabled', label: 'Password', description: 'Allow users in this organisation to sign in with email and password.' },
  { key: 'google', field: 'googleAuthEnabled', label: 'Google', description: 'Allow users in this organisation to sign in with Google.' },
  { key: 'microsoft', field: 'microsoftAuthEnabled', label: 'Microsoft', description: 'Allow users in this organisation to sign in with Microsoft.' },
];

/**
 * P1C.1B — Settings -> Security -> Authentication (Twenty-style provider toggles,
 * FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.6/§33.7.12). Backend authorization remains
 * authoritative (SETTINGS_EDIT via PermissionGuard, re-checked server-side on every PATCH); this
 * page's hiding/disabling is presentation only, matching the P1C.1B brief's own §8 instruction.
 */
export default function SecurityAuthenticationPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['workspace-security'],
    queryFn: async () => (await api.get<AuthProvidersResponse>('/workspace/security')).data,
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.patch('/workspace/security', patch),
    onSuccess: (res) => {
      qc.setQueryData(['workspace-security'], res.data);
      toast.success('Authentication settings updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not update authentication settings.'),
  });

  if (isLoading || !data) {
    return <FormSkeleton />;
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Authentication</h3>
        <p>Control which sign-in methods are available to people in this organisation.</p>

        {PROVIDERS.map(({ key, field, label, description }) => {
          const state = data[key];
          return (
            <div key={key} className="settings-row" style={{ alignItems: 'flex-start', padding: '12px 0' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{label}</div>
                <p style={{ fontSize: 12, color: 'var(--font-tertiary, #888)', margin: '2px 0 0' }}>
                  {state.systemEnabled ? description : 'Unavailable on this deployment.'}
                </p>
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', cursor: state.systemEnabled ? 'pointer' : 'not-allowed', opacity: state.systemEnabled ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={state.organisationEnabled}
                  disabled={!state.systemEnabled || save.isPending}
                  onChange={(e) => save.mutate({ [field]: e.target.checked })}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
