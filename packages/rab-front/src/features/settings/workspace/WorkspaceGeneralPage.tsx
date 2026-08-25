import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import LogoUpload from './LogoUpload';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

export default function WorkspaceGeneralPage() {
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: async () => (await api.get<Workspace>('/workspace')).data,
  });
  const [name, setName] = useState('');

  useEffect(() => {
    if (workspace) setName(workspace.name);
  }, [workspace]);

  const save = useMutation({
    mutationFn: () => api.patch('/workspace', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace'] });
      toast.success('Workspace updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not save the workspace.'),
  });

  if (isLoading || !workspace) {
    return <div className="settings-page"><p className="muted">Loading…</p></div>;
  }

  const dirty = name !== workspace.name;

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Picture</h3>
        <p>Your workspace logo.</p>
        <LogoUpload logoKey={workspace.logoKey} />
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
          <span style={{ color: 'var(--font-primary)' }}>{workspace.slug}</span>
        </div>
      </div>
    </div>
  );
}
