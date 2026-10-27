import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { useUploadProgress } from '../../../shared/hooks/useUploadProgress';
import { LOGO_RULE, uploadErrorOptions, uploadHint, validateUploadFile } from '../../../shared/lib/upload';
import { toast } from '../../../shared/lib/toast';
import { getApiErrorStatus, getApiFieldErrors } from '../../../shared/lib/apiError';

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

/** rab-server `UpdateSubdomainDto`: lowercase letters, numbers and hyphens, 3–63, no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
export const SLUG_HINT = '3 to 63 lowercase letters, numbers or hyphens. It can’t start or end with a hyphen.';
const SLUG_INVALID = `Use ${SLUG_HINT.charAt(0).toLowerCase()}${SLUG_HINT.slice(1)}`;
const SLUG_TAKEN = 'This identifier is already used by another organisation. Choose a different one.';
const NAME_REQUIRED = 'Enter a name for the organisation.';
const TIMEZONE_INVALID = 'Enter a valid timezone, for example Europe/London.';

/** Generous ceiling for a 10 MB logo on a slow link; past it the admin is told it took too long instead of waiting. */
const UPLOAD_TIMEOUT_MS = 120_000;

type GeneralField = 'name' | 'timezone';

/**
 * W6-E2E-04 — owner decision 2026-10-23: organisation settings (name, timezone, identifier, logo and sign-in methods,
 * including turning password sign-in off) are changed by a PLATFORM ADMINISTRATOR only, here in Admin Panel →
 * Organisations → (organisation). The organisation's own members see them read-only under Settings. The server is
 * authoritative (`PlatformAdminGuard` + `OrganisationSettingsAdminService`); this section only presents it.
 *
 * Feedback (owner rule): every action is guarded synchronously (`useFeedbackMutation().submit`) and labelled while it
 * runs; success only from the server's answer (its view is written to the cache); a server validation error is shown
 * UNDER its field (`aria-invalid` + `aria-describedby`, focus moves there) and every other failure is one red toast
 * with the reason and, where a retry can help, "Try again". A background refetch never wipes an unsaved edit: a field is
 * reseeded from the server only while the admin has not changed it.
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
  const [generalErrors, setGeneralErrors] = useState<Partial<Record<GeneralField, string>>>({});
  const [slugError, setSlugError] = useState<string>();
  const [confirmPasswordOff, setConfirmPasswordOff] = useState(false);
  const [confirmRemoveLogo, setConfirmRemoveLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const progress = useUploadProgress('logo');
  /** The server values each field was last seeded from: a field still equal to it is "untouched" and may be reseeded. */
  const seeded = useRef<{ name: string; timezone: string; slug: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = { name: data.organisation.name, timezone: data.organisation.timezone, slug: data.organisation.slug };
    const prev = seeded.current;
    setName((cur) => (prev === null || cur === prev.name ? next.name : cur));
    setTimezone((cur) => (prev === null || cur === prev.timezone ? next.timezone : cur));
    setSlug((cur) => (prev === null || cur === prev.slug ? next.slug : cur));
    seeded.current = next;
  }, [data]);

  const focusField = (id: string) => window.setTimeout(() => document.getElementById(id)?.focus(), 0);

  /** Writes the server's confirmed view; the organisation list refreshes in the background. */
  const applied = (view: OrganisationSettingsView) => {
    qc.setQueryData(key, view);
    void qc.invalidateQueries({ queryKey: ['admin', 'organisations'], exact: true });
    void qc.invalidateQueries({ queryKey: ['admin', 'org-search'] });
  };

  const saveGeneral = useFeedbackMutation<OrganisationSettingsView, { name: string; timezone: string }>({
    mutationFn: async (body) => (await api.patch<OrganisationSettingsView>(base, body)).data,
    successMessage: 'Organisation updated.',
    // A 400 naming a field is shown under it (no toast); anything else is the toast.
    errorFeedback: (err) =>
      Object.keys(generalFieldErrors(err)).length ? false : { fallback: 'Could not update the organisation. Please try again.' },
    onSuccess: (view) => {
      // The saved values are now the server's: reseed both fields from them (and treat them as untouched again).
      seeded.current = { ...(seeded.current ?? { slug: view.organisation.slug }), name: view.organisation.name, timezone: view.organisation.timezone };
      setName(view.organisation.name);
      setTimezone(view.organisation.timezone);
      applied(view);
    },
    onError: (err) => {
      const fields = generalFieldErrors(err);
      setGeneralErrors(fields);
      if (fields.name) focusField('admin-org-name');
      else if (fields.timezone) focusField('admin-org-timezone');
    },
  });
  const saveSlug = useFeedbackMutation<OrganisationSettingsView, string>({
    mutationFn: async (next) => (await api.patch<OrganisationSettingsView>(`${base}/domain`, { slug: next })).data,
    successMessage: 'Identifier updated.',
    errorFeedback: (err) => (slugFieldError(err) ? false : { fallback: 'Could not update the identifier. Please try again.' }),
    onSuccess: (view) => {
      seeded.current = { ...(seeded.current ?? { name: view.organisation.name, timezone: view.organisation.timezone }), slug: view.organisation.slug };
      setSlug(view.organisation.slug);
      applied(view);
    },
    onError: (err) => {
      const message = slugFieldError(err);
      if (message) {
        setSlugError(message);
        focusField('admin-org-slug');
      }
    },
  });
  const saveProviders = useFeedbackMutation<OrganisationSettingsView, Record<string, boolean>>({
    mutationFn: async (patch) => (await api.patch<OrganisationSettingsView>(`${base}/security`, patch)).data,
    successMessage: 'Sign-in methods updated.',
    errorFeedback: { fallback: 'Could not update the sign-in methods. Please try again.' },
    onSuccess: (view) => applied(view),
    onSettled: () => setConfirmPasswordOff(false),
  });
  const removeLogo = useFeedbackMutation<OrganisationSettingsView, void>({
    mutationFn: async () => (await api.delete<OrganisationSettingsView>(`${base}/logo`)).data,
    successMessage: 'Logo removed.',
    errorFeedback: { fallback: 'Could not remove the logo. Please try again.' },
    onSuccess: (view) => applied(view),
    onSettled: () => setConfirmRemoveLogo(false),
  });
  // POST …/settings/logo (LOGO_MAX_BYTES = 10 MB, PNG/JPEG/WebP sniffed by the server).
  const uploadLogo = useFeedbackMutation<OrganisationSettingsView, File>({
    mutationFn: async (file) => {
      const form = new FormData();
      form.append('file', file);
      progress.begin();
      return (
        await api.post<OrganisationSettingsView>(`${base}/logo`, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: progress.onUploadProgress,
          timeout: UPLOAD_TIMEOUT_MS,
        })
      ).data;
    },
    successMessage: 'Logo updated.',
    errorFeedback: uploadErrorOptions(LOGO_RULE),
    onSuccess: (view) => applied(view),
    onSettled: () => progress.end(),
  });

  if (isLoading) return <div className="detail-group"><div className="detail-group-title">Organisation settings</div><p className="cell-muted" style={{ margin: '0 4px' }}>Loading…</p></div>;
  if (isError || !data) return <div className="detail-group"><div className="detail-group-title">Organisation settings</div><p className="cell-muted" style={{ margin: '0 4px' }}>Could not load this organisation’s settings.</p></div>;

  const org = data.organisation;
  const generalDirty = name.trim() !== org.name || timezone.trim() !== org.timezone;
  const providersBusy = saveProviders.busy;
  const logoBusy = uploadLogo.busy || removeLogo.busy;

  function submitGeneral(e: React.FormEvent) {
    e.preventDefault();
    if (!generalDirty || saveGeneral.busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      // Same rule as the server's `@MinLength(1)`: caught before sending, shown under the field.
      setGeneralErrors({ name: NAME_REQUIRED });
      focusField('admin-org-name');
      return;
    }
    setGeneralErrors({});
    saveGeneral.submit({ name: trimmedName, timezone: timezone.trim() });
  }

  function submitSlug(e: React.FormEvent) {
    e.preventDefault();
    const next = slug.trim();
    if (!next || next === org.slug || saveSlug.busy) return;
    if (!SLUG_PATTERN.test(next)) {
      setSlugError(SLUG_INVALID);
      focusField('admin-org-slug');
      return;
    }
    setSlugError(undefined);
    saveSlug.submit(next);
  }

  function onLogoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const rejection = validateUploadFile(file, LOGO_RULE);
    if (rejection) {
      toast.error(rejection.message);
      return;
    }
    if (uploadLogo.submit(file)) progress.begin();
  }

  function toggle(provider: ProviderKey, field: string, next: boolean) {
    if (provider === 'password' && !next) {
      setConfirmPasswordOff(true);
      return;
    }
    saveProviders.submit({ [field]: next });
  }

  const fieldA11y = (error: string | undefined, errorId: string, hintId?: string) => ({
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [error ? errorId : null, hintId ?? null].filter(Boolean).join(' ') || undefined,
  });

  return (
    <>
      <div className="detail-group" aria-label="Organisation settings">
        <div className="detail-group-title">Organisation settings</div>
        <p className="cell-muted" style={{ margin: '0 4px 8px' }}>Only platform administrators can change these. The organisation sees them read-only.</p>
        <form noValidate onSubmit={submitGeneral}>
          <div className="field" style={{ margin: '0 4px 8px' }}>
            <label htmlFor="admin-org-name">Name</label>
            <input
              id="admin-org-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (generalErrors.name) setGeneralErrors((cur) => ({ ...cur, name: undefined }));
              }}
              disabled={saveGeneral.busy}
              {...fieldA11y(generalErrors.name, 'admin-org-name-error')}
            />
            {generalErrors.name && <p id="admin-org-name-error" className="field-hint" role="alert" style={{ color: 'var(--feedback-error)' }}>{generalErrors.name}</p>}
          </div>
          <div className="field" style={{ margin: '0 4px 8px' }}>
            <label htmlFor="admin-org-timezone">Timezone</label>
            <input
              id="admin-org-timezone"
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                if (generalErrors.timezone) setGeneralErrors((cur) => ({ ...cur, timezone: undefined }));
              }}
              disabled={saveGeneral.busy}
              {...fieldA11y(generalErrors.timezone, 'admin-org-timezone-error')}
            />
            {generalErrors.timezone && <p id="admin-org-timezone-error" className="field-hint" role="alert" style={{ color: 'var(--feedback-error)' }}>{generalErrors.timezone}</p>}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 4px 12px' }}>
            <button type="submit" className="btn btn-dark" disabled={!generalDirty || saveGeneral.busy} aria-busy={saveGeneral.busy || undefined}>
              {saveGeneral.busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
        <form noValidate onSubmit={submitSlug} className="field" style={{ margin: '0 4px 8px' }}>
          <label htmlFor="admin-org-slug">Identifier</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="admin-org-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value.toLowerCase());
                setSlugError(undefined);
              }}
              disabled={saveSlug.busy}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              style={{ flex: 1 }}
              {...fieldA11y(slugError, 'admin-org-slug-error', 'admin-org-slug-hint')}
            />
            <button type="submit" className="btn btn-outline" disabled={!slug.trim() || slug.trim() === org.slug || saveSlug.busy} aria-busy={saveSlug.busy || undefined}>
              {saveSlug.busy ? 'Saving…' : 'Change'}
            </button>
          </div>
          {slugError && <p id="admin-org-slug-error" className="field-hint" role="alert" style={{ color: 'var(--feedback-error)' }}>{slugError}</p>}
          <p id="admin-org-slug-hint" className="field-hint">{SLUG_HINT}</p>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 4px' }}>
          <span className="detail-info-label" style={{ flex: 1 }}>
            Logo <span className="cell-muted">({uploadHint(LOGO_RULE)})</span>
          </span>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} tabIndex={-1} aria-label="Choose an organisation logo" onChange={onLogoSelected} />
          <button type="button" className="btn btn-outline" disabled={logoBusy} aria-busy={uploadLogo.busy || undefined} onClick={() => fileRef.current?.click()}>
            {uploadLogo.busy ? progress.label || 'Uploading…' : 'Upload'}
          </button>
          {org.logoKey && (
            <button type="button" className="btn btn-outline" disabled={logoBusy} aria-busy={removeLogo.busy || undefined} onClick={() => setConfirmRemoveLogo(true)}>
              {removeLogo.busy ? 'Removing…' : 'Remove'}
            </button>
          )}
          <span className="visually-hidden" role="status" aria-live="polite">{progress.announcement}</span>
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
                disabled={!state.systemEnabled || providersBusy}
                aria-busy={providersBusy || undefined}
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
        loading={providersBusy}
        onConfirm={() => saveProviders.submit({ passwordAuthEnabled: false })}
        onCancel={() => setConfirmPasswordOff(false)}
      />
      <ConfirmDialog
        open={confirmRemoveLogo}
        title={`Remove ${org.name}’s logo?`}
        description="The organisation’s logo is removed everywhere it is shown. You can upload a new one at any time."
        confirmLabel="Remove logo"
        destructive
        loading={removeLogo.busy}
        onConfirm={() => removeLogo.submit()}
        onCancel={() => setConfirmRemoveLogo(false)}
      />
    </>
  );
}

/** A 400 naming `name` / `timezone` → the field's own text (never the server's property-name text). */
function generalFieldErrors(err: unknown): Partial<Record<GeneralField, string>> {
  return getApiFieldErrors(err, { name: NAME_REQUIRED, timezone: TIMEZONE_INVALID });
}

/**
 * The identifier route's body is only `{ slug }`, so its 400 (`UpdateSubdomainDto`'s custom format message, which does not
 * start with the property name) and its 409 "already taken" both belong under the Identifier field.
 */
function slugFieldError(err: unknown): string | undefined {
  const status = getApiErrorStatus(err);
  if (status === 409) return SLUG_TAKEN;
  if (status === 400 || status === 422) return SLUG_INVALID;
  return undefined;
}
