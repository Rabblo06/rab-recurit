import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconPencil } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { FormSkeleton } from '../../../shared/components/LoadingState';

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
      toast.success('Identifier updated.');
    },
    onError: (err: any) => toast.error(getApiErrorMessage(err, 'Could not update the identifier.')),
  });

  if (isLoading || !workspace) {
    return <FormSkeleton sections={2} />;
  }

  // Wave 3 lane H (phase 0 C1, lane S2 contract): the organisation slug is an identifier, NOT a routable host — only a
  // Manager's workspace subdomain is (Settings -> My workspace -> Domains). Never render `<slug>.<base>` as a URL.
  const url = workspace.slug;

  function copyUrl() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Organisation identifier</h3>
        <p>A short identifier for your organisation. It is not a web address — workspace addresses are managed under My workspace → Domains.</p>
        {editing ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="identifier" />
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
            <button className="btn-icon" title="Edit identifier" onClick={() => { setSlug(workspace.slug); setEditing(true); }}>
              <IconPencil size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Identifier</h3>
        <p>Copy this identifier when support asks which organisation you belong to.</p>
        <div className="settings-row">
          <span style={{ color: 'var(--font-primary)' }}>{url}</span>
          <button className="btn btn-outline" onClick={copyUrl}>
            <IconCopy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
