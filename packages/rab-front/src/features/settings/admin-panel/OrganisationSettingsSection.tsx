import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';

type ProviderKey = 'password' | 'google' | 'microsoft';

interface ProviderState {
  organisationEnabled: boolean;
  systemEnabled: boolean;
}

export interface OrganisationSettingsView {
  organisation: { id: string; name: string; slug: string; logoKey: string | null; timezone: string };
  authProviders: Record<ProviderKey, ProviderState>;
}

const PROVIDERS: Array<{ key: ProviderKey; field: string; label: string }> = [
  { key: 'password', field: 'passwordAuthEnabled', label: 'Password' },
  { key: 'google', field: 'googleAuthEnabled', label: 'Google' },
  { key: 'microsoft', field: 'microsoftAuthEnabled', label: 'Microsoft' },
];

/**
 * W6-E2E-04 — owner decision 2026-10-23: organisation settings (name, timezone, identifier, logo and sign-in methods,
 * including turning password sign-in off) are changed by a PLATFORM ADMINISTRATOR only, here in Admin Panel →
 * Organisations → (organisation). The organisation's own members see them read-only under Settings. The server is
 * authoritative (`PlatformAdminGuard` + `OrganisationSettingsAdminService`); this section only presents it.
 */
export default function OrganisationSettingsSection({ organisationId }: { organisationId: string }) {
  const qc = useQueryClient();
  const key = ['admin', 'organisations', organisationId, 'settings'];
  const base = `/admin/organisations/${organisationId}/settings`;
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<OrganisationSettingsView>(base)).data,
  });
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [slug, setSlug] = useState('');
  const [confirmPasswordOff, setConfirmPasswordOff] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data) {
      setName(data.organisation.name);
      setTimezone(data.organisation.timezone);
      setSlug(data.organisation.slug);
    }
  }, [data]);

  const applied = (view: OrganisationSettingsView, message: string) => {
    qc.setQueryData(key, view);
    qc.invalidateQueries({ queryKey: ['admin', 'organisations'] });
    toast.success(message);
  };
  const onError = (fallback: string) => (err: unknown) => toast.error(getApiErrorMessage(err, fallback));

  const saveGeneral = useMutation({
    mutationFn: () => api.patch<OrganisationSettingsView>(base, { name: name.trim(), timezone: timezone.trim() }),
    onSuccess: (res) => applied(res.data, 'Organisation updated.'),
    onError: onError('Could not update the organisation.'),
  });
  const saveSlug = useMutation({
    mutationFn: () => api.patch<OrganisationSettingsView>(`${base}/domain`, { slug: slug.trim() }),
    onSuccess: (res) => applied(res.data, 'Identifier updated.'),
    onError: onError('Could not update the identifier.'),
  });
  const saveProviders = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.patch<OrganisationSettingsView>(`${base}/security`, patch),
    onSuccess: (res) => applied(res.data, 'Sign-in methods updated.'),
    onError: onError('Could not update the sign-in methods.'),
    onSettled: () => setConfirmPasswordOff(false),
  });
  const removeLogo = useMutation({
    mutationFn: () => api.delete<OrganisationSettingsView>(`${base}/logo`),
    onSuccess: (res) => applied(res.data, 'Logo removed.'),
    onError: onError('Could not remove the logo.'),
  });
  const uploadLogo = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post<OrganisationSettingsView>(`${base}/logo`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    },
    onSuccess: (res) => applied(res.data, 'Logo updated.'),
    onError: onError('Could not upload that file.'),
  });

  if (isLoading) return <div className="detail-group"><div className="detail-group-title">Organisation settings</div><p className="cell-muted" style={{ margin: '0 4px' }}>Loading…</p></div>;
  if (isError || !data) return <div className="detail-group"><div className="detail-group-title">Organisation settings</div><p className="cell-muted" style={{ margin: '0 4px' }}>Could not load this organisation’s settings.</p></div>;

  const org = data.organisation;
  const generalDirty = name.trim() !== org.name || timezone.trim() !== org.timezone;
  const busy = saveProviders.isPending;

  function toggle(provider: ProviderKey, field: string, next: boolean) {
    if (provider === 'password' && !next) {
      setConfirmPasswordOff(true);
      return;
    }
    saveProviders.mutate({ [field]: next });
  }

  return (
    <>
      <div className="detail-group" aria-label="Organisation settings">
        <div className="detail-group-title">Organisation settings</div>
        <p className="cell-muted" style={{ margin: '0 4px 8px' }}>Only platform administrators can change these. The organisation sees them read-only.</p>
        <div className="field" style={{ margin: '0 4px 8px' }}>
          <label htmlFor="admin-org-name">Name</label>
          <input id="admin-org-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ margin: '0 4px 8px' }}>
          <label htmlFor="admin-org-timezone">Timezone</label>
          <input id="admin-org-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 4px 12px' }}>
          <button type="button" className="btn btn-dark" disabled={!generalDirty || !name.trim() || saveGeneral.isPending} onClick={() => saveGeneral.mutate()}>
            {saveGeneral.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="field" style={{ margin: '0 4px 8px' }}>
          <label htmlFor="admin-org-slug">Identifier</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="admin-org-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} style={{ flex: 1 }} />
            <button type="button" className="btn btn-outline" disabled={!slug.trim() || slug.trim() === org.slug || saveSlug.isPending} onClick={() => saveSlug.mutate()}>
              {saveSlug.isPending ? 'Saving…' : 'Change'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 4px' }}>
          <span className="detail-info-label" style={{ flex: 1 }}>Logo</span>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) uploadLogo.mutate(file);
          }} />
          <button type="button" className="btn btn-outline" disabled={uploadLogo.isPending} onClick={() => fileRef.current?.click()}>{uploadLogo.isPending ? 'Uploading…' : 'Upload'}</button>
          {org.logoKey && <button type="button" className="btn btn-outline" disabled={removeLogo.isPending} onClick={() => removeLogo.mutate()}>Remove</button>}
        </div>
      </div>

      <div className="detail-group" aria-label="Sign-in methods">
        <div className="detail-group-title">Sign-in methods</div>
        {PROVIDERS.map(({ key: provider, field, label }) => {
          const state = data.authProviders[provider];
          return (
            <label key={provider} className="detail-info-row" style={{ cursor: state.systemEnabled ? 'pointer' : 'not-allowed' }}>
              <span className="detail-info-label">{label}{state.systemEnabled ? '' : ' (unavailable on this deployment)'}</span>
              <input
                type="checkbox"
                aria-label={`${label} sign-in`}
                checked={state.organisationEnabled}
                disabled={!state.systemEnabled || busy}
                onChange={(e) => toggle(provider, field, e.target.checked)}
              />
            </label>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmPasswordOff}
        title={`Turn off password sign-in for ${org.name}?`}
        description="Everyone in this organisation who signed in on the web with a password is signed out now and must use another sign-in method. The mobile workforce keeps signing in on its own app."
        confirmLabel="Turn off password sign-in"
        destructive
        loading={busy}
        onConfirm={() => saveProviders.mutate({ passwordAuthEnabled: false })}
        onCancel={() => setConfirmPasswordOff(false)}
      />
    </>
  );
}
