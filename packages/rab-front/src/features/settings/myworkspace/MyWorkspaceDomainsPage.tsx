import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconPencil } from '@tabler/icons-react';
import { normalizeSubdomain } from '@rab/shared';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { FormSkeleton } from '../../../shared/components/LoadingState';

interface SubdomainCheck {
  available: boolean;
  normalized: string;
  reserved: boolean;
  suggested?: string;
  alternatives?: string[];
}

const DEBOUNCE_MS = 350;

/** Same smart-subdomain UX as onboarding's Create Workspace step, reused for later edits — same normalize/reserved/availability pipeline, against the private `ManagerWorkspace` instead of the shared Organisation. */
export default function MyWorkspaceDomainsPage() {
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useMyWorkspace();
  const [editing, setEditing] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setCheck(null);
    if (!editing || !subdomain || subdomain === workspace?.subdomain) return;
    setChecking(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post<SubdomainCheck>('/manager-workspaces/subdomain/check', { candidate: subdomain });
        setCheck(data);
      } catch {
        // ignore — the real check runs again on save
      } finally {
        setChecking(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [subdomain, editing, workspace?.subdomain]);

  const save = useMutation({
    mutationFn: () => api.patch('/manager-workspaces/me/subdomain', { subdomain }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manager-workspace'] });
      setEditing(false);
      toast.success('Subdomain updated.');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? 'Could not update the subdomain.'),
  });

  if (isLoading || !workspace) {
    return <FormSkeleton sections={2} />;
  }

  const url = `https://${workspace.subdomain}.rab.app`;
  const sameAsCurrent = subdomain === workspace.subdomain;
  const canSave = !sameAsCurrent && (check?.available === true) && !save.isPending;

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
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <input value={subdomain} onChange={(e) => setSubdomain(normalizeSubdomain(e.target.value))} placeholder="subdomain" />
              </div>
              <button className="btn btn-dark" disabled={!canSave} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-outline" onClick={() => setEditing(false)}>Cancel</button>
            </div>
            {subdomain.length >= 3 && !sameAsCurrent && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {checking ? (
                  <span style={{ color: 'var(--font-tertiary)' }}>Checking availability…</span>
                ) : check?.available ? (
                  <span style={{ color: 'var(--color-green)' }}>✓ {check.normalized} is available</span>
                ) : check && !check.available ? (
                  <div>
                    <span style={{ color: 'var(--color-red)' }}>
                      {check.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.'}
                    </span>
                    {check.suggested && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        {[check.suggested, ...(check.alternatives ?? [])].map((candidate) => (
                          <button
                            key={candidate}
                            className="btn btn-outline"
                            style={{ fontSize: 11, padding: '3px 8px' }}
                            onClick={() => setSubdomain(candidate)}
                          >
                            {candidate}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="settings-row">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {workspace.subdomain}
              <span className="badge badge-active"><IconCheck size={11} /> Verified</span>
            </span>
            <button className="btn-icon" title="Edit subdomain" onClick={() => { setSubdomain(workspace.subdomain); setEditing(true); }}>
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
