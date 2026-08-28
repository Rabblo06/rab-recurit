import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import Avatar from '../../../shared/components/Avatar';
import { EmptyState, FormSkeleton } from '../../../shared/components/LoadingState';

/** Same "Picture + Name" shape as the old `WorkspaceGeneralPage`, pointed at the private `ManagerWorkspace` (`/manager-workspaces/me`) instead of the shared Organisation (`/workspace`). */
export default function MyWorkspaceGeneralPage() {
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useMyWorkspace();
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (workspace) setName(workspace.name);
  }, [workspace]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['manager-workspace'] });

  const save = useMutation({
    mutationFn: () => api.patch('/manager-workspaces/me', { name }),
    onSuccess: () => {
      invalidate();
      toast.success('Workspace updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not save the workspace.'),
  });

  const removeLogo = useMutation({
    mutationFn: () => api.delete('/manager-workspaces/me/logo'),
    onSuccess: () => {
      invalidate();
      toast.success('Logo removed.');
    },
    onError: () => toast.error('Could not remove the logo.'),
  });

  async function onLogoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post('/manager-workspaces/me/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      invalidate();
      toast.success('Logo updated.');
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? 'Could not upload that file.');
    } finally {
      setUploading(false);
    }
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

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Picture</h3>
        <p>Your workspace logo.</p>
        <div className="avatar-upload">
          <Avatar imageKey={workspace.logoKey} label={workspace.name} alt="Workspace logo" />
          <div className="avatar-upload-actions">
            <input id="my-ws-logo" type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onLogoSelected} />
            <button className="btn btn-outline" onClick={() => document.getElementById('my-ws-logo')?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            {workspace.logoKey && (
              <button className="btn btn-outline" onClick={() => removeLogo.mutate()} disabled={removeLogo.isPending}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Name</h3>
        <p>Name of your workspace.</p>
        <div className="field">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-dark" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Workspace URL</h3>
        <p>This is the URL used to access your workspace.</p>
        <div className="settings-row">
          <span>Subdomain</span>
          <span style={{ color: 'var(--font-primary)' }}>{workspace.subdomain}</span>
        </div>
      </div>
    </div>
  );
}
