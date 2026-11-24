import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconCopy, IconDeviceFloppy } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import SettingsHeaderActions from '../layout/SettingsHeaderActions';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { normalizeSubdomain } from '@rab/shared';
import { api } from '../../../shared/api';
import { toast } from '../../../shared/lib/toast';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { useMyWorkspace } from '../../../shared/hooks/useMyWorkspace';
import { useWorkspaceHost, workspaceUrlFor } from '../../../shared/lib/workspace-host';
import { EmptyState, FormSkeleton } from '../../../shared/components/LoadingState';

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
  const host = useWorkspaceHost();
  const [editing, setEditing] = useState(false);
  // Wave 3 lane H: a rename quarantines the old address, so it is confirmed explicitly before it is sent.
  const [confirming, setConfirming] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // The live availability check failed (network/5xx): said so, instead of leaving Save disabled with no reason.
  const [checkFailed, setCheckFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let cancelled = false;
    setCheck(null);
    setCheckFailed(false);
    setChecking(false);
    if (!editing || !subdomain || subdomain === workspace?.subdomain) return;
    setChecking(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post<SubdomainCheck>('/manager-workspaces/subdomain/check', { candidate: subdomain });
        if (!cancelled) setCheck(data);
      } catch {
        // The real check runs again on save; meanwhile tell the user why there is no answer.
        if (!cancelled) setCheckFailed(true);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(debounceRef.current); };
  }, [subdomain, editing, workspace?.subdomain]);

  const save = useMutation({
    mutationFn: () => api.patch('/manager-workspaces/me/subdomain', { subdomain }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manager-workspace'] });
      setEditing(false);
      setConfirming(false);
      toast.success('Subdomain updated.');
    },
    onError: (err: any) => toast.error(getApiErrorMessage(err, 'Could not update the subdomain.')),
  });

  if (isLoading) {
    return <FormSkeleton sections={2} />;
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

  // Wave 3 lane H: the server's canonical form only, and only when this deployment routes workspace hosts — never a guess
  // from the browser's hostname. Otherwise the current application address is named honestly.
  const currentAppAddress = window.location.origin;
  const routedUrl = workspaceUrlFor(host, workspace.subdomain);
  const url = routedUrl ?? currentAppAddress;
  const newUrl = workspaceUrlFor(host, subdomain);
  const sameAsCurrent = subdomain === workspace.subdomain;
  const canSave = !sameAsCurrent && (check?.available === true) && !save.isPending;

  function copyUrl() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="settings-page subdomain-settings">
      <SettingsHeaderActions><Link className="btn btn-outline" to="/settings/my-workspace">Cancel</Link><button className="btn btn-dark" disabled={!editing || !canSave || confirming || checking} onClick={() => setConfirming(true)}><IconDeviceFloppy size={14} /> Save</button></SettingsHeaderActions>
      <div className="settings-section">
        <h3>Subdomain</h3>
        <p>Set the name of your subdomain.</p>
        <div>
          <div className="settings-subdomain-input">
            <input aria-label="Subdomain" value={editing ? subdomain : workspace.subdomain} disabled={save.isPending} onChange={(e) => { setEditing(true); setSubdomain(normalizeSubdomain(e.target.value)); }} placeholder="subdomain" />
            {host.workspaceBaseDomain && <span>.{host.workspaceBaseDomain}</span>}
          </div>
          <ConfirmDialog open={confirming} title="Change subdomain?" description={
            'Your workspace will move to ' + (newUrl ?? subdomain) + '. The old address will temporarily redirect and remain reserved. People using the old address may need to sign in again on the new one.'
          } confirmLabel="Confirm" destructive loading={save.isPending} onConfirm={() => { if(canSave && !checking) save.mutate(); }} onCancel={() => setConfirming(false)} />
            {subdomain.length >= 3 && !sameAsCurrent && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {checking ? (
                  <span style={{ color: 'var(--font-tertiary)' }}>Checking availability…</span>
                ) : check?.available ? (
                  <span style={{ color: 'var(--feedback-success)' }}>✓ {check.normalized} is available</span>
                ) : check && !check.available ? (
                  <div>
                    <span style={{ color: 'var(--feedback-error)' }}>
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
                ) : checkFailed ? (
                  <span role="alert" style={{ color: 'var(--feedback-error)' }}>
                    Couldn&apos;t check availability. Check your connection, then edit the subdomain to try again.
                  </span>
                ) : null}
              </div>
            )}
          </div>

      </div>

      <details className="settings-section subdomain-address-details">
        <summary>Workspace URL</summary>
        <p>{routedUrl ? 'This is the URL to access your workspace.' : 'Workspace addresses are not enabled for this environment yet — use the application at this address.'}</p>
        <div className="settings-row">
          <span style={{ color: 'var(--font-primary)' }}>{url}</span>
          <button className="btn btn-outline" onClick={copyUrl}>
            <IconCopy size={14} /> {copied ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </details>
    </div>
  );
}
