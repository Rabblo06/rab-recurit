import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconPencil } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

export default function WorkspaceDomainsPage() {
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: async () => (await api.get<Workspace>('/workspace')).data,
  });
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState('');
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () => api.patch('/workspace/domain', { slug }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace'] });
      setEditing(false);
      toast.success('Subdomain updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not update the subdomain.'),
  });

  if (isLoading || !workspace) {
    return <div className="settings-page"><p className="muted">Loading…</p></div>;
  }

  const url = `https://${workspace.slug}.rab.app`;

  function copyUrl() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Subdomain</h3>
        <p>Manage your workspace subdomain and access URL.</p>
        {editing ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="subdomain" />
            </div>
            <button className="btn btn-dark" disabled={!slug || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-outline" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <div className="settings-row">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {workspace.slug}
              <span className="badge badge-active"><IconCheck size={11} /> Verified</span>
            </span>
            <button className="btn-icon" title="Edit subdomain" onClick={() => { setSlug(workspace.slug); setEditing(true); }}>
              <IconPencil size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Workspace URL</h3>
        <p>This is the URL to access your workspace.</p>
        <div className="settings-row">
          <span style={{ color: 'var(--font-primary)' }}>{url}</span>
          <button className="btn btn-outline" onClick={copyUrl}>
            <IconCopy size={14} /> {copied ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </div>
    </div>
  );
}
