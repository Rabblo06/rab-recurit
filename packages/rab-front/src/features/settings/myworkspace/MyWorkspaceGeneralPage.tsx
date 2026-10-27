import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { useUploadProgress } from '../../../shared/hooks/useUploadProgress';
import { LOGO_RULE, uploadErrorOptions, uploadHint, validateUploadFile } from '../../../shared/lib/upload';
import Avatar from '../../../shared/components/Avatar';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { EmptyState, FormSkeleton } from '../../../shared/components/LoadingState';

/** Generous ceiling for a 10 MB logo on a slow link; past it the user is told it took too long instead of waiting forever. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Same "Picture + Name" shape as the old `WorkspaceGeneralPage`, pointed at the private `ManagerWorkspace` (`/manager-workspaces/me`) instead of the shared Organisation (`/workspace`). */
export default function MyWorkspaceGeneralPage() {
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useMyWorkspace();
  const [name, setName] = useState('');
  // Reseed the name from the server only while the user has not started editing it: a logo upload/removal refetches
  // the workspace, and that must never wipe a name that was typed but not yet saved.
  const [nameTouched, setNameTouched] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const progress = useUploadProgress('logo');

  useEffect(() => {
    if (workspace && !nameTouched) setName(workspace.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest `nameTouched`; reseeds on server changes only
  }, [workspace]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['manager-workspace'] });

  const save = useFeedbackMutation<unknown, string>({
    mutationFn: (next) => api.patch('/manager-workspaces/me', { name: next }),
    successMessage: 'Workspace updated.',
    errorFeedback: { fallback: 'Could not save the workspace.' },
    onSuccess: () => {
      setNameTouched(false);
      void invalidate();
    },
  });

  const removeLogo = useFeedbackMutation({
    mutationFn: () => api.delete('/manager-workspaces/me/logo'),
    successMessage: 'Logo removed.',
    errorFeedback: { fallback: 'Could not remove the logo. Please try again.' },
    onSuccess: () => void invalidate(),
    onSettled: () => setConfirmRemove(false),
  });

  // POST /manager-workspaces/me/logo (LOGO_MAX_BYTES = 10 MB, PNG/JPEG/WebP sniffed by the server).
  const uploadLogo = useFeedbackMutation<unknown, File>({
    mutationFn: async (file) => {
      const form = new FormData();
      form.append('file', file);
      progress.begin();
      return api.post('/manager-workspaces/me/logo', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: progress.onUploadProgress,
        timeout: UPLOAD_TIMEOUT_MS,
      });
    },
    successMessage: 'Logo updated.',
    errorFeedback: uploadErrorOptions(LOGO_RULE),
    onSuccess: () => void invalidate(),
    onSettled: () => progress.end(),
  });

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

  // `isLoading` (no data fetched yet) and "fetch settled with no workspace"
  // are different states — conflating them left this page stuck on a
  // loading skeleton forever for any account with no private workspace
  // (e.g. the platform admin, who structurally can never have one), with no
  // indication anything was actually wrong.
  if (isLoading) {
    return <FormSkeleton />;
  }
  if (!workspace) {
    return (
      <EmptyState
        variant="access"
        title="No private workspace"
        description="This account doesn't have a private workspace. Only Managers who have completed onboarding have one."
      />
    );
  }

  const dirty = name !== workspace.name;
  const logoBusy = uploadLogo.busy || removeLogo.busy;

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Picture</h3>
        <p>Your workspace logo. {uploadHint(LOGO_RULE)}</p>
        <div className="avatar-upload">
          <Avatar imageKey={workspace.logoKey} label={workspace.name} alt="Workspace logo" />
          <div className="avatar-upload-actions">
            <input ref={fileInput} id="my-ws-logo" type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onLogoSelected} aria-label="Choose a workspace logo" tabIndex={-1} />
            <button type="button" className="btn btn-outline" onClick={() => fileInput.current?.click()} disabled={logoBusy} aria-busy={uploadLogo.busy || undefined}>
              {uploadLogo.busy ? progress.label || 'Uploading…' : 'Upload'}
            </button>
            {workspace.logoKey && (
              <button type="button" className="btn btn-outline" onClick={() => setConfirmRemove(true)} disabled={logoBusy} aria-busy={removeLogo.busy || undefined}>
                {removeLogo.busy ? 'Removing…' : 'Remove'}
              </button>
            )}
            <span className="visually-hidden" role="status" aria-live="polite">{progress.announcement}</span>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Name</h3>
        <p>Name of your workspace.</p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (dirty && name.length > 0) save.submit(name); }}>
          <div className="field">
            {/* Same limits as the server's UpdateManagerWorkspaceNameDto (MinLength 1, MaxLength 120). */}
            <input aria-label="Workspace name" maxLength={120} value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-dark" disabled={!dirty || name.length === 0 || save.busy} aria-busy={save.busy || undefined}>
              {save.busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>

      <div className="settings-section">
        <h3>Workspace URL</h3>
        <p>This is the URL used to access your workspace.</p>
        <div className="settings-row">
          <span>Subdomain</span>
          <span style={{ color: 'var(--font-primary)' }}>{workspace.subdomain}</span>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the workspace logo?"
        description="The workspace initial will be shown instead until you upload a new logo."
        confirmLabel="Remove logo"
        destructive
        loading={removeLogo.busy}
        onConfirm={() => removeLogo.submit()}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
