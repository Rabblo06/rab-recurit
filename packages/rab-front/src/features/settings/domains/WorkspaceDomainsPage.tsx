import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconCopy } from '@tabler/icons-react';
import { api } from '../../../shared/api';
import { FormSkeleton } from '../../../shared/components/LoadingState';
import ManagedByPlatformAdminNotice from '../workspace/ManagedByPlatformAdminNotice';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoKey: string | null;
  timezone: string;
}

/**
 * The organisation identifier — READ-ONLY since W6-E2E-04 (owner decision 2026-10-23: a platform administrator changes
 * organisation settings; `PATCH /workspace/domain` no longer exists).
 */
export default function WorkspaceDomainsPage() {
  const { data: workspace, isLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: async () => (await api.get<Workspace>('/workspace')).data,
  });
  const [copied, setCopied] = useState(false);

  if (isLoading || !workspace) {
    return <FormSkeleton sections={2} />;
  }

  // Wave 3 lane H (phase 0 C1, lane S2 contract): the organisation slug is an identifier, NOT a routable host — only a
  // Manager's workspace subdomain is (Settings -> My workspace -> Domains). Never render `<slug>.<base>` as a URL.
  const identifier = workspace.slug;

  function copy() {
    navigator.clipboard.writeText(identifier).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="settings-page">
      <div className="settings-section">
        <h3>Organisation identifier</h3>
        <p>A short identifier for your organisation. It is not a web address — workspace addresses are managed under My workspace → Domains.</p>
        <ManagedByPlatformAdminNotice />
        <div className="settings-row">
          <span style={{ color: 'var(--font-primary)' }}>{identifier}</span>
          <button className="btn btn-outline" onClick={copy}>
            <IconCopy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
